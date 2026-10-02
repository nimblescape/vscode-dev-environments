// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 7, PR 2: the Session Monitor container from the side of the pipeline (ensured right after the helper image, before
// the container is created or started; the record of this computer removed at Delete), and the flag of Close and Keep
// Running (cleared when a window connects, and by Stop). Plan step 8, PR A: on every engine, local and remote, and an open
// is refused when the monitor cannot be ensured (user decision Q3 of 2026-10-02).
import { afterEach, describe, expect, it } from 'vitest';
import { abortError } from '../ports';
import type { DockerTarget } from '../docker/dockerHost';
import type { EnvironmentSessionMonitor, RepositoryTarget } from './environmentService';
import { ENV_ID, REPO, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness | undefined;
/** The seq of each first heartbeat (review round 2 of PR #39, L1). */
let seqs: number[] = [];
/** The signal of each ensure (review round 1 of PR #85, E10). */
let ensureSignals: Array<AbortSignal | undefined> = [];
/** Review round 1 of PR #86, A-R1-1: for each ensure, the number of `up` and run-user-commands before it. */
let ensureAt: Array<{ ups: number; userCommands: number }> = [];

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
    ensure?: (index: number) => Promise<unknown>;
    forget?: () => Promise<void>;
    heartbeat?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
  } = {},
): Setup {
  const calls: string[] = [];
  seqs = [];
  ensureSignals = [];
  ensureAt = [];
  const sessionMonitor: EnvironmentSessionMonitor = {
    ensure: async (target, helperTag, signal, helperImage) => {
      ensureSignals.push(signal);
      ensureAt.push({ ups: created.helper.ups.length, userCommands: created.helper.userCommandRuns.length });
      const host = engineOf(target);
      // Review round 1 of PR #64 (S1), review round 3 of PR #64 (P2): the image ID of the helper image of the open.
      calls.push(`ensure ${host} ${helperTag}` + (helperImage !== undefined ? ` image ${helperImage}` : ''));
      // In the order of the helper calls.
      created.helper.calls.push('remote monitor');
      return behavior.ensure?.(ensureSignals.length - 1);
    },
    heartbeat: async (target, environmentId, keepRunning, seq) => {
      const host = engineOf(target);
      calls.push(`heartbeat ${host} ${environmentId} ${keepRunning}`);
      seqs.push(seq);
      created.helper.calls.push('first heartbeat');
      return (await behavior.heartbeat?.()) ?? { ok: true };
    },
    forget: async (target, environmentId) => {
      const host = engineOf(target);
      calls.push(`forget ${host} ${environmentId}`);
      return behavior.forget?.();
    },
  };
  const created = createHarness({ dockerTarget: async () => target, sessionMonitor });
  h = created;
  return { h: created, calls };
}

/** The engine in the calls: the host, or `local` for the local Docker. */
function engineOf(target: Pick<DockerTarget, 'kind' | 'host'>): string {
  return target.kind === 'local' ? 'local' : target.host;
}

const REMOTE = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' } as const;
const LOCAL = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' } as const;

describe('the Session Monitor in the open pipeline', () => {
  it('a first open on a remote host ensures it once, with the helper tag, after the helper image and before up', async () => {
    const { h, calls } = setup(REMOTE);
    const result = await h.service.open(TARGET, { progress: h.progress });
    // Then the first heartbeat of this computer for the new environment, not kept. Changed expectation (review round 3 of
    // PR #64, P2): the monitor runs the image ID that the open pinned for the current tag too; the label keeps the tag.
    // Changed expectation, review round 1 of PR #86, A-R1-1: ensured again right after `up` started the container (was:
    // the ensure and the first heartbeat only).
    const ensure = `ensure build-box devenv-helper:test image ${h.helper.currentHelperImageId}`;
    expect(calls).toEqual([ensure, `heartbeat build-box ${result.environment.id} false`, ensure]);
    const order = h.helper.calls;
    expect(order.indexOf('ensureImage')).toBeLessThan(order.indexOf('remote monitor'));
    expect(order.indexOf('remote monitor')).toBeLessThan(order.indexOf('first heartbeat'));
    const up = order.findIndex((call) => call.startsWith('up '));
    expect(up).toBeGreaterThan(order.indexOf('first heartbeat'));
    expect(order.lastIndexOf('remote monitor')).toBeGreaterThan(up);
  });

  it('an open of a stopped environment on a remote host ensures it before the container starts', async () => {
    const { h, calls } = setup(REMOTE);
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    // Changed expectation (review round 3 of PR #64, P2): the monitor runs the image ID that the open pinned.
    // Changed expectation, review round 1 of PR #86, A-R1-1: ensured again right after `up` started the container.
    const ensure = `ensure build-box devenv-helper:test image ${h.helper.currentHelperImageId}`;
    expect(calls).toEqual([ensure, `heartbeat build-box ${ENV_ID} false`, ensure]);
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

  it('reads the flags from the registry again, with seq = the time before that read', async () => {
    const { h, calls } = setup(REMOTE);
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(seqs).toHaveLength(1);
    expect(Number.isSafeInteger(seqs[0]) && seqs[0] > 0).toBe(true);
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} false`);
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

  // Changed expectation, plan step 8 PR A (user decision Q3 of 2026-10-02): a monitor that cannot be ensured refuses the
  // open, so no first heartbeat is sent and nothing is started (before: the heartbeat was sent and the open went on).
  it('refuses the open of a stopped environment when the monitor could not be ensured, before anything starts', async () => {
    const { h, calls } = setup(REMOTE, { ensure: async () => Promise.reject(new Error('unreachable')) });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'sessionMonitorFailed' });
    expect(calls.filter((call) => call.startsWith('heartbeat'))).toEqual([]);
    expect(h.helper.calls.some((call) => call.startsWith('up '))).toBe(false);
  });

  // Changed expectation, plan step 8 PR A: the local Docker gets the same monitor (before: never on the local Docker).
  it('a first open on the local Docker ensures it once, then sends the first heartbeat, before up', async () => {
    const { h, calls } = setup(LOCAL);
    const result = await h.service.open(TARGET, { progress: h.progress });
    // Changed expectation, review round 1 of PR #86, A-R1-1: ensured again right after `up` started the container.
    const ensure = `ensure local devenv-helper:test image ${h.helper.currentHelperImageId}`;
    expect(calls).toEqual([ensure, `heartbeat local ${result.environment.id} false`, ensure]);
    const order = h.helper.calls;
    expect(order.indexOf('ensureImage')).toBeLessThan(order.indexOf('remote monitor'));
    expect(order.findIndex((call) => call.startsWith('up '))).toBeGreaterThan(order.indexOf('first heartbeat'));
  });

  // Changed expectation, plan step 8 PR A (Q3): a failure fails the open, with a message that names the cause.
  it('a failure refuses the open with the cause', async () => {
    const { h } = setup(REMOTE, { ensure: async () => Promise.reject(new Error('ssh: connect to host build-box: timed out')) });
    const error = await h.service.open(TARGET, { progress: h.progress }).then(
      () => undefined,
      (failure: unknown) => failure as { code?: string; message?: string; detail?: string },
    );
    expect(error?.code).toBe('sessionMonitorFailed');
    expect(error?.message).toContain('the Session Monitor on the Docker engine could not be started (ssh: connect to host build-box: timed out)');
    expect(h.logger.warnings.some((line) => line.includes('The Session Monitor on build-box could not be started'))).toBe(true);
    expect(h.helper.calls.some((call) => call.startsWith('up '))).toBe(false);
  });

  // Plan step 8, PR A (Q3): also on the local Docker, and also a running container is not opened as it is.
  it('refuses the open on the local Docker, also of a running container', async () => {
    const { h } = setup(LOCAL, { ensure: async () => Promise.reject(new Error('docker run failed: image not found')) });
    await seedEnvironment(h, { container: 'running' });
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'sessionMonitorFailed' });
    expect(h.logger.warnings.some((line) => line.includes('The Session Monitor on the local Docker could not be started'))).toBe(true);
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

  // Review round 1 of PR #85 (mutants E06, E10): the ensure gets the signal of the open, and a cancellation in it is a
  // cancellation, never the refusal of a monitor that could not be started.
  it('passes the signal of the open to the ensure; a cancellation in it is not reported as a refusal', async () => {
    const controller = new AbortController();
    const { h } = setup(REMOTE, {
      ensure: async () => {
        controller.abort();
        throw abortError();
      },
    });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress, signal: controller.signal })).rejects.not.toMatchObject({ code: 'sessionMonitorFailed' });
    expect(ensureSignals).toHaveLength(1);
    expect(ensureSignals[0]?.aborted).toBe(true);
    expect(h.logger.warnings.some((line) => line.includes('could not be started'))).toBe(false);
  });

  // Review round 1 of PR #85 (mutants E12, E17): the first heartbeat takes the flags of the entry as it is now (read
  // again), with seq = the time before that read.
  it('the first heartbeat reads the entry again (a flag set meanwhile counts), with seq taken before the read', async () => {
    const readAt: number[] = [];
    const { h, calls } = setup(REMOTE, {
      ensure: async () => {
        // Another window sets Keep Running When Closed while this open runs.
        await h.registry.updateEnvironment(ENV_ID, (entry) => {
          entry.keepRunning = true;
        });
        const get = h.registry.get.bind(h.registry);
        h.registry.get = async (id: string) => {
          readAt.push(h.clock.now());
          return get(id);
        };
      },
    });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(calls).toContain(`heartbeat build-box ${ENV_ID} true`);
    expect(seqs).toHaveLength(1);
    expect(readAt.length).toBeGreaterThan(0);
    expect(seqs[0]).toBeLessThan(readAt[0]);
  });
});

// Review round 1 of PR #86, A-R1-1: the monitor may have exited when idle (Q5) during the clone and the build; the open
// ensures it again right after `up` created or started the container, before the lifecycle commands, once per run. A
// failure there does not refuse the open (the container runs already): it is logged, and the user is warned.
describe('the Session Monitor again after the container started (review round 1 of PR #86, A-R1-1)', () => {
  it('ensures it again after `up` and before the lifecycle commands, with the same image and the signal of the open', async () => {
    const { h, calls } = setup(REMOTE);
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    const controller = new AbortController();
    await h.service.openEnvironment(ENV_ID, { progress: h.progress, signal: controller.signal });
    expect(calls.filter((call) => call.startsWith('ensure'))).toHaveLength(2);
    expect(ensureAt).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(ensureSignals[1]).toBe(ensureSignals[0]);
    expect(ensureSignals[1]).toBeDefined();
  });

  it('a first open (clone, build, create) ensures it again after the container was created', async () => {
    const { h } = setup(LOCAL);
    await h.service.open(TARGET, { progress: h.progress });
    expect(ensureAt).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
  });

  it('a running container that opens as it is: the first ensure only (it ran all along)', async () => {
    const { h } = setup(LOCAL);
    await seedEnvironment(h, { container: 'running' });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(ensureAt).toEqual([{ ups: 0, userCommands: 0 }]);
  });

  it('a failure after the start is logged and shown as a warning, and the open goes on', async () => {
    const { h } = setup(REMOTE, { ensure: async (index) => (index === 1 ? Promise.reject(new Error('ssh: connect to host build-box: timed out')) : undefined) });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    const result = await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(result.environment.id).toBe(ENV_ID);
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(h.logger.warnings.some((line) => line.includes(`The Session Monitor on build-box could not be started again after the container of ${REPO} started`))).toBe(true);
    expect(h.ui.warnings).toContainEqual(expect.stringContaining('The Session Monitor on the Docker host build-box could not be started after the container of'));
    expect(h.ui.warnings).toContainEqual(expect.stringContaining('(ssh: connect to host build-box: timed out)'));
  });

  it('a cancellation in it cancels the open, and is not reported as a failure', async () => {
    const controller = new AbortController();
    const { h } = setup(REMOTE, {
      ensure: async (index) => {
        if (index !== 1) return;
        controller.abort();
        throw abortError();
      },
    });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.ui.warnings.some((line) => line.includes('could not be started after the container'))).toBe(false);
  });

  it('a failed `up` that may have left a container running ensures it too, and keeps the error of `up`', async () => {
    const { h } = setup(REMOTE);
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    h.helper.upError = () => new Error('devcontainer up failed: port is already allocated');
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'startFailed' });
    expect(ensureAt).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
  });

  // Third verifier: lifecycle commands that fail leave the container running ("It is left running"); the monitor was
  // ensured before them, so it exists to stop the container after the limit of its record.
  it('lifecycle commands that cannot run come after it, and a failed second ensure keeps the error of the open', async () => {
    const { h } = setup(REMOTE, { ensure: async (index) => (index === 1 ? Promise.reject(new Error('unreachable')) : undefined) });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    h.helper.userCommandsError = new Error('devcontainer run-user-commands failed');
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'startFailed' });
    expect(ensureAt).toEqual([
      { ups: 0, userCommands: 0 },
      { ups: 1, userCommands: 0 },
    ]);
    expect(h.ui.warnings).toContainEqual(expect.stringContaining('could not be started after the container of'));
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

describe('Delete and the record of this computer', () => {
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
    // Changed expectation, plan step 8 PR A: the text names the Session Monitor of any engine.
    expect(h.logger.warnings.some((line) => line.includes('remove the heartbeat record from the Session Monitor'))).toBe(true);
  });

  // Changed expectation, plan step 8 PR A: on the local Docker too (before: nothing for an environment of the local Docker).
  it('removes the record of this computer on the local Docker too', async () => {
    const { h, calls } = setup(LOCAL);
    await seedEnvironment(h, { container: 'stopped' });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    expect(calls.filter((call) => call.startsWith('forget'))).toEqual([`forget local ${ENV_ID}`]);
  });
});

// User requests 2026-09-28: the image list for the image maintenance of the monitor (plan step 8, PR A: on every engine).
describe('the image list for the Session Monitor in the open pipeline', () => {
  function withImages(target: Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>, images: (host: string) => Promise<void>) {
    const calls: string[] = [];
    const sessionMonitor: EnvironmentSessionMonitor = {
      ensure: async (target) => {
        calls.push(`ensure ${engineOf(target)}`);
      },
      heartbeat: async (target) => {
        calls.push(`heartbeat ${engineOf(target)}`);
        return { ok: true };
      },
      forget: async () => {},
      images: async (target) => {
        calls.push(`images ${engineOf(target)}`);
        return images(engineOf(target));
      },
    };
    const created = createHarness({ dockerTarget: async () => target, sessionMonitor });
    h = created;
    return { h: created, calls };
  }

  it('sends it after the monitor is ensured and before the first heartbeat, on every engine', async () => {
    const remote = withImages(REMOTE, async () => {});
    await seedEnvironment(remote.h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await remote.h.service.openEnvironment(ENV_ID, { progress: remote.h.progress });
    // Changed expectation, review round 1 of PR #86, A-R1-1: the monitor is ensured again after `up` (no image list then).
    expect(remote.calls).toEqual(['ensure build-box', 'images build-box', 'heartbeat build-box', 'ensure build-box']);
    const local = withImages(LOCAL, async () => {});
    await seedEnvironment(local.h, { container: 'stopped' });
    await local.h.service.openEnvironment(ENV_ID, { progress: local.h.progress });
    // Changed expectation, plan step 8 PR A: on the local Docker too (before: nothing there).
    // Changed expectation, review round 1 of PR #86, A-R1-1: and ensured again after `up`.
    expect(local.calls).toEqual(['ensure local', 'images local', 'heartbeat local', 'ensure local']);
  });

  it('a failure is a warning, and the open goes on', async () => {
    const { h, calls } = withImages(REMOTE, async () => Promise.reject(new Error('GitHub answered HTTP 403')));
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(calls).toContain('heartbeat build-box');
    expect(h.logger.warnings).toContain('The image list for the Session Monitor on build-box could not be sent: GitHub answered HTTP 403');
  });
});
