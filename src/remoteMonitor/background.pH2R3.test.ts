// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of 11H2 (reviewer B, mutation testing): probes for the round-2 changes of the background run that no
// test pinned: the time of the folder of a version without a use marker is its modification time, not its access time
// (A2-L2, R3); and the write of the failed fetches ends before the run goes on (R2), so it never races the later writes
// of the state (the store reads, changes and writes the whole file, as cacheRunStore does). The store is a temporary
// folder (never the home folder); nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VscodeServerRef } from '../core/helperChannel/protocol';
import type { HttpStreamTransport, HttpTransport } from '../core/http';
import { silentLogger } from '../core/ports';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { serverFolder, type StoreLockAttempt, type VscodeStoreDeps } from '../core/worker/vscodeServerStore';
import { BackgroundRun, type VscodeBackgroundDeps } from './background';
import type { CacheRunState } from './backgroundRules';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const commit = (n: number) => n.toString(16).padStart(40, '0');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A ready server without a use marker whose folder has the access time `accessedAt` and the modification time `modifiedAt`. */
function unmarkedServer(root: string, server: VscodeServerRef, accessedAt: number, modifiedAt: number): string {
  const folder = serverFolder(root, server, 'linux-x64');
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(folder, 'node'), '');
  fs.utimesSync(folder, new Date(accessedAt), new Date(modifiedAt));
  return folder;
}

function harness(options: { commits: string[]; ensure: boolean; slowWrite?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-background-ph2r3-'));
  temps.push(root);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-background-ph2r3-state-'));
  temps.push(stateDir);
  const log: string[] = [];
  const writes: string[] = [];
  let state: CacheRunState = {};
  const unused = () => {
    throw new Error('not used');
  };
  const transport: HttpTransport = { request: async () => ({ status: 200, headers: {}, body: JSON.stringify(options.commits) }) };
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
    tryLock: async (): Promise<StoreLockAttempt> => ({ kind: 'locked', release: () => {} }),
    ensure: async () => options.ensure,
  };
  const run = new BackgroundRun({
    log: (message) => log.push(message),
    now: () => NOW,
    images: async () => {},
    vscode: () => vscode,
    state: {
      read: async () => state,
      // As cacheRunStore: read the whole state, then (some time later) write it with the change.
      update: async (change) => {
        const base = state;
        if (options.slowWrite === true && 'failedFetches' in change) await new Promise<void>((resolve) => setTimeout(resolve, 50));
        state = { ...base, ...change };
        writes.push(Object.keys(change).join(','));
      },
    },
  });
  return { run, root, log, writes, state: () => state };
}

const stable = (root: string) => fs.readdirSync(path.join(root, 'server', 'stable', 'linux-x64')).sort();

describe('11H2 review round 3 (B): the time of the folder of a version without a marker', () => {
  it('is its modification time: a folder modified 15 days ago goes even when it was read just now', async () => {
    const h = harness({ commits: [commit(4), commit(3), commit(1)], ensure: true });
    for (const n of [4, 3]) unmarkedServer(h.root, { commit: commit(n), quality: 'stable' }, NOW, NOW);
    unmarkedServer(h.root, { commit: commit(1), quality: 'stable' }, NOW, NOW - 15 * DAY);
    await h.run.run();
    expect(stable(h.root)).toEqual([commit(3), commit(4)]);
  });

  it('is its modification time: a folder modified a day ago stays even when it was last read 15 days ago', async () => {
    const h = harness({ commits: [commit(4), commit(3), commit(1)], ensure: true });
    for (const n of [4, 3]) unmarkedServer(h.root, { commit: commit(n), quality: 'stable' }, NOW, NOW);
    unmarkedServer(h.root, { commit: commit(1), quality: 'stable' }, NOW - 15 * DAY, NOW - DAY);
    await h.run.run();
    expect(stable(h.root)).toEqual([commit(1), commit(3), commit(4)]);
  });
});

describe('11H2 review round 3 (B): the write of the failed fetches', () => {
  it('ends before the run goes on: a slow write is neither lost nor overwritten by the later writes of the state', async () => {
    const h = harness({ commits: [commit(4), commit(3), commit(2), commit(1)], ensure: false, slowWrite: true });
    for (const n of [3, 2, 1]) unmarkedServer(h.root, { commit: commit(n), quality: 'stable' }, NOW - 15 * DAY, NOW - 15 * DAY);
    await h.run.run();
    expect(h.writes[0]).toBe('failedFetches');
    expect(h.state().failedFetches).toEqual({ [`stable-linux-x64-${commit(4)}`]: NOW });
    expect(h.state().lastCleanupAt).toBe(NOW);
    expect(stable(h.root)).toEqual([commit(2), commit(3)]);
  });
});
