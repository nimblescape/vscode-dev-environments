// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1 (reviewer B, mutation testing): a probe of the streamed GET (httpsStream) that no test
// held: a Cancel (or the time limit of the fetch) ends a request whose server never answers, before any header came; a
// download of the VS Code server would otherwise hold the lock of its version for good.
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpsStream } from './http';

const sockets: net.Socket[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the streamed GET, probe (review round 1 of 11H1, reviewer B)', () => {
  it('an abort ends a request whose server takes the connection and never answers', async () => {
    // Accepts the TCP connection and says nothing (no TLS handshake, no header).
    const server = net.createServer((socket) => void sockets.push(socket));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expect(httpsStream(`https://127.0.0.1:${port}/server.tar.gz`, controller.signal)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
