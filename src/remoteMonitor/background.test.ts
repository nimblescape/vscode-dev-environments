// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D2 to D5): one background run of the Session Monitor with fakes: the images
// (a), the newest released VS Code server through the fetch of the open (b), its link into the running dev containers
// that mount the store, as the remote user of each (c), and the cleanup of the store at most once a day (d), each part
// failing on its own. The store is a temporary folder (never the home folder).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VscodePlatform, VscodeServerRef } from '../core/helperChannel/protocol';
import type { HttpRequest, HttpStreamTransport, HttpTransport } from '../core/http';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import { silentLogger } from '../core/ports';
import { scriptCommand } from '../core/worker/containerScripts';
import type { EngineContainer, EngineContainerSummary, EngineExecOptions, EngineExecResult } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { serverCommitsUrl, serverFolder, serverLockFile, type StoreLockAttempt, type VscodeStoreDeps } from '../core/worker/vscodeServerStore';
import { BackgroundRun, type CacheRunStore, type VscodeBackgroundDeps } from './background';
import { SERVER_UNUSED_MS, type CacheRunState } from './backgroundRules';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const commit = (n: number) => n.toString(16).padStart(40, '0');
const C1 = commit(1);
const C2 = commit(2);
const C3 = commit(3);
const C4 = commit(4);
const C5 = commit(5);
const STORE = 'devenv-vscode';
const STORE_MOUNT = { type: 'volume', volume: STORE, target: '/opt/devenv/vscode', readOnly: true as const };
const METADATA = JSON.stringify([{ id: 'base', remoteUser: 'root' }, { remoteUser: 'vscode' }]);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function readyServer(root: string, server: VscodeServerRef, platform: VscodePlatform = 'linux-x64', usedAt = NOW - SERVER_UNUSED_MS - DAY): string {
  const folder = serverFolder(root, server, platform);
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(folder, 'node'), '');
  fs.utimesSync(folder, new Date(usedAt), new Date(usedAt));
  return folder;
}

interface Container {
  id: string;
  name: string;
  state: 'running' | 'exited';
  mounts?: EngineContainer['mountTargets'];
  labels?: Record<string, string>;
  exec?: EngineExecResult;
}

const linked: EngineExecResult = { exitCode: 0, stdout: 'linked\n', stderr: '', timedOut: false };

function harness(options: {
  commits?: Partial<Record<'stable' | 'insider', unknown>>;
  architecture?: string | Error;
  containers?: Container[];
  busy?: string[];
  onLock?: (name: string) => void;
  state?: CacheRunState;
  images?: () => Promise<void>;
  fetch?: (server: VscodeServerRef) => boolean;
  vscode?: false;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-background-'));
  temps.push(root);
  const log: string[] = [];
  const requests: HttpRequest[] = [];
  const fetched: Array<{ server: VscodeServerRef; platform: VscodePlatform }> = [];
  const execs: Array<{ container: string; command: readonly string[]; user?: string }> = [];
  const inspected: string[] = [];
  const locks: string[] = [];
  const released: string[] = [];
  let listed = 0;
  let state: CacheRunState = options.state ?? {};
  const imagesCalled: number[] = [];
  const transport: HttpTransport = {
    request: async (request) => {
      requests.push(request);
      const quality = request.url === serverCommitsUrl('insider', 'linux-x64') ? 'insider' : 'stable';
      const answer = options.commits?.[quality];
      if (answer instanceof Error) throw answer;
      return { status: 200, headers: {}, body: typeof answer === 'string' ? answer : JSON.stringify(answer ?? [C1]) };
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
      architecture: async () => {
        if (options.architecture instanceof Error) throw options.architecture;
        return options.architecture ?? 'x86_64';
      },
      containerSummaries: async (label) => {
        listed++;
        expect(label).toBe(LABEL_ENVIRONMENT_ID);
        return containers.map((container): EngineContainerSummary => ({ id: container.id, name: container.name, state: container.state, labels: { [LABEL_ENVIRONMENT_ID]: 'x' } }));
      },
      container: async (id) => {
        inspected.push(id);
        const found = containers.find((container) => container.id === id)!;
        return {
          id,
          name: found.name,
          state: found.state === 'running' ? 'running' : 'stopped',
          rawState: found.state,
          labels: found.labels ?? {},
          image: 'image',
          ...(found.mounts ? { mountTargets: found.mounts } : {}),
        } as EngineContainer;
      },
      exec: async (container: string, command: readonly string[], execOptions?: EngineExecOptions) => {
        execs.push({ container, command, ...(execOptions?.user !== undefined ? { user: execOptions.user } : {}) });
        return containers.find((entry) => entry.id === container)?.exec ?? linked;
      },
    },
    tryLock: async (name): Promise<StoreLockAttempt> => {
      locks.push(name);
      options.onLock?.(name);
      if (options.busy?.includes(name)) return { kind: 'busy' };
      return { kind: 'locked', release: () => void released.push(name) };
    },
    ensure: async (_deps, server, platform) => {
      fetched.push({ server, platform });
      const ready = options.fetch?.(server) ?? true;
      // A fetched server whose folder was not used yet (the time of the archive): the link marks it.
      if (ready) readyServer(root, server, platform, NOW - 3 * DAY);
      return ready;
    },
  };
  const stateStore: CacheRunStore = { read: async () => state, update: async (change) => void (state = { ...state, ...change }) };
  const run = new BackgroundRun({
    log: (message) => log.push(message),
    now: () => NOW,
    images: async () => {
      imagesCalled.push(1);
      await options.images?.();
    },
    vscode: () => (options.vscode === false ? undefined : vscode),
    state: stateStore,
  });
  return { run, root, log, requests, fetched, execs, inspected, locks, released, listed: () => listed, state: () => state, imagesCalled };
}

const linkCommand = (server: string, quality = 'stable') => scriptCommand('vscodeServerLink', [server, quality, 'linux-x64']);

describe('the background run of the Session Monitor (plan step 11H2)', () => {
  it('runs the images first; a failure there stops neither the VS Code server nor the cleanup', async () => {
    const h = harness({ images: async () => Promise.reject(new Error('registry down')), commits: { stable: [C2, C1] } });
    await h.run.run();
    expect(h.imagesCalled).toHaveLength(1);
    expect(h.log).toContain('The background run could not do the images: registry down');
    expect(h.fetched).toEqual([{ server: { commit: C2, quality: 'stable' }, platform: 'linux-x64' }]);
    expect(h.state().lastCleanupAt).toBe(NOW);
    expect(h.log.at(-1)).toBe('The background run ended.');
  });

  it('without a store: the images only, and one line', async () => {
    const h = harness({ vscode: false });
    await h.run.run();
    expect(h.imagesCalled).toHaveLength(1);
    expect(h.requests).toEqual([]);
    expect(h.log).toContain('The Session Monitor mounts no shared VS Code server store; the background run leaves the VS Code server out.');
  });

  // The HTTPS of the VS Code part reads the proxy of the daemon once; a failed read must not hold every later run.
  it('makes the VS Code part afresh for each run', async () => {
    let made = 0;
    const run = new BackgroundRun({
      log: () => {},
      now: () => NOW,
      images: async () => {},
      vscode: () => void made++,
      state: { read: async () => ({}), update: async () => {} },
    });
    await run.run();
    await run.run();
    expect(made).toBe(2);
  });

  it('fetches the newest released stable server of the engine platform through the fetch of the open', async () => {
    const h = harness({ commits: { stable: [C2, C1] }, architecture: 'aarch64' });
    await h.run.run();
    expect(h.requests.map((request) => request.url)).toEqual([serverCommitsUrl('stable', 'linux-arm64')]);
    expect(h.fetched).toEqual([{ server: { commit: C2, quality: 'stable' }, platform: 'linux-arm64' }]);
  });

  it('fetches nothing and links nothing when the newest server is in the store already', async () => {
    const h = harness({ commits: { stable: [C2, C1] }, containers: [{ id: 'a', name: 'dev-a', state: 'running', mounts: [STORE_MOUNT], labels: { 'devcontainer.metadata': METADATA } }] });
    readyServer(h.root, { commit: C2, quality: 'stable' }, 'linux-x64', NOW);
    await h.run.run();
    expect(h.fetched).toEqual([]);
    expect(h.listed()).toBe(0);
    expect(h.execs).toEqual([]);
  });

  it('asks for the insider server only when the store has one', async () => {
    const without = harness({ commits: { stable: [C2], insider: [C5] } });
    await without.run.run();
    expect(without.requests.map((request) => request.url)).toEqual([serverCommitsUrl('stable', 'linux-x64')]);
    const withInsider = harness({ commits: { stable: [C2], insider: [C5, C4] } });
    readyServer(withInsider.root, { commit: C4, quality: 'insider' }, 'linux-x64', NOW);
    await withInsider.run.run();
    expect(withInsider.requests.map((request) => request.url)).toEqual([serverCommitsUrl('stable', 'linux-x64'), serverCommitsUrl('insider', 'linux-x64')]);
    expect(withInsider.fetched.map((entry) => entry.server)).toEqual([
      { commit: C2, quality: 'stable' },
      { commit: C5, quality: 'insider' },
    ]);
  });

  it('an invalid or failed answer of the update service is one line, and nothing is fetched', async () => {
    for (const answer of ['{"commit":"x"}', JSON.stringify(['ABC']), new Error('proxy refused')]) {
      const h = harness({ commits: { stable: answer } });
      await h.run.run();
      expect(h.fetched).toEqual([]);
      expect(h.log.some((line) => line.startsWith('The newest VS Code server (stable, linux-x64) could not be read from the update service:'))).toBe(true);
    }
  });

  it('an engine whose architecture is unknown or has no server: one line, nothing fetched, no versions removed', async () => {
    for (const architecture of [new Error('no answer'), 'riscv64']) {
      const h = harness({ architecture, commits: { stable: [C5] } });
      for (const n of [1, 2, 3]) readyServer(h.root, { commit: commit(n), quality: 'stable' });
      await h.run.run();
      expect(h.fetched).toEqual([]);
      expect(h.requests).toEqual([]);
      expect(fs.readdirSync(path.dirname(serverFolder(h.root, { commit: C1, quality: 'stable' }, 'linux-x64'))).sort()).toEqual([C1, C2, C3]);
      expect(h.log).toContain('The shared VS Code server store is not cleaned up: the platform of the engine is not known.');
    }
  });
});

describe('the link of a new server into the running dev containers (plan step 11H2, D4)', () => {
  const containers: Container[] = [
    { id: 'a', name: 'dev-a', state: 'running', mounts: [STORE_MOUNT], labels: { 'devcontainer.metadata': METADATA } },
    { id: 'b', name: 'dev-b', state: 'running', mounts: [{ type: 'volume', volume: 'devenv-workspace-x', target: '/workspaces' }], labels: { 'devcontainer.metadata': METADATA } },
    { id: 'c', name: 'dev-c', state: 'running', mounts: [STORE_MOUNT], labels: {} },
    { id: 'd', name: 'dev-d', state: 'exited', mounts: [STORE_MOUNT], labels: { 'devcontainer.metadata': METADATA } },
    { id: 'e', name: 'dev-e', state: 'running', mounts: [STORE_MOUNT], labels: { 'devcontainer.metadata': JSON.stringify([{ remoteUser: 'node' }]) }, exec: { exitCode: 1, stdout: '', stderr: 'ln: failed\n', timedOut: false } },
    { id: 'f', name: 'dev-f', state: 'running', mounts: [{ ...STORE_MOUNT, readOnly: undefined } as unknown as typeof STORE_MOUNT], labels: { 'devcontainer.metadata': METADATA } },
  ];

  it('links it as the remote user of each running container that mounts the store; skips the others with one line each', async () => {
    const h = harness({ commits: { stable: [C2, C1] }, containers });
    await h.run.run();
    expect(h.execs).toEqual([
      { container: 'a', command: linkCommand(C2), user: 'vscode' },
      { container: 'e', command: linkCommand(C2), user: 'node' },
    ]);
    // The exited one is not even inspected.
    expect(h.inspected).toEqual(['a', 'b', 'c', 'e', 'f']);
    const name = `${C2} (stable)`;
    expect(h.log).toEqual(
      expect.arrayContaining([
        `The VS Code server ${name} is linked into dev-a (as vscode).`,
        `The VS Code server ${name} is not linked into dev-b: it does not mount the shared store.`,
        `The VS Code server ${name} is not linked into dev-c: its label devcontainer.metadata names no remote user.`,
        `The VS Code server ${name} is not linked into dev-e (failed: exit code 1: ln: failed).`,
        `The VS Code server ${name} is not linked into dev-f: it does not mount the shared store.`,
      ]),
    );
    // The link marks the version as used now.
    expect(fs.lstatSync(serverFolder(h.root, { commit: C2, quality: 'stable' }, 'linux-x64')).mtimeMs).toBe(NOW);
  });

  it('links nothing after a fetch that failed', async () => {
    const h = harness({ commits: { stable: [C2, C1] }, containers, fetch: () => false });
    await h.run.run();
    expect(h.fetched).toHaveLength(1);
    expect(h.listed()).toBe(0);
    expect(h.execs).toEqual([]);
  });
});

describe('the cleanup of the store (plan step 11H2)', () => {
  const version = (n: number) => `stable-linux-x64-${commit(n)}`;
  const stored = (root: string) => fs.readdirSync(path.dirname(serverFolder(root, { commit: C1, quality: 'stable' }, 'linux-x64'))).sort();

  it('removes the versions unused for 14 days beyond the two newest, each under its lock taken without a wait; lock files stay', async () => {
    const h = harness({ commits: { stable: [C4, C3, C2, C1] } });
    for (const n of [1, 2, 3, 4]) readyServer(h.root, { commit: commit(n), quality: 'stable' });
    fs.mkdirSync(path.join(h.root, 'locks'));
    fs.writeFileSync(serverLockFile(h.root, version(1)), '');
    await h.run.run();
    expect(stored(h.root)).toEqual([C3, C4]);
    expect(h.locks.sort()).toEqual([version(1), version(2)]);
    expect(h.released.sort()).toEqual([version(1), version(2)]);
    expect(fs.existsSync(serverLockFile(h.root, version(1)))).toBe(true);
    // The removal leaves no temporary folder.
    expect(fs.readdirSync(path.join(h.root, 'tmp'))).toEqual([]);
    expect(h.state().lastCleanupAt).toBe(NOW);
  });

  it('skips a version whose lock is held (a download of it runs), and one used since the list', async () => {
    const h = harness({
      commits: { stable: [C4, C3, C2, C1] },
      busy: [version(2)],
      onLock: (name) => {
        if (name === version(1)) fs.utimesSync(serverFolder(h.root, { commit: C1, quality: 'stable' }, 'linux-x64'), new Date(NOW), new Date(NOW));
      },
    });
    for (const n of [1, 2, 3, 4]) readyServer(h.root, { commit: commit(n), quality: 'stable' });
    await h.run.run();
    expect(stored(h.root)).toEqual([C1, C2, C3, C4]);
    expect(h.log).toContain(`The VS Code server ${C2} (stable) is not removed now: its lock is held (a download of it runs).`);
    expect(h.released).toEqual([version(1)]);
  });

  it('removes the temporary folders of a version only while its lock can be taken at once; other names stay', async () => {
    const h = harness({ commits: { stable: [C1] }, busy: [version(5)] });
    const tmp = path.join(h.root, 'tmp');
    fs.mkdirSync(path.join(tmp, `${version(3)}-0a0a`, 'server'), { recursive: true });
    fs.mkdirSync(path.join(tmp, `${version(3)}-0b0b`), { recursive: true });
    fs.mkdirSync(path.join(tmp, `${version(5)}-0c0c`), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    await h.run.run();
    expect(fs.readdirSync(tmp).sort()).toEqual([`${version(5)}-0c0c`, 'unrelated']);
    expect(h.locks.sort()).toEqual([version(3), version(5)]);
    expect(h.released).toEqual([version(3)]);
  });

  it('runs at most once a day', async () => {
    const recent = harness({ commits: { stable: [C4, C3, C2, C1] }, state: { lastCleanupAt: NOW - DAY + 60_000 } });
    for (const n of [1, 2, 3, 4]) readyServer(recent.root, { commit: commit(n), quality: 'stable' });
    fs.mkdirSync(path.join(recent.root, 'tmp', `${version(3)}-0a0a`), { recursive: true });
    await recent.run.run();
    expect(stored(recent.root)).toEqual([C1, C2, C3, C4]);
    expect(recent.locks).toEqual([]);
    expect(recent.state().lastCleanupAt).toBe(NOW - DAY + 60_000);
    const due = harness({ commits: { stable: [C4, C3, C2, C1] }, state: { lastCleanupAt: NOW - DAY } });
    for (const n of [1, 2, 3, 4]) readyServer(due.root, { commit: commit(n), quality: 'stable' });
    await due.run.run();
    expect(stored(due.root)).toEqual([C3, C4]);
  });

  it('leaves a quality whose releases the update service did not name as it is', async () => {
    const h = harness({ commits: { stable: new Error('no answer') } });
    for (const n of [1, 2, 3, 4]) readyServer(h.root, { commit: commit(n), quality: 'stable' });
    await h.run.run();
    expect(stored(h.root)).toEqual([C1, C2, C3, C4]);
    expect(h.log).toContain('The VS Code servers (stable, linux-x64) of the shared store are not cleaned up: the update service did not name its releases.');
    expect(h.state().lastCleanupAt).toBe(NOW);
  });
});
