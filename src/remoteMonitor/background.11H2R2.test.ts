// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11H2: the cleanup counts a version without a use marker (a store of 11H1, or a version that the
// monitor fetched) as used at the time of its folder (reviewer A, A2-L2; reviewer B, R3), in the list and again under the
// lock; and a failed write of the failed fetches never fails part b, so the cleanup still runs (reviewer B, R2). The store
// is a temporary folder (never the home folder); nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VscodePlatform, VscodeServerRef } from '../core/helperChannel/protocol';
import type { HttpStreamTransport, HttpTransport } from '../core/http';
import { silentLogger } from '../core/ports';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { serverCommitsUrl, serverFolder, type StoreLockAttempt, type VscodeStoreDeps } from '../core/worker/vscodeServerStore';
import { BackgroundRun, type VscodeBackgroundDeps } from './background';
import type { CacheRunState } from './backgroundRules';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const commit = (n: number) => n.toString(16).padStart(40, '0');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A ready server without a use marker whose folder has the time `folderAt`. */
function unmarkedServer(root: string, server: VscodeServerRef, folderAt: number, platform: VscodePlatform = 'linux-x64'): string {
  const folder = serverFolder(root, server, platform);
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(folder, 'node'), '');
  fs.utimesSync(folder, new Date(folderAt), new Date(folderAt));
  return folder;
}

function harness(options: { commits: Partial<Record<'stable' | 'insider', string[]>>; ensure: boolean; onLock?: (name: string) => void; failWrite?: keyof CacheRunState }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-background-11h2r2-'));
  temps.push(root);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-background-11h2r2-state-'));
  temps.push(stateDir);
  const log: string[] = [];
  const locks: string[] = [];
  let state: CacheRunState = {};
  const unused = () => {
    throw new Error('not used');
  };
  const transport: HttpTransport = {
    request: async (request) => {
      const quality = request.url === serverCommitsUrl('insider', 'linux-x64') ? 'insider' : 'stable';
      return { status: 200, headers: {}, body: JSON.stringify(options.commits[quality] ?? [commit(1)]) };
    },
  };
  const store: VscodeStoreDeps = {
    root,
    transport: { ...transport, stream: unused } as unknown as HttpTransport & HttpStreamTransport,
    architecture: unused,
    lock: unused,
    unpack: unused,
    logger: silentLogger,
    background: true,
  };
  const vscode: VscodeBackgroundDeps = {
    store,
    storeVolume: 'devenv-vscode',
    // Integration of 11H3 with the final 11H2 (#135): the monitor's volume of the run (the extension lists of 11H3) is a temporary folder,
    // never the real /state (as background.test.ts since review round 2 of 11H3, A-L4).
    extensionStateDir: stateDir,
    engine: { ...unusedEngine(), architecture: async () => 'x86_64', containerSummaries: async () => [], containerIds: async () => [], processes: async () => [] } as unknown as VscodeBackgroundDeps['engine'],
    tryLock: async (name): Promise<StoreLockAttempt> => {
      locks.push(name);
      options.onLock?.(name);
      return { kind: 'locked', release: () => {} };
    },
    ensure: async () => options.ensure,
  };
  const run = new BackgroundRun({
    log: (message) => log.push(message),
    now: () => NOW,
    images: async () => {},
    vscode: () => vscode,
    state: {
      read: async () => state,
      update: async (change) => {
        if (options.failWrite !== undefined && options.failWrite in change) throw new Error('the state volume is full');
        state = { ...state, ...change };
      },
    },
  });
  return { run, root, log, locks, state: () => state };
}

const stable = (root: string) => fs.readdirSync(path.join(root, 'server', 'stable', 'linux-x64')).sort();

describe('11H2 review round 2 (A2-L2, R3): a version without a use marker in the cleanup', () => {
  it('counts as used at the time of its folder: fetched 13 days ago it stays (no lock asked), 15 days ago it goes', async () => {
    const h = harness({ commits: { stable: [commit(4), commit(3), commit(2), commit(1)] }, ensure: true });
    for (const n of [4, 3]) unmarkedServer(h.root, { commit: commit(n), quality: 'stable' }, NOW);
    unmarkedServer(h.root, { commit: commit(2), quality: 'stable' }, NOW - 13 * DAY);
    unmarkedServer(h.root, { commit: commit(1), quality: 'stable' }, NOW - 15 * DAY);
    await h.run.run();
    expect(stable(h.root)).toEqual([commit(2), commit(3), commit(4)]);
    expect(h.locks).toEqual([`stable-linux-x64-${commit(1)}`]);
    expect(h.log).toContain(`Removed the VS Code server ${commit(1)} (stable, linux-x64) from the shared store: no open used it for 14 days, it is not among the two newest, and no running container runs it.`);
    // The Insiders rule reads only the markers: no folder of the store counts as a use of an insider version.
    expect(fs.existsSync(path.join(h.root, 'used'))).toBe(false);
  });

  it('is checked again under the lock by the time of its folder: a folder that is younger than 14 days by then stays', async () => {
    let folder = '';
    const h = harness({
      commits: { stable: [commit(4), commit(3), commit(1)] },
      ensure: true,
      onLock: () => fs.utimesSync(folder, new Date(NOW - DAY), new Date(NOW - DAY)),
    });
    for (const n of [4, 3]) unmarkedServer(h.root, { commit: commit(n), quality: 'stable' }, NOW);
    folder = unmarkedServer(h.root, { commit: commit(1), quality: 'stable' }, NOW - 15 * DAY);
    await h.run.run();
    expect(h.locks).toEqual([`stable-linux-x64-${commit(1)}`]);
    expect(stable(h.root)).toEqual([commit(1), commit(3), commit(4)]);
  });
});

describe('11H2 review round 2 (R2): a failed write of the failed fetches', () => {
  it('is one line of the log; part b still names the platform and the releases, so the cleanup removes the old versions', async () => {
    const h = harness({ commits: { stable: [commit(4), commit(3), commit(2), commit(1)] }, ensure: false, failWrite: 'failedFetches' });
    for (const n of [3, 2, 1]) unmarkedServer(h.root, { commit: commit(n), quality: 'stable' }, NOW - 15 * DAY);
    await h.run.run();
    expect(h.log).toContain('The failed fetches of the VS Code server could not be stored: the state volume is full');
    expect(h.log).not.toContain('The shared VS Code server store is not cleaned up: the platform of the engine is not known.');
    expect(h.log.some((line) => line.startsWith('The background run could not do'))).toBe(false);
    expect(stable(h.root)).toEqual([commit(2), commit(3)]);
    expect(h.state().lastCleanupAt).toBe(NOW);
  });
});
