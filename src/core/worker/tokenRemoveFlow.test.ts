// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1: the first flow that runs in the worker: the token removal of a dev container (concept section 9),
// with the port of the engine and the seams of the user's computer.
import { describe, expect, it } from 'vitest';
import { LABEL_ENVIRONMENT_ID } from '../names';
import type { Environment } from '../types';
import { scriptCommand } from './containerScripts';
import type { DockerEngine, EngineContainer, EngineExecOptions, EngineExecResult } from './dockerEngine';
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

/** An engine that answers the inspect with `found` and every exec from `exec`. */
function fakeEngine(found: EngineContainer | undefined, exec: (user: string | undefined, call: number) => EngineExecResult, listed: EngineContainer[] = []) {
  const execs: { container: string; command: readonly string[]; options: EngineExecOptions }[] = [];
  const engine: DockerEngine = {
    container: async (reference) => (reference === CONTAINER ? found : undefined),
    containers: async () => listed,
    exec: async (name, command, options = {}) => {
      execs.push({ container: name, command, options });
      return exec(options.user, execs.length);
    },
    stop: async () => {},
    start: async () => {},
  };
  return { engine, execs };
}

function records(environment?: Partial<Environment>) {
  return { get: async () => (environment === undefined ? undefined : ({ id: ENVIRONMENT_ID, ...environment } as Environment)) };
}

describe('the token removal as a flow of the worker (plan step 11B1)', () => {
  it('runs the script of the registry as root in the running dev container, with its time limit', async () => {
    const { engine, execs } = fakeEngine(container(), () => ok());
    expect(await removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine, records: records() })).toEqual({
      outcome: 'removed',
      container: ID.slice(0, 12),
    });
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatchObject({ container: ID, command: scriptCommand('tokenRemove', []), options: { user: 'root', timeoutMs: TOKEN_REMOVE_TIMEOUT_MS } });
  });

  it('runs nothing when no container of the environment runs', async () => {
    for (const [found, listed] of [
      [undefined, []],
      [container({ state: 'stopped', rawState: 'exited' }), []],
      // A container of the name that belongs to another environment, and no container of this one.
      [container({ labels: { [LABEL_ENVIRONMENT_ID]: 'another' } }), []],
    ] as const) {
      const { engine, execs } = fakeEngine(found, () => ok(), [...listed]);
      expect(await removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine, records: records() })).toEqual({ outcome: 'notRunning' });
      expect(execs).toEqual([]);
    }
  });

  it('finds the container by the label of the environment when the name belongs to another one', async () => {
    const other = container({ labels: { [LABEL_ENVIRONMENT_ID]: 'another' } });
    const { engine, execs } = fakeEngine(other, () => ok(), [container({ id: 'a'.repeat(64) })]);
    expect(await removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine, records: records() })).toEqual({
      outcome: 'removed',
      container: 'a'.repeat(12),
    });
    expect(execs[0].container).toBe('a'.repeat(64));
  });

  it('runs it as the remote user of the environment when root may not (for example --cap-drop ALL)', async () => {
    const { engine, execs } = fakeEngine(container(), (user) => (user === 'root' ? ok(1, 'Operation not permitted') : ok()));
    expect(await removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine, records: records({ remoteUser: 'vscode' }) })).toEqual({
      outcome: 'removed',
      container: ID.slice(0, 12),
    });
    expect(execs.map((exec) => exec.options.user)).toEqual(['root', 'vscode']);
  });

  it('fails with the reason when the token could still be there', async () => {
    const asRoot = fakeEngine(container(), () => ok(1, '/run/devenv/github-token could not be removed.'));
    await expect(removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine: asRoot.engine, records: records() })).rejects.toThrow(
      'github-token could not be removed.',
    );
    const both = fakeEngine(container(), (user) => ok(1, user === 'root' ? 'root may not' : 'the user may not'));
    await expect(
      removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine: both.engine, records: records({ remoteUser: 'vscode' }) }),
    ).rejects.toThrow('root may not As vscode: the user may not');
    const slow = fakeEngine(container(), () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
    await expect(removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine: slow.engine, records: records() })).rejects.toThrow(
      'did not end in time',
    );
  });

  it('does not try a remote user that is root, and names the exit code when the script said nothing', async () => {
    for (const remoteUser of ['root', '0', '']) {
      const { engine, execs } = fakeEngine(container(), () => ok(2));
      await expect(
        removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine, records: records({ remoteUser }) }),
      ).rejects.toThrow('exit code 2.');
      expect(execs).toHaveLength(1);
    }
  });
});
