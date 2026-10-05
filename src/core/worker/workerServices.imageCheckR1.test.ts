// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #109 (plan step 11E3a), reviewer B: the probes of the mutation testing of the worker's image check
// (workerImageChecker, hostRegistryCredentials, the `imageChecker` of workerServiceDeps). A local registry with TLS (a
// test certificate for `registry.test`) is reached through a local proxy (CONNECT),
// as the proxy of the daemon gives it; nothing leaves 127.0.0.1. The test certificate is added to the trusted ones of each
// `tls.connect` of the worker's code (vi.mock: Node 20 has no tls.setDefaultCACertificates).
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { hostRegistryCredentials, registryLogins, workerImageChecker, workerServiceDeps } from './workerServices';
import { SECRET_REGISTRY } from '../helperChannel/protocol';

// A test certificate (self-signed, EC P-256, until 2126) for registry.test, 10.9.8.7 and fd00::7. Test data only.
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
const DIGEST = `sha256:${'d'.repeat(64)}`;

vi.mock('tls', async (importOriginal) => {
  const original = await importOriginal<typeof import('tls')>();
  const connect = ((options: import('tls').ConnectionOptions) => original.connect({ ca: [...original.rootCertificates, CERT], ...options })) as typeof original.connect;
  return { ...original, default: { ...original, connect }, connect };
});

describe("the worker's image check, review round 1 of PR #109 (B)", () => {
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
   * A registry (HTTPS, registry.test) with a Bearer token service that rejects every login (401) and gives an anonymous
   * token; with that token, the digest of each manifest. A proxy that tunnels every CONNECT to it.
   */
  async function registryBehindProxy(): Promise<{ registry: string; proxyPort: number; connects: string[]; tokenLogins: string[] }> {
    const tokenLogins: string[] = [];
    let registry = '';
    const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
      const url = new URL(req.url ?? '/', 'https://registry.test');
      if (url.pathname === '/token') {
        if (req.headers.authorization !== undefined) {
          tokenLogins.push(req.headers.authorization);
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'anonymous' }));
        return;
      }
      if (req.headers.authorization !== 'Bearer anonymous') {
        res.writeHead(401, { 'www-authenticate': `Bearer realm="https://${registry}/token",service="registry.test"` }).end();
        return;
      }
      res.writeHead(200, { 'docker-content-digest': DIGEST }).end();
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
    return { registry, proxyPort: await listen(proxy), connects, tokenLogins };
  }

  function recording() {
    const events: string[] = [];
    const host = {
      secrets: {
        registry: async (registry: string) => {
          events.push(`ask ${registry}`);
          return { username: 'octo', serveraddress: registry, password: 'pw-1234' };
        },
      },
    } as unknown as HostSide;
    const logger: Logger = { ...silentLogger, warn: (text: string) => void events.push(`warn ${text}`) };
    return { events, host, logger };
  }

  it('goes through the proxy of the daemon, asks the login of the registry and forgets the registry secret, logs a rejected login', async () => {
    const { registry, proxyPort, connects, tokenLogins } = await registryBehindProxy();
    const { events, host, logger } = recording();
    let proxies = 0;
    const checker = workerImageChecker({
      host,
      engine: { ...unusedEngine(), proxy: async () => (proxies++, { httpsProxy: `http://127.0.0.1:${proxyPort}` }) },
      forgetSecret: (name) => void events.push(`forget ${name}`),
      logger,
    });
    const outcome = await checker.check({ images: [`${registry}/team/app:1`], features: [] }, { timeoutMs: 4000 });
    expect(outcome).toMatchObject({ status: 'checked', images: { [`${registry}/team/app:1`]: DIGEST } });
    expect(proxies).toBe(1);
    expect(connects.length).toBeGreaterThan(0);
    expect(new Set(connects)).toEqual(new Set([registry]));
    expect(tokenLogins).toEqual([`Basic ${Buffer.from('octo:pw-1234').toString('base64')}`]);
    expect(events.slice(0, 2)).toEqual([`ask ${registry}`, `forget ${SECRET_REGISTRY}`]);
    expect(events).toContain(`warn The registry ${registry} rejected the login of this computer.`);
  });

  it('the image check of workerServiceDeps is this one (the proxy of its engine, its forgetSecret)', async () => {
    const { registry, proxyPort, connects } = await registryBehindProxy();
    const { events, host, logger } = recording();
    const all = workerServiceDeps({
      host,
      engine: { ...unusedEngine(), proxy: async () => ({ httpsProxy: `http://127.0.0.1:${proxyPort}` }) },
      secretOf: () => undefined,
      forgetSecret: (name) => void events.push(`forget ${name}`),
      logger,
      ownHelper: { image: { tag: 'devenv-helper:abc', id: `sha256:${'c'.repeat(64)}` }, socket: '/s.sock' },
      dockerHost: '',
      owner: { windowId: 'w', pid: 1 },
      environmentLock: async () => {
        throw new Error('no lock in this test');
      },
    });
    const outcome = await all.imageChecker.check({ images: [`${registry}/team/app:1`], features: [] }, { timeoutMs: 4000 });
    expect(outcome).toMatchObject({ status: 'checked', images: { [`${registry}/team/app:1`]: DIGEST } });
    expect(new Set(connects)).toEqual(new Set([registry]));
    expect(events.slice(0, 2)).toEqual([`ask ${registry}`, `forget ${SECRET_REGISTRY}`]);
  });

  it('hostRegistryCredentials: a failed request is logged with the registry and its reason, no login is not; a login without a user name', async () => {
    for (const [answer, warnings] of [
      [() => Promise.reject(new Error('channel closed')), ['The login of ghcr.io could not be asked: channel closed']],
      [async () => undefined, []],
    ] as const) {
      const logged: string[] = [];
      // Review round 1 of PR #109 (A-H1): changed call, the logins of the operation go through registryLogins.
      const provider = hostRegistryCredentials(
        registryLogins({ secrets: { registry: answer } } as unknown as HostSide, () => undefined, { ...silentLogger, warn: (text: string) => void logged.push(text) }),
      );
      expect(await provider('ghcr.io')).toBeUndefined();
      expect(logged).toEqual(warnings);
    }
    const plain = hostRegistryCredentials(registryLogins({ secrets: { registry: async () => ({ serveraddress: 'ghcr.io', password: 'p1' }) } } as unknown as HostSide, () => undefined, silentLogger));
    expect(await plain('ghcr.io')).toEqual({ username: '', password: 'p1' });
  });
});
