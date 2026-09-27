// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 7, PR 2: the Session Monitor on a remote Docker host from the side of the pipeline (ensured right after the helper
// image, before the container is created or started; the record of this computer removed at Delete), and the flag of
// Close and Keep Running (cleared when a window connects, and by Stop).
import { afterEach, describe, expect, it } from 'vitest';
import { abortError } from '../ports';
import type { DockerTarget } from '../docker/dockerHost';
import type { EnvironmentRemoteMonitor, RepositoryTarget } from './environmentService';
import { ENV_ID, REPO, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

interface Setup {
  h: Harness;
  calls: string[];
}

function setup(
  target: Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>,
  behavior: {
    ensure?: () => Promise<unknown>;
    forget?: () => Promise<void>;
    heartbeat?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
  } = {},
): Setup {
  const calls: string[] = [];
  const remoteMonitor: EnvironmentRemoteMonitor = {
    ensure: async (host, helperTag) => {
      calls.push(`ensure ${host} ${helperTag}`);
      // In the order of the helper calls.
      created.helper.calls.push('remote monitor');
      return behavior.ensure?.();
    },
    heartbeat: async (host, environmentId, keepRunning) => {
      calls.push(`heartbeat ${host} ${environmentId} ${keepRunning}`);
      created.helper.calls.push('first heartbeat');
      return (await behavior.heartbeat?.()) ?? { ok: true };
    },
    forget: async (host, environmentId) => {
      calls.push(`forget ${host} ${environmentId}`);
      return behavior.forget?.();
    },
  };
  const created = createHarness({ dockerTarget: async () => target, remoteMonitor });
  h = created;
  return { h: created, calls };
}

const REMOTE = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' } as const;
const LOCAL = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' } as const;

describe('the Session Monitor on a remote host in the open pipeline', () => {
  it('a first open on a remote host ensures it once, with the helper tag, after the helper image and before up', async () => {
    const { h, calls } = setup(REMOTE);
    const result = await h.service.open(TARGET, { progress: h.progress });
    // Then the first heartbeat of this computer for the new environment, not kept.
    expect(calls).toEqual(['ensure build-box devenv-helper:test', `heartbeat build-box ${result.environment.id} false`]);
    const order = h.helper.calls;
    expect(order.indexOf('ensureImage')).toBeLessThan(order.indexOf('remote monitor'));
    expect(order.indexOf('remote monitor')).toBeLessThan(order.indexOf('first heartbeat'));
    const up = order.findIndex((call) => call.startsWith('up '));
    expect(up).toBeGreaterThan(order.indexOf('first heartbeat'));
  });

  it('an open of a stopped environment on a remote host ensures it before the container starts', async () => {
    const { h, calls } = setup(REMOTE);
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(calls).toEqual(['ensure build-box devenv-helper:test', `heartbeat build-box ${ENV_ID} false`]);
    // The stopped container is started with `up` of the Dev Container CLI.
    const up = h.helper.calls.findIndex((call) => call.startsWith('up '));
    expect(up).toBeGreaterThan(h.helper.calls.indexOf('first heartbeat'));
    expect(h.helper.calls.indexOf('remote monitor')).toBeGreaterThan(h.helper.calls.indexOf('ensureImage'));
  });

  it('sends the keep-running flag of the usual rules in the first heartbeat', async () => {
    const { h, calls } = setup(REMOTE);
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box', keepRunning: true } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} true`);
  });

  it('sends the flag for every environment while stopOnClose is off', async () => {
    const { h, calls } = setup(REMOTE);
    h.settings.stopOnClose = false;
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} true`);
  });

  it.each<[string, () => Promise<{ ok: true } | { ok: false; detail: string }>]>([
    ['fails', async () => ({ ok: false, detail: 'No such container: devenv-session-monitor' })],
    ['throws', async () => Promise.reject(new Error('Docker Desktop is not installed.'))],
  ])('a first heartbeat that %s is a warning, and the open goes on', async (_name, heartbeat) => {
    const { h } = setup(REMOTE, { heartbeat });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(h.helper.calls.some((call) => call.startsWith('up '))).toBe(true);
    expect(h.logger.warnings.some((line) => line.includes('The first heartbeat for') && line.includes('build-box'))).toBe(true);
  });

  it('sends the first heartbeat also when the monitor could not be ensured', async () => {
    const { h, calls } = setup(REMOTE, { ensure: async () => Promise.reject(new Error('unreachable')) });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} false`);
  });

  it('never on the local Docker', async () => {
    const { h, calls } = setup(LOCAL);
    await h.service.open(TARGET, { progress: h.progress });
    expect(calls).toEqual([]);
  });

  it('a failure does not fail the open', async () => {
    const { h } = setup(REMOTE, { ensure: async () => Promise.reject(new Error('ssh: connect to host build-box: timed out')) });
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.environment.dockerHost).toBe('build-box');
    expect(h.logger.warnings.some((line) => line.includes('The Session Monitor on build-box could not be started'))).toBe(true);
  });

  it('a cancellation during it cancels the open', async () => {
    const controller = new AbortController();
    const { h } = setup(REMOTE, {
      ensure: async () => {
        controller.abort();
        throw abortError();
      },
    });
    await expect(h.service.open(TARGET, { progress: h.progress, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('Close and Keep Running in the registry', () => {
  it('an open clears keepRunningOnce (a window connects again) and keeps keepRunning', async () => {
    const { h } = setup(LOCAL);
    await seedEnvironment(h, { container: 'running', extra: { keepRunningOnce: true, keepRunning: true } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    const entry = await h.registry.get(ENV_ID);
    expect(entry).not.toHaveProperty('keepRunningOnce');
    expect(entry?.keepRunning).toBe(true);
  });

  it('Stop clears keepRunningOnce, also when the container does not run', async () => {
    const { h } = setup(LOCAL);
    await seedEnvironment(h, { container: 'stopped', extra: { keepRunningOnce: true } });
    await h.service.stop(ENV_ID);
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
  });
});

describe('Delete on a remote host', () => {
  it('removes the record of this computer on the remote monitor', async () => {
    const { h, calls } = setup(REMOTE);
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    expect(calls).toContain(`forget build-box ${ENV_ID}`);
  });

  it('a failure of the removal is only logged', async () => {
    const { h } = setup(REMOTE, { forget: async () => Promise.reject(new Error('unreachable')) });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    expect(h.logger.warnings.some((line) => line.includes('remove the heartbeat record on the remote host'))).toBe(true);
  });

  it('nothing for an environment of the local Docker', async () => {
    const { h, calls } = setup(LOCAL);
    await seedEnvironment(h, { container: 'stopped' });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(calls.filter((call) => call.startsWith('forget'))).toEqual([]);
  });
});
