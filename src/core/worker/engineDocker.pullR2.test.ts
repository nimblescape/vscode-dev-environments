// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #110 (plan step 11E3b), reviewer B: the probes of the mutation testing of EngineDocker.pullImage
// (the registry whose login a pull sends, the refusal of a login and the pull once more without it, the pull without a
// login).
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import { EngineError, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker, type PullLogins } from './engineDocker';

type Login = Parameters<Parameters<PullLogins>[1]>[0];

/** Logins as registryLogins gives them: the secret slot holds the password only during `use`. */
function logins(answers: Record<string, Login>) {
  const state = { slot: undefined as string | undefined, asked: [] as string[] };
  const run: PullLogins = async (registry, use) => {
    state.asked.push(registry);
    const login = answers[registry];
    state.slot = login?.password;
    try {
      return await use(login);
    } finally {
      state.slot = undefined;
    }
  };
  return { run, state };
}

/** A pull with the login `octo`/`gho_old` of ghcr.io that fails with `failure` while it sends the login. */
async function refusedWith(failure: Error, signal?: AbortSignal): Promise<{ pulls: string[]; result: Promise<void> }> {
  const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_old' } });
  const pulls: string[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    pull: async (_reference, options) => {
      pulls.push(options?.login ? 'with login' : 'anonymous');
      if (options?.login) throw failure;
    },
  };
  const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
  const result = docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {}, ...(signal !== undefined ? { signal } : {}) });
  await result.catch(() => undefined);
  return { pulls, result };
}

describe('EngineDocker.pullImage with the logins of the operation, review round 2 of PR #110 (B)', () => {
  it('the registry of a login: a host with a port in mixed case is not asked for; a tag in mixed case is', async () => {
    const { run, state } = logins({ 'registry-1.docker.io': { username: 'hub', password: 'hub_x' } });
    const pulls: unknown[] = [];
    const engine: DockerEngine = { ...unusedEngine(), pull: async (reference, options) => void pulls.push([reference, options?.login !== undefined]) };
    const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
    // The daemon reads `Registry:5000` as written (no `.`: the port alone names the host).
    await docker.pullImage('Registry:5000/team/app:1', { onOutput: () => {} });
    expect(state.asked).toEqual([]);
    // The case of a tag (or of a digest) is no registry: Docker Hub, with its login.
    await docker.pullImage('node:Latest', { onOutput: () => {} });
    await docker.pullImage(`node@sha256:${'A'.repeat(64)}`, { onOutput: () => {} });
    expect(state.asked).toEqual(['registry-1.docker.io', 'registry-1.docker.io']);
    expect(pulls).toEqual([
      ['Registry:5000/team/app:1', false],
      ['node:Latest', true],
      [`node@sha256:${'A'.repeat(64)}`, true],
    ]);
  });

  it("each of Docker's words for a refused login is one, also in another case; other failures that name a denial are none", async () => {
    for (const message of [
      'Head "https://ghcr.io/v2/o/i/manifests/1": authentication required',
      'Get "https://ghcr.io/v2/": incorrect username or password',
      'Head "https://ghcr.io/v2/o/i/manifests/1": denied: denied',
      'Get "https://r.example/v2/": invalid username/password',
      'Head "https://ghcr.io/v2/o/i/manifests/1": Authentication Required',
    ]) {
      const { pulls, result } = await refusedWith(new EngineError(message, 500));
      await expect(result, message).resolves.toBeUndefined();
      expect(pulls, message).toEqual(['with login', 'anonymous']);
    }
    for (const message of ['permission denied while trying to connect to the Docker daemon socket', 'open /var/lib/docker/tmp: access denied by policy']) {
      const { pulls, result } = await refusedWith(new EngineError(message, 404));
      await expect(result, message).rejects.toThrow(message);
      expect(pulls, message).toEqual(['with login']);
    }
  });

  it('a refused login of a pull whose user cancelled: no pull once more, the failure stays', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new EngineError('unauthorized', 401);
    const { pulls, result } = await refusedWith(failure, controller.signal);
    await expect(result).rejects.toBe(failure);
    expect(pulls).toEqual(['with login']);
  });

  it('a pull without a login keeps its output and its signal', async () => {
    const { run, state } = logins({});
    const seen: (AbortSignal | undefined)[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (_reference, options) => {
        seen.push(options?.signal);
        options?.onLine?.('done');
      },
    };
    const output: string[] = [];
    const docker = new EngineDocker(engine, { ...silentLogger, output: (text: string) => void output.push(`log ${text}`) }, () => undefined, run);
    const signal = new AbortController().signal;
    await docker.pullImage('ghcr.io/o/i:1', { onOutput: (text) => void output.push(text), signal });
    expect(state.asked).toEqual(['ghcr.io']);
    expect(seen).toEqual([signal]);
    expect(output).toEqual(['done\n']);
  });
});
