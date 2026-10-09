// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #109 (plan step 11E3a), reviewer B: the probes of the mutation testing of proxyTransport.ts and
// httpsRequest (http.ts). Every server here is local (127.0.0.1); a host name in a URL is only ever the target of a
// CONNECT at a local proxy, never resolved.
import * as http from 'http';
import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpsRequest, nodeHttpsTransport } from './http';
import { bypassesProxy, proxiedHttpsTransport, proxyFor } from './proxyTransport';

// The options of each request of proxyTransport.ts to a proxy (the real `http.request`, recorded).
const proxyRequests = vi.hoisted(() => [] as { host?: unknown; port?: unknown }[]);
vi.mock('http', async (importOriginal) => {
  const original = await importOriginal<typeof import('http')>();
  const request = ((...args: Parameters<typeof original.request>) => {
    const options = args[0] as { host?: unknown; port?: unknown };
    if (typeof options === 'object' && options !== null && !(options instanceof URL)) proxyRequests.push({ host: options.host, port: options.port });
    return original.request(...args);
  }) as typeof original.request;
  return { ...original, default: { ...original, request }, request };
});

describe('bypassesProxy, review round 1 (B)', () => {
  it('case of an entry, comma without space, leading separators, `*.` domains, odd CIDR blocks, five-digit ports', () => {
    const cases: [string, number, string, boolean][] = [
      ['registry.example.com', 443, 'Example.COM', true],
      ['registry.example.com', 443, 'other.com,example.com', true],
      ['registry.example.com', 443, ',example.com', true],
      ['registry.example.com', 443, ' example.com', true],
      ['registry.example.com', 443, '*.example.com', true],
      ['badexample.com', 443, '*.example.com', false],
      ['a.10.1.2.3', 443, '10.1.2.3', false],
      // Review round 1 of PR #109 (A-L2): changed input, the loopback `::1` is always direct now; an IPv6 address of
      // another family than the block (before: '::1').
      ['fd00::1', 443, '10.0.0.0/8', false],
      ['10.1.2.3', 443, '::/0', false],
      ['10.1.2.3', 443, '10.0.0.0/33', false],
      ['registry.example.com', 10443, 'example.com:10443', true],
      ['registry.example.com', 443, 'example.com:10443', false],
    ];
    for (const [host, port, noProxy, expected] of cases) {
      expect(bypassesProxy(host, port, noProxy), `${host}:${port} ${noProxy}`).toBe(expected);
    }
  });
});

describe('proxyFor, review round 1 (B)', () => {
  it('port 443 by default for NoProxy, an IPv6 host without brackets, a scheme in capitals', () => {
    const settings = { httpsProxy: 'http://proxy.corp:3128' };
    expect(proxyFor(new URL('https://ghcr.io/v2/'), { ...settings, noProxy: 'ghcr.io:443' })).toBeUndefined();
    expect(proxyFor(new URL('https://ghcr.io/v2/'), { ...settings, noProxy: 'ghcr.io:80' })?.href).toBe('http://proxy.corp:3128/');
    expect(proxyFor(new URL('https://[fd00::7]:5000/v2/'), { ...settings, noProxy: 'fd00::/8' })).toBeUndefined();
    expect(proxyFor(new URL('https://[fd00::7]:5000/v2/'), { ...settings, noProxy: 'fd00::7' })).toBeUndefined();
    expect(proxyFor(new URL('https://ghcr.io/v2/'), { httpsProxy: 'HTTP://proxy.corp:3128' })?.href).toBe('http://proxy.corp:3128/');
  });
});

describe('proxiedHttpsTransport and httpsRequest, review round 1 (B)', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    proxyRequests.length = 0;
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

  /** A TCP server that records the first bytes that a client sends and never answers. */
  async function silent(): Promise<{ port: number; received: Promise<Buffer> }> {
    let deliver: (data: Buffer) => void = () => undefined;
    const received = new Promise<Buffer>((resolve) => (deliver = resolve));
    const server = net.createServer((socket) => {
      socket.once('data', deliver);
      socket.on('error', () => undefined);
    });
    return { port: await listen(server), received };
  }

  /** A proxy that tunnels every CONNECT to 127.0.0.1:`targetPort`. */
  async function proxy(targetPort: number): Promise<{ port: number; connects: string[] }> {
    const connects: string[] = [];
    const server = http.createServer();
    server.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
      connects.push(req.url ?? '');
      client.on('error', () => undefined);
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
    return { port: await listen(server), connects };
  }

  it('an IPv6 host: CONNECT with its brackets once, and no SNI with an IP address (IPv4 or IPv6)', async () => {
    for (const [url, connect, text] of [
      ['https://[fd00::7]:5000/v2/', '[fd00::7]:5000', 'fd00::7'],
      ['https://10.9.8.7:5000/v2/', '10.9.8.7:5000', '10.9.8.7'],
    ] as const) {
      const target = await silent();
      const { port, connects } = await proxy(target.port);
      const controller = new AbortController();
      const request = proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${port}` })).request({ method: 'GET', url }, controller.signal);
      const first = await target.received;
      controller.abort();
      await expect(request).rejects.toThrow();
      expect(connects).toEqual([connect]);
      expect(first[0]).toBe(22);
      expect(first.includes(Buffer.from(text)), url).toBe(false);
    }
  });

  it('an `https://` proxy is spoken to with TLS (a plain proxy never sees the CONNECT)', async () => {
    const target = await silent();
    const plain = await proxy(target.port);
    await expect(proxiedHttpsTransport(async () => ({ httpsProxy: `https://127.0.0.1:${plain.port}` })).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).rejects.toThrow();
    expect(plain.connects).toEqual([]);
  });

  it('a proxy without a port: 80 for `http://`, 443 for `https://`', async () => {
    for (const [httpsProxy, port] of [
      ['http://127.0.0.1', 80],
      ['https://127.0.0.1', 443],
    ] as const) {
      proxyRequests.length = 0;
      const controller = new AbortController();
      const request = proxiedHttpsTransport(async () => ({ httpsProxy })).request({ method: 'GET', url: 'https://ghcr.io/v2/' }, controller.signal);
      // Review round 1 of 11H1 (A-L1): changed timing, the abort comes after the proxy settings were read (before: at
      // once). The read of the settings now ends with the request's signal, so an abort before it ended no longer reaches
      // the tunnel whose port this test checks. The expectation is attached first: the connection to the proxy may fail
      // (nothing listens there) before the abort.
      const rejected = expect(request).rejects.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await rejected;
      if (httpsProxy.startsWith('http:')) expect(proxyRequests).toEqual([{ host: '127.0.0.1', port }]);
      else expect(proxyRequests).toEqual([]);
    }
  });

  it('closes the connection to a proxy that refuses the tunnel', async () => {
    // A proxy as a plain TCP server (an http.Server pauses the socket of a CONNECT): 403, and the connection stays open.
    let closed: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (closed = resolve));
    const server = net.createServer((client) => {
      client.on('error', () => undefined);
      client.on('close', () => closed());
      client.once('data', () => client.write('HTTP/1.1 403 No\r\n\r\n'));
    });
    const port = await listen(server);
    await expect(proxiedHttpsTransport(async () => ({ httpsProxy: `127.0.0.1:${port}` })).request({ method: 'GET', url: 'https://ghcr.io/v2/' })).rejects.toThrow('HTTP 403');
    await done;
  });

  it('a proxy that does not answer the CONNECT in time: the error says so; an abort of the request ends the wait too', async () => {
    const quiet = await silent();
    let limit = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => limit.signal);
    const transport = proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${quiet.port}` }));
    const timed = transport.request({ method: 'GET', url: 'https://ghcr.io/v2/' });
    await quiet.received;
    limit.abort();
    await expect(timed).rejects.toThrow('did not answer within 30 seconds');

    limit = new AbortController();
    const controller = new AbortController();
    const quiet2 = await silent();
    const aborted = proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${quiet2.port}` })).request({ method: 'GET', url: 'https://ghcr.io/v2/' }, controller.signal);
    await quiet2.received;
    controller.abort();
    const error = await aborted.then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );
    expect(error?.name).toBe('AbortError');
    expect(error?.message).not.toContain('did not answer');
  });

  it('the signal of the request ends it after the tunnel and on the direct path; so for nodeHttpsTransport', async () => {
    const tunnelled = await silent();
    const { port } = await proxy(tunnelled.port);
    const viaProxy = new AbortController();
    const one = proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${port}` })).request({ method: 'GET', url: 'https://registry.example.com/v2/' }, viaProxy.signal);
    await tunnelled.received;
    viaProxy.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });

    const direct = await silent();
    const directly = new AbortController();
    const two = proxiedHttpsTransport(async () => ({ httpsProxy: 'http://127.0.0.1:9', noProxy: '127.0.0.1' })).request({ method: 'GET', url: `https://127.0.0.1:${direct.port}/v2/` }, directly.signal);
    await direct.received;
    directly.abort();
    await expect(two).rejects.toMatchObject({ name: 'AbortError' });

    const node = await silent();
    const nodeController = new AbortController();
    const three = nodeHttpsTransport.request({ method: 'GET', url: `https://127.0.0.1:${node.port}/v2/` }, nodeController.signal);
    await node.received;
    nodeController.abort();
    await expect(three).rejects.toMatchObject({ name: 'AbortError' });
  });

  /** An HTTP server (in clear: httpsRequest gets a plain connection) that sends `size` bytes and records the headers. */
  async function plain(size: number): Promise<{ port: number; headers: http.IncomingHttpHeaders[] }> {
    const headers: http.IncomingHttpHeaders[] = [];
    const body = Buffer.alloc(size, 'a');
    const server = http.createServer((req, res) => {
      headers.push(req.headers);
      res.writeHead(200, { 'content-length': String(size), 'X-Probe': ['a', 'b'] });
      res.end(body);
    });
    return { port: await listen(server), headers };
  }

  it('httpsRequest: the headers of the request go out; a body up to 16 MiB is read, a larger one fails', async () => {
    const limit = 16 * 1024 * 1024;
    const exact = await plain(limit);
    const response = await httpsRequest({ method: 'GET', url: 'https://registry.example.com/v2/', headers: { 'X-Probe': 'yes', Accept: 'application/json' } }, undefined, {
      createConnection: () => net.connect(exact.port, '127.0.0.1'),
    });
    expect(response.status).toBe(200);
    expect(response.body.length).toBe(limit);
    expect(response.headers['x-probe']).toBe('a, b');
    expect(exact.headers[0]?.['x-probe']).toBe('yes');
    expect(exact.headers[0]?.accept).toBe('application/json');

    const over = await plain(limit + 1);
    await expect(
      httpsRequest({ method: 'GET', url: 'https://registry.example.com/v2/' }, undefined, { createConnection: () => net.connect(over.port, '127.0.0.1') }),
    ).rejects.toThrow('is too large');
  });
});
