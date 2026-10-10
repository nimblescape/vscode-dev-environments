// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup C5 (plan step 11J, C1), review B: probes of the monitor's tag reads that the tests of the PR
// left open: requestsWithin ends a request with the signal of its caller too (also one aborted before the start) and
// leaves no listener behind; a pass gives every registry request the time limit REGISTRY_TIMEOUT_MS (30 s); the warnings
// of the registry client and the reason of a refused sign-in reach the log of the monitor.
import { getEventListeners } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../core/http';
import type { ImageEngine } from './engine';
import { ImageMaintenance, REGISTRY_TIMEOUT_MS, requestsWithin } from './images';

const hanging: HttpTransport = { request: () => new Promise<HttpResponse>(() => {}) };

function imageEngine(): ImageEngine {
  return {
    images: async () => [],
    inspect: async () => undefined,
    pull: async () => {},
    containerIds: async () => [],
    removeImage: async () => 'missing',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestsWithin (review round 1 of cleanup C5, B)', () => {
  it('ends a request at once when the signal of its caller aborts, also before the start', async () => {
    const before = new AbortController();
    before.abort();
    await expect(requestsWithin(hanging, 60_000).request({ method: 'GET', url: 'https://ghcr.io/v2/' }, before.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const during = new AbortController();
    const pending = requestsWithin(hanging, 60_000).request({ method: 'GET', url: 'https://ghcr.io/v2/' }, during.signal);
    setTimeout(() => during.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('leaves no abort listener on the signal of the request once it settled', async () => {
    let given: AbortSignal | undefined;
    const answering: HttpTransport = {
      request: async (_request, signal) => {
        given = signal;
        return { status: 200, headers: {}, body: '' };
      },
    };
    await requestsWithin(answering, 60_000).request({ method: 'GET', url: 'https://ghcr.io/v2/' }, new AbortController().signal);
    expect(given).toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(getEventListeners(given!, 'abort')).toHaveLength(0);
  });
});

describe('the tag reads of a pass (review round 1 of cleanup C5, B)', () => {
  it('give every registry request the time limit REGISTRY_TIMEOUT_MS (30 s)', async () => {
    expect(REGISTRY_TIMEOUT_MS).toBe(30_000);
    const original = AbortSignal.timeout.bind(AbortSignal);
    const limits: AbortController[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      if (ms !== 30_000) return original(ms);
      const limit = new AbortController();
      limits.push(limit);
      return limit.signal;
    });
    const signals: (AbortSignal | undefined)[] = [];
    const transport: HttpTransport = {
      request: (_request: HttpRequest, signal?: AbortSignal) => {
        signals.push(signal);
        return new Promise<HttpResponse>(() => {});
      },
    };
    const log: string[] = [];
    const pass = new ImageMaintenance({
      engine: imageEngine(),
      registryTransport: () => transport,
      log: (message) => log.push(message),
      prefixes: () => ['ghcr.io/team/'],
      knownRepositories: async () => ['ghcr.io/team/app'],
    }).pass();
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(limits).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    limits[0].abort();
    await pass;
    expect(log).toEqual(['The tags of ghcr.io/team/app could not be read; it is not updated: No answer in time.']);
  });

  it('log the warnings of the registry client and the reason of a refused sign-in', async () => {
    const transport: HttpTransport = {
      request: async (request): Promise<HttpResponse> =>
        new URL(request.url).host === 'ghcr.io'
          ? { status: 302, headers: { location: 'https://login.example/v2/team/app/tags/list' }, body: '' }
          : { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://login.example/token"' }, body: '' },
    };
    const log: string[] = [];
    await new ImageMaintenance({
      engine: imageEngine(),
      registryTransport: () => transport,
      log: (message) => log.push(message),
      prefixes: () => ['ghcr.io/team/'],
      knownRepositories: async () => ['ghcr.io/team/app'],
    }).pass();
    expect(log).toEqual([
      'The registry ghcr.io redirected to login.example, which asked for a sign-in. Registry credentials are not sent to another host.',
      'The tags of ghcr.io/team/app could not be read; it is not updated: the registry asks for a sign-in',
    ]);
  });
  it('use a transport made afresh for each pass (a failed proxy read counts only for that pass)', async () => {
    const used: number[] = [];
    let made = 0;
    const registryTransport = (): HttpTransport => {
      const index = made++;
      return {
        request: async (): Promise<HttpResponse> => {
          used.push(index);
          if (index === 0) throw new Error('the proxy of the daemon could not be read');
          return { status: 200, headers: {}, body: '{"tags":[]}' };
        },
      };
    };
    const log: string[] = [];
    const images = new ImageMaintenance({
      engine: imageEngine(),
      registryTransport,
      log: (message) => log.push(message),
      prefixes: () => ['ghcr.io/team/'],
      knownRepositories: async () => ['ghcr.io/team/app'],
    });
    await images.pass();
    await images.pass();
    expect(made).toBe(2);
    expect(used).toEqual([0, 1]);
    expect(log).toEqual(['The tags of ghcr.io/team/app could not be read; it is not updated: the proxy of the daemon could not be read']);
  });
});
