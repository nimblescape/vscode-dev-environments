// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #141 (cleanup C5, plan step 11J, C1; A-L1, from reviewer A's probe): the monitor's tag reads over
// the proxy of the daemon leave no tunnel open: a token that no header may carry is refused before any request carries
// it (registryClient.ts), and a request that fails before it uses its tunnel destroys the tunnel (proxyTransport.ts).
// A local HTTPS registry (a test certificate that only this file's `tls` trusts) and a local CONNECT proxy; nothing needs
// root or writes a file.
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { describe, expect, it, vi } from 'vitest';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { requestsWithin } from './images';
import { daemonProxyTransport } from './main';

const { CERT, KEY } = vi.hoisted(() => ({
  CERT: `-----BEGIN CERTIFICATE-----
MIIBujCCAWGgAwIBAgIUZIkHnepyLbHIF1Xdpp5xnblg514wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNcmVnaXN0cnkudGVzdDAgFw0yNjEwMDUwNTIxMDFaGA8yMTI2
MDkxMTA1MjEwMVowGDEWMBQGA1UEAwwNcmVnaXN0cnkudGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABJtW/zHPvhPxe04fRuP1+U0xFnKDZeW7tl6/KZnzyEnN
KDk4jyZMkx47mRhbq1rdRAq8f9l0agFIZQgRwjkcT5CjgYYwgYMwHQYDVR0OBBYE
FAVVYOW315MCNGLbZ9h38NKxTT4NMB8GA1UdIwQYMBaAFAVVYOW315MCNGLbZ9h3
8NKxTT4NMDAGA1UdEQQpMCeCDXJlZ2lzdHJ5LnRlc3SHBAoJCAeHEP0AAAAAAAAA
AAAAAAAAAAcwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBayN52
WYdZfxOmp74d9azomEENuTQ6EE9+1C9E8fedkgIgVNuddexWEPQxJJR7KYchMgNh
ihiwzVuxOVXsVa6DtII=
-----END CERTIFICATE-----
`,
  KEY: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWU66JStv73vD1Lhr
IvfV+QSeQVIK3tB6FgIEF2SUu6WhRANCAASbVv8xz74T8XtOH0bj9flNMRZyg2Xl
u7ZevymZ88hJzSg5OI8mTJMeO5kYW6ta3UQKvH/ZdGoBSGUIEcI5HE+Q
-----END PRIVATE KEY-----
`,
}));

vi.mock('tls', async (importOriginal) => {
  const original = await importOriginal<typeof import('tls')>();
  const connect = ((options: import('tls').ConnectionOptions) => original.connect({ ca: [...original.rootCertificates, CERT], ...options })) as typeof original.connect;
  return { ...original, default: { ...original, connect }, connect };
});

vi.mock('tls', async (importOriginal) => {
  const original = await importOriginal<typeof import('tls')>();
  const connect = ((options: import('tls').ConnectionOptions) => original.connect({ ca: [...original.rootCertificates, CERT], ...options })) as typeof original.connect;
  return { ...original, default: { ...original, connect }, connect };
});

/** A registry that wants the Bearer token `good` and hands out `token`, and a CONNECT proxy that counts its tunnels. */
async function registryBehindProxy(token: string) {
  let registry = '';
  const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://registry.test');
    if (url.pathname === '/token') {
      res.writeHead(200).end(JSON.stringify({ token }));
      return;
    }
    if (req.headers.authorization === 'Bearer good') {
      res.writeHead(200).end('{"tags":["1"]}');
      return;
    }
    res.writeHead(401, { 'www-authenticate': `Bearer realm="https://${registry}/token",service="x"` }).end();
  });
  // An idle connection that never started TLS would stay open for this long: longer than the test waits.
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const registryPort = (server.address() as net.AddressInfo).port;
  registry = `registry.test:${registryPort}`;
  const open = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  const proxy = http.createServer();
  proxy.on('connect', (_req: http.IncomingMessage, client: net.Socket) => {
    open.add(client);
    client.on('close', () => open.delete(client));
    const upstream = net.connect(registryPort, '127.0.0.1', () => {
      upstreams.add(upstream);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    // As a proxy does: a tunnel ends with its upstream connection.
    upstream.on('close', () => client.destroy());
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  return {
    registry,
    engine: { proxy: async () => ({ httpsProxy: `http://127.0.0.1:${proxyPort}` }) },
    /** The tunnels that are still open at the proxy, once they had up to 2 s to close. */
    async openTunnels(): Promise<number> {
      const deadline = Date.now() + 2000;
      while (open.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      return open.size;
    },
    async close(): Promise<void> {
      for (const socket of open) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}

describe('the tag reads over the proxy of the daemon (review round 1 of PR #141, A-L1)', () => {
  it('read the tags with a valid token and leave no tunnel open', async () => {
    const setup = await registryBehindProxy('good');
    try {
      const client = new RegistryClient(requestsWithin(daemonProxyTransport(setup.engine), 3000), async () => undefined);
      expect(await client.listTags(setup.registry, 'team/app')).toEqual({ kind: 'tags', tags: ['1'] });
      expect(await setup.openTunnels()).toBe(0);
    } finally {
      await setup.close();
    }
  }, 20_000);

  it('refuse a token with CR/LF before it is sent, and leave no tunnel open', async () => {
    const setup = await registryBehindProxy('bad\r\nX-Injected: 1');
    try {
      const client = new RegistryClient(requestsWithin(daemonProxyTransport(setup.engine), 3000), async () => undefined);
      expect(await client.listTags(setup.registry, 'team/app')).toEqual({
        kind: 'error',
        registry: setup.registry,
        error: 'The token service returned an invalid token.',
      });
      expect(await setup.openTunnels()).toBe(0);
    } finally {
      await setup.close();
    }
  }, 20_000);

  it('destroy the tunnel of a request that fails before it uses it (a header value that https.request refuses)', async () => {
    const setup = await registryBehindProxy('good');
    try {
      const transport = daemonProxyTransport(setup.engine);
      await expect(
        transport.request({ method: 'GET', url: `https://${setup.registry}/v2/`, headers: { Authorization: 'Bearer bad\r\nX-Injected: 1' } }),
      ).rejects.toThrow(/Invalid character in header content/);
      expect(await setup.openTunnels()).toBe(0);
    } finally {
      await setup.close();
    }
  }, 20_000);
});
