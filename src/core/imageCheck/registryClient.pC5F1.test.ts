// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #141 (cleanup C5, plan step 11J, C1): the token of a token service is visible ASCII or refused
// before any request carries it (A-L1); the token answer has the body limit of a tag list (A-L2); tag paging compares
// origins as the URL parser writes them, so a registry written as `Host:443` or in upper case pages on, and reaching the
// page cap is logged (B, defect 1).
import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { silentLogger, type Logger } from '../ports';
import { MAX_TAG_LIST_BYTES, MAX_TAG_PAGES, RegistryClient } from './registryClient';

const CHALLENGE = 'Bearer realm="https://ghcr.io/token",service="ghcr.io"';

/** A transport that answers with `answer` and records each request. */
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

const json = (body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, body: JSON.stringify(body) });

/** A registry that wants a Bearer token and hands out `token`. */
function tokenRegistry(token: string) {
  return recording((request) => {
    if (request.url.startsWith('https://ghcr.io/token')) return json({ token });
    if (request.headers?.Authorization === undefined) return { status: 401, headers: { 'www-authenticate': CHALLENGE }, body: '' };
    return json({ tags: ['1'] });
  });
}

function warnings(): { logger: Logger; messages: string[] } {
  const messages: string[] = [];
  return { logger: { ...silentLogger, warn: (message: string) => void messages.push(message) }, messages };
}

describe('the token of a token service (review round 1 of PR #141, A-L1 and A-L2)', () => {
  for (const token of ['bad\r\nX-Injected: 1', 'with space', 'non-ascii-ä', 'tab\there']) {
    it(`refuses ${JSON.stringify(token)} before any request carries it`, async () => {
      const { transport, requests } = tokenRegistry(token);
      expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({
        kind: 'error',
        registry: 'ghcr.io',
        error: 'The token service returned an invalid token.',
      });
      expect(requests.map((request) => request.headers?.Authorization)).toEqual([undefined, undefined]);
    });
  }

  it('refuses it for a digest of the worker too, also one got with credentials', async () => {
    const { transport, requests } = tokenRegistry('bad\nvalue');
    const client = new RegistryClient(transport, async () => ({ username: 'u', password: 'p' }));
    expect(await client.getDigest({ original: 'ghcr.io/team/app:1', registry: 'ghcr.io', repository: 'team/app', tag: '1' })).toEqual({
      kind: 'error',
      registry: 'ghcr.io',
      error: 'The token service returned an invalid token.',
    });
    expect(requests.some((request) => request.headers?.Authorization?.startsWith('Bearer'))).toBe(false);
  });

  it('accepts a visible ASCII token and reads its answer within the body limit of a tag list', async () => {
    const token = 'eyJ0eXAi.Oi-JKV_1Q~+/=';
    const { transport, requests } = tokenRegistry(token);
    expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(requests[2].headers?.Authorization).toBe(`Bearer ${token}`);
    const tokenRequests = requests.filter((request) => request.url.startsWith('https://ghcr.io/token'));
    expect(tokenRequests.map((request) => request.maxBodyBytes)).toEqual([MAX_TAG_LIST_BYTES]);
  });
});

describe('the pages of a tag list (review round 1 of PR #141, B defect 1)', () => {
  for (const registry of ['GHCR.io', 'ghcr.io:443', 'GhCr.IO:443']) {
    it(`pages on for a registry written as ${registry}`, async () => {
      const { transport, requests } = recording((request) => {
        if (request.url.includes('last=2')) return json({ tags: ['3'] }, { link: '<https://ghcr.io/v2/team/app/tags/list?last=3>; rel="next"' });
        if (request.url.includes('last=3')) return json({ tags: ['4'] });
        return json({ tags: ['1', '2'] }, { link: '</v2/team/app/tags/list?last=2>; rel="next"' });
      });
      expect(await new RegistryClient(transport, async () => undefined).listTags(registry, 'team/app')).toEqual({ kind: 'tags', tags: ['1', '2', '3', '4'] });
      expect(requests).toHaveLength(3);
    });
  }

  it('still pages only on the same origin (another port is another origin)', async () => {
    const { transport, requests } = recording(() => json({ tags: ['1'] }, { link: '<https://ghcr.io:444/v2/team/app/tags/list?n=1>; rel="next"' }));
    expect(await new RegistryClient(transport, async () => undefined).listTags('GHCR.io:443', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(requests).toHaveLength(1);
  });

  it('logs a warning when the page cap ends the list, which stays the partial one', async () => {
    let page = 0;
    const { transport, requests } = recording(() => json({ tags: [String(page++)] }, { link: `</v2/team/app/tags/list?last=${page}>; rel="next"` }));
    const { logger, messages } = warnings();
    const listed = await new RegistryClient(transport, async () => undefined, logger).listTags('ghcr.io', 'team/app');
    expect(requests).toHaveLength(MAX_TAG_PAGES);
    expect(listed).toEqual({ kind: 'tags', tags: Array.from({ length: MAX_TAG_PAGES }, (_, index) => String(index)) });
    expect(messages).toEqual(['The tag list of team/app at ghcr.io has more than 20 pages; only the first 20 were read.']);
  });

  it('logs nothing for a list that ends on its last allowed page', async () => {
    let page = 0;
    const { transport } = recording(() => {
      page++;
      return json({ tags: [String(page)] }, page < MAX_TAG_PAGES ? { link: `</v2/team/app/tags/list?last=${page}>; rel="next"` } : {});
    });
    const { logger, messages } = warnings();
    const listed = await new RegistryClient(transport, async () => undefined, logger).listTags('ghcr.io', 'team/app');
    expect(listed.kind === 'tags' && listed.tags.length).toBe(MAX_TAG_PAGES);
    expect(messages).toEqual([]);
  });
});
