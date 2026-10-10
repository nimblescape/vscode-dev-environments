// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup C5 (plan step 11J, C1), review B: probes of RegistryClient.listTags that the tests of the PR
// left open: the limits are those of the monitor's former client (20 pages, 4 MiB), each page asks for JSON with the
// client's User-Agent, and a page that the registry redirects keeps its body limit.
import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { MAX_TAG_LIST_BYTES, MAX_TAG_PAGES, RegistryClient } from './registryClient';

function recording(answer: (request: HttpRequest) => HttpResponse) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (request) => {
      requests.push({ ...request, headers: { ...request.headers } });
      return answer(request);
    },
  };
  return { transport, requests };
}

describe('RegistryClient.listTags (review round 1 of cleanup C5, B)', () => {
  it('keeps the limits of the monitor’s former client: 20 pages of at most 4 MiB', () => {
    expect(MAX_TAG_PAGES).toBe(20);
    expect(MAX_TAG_LIST_BYTES).toBe(4 * 1024 * 1024);
  });

  it('asks for JSON with the User-Agent of the client', async () => {
    const { transport, requests } = recording(() => ({ status: 200, headers: {}, body: '{"tags":["1"]}' }));
    expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(requests[0].headers?.Accept).toBe('application/json');
    expect(requests[0].headers?.['User-Agent']).toMatch(/\S/);
  });

  it('a redirected page keeps the body limit of a tag list', async () => {
    const { transport, requests } = recording((request): HttpResponse =>
      new URL(request.url).host === 'ghcr.io'
        ? { status: 307, headers: { location: 'https://cdn.example/v2/team/app/tags/list' }, body: '' }
        : { status: 200, headers: {}, body: '{"tags":["1"]}' },
    );
    expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(requests.map((request) => [new URL(request.url).host, request.maxBodyBytes])).toEqual([
      ['ghcr.io', MAX_TAG_LIST_BYTES],
      ['cdn.example', MAX_TAG_LIST_BYTES],
    ]);
  });
});
