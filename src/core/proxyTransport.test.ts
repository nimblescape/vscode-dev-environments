// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E3a (decision C1 of 2026-10-05): the worker's HTTPS through the proxy of the Docker daemon. The tunnel is
// tested against a local proxy (CONNECT) and a local TCP server that records what the client sends through it: the TLS
// handshake for the name of the host (SNI), never the request in clear text.
import * as http from 'http';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { bypassesProxy, proxiedHttpsTransport, proxyFor } from './proxyTransport';

describe('bypassesProxy (NO_PROXY as Go reads it)', () => {
  it('matches `*`, domains with their subdomains, IP addresses, CIDR blocks and ports; nothing without NoProxy', () => {
    const cases: [string, number, string | undefined, boolean][] = [
      ['registry.example.com', 443, undefined, false],
      ['registry.example.com', 443, '', false],
      ['registry.example.com', 443, '*', true],
      ['registry.example.com', 443, 'example.com', true],
      ['registry.example.com', 443, '.example.com', true],
      ['example.com', 443, '.example.com', true],
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
      ['::1', 443, '::1', true],
      ['::1', 443, '[::1]', true],
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
