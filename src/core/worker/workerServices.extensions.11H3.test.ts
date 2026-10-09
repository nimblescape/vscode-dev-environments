// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; live check 3 of the user): the pipeline of an open with a VS Code server on a
// worker with a store gets the shared extension cache of the store (workerExtensionCache): its record of the list with
// the user's defaults of the open, and the cached files to seed for the engine's platform.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { workerExtensionCache, workerServiceDeps, type WorkerServicesDeps } from './workerServices';

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const ENV = 'a1b2c3d4e5';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<WorkerServicesDeps>) {
  return workerServiceDeps({
    host: { questions: {}, state: {}, records: {}, secrets: {} } as unknown as HostSide,
    engine: unusedEngine(),
    secretOf: () => undefined,
    forgetSecret: () => undefined,
    logger: silentLogger,
    ownHelper: { image: { tag: 'devenv-helper:abc', id: IMAGE_ID }, socket: '/s.sock', vscodeStore: 'devenv-vscode' },
    dockerHost: '',
    owner: { windowId: 'w', pid: 1 },
    environmentLock: async () => {
      throw new Error('no lock in this test');
    },
    ...overrides,
  });
}

describe('the shared extension cache of the pipeline in the worker (plan step 11H3)', () => {
  it('comes with the server of an open, never without it', () => {
    expect(typeof deps({ vscodeServer: SERVER, defaultExtensions: ['a.b'] }).vscodeServer?.extensions?.record).toBe('function');
    expect(deps({ defaultExtensions: ['a.b'] })).not.toHaveProperty('vscodeServer');
  });

  it('records the list of the open with its defaults, and gives the cached files for the platform', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-worker-'));
    temps.push(root);
    const cache = workerExtensionCache(['c.d', 'not valid'], root, () => 77);
    expect(await cache.record(ENV, [{ id: 'a.b' }])).toEqual([{ id: 'a.b' }, { id: 'c.d' }]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'wanted', `${ENV}.json`), 'utf8'))).toEqual({ at: 77, configuration: ['a.b'], defaults: ['c.d'] });
    fs.mkdirSync(path.join(root, 'extensions', 'linux-x64'), { recursive: true });
    fs.mkdirSync(path.join(root, 'extensions', 'universal'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', 'universal', 'a.b-1.0.0'), '');
    fs.writeFileSync(path.join(root, 'extensions', 'linux-x64', 'c.d-1.0.0-linux-x64'), '');
    expect(await cache.seedFiles([{ id: 'a.b' }, { id: 'c.d' }], 'linux-x64')).toEqual(['universal/a.b-1.0.0', 'linux-x64/c.d-1.0.0-linux-x64']);
    expect(await cache.seedFiles([{ id: 'a.b' }, { id: 'c.d' }], undefined)).toEqual(['universal/a.b-1.0.0']);
  });
});
