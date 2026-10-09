// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11H2 (reviewer B, mutation testing): probes for the run of round 1 that no test pinned: the failed
// fetches that the run stores are the newest MAX_FAILED_FETCHES (a longer list would make the strict parse drop them all,
// an older one would drop the failure that just happened), and the cleanup does not ask the update service a second time
// for a quality whose releases part b asked for (and could not read); the state is written only on a change; only a
// marker named exactly as a version counts; the list of the containers that mount the store has its time limit; the
// cleanup reads the use of an insider version from its own marker; the run marks no version as used (only an open does);
// the processes are read once per cleanup and keep a version of every quality. The store is a temporary folder (never the home folder); nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VscodePlatform, VscodeServerRef } from '../core/helperChannel/protocol';
import type { HttpRequest, HttpStreamTransport, HttpTransport } from '../core/http';
import { silentLogger } from '../core/ports';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { markServerOpened, serverCommitsUrl, serverFolder, type StoreLockAttempt, type VscodeStoreDeps } from '../core/worker/vscodeServerStore';
import { BACKGROUND_ENGINE_TIMEOUT_MS, BackgroundRun, type VscodeBackgroundDeps } from './background';
import { MAX_FAILED_FETCHES, SERVER_UNUSED_MS, type CacheRunState } from './backgroundRules';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const commit = (n: number) => n.toString(16).padStart(40, '0');

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function readyServer(root: string, server: VscodeServerRef, platform: VscodePlatform = 'linux-x64', usedAt = NOW - SERVER_UNUSED_MS - DAY): Promise<void> {
  const folder = serverFolder(root, server, platform);
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(folder, 'node'), '');
  await markServerOpened(root, server, platform, new Date(usedAt));
}

function harness(options: {
  commits: Partial<Record<'stable' | 'insider', string[] | Error>>;
  ensure: boolean;
  state?: CacheRunState;
  containerIds?: (signal: AbortSignal | undefined) => void;
  /** The processes of the containers that mount the store (each container: its process lines); default none. */
  processes?: Record<string, string[][]>;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-background-ph2r2-'));
  temps.push(root);
  const log: string[] = [];
  const requests: HttpRequest[] = [];
  const locks: string[] = [];
  const processReads: string[] = [];
  let state: CacheRunState = options.state ?? {};
  const unused = () => {
    throw new Error('not used');
  };
  const transport: HttpTransport = {
    request: async (request) => {
      requests.push(request);
      const quality = request.url === serverCommitsUrl('insider', 'linux-x64') ? 'insider' : 'stable';
      const answer = options.commits[quality];
      if (answer instanceof Error) throw answer;
      return { status: 200, headers: {}, body: JSON.stringify(answer ?? [commit(1)]) };
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
    engine: {
      ...unusedEngine(),
      architecture: async () => 'x86_64',
      containerSummaries: async () => [],
      containerIds: async (_filters: unknown, signal?: AbortSignal) => {
        options.containerIds?.(signal);
        return Object.keys(options.processes ?? {});
      },
      processes: async (id: string) => {
        processReads.push(id);
        return options.processes?.[id] ?? [];
      },
    } as unknown as VscodeBackgroundDeps['engine'],
    tryLock: async (name): Promise<StoreLockAttempt> => {
      locks.push(name);
      return { kind: 'locked', release: () => {} };
    },
    ensure: async () => options.ensure,
  };
  const run = new BackgroundRun({
    log: (message) => log.push(message),
    now: () => NOW,
    images: async () => {},
    vscode: () => vscode,
    state: { read: async () => state, update: async (change) => void (state = { ...state, ...change }) },
  });
  return { run, root, log, requests, locks, processReads, state: () => state };
}

describe('11H2 review round 2 (B): the failed fetches that the run stores', () => {
  it('keeps the newest MAX_FAILED_FETCHES: the failure of this run stays, the oldest waiting one goes', async () => {
    // 16 failures that still wait (an hour old and older, one ms apart), each of another version.
    const waiting = Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`insider-linux-arm64-${commit(100 + n)}`, NOW - 60 * 60_000 - n]));
    const h = harness({ commits: { stable: [commit(1)] }, ensure: false, state: { failedFetches: waiting } });
    await h.run.run();
    const failed = h.state().failedFetches ?? {};
    expect(MAX_FAILED_FETCHES).toBe(16);
    expect(Object.keys(failed)).toHaveLength(16);
    expect(failed[`stable-linux-x64-${commit(1)}`]).toBe(NOW);
    expect(failed[`insider-linux-arm64-${commit(115)}`]).toBeUndefined();
    expect(failed[`insider-linux-arm64-${commit(114)}`]).toBe(NOW - 60 * 60_000 - 14);
  });

  it('a run without a failure and without stored failures writes none (the state is written only on a change)', async () => {
    const h = harness({ commits: { stable: [commit(1)] }, ensure: true });
    await h.run.run();
    expect('failedFetches' in h.state()).toBe(false);
  });
});

describe('11H2 review round 2 (B): the use markers that part b reads', () => {
  it('only a file named exactly as a version counts: another name in used/ asks for no Insiders server', async () => {
    const h = harness({ commits: { stable: [commit(1)], insider: [commit(2)] }, ensure: true });
    fs.mkdirSync(path.join(h.root, 'used'), { mode: 0o700 });
    for (const name of [`insider-linux-x64-${commit(9)}.old`, `old-insider-linux-x64-${commit(9)}`]) {
      fs.writeFileSync(path.join(h.root, 'used', name), '');
      fs.utimesSync(path.join(h.root, 'used', name), new Date(NOW - DAY), new Date(NOW - DAY));
    }
    await h.run.run();
    expect(h.requests.map((request) => request.url)).toEqual([serverCommitsUrl('stable', 'linux-x64')]);
  });
});

describe('11H2 review round 2 (B): the releases that the cleanup reads', () => {
  it('a quality whose releases part b asked for and could not read is not asked again by the cleanup (it is left as it is)', async () => {
    const h = harness({ commits: { stable: new Error('offline') }, ensure: true });
    for (const n of [1, 2, 3]) await readyServer(h.root, { commit: commit(n), quality: 'stable' });
    await h.run.run();
    expect(h.requests.filter((request) => request.url === serverCommitsUrl('stable', 'linux-x64'))).toHaveLength(1);
    expect(h.log).toContain('The VS Code servers (stable, linux-x64) of the shared store are not cleaned up: the update service did not name its releases.');
    expect(fs.readdirSync(path.join(h.root, 'server', 'stable', 'linux-x64')).sort()).toEqual([commit(1), commit(2), commit(3)]);
  });
});

describe('11H2 review round 2 (B): the cleanup', () => {
  it('lists the containers that mount the store within BACKGROUND_ENGINE_TIMEOUT_MS (a daemon that does not answer ends)', async () => {
    const made = new Map<AbortSignal, number>();
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const signal = original(ms);
      made.set(signal, ms);
      return signal;
    });
    const seen: Array<number | undefined> = [];
    const h = harness({ commits: { stable: [commit(3), commit(2), commit(1)] }, ensure: true, containerIds: (signal) => void seen.push(signal === undefined ? undefined : made.get(signal)) });
    for (const n of [1, 2, 3]) await readyServer(h.root, { commit: commit(n), quality: 'stable' });
    await h.run.run();
    expect(seen).toEqual([BACKGROUND_ENGINE_TIMEOUT_MS]);
    expect(fs.readdirSync(path.join(h.root, 'server', 'stable', 'linux-x64')).sort()).toEqual([commit(2), commit(3)]);
  });

  it('reads the use of an insider version from its own marker: one that an open used yesterday is no candidate (no lock asked)', async () => {
    const h = harness({ commits: { stable: [commit(9)], insider: [commit(3), commit(2), commit(1)] }, ensure: true });
    await readyServer(h.root, { commit: commit(9), quality: 'stable' });
    for (const n of [2, 3]) await readyServer(h.root, { commit: commit(n), quality: 'insider' });
    await readyServer(h.root, { commit: commit(1), quality: 'insider' }, 'linux-x64', NOW - DAY);
    await h.run.run();
    expect(h.locks).not.toContain(`insider-linux-x64-${commit(1)}`);
    expect(fs.readdirSync(path.join(h.root, 'server', 'insider', 'linux-x64')).sort()).toEqual([commit(1), commit(2), commit(3)]);
  });
});

describe('11H2 review round 2 (B): the run marks nothing, and the processes keep every quality', () => {
  it('a newest server that is in the store already is no use by the run: no marker is written', async () => {
    const h = harness({ commits: { stable: [commit(1)] }, ensure: true });
    const folder = serverFolder(h.root, { commit: commit(1), quality: 'stable' }, 'linux-x64');
    fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(folder, 'node'), '');
    await h.run.run();
    expect(fs.existsSync(path.join(h.root, 'used', `stable-linux-x64-${commit(1)}`))).toBe(false);
  });

  it('an insider version that a running container runs stays, also when only Insiders has versions to remove', async () => {
    const line = (n: number) => ['1000', '42', `/home/u/.vscode-server-insiders/bin/${commit(n)}/node`];
    const h = harness({ commits: { stable: [commit(9)], insider: [commit(3), commit(2), commit(1)] }, ensure: true, processes: { 'dev-a': [line(1)] } });
    await readyServer(h.root, { commit: commit(9), quality: 'stable' });
    for (const n of [1, 2, 3]) await readyServer(h.root, { commit: commit(n), quality: 'insider' });
    await h.run.run();
    expect(fs.readdirSync(path.join(h.root, 'server', 'insider', 'linux-x64')).sort()).toEqual([commit(1), commit(2), commit(3)]);
    expect(h.processReads).toEqual(['dev-a']);
  });

  it('reads the processes once in a cleanup that removes versions of both qualities', async () => {
    const h = harness({ commits: { stable: [commit(13), commit(12), commit(11)], insider: [commit(3), commit(2), commit(1)] }, ensure: true, processes: { 'dev-a': [] } });
    for (const n of [11, 12, 13]) await readyServer(h.root, { commit: commit(n), quality: 'stable' });
    for (const n of [1, 2, 3]) await readyServer(h.root, { commit: commit(n), quality: 'insider' });
    await h.run.run();
    expect(fs.readdirSync(path.join(h.root, 'server', 'stable', 'linux-x64')).sort()).toEqual([commit(12), commit(13)]);
    expect(fs.readdirSync(path.join(h.root, 'server', 'insider', 'linux-x64')).sort()).toEqual([commit(2), commit(3)]);
    expect(h.processReads).toEqual(['dev-a']);
  });
});
