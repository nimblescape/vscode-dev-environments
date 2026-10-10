// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup C5 (plan step 11J, C1; the user's decision of 2026-10-10): the tag lists of the Session Monitor's image
// maintenance are read by the worker's registry client (RegistryClient.listTags), which the monitor's own client
// (images.ts: httpGetWith, parseBearerChallenge, its token and paging) did before: the challenge and the token, all
// pages of the RFC 5988 Link on the same registry only, at most MAX_TAG_PAGES pages of MAX_TAG_LIST_BYTES each, and the
// redirect rules of the client (HTTPS only; no credential to another host than the registry and its token service).
import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { silentLogger, type Logger } from '../ports';
import { MAX_TAG_LIST_BYTES, MAX_TAG_PAGES, RegistryClient } from './registryClient';

const CHALLENGE = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:team/app:pull"';

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

describe('RegistryClient.listTags (cleanup C5, C1)', () => {
  it('asks anonymously, follows the Bearer challenge, and keeps the token for the further pages', async () => {
    const { transport, requests } = recording((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) return json({ token: 'anon' });
      if (request.headers?.Authorization !== 'Bearer anon') return { status: 401, headers: { 'www-authenticate': CHALLENGE }, body: '' };
      if (request.url.endsWith('/tags/list')) return json({ tags: ['1', '2'] }, { link: '</v2/team/app/tags/list?last=2&n=2>; rel="next"' });
      return json({ tags: ['latest', 3] });
    });
    expect(await new RegistryClient(transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1', '2', 'latest'] });
    expect(requests.map((request) => [request.method, request.url, request.headers?.Authorization])).toEqual([
      ['GET', 'https://ghcr.io/v2/team/app/tags/list', undefined],
      ['GET', 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Ateam%2Fapp%3Apull', undefined],
      ['GET', 'https://ghcr.io/v2/team/app/tags/list', 'Bearer anon'],
      ['GET', 'https://ghcr.io/v2/team/app/tags/list?last=2&n=2', 'Bearer anon'],
    ]);
    // Each page within the body limit of a tag list.
    expect(requests.filter((request) => request.url.includes('/v2/')).map((request) => request.maxBodyBytes)).toEqual([MAX_TAG_LIST_BYTES, MAX_TAG_LIST_BYTES, MAX_TAG_LIST_BYTES]);
  });

  it('follows a next page only on the same registry, and at most MAX_TAG_PAGES pages', async () => {
    const other = recording(() => json({ tags: ['1'] }, { link: '<https://evil.example/v2/team/app/tags/list?n=1>; rel="next"' }));
    expect(await new RegistryClient(other.transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(other.requests).toHaveLength(1);
    let page = 0;
    const endless = recording(() => json({ tags: [String(page++)] }, { link: `</v2/team/app/tags/list?last=${page}>; rel="next"` }));
    const listed = await new RegistryClient(endless.transport, async () => undefined).listTags('ghcr.io', 'team/app');
    expect(endless.requests).toHaveLength(MAX_TAG_PAGES);
    expect(listed.kind === 'tags' && listed.tags.length).toBe(MAX_TAG_PAGES);
  });

  it('gives the reason of a page that cannot be used: its status, an invalid list, no answer', async () => {
    const answering = (response: HttpResponse) => new RegistryClient(recording(() => response).transport, async () => undefined).listTags('ghcr.io', 'team/app');
    expect(await answering({ status: 404, headers: {}, body: '' })).toEqual({ kind: 'notFound', registry: 'ghcr.io' });
    expect(await answering({ status: 500, headers: {}, body: '' })).toEqual({ kind: 'unreachable', registry: 'ghcr.io', error: 'The registry answered with HTTP 500.' });
    expect(await answering({ status: 204, headers: {}, body: '' })).toEqual({ kind: 'error', registry: 'ghcr.io', error: 'The registry answered with HTTP 204.' });
    expect(await answering({ status: 200, headers: {}, body: 'not json' })).toEqual({ kind: 'error', registry: 'ghcr.io', error: 'The registry sent an invalid tag list.' });
    expect(await answering({ status: 200, headers: {}, body: 'null' })).toEqual({ kind: 'tags', tags: [] });
    // A token that a later page refuses: no second token request (as the monitor's own client: once per list).
    const refused = recording((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) return json({ token: 'anon' });
      if (request.headers?.Authorization !== 'Bearer anon' || request.url.includes('last=')) return { status: 401, headers: { 'www-authenticate': CHALLENGE }, body: '' };
      return json({ tags: ['1'] }, { link: '</v2/team/app/tags/list?last=1>; rel="next"' });
    });
    expect(await new RegistryClient(refused.transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'authRequired', registry: 'ghcr.io' });
    expect(refused.requests.filter((request) => request.url.startsWith('https://ghcr.io/token'))).toHaveLength(1);
    const failing: HttpTransport = { request: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND ghcr.io')) };
    expect(await new RegistryClient(failing, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'unreachable', registry: 'ghcr.io', error: 'getaddrinfo ENOTFOUND ghcr.io' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await new RegistryClient(recording(() => json({ tags: [] })).transport, async () => undefined).listTags('ghcr.io', 'team/app', aborted.signal)).toEqual({
      kind: 'unreachable',
      registry: 'ghcr.io',
      error: 'No answer in time.',
    });
  });

  it('never sends a credential to another host: no token to a redirected page, no sign-in for a host it was redirected to', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message: string) => void warnings.push(message) };
    // A page that redirects to another host after the token: the token stays with the registry.
    const moved = recording((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) return json({ token: 'anon' });
      if (new URL(request.url).host === 'cdn.example') return json({ tags: ['1'] });
      if (request.headers?.Authorization !== 'Bearer anon') return { status: 401, headers: { 'www-authenticate': CHALLENGE }, body: '' };
      return { status: 307, headers: { location: 'https://cdn.example/v2/team/app/tags/list' }, body: '' };
    });
    expect(await new RegistryClient(moved.transport, async () => undefined, logger).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
    expect(moved.requests.filter((request) => new URL(request.url).host === 'cdn.example').map((request) => request.headers?.Authorization)).toEqual([undefined]);
    expect(moved.requests.filter((request) => request.headers?.Authorization === 'Bearer anon').map((request) => new URL(request.url).host)).toEqual(['ghcr.io']);
    // A redirect to another host that asks for a sign-in: `authRequired`, without a token request, and a warning.
    const elsewhere = recording((request): HttpResponse =>
      new URL(request.url).host === 'ghcr.io'
        ? { status: 302, headers: { location: 'https://login.example/v2/team/app/tags/list' }, body: '' }
        : { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://login.example/token"' }, body: '' },
    );
    expect(await new RegistryClient(elsewhere.transport, async () => ({ username: 'u', password: 'p' }), logger).listTags('ghcr.io', 'team/app')).toEqual({ kind: 'authRequired', registry: 'ghcr.io' });
    expect(elsewhere.requests.map((request) => request.url)).toEqual(['https://ghcr.io/v2/team/app/tags/list', 'https://login.example/v2/team/app/tags/list']);
    expect(elsewhere.requests.every((request) => request.headers?.Authorization === undefined)).toBe(true);
    expect(warnings).toEqual(['The registry ghcr.io redirected to login.example, which asked for a sign-in. Registry credentials are not sent to another host.']);
    // A redirect without TLS is refused.
    const insecure = recording(() => ({ status: 301, headers: { location: 'http://ghcr.io/v2/team/app/tags/list' }, body: '' }));
    expect(await new RegistryClient(insecure.transport, async () => undefined).listTags('ghcr.io', 'team/app')).toEqual({
      kind: 'error',
      registry: 'ghcr.io',
      error: 'The registry redirected to an insecure address (http://ghcr.io).',
    });
  });
});
