// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E3a (decision C1 of 2026-10-05): the worker's HTTPS through the proxy of the Docker daemon. The tunnel is
// tested against a local proxy (CONNECT) and a local TCP server that records what the client sends through it: the TLS
// handshake for the name of the host (SNI), never the request in clear text.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bypassesProxy, proxiedHttpsTransport, proxyFor, tlsNameOf } from './proxyTransport';

describe('bypassesProxy (NO_PROXY as Go reads it)', () => {
  it('matches `*`, domains with their subdomains, IP addresses, CIDR blocks and ports; nothing without NoProxy', () => {
    const cases: [string, number, string | undefined, boolean][] = [
      ['registry.example.com', 443, undefined, false],
      ['registry.example.com', 443, '', false],
      ['registry.example.com', 443, '*', true],
      ['registry.example.com', 443, 'example.com', true],
      ['registry.example.com', 443, '.example.com', true],
      // Review round 1 of PR #109 (A-L1): changed expectation, `.example.com` is its subdomains only, as in Go (before: true).
      ['example.com', 443, '.example.com', false],
      ['registry.example.com', 443, '*.example.com', true],
      ['example.com', 443, '*.example.com', false],
      ['REGISTRY.Example.COM.', 443, 'example.com', true],
      ['badexample.com', 443, 'example.com', false],
      ['registry.example.com', 443, 'other.com, example.com', true],
      ['registry.example.com', 443, 'other.com example.com', true],
      ['registry.example.com', 443, 'example.com:8443', false],
      ['registry.example.com', 8443, 'example.com:8443', true],
      ['10.1.2.3', 443, '10.0.0.0/8', true],
      ['11.1.2.3', 443, '10.0.0.0/8', false],
      ['10.1.2.3', 443, '10.1.2.3', true],
      ['10.1.2.4', 443, '10.1.2.3', false],
      ['fd00::1', 443, 'fd00::1', true],
      ['fd00::1', 443, '[fd00::1]', true],
      // Review round 1 of PR #109 (A-L2): an IPv6 address with a port in brackets; localhost and the loopback always.
      ['fd00::1', 443, '[fd00::1]:443', true],
      ['fd00::1', 8443, '[fd00::1]:443', false],
      ['localhost', 443, undefined, true],
      ['LOCALHOST.', 443, '', true],
      ['api.localhost', 443, undefined, true],
      ['127.0.0.1', 443, undefined, true],
      ['127.8.9.10', 443, undefined, true],
      ['::1', 443, undefined, true],
      ['notlocalhost', 443, undefined, false],
      ['fd00::5', 443, 'fd00::/8', true],
      ['registry.example.com', 443, '10.0.0.0/8', false],
      ['10.1.2.3', 443, 'bad/cidr', false],
    ];
    for (const [host, port, noProxy, expected] of cases) {
      expect(bypassesProxy(host, port, noProxy), `${host}:${port} ${noProxy}`).toBe(expected);
    }
  });
});

describe('proxyFor', () => {
  const url = new URL('https://ghcr.io/v2/');
  it('the HTTPS proxy of the daemon, also without a scheme; none without one or for a host of NoProxy', () => {
    expect(proxyFor(url, {})).toBeUndefined();
    expect(proxyFor(url, { httpsProxy: 'http://proxy.corp:3128' })?.href).toBe('http://proxy.corp:3128/');
    expect(proxyFor(url, { httpsProxy: 'proxy.corp:3128' })?.href).toBe('http://proxy.corp:3128/');
    expect(proxyFor(url, { httpsProxy: 'https://proxy.corp' })?.protocol).toBe('https:');
    expect(proxyFor(url, { httpsProxy: 'http://proxy.corp:3128', noProxy: 'ghcr.io' })).toBeUndefined();
  });

  it('refuses a proxy that the worker cannot use (it never goes direct instead)', () => {
    expect(() => proxyFor(url, { httpsProxy: 'socks5://proxy.corp:1080' })).toThrow('socks5:');
    expect(() => proxyFor(url, { httpsProxy: 'http://[bad' })).toThrow('no valid URL');
  });
});

describe('proxiedHttpsTransport', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function listen(server: net.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  }

  /** A TCP server that records the first bytes that a client sends, then closes the connection. */
  async function recorder(): Promise<{ port: number; received: Promise<Buffer> }> {
    let deliver: (data: Buffer) => void = () => undefined;
    const received = new Promise<Buffer>((resolve) => (deliver = resolve));
    const server = net.createServer((socket) => {
      socket.once('data', (data) => {
        deliver(data);
        socket.destroy();
      });
    });
    return { port: await listen(server), received };
  }

  /** A proxy that answers CONNECT with `status` and, for 200, pipes the tunnel to 127.0.0.1:`targetPort`. */
  async function proxy(status: number, targetPort: number): Promise<{ port: number; connects: string[] }> {
    const connects: string[] = [];
    const server = http.createServer();
    server.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
      connects.push(req.url ?? '');
      if (status !== 200) {
        client.end(`HTTP/1.1 ${status} No\r\n\r\n`);
        return;
      }
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    return { port: await listen(server), connects };
  }

  it('tunnels to the host and port of the URL and speaks TLS for the name of the host inside the tunnel', async () => {
    const target = await recorder();
    const { port, connects } = await proxy(200, target.port);
    const transport = proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${port}` }));
    const request = transport.request({ method: 'GET', url: 'https://registry.example.com:5000/v2/' });
    const first = await target.received;
    await expect(request).rejects.toThrow();
    expect(connects).toEqual(['registry.example.com:5000']);
    // A TLS ClientHello (record type 22) with the name of the host (SNI); the path never goes in clear text.
    expect(first[0]).toBe(22);
    expect(first.includes(Buffer.from('registry.example.com'))).toBe(true);
    expect(first.includes(Buffer.from('/v2/'))).toBe(false);
  });

  it('a refusal of the proxy is an error that names it; a sign-in it asks for is named too', async () => {
    const target = await recorder();
    const refusing = await proxy(403, target.port);
    await expect(proxiedHttpsTransport(async () => ({ httpsProxy: `127.0.0.1:${refusing.port}` })).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).rejects.toThrow(
      'refused the connection to ghcr.io:443: HTTP 403',
    );
    const signIn = await proxy(407, target.port);
    await expect(proxiedHttpsTransport(async () => ({ httpsProxy: `127.0.0.1:${signIn.port}` })).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).rejects.toThrow(
      'asks for a sign-in',
    );
  });

  it('a host of NoProxy is reached directly; the proxy is read once; only HTTPS', async () => {
    const target = await recorder();
    const { port, connects } = await proxy(200, target.port);
    let reads = 0;
    const transport = proxiedHttpsTransport(async () => (reads++, { httpsProxy: `http://127.0.0.1:${port}`, noProxy: '127.0.0.1' }));
    await expect(transport.request({ method: 'GET', url: `https://127.0.0.1:${target.port}/v2/` })).rejects.toThrow();
    // Directly to the target: the ClientHello arrives there without a CONNECT at the proxy.
    expect((await target.received)[0]).toBe(22);
    expect(connects).toEqual([]);
    await expect(transport.request({ method: 'GET', url: 'http://registry.example.com/v2/' })).rejects.toThrow('without TLS');
    await expect(transport.request({ method: 'GET', url: `https://127.0.0.1:${target.port}/v2/` })).rejects.toThrow();
    expect(reads).toBe(1);
  });
});

describe('the TLS names through the tunnel (review round 1 of PR #109, A-M1, A-M2)', () => {
  it('a certificate is checked for the host of the URL, also an IP address; SNI only for a name', () => {
    const forName = (names: string) => ({ subject: { CN: '' }, subjectaltname: names }) as unknown as tls.PeerCertificate;
    const ip = tlsNameOf('10.9.9.9');
    expect(ip.servername).toBeUndefined();
    // Node would pass the name of the proxy here; the certificate of the proxy is no certificate of the registry.
    expect(ip.checkServerIdentity!('proxy.local', forName('DNS:proxy.local'))).toBeInstanceOf(Error);
    expect(ip.checkServerIdentity!('proxy.local', forName('IP Address:10.9.9.9'))).toBeUndefined();
    const name = tlsNameOf('registry.example.com');
    expect(name.servername).toBe('registry.example.com');
    expect(name.checkServerIdentity!('other', forName('DNS:registry.example.com'))).toBeUndefined();
    expect(name.checkServerIdentity!('registry.example.com', forName('DNS:proxy.local'))).toBeInstanceOf(Error);
  });

  describe('against TLS servers', () => {
    let dir: string;
    let key: Buffer;
    let cert: Buffer;
    const closers: (() => Promise<void>)[] = [];
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-proxy-tls-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
      key = fs.readFileSync(path.join(dir, 'key.pem'));
      cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    afterEach(async () => {
      for (const close of closers.splice(0)) await close();
    });

    /** A TLS server that records the SNI of each handshake as it starts (`connections`: every TCP connection to it). */
    async function tlsServer(): Promise<{ port: number; names: string[]; connections: () => number }> {
      const names: string[] = [];
      let connections = 0;
      const context = tls.createSecureContext({ key, cert });
      const server = tls.createServer({
        key,
        cert,
        SNICallback: (name, done) => {
          names.push(name);
          done(null, context);
        },
      });
      server.on('connection', () => void connections++);
      server.on('tlsClientError', () => undefined);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      closers.push(() => new Promise((resolve) => server.close(() => resolve())));
      return { port: (server.address() as net.AddressInfo).port, names, connections: () => connections };
    }

    it('an https:// proxy is spoken to with its own name, never the name of the target (A-M2)', async () => {
      const proxy = await tlsServer();
      const transport = proxiedHttpsTransport(async () => ({ httpsProxy: `https://localhost:${proxy.port}` }));
      await expect(transport.request({ method: 'GET', url: 'https://registry.example.com/v2/' })).rejects.toThrow();
      expect(proxy.names).toEqual(['localhost']);
    });

    it('a registry of an IP address gets no SNI through the tunnel, and its certificate is checked (A-M1)', async () => {
      const target = await tlsServer();
      const connects: string[] = [];
      const server = http.createServer();
      server.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
        connects.push(req.url ?? '');
        const upstream = net.connect(target.port, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      closers.push(() => new Promise((resolve) => server.close(() => resolve())));
      const transport = proxiedHttpsTransport(async () => ({ httpsProxy: `http://localhost:${(server.address() as net.AddressInfo).port}` }));
      await expect(transport.request({ method: 'GET', url: 'https://10.9.9.9/v2/' })).rejects.toThrow();
      expect(connects).toEqual(['10.9.9.9:443']);
      // No SNI for the IP address (before, Node took the name of the proxy, `localhost`, which this certificate has).
      expect(target.connections()).toBe(1);
      expect(target.names).toEqual([]);
    });
  });
});
