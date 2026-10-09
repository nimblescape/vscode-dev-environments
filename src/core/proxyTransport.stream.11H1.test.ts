// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"; decision C1 of 2026-10-05): the streamed GET of
// the worker (the download of a VS Code server), over the same connection rules as its requests: only HTTPS, through the
// tunnel of the daemon's proxy, the body as it comes (binary, never decoded or buffered as a whole), no redirect followed.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { httpsStream } from './http';
import { proxiedHttpsTransport } from './proxyTransport';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

describe('the streamed GET of the worker (plan step 11H1)', () => {
  it('goes through the tunnel of the proxy to the host and port of the URL; only HTTPS', async () => {
    let deliver: (data: Buffer) => void = () => undefined;
    const received = new Promise<Buffer>((resolve) => (deliver = resolve));
    const target = net.createServer((socket) => {
      socket.once('data', (data) => {
        deliver(data);
        socket.destroy();
      });
    });
    const targetPort = await listen(target);
    const connects: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
      connects.push(req.url ?? '');
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    const transport = proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${proxyPort}` }));
    const streamed = transport.stream('https://update.code.visualstudio.com/commit:x/server-linux-x64/stable');
    const first = await received;
    await expect(streamed).rejects.toThrow();
    expect(connects).toEqual(['update.code.visualstudio.com:443']);
    // A TLS ClientHello for the name of the host; the path never in clear text.
    expect(first[0]).toBe(22);
    expect(first.includes(Buffer.from('update.code.visualstudio.com'))).toBe(true);
    expect(first.includes(Buffer.from('server-linux-x64'))).toBe(false);
    await expect(transport.stream('http://update.code.visualstudio.com/x')).rejects.toThrow('without TLS');
  });

  describe('against an HTTPS server', () => {
    let dir: string;
    let key: Buffer;
    let cert: Buffer;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-stream-tls-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
      key = fs.readFileSync(path.join(dir, 'key.pem'));
      cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('streams a binary body unchanged, and leaves a redirect to the caller', async () => {
      // Bytes that are no UTF-8 (the buffered request would change them).
      const body = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 7 + 128) % 256));
      const server = https.createServer({ key, cert }, (req, res) => {
        if (req.url === '/moved') {
          res.writeHead(302, { Location: 'https://localhost/elsewhere' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Length': String(body.length), 'X-Name': 'Server' });
        res.end(body);
      });
      const port = await listen(server);
      const response = await httpsStream(`https://localhost:${port}/server.tar.gz`, undefined, { ca: cert });
      expect(response.status).toBe(200);
      expect(response.headers['x-name']).toBe('Server');
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).equals(body)).toBe(true);
      const moved = await httpsStream(`https://localhost:${port}/moved`, undefined, { ca: cert });
      expect(moved.status).toBe(302);
      expect(moved.headers.location).toBe('https://localhost/elsewhere');
      moved.body.destroy();
    });
  });
});
