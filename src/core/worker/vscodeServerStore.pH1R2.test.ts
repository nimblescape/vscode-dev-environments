// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11H1 (reviewer B, mutation testing): probes of the changes of review round 1 to the store
// that no test held: the one time limit covers the read of the engine's architecture and the fetch together (it does not
// start again after /info), a cancel that came before the read ends it at once (also when the read ignores its signal),
// and an answer of the update service of exactly MAX_UPDATE_SERVICE_BYTES is still taken.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequest } from '../http';
import { silentLogger, type Logger } from '../ports';
import { MAX_UPDATE_SERVICE_BYTES, ensureEngineServer, ensureServer, type VscodeStoreDeps } from './vscodeServerStore';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Settles `promise` or says 'pending' after `ms` (so a hang fails the test at once instead of its time limit). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
}

function deps(more: Partial<VscodeStoreDeps>): { deps: VscodeStoreDeps; log: string[]; requests: HttpRequest[] } {
  const log: string[] = [];
  const requests: HttpRequest[] = [];
  const logger: Logger = { ...silentLogger, info: (message) => log.push(`info ${message}`), warn: (message) => log.push(`warn ${message}`) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-store-r2probe-'));
  temps.push(root);
  return {
    log,
    requests,
    deps: {
      root,
      transport: {
        request: async (request) => {
          requests.push(request);
          return { status: 404, headers: {}, body: '' };
        },
        stream: async () => {
          throw new Error('no download in this test');
        },
      },
      architecture: async () => 'x86_64',
      lock: async () => () => undefined,
      unpack: async () => undefined,
      logger,
      ...more,
    },
  };
}

describe('the store after review round 1, probes (review round 2 of 11H1, reviewer B)', () => {
  it('one time limit for the read of the architecture and the fetch: it does not start again after /info', async () => {
    // The limit is 2 s; /info answers after 1 s; the wait for the lock then ends when the limit (started before /info)
    // ends, about 1 s later, not 2 s after the answer of /info.
    const timeoutMs = 2_000;
    let lockEnded = 0;
    const h = deps({
      timeoutMs,
      architecture: () => new Promise<string>((resolve) => setTimeout(() => resolve('x86_64'), 1_000)),
      lock: (_root, _name, _waitSeconds, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            lockEnded = Date.now();
            reject(new Error('the wait for the lock ended'));
          });
        }),
    });
    const started = Date.now();
    expect(await within(ensureEngineServer(h.deps, SERVER, new AbortController().signal), 6_000)).toBeUndefined();
    expect(lockEnded).toBeGreaterThan(0);
    expect(lockEnded - started).toBeLessThan(timeoutMs + 600);
    expect(h.log.at(-1)).toContain(`(the fetch took longer than ${timeoutMs / 1000} s)`);
  });

  it('a cancel before the read of the architecture: undefined at once, also when the read ignores its signal', async () => {
    let calls = 0;
    const h = deps({
      architecture: () => {
        calls++;
        return new Promise<string>(() => undefined);
      },
    });
    expect(await within(ensureEngineServer(h.deps, SERVER, AbortSignal.abort()), 2_000)).toBeUndefined();
    expect(calls).toBeLessThanOrEqual(1);
    expect(h.log).toEqual([`warn The VS Code server ${SERVER.commit} (stable) is not fetched into the shared store: the architecture of the engine could not be read (the open was cancelled).`]);
  });

  it('an answer of the update service of exactly MAX_UPDATE_SERVICE_BYTES is taken (the cap refuses only more)', async () => {
    const json = JSON.stringify({ url: 'https://example.com/server.tar.gz', sha256hash: 'a'.repeat(64) });
    const h = deps({});
    h.deps.transport.request = async (request) => {
      h.requests.push(request);
      return { status: 200, headers: {}, body: json + ' '.repeat(MAX_UPDATE_SERVICE_BYTES - json.length) };
    };
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', new AbortController().signal)).toBe(false);
    // The download was tried (the fake has none): the answer itself was taken.
    expect(h.log.at(-1)).toContain('(no download in this test)');
  });
});
