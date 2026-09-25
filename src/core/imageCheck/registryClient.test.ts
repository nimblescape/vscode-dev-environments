// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import type { Credentials } from '../ports';
import { parseImageReference, type ImageReference } from './reference';
import { IMAGE_CHECK_TIMEOUT_MS } from './imageCheck';
import { CREDENTIALS_TIMEOUT_MS, MANIFEST_ACCEPT, parseWwwAuthenticate, RegistryClient, type CredentialsProvider } from './registryClient';

const DIGEST = `sha256:${'1'.repeat(64)}`;

type Answer = { status?: number; headers?: Record<string, string | undefined>; body?: string } | Error | 'hang';

function responseOf(answer: Exclude<Answer, Error | 'hang'>): HttpResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(answer.headers ?? {})) if (value !== undefined) headers[name] = value;
  return { status: answer.status ?? 200, headers, body: answer.body ?? '' };
}

function fakeTransport(handler: (request: HttpRequest) => Answer): HttpTransport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    request(request) {
      requests.push(request);
      const answer = handler(request);
      if (answer === 'hang') return new Promise<HttpResponse>(() => {});
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(responseOf(answer));
    },
  };
}

function ref(text: string): ImageReference {
  const parsed = parseImageReference(text);
  if (!parsed) throw new Error(`invalid test reference ${text}`);
  return parsed;
}

const noCredentials: CredentialsProvider = async () => undefined;

function credentialsOf(value: Credentials): CredentialsProvider & ReturnType<typeof vi.fn> {
  return vi.fn(async () => value) as unknown as CredentialsProvider & ReturnType<typeof vi.fn>;
}

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

const bearerChallenge = (realm: string, service: string, scope: string) =>
  `Bearer realm="${realm}",service="${service}",scope="${scope}"`;

describe('parseWwwAuthenticate', () => {
  it('parses a Bearer challenge with quoted values that contain commas', () => {
    expect(
      parseWwwAuthenticate('Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:a/b:pull,push"'),
    ).toEqual([
      {
        scheme: 'bearer',
        params: { realm: 'https://auth.example.com/token', service: 'registry.example.com', scope: 'repository:a/b:pull,push' },
      },
    ]);
  });

  it('parses several challenges, spaces, unquoted values, and escapes', () => {
    expect(parseWwwAuthenticate('Basic realm="Registry \\"x\\"", Bearer Realm=https://a/token , error=insufficient_scope')).toEqual([
      { scheme: 'basic', params: { realm: 'Registry "x"' } },
      { scheme: 'bearer', params: { realm: 'https://a/token', error: 'insufficient_scope' } },
    ]);
  });

  it('parses a token68 challenge and an empty header', () => {
    expect(parseWwwAuthenticate('Negotiate abc==, Basic realm="r"')).toEqual([
      { scheme: 'negotiate', params: {}, token68: 'abc==' },
      { scheme: 'basic', params: { realm: 'r' } },
    ]);
    expect(parseWwwAuthenticate('')).toEqual([]);
  });

  it('keeps several scopes separated by spaces', () => {
    const [challenge] = parseWwwAuthenticate('Bearer realm="https://r/t",scope="repository:a:pull repository:b:pull"');
    expect(challenge.params.scope).toBe('repository:a:pull repository:b:pull');
  });
});

describe('RegistryClient', () => {
  it('reads the digest of an anonymous HEAD request', async () => {
    const transport = fakeTransport(() => ({ status: 200, headers: { 'docker-content-digest': DIGEST } }));
    const client = new RegistryClient(transport, noCredentials);
    expect(await client.getDigest(ref('mcr.microsoft.com/devcontainers/python:3.12'))).toEqual({ kind: 'digest', digest: DIGEST });
    expect(transport.requests).toHaveLength(1);
    const [request] = transport.requests;
    expect(request.method).toBe('HEAD');
    expect(request.url).toBe('https://mcr.microsoft.com/v2/devcontainers/python/manifests/3.12');
    expect(request.headers?.Authorization).toBeUndefined();
  });

  it('sends all four manifest types in the Accept header', async () => {
    const transport = fakeTransport(() => ({ headers: { 'docker-content-digest': DIGEST } }));
    await new RegistryClient(transport, noCredentials).getDigest(ref('ghcr.io/o/r:1'));
    const accept = transport.requests[0].headers?.Accept ?? '';
    expect(accept).toBe(MANIFEST_ACCEPT);
    for (const type of [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.docker.distribution.manifest.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
    ]) {
      expect(accept.split(', ')).toContain(type);
    }
  });

  it('returns a digest reference without a request', async () => {
    const transport = fakeTransport(() => new Error('not expected'));
    const reference = ref(`ghcr.io/o/r@${DIGEST}`);
    expect(await new RegistryClient(transport, noCredentials).getDigest(reference)).toEqual({ kind: 'digest', digest: DIGEST });
    expect(transport.requests).toHaveLength(0);
  });

  it('gets an anonymous Bearer token on 401 and repeats the request (Docker Hub)', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://auth.docker.io/')) return { status: 200, body: JSON.stringify({ token: 'tok' }) };
      if (request.headers?.Authorization === 'Bearer tok') return { headers: { 'docker-content-digest': DIGEST } };
      return {
        status: 401,
        headers: {
          'www-authenticate': bearerChallenge('https://auth.docker.io/token', 'registry.docker.io', 'repository:library/ubuntu:pull'),
        },
      };
    });
    const client = new RegistryClient(transport, noCredentials);
    expect(await client.getDigest(ref('ubuntu'))).toEqual({ kind: 'digest', digest: DIGEST });
    expect(transport.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'HEAD https://registry-1.docker.io/v2/library/ubuntu/manifests/latest',
      'GET https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fubuntu%3Apull',
      'HEAD https://registry-1.docker.io/v2/library/ubuntu/manifests/latest',
    ]);
    expect(transport.requests[1].headers?.Authorization).toBeUndefined();
  });

  it('accepts access_token in the token response', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) return { status: 200, body: JSON.stringify({ access_token: 'acc' }) };
      if (request.headers?.Authorization === 'Bearer acc') return { headers: { 'docker-content-digest': DIGEST } };
      return { status: 401, headers: { 'www-authenticate': bearerChallenge('https://ghcr.io/token', 'ghcr.io', 'repository:o/r:pull') } };
    });
    expect(await new RegistryClient(transport, noCredentials).getDigest(ref('ghcr.io/o/r:1'))).toEqual({ kind: 'digest', digest: DIGEST });
  });

  it('requests the token with Basic credentials of the provider', async () => {
    const credentials = credentialsOf({ username: 'user', password: 'secret' });
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) {
        return request.headers?.Authorization === basicHeader('user', 'secret')
          ? { status: 200, body: JSON.stringify({ token: 'private' }) }
          : { status: 401 };
      }
      if (request.headers?.Authorization === 'Bearer private') return { headers: { 'docker-content-digest': DIGEST } };
      return { status: 401, headers: { 'www-authenticate': bearerChallenge('https://ghcr.io/token', 'ghcr.io', 'repository:o/private:pull') } };
    });
    const client = new RegistryClient(transport, credentials);
    expect(await client.getDigest(ref('ghcr.io/o/private'))).toEqual({ kind: 'digest', digest: DIGEST });
    expect(credentials).toHaveBeenCalledWith('ghcr.io', expect.any(AbortSignal));
    expect(new URL(transport.requests[1].url).searchParams.getAll('scope')).toEqual(['repository:o/private:pull']);
  });

  it('reports authRequired for a private image without credentials', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) return { status: 200, body: JSON.stringify({ token: 'anonymous' }) };
      return { status: 401, headers: { 'www-authenticate': bearerChallenge('https://ghcr.io/token', 'ghcr.io', 'repository:o/p:pull') } };
    });
    expect(await new RegistryClient(transport, noCredentials).getDigest(ref('ghcr.io/o/p'))).toEqual({
      kind: 'authRequired',
      registry: 'ghcr.io',
    });
  });

  it('reports authRequired when the image is denied also with credentials', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) return { status: 200, body: JSON.stringify({ token: 't' }) };
      if (request.headers?.Authorization === 'Bearer t') return { status: 403 };
      return { status: 401, headers: { 'www-authenticate': bearerChallenge('https://ghcr.io/token', 'ghcr.io', 'repository:o/p:pull') } };
    });
    const client = new RegistryClient(transport, credentialsOf({ username: 'u', password: 'p' }));
    expect(await client.getDigest(ref('ghcr.io/o/p'))).toEqual({ kind: 'authRequired', registry: 'ghcr.io' });
  });

  it('retries the token request without credentials when the credentials are rejected', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) {
        return request.headers?.Authorization ? { status: 401 } : { status: 200, body: JSON.stringify({ token: 'anon' }) };
      }
      if (request.headers?.Authorization === 'Bearer anon') return { headers: { 'docker-content-digest': DIGEST } };
      return { status: 401, headers: { 'www-authenticate': bearerChallenge('https://ghcr.io/token', 'ghcr.io', 'repository:o/r:pull') } };
    });
    const client = new RegistryClient(transport, credentialsOf({ username: 'old', password: 'expired' }));
    expect(await client.getDigest(ref('ghcr.io/o/r'))).toEqual({ kind: 'digest', digest: DIGEST });
  });

  it('reports credentials that the token service rejects with 401, not with 403 (the sign-in fix)', async () => {
    for (const [status, reported] of [
      [401, [['ghcr.io', { username: 'octo', password: 'gho_rejected' }]]],
      [403, []],
    ] as const) {
      const transport = fakeTransport((request) => {
        if (request.url.startsWith('https://ghcr.io/token')) {
          return request.headers?.Authorization ? { status } : { status: 200, body: JSON.stringify({ token: 'anon' }) };
        }
        if (request.headers?.Authorization === 'Bearer anon') return { headers: { 'docker-content-digest': DIGEST } };
        return { status: 401, headers: { 'www-authenticate': bearerChallenge('https://ghcr.io/token', 'ghcr.io', 'repository:o/r:pull') } };
      });
      const onCredentialsRejected = vi.fn();
      const client = new RegistryClient(transport, credentialsOf({ username: 'octo', password: 'gho_rejected' }), undefined, { onCredentialsRejected });
      expect(await client.getDigest(ref('ghcr.io/o/r'))).toEqual({ kind: 'digest', digest: DIGEST });
      expect(onCredentialsRejected.mock.calls).toEqual(reported);
    }
  });

  it('reports authRequired when the token service denies also anonymous access', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://auth.example.com/')) return { status: 403 };
      return { status: 401, headers: { 'www-authenticate': bearerChallenge('https://auth.example.com/token', 's', 'repository:a:pull') } };
    });
    const client = new RegistryClient(transport, credentialsOf({ username: 'u', password: 'p' }));
    expect(await client.getDigest(ref('registry.example.com/a'))).toEqual({ kind: 'authRequired', registry: 'registry.example.com' });
  });

  it('sends credentials to a token realm on another host only over HTTPS', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('http://')) return { status: 200, body: JSON.stringify({ token: 'leak' }) };
      return { status: 401, headers: { 'www-authenticate': bearerChallenge('http://evil.example.com/token', 's', 'repository:a:pull') } };
    });
    const credentials = credentialsOf({ username: 'u', password: 'p' });
    const result = await new RegistryClient(transport, credentials).getDigest(ref('registry.example.com/a'));
    expect(result.kind).toBe('error');
    expect(transport.requests.every((request) => request.url.startsWith('https://registry.example.com/'))).toBe(true);
    expect(transport.requests.some((request) => request.headers?.Authorization !== undefined)).toBe(false);
    expect(credentials).not.toHaveBeenCalled();
  });

  it('uses a default pull scope when the challenge has none', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://auth.example.com/')) return { status: 200, body: JSON.stringify({ token: 't' }) };
      if (request.headers?.Authorization === 'Bearer t') return { headers: { 'docker-content-digest': DIGEST } };
      return { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example.com/token?x=1"' } };
    });
    await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/team/app:2'));
    const tokenUrl = new URL(transport.requests[1].url);
    expect(tokenUrl.searchParams.get('x')).toBe('1');
    expect(tokenUrl.searchParams.getAll('scope')).toEqual(['repository:team/app:pull']);
    expect(tokenUrl.searchParams.has('service')).toBe(false);
  });

  it('reports an error when the token response has no token', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://auth.example.com/')) return { status: 200, body: '{"expires_in":300}' };
      return { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example.com/token"' } };
    });
    const result = await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a'));
    expect(result.kind).toBe('error');
  });

  it('retries with Basic credentials on a Basic challenge', async () => {
    const transport = fakeTransport((request) =>
      request.headers?.Authorization === basicHeader('u', 'p')
        ? { headers: { 'docker-content-digest': DIGEST } }
        : { status: 401, headers: { 'www-authenticate': 'Basic realm="Registry"' } },
    );
    const client = new RegistryClient(transport, credentialsOf({ username: 'u', password: 'p' }));
    expect(await client.getDigest(ref('registry.example.com/a'))).toEqual({ kind: 'digest', digest: DIGEST });
    expect(transport.requests).toHaveLength(2);
  });

  it('reports authRequired on a Basic challenge without credentials, and when Basic credentials are rejected', async () => {
    const transport = fakeTransport(() => ({ status: 401, headers: { 'www-authenticate': 'Basic realm="Registry"' } }));
    expect(await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a'))).toEqual({
      kind: 'authRequired',
      registry: 'registry.example.com',
    });
    expect(
      await new RegistryClient(transport, credentialsOf({ username: 'u', password: 'wrong' })).getDigest(ref('registry.example.com/a')),
    ).toEqual({ kind: 'authRequired', registry: 'registry.example.com' });
  });

  it('maps status codes', async () => {
    const statusOf = async (status: number) =>
      new RegistryClient(fakeTransport(() => ({ status })), noCredentials).getDigest(ref('registry.example.com/a'));
    expect(await statusOf(404)).toEqual({ kind: 'notFound', registry: 'registry.example.com' });
    expect(await statusOf(403)).toEqual({ kind: 'authRequired', registry: 'registry.example.com' });
    expect((await statusOf(401)).kind).toBe('authRequired');
    expect((await statusOf(500)).kind).toBe('unreachable');
    expect((await statusOf(503)).kind).toBe('unreachable');
    expect((await statusOf(429)).kind).toBe('error');
    expect((await statusOf(400)).kind).toBe('error');
  });

  it('reports a failed name resolution as unreachable', async () => {
    const error = Object.assign(new Error('getaddrinfo ENOTFOUND ghcr.io'), { code: 'ENOTFOUND' });
    const result = await new RegistryClient(fakeTransport(() => error), noCredentials).getDigest(ref('ghcr.io/o/r'));
    expect(result).toEqual({ kind: 'unreachable', registry: 'ghcr.io', error: 'getaddrinfo ENOTFOUND ghcr.io' });
  });

  it('reports a failed token request as unreachable', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://auth.example.com/')) return new Error('connect ECONNREFUSED');
      return { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example.com/token"' } };
    });
    const result = await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a'));
    expect(result.kind).toBe('unreachable');
  });

  it('reports an abort as unreachable, also when the transport ignores the signal', async () => {
    const controller = new AbortController();
    const client = new RegistryClient(fakeTransport(() => 'hang'), noCredentials);
    const pending = client.getDigest(ref('ghcr.io/o/r'), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: 'unreachable', registry: 'ghcr.io', error: 'No answer in time.' });
  });

  it('ends a hanging credential lookup when the signal aborts', async () => {
    const controller = new AbortController();
    const transport = fakeTransport(() => ({ status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } }));
    const client = new RegistryClient(transport, () => new Promise(() => {}));
    const pending = client.getDigest(ref('registry.example.com/a'), controller.signal);
    setTimeout(() => controller.abort(), 10);
    expect((await pending).kind).toBe('unreachable');
  });

  it('calls the credentials provider once per registry and signal, with a signal that follows the check', async () => {
    const credentials = credentialsOf({ username: 'u', password: 'p' });
    const transport = fakeTransport((request) =>
      request.headers?.Authorization ? { headers: { 'docker-content-digest': DIGEST } } : { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } },
    );
    const client = new RegistryClient(transport, credentials);
    const controller = new AbortController();
    await Promise.all([
      client.getDigest(ref('registry.example.com/a'), controller.signal),
      client.getDigest(ref('registry.example.com/b'), controller.signal),
    ]);
    expect(credentials).toHaveBeenCalledTimes(1);
    expect(credentials.mock.calls[0][0]).toBe('registry.example.com');
    const lookupSignal = credentials.mock.calls[0][1] as AbortSignal;
    expect(lookupSignal).toBeInstanceOf(AbortSignal);
    expect(lookupSignal.aborted).toBe(false);
  });

  it('aborts the credentials lookup when the check aborts', async () => {
    let lookupSignal: AbortSignal | undefined;
    const credentials: CredentialsProvider = (_registry, signal) => {
      lookupSignal = signal;
      return new Promise(() => {});
    };
    const transport = fakeTransport(() => ({ status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } }));
    const controller = new AbortController();
    const pending = new RegistryClient(transport, credentials).getDigest(ref('registry.example.com/a'), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect((await pending).kind).toBe('unreachable');
    expect(lookupSignal?.aborted).toBe(true);
  });

  it('asks without credentials when the credentials lookup takes too long (for example a keychain prompt)', async () => {
    let lookupSignal: AbortSignal | undefined;
    const credentials: CredentialsProvider = (_registry, signal) => {
      lookupSignal = signal;
      return new Promise(() => {});
    };
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://ghcr.io/token')) {
        return request.headers?.Authorization ? { status: 403 } : { status: 200, body: JSON.stringify({ token: 'anon' }) };
      }
      if (request.headers?.Authorization === 'Bearer anon') return { headers: { 'docker-content-digest': DIGEST } };
      return { status: 401, headers: { 'www-authenticate': bearerChallenge('https://ghcr.io/token', 'ghcr.io', 'repository:o/r:pull') } };
    });
    const warnings: string[] = [];
    const logger = { info() {}, warn: (message: string) => warnings.push(message), error() {}, output() {} };
    const client = new RegistryClient(transport, credentials, logger, { credentialsTimeoutMs: 20 });
    const controller = new AbortController();
    expect(await client.getDigest(ref('ghcr.io/o/r'), controller.signal)).toEqual({ kind: 'digest', digest: DIGEST });
    expect(controller.signal.aborted).toBe(false);
    // The helper process is ended, and the token request is sent without credentials.
    expect(lookupSignal?.aborted).toBe(true);
    expect(transport.requests.find((request) => request.url.startsWith('https://ghcr.io/token'))?.headers?.Authorization).toBeUndefined();
    expect(warnings.some((message) => message.includes('not available in time'))).toBe(true);
  });

  it('reports authRequired, not unreachable, when the credentials lookup for a Basic challenge takes too long', async () => {
    const transport = fakeTransport(() => ({ status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } }));
    const client = new RegistryClient(transport, () => new Promise(() => {}), undefined, { credentialsTimeoutMs: 20 });
    expect(await client.getDigest(ref('registry.example.com/a'), new AbortController().signal)).toEqual({
      kind: 'authRequired',
      registry: 'registry.example.com',
    });
  });

  it('keeps the credentials time limit below the time limit of the check', () => {
    expect(CREDENTIALS_TIMEOUT_MS).toBeLessThanOrEqual(IMAGE_CHECK_TIMEOUT_MS / 2);
  });

  it('computes the digest with GET when the header is missing', async () => {
    const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] });
    const expected = `sha256:${crypto.createHash('sha256').update(manifest).digest('hex')}`;
    const transport = fakeTransport((request) => (request.method === 'GET' ? { body: manifest } : { status: 200 }));
    const result = await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a:1'));
    expect(result).toEqual({ kind: 'digest', digest: expected });
    expect(transport.requests.map((request) => request.method)).toEqual(['HEAD', 'GET']);
    expect(transport.requests[1].headers?.Accept).toBe(MANIFEST_ACCEPT);
  });

  it('prefers the digest header of the GET response', async () => {
    const transport = fakeTransport((request) =>
      request.method === 'GET' ? { body: '{}', headers: { 'docker-content-digest': DIGEST } } : { status: 200 },
    );
    expect(await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a'))).toEqual({
      kind: 'digest',
      digest: DIGEST,
    });
  });

  it('keeps the token for the GET fallback', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://auth.example.com/')) return { status: 200, body: JSON.stringify({ token: 't' }) };
      if (request.headers?.Authorization !== 'Bearer t') {
        return { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example.com/token"' } };
      }
      return request.method === 'GET' ? { body: '{"a":1}' } : { status: 200 };
    });
    const result = await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a'));
    expect(result.kind).toBe('digest');
  });

  it('uses GET when the registry does not support HEAD', async () => {
    const transport = fakeTransport((request) =>
      request.method === 'GET' ? { headers: { 'docker-content-digest': DIGEST }, body: '{}' } : { status: 405 },
    );
    expect(await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a'))).toEqual({
      kind: 'digest',
      digest: DIGEST,
    });
    expect(transport.requests.map((request) => request.method)).toEqual(['HEAD', 'GET']);
  });

  it('never uses GET on Docker Hub', async () => {
    const transport = fakeTransport(() => ({ status: 200 }));
    const result = await new RegistryClient(transport, noCredentials).getDigest(ref('ubuntu:22.04'));
    expect(result.kind).toBe('error');
    expect(transport.requests.map((request) => request.method)).toEqual(['HEAD']);
    const noHead = fakeTransport(() => ({ status: 405 }));
    expect((await new RegistryClient(noHead, noCredentials).getDigest(ref('ubuntu'))).kind).toBe('error');
    expect(noHead.requests.map((request) => request.method)).toEqual(['HEAD']);
  });

  it('ignores an invalid digest header', async () => {
    const transport = fakeTransport((request) => (request.method === 'GET' ? { body: 'x' } : { headers: { 'docker-content-digest': 'nonsense' } }));
    const result = await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a'));
    expect(result).toEqual({ kind: 'digest', digest: `sha256:${crypto.createHash('sha256').update('x').digest('hex')}` });
  });

  it('follows redirects and drops the Authorization header on another host', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://registry.example.com/')) {
        if (!request.headers?.Authorization) return { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } };
        return { status: 307, headers: { location: 'https://cdn.example.net/manifest' } };
      }
      return { headers: { 'docker-content-digest': DIGEST } };
    });
    const client = new RegistryClient(transport, credentialsOf({ username: 'u', password: 'p' }));
    expect(await client.getDigest(ref('registry.example.com/a'))).toEqual({ kind: 'digest', digest: DIGEST });
    const last = transport.requests[transport.requests.length - 1];
    expect(last.url).toBe('https://cdn.example.net/manifest');
    expect(last.method).toBe('HEAD');
    expect(last.headers?.Authorization).toBeUndefined();
  });

  it('does not send registry credentials to the token service of a host that the registry redirected to', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://registry.example.com/')) {
        return { status: 307, headers: { location: 'https://cdn.other-host.net/x' } };
      }
      if (request.url.startsWith('https://cdn.other-host.net/token')) return { status: 200, body: JSON.stringify({ token: 't' }) };
      return { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://cdn.other-host.net/token"' } };
    });
    const credentials = credentialsOf({ username: 'u', password: 'p' });
    const warnings: string[] = [];
    const logger = { info() {}, warn: (message: string) => warnings.push(message), error() {}, output() {} };
    const client = new RegistryClient(transport, credentials, logger);
    expect(await client.getDigest(ref('registry.example.com/team/app'), new AbortController().signal)).toEqual({
      kind: 'authRequired',
      registry: 'registry.example.com',
    });
    expect(credentials).not.toHaveBeenCalled();
    expect(transport.requests.some((request) => request.headers?.Authorization !== undefined)).toBe(false);
    expect(transport.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'HEAD https://registry.example.com/v2/team/app/manifests/latest',
      'HEAD https://cdn.other-host.net/x',
    ]);
    expect(warnings.some((message) => message.includes('cdn.other-host.net'))).toBe(true);
  });

  it('answers a 401 after a redirect on the same host with the credentials of the registry', async () => {
    const transport = fakeTransport((request) => {
      if (request.url.startsWith('https://auth.example.com/')) {
        return request.headers?.Authorization === basicHeader('u', 'p') ? { status: 200, body: JSON.stringify({ token: 't' }) } : { status: 401 };
      }
      if (request.url.endsWith('/manifests/latest')) return { status: 308, headers: { location: '/v2/a/manifests/moved' } };
      if (request.headers?.Authorization === 'Bearer t') return { headers: { 'docker-content-digest': DIGEST } };
      return { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example.com/token"' } };
    });
    const credentials = credentialsOf({ username: 'u', password: 'p' });
    expect(await new RegistryClient(transport, credentials).getDigest(ref('registry.example.com/a'))).toEqual({ kind: 'digest', digest: DIGEST });
    expect(credentials).toHaveBeenCalledWith('registry.example.com', expect.any(AbortSignal));
  });

  it('does not follow a redirect to HTTP', async () => {
    const transport = fakeTransport((request) =>
      request.url.startsWith('https://') ? { status: 302, headers: { location: 'http://registry.example.com/x' } } : { status: 200 },
    );
    const result = await new RegistryClient(transport, noCredentials).getDigest(ref('registry.example.com/a'));
    expect(result.kind).toBe('error');
    expect(transport.requests).toHaveLength(1);
  });
});
