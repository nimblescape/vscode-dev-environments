// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1: the first flow that runs in the worker: the token removal of a dev container (concept section 9),
// with the port of the engine and the seams of the user's computer.
import { describe, expect, it } from 'vitest';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../names';
import type { Environment } from '../types';
import { scriptCommand } from './containerScripts';
import { EngineError, type DockerEngine, type EngineContainer, type EngineExecOptions, type EngineExecResult } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { removeTokenFlow, TOKEN_REMOVE_TIMEOUT_MS } from './tokenRemoveFlow';

const ENVIRONMENT_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const CONTAINER = 'devenv-acme-api-brave-noether';
const ID = 'c0ffee'.repeat(10) + 'c0ff';

function container(overrides: Partial<EngineContainer> = {}): EngineContainer {
  return {
    id: ID,
    name: CONTAINER,
    state: 'running',
    rawState: 'running',
    labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID },
    image: 'devenv-acme-api-brave-noether:1',
    ...overrides,
  };
}

function ok(exitCode = 0, stderr = ''): EngineExecResult {
  return { exitCode, stdout: '', stderr, timedOut: false };
}

/**
 * An engine that lists `listed` for the label of the environment and answers every exec from `exec`. Review round 1 of
 * plan step 11B1 (A-R1-6): the flow finds the container by the label only (as ContainerAdapter.findContainer did), so the
 * fake records the label and the signal of each call.
 */
function fakeEngine(listed: EngineContainer[], exec: (user: string | undefined, call: number) => EngineExecResult = () => ok()) {
  const execs: { container: string; command: readonly string[]; options: EngineExecOptions }[] = [];
  const lists: { label: string; signal?: AbortSignal }[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    container: async () => {
      throw new Error('The flow reads no container by its name.');
    },
    containers: async (label, signal) => {
      lists.push({ label, signal });
      return label === `${LABEL_ENVIRONMENT_ID}=${ENVIRONMENT_ID}` ? listed : [];
    },
    exec: async (name, command, options = {}) => {
      execs.push({ container: name, command, options });
      return exec(options.user, execs.length);
    },
    stop: async () => {},
    start: async () => {},
  };
  return { engine, execs, lists };
}

function records(environment?: Partial<Environment>) {
  return { get: async () => (environment === undefined ? undefined : ({ id: ENVIRONMENT_ID, ...environment } as Environment)) };
}

const flow = (engine: DockerEngine, more: Partial<Parameters<typeof removeTokenFlow>[0]> = {}) =>
  removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine, records: records(), ...more });

describe('the token removal as a flow of the worker (plan step 11B1)', () => {
  it('runs the script of the registry as root in the running dev container, with its time limit and the signal of the operation', async () => {
    const { engine, execs, lists } = fakeEngine([container()]);
    const controller = new AbortController();
    expect(await flow(engine, { signal: controller.signal })).toEqual({ outcome: 'removed', container: ID.slice(0, 12) });
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatchObject({ container: ID, command: scriptCommand('tokenRemove', []), options: { user: 'root', timeoutMs: TOKEN_REMOVE_TIMEOUT_MS } });
    // Review round 1 of plan step 11B1 (B-R1-12): a cancel of the operation reaches every call to the engine.
    expect(execs[0].options.signal).toBe(controller.signal);
    expect(lists).toEqual([{ label: `${LABEL_ENVIRONMENT_ID}=${ENVIRONMENT_ID}`, signal: controller.signal }]);
  });

  it('runs nothing when no dev container of the environment runs', async () => {
    for (const listed of [
      [],
      [container({ state: 'stopped', rawState: 'exited' })],
      // Review round 1 of plan step 11B1 (B-R1-7): a side service of Docker Compose is not the dev container.
      [container({ id: 'b'.repeat(64), name: `${CONTAINER}-db-1`, labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID, [LABEL_COMPOSE_SERVICE]: 'db' } })],
    ]) {
      const { engine, execs } = fakeEngine(listed);
      expect(await flow(engine)).toEqual({ outcome: 'notRunning' });
      expect(execs).toEqual([]);
    }
  });

  it('prefers the named container, then the newest running dev container of the environment (review round 1, A-R1-6, B-R1-7)', async () => {
    const service = container({ id: 'b'.repeat(64), name: `${CONTAINER}-db-1`, labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID, [LABEL_COMPOSE_SERVICE]: 'db' } });
    const stopped = container({ id: 'd'.repeat(64), state: 'stopped', rawState: 'exited' });
    const named = fakeEngine([service, container({ id: 'a'.repeat(64), name: 'older', created: '2026-10-03T19:00:00Z' }), container()]);
    expect(await flow(named.engine)).toEqual({ outcome: 'removed', container: ID.slice(0, 12) });
    // Plan step 11I (U4, decision of 2026-10-08): changed expectation, every running dev container is emptied, the named
    // one first (before: only the named one).
    expect(named.execs.map((exec) => exec.container)).toEqual([ID, 'a'.repeat(64)]);
    // The recorded name is gone (the container was created again under another one): the newest running one.
    const lines: string[] = [];
    const renamed = fakeEngine([
      service,
      stopped,
      container({ id: 'a'.repeat(64), name: 'older', created: '2026-10-03T19:00:00Z' }),
      container({ id: 'e'.repeat(64), name: 'newer', created: '2026-10-03T20:00:00Z' }),
    ]);
    expect(await flow(renamed.engine, { log: (line) => lines.push(line) })).toEqual({ outcome: 'removed', container: 'e'.repeat(12) });
    // Plan step 11I (U4): changed expectation, the newest running one first, then the others (before: only the newest),
    // and the log names each one that was emptied.
    expect(renamed.execs.map((exec) => exec.container)).toEqual(['e'.repeat(64), 'a'.repeat(64)]);
    expect(lines).toEqual([
      `The container ${CONTAINER} does not run; the running container newer of the environment is used.`,
      'The GitHub token was removed from the container newer.',
      'The GitHub token was removed from the container older.',
    ]);
  });

  it('runs it as the remote user of the environment when root may not (for example --cap-drop ALL), and logs the first try', async () => {
    const lines: string[] = [];
    const { engine, execs } = fakeEngine([container()], (user) => (user === 'root' ? ok(1, 'Operation not permitted') : ok()));
    expect(await flow(engine, { records: records({ remoteUser: 'vscode' }), log: (line) => lines.push(line) })).toEqual({ outcome: 'removed', container: ID.slice(0, 12) });
    expect(execs.map((exec) => exec.options.user)).toEqual(['root', 'vscode']);
    expect(lines).toEqual([`The removal as root failed in the container ${CONTAINER}: Operation not permitted`]);
    // Review round 2 of plan step 11B1 (B-R2-4): the second try has the same time limit and cancel as the first.
    const controller = new AbortController();
    const second = fakeEngine([container()], (user) => (user === 'root' ? ok(1, 'no') : ok()));
    await flow(second.engine, { records: records({ remoteUser: 'vscode' }), signal: controller.signal });
    expect(second.execs[1].options).toMatchObject({ user: 'vscode', timeoutMs: TOKEN_REMOVE_TIMEOUT_MS, signal: controller.signal });
  });

  it('reads the record only for the second try, and a record that cannot be read never stops the first (review round 1, A-R1-7)', async () => {
    let reads = 0;
    const failing = {
      get: async () => {
        reads++;
        throw new Error('the registry file is locked');
      },
    };
    const { engine } = fakeEngine([container()]);
    expect(await flow(engine, { records: failing })).toEqual({ outcome: 'removed', container: ID.slice(0, 12) });
    expect(reads).toBe(0);
    const refused = fakeEngine([container()], () => ok(1, 'root may not'));
    await expect(flow(refused.engine, { records: failing })).rejects.toThrow('root may not');
    expect(reads).toBe(1);
    expect(refused.execs).toHaveLength(1);
  });

  it('fails with the reason when the token could still be there', async () => {
    const asRoot = fakeEngine([container()], () => ok(1, '/run/devenv/github-token could not be removed.'));
    await expect(flow(asRoot.engine)).rejects.toThrow('github-token could not be removed.');
    const both = fakeEngine([container()], (user) => ok(1, user === 'root' ? 'root may not' : 'the user may not'));
    await expect(flow(both.engine, { records: records({ remoteUser: 'vscode' }) })).rejects.toThrow('root may not As vscode: the user may not');
    const slow = fakeEngine([container()], () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
    await expect(flow(slow.engine)).rejects.toThrow('did not end in time');
  });

  it('keeps every line of the reason, clipped (review round 1, A-R1-11)', async () => {
    const twoLines = fakeEngine([container()], () => ok(1, '/run/devenv/github-token could not be removed.\n/run/devenv could not be emptied.\n'));
    await expect(flow(twoLines.engine)).rejects.toThrow('/run/devenv/github-token could not be removed. /run/devenv could not be emptied.');
    const long = fakeEngine([container()], () => ok(1, 'x'.repeat(5000)));
    const error = (await flow(long.engine).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(`${'x'.repeat(1000)}…`);
  });

  it('does not try a remote user that is root, and names the exit code when the script said nothing', async () => {
    for (const remoteUser of ['root', '0', '']) {
      const { engine, execs } = fakeEngine([container()], () => ok(2));
      await expect(flow(engine, { records: records({ remoteUser }) })).rejects.toThrow('exit code 2.');
      expect(execs).toHaveLength(1);
    }
  });

  it('takes a failure of the engine as a failed try, and a container that stopped since as notRunning (review round 2, A-R2-5)', async () => {
    const lines: string[] = [];
    let calls = 0;
    const engine = fakeEngine([container()]).engine;
    engine.exec = async (_c, _cmd, options = {}) => {
      calls++;
      if (options.user === 'root') throw new EngineError('the daemon is busy', 500);
      return ok();
    };
    expect(await flow(engine, { records: records({ remoteUser: 'vscode' }), log: (line) => lines.push(line) })).toMatchObject({ outcome: 'removed' });
    expect(calls).toBe(2);
    expect(lines).toEqual([`The removal as root failed in the container ${CONTAINER}: the daemon is busy`]);
    engine.exec = async () => {
      throw new EngineError(`Container ${ID} is not running`, 409);
    };
    expect(await flow(engine)).toEqual({ outcome: 'notRunning' });
    // A cancel is no failed try: it ends the flow.
    engine.exec = async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    };
    await expect(flow(engine, { records: records({ remoteUser: 'vscode' }) })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('takes the newest by its time, whatever the digits of its fraction (review round 2, A-R2-7)', async () => {
    const { engine, execs } = fakeEngine([
      container({ id: 'a'.repeat(64), name: 'one', created: '2026-10-03T20:00:00.5Z' }),
      // Review round 3 of plan step 11B1 (A-R3-5): sorts before `.5Z` as text, but is older.
      container({ id: 'b'.repeat(64), name: 'two', created: '2026-10-03T20:00:00Z' }),
      container({ id: 'c'.repeat(64), name: 'three' }),
    ]);
    await flow(engine);
    expect(execs[0].container).toBe('a'.repeat(64));
  });

  it('takes the reason from stdout when stderr is empty, and both tries fit in the time limit of the extension (review round 2, B-R2-10, B-R2-11)', async () => {
    const { engine } = fakeEngine([container()], () => ({ exitCode: 1, stdout: '  said on stdout \n', stderr: '', timedOut: false }));
    await expect(flow(engine)).rejects.toThrow(/^said on stdout$/);
    const exact = fakeEngine([container()], () => ok(1, 'y'.repeat(1000)));
    expect(((await flow(exact.engine).catch((e: unknown) => e)) as Error).message).toBe('y'.repeat(1000));
    // The controller allows 60 s for the whole removal (TOKEN_REMOVAL_TIMEOUT_MS of src/vscode/controller.ts).
    expect(2 * TOKEN_REMOVE_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('takes any failure but a cancel as a failed try, and a removed container as notRunning (review round 3, A-R3-2, A-R3-3)', async () => {
    const engine = fakeEngine([container()]).engine;
    let calls = 0;
    engine.exec = async (_c, _cmd, options = {}) => {
      calls++;
      if (options.user === 'root') throw new Error('The connection to the engine closed before the output ended.');
      return ok();
    };
    expect(await flow(engine, { records: records({ remoteUser: 'vscode' }) })).toMatchObject({ outcome: 'removed' });
    expect(calls).toBe(2);
    engine.exec = async () => {
      throw new EngineError(`No such container: ${ID}`, 404);
    };
    expect(await flow(engine)).toEqual({ outcome: 'notRunning' });
    engine.exec = async () => {
      throw new EngineError('No such exec instance', 404);
    };
    await expect(flow(engine)).rejects.toThrow('No such exec instance');
  });

  it('a paused or restarting container is no notRunning: its memory still holds the token (review round 3, B-R3-1, B-R3-2, B-R3-3)', async () => {
    const engine = fakeEngine([container()]).engine;
    for (const error of [
      new EngineError(`Container ${ID} is paused, unpause the container before exec`, 409),
      new EngineError(`Container ${ID} is restarting, wait until the container is running`, 409),
      new EngineError(`Container ${ID} is not running`, 500),
    ]) {
      engine.exec = async () => {
        throw error;
      };
      await expect(flow(engine), error.message).rejects.toThrow(error.message);
    }
    // The container stopped between the two tries.
    engine.exec = async (_c, _cmd, options = {}) => {
      if (options.user === 'root') return ok(1, 'no');
      throw new EngineError(`Container ${ID} is not running`, 409);
    };
    expect(await flow(engine, { records: records({ remoteUser: 'vscode' }) })).toEqual({ outcome: 'notRunning' });
  });
});

describe('the token removal in every running dev container (plan step 11I, U4, decision of 2026-10-08)', () => {
  const other = container({ id: 'b'.repeat(64), name: 'other', created: '2026-10-08T09:00:00Z' });

  it('empties each running dev container, the named one first, each with its two tries; the result names the first', async () => {
    const lines: string[] = [];
    const { engine } = fakeEngine([other, container(), container({ id: 'd'.repeat(64), name: 'stopped', state: 'stopped', rawState: 'exited' })]);
    const tried: string[] = [];
    engine.exec = async (name, _command, options = {}) => {
      tried.push(`${name.slice(0, 2)} ${options.user}`);
      return name === other.id && options.user === 'root' ? ok(1, 'Operation not permitted') : ok();
    };
    expect(await flow(engine, { records: records({ remoteUser: 'vscode' }), log: (line) => lines.push(line) })).toEqual({ outcome: 'removed', container: ID.slice(0, 12) });
    expect(tried).toEqual(['c0 root', 'bb root', 'bb vscode']);
    expect(lines).toEqual([
      `The GitHub token was removed from the container ${CONTAINER}.`,
      'The removal as root failed in the container other: Operation not permitted',
      'The GitHub token was removed from the container other.',
    ]);
  });

  it('a stopped named container never keeps a running other dev container from being emptied', async () => {
    const { engine, execs } = fakeEngine([container({ state: 'stopped', rawState: 'exited' }), other]);
    expect(await flow(engine)).toEqual({ outcome: 'removed', container: 'b'.repeat(12) });
    expect(execs.map((exec) => exec.container)).toEqual([other.id]);
  });

  it('throws after it tried each one when the token could still be in one, and names it', async () => {
    const keeps = (failing: string[]) => {
      const { engine, execs } = fakeEngine([other, container()]);
      engine.exec = async (name, command, options = {}) => {
        execs.push({ container: name, command, options });
        return failing.includes(name) ? ok(1, 'root may not') : ok();
      };
      return { engine, execs };
    };
    // The other keeps it: the named one is emptied all the same, and the message names the other.
    const otherKeeps = keeps([other.id]);
    expect(((await flow(otherKeeps.engine).catch((e: unknown) => e)) as Error).message).toBe('In the container other: root may not');
    expect(otherKeeps.execs.map((exec) => exec.container)).toEqual([ID, other.id]);
    // The named one keeps it (the extension names the container of the request): its reason as before, and the other is
    // tried all the same.
    const namedKeeps = keeps([ID]);
    expect(((await flow(namedKeeps.engine).catch((e: unknown) => e)) as Error).message).toBe('root may not');
    expect(namedKeeps.execs.map((exec) => exec.container)).toEqual([ID, other.id]);
    // Both keep it: both reasons.
    expect(((await flow(keeps([ID, other.id]).engine).catch((e: unknown) => e)) as Error).message).toBe('root may not In the container other: root may not');
  });

  it('is notRunning when each turned out not running, and removed when one was emptied and the other stopped since the list', async () => {
    const { engine } = fakeEngine([other, container()]);
    engine.exec = async (name) => {
      throw new EngineError(`Container ${name} is not running`, 409);
    };
    expect(await flow(engine)).toEqual({ outcome: 'notRunning' });
    engine.exec = async (name) => {
      if (name === ID) throw new EngineError(`Container ${name} is not running`, 409);
      return ok();
    };
    expect(await flow(engine)).toEqual({ outcome: 'removed', container: 'b'.repeat(12) });
  });

  it('reads the record of the remote user once for all containers', async () => {
    let reads = 0;
    const counted = {
      get: async () => {
        reads++;
        return { id: ENVIRONMENT_ID, remoteUser: 'vscode' } as Environment;
      },
    };
    const { engine, execs } = fakeEngine([other, container()], (user) => (user === 'root' ? ok(1, 'no') : ok()));
    expect(await flow(engine, { records: counted })).toEqual({ outcome: 'removed', container: ID.slice(0, 12) });
    expect(execs.map((exec) => `${exec.container.slice(0, 2)} ${exec.options.user}`)).toEqual(['c0 root', 'c0 vscode', 'bb root', 'bb vscode']);
    expect(reads).toBe(1);
  });
});
