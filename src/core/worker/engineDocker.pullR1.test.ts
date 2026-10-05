// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #110 (plan step 11E3b), reviewer B: the probes of the mutation testing of EngineDocker.pullImage
// with the logins of the operation (the user of a login without a user name, the output and the signal of a pull that
// asked for its login).
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import type { DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker, type PullLogins } from './engineDocker';

type Login = Parameters<Parameters<PullLogins>[1]>[0];

/** Logins that answer `login` and record the signal of each ask; the secret slot holds its password during `use`. */
function loginsOf(login: Login) {
  const state = { slot: undefined as string | undefined, signals: [] as (AbortSignal | undefined)[] };
  const run: PullLogins = async (_registry, use, signal) => {
    state.signals.push(signal);
    state.slot = login?.password;
    try {
      return await use(login);
    } finally {
      state.slot = undefined;
    }
  };
  return { run, state };
}

describe('EngineDocker.pullImage with the logins of the operation, review round 1 of PR #110 (B)', () => {
  it('a login without a user name and without an identity token pulls with an empty user name (as hostRegistryCredentials)', async () => {
    const { run, state } = loginsOf({ password: 'pw' });
    const logins: unknown[] = [];
    const engine: DockerEngine = { ...unusedEngine(), pull: async (_reference, options) => void logins.push(options?.login) };
    const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
    await docker.pullImage('r.example/i:1', { onOutput: () => {} });
    expect(logins).toEqual([{ serveraddress: 'r.example', username: '', secretName: SECRET_REGISTRY }]);
  });

  it('a pull that asked for its login keeps its output and its signal; the ask gets the signal too', async () => {
    const { run, state } = loginsOf({ username: 'octo', password: 'pw' });
    const signals: (AbortSignal | undefined)[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (_reference, options) => {
        signals.push(options?.signal);
        options?.onLine?.('Pulling fs layer');
      },
    };
    const output: string[] = [];
    const docker = new EngineDocker(engine, { ...silentLogger, output: (text: string) => void output.push(`log ${text}`) }, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
    const controller = new AbortController();
    await docker.pullImage('ghcr.io/o/i:1', { onOutput: (text) => void output.push(text), signal: controller.signal });
    expect(output).toEqual(['Pulling fs layer\n']);
    expect(signals).toEqual([controller.signal]);
    expect(state.signals).toEqual([controller.signal]);
  });

  it('without a login the pull is anonymous and still keeps its output and its signal', async () => {
    const { run, state } = loginsOf(undefined);
    const pulls: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (_reference, options) => {
        pulls.push([options?.login, options?.signal]);
        options?.onLine?.('Digest: sha256:x');
      },
    };
    const output: string[] = [];
    const docker = new EngineDocker(engine, silentLogger, () => undefined, run);
    const controller = new AbortController();
    await docker.pullImage('ghcr.io/o/i:1', { onOutput: (text) => void output.push(text), signal: controller.signal });
    expect(pulls).toEqual([[undefined, controller.signal]]);
    expect(output).toEqual(['Digest: sha256:x\n']);
    expect(state.signals).toEqual([controller.signal]);
  });
});
