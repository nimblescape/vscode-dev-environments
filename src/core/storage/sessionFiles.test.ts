// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../ports';
import type { MonitorSettings, PendingOperation, WindowStatus } from '../types';
import { StoragePaths } from './paths';
import {
  DEFAULT_CLAIM_MAX_AGE_MS,
  SessionFiles,
  isMonitorSettings,
  isPendingConnection,
  isPendingOperation,
  isReopenRecord,
  isWindowStatus,
} from './sessionFiles';

const ENV_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ENV_B = '7c1d2e3f-0000-4000-8000-000000000002';
const WIN_1 = 'b7c1d2e3-0000-4000-8000-000000000001';
const WIN_2 = 'b7c1d2e3-0000-4000-8000-000000000002';
const T0 = Date.parse('2026-09-24T17:40:15.000Z');

class FakeClock implements Clock {
  constructor(public ms: number = T0) {}
  now(): number {
    return this.ms;
  }
}

function status(windowId: string, extra: Partial<WindowStatus> = {}): WindowStatus {
  return { windowId, pid: 48213, environmentId: ENV_A, state: 'active', updatedAt: '2026-09-24T17:40:15.000Z', ...extra };
}

function operation(environmentId: string, extra: Partial<PendingOperation> = {}): PendingOperation {
  return {
    environmentId,
    operation: 'rebuild',
    requestedAt: '2026-09-24T17:40:15.000Z',
    requestedBy: WIN_1,
    reason: 'manual',
    ...extra,
  };
}

let root: string;
let paths: StoragePaths;
let clock: FakeClock;
let files: SessionFiles;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  paths = new StoragePaths(root);
  clock = new FakeClock();
  files = new SessionFiles(paths, clock);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('window status files', () => {
  it('writes, reads, and removes status files (async and sync)', async () => {
    await expect(files.readWindowStatuses()).resolves.toEqual([]);
    await files.writeWindowStatus(status(WIN_2));
    files.writeWindowStatusSync(status(WIN_1, { state: 'closing', environmentId: null }));
    expect(JSON.parse(fs.readFileSync(paths.sessionFile(WIN_1), 'utf8'))).toEqual(
      status(WIN_1, { state: 'closing', environmentId: null }),
    );
    await expect(files.readWindowStatuses()).resolves.toEqual([
      status(WIN_1, { state: 'closing', environmentId: null }),
      status(WIN_2),
    ]);
    await files.writeWindowStatus(status(WIN_2, { updatedAt: '2026-09-24T17:40:30.000Z' }));
    await expect(files.readWindowStatuses()).resolves.toContainEqual(
      status(WIN_2, { updatedAt: '2026-09-24T17:40:30.000Z' }),
    );
    await files.removeWindowStatus(WIN_1);
    await files.removeWindowStatus(WIN_1);
    await expect(files.readWindowStatuses()).resolves.toEqual([
      status(WIN_2, { updatedAt: '2026-09-24T17:40:30.000Z' }),
    ]);
    expect(fs.readdirSync(paths.sessionsDir)).toEqual([`${WIN_2}.json`]);
  });

  it('skips invalid files, temporary files, and files whose name does not match', async () => {
    await files.writeWindowStatus(status(WIN_1));
    fs.writeFileSync(path.join(paths.sessionsDir, 'broken.json'), '{');
    fs.writeFileSync(path.join(paths.sessionsDir, 'other.json'), JSON.stringify(status(WIN_2)));
    fs.writeFileSync(path.join(paths.sessionsDir, `.${WIN_2}.json.1.ab.tmp`), JSON.stringify(status(WIN_2)));
    fs.writeFileSync(path.join(paths.sessionsDir, `${WIN_2}.json.tmp`), JSON.stringify(status(WIN_2)));
    fs.writeFileSync(path.join(paths.sessionsDir, 'bad-state.json'), JSON.stringify(status('bad-state', { state: 'x' as 'active' })));
    fs.writeFileSync(path.join(paths.sessionsDir, 'bad-pid.json'), JSON.stringify(status('bad-pid', { pid: -1 })));
    fs.mkdirSync(path.join(paths.sessionsDir, 'folder.json'));
    await expect(files.readWindowStatuses()).resolves.toEqual([status(WIN_1)]);
  });

  it('keeps unknown fields of a newer version', async () => {
    const withExtra = { ...status(WIN_1), future: 1 };
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    fs.writeFileSync(paths.sessionFile(WIN_1), JSON.stringify(withExtra));
    await expect(files.readWindowStatuses()).resolves.toEqual([withExtra]);
  });

  it('refuses an unsafe window ID', async () => {
    await expect(files.writeWindowStatus(status('../escape'))).rejects.toThrow(/Invalid window ID/);
    expect(() => files.writeWindowStatusSync(status('a/b'))).toThrow(/Invalid window ID/);
    expect(fs.existsSync(path.join(root, 'escape.json'))).toBe(false);
  });
});

describe('pending connection files', () => {
  it('writes with the current time, reads, and removes', async () => {
    await files.writePending(ENV_A, WIN_1);
    clock.ms += 1000;
    await files.writePending(ENV_B, WIN_2);
    await expect(files.readPendings()).resolves.toEqual([
      { environmentId: ENV_A, windowId: WIN_1, createdAt: '2026-09-24T17:40:15.000Z' },
      { environmentId: ENV_B, windowId: WIN_2, createdAt: '2026-09-24T17:40:16.000Z' },
    ]);
    await files.removePending(ENV_A);
    await files.removePending(ENV_A);
    await expect(files.readPendings()).resolves.toEqual([
      { environmentId: ENV_B, windowId: WIN_2, createdAt: '2026-09-24T17:40:16.000Z' },
    ]);
  });

  it('skips invalid pending files', async () => {
    fs.mkdirSync(paths.pendingDir, { recursive: true });
    fs.writeFileSync(path.join(paths.pendingDir, `${ENV_A}.json`), JSON.stringify({ environmentId: ENV_A, windowId: WIN_1, createdAt: 'yesterday' }));
    fs.writeFileSync(path.join(paths.pendingDir, `${ENV_B}.json`), JSON.stringify({ environmentId: ENV_A, windowId: WIN_1, createdAt: '2026-09-24T17:40:15Z' }));
    await expect(files.readPendings()).resolves.toEqual([]);
  });
});

describe('pending operations', () => {
  it('writes and reads operations', async () => {
    await files.writeOperation(operation(ENV_A));
    await files.writeOperation(
      operation(ENV_B, { operation: 'delete', reason: 'configurationSelected', configPath: '.devcontainer/py/devcontainer.json', removeAdditionalVolumes: true }),
    );
    const operations = await files.readOperations();
    expect(operations).toEqual([
      operation(ENV_A),
      operation(ENV_B, { operation: 'delete', reason: 'configurationSelected', configPath: '.devcontainer/py/devcontainer.json', removeAdditionalVolumes: true }),
    ]);
  });

  it('reads and claims every operation kind of types.ts, also stop', async () => {
    const kinds: Array<PendingOperation['operation']> = ['rebuild', 'delete', 'stop'];
    const ids = [ENV_A, ENV_B, 'c0ffee00-0000-4000-8000-000000000003'];
    for (const [index, kind] of kinds.entries()) {
      await files.writeOperation(operation(ids[index], { operation: kind }));
    }
    await expect(files.readOperations()).resolves.toHaveLength(3);
    for (const [index, kind] of kinds.entries()) {
      expect(isPendingOperation(operation(ids[index], { operation: kind }))).toBe(true);
      await expect(files.claimOperation(ids[index], WIN_1)).resolves.toEqual(operation(ids[index], { operation: kind }));
    }
    await expect(files.readOperations()).resolves.toEqual([]);
  });

  it('claims an operation once', async () => {
    await files.writeOperation(operation(ENV_A));
    await expect(files.claimOperation(ENV_A, WIN_2)).resolves.toEqual(operation(ENV_A));
    await expect(files.readOperations()).resolves.toEqual([]);
    expect(fs.readdirSync(paths.operationsDir)).toEqual([`${ENV_A}.claimed.${T0}.${WIN_2}`]);
    await expect(files.claimOperation(ENV_A, WIN_1)).resolves.toBeUndefined();
    await expect(files.claimOperation(ENV_B, WIN_1)).resolves.toBeUndefined();
  });

  it('lets exactly one of many parallel claims win', async () => {
    for (let round = 0; round < 20; round++) {
      await files.writeOperation(operation(ENV_A, { requestedBy: `round-${round}` }));
      const contenders = Array.from({ length: 8 }, (_, i) => new SessionFiles(paths, clock).claimOperation(ENV_A, `window-${i}`));
      const results = await Promise.all(contenders);
      const winners = results.filter((result) => result !== undefined);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.requestedBy).toBe(`round-${round}`);
      await files.removeOperation(ENV_A);
    }
    expect(fs.readdirSync(paths.operationsDir)).toEqual([]);
  });

  it('removes an invalid claimed operation and reports no operation', async () => {
    fs.mkdirSync(paths.operationsDir, { recursive: true });
    fs.writeFileSync(paths.operationFile(ENV_A), JSON.stringify(operation(ENV_A, { operation: 'explode' as 'rebuild' })));
    await expect(files.claimOperation(ENV_A, WIN_1)).resolves.toBeUndefined();
    fs.writeFileSync(paths.operationFile(ENV_A), JSON.stringify(operation(ENV_B)));
    await expect(files.claimOperation(ENV_A, WIN_1)).resolves.toBeUndefined();
    fs.writeFileSync(paths.operationFile(ENV_A), '{');
    await expect(files.claimOperation(ENV_A, WIN_1)).resolves.toBeUndefined();
    expect(fs.readdirSync(paths.operationsDir)).toEqual([]);
  });

  it('removes the operation and the claimed files of one environment only', async () => {
    await files.writeOperation(operation(ENV_A));
    await files.claimOperation(ENV_A, WIN_1);
    await files.writeOperation(operation(ENV_A, { reason: 'update' }));
    await files.writeOperation(operation(ENV_B));
    await files.claimOperation(ENV_B, WIN_1);
    await files.removeOperation(ENV_A);
    expect(fs.readdirSync(paths.operationsDir)).toEqual([`${ENV_B}.claimed.${T0}.${WIN_1}`]);
    await files.removeOperation(ENV_A);
    await new SessionFiles(new StoragePaths(path.join(root, 'empty')), clock).removeOperation(ENV_A);
  });

  it('removes claimed files older than the maximum age', async () => {
    await files.writeOperation(operation(ENV_A));
    await files.claimOperation(ENV_A, WIN_1);
    clock.ms += 10 * 60_000;
    await files.writeOperation(operation(ENV_B));
    await files.claimOperation(ENV_B, WIN_1);
    await files.writeOperation(operation(ENV_A));
    const oldForeign = path.join(paths.operationsDir, `x${'.claimed.'}unknown-form`);
    fs.writeFileSync(oldForeign, '');
    const past = new Date(T0 - 2 * DEFAULT_CLAIM_MAX_AGE_MS);
    fs.utimesSync(oldForeign, past, past);

    clock.ms = T0 + DEFAULT_CLAIM_MAX_AGE_MS + 1;
    await files.cleanupStaleClaims();
    expect(fs.readdirSync(paths.operationsDir).sort()).toEqual([`${ENV_A}.json`, `${ENV_B}.claimed.${T0 + 600_000}.${WIN_1}`]);

    await files.cleanupStaleClaims(1000);
    expect(fs.readdirSync(paths.operationsDir)).toEqual([`${ENV_A}.json`]);
    await new SessionFiles(new StoragePaths(path.join(root, 'empty')), clock).cleanupStaleClaims();
  });

  it('treats a claim time far in the future as stale', async () => {
    clock.ms = T0 + 5 * DEFAULT_CLAIM_MAX_AGE_MS;
    await files.writeOperation(operation(ENV_A));
    await files.claimOperation(ENV_A, WIN_1);
    clock.ms = T0;
    await files.cleanupStaleClaims();
    expect(fs.readdirSync(paths.operationsDir)).toEqual([]);
  });
});

describe('claimOperation across processes', () => {
  it('lets exactly one process win', async () => {
    const script = path.join(root, 'claim.js');
    const entry = path.join(root, 'claim-entry.ts');
    fs.writeFileSync(
      entry,
      [
        `import { StoragePaths } from ${JSON.stringify(path.join(__dirname, 'paths'))};`,
        `import { SessionFiles } from ${JSON.stringify(path.join(__dirname, 'sessionFiles'))};`,
        'const [storage, id, windowId, startAt] = process.argv.slice(2);',
        'while (Date.now() < Number(startAt)) { /* start together */ }',
        'new SessionFiles(new StoragePaths(storage)).claimOperation(id, windowId).then(',
        '  (result) => process.stdout.write(result ? "won" : "lost"),',
        '  (error) => { console.error(error); process.exitCode = 1; },',
        ');',
      ].join('\n'),
    );
    buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: script, logLevel: 'silent' });

    const storage = path.join(root, 'storage');
    await new SessionFiles(new StoragePaths(storage)).writeOperation(operation(ENV_A));
    const startAt = Date.now() + 1500;
    const outputs = await Promise.all(
      Array.from(
        { length: 4 },
        (_, i) =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, [script, storage, ENV_A, `window-${i}`, String(startAt)], {
              stdio: ['ignore', 'pipe', 'inherit'],
            });
            let out = '';
            child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
            child.on('error', reject);
            child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
          }),
      ),
    );
    expect(outputs.filter((output) => output === 'won')).toHaveLength(1);
    expect(outputs.filter((output) => output === 'lost')).toHaveLength(3);
  }, 60_000);
});

describe('reopen record', () => {
  it('writes synchronously, reads, and removes', async () => {
    await expect(files.readReopen()).resolves.toBeUndefined();
    files.writeReopenSync({ environmentId: ENV_A, closedAt: '2026-09-24T18:02:11Z' });
    await expect(files.readReopen()).resolves.toEqual({ environmentId: ENV_A, closedAt: '2026-09-24T18:02:11Z' });
    await files.removeReopen();
    await files.removeReopen();
    await expect(files.readReopen()).resolves.toBeUndefined();
  });

  it('ignores an invalid record', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(paths.reopen, JSON.stringify({ environmentId: ENV_A }));
    await expect(files.readReopen()).resolves.toBeUndefined();
    fs.writeFileSync(paths.reopen, 'nope');
    await expect(files.readReopen()).resolves.toBeUndefined();
  });
});

describe('monitor settings', () => {
  const settings: MonitorSettings = {
    waitingTimeSeconds: 30,
    stopOnClose: true,
    respectShutdownActionNone: false,
    updatedAt: '2026-09-24T17:40:15.000Z',
  };

  it('writes and reads (async and sync)', async () => {
    await expect(files.readMonitorSettings()).resolves.toBeUndefined();
    expect(files.readMonitorSettingsSync()).toBeUndefined();
    await files.writeMonitorSettings(settings);
    await expect(files.readMonitorSettings()).resolves.toEqual(settings);
    expect(files.readMonitorSettingsSync()).toEqual(settings);
  });

  it('ignores invalid settings', async () => {
    await files.writeMonitorSettings({ ...settings, waitingTimeSeconds: -1 });
    await expect(files.readMonitorSettings()).resolves.toBeUndefined();
    expect(files.readMonitorSettingsSync()).toBeUndefined();
    fs.writeFileSync(paths.monitorSettings, '{');
    expect(files.readMonitorSettingsSync()).toBeUndefined();
  });
});

describe('validators', () => {
  it('check the shapes', () => {
    expect(isWindowStatus(status(WIN_1))).toBe(true);
    expect(isWindowStatus(status(WIN_1, { environmentId: null }))).toBe(true);
    expect(isWindowStatus({ ...status(WIN_1), environmentId: undefined })).toBe(false);
    expect(isWindowStatus({ ...status(WIN_1), updatedAt: 'later' })).toBe(false);
    expect(isWindowStatus([])).toBe(false);
    expect(isPendingConnection({ environmentId: ENV_A, windowId: WIN_1, createdAt: '2026-09-24T17:40:15Z' })).toBe(true);
    expect(isPendingConnection({ environmentId: ENV_A, windowId: '', createdAt: '2026-09-24T17:40:15Z' })).toBe(false);
    expect(isPendingOperation(operation(ENV_A))).toBe(true);
    expect(isPendingOperation({ ...operation(ENV_A), reason: 'whim' })).toBe(false);
    expect(isPendingOperation({ ...operation(ENV_A), configPath: 3 })).toBe(false);
    expect(isPendingOperation({ ...operation(ENV_A), removeAdditionalVolumes: 'yes' })).toBe(false);
    expect(isReopenRecord({ environmentId: ENV_A, closedAt: '2026-09-24T18:02:11Z' })).toBe(true);
    expect(isReopenRecord(null)).toBe(false);
    expect(isMonitorSettings({ waitingTimeSeconds: 0, stopOnClose: false, respectShutdownActionNone: true, updatedAt: '2026-09-24T18:02:11Z' })).toBe(true);
    expect(isMonitorSettings({ waitingTimeSeconds: Number.NaN, stopOnClose: false, respectShutdownActionNone: true, updatedAt: '2026-09-24T18:02:11Z' })).toBe(false);
  });
});
