// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the lock of an environment as the worker takes it (takeEnvironmentLock; plan step 11I1, PR B1: the
// operation `lock` is gone). First with a fake `flock` (the order of the steps, the exit codes, the cancel), then with
// real processes as in heartbeatLock.test.ts: `flock` as in the helper image, the kernel lock, a killed holder, and a lock
// file that is a symbolic link. Plan step 11B2: the operation `stop` under its own lock.
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT, LOCK_UNAVAILABLE_CODE, MAX_STOPPED_SERVICES, MAX_STOP_FAILURE_LENGTH, lockFilePath, lockFolder, parseStopParams, parseStopValue } from '../core/helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import { EngineError, type DockerEngine, type EngineContainer, type EngineExecOptions } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { scriptCommand } from '../core/worker/containerScripts';
import { stopOperation } from './flowOperations';
import { LOCK_DEPS, takeEnvironmentLock, type LockDeps } from './lock';
import { FLOCK_FD, openLockFile, type FlockProcess } from '../core/helperChannel/lockFile';
import { OperationError, type OperationContext } from './server';
import { contextSecrets } from './operationContext.testkit';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

interface Harness {
  context: OperationContext;
  controller: AbortController;
  progress: string[];
}

function harness(secret?: string): Harness {
  const controller = new AbortController();
  const progress: string[] = [];
  return {
    controller,
    progress,
    context: {
      signal: controller.signal,
      ...contextSecrets(secret === undefined ? {} : { token: secret }),
      progress: (step) => progress.push(step),
      log: () => {},
      output: () => {},
    },
  };
}

/** A fake flock whose exit the test decides; records its arguments and its kills. */
class FakeFlock implements FlockProcess {
  readonly kills: string[] = [];
  private finish!: (outcome: { exitCode: number | null; error?: string; stderr?: string }) => void;
  readonly exited = new Promise<{ exitCode: number | null; error?: string; stderr?: string }>((resolve) => (this.finish = resolve));
  exit(exitCode: number | null, stderr = ''): void {
    this.finish({ exitCode, stderr });
  }
  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.kills.push(signal);
    this.finish({ exitCode: null });
  }
}

function fakeDeps(options: { openFails?: boolean } = {}): { deps: LockDeps; events: string[]; flocks: FakeFlock[] } {
  const events: string[] = [];
  const flocks: FakeFlock[] = [];
  const deps: LockDeps = {
    stateDir: '/state',
    openLockFile: (stateDir, environmentId) => {
      events.push(`open ${stateDir} ${environmentId}`);
      if (options.openFails) throw new Error('ELOOP: too many symbolic links');
      return 42;
    },
    closeFile: (fd) => events.push(`close ${fd}`),
    startFlock: (args, fd) => {
      events.push(`flock ${args.join(' ')} fd=${fd}`);
      const flock = new FakeFlock();
      flocks.push(flock);
      return flock;
    },
  };
  return { deps, events, flocks };
}

/** Lets the pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Plan step 11I1, PR B1: the operation `lock` is gone; these cases now take the lock the one way that stays
// (takeEnvironmentLock, which that operation ran), so the lock is held until its release instead of the cancel of the
// operation. Gone with the operation: its progress (LOCK_HELD_STEP), its backstop (holdLimitMs), and its checks of the
// parameters and the secret (each flow checks its own parameters, for example parseStopParams).
describe('the lock of an environment with a fake flock (plan step 5, PR B)', () => {
  it('takes the lock with flock -w -E 75 on the inherited file, and holds it until the release', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const taking = takeEnvironmentLock(deps, ID, 10, h.controller.signal);
    await settle();
    expect(events).toEqual(['open /state ' + ID, `flock -w 10 -E ${LOCK_BUSY_EXIT} ${FLOCK_FD} fd=42`]);
    flocks[0].exit(0);
    const release = await taking;
    // Held: the file stays open until the release.
    expect(events).not.toContain('close 42');
    release();
    expect(events.at(-1)).toBe('close 42');
  });

  it('exit 75 of flock is a busy lock (code busy); the file is closed', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const taking = takeEnvironmentLock(deps, ID, 10, h.controller.signal);
    await settle();
    flocks[0].exit(LOCK_BUSY_EXIT);
    await expect(taking).rejects.toMatchObject({ name: 'OperationError', code: 'busy' });
    expect(events.at(-1)).toBe('close 42');
  });

  it('another exit code of flock fails (code failed) with its error output', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const taking = takeEnvironmentLock(deps, ID, 10, h.controller.signal);
    await settle();
    flocks[0].exit(1, 'flock: 3: Bad file descriptor');
    const error = await taking.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: 'failed' });
    expect((error as Error).message).toContain('Bad file descriptor');
    expect(events.at(-1)).toBe('close 42');
  });

  // PR #74 review round 1, B-R1-2: flock killed from outside (an OOM kill, a SIGKILL) while it waits has no lock.
  it('B-R1-2: flock ended by a signal without a cancel fails (code failed), without the lock', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const taking = takeEnvironmentLock(deps, ID, 10, h.controller.signal);
    await settle();
    flocks[0].exit(null);
    const error = await taking.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: 'failed' });
    expect((error as Error).message).toContain('ended by a signal');
    expect(events.at(-1)).toBe('close 42');
  });

  it('a cancel while it waits kills flock and closes the file, without the lock', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const taking = takeEnvironmentLock(deps, ID, 10, h.controller.signal);
    await settle();
    h.controller.abort();
    await expect(taking).rejects.toMatchObject({ code: 'cancelled' });
    expect(flocks[0].kills).toEqual(['SIGKILL']);
    expect(events.at(-1)).toBe('close 42');
  });

  it('fails without flock when the lock file cannot be opened', async () => {
    const { deps, events } = fakeDeps({ openFails: true });
    await expect(takeEnvironmentLock(deps, ID, 10, harness().controller.signal)).rejects.toMatchObject({ code: 'failed' });
    expect(events).toEqual([`open /state ${ID}`]);
  });
});

// As heartbeatLock.test.ts: `flock` and process groups exist on Linux only, where the helper image and CI run.
// Plan step 11I1, PR B1: through takeEnvironmentLock instead of the removed operation `lock` (see above): held once it
// resolves, let go by its release instead of the cancel of the operation.
describe.skipIf(process.platform !== 'linux')('the lock of an environment with real processes (plan step 5, PR B)', () => {
  let stateDir: string;
  const started: ChildProcess[] = [];
  const deps = (): LockDeps => ({ ...LOCK_DEPS, stateDir });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-environment-lock-'));
  });

  afterEach(() => {
    for (const child of started) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-(child.pid as number), 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
    }
    started.length = 0;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  /** Holds the lock file of ID with `flock` in a process group of its own until it is killed; resolves once it holds it. */
  async function holdWithFlock(): Promise<ChildProcess> {
    fs.mkdirSync(lockFolder(stateDir), { recursive: true, mode: 0o700 });
    const marker = path.join(stateDir, 'held');
    const holder = spawn('flock', [lockFilePath(ID, stateDir), 'sh', '-c', `touch '${marker}'; exec sleep 60`], { detached: true, stdio: 'ignore' });
    started.push(holder);
    while (!fs.existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
    return holder;
  }

  function exited(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once('exit', () => resolve()));
  }

  /** `flock -n` from another process: 0 when the lock is free, 1 when it is held. */
  function tryLock(): number {
    try {
      execFileSync('flock', ['-n', lockFilePath(ID, stateDir), 'true'], { stdio: 'ignore' });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  }

  it('takes the lock (folder 0700, file 0600), holds it against another flock, and lets go of it on the release', { timeout: 20_000 }, async () => {
    const release = await takeEnvironmentLock(deps(), ID, 5, harness().controller.signal);
    expect(fs.statSync(lockFolder(stateDir)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(lockFilePath(ID, stateDir)).mode & 0o777).toBe(0o600);
    expect(tryLock()).toBe(1);
    release();
    expect(tryLock()).toBe(0);
    // The lock file is never deleted.
    expect(fs.existsSync(lockFilePath(ID, stateDir))).toBe(true);
  });

  it('a second holder gets exit 75 of the real flock (busy) after its wait, and the first keeps the lock', { timeout: 20_000 }, async () => {
    const release = await takeEnvironmentLock(deps(), ID, 5, harness().controller.signal);
    const startedAt = Date.now();
    await expect(takeEnvironmentLock(deps(), ID, 1, harness().controller.signal)).rejects.toMatchObject({ code: 'busy' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(tryLock()).toBe(1);
    release();
    expect(tryLock()).toBe(0);
  });

  it('a holder killed with SIGKILL frees the lock at once: the waiting lock takes it', { timeout: 20_000 }, async () => {
    const holder = await holdWithFlock();
    let held = false;
    const taking = takeEnvironmentLock(deps(), ID, 10, harness().controller.signal).then((release) => {
      held = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(held).toBe(false);
    process.kill(-(holder.pid as number), 'SIGKILL');
    await exited(holder);
    const killedAt = Date.now();
    const release = await taking;
    expect(Date.now() - killedAt).toBeLessThan(3_000);
    release();
  });

  it('a lock file that is a symbolic link is refused, and its target is not touched', { timeout: 20_000 }, async () => {
    fs.mkdirSync(lockFolder(stateDir), { mode: 0o700 });
    const target = path.join(stateDir, 'elsewhere');
    fs.writeFileSync(target, 'data', { mode: 0o644 });
    fs.symlinkSync(target, lockFilePath(ID, stateDir));
    expect(() => openLockFile(stateDir, ID)).toThrow(/ELOOP|symbolic/);
    await expect(takeEnvironmentLock(deps(), ID, 1, harness().controller.signal)).rejects.toMatchObject({ code: 'failed' });
    expect(fs.readFileSync(target, 'utf8')).toBe('data');
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });

  // PR #74 review round 1, B-R1-7: an existing folder or file with a wider mode is repaired, so no other user can
  // replace a held lock file.
  it('B-R1-7: repairs an existing lock folder at 0777 to 0700 and an existing lock file at 0666 to 0600', () => {
    fs.mkdirSync(lockFolder(stateDir));
    fs.chmodSync(lockFolder(stateDir), 0o777);
    fs.writeFileSync(lockFilePath(ID, stateDir), '');
    fs.chmodSync(lockFilePath(ID, stateDir), 0o666);
    expect(fs.statSync(lockFolder(stateDir)).mode & 0o777).toBe(0o777);
    expect(fs.statSync(lockFilePath(ID, stateDir)).mode & 0o777).toBe(0o666);
    const fd = openLockFile(stateDir, ID);
    try {
      expect(fs.statSync(lockFolder(stateDir)).mode & 0o777).toBe(0o700);
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('a lock folder that is a symbolic link is refused', { timeout: 20_000 }, async () => {
    const elsewhere = path.join(stateDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, lockFolder(stateDir));
    await expect(takeEnvironmentLock(deps(), ID, 1, harness().controller.signal)).rejects.toMatchObject({ code: 'failed' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});

// Plan step 11B2: `stop` takes the lock of the environment itself (takeEnvironmentLock, the one way), runs Stop under it,
// and lets go of it at its end, whatever the end.
describe('the stop operation under its own lock (plan step 11B2)', () => {
  const NAME = 'devenv-acme-api-brave-noether';
  const PARAMS = { environmentId: ID, containerName: NAME, folder: '/workspaces/api', user: 'dev', waitSeconds: 10 };

  function engineOf(stop: () => Promise<void> = async () => {}, events: string[] = [], execs: { command: readonly string[]; options: EngineExecOptions }[] = []): DockerEngine {
    const dev: EngineContainer = { id: 'd'.repeat(64), name: NAME, state: 'running', rawState: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ID }, image: 'img:1' };
    return {
      ...unusedEngine(),
      container: async () => undefined,
      containers: async () => (events.push('list'), [dev]),
      exec: async (_c, command, options = {}) => (events.push('git'), execs.push({ command, options }), { exitCode: 0, stdout: 'main\n0\n0\n0\n', stderr: '', timedOut: false }),
      stop: async () => (events.push('docker stop'), stop()),
      start: async () => {},
    };
  }

  it('takes the lock with the wait of its parameters, stops under it, answers the Git state, and lets go', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const seen: OperationContext[] = [];
    const done = stopOperation((context) => (seen.push(context), engineOf(undefined, events)), deps)(PARAMS, h.context);
    await settle();
    expect(events).toEqual(['open /state ' + ID, `flock -w 10 -E ${LOCK_BUSY_EXIT} ${FLOCK_FD} fd=42`]);
    flocks[0].exit(0);
    const value = await done;
    expect(value).toMatchObject({ outcome: 'stopped', services: [], failures: [], gitSummary: { branch: 'main', uncommittedFiles: 0 } });
    expect(parseStopValue(value)).toBeDefined();
    expect(events.slice(2)).toEqual(['list', 'git', 'docker stop', 'close 42']);
    expect(h.progress).toEqual(['lock', 'stop']);
    expect(seen).toEqual([h.context]);
  });

  it('a lock held elsewhere is busy and stops nothing; one that cannot be taken is lockUnavailable; a failed stop is answered; the lock is let go', async () => {
    const busy = fakeDeps();
    const stops: string[] = [];
    const first = stopOperation(() => engineOf(undefined, stops), busy.deps)(PARAMS, harness().context);
    await settle();
    busy.flocks[0].exit(LOCK_BUSY_EXIT);
    await expect(first).rejects.toMatchObject({ code: 'busy' });
    expect(stops).toEqual([]);
    expect(busy.events.at(-1)).toBe('close 42');
    // Review round 1 (A-R1-3): another failure of the lock changed nothing either.
    const broken = fakeDeps();
    const second = stopOperation(() => engineOf(undefined, stops), broken.deps)(PARAMS, harness().context);
    await settle();
    broken.flocks[0].exit(1, 'flock: bad file');
    await expect(second).rejects.toMatchObject({ code: LOCK_UNAVAILABLE_CODE, message: 'flock failed (exit code 1): flock: bad file' });
    const unopened = fakeDeps({ openFails: true });
    await expect(stopOperation(() => engineOf(undefined, stops), unopened.deps)(PARAMS, harness().context)).rejects.toMatchObject({ code: LOCK_UNAVAILABLE_CODE });
    expect(stops).toEqual([]);
    // Review round 1 (A-R1-2): a stop that failed is answered with the Git state, not thrown.
    const failing = fakeDeps();
    const third = stopOperation(
      () =>
        engineOf(async () => {
          throw new EngineError('permission denied', 500);
        }),
      failing.deps,
    )(PARAMS, harness().context);
    await settle();
    failing.flocks[0].exit(0);
    expect(await third).toMatchObject({ outcome: 'stopped', gitSummary: { branch: 'main' }, failures: [`The container ${NAME} could not be stopped: permission denied`] });
    expect(failing.events.at(-1)).toBe('close 42');
  });

  it('a cancel while it waits for the lock is cancelled, not lockUnavailable (review round 2, B-R2-4)', async () => {
    const { deps, events } = fakeDeps();
    const h = harness();
    const done = stopOperation(() => engineOf(), deps)(PARAMS, h.context);
    await settle();
    h.controller.abort();
    await expect(done).rejects.toMatchObject({ code: 'cancelled' });
    expect(events.at(-1)).toBe('close 42');
  });

  it('a cancel under the lock is cancelled, and lets go of it', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const done = stopOperation(
      () =>
        engineOf(async () => {
          // As the port: a cancel ends the request with an AbortError.
          h.controller.abort();
          throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        }),
      deps,
    )(PARAMS, h.context);
    await settle();
    flocks[0].exit(0);
    await expect(done).rejects.toMatchObject({ code: 'cancelled' });
    expect(events.at(-1)).toBe('close 42');
  });

  it('refuses invalid parameters and any secret, before the lock', async () => {
    for (const params of [{}, { ...PARAMS, waitSeconds: 0 }, { ...PARAMS, folder: '/etc' }, { ...PARAMS, user: '-u' }, { ...PARAMS, extra: 1 }]) {
      const { deps, events } = fakeDeps();
      await expect(stopOperation(() => engineOf(), deps)(params, harness().context), JSON.stringify(params)).rejects.toMatchObject({ code: 'invalid' });
      expect(events).toEqual([]);
    }
    const { deps, events } = fakeDeps();
    await expect(stopOperation(() => engineOf(), deps)(PARAMS, harness('abcd1234').context)).rejects.toMatchObject({ code: 'invalid' });
    expect(events).toEqual([]);
  });

  it('takeEnvironmentLock closes the file when the lock is not taken, and its release closes it once', async () => {
    const { deps, events, flocks } = fakeDeps();
    const controller = new AbortController();
    const taking = takeEnvironmentLock(deps, ID, 5, controller.signal);
    await settle();
    flocks[0].exit(0);
    const release = await taking;
    expect(events).not.toContain('close 42');
    release();
    expect(events.filter((event) => event === 'close 42')).toHaveLength(1);
    const failed = fakeDeps();
    const refused = takeEnvironmentLock(failed.deps, ID, 5, new AbortController().signal);
    await settle();
    failed.flocks[0].exit(1, 'flock: bad file');
    await expect(refused).rejects.toMatchObject({ code: 'failed', message: 'flock failed (exit code 1): flock: bad file' });
    expect(failed.events.at(-1)).toBe('close 42');
  });

  it('reads the Git state in the folder, as the user, with the cancel of the operation; waits as asked; logs (review round 1, B-R1-3 to B-R1-5, B-R1-15, B-R1-16)', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const lines: string[] = [];
    h.context.log = (line) => lines.push(line);
    const execs: { command: readonly string[]; options: EngineExecOptions }[] = [];
    const done = stopOperation(() => engineOf(undefined, [], execs), deps)({ ...PARAMS, waitSeconds: 7 }, h.context);
    await settle();
    expect(events[1]).toBe(`flock -w 7 -E ${LOCK_BUSY_EXIT} ${FLOCK_FD} fd=42`);
    flocks[0].exit(0);
    await done;
    expect(execs).toHaveLength(1);
    expect(execs[0].command).toEqual(scriptCommand('gitSummary', ['/workspaces/api']));
    expect(execs[0].options).toMatchObject({ user: 'dev', signal: h.context.signal });
    expect(lines).toContain(`Stopping the container ${NAME}.`);
  });

  it('flock that cannot start names why (review round 1, B-R1-18)', async () => {
    const { deps } = fakeDeps();
    deps.startFlock = () => ({ exited: Promise.resolve({ exitCode: null, error: 'ENOENT flock' }), kill: () => {} });
    await expect(takeEnvironmentLock(deps, ID, 5, new AbortController().signal)).rejects.toMatchObject({ code: 'failed', message: 'flock could not be started: ENOENT flock' });
  });
});

describe('the checks of stop (plan step 11B2)', () => {
  const PARAMS = { environmentId: ID, containerName: 'devenv-acme-api-brave-noether', folder: '/workspaces/api', waitSeconds: 10 };
  it('takes the parameters of a Stop, and nothing else', () => {
    expect(parseStopParams(PARAMS)).toEqual(PARAMS);
    expect(parseStopParams({ ...PARAMS, user: 'dev' })).toEqual({ ...PARAMS, user: 'dev' });
    for (const value of [null, { ...PARAMS, waitSeconds: 61 }, { ...PARAMS, waitSeconds: 1.5 }, { ...PARAMS, folder: '/workspaces/..' }, { ...PARAMS, environmentId: 'a b' }, { ...PARAMS, containerName: '-x' }, { ...PARAMS, user: 'a b' }]) {
      expect(parseStopParams(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('takes the value of a Stop, the Git state only after a stop, and only its fields', () => {
    const summary = { branch: null, uncommittedFiles: 0, unpushedCommits: 0, stashes: 1, recordedAt: '2026-10-03T23:00:00.000Z' };
    expect(parseStopValue({ outcome: 'stopped', gitSummary: { ...summary, extra: 'x' }, services: ['db-1'], failures: ['no'] })).toEqual({
      outcome: 'stopped',
      gitSummary: summary,
      services: ['db-1'],
      failures: ['no'],
    });
    expect(parseStopValue({ outcome: 'notRunning', services: [], failures: [] })).toEqual({ outcome: 'notRunning', services: [], failures: [] });
    // Review round 1 (B-R1-13, B-R1-14, B-R1-17): the limits, exactly, and the check of the Git state.
    expect(MAX_STOPPED_SERVICES).toBe(256);
    // Review round 2 (B-R2-2): a reason of exactly the longest length, as the worker clips one, is accepted.
    expect(MAX_STOP_FAILURE_LENGTH).toBe(1000);
    expect(parseStopValue({ outcome: 'stopped', services: [], failures: ['x'.repeat(MAX_STOP_FAILURE_LENGTH)] })?.failures).toHaveLength(1);
    const all = Array.from({ length: MAX_STOPPED_SERVICES }, (_, i) => `s${i}`);
    expect(parseStopValue({ outcome: 'notRunning', services: all, failures: [] })?.services).toHaveLength(MAX_STOPPED_SERVICES);
    for (const gitSummary of [{ ...summary, branch: 1 }, { ...summary, uncommittedFiles: 1.5 }, { branch: 'x', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0 }]) {
      expect(parseStopValue({ outcome: 'stopped', gitSummary, services: [], failures: [] }), JSON.stringify(gitSummary)).toBeUndefined();
    }
    for (const value of [
      { outcome: 'notRunning', gitSummary: summary, services: [], failures: [] },
      { outcome: 'stopped', gitSummary: { ...summary, stashes: -1 }, services: [], failures: [] },
      { outcome: 'stopped', services: ['-x'], failures: [] },
      { outcome: 'stopped', services: Array.from({ length: MAX_STOPPED_SERVICES + 1 }, (_, i) => `s${i}`), failures: [] },
      { outcome: 'stopped', services: [], failures: Array.from({ length: MAX_STOPPED_SERVICES + 2 }, () => 'x') },
      { outcome: 'stopped', services: [], failures: ['x'.repeat(MAX_STOP_FAILURE_LENGTH + 1)] },
      // Review round 2 (B-R2-7): the type of the failures and of the list.
      { outcome: 'stopped', services: [], failures: [[]] },
      { outcome: 'stopped', services: [], failures: 'x' },
      { outcome: 'stopped', services: [], failures: [1] },
      { outcome: 'stopped', services: [] },
      { outcome: 'stopped', failures: [] },
      { outcome: 'maybe', services: [], failures: [] },
      { outcome: 'stopped', services: [], failures: [], more: 1 },
    ]) {
      expect(parseStopValue(value), JSON.stringify(value).slice(0, 80)).toBeUndefined();
    }
  });
});
