// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #141 (cleanup C5, plan step 11J; round 1, A-L1): the edges of the visible ASCII rule for the token
// of a token service: `!` (0x21) and `~` (0x7e) are accepted, DEL (0x7f) is refused before any request carries it.
import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { RegistryClient } from './registryClient';

const CHALLENGE = 'Bearer realm="https://ghcr.io/token",service="ghcr.io"';

/** A registry that wants a Bearer token and hands out `token`; records each request. */
function tokenRegistry(token: string) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (request): Promise<HttpResponse> => {
      requests.push({ ...request, headers: { ...request.headers } });
      if (request.url.startsWith('https://ghcr.io/token')) return { status: 200, headers: {}, body: JSON.stringify({ token }) };
      if (request.headers?.Authorization === undefined) return { status: 401, headers: { 'www-authenticate': CHALLENGE }, body: '' };
      return { status: 200, headers: {}, body: '{"tags":["1"]}' };
    },
  };
  return { transport, requests };
}

describe('the edges of the visible ASCII rule for a token (review round 2 of PR #141)', () => {
  it('accepts a token with ! and ~', async () => {
    const token = '!abc~';
    const { transport, requests } = tokenRegistry(token);
    expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(requests[2].headers?.Authorization).toBe(`Bearer ${token}`);
  });

  it('refuses a token with DEL before any request carries it', async () => {
    const { transport, requests } = tokenRegistry('abc\x7f');
    expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({
      kind: 'error',
      registry: 'ghcr.io',
      error: 'The token service returned an invalid token.',
    });
    expect(requests.map((request) => request.headers?.Authorization)).toEqual([undefined, undefined]);
  });
});
