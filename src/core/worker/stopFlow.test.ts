// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B2: Stop as a flow of the worker, with the port of the engine (the lock is the operation's, flowOperations.ts).
import { describe, expect, it } from 'vitest';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../names';
import { scriptCommand } from './containerScripts';
import { EngineError, type DockerEngine, type EngineContainer, type EngineExecOptions, type EngineExecResult } from './dockerEngine';
import { runningDevContainer, runningServices } from './environmentContainers';
import { STOP_CONTAINER_TIMEOUT_MS, STOP_GIT_TIMEOUT_MS, stopFlow } from './stopFlow';
import { MAX_STOPPED_SERVICES, MAX_STOP_FAILURE_LENGTH, parseStopValue } from '../helperChannel/protocol';

const ENVIRONMENT_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devenv-acme-api-brave-noether';
const FOLDER = '/workspaces/api';
const NOW = '2026-10-03T23:00:00.000Z';

function container(overrides: Partial<EngineContainer> = {}): EngineContainer {
  return { id: 'd'.repeat(64), name: NAME, state: 'running', rawState: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID }, image: 'img:1', ...overrides };
}

function service(name: string, state: 'running' | 'stopped' = 'running'): EngineContainer {
  return container({ id: name.padEnd(64, '0').slice(0, 64), name, state, rawState: state === 'running' ? 'running' : 'exited', labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID, [LABEL_COMPOSE_SERVICE]: name.split('-').at(-1)! } });
}

const SUMMARY_OUTPUT = 'main\n2\n1\n0\n';

function fakeEngine(listed: EngineContainer[], exec: () => EngineExecResult | Promise<EngineExecResult> = () => ({ exitCode: 0, stdout: SUMMARY_OUTPUT, stderr: '', timedOut: false })) {
  const calls: string[] = [];
  const execs: { container: string; command: readonly string[]; options: EngineExecOptions }[] = [];
  const stops: { container: string; timeout?: number; signal?: AbortSignal }[] = [];
  const engine: DockerEngine = {
    container: async () => undefined,
    containers: async (label) => (calls.push(`list ${label}`), listed),
    exec: async (name, command, options = {}) => {
      calls.push(`exec ${name}`);
      execs.push({ container: name, command, options });
      return exec();
    },
    stop: async (name, timeout, signal) => {
      calls.push(`stop ${name}`);
      stops.push({ container: name, timeout, signal });
    },
    start: async () => {},
  };
  return { engine, calls, execs, stops };
}

const run = (engine: DockerEngine, more: Partial<Parameters<typeof stopFlow>[0]> = {}) => {
  const lines: string[] = [];
  return {
    lines,
    result: stopFlow({ environmentId: ENVIRONMENT_ID, containerName: NAME, folder: FOLDER, user: 'dev', engine, log: (line) => lines.push(line), now: () => NOW, ...more }),
  };
};

describe('Stop as a flow of the worker (plan step 11B2)', () => {
  it('reads the Git state as the remote user, then stops the dev container and after it the running services', async () => {
    const db = service(`${NAME}-db`);
    const { engine, calls, execs, stops } = fakeEngine([db, container(), service(`${NAME}-cache`, 'stopped')]);
    const controller = new AbortController();
    const { result, lines } = run(engine, { signal: controller.signal });
    expect(await result).toEqual({
      outcome: 'stopped',
      gitSummary: { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, stashes: 0, recordedAt: NOW },
      services: [`${NAME}-db`],
      failures: [],
    });
    expect(calls).toEqual([`list ${LABEL_ENVIRONMENT_ID}=${ENVIRONMENT_ID}`, `exec ${'d'.repeat(64)}`, `stop ${'d'.repeat(64)}`, `stop ${db.id}`]);
    expect(execs[0]).toMatchObject({ command: scriptCommand('gitSummary', [FOLDER]), options: { user: 'dev', timeoutMs: STOP_GIT_TIMEOUT_MS, signal: controller.signal } });
    // Its own stop time (no `t`), and a signal that the cancel of the operation ends.
    expect(stops.map((stop) => stop.timeout)).toEqual([undefined, undefined]);
    controller.abort();
    expect(stops.every((stop) => stop.signal?.aborted)).toBe(true);
    expect(lines).toEqual([`Stopping the container ${NAME}.`, `Stopping the container ${NAME}-db of the service db.`]);
  });

  it('stops the running services also when the dev container does not run, and reads no Git state', async () => {
    const db = service(`${NAME}-db`);
    const { engine, execs, stops } = fakeEngine([container({ state: 'stopped', rawState: 'exited' }), db]);
    const { result, lines } = run(engine);
    expect(await result).toEqual({ outcome: 'notRunning', services: [`${NAME}-db`], failures: [] });
    expect(execs).toEqual([]);
    expect(stops.map((stop) => stop.container)).toEqual([db.id]);
    expect(lines[0]).toBe(`The container ${NAME} does not run.`);
  });

  it('stops without a Git state when it cannot be read, and logs why', async () => {
    for (const [exec, reason] of [
      [() => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n', timedOut: false }), 'fatal: not a git repository'],
      [() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }), 'the script did not end in time.'],
      [() => ({ exitCode: 0, stdout: 'banner only\n', stderr: '', timedOut: false }), 'Unexpected output of the Git summary'],
      [
        () => {
          throw new EngineError('the daemon is busy', 500);
        },
        'the daemon is busy',
      ],
    ] as const) {
      const { engine, stops } = fakeEngine([container()], exec);
      const { result, lines } = run(engine);
      expect(await result).toEqual({ outcome: 'stopped', services: [], failures: [] });
      expect(stops).toHaveLength(1);
      expect(lines[0]).toContain(`The Git state in ${NAME} could not be read: `);
      expect(lines[0]).toContain(reason);
    }
  });

  it('stops the others when a container cannot be stopped, and answers its reason with the Git state (review round 1, A-R1-2)', async () => {
    const db = service(`${NAME}-db`);
    const cache = service(`${NAME}-cache`);
    const failing = fakeEngine([container(), db, cache]);
    const stopped: string[] = [];
    failing.engine.stop = async (id) => {
      if (id === db.id) throw new EngineError('cannot stop container: permission denied', 500);
      stopped.push(id);
    };
    const { result, lines } = run(failing.engine);
    expect(await result).toEqual({
      outcome: 'stopped',
      gitSummary: { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, stashes: 0, recordedAt: NOW },
      services: [`${NAME}-cache`],
      failures: [`The container ${NAME}-db could not be stopped: cannot stop container: permission denied`],
    });
    expect(stopped).toEqual(['d'.repeat(64), cache.id]);
    expect(lines).toContain(`The container ${NAME}-db could not be stopped: cannot stop container: permission denied`);
    // The dev container itself, and a reason that is clipped.
    const dev = fakeEngine([container()]);
    dev.engine.stop = async () => {
      throw new EngineError('x'.repeat(5000), 500);
    };
    const answered = await run(dev.engine).result;
    expect(answered.gitSummary).toBeDefined();
    expect(answered.failures).toHaveLength(1);
    expect(answered.failures[0]).toHaveLength(MAX_STOP_FAILURE_LENGTH);
    expect(answered.failures[0].endsWith('…')).toBe(true);
    // One that is gone meanwhile is no failure.
    const gone = fakeEngine([container(), service(`${NAME}-db`)]);
    gone.engine.stop = async () => {
      throw new EngineError('No such container', 404);
    };
    const { result: goneResult, lines: goneLines } = run(gone.engine);
    expect(await goneResult).toMatchObject({ outcome: 'stopped', services: [`${NAME}-db`], failures: [] });
    expect(goneLines.filter((line) => line.endsWith('does not exist any more.'))).toHaveLength(2);
  });

  it('names at most MAX_STOPPED_SERVICES services and as many failures as the answer takes, and stops all (review round 1, A-R1-6)', async () => {
    const many = Array.from({ length: MAX_STOPPED_SERVICES + 5 }, (_, i) => service(`${NAME}-s${i}`));
    const ok = fakeEngine(many);
    const answered = await run(ok.engine).result;
    expect(ok.stops).toHaveLength(many.length);
    expect(answered.services).toHaveLength(MAX_STOPPED_SERVICES);
    expect(parseStopValue(answered)).toBeDefined();
    const failing = fakeEngine(many);
    failing.engine.stop = async () => {
      throw new EngineError('busy', 500);
    };
    const refused = await run(failing.engine).result;
    expect(refused.failures).toHaveLength(MAX_STOPPED_SERVICES + 1);
    expect(parseStopValue(refused)).toBeDefined();
  });

  it('a cancel ends it with its AbortError, also while the Git state is read', async () => {
    const controller = new AbortController();
    const { engine, stops } = fakeEngine([container()], async () => {
      controller.abort();
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    });
    await expect(run(engine, { signal: controller.signal }).result).rejects.toMatchObject({ name: 'AbortError' });
    expect(stops).toEqual([]);
  });

  it('stops every running service, not only the first, and logs each (review round 1, B-R1-1, B-R1-16)', async () => {
    const a = service(`${NAME}-a`);
    const b = service(`${NAME}-b`);
    const { engine, stops } = fakeEngine([container(), a, b]);
    const { result, lines } = run(engine);
    expect((await result).services).toEqual([`${NAME}-a`, `${NAME}-b`]);
    expect(stops.map((stop) => stop.container)).toEqual(['d'.repeat(64), a.id, b.id]);
    expect(lines.filter((line) => line.startsWith('Stopping the container'))).toHaveLength(3);
  });

  it('ends a stop at its own time limit also while the operation runs on, and names it (review round 1, B-R1-2)', async () => {
    const controller = new AbortController();
    const { engine } = fakeEngine([container()]);
    engine.stop = (_id, _timeout, signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const answered = await run(engine, { signal: controller.signal, stopContainerTimeoutMs: 30 }).result;
    expect(controller.signal.aborted).toBe(false);
    expect(answered.failures).toEqual([`The container ${NAME} did not stop within 0.03 s.`]);
    expect(STOP_CONTAINER_TIMEOUT_MS).toBe(60_000);
    expect(STOP_GIT_TIMEOUT_MS).toBe(30_000);
  });

  it('a cancel during a stop ends the flow with its AbortError, and the list gets the signal (review round 1, B-R1-9, B-R1-10)', async () => {
    const controller = new AbortController();
    const { engine } = fakeEngine([container()]);
    const signals: (AbortSignal | undefined)[] = [];
    const list = engine.containers;
    engine.containers = async (label, signal) => (signals.push(signal), list(label, signal));
    engine.stop = async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(run(engine, { signal: controller.signal }).result).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals).toEqual([controller.signal]);
  });

  it('names the running dev container that has another name than the recorded one (review round 1, B-R1-11)', async () => {
    const { engine, stops } = fakeEngine([container({ name: 'renamed' })]);
    const { result, lines } = run(engine);
    expect((await result).outcome).toBe('stopped');
    expect(stops.map((stop) => stop.container)).toEqual(['d'.repeat(64)]);
    expect(lines[0]).toBe(`The container ${NAME} does not run; the running container renamed of the environment is used.`);
  });

  it('takes the reason of an unread Git state from stdout, trimmed, or names the exit code (review round 1, B-R1-12)', async () => {
    for (const [exec, expected] of [
      [() => ({ exitCode: 1, stdout: '  only on stdout \n', stderr: '', timedOut: false }), `The Git state in ${NAME} could not be read: only on stdout`],
      [() => ({ exitCode: 2, stdout: '', stderr: '', timedOut: false }), `The Git state in ${NAME} could not be read: exit code 2.`],
    ] as const) {
      const { engine } = fakeEngine([container()], exec);
      const { result, lines } = run(engine);
      await result;
      expect(lines[0]).toBe(expected);
    }
  });
});

describe('the containers of an environment for the flows (plan step 11B2)', () => {
  it('the running services are the running containers with the service label, never the dev container', () => {
    const dev = container({ labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID, [LABEL_COMPOSE_SERVICE]: 'app' } });
    const db = service(`${NAME}-db`);
    const all = [dev, db, service(`${NAME}-cache`, 'stopped'), container({ id: 'e'.repeat(64), name: 'plain' })];
    expect(runningDevContainer(all, NAME)).toBe(dev);
    expect(runningServices(all, dev)).toEqual([db]);
    expect(runningServices(all)).toEqual([dev, db]);
  });
});
