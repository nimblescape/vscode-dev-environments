// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #101 (B, mutation probes): a cancel during the check of the image ID of the created container
// ends the attached create as aborted, without waiting for the engine.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorRunSpec } from '../core/remoteMonitor/monitorEngine';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';

const ID = 'c0ffee'.repeat(10) + 'c0ff';
const SPEC: MonitorRunSpec = {
  name: 'devenv-session-monitor',
  image: 'devenv-monitor:0123456789ab',
  imageId: 'sha256:' + 'b'.repeat(64),
  labels: { 'nimblescape.devenv.session-monitor': 'label', 'nimblescape.devenv.monitor-create': 'nonce' },
  restartPolicy: 'on-failure',
  network: 'none',
  log: { driver: 'json-file', maxSize: '1m', maxFile: '2' },
  mounts: { socket: '/var/run/docker.sock', volume: 'devenv-session-monitor', volumeTarget: '/state' },
  env: { DEVENV_IMAGE_TZ: 'UTC' },
  command: ['node', '-e', 'loader', '/opt/devenv/monitor.js', 'hash', 'startMonitor'],
};

describe('the check of the image ID of the attached create (review round 2 of PR #101, B)', () => {
  const servers: http.Server[] = [];
  const pending: http.ServerResponse[] = [];
  const folders: string[] = [];

  afterEach(async () => {
    for (const res of pending.splice(0)) res.destroy();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  it('a cancel while the engine does not answer the inspect is aborted', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-inspect-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const urls: string[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        urls.push(req.url?.split('?')[0] ?? '');
        if (req.url?.startsWith('/containers/create')) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: ID }));
          return;
        }
        // The inspect never gets an answer.
        pending.push(res);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const engine = dockerEngine(engineApi(socketPath), engineHijack(socketPath));
    const controller = new AbortController();
    const started = Date.now();
    const creating = engine.createAttached(SPEC, { input: 'x\n', readyText: 'ready', timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await creating).toEqual({ kind: 'aborted' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(urls).toEqual(['/containers/create', `/containers/${ID}/json`]);
  }, 10_000);
});
