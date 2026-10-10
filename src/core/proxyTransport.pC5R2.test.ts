// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #141 (cleanup C5, plan step 11J; round 1, A-L1): the stream of the proxy transport (the download
// of the shared VS Code server) destroys its tunnel through the proxy when the request fails before it uses the tunnel,
// as `request` does (tunnelLeak.pC5R1 covers `request`). httpsStream is replaced by one that rejects before it connects;
// a local CONNECT proxy counts the tunnels whose client side is still open. Nothing needs root or writes a file.
import * as http from 'http';
import * as net from 'net';
import { describe, expect, it, vi } from 'vitest';
import { proxiedHttpsTransport } from './proxyTransport';

const state = vi.hoisted(() => ({ refuseStream: false }));

vi.mock('./http', async (importOriginal) => {
  const original = await importOriginal<typeof import('./http')>();
  return {
    ...original,
    httpsStream: (url: string, signal: AbortSignal | undefined, options: import('https').RequestOptions) =>
      state.refuseStream ? Promise.reject(new Error('refused before connecting')) : original.httpsStream(url, signal, options),
  };
});

/** A TCP target and a CONNECT proxy to it that counts the tunnels whose client side has not ended. */
async function proxyToTarget() {
  const sockets: net.Socket[] = [];
  const target = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as net.AddressInfo).port;
  let tunnels = 0;
  const open = new Set<net.Socket>();
  const proxy = http.createServer();
  proxy.on('connection', (socket: net.Socket) => sockets.push(socket));
  proxy.on('connect', (_req: http.IncomingMessage, client: net.Socket) => {
    tunnels++;
    open.add(client);
    const gone = (): boolean => open.delete(client);
    client.on('end', gone);
    client.on('close', gone);
    client.on('error', gone);
    client.resume();
    const upstream = net.connect(targetPort, '127.0.0.1', () => client.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
    sockets.push(upstream);
    upstream.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  return {
    url: `https://registry.test:${targetPort}/server.tar.gz`,
    settings: async () => ({ httpsProxy: `http://127.0.0.1:${proxyPort}` }),
    tunnels: () => tunnels,
    /** The tunnels whose client side is still open, once they had up to 2 s to end. */
    async openTunnels(): Promise<number> {
      const deadline = Date.now() + 2000;
      while (open.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      return open.size;
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => target.close(resolve));
    },
  };
}

describe('the stream of the proxy transport (review round 2 of PR #141)', () => {
  it('destroys the tunnel of a stream that fails before it uses it', async () => {
    const setup = await proxyToTarget();
    state.refuseStream = true;
    try {
      await expect(proxiedHttpsTransport(setup.settings).stream(setup.url)).rejects.toThrow('refused before connecting');
      expect(setup.tunnels()).toBe(1);
      expect(await setup.openTunnels()).toBe(0);
    } finally {
      state.refuseStream = false;
      await setup.close();
    }
  }, 20_000);
});
