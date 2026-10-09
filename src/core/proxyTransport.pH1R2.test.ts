// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11H1 (reviewer B, mutation testing): a probe of the wait for the proxy settings with the
// request's signal (review round 1 of 11H1, A-L1) that no test held: the wait leaves no listener on the request's signal
// behind (one per request on a signal that lives longer, such as the signal of an open). Every server here is local
// (127.0.0.1); the host name of a URL is only ever the target of a CONNECT at a local proxy, never resolved.
import { getEventListeners } from 'events';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { proxiedHttpsTransport } from './proxyTransport';

const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A proxy (plain TCP) that refuses every tunnel with 403 and closes. */
async function refusingProxy(): Promise<number> {
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    client.once('data', () => client.end('HTTP/1.1 403 No\r\nContent-Length: 0\r\n\r\n'));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

describe('the wait for the proxy settings, probes (review round 2 of 11H1, reviewer B)', () => {
  it("leaves no listener on the request's signal once the settings are read", async () => {
    const port = await refusingProxy();
    const transport = proxiedHttpsTransport(async () => ({ httpsProxy: `http://127.0.0.1:${port}` }));
    const controller = new AbortController();
    for (let i = 0; i < 3; i++) {
      await expect(transport.request({ method: 'GET', url: 'https://ghcr.io/v2/' }, controller.signal)).rejects.toThrow('HTTP 403');
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
