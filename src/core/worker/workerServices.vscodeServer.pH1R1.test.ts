// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1 (reviewer B, mutation testing): probes of the wiring of the store in the worker
// (workerVscodeStore) that no test held: its lock is the flock of the server version (one download of a version at a
// time across the workers of the engine), and its HTTPS goes through the proxy of the daemon (decision C1 of 2026-10-05).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import { workerVscodeStore } from './workerServices';

const NAME = 'stable-linux-x64-0123456789abcdef0123456789abcdef01234567';
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the store of the worker, probes (review round 1 of 11H1, reviewer B)', () => {
  it('its lock is the flock of the server version: a second holder waits and gives up', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-wiring-'));
    temps.push(root);
    const store = workerVscodeStore({ engine: unusedEngine(), logger: silentLogger });
    const first = await store.lock(root, NAME, 5, new AbortController().signal);
    await expect(store.lock(root, NAME, 1, new AbortController().signal)).rejects.toThrow('the lock of the server stayed held for 1 s');
    first();
    expect(fs.lstatSync(path.join(root, 'locks', `server-${NAME}.lock`)).isFile()).toBe(true);
  });

  it('its HTTPS asks the proxy of the daemon, for the update service and for the download', async () => {
    let asked = 0;
    const engine = {
      ...unusedEngine(),
      proxy: async () => {
        asked++;
        // A proxy that refuses the connection: the request fails, after the proxy was asked.
        return { httpsProxy: 'http://127.0.0.1:9' };
      },
    };
    const store = workerVscodeStore({ engine, logger: silentLogger });
    await expect(store.transport.request({ method: 'GET', url: 'https://update.example.invalid/api' }, new AbortController().signal)).rejects.toThrow();
    await expect(store.transport.stream('https://download.example.invalid/server.tar.gz', new AbortController().signal)).rejects.toThrow();
    // Read once per transport (proxiedHttpsTransport caches the settings), and used for both.
    expect(asked).toBe(1);
  });
});
