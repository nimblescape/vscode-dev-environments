// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, it, expect } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { abortError, isAbortError, type Logger } from '../ports';
import {
  describeGraphQLErrors,
  GitHubApi,
  GitHubApiError,
  GitHubTimeoutError,
  GITHUB_GRAPHQL_URL,
} from './githubApi';

const TOKEN = 'gho_secretTokenValue123';

class FakeTransport implements HttpTransport {
  readonly requests: Array<{ request: HttpRequest; signal?: AbortSignal }> = [];
  constructor(private readonly handler: (request: HttpRequest, signal?: AbortSignal) => Promise<HttpResponse>) {}
  request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    this.requests.push({ request, signal });
    return this.handler(request, signal);
  }
}

function respond(body: unknown, status = 200): FakeTransport {
  return new FakeTransport(async () => ({
    status,
    headers: {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

/** A transport that answers only when the signal aborts (then it rejects like the Node.js transport). */
function hangingTransport(): FakeTransport {
  return new FakeTransport(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      }),
  );
}

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
    output: (text) => lines.push(text),
  };
}

describe('GitHubApi.graphql', () => {
  it('sends a POST request with the token, the user agent, and the query as JSON', async () => {
    const transport = respond({ data: { viewer: { login: 'octo' } } });
    const api = new GitHubApi(transport);
    const result = await api.graphql<{ viewer: { login: string } }>('query { viewer { login } }', { a: 1 }, TOKEN);

    expect(result).toEqual({ data: { viewer: { login: 'octo' } } });
    expect(transport.requests).toHaveLength(1);
    const { request } = transport.requests[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe(GITHUB_GRAPHQL_URL);
    expect(request.headers?.Authorization).toBe(`bearer ${TOKEN}`);
    expect(request.headers?.['User-Agent']).toBe('vscode-dev-environments');
    expect(request.headers?.['Content-Type']).toBe('application/json');
    expect(request.headers?.['Content-Length']).toBe(String(Buffer.byteLength(request.body ?? '', 'utf8')));
    expect(JSON.parse(request.body ?? '')).toEqual({ query: 'query { viewer { login } }', variables: { a: 1 } });
  });

  it('returns partial data together with the errors', async () => {
    const api = new GitHubApi(
      respond({
        data: { viewer: { repositories: { nodes: [null] } } },
        errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.', path: ['viewer', 'repositories', 'nodes', 0], locations: [{ line: 1, column: 2 }], extensions: { saml_failure: true } }],
      }),
    );
    const result = await api.graphql('query', {}, TOKEN);
    expect(result.data).toEqual({ viewer: { repositories: { nodes: [null] } } });
    expect(result.errors).toEqual([
      {
        type: 'FORBIDDEN',
        message: 'Resource protected by organization SAML enforcement.',
        path: ['viewer', 'repositories', 'nodes', 0],
        extensions: { saml_failure: true },
      },
    ]);
  });

  it('returns only errors when data is null', async () => {
    const api = new GitHubApi(respond({ data: null, errors: [{ message: 'Something went wrong' }] }));
    const result = await api.graphql('query', {}, TOKEN);
    expect(result).toEqual({ errors: [{ message: 'Something went wrong' }] });
  });

  it('normalizes malformed error entries', async () => {
    const api = new GitHubApi(respond({ data: {}, errors: [42, { path: ['a', 1, { x: 1 }] }, { message: 'ok', type: 3 }] }));
    const result = await api.graphql('query', {}, TOKEN);
    expect(result.errors).toEqual([{ message: 'Unknown GraphQL error.', path: ['a', 1] }, { message: 'ok' }]);
  });

  it('throws GitHubApiError with the status for HTTP 401, without the token in the message', async () => {
    const api = new GitHubApi(respond({ message: 'Bad credentials', documentation_url: 'https://docs.github.com' }, 401));
    const error = await api.graphql('query', {}, TOKEN).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(401);
    expect((error as Error).message).toContain('Bad credentials');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('throws GitHubApiError for an HTML error page', async () => {
    const api = new GitHubApi(respond('<html>Bad gateway</html>', 502));
    await expect(api.graphql('query', {}, TOKEN)).rejects.toMatchObject({ name: 'GitHubApiError', status: 502 });
  });

  it('throws GitHubApiError for a response that is not JSON, and logs it without the body', async () => {
    const logger = recordingLogger();
    const api = new GitHubApi(respond('not json'), logger);
    await expect(api.graphql('query', {}, TOKEN)).rejects.toBeInstanceOf(GitHubApiError);
    expect(logger.lines.join('\n')).not.toContain('not json');
  });

  it('throws for a response without data and without errors', async () => {
    const api = new GitHubApi(respond({}));
    await expect(api.graphql('query', {}, TOKEN)).rejects.toBeInstanceOf(GitHubApiError);
    const arrayApi = new GitHubApi(respond([1, 2]));
    await expect(arrayApi.graphql('query', {}, TOKEN)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('passes a connection failure of the transport on', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' });
    const api = new GitHubApi(new FakeTransport(() => Promise.reject(failure)));
    await expect(api.graphql('query', {}, TOKEN)).rejects.toBe(failure);
  });

  it('rejects with an AbortError without a request when the signal is already aborted', async () => {
    const transport = respond({ data: {} });
    const controller = new AbortController();
    controller.abort();
    const error = await new GitHubApi(transport).graphql('query', {}, TOKEN, controller.signal).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(transport.requests).toHaveLength(0);
  });

  it('rejects with an AbortError when the signal aborts during the request', async () => {
    const transport = hangingTransport();
    const controller = new AbortController();
    const promise = new GitHubApi(transport).graphql('query', {}, TOKEN, controller.signal);
    controller.abort();
    const error = await promise.catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
  });

  it('rejects with GitHubTimeoutError after the time limit, and aborts the request', async () => {
    const transport = hangingTransport();
    const api = new GitHubApi(transport, undefined, { timeoutMs: 30 });
    const started = Date.now();
    const error = await api.graphql('query', {}, TOKEN).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubTimeoutError);
    expect(isAbortError(error)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(transport.requests[0].signal?.aborted).toBe(true);
  });

  it('removes its listener from the signal of the caller after the request', async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      added++;
      originalAdd(...args);
    }) as AbortSignal['addEventListener'];
    signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      removed++;
      originalRemove(...args);
    }) as AbortSignal['removeEventListener'];
    await new GitHubApi(respond({ data: {} })).graphql('query', {}, TOKEN, signal);
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });
});

describe('describeGraphQLErrors', () => {
  it('lists identical messages once, with their type', () => {
    expect(
      describeGraphQLErrors([
        { message: 'A', type: 'FORBIDDEN' },
        { message: 'A', type: 'FORBIDDEN' },
        { message: 'B' },
      ]),
    ).toBe('FORBIDDEN: A | B');
  });

  it('shortens long lists', () => {
    const errors = Array.from({ length: 8 }, (_, i) => ({ message: `E${i}` }));
    expect(describeGraphQLErrors(errors)).toBe('E0 | E1 | E2 | E3 | E4 | … (3 more)');
  });

  it('handles an empty list', () => {
    expect(describeGraphQLErrors(undefined)).toBe('no details');
    expect(describeGraphQLErrors([])).toBe('no details');
  });
});
