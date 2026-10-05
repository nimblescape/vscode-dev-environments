// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #109 (plan step 11E3a), reviewer B: the probes of the mutation testing of bypassesProxy (the
// loopback) and of the check of the certificate of a registry of an IP address through the tunnel. Every server here is
// local (127.0.0.1); an address in a URL is only ever the target of a CONNECT at a local proxy. A test certificate (made
// here, for 127.0.0.1 and 10.1.2.4) is added to the trusted ones of each `tls.connect` (vi.mock), so that only the check
// of the name decides.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bypassesProxy, proxiedHttpsTransport } from './proxyTransport';

const trusted = vi.hoisted(() => [] as string[]);
vi.mock('tls', async (importOriginal) => {
  const original = await importOriginal<typeof import('tls')>();
  const connect = ((options: import('tls').ConnectionOptions) => original.connect({ ca: [...original.rootCertificates, ...trusted], ...options })) as typeof original.connect;
  return { ...original, default: { ...original, connect }, connect };
});

describe('bypassesProxy, review round 2 of PR #109 (B)', () => {
  it('the IPv6 loopback in any spelling is direct; the unspecified address and its neighbours are not', () => {
    const cases: [string, boolean][] = [
      ['0:0:0:0:0:0:0:1', true],
      ['0000::0001', true],
      ['::', false],
      ['::2', false],
      ['fe80::1', false],
    ];
    for (const [host, expected] of cases) {
      expect(bypassesProxy(host, 443, undefined), host).toBe(expected);
    }
  });
});

describe('the certificate of a registry of an IP address through the tunnel, review round 2 of PR #109 (B)', () => {
  let dir: string;
  let key: Buffer;
  let cert: Buffer;
  const closers: (() => Promise<void>)[] = [];
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-proxy-r2-'));
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=probe', '-addext', 'subjectAltName=IP:127.0.0.1,IP:10.1.2.4', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    );
    key = fs.readFileSync(path.join(dir, 'key.pem'));
    cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    trusted.push(cert.toString());
  });
  afterAll(() => {
    trusted.length = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });
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

  it('is checked for the address of the URL, never for the address of the proxy (which the certificate has)', async () => {
    const registryPort = await listen(https.createServer({ key, cert }, (_req, res) => res.writeHead(200).end('{}')));
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
    const transport = proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${proxyPort}` }));
    // The address that the certificate has: the request goes through (the test certificate is trusted).
    expect((await transport.request({ method: 'GET', url: 'https://10.1.2.4/v2/' })).status).toBe(200);
    // Another address: refused, although the certificate has the address of the proxy (127.0.0.1).
    await expect(transport.request({ method: 'GET', url: 'https://10.1.2.3/v2/' })).rejects.toThrow(/10\.1\.2\.3/);
    expect(connects).toEqual(['10.1.2.4:443', '10.1.2.3:443']);
  });
});
