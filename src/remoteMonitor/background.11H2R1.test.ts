// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H2 (reviewer B, mutation testing: its probes, adopted; each kills a mutant that survived the tests
// of 11H2): what the tests of background.ts left open: the time limits of the engine, the update service, the link and
// (A-M2) the read of the processes; the removal that renames before it removes; a lock that fails (not busy) leaves a
// version and its temporary folders alone; the recheck of the state of a container; the temporary folders also when the
// platform is unknown; a link in the place of a version stays. Adapted to the use marker of an open (A-M1): the stored
// qualities of 11H2 are gone, so its probe now checks that a ready insider server without an open's use asks nothing. The
// store is a temporary folder (never the home folder); nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VscodePlatform, VscodeServerRef } from '../core/helperChannel/protocol';
import type { HttpRequest, HttpStreamTransport, HttpTransport } from '../core/http';
import { silentLogger } from '../core/ports';
import type { EngineContainer, EngineContainerSummary, EngineExecOptions, EngineExecResult } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { markServerOpened, serverCommitsUrl, serverFolder, type StoreLockAttempt, type VscodeStoreDeps } from '../core/worker/vscodeServerStore';
import { BACKGROUND_ENGINE_TIMEOUT_MS, BACKGROUND_LINK_TIMEOUT_MS, BackgroundRun, UPDATE_SERVICE_TIMEOUT_MS, type VscodeBackgroundDeps } from './background';
import { SERVER_UNUSED_MS, type CacheRunState } from './backgroundRules';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const commit = (n: number) => n.toString(16).padStart(40, '0');
const C1 = commit(1);
const C2 = commit(2);
const C3 = commit(3);
const C4 = commit(4);
const STORE = 'devenv-vscode';
const STORE_MOUNT = { type: 'volume', volume: STORE, target: '/opt/devenv/vscode', readOnly: true as const };
const METADATA = JSON.stringify([{ remoteUser: 'vscode' }]);
const version = (n: number, quality = 'stable') => `${quality}-linux-x64-${commit(n)}`;

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A ready server; `usedAt`: the last use by an open (its marker); `never`: none. */
async function readyServer(root: string, server: VscodeServerRef, platform: VscodePlatform = 'linux-x64', usedAt: number | 'never' = NOW - SERVER_UNUSED_MS - DAY): Promise<string> {
  const folder = serverFolder(root, server, platform);
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(folder, 'node'), '');
  if (usedAt !== 'never') await markServerOpened(root, server, platform, new Date(usedAt));
  return folder;
}

interface ProbeContainer {
  id: string;
  /** The state of the list. */
  listed: 'running' | 'exited';
  /** The state of the inspect (default: as listed). */
  inspected?: 'running' | 'exited';
}

function harness(options: {
  commits?: Partial<Record<'stable' | 'insider', unknown>>;
  architecture?: (signal: AbortSignal) => Promise<string>;
  request?: (request: HttpRequest, signal: AbortSignal | undefined) => void;
  /** Review round 1 of 11H2 (A-M2): the read of the processes of a container that mounts the store. */
  processes?: (signal: AbortSignal | undefined) => void;
  containers?: ProbeContainer[];
  lock?: (name: string) => StoreLockAttempt | undefined;
  state?: CacheRunState;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-background-11h2r1-'));
  temps.push(root);
  const log: string[] = [];
  const requests: HttpRequest[] = [];
  const execs: Array<{ container: string; options?: EngineExecOptions }> = [];
  const fetched: VscodeServerRef[] = [];
  const locks: string[] = [];
  let state: CacheRunState = options.state ?? {};
  const transport: HttpTransport = {
    request: async (request, signal) => {
      requests.push(request);
      options.request?.(request, signal);
      const quality = request.url === serverCommitsUrl('insider', 'linux-x64') ? 'insider' : 'stable';
      const answer = options.commits?.[quality];
      if (answer instanceof Error) throw answer;
      return { status: 200, headers: {}, body: JSON.stringify(answer ?? [C1]) };
    },
  };
  const unused = () => {
    throw new Error('not used');
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
  const containers = options.containers ?? [];
  const vscode: VscodeBackgroundDeps = {
    store,
    storeVolume: STORE,
    engine: {
      ...unusedEngine(),
      architecture: async (signal: AbortSignal) => (options.architecture ? options.architecture(signal) : 'x86_64'),
      containerSummaries: async () =>
        containers.map((container): EngineContainerSummary => ({ id: container.id, name: `dev-${container.id}`, state: container.listed, labels: {} })),
      container: async (id: string) => {
        const found = containers.find((container) => container.id === id)!;
        const state = found.inspected ?? found.listed;
        return {
          id,
          name: `dev-${id}`,
          state: state === 'running' ? 'running' : 'stopped',
          rawState: state,
          labels: { 'devcontainer.metadata': METADATA },
          image: 'image',
          mountTargets: [STORE_MOUNT],
        } as EngineContainer;
      },
      containerIds: async () => ['store-user'],
      processes: async (_id: string, signal?: AbortSignal) => {
        options.processes?.(signal);
        return [];
      },
      exec: async (container: string, _command: readonly string[], execOptions?: EngineExecOptions): Promise<EngineExecResult> => {
        execs.push({ container, ...(execOptions ? { options: execOptions } : {}) });
        return { exitCode: 0, stdout: 'linked\n', stderr: '', timedOut: false };
      },
    } as unknown as VscodeBackgroundDeps['engine'],
    tryLock: async (name): Promise<StoreLockAttempt> => {
      locks.push(name);
      return options.lock?.(name) ?? { kind: 'locked', release: () => {} };
    },
    ensure: async (_deps, server, platform) => {
      fetched.push(server);
      await readyServer(root, server, platform, 'never');
      return true;
    },
  };
  const run = new BackgroundRun({
    log: (message) => log.push(message),
    now: () => NOW,
    images: async () => {},
    vscode: () => vscode,
    state: { read: async () => state, update: async (change) => void (state = { ...state, ...change }) },
  });
  return { run, root, log, requests, execs, fetched, locks, state: () => state };
}

const stored = (root: string, quality = 'stable') => fs.readdirSync(path.join(root, 'server', quality, 'linux-x64')).sort();

describe('11H2 review round 1 (B): the time limits of the VS Code part of the run', () => {
  it('reads the architecture of the engine within BACKGROUND_ENGINE_TIMEOUT_MS (a daemon that does not answer ends)', async () => {
    const made = new Map<AbortSignal, number>();
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const signal = original(ms);
      made.set(signal, ms);
      return signal;
    });
    let seen: number | undefined;
    const h = harness({
      architecture: async (signal) => {
        seen = made.get(signal);
        return 'x86_64';
      },
    });
    await h.run.run();
    expect(seen).toBe(BACKGROUND_ENGINE_TIMEOUT_MS);
  });

  it('asks the update service within UPDATE_SERVICE_TIMEOUT_MS', async () => {
    const made = new Map<AbortSignal, number>();
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const signal = original(ms);
      made.set(signal, ms);
      return signal;
    });
    const seen: Array<number | undefined> = [];
    const h = harness({ request: (_request, signal) => void seen.push(signal === undefined ? undefined : made.get(signal)) });
    await h.run.run();
    expect(seen).toEqual([UPDATE_SERVICE_TIMEOUT_MS]);
  });

  it('runs the link script within BACKGROUND_LINK_TIMEOUT_MS', async () => {
    const h = harness({ commits: { stable: [C2, C1] }, containers: [{ id: 'a', listed: 'running' }] });
    await h.run.run();
    expect(h.execs).toHaveLength(1);
    expect(h.execs[0]?.options?.timeoutMs).toBe(BACKGROUND_LINK_TIMEOUT_MS);
    expect(h.execs[0]?.options?.user).toBe('vscode');
  });
});

describe('11H2 review round 1 (B): the link checks the state of the inspect', () => {
  it('a container that stopped after the list is not linked', async () => {
    const h = harness({ commits: { stable: [C2, C1] }, containers: [{ id: 'a', listed: 'running', inspected: 'exited' }] });
    await h.run.run();
    expect(h.execs).toEqual([]);
  });
});

describe('11H2 review round 1 (B): the removal of a version', () => {
  it('renames the version folder away first and removes only below tmp/ (never in place, so an open never sees half of it)', async () => {
    const h = harness({ commits: { stable: [C4, C3, C2, C1] } });
    for (const n of [1, 2, 3, 4]) await readyServer(h.root, { commit: commit(n), quality: 'stable' });
    const removed: string[] = [];
    const rm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, rmOptions) => {
      removed.push(String(target));
      return rm(target, rmOptions);
    });
    await h.run.run();
    expect(stored(h.root)).toEqual([C3, C4]);
    expect(removed.length).toBeGreaterThan(0);
    for (const target of removed) expect(target.startsWith(path.posix.join(h.root, 'tmp') + '/'), target).toBe(true);
    // The folder of the removals is private (0700, whatever the umask).
    expect(fs.statSync(path.join(h.root, 'tmp')).mode & 0o077).toBe(0);
  });

  it('a lock that fails (not busy) leaves the version alone', async () => {
    const h = harness({ commits: { stable: [C4, C3, C2, C1] }, lock: (name) => (name === version(1) ? { kind: 'failed', detail: 'flock is missing' } : undefined) });
    for (const n of [1, 2, 3, 4]) await readyServer(h.root, { commit: commit(n), quality: 'stable' });
    await h.run.run();
    expect(stored(h.root)).toEqual([C1, C3, C4]);
    expect(h.log).toContain(`The VS Code server ${C1} (stable) is not removed: its lock could not be taken (flock is missing).`);
    expect(h.state().lastCleanupAt).toBe(NOW);
  });

  it('a version used within 14 days by a clock far ahead (its time in the future) is kept', async () => {
    const h = harness({ commits: { stable: [C4, C3, C2, C1] } });
    for (const n of [2, 3, 4]) await readyServer(h.root, { commit: commit(n), quality: 'stable' });
    await readyServer(h.root, { commit: C1, quality: 'stable' }, 'linux-x64', NOW + 30 * DAY);
    await h.run.run();
    expect(stored(h.root)).toEqual([C1, C3, C4]);
  });

  it('a link in the place of a version is no version: it stays, and so does its target', async () => {
    const h = harness({ commits: { stable: [C4, C3, C2, C1] } });
    for (const n of [2, 3, 4]) await readyServer(h.root, { commit: commit(n), quality: 'stable' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-background-11h2r1-outside-'));
    temps.push(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'x');
    const link = serverFolder(h.root, { commit: C1, quality: 'stable' }, 'linux-x64');
    fs.symlinkSync(outside, link);
    await markServerOpened(h.root, { commit: C1, quality: 'stable' }, 'linux-x64', new Date(NOW - SERVER_UNUSED_MS - DAY));
    await h.run.run();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(outside, 'keep'))).toBe(true);
    expect(stored(h.root)).toEqual([C1, C4, C3].sort());
  });
});

describe('11H2 review round 1 (B): the temporary folders', () => {
  it('stay while the lock of their version fails (not busy)', async () => {
    const h = harness({ commits: { stable: [C1] }, lock: (name) => (name === version(3) ? { kind: 'failed', detail: 'flock is missing' } : undefined) });
    const tmp = path.join(h.root, 'tmp');
    fs.mkdirSync(path.join(tmp, `${version(3)}-0a0a`), { recursive: true });
    fs.mkdirSync(path.join(tmp, `${version(4)}-0b0b`), { recursive: true });
    await h.run.run();
    expect(fs.readdirSync(tmp).sort()).toEqual([`${version(3)}-0a0a`]);
    expect(h.log).toContain(`The temporary folders of ${version(3)} are not removed: its lock could not be taken (flock is missing).`);
    expect(h.state().lastCleanupAt).toBe(NOW);
  });

  it('are removed also when the platform of the engine is not known', async () => {
    const h = harness({ architecture: async () => Promise.reject(new Error('no answer')) });
    const tmp = path.join(h.root, 'tmp');
    fs.mkdirSync(path.join(tmp, `${version(3)}-0a0a`), { recursive: true });
    await h.run.run();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe('11H2 review round 1 (B): the stored qualities', () => {
  // Review round 1 of 11H2 (A-M1): changed expectation, the stored qualities of 11H2 (a ready insider server in the store)
  // no longer decide; an insider server in the store without an open's use within 14 days asks for no insider server.
  it('a ready insider server that no open used, or an insider folder of another name, asks for no insider server', async () => {
    const h = harness({ commits: { stable: [C2], insider: [C4] } });
    fs.mkdirSync(path.join(serverFolder(h.root, { commit: C3, quality: 'insider' }, 'linux-x64'), 'bin'), { recursive: true });
    await readyServer(h.root, { commit: C4, quality: 'insider' }, 'linux-x64', 'never');
    fs.mkdirSync(path.join(h.root, 'used', `insider-linux-x64-${'x'.repeat(40)}`), { recursive: true });
    await h.run.run();
    expect(h.requests.map((request) => request.url)).toEqual([serverCommitsUrl('stable', 'linux-x64'), serverCommitsUrl('insider', 'linux-x64')]);
    // The insider releases are asked for by the cleanup only (once a day), nothing of insider is fetched.
    expect(h.fetched).toEqual([{ commit: C2, quality: 'stable' }]);
  });
});

describe('11H2 review round 1 (A-M2): the time limit of the read of the processes', () => {
  it('reads the processes of each container that mounts the store within BACKGROUND_ENGINE_TIMEOUT_MS', async () => {
    const made = new Map<AbortSignal, number>();
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const signal = original(ms);
      made.set(signal, ms);
      return signal;
    });
    const seen: Array<number | undefined> = [];
    const h = harness({ commits: { stable: [C4, C3, C2, C1] }, processes: (signal) => void seen.push(signal === undefined ? undefined : made.get(signal)) });
    for (const n of [1, 2, 3, 4]) await readyServer(h.root, { commit: commit(n), quality: 'stable' });
    await h.run.run();
    expect(seen).toEqual([BACKGROUND_ENGINE_TIMEOUT_MS]);
  });
});
