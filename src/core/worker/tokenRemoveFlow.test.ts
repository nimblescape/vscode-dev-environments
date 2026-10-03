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
    expect(named.execs.map((exec) => exec.container)).toEqual([ID]);
    // The recorded name is gone (the container was created again under another one): the newest running one.
    const lines: string[] = [];
    const renamed = fakeEngine([
      service,
      stopped,
      container({ id: 'a'.repeat(64), name: 'older', created: '2026-10-03T19:00:00Z' }),
      container({ id: 'e'.repeat(64), name: 'newer', created: '2026-10-03T20:00:00Z' }),
    ]);
    expect(await flow(renamed.engine, { log: (line) => lines.push(line) })).toEqual({ outcome: 'removed', container: 'e'.repeat(12) });
    expect(renamed.execs.map((exec) => exec.container)).toEqual(['e'.repeat(64)]);
    expect(lines).toEqual([`The container ${CONTAINER} does not run; the running container newer of the environment is used.`]);
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
      container({ id: 'a'.repeat(64), name: 'one', created: '2026-10-03T20:00:00.9Z' }),
      container({ id: 'b'.repeat(64), name: 'two', created: '2026-10-03T20:00:00.10Z' }),
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
});
