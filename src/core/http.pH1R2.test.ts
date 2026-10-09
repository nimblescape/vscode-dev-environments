// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11H1 (reviewer B, mutation testing): probes of the size cap of httpsRequest (review round 1
// of 11H1: `maxBodyBytes`) that no test held: a `maxBodyBytes` above the transport's own 16 MiB never raises the cap, and
// a body over the cap ends the connection (a server that keeps sending is not read on for good). Every server here is
// local (127.0.0.1, plain HTTP through `createConnection`); the host name of a URL is never resolved.
import * as http from 'http';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpsRequest } from './http';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: http.Server): Promise<{ createConnection: () => net.Socket }> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { createConnection: () => net.connect(port, '127.0.0.1') };
}

describe('the size cap of httpsRequest, probes (review round 2 of 11H1, reviewer B)', () => {
  it('a maxBodyBytes above 16 MiB keeps the cap of 16 MiB', async () => {
    const size = 16 * 1024 * 1024 + 1;
    const options = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-length': String(size) });
        res.end(Buffer.alloc(size, 'a'));
      }),
    );
    await expect(httpsRequest({ method: 'GET', url: 'https://update.code.visualstudio.com/x', maxBodyBytes: 64 * 1024 * 1024 }, undefined, options)).rejects.toThrow('is too large');
  });

  it('a body over the cap ends the connection (a server that keeps sending is not read on)', async () => {
    let closed: () => void = () => undefined;
    const socketClosed = new Promise<void>((resolve) => (closed = resolve));
    const options = await listen(
      http.createServer((req, res) => {
        req.socket.on('close', () => closed());
        // 200 bytes at once, then the body never ends.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(Buffer.alloc(200, 'a'));
      }),
    );
    await expect(httpsRequest({ method: 'GET', url: 'https://update.code.visualstudio.com/x', maxBodyBytes: 100 }, undefined, options)).rejects.toThrow('is too large');
    const outcome = await Promise.race([socketClosed.then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('open'), 2_000))]);
    expect(outcome).toBe('closed');
  });
});
