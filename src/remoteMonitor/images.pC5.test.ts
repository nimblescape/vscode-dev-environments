// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup C5 (plan step 11J, C1; the user's decision of 2026-10-10): the registry checks of the Session Monitor's image
// maintenance go through the proxy of the daemon of its engine, as the worker's image checks and the monitor's VS Code
// downloads (before: the monitor's own `https.get` client, which went around that proxy). A local registry with TLS (a
// test certificate for `registry.test`, which only the proxy resolves) behind a local proxy (CONNECT); nothing leaves
// 127.0.0.1. The test certificate is added to the trusted ones of each `tls.connect` (vi.mock, as
// src/core/worker/workerServices.imageCheckR1.test.ts does).
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageEngine } from './engine';
import { ImageMaintenance, requestsWithin } from './images';
import { daemonProxyTransport } from './main';

// A test certificate (self-signed, EC P-256, until 2126) for registry.test, 10.9.8.7 and fd00::7. Test data only (the one
// of workerServices.imageCheckR1.test.ts).
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

describe("the Session Monitor's registry checks through the proxy of the daemon (cleanup C5, C1)", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function listen(server: net.Server): Promise<number> {
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket: net.Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    );
    return (server.address() as net.AddressInfo).port;
  }

  /**
   * A registry (HTTPS, registry.test) with a Bearer token service that gives an anonymous token, and with it the tags of
   * `team/app` on two pages; `/v2/team/slow/…` trickles a byte at a time, `/v2/team/cut/…` is cut in the middle. A proxy
   * that tunnels every CONNECT to it.
   */
  async function registryBehindProxy() {
    let registry = '';
    const seen: string[] = [];
    const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
      const url = new URL(req.url ?? '/', 'https://registry.test');
      seen.push(`${url.pathname}${url.search} ${req.headers.authorization ?? '-'}`);
      if (url.pathname === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'anonymous' }));
        return;
      }
      if (url.pathname === '/v2/team/slow/tags/list') {
        res.writeHead(200, { 'content-length': '1000' });
        const timer = setInterval(() => res.write('x'), 50);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (url.pathname === '/v2/team/cut/tags/list') {
        res.writeHead(200, { 'content-length': '1000' });
        res.write('{"tags":', () => setTimeout(() => req.socket.destroy(), 20));
        return;
      }
      if (req.headers.authorization !== 'Bearer anonymous') {
        res.writeHead(401, { 'www-authenticate': `Bearer realm="https://${registry}/token",service="registry.test"` }).end();
        return;
      }
      if (url.search === '') res.writeHead(200, { link: '</v2/team/app/tags/list?last=1>; rel="next"' }).end(JSON.stringify({ tags: ['1'] }));
      else res.writeHead(200).end(JSON.stringify({ tags: ['2', 'latest'] }));
    });
    const registryPort = await listen(server);
    registry = `registry.test:${registryPort}`;
    const connects: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
      connects.push(req.url ?? '');
      const upstream = net.connect(registryPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    // The engine of the monitor: the proxy of its daemon (`docker info`), and the images of a pass (none on the engine).
    let proxies = 0;
    const engine = {
      proxy: async () => (proxies++, { httpsProxy: `http://127.0.0.1:${proxyPort}` }),
    };
    return { registry, connects, seen, engine, proxies: () => proxies };
  }

  function imageEngine() {
    const pulls: string[] = [];
    const engine: ImageEngine = {
      images: async () => [],
      inspect: async () => undefined,
      pull: async (reference) => void pulls.push(reference),
      containerIds: async () => [],
      removeImage: async () => 'missing',
    };
    return { engine, pulls };
  }

  it('reads the tags through the proxy of the daemon (the challenge, the token, every page) and pulls the highest major tag', async () => {
    const { registry, connects, seen, engine, proxies } = await registryBehindProxy();
    const images = imageEngine();
    const log: string[] = [];
    await new ImageMaintenance({
      engine: images.engine,
      registryTransport: () => daemonProxyTransport(engine),
      log: (message) => log.push(message),
      prefixes: () => [`${registry}/team/`],
      knownRepositories: async () => [`${registry}/team/app`],
    }).pass();
    expect(log).toEqual([]);
    expect(images.pulls).toEqual([`${registry}/team/app:2`]);
    expect(proxies()).toBe(1);
    expect(new Set(connects)).toEqual(new Set([registry]));
    expect(seen).toEqual([
      '/v2/team/app/tags/list -',
      '/token?service=registry.test&scope=repository%3Ateam%2Fapp%3Apull -',
      '/v2/team/app/tags/list Bearer anonymous',
      '/v2/team/app/tags/list?last=1 Bearer anonymous',
    ]);
  });

  it('a request through the proxy ends within its time limit when the answer trickles, and fails when it is cut', async () => {
    const { registry, engine } = await registryBehindProxy();
    const transport = requestsWithin(daemonProxyTransport(engine), 400);
    const started = Date.now();
    await expect(transport.request({ method: 'GET', url: `https://${registry}/v2/team/slow/tags/list` })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(requestsWithin(daemonProxyTransport(engine), 5_000).request({ method: 'GET', url: `https://${registry}/v2/team/cut/tags/list` })).rejects.toThrow();
    // In a pass: logged, and no pull.
    const images = imageEngine();
    const log: string[] = [];
    await new ImageMaintenance({
      engine: images.engine,
      registryTransport: () => daemonProxyTransport(engine),
      log: (message) => log.push(message),
      prefixes: () => [`${registry}/team/`],
      knownRepositories: async () => [`${registry}/team/cut`],
    }).pass();
    expect(images.pulls).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(new RegExp(`^The tags of ${registry}/team/cut could not be read; it is not updated: `));
  });
});
