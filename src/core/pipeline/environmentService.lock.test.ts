// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: Stop and Delete under the lock of the environment on the Docker host (EnvironmentService
// withEnvironmentLock). User decision D1: the helper image is ensured (built when missing) and the worker opened before;
// when that fails, the operation is refused and nothing is stopped or removed. User decision D2: Stop and Delete only.
// User decision D3: a lock held elsewhere is refused after the wait, with its message. The busy mark comes first, then
// the lock; both are released in `finally`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentLockError, holdsEnvironmentLock, runWithEnvironmentLock, type HeldEnvironmentLock } from '../docker/environmentLock';
import { CommandError, UserFacingError } from '../errors';
import { Messages } from '../messages';
import { ENVIRONMENT_LOCK_WAIT_SECONDS, PipelineTexts } from './environmentService';
import { ENV_ID, REPO, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';

let h: Harness;
/** What happened, in order: `ensureImage`, `build`, `lock <id> <wait>`, `busy=<operation>` at the lock, `docker …`, `release`. */
let events: string[];
/** How the next lock ends: held, or an error. */
let lockOutcome: Error | undefined;
let releases: number;

function heldLock(environmentId: string): HeldEnvironmentLock {
  return {
    environmentId,
    lost: new Promise(() => {}),
    docker: async () => {
      throw new Error('The fake Docker of the service runs no call through the worker.');
    },
    release: async () => {
      releases++;
      events.push('release');
    },
  };
}

beforeEach(() => {
  events = [];
  lockOutcome = undefined;
  releases = 0;
  h = createHarness({
    environmentLock: async (environmentId, waitSeconds) => {
      events.push(`lock ${environmentId} ${waitSeconds}`);
      const busy = (await h.registry.get(environmentId))?.busy;
      events.push(`busy=${busy?.operation ?? 'none'}`);
      if (lockOutcome) throw lockOutcome;
      return heldLock(environmentId);
    },
  });
  const ensure = h.helper.ensureImageUse.bind(h.helper);
  h.helper.ensureImageUse = async (options) => {
    events.push('ensureImage');
    return ensure(options);
  };
  const remove = h.docker.removeContainer.bind(h.docker);
  h.docker.removeContainer = async (ref) => {
    events.push(`docker rm${holdsEnvironmentLock(ENV_ID) ? ' (locked)' : ''}`);
    return remove(ref);
  };
  const stop = h.docker.stopContainer.bind(h.docker);
  h.docker.stopContainer = async (ref) => {
    events.push(`docker stop${holdsEnvironmentLock(ENV_ID) ? ' (locked)' : ''}`);
    return stop(ref);
  };
});

afterEach(() => {
  h?.cleanup();
});

function deleteOptions() {
  return { progress: h.progress, additionalVolumesToRemove: [] as string[] };
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

describe('Delete under the environment lock (plan step 5, PR B)', () => {
  it('takes the busy mark first, then the lock (10 s wait), removes under the lock, and releases both', async () => {
    await seedEnvironment(h, { container: 'running' });
    await h.service.delete(ENV_ID, deleteOptions());
    expect(events.slice(0, 5)).toEqual(['ensureImage', `lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`, 'busy=delete', 'docker stop (locked)', 'docker rm (locked)']);
    expect(events.at(-1)).toBe('release');
    expect(ENVIRONMENT_LOCK_WAIT_SECONDS).toBe(10);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    expect(releases).toBe(1);
  });

  it('user decision D3: a lock held elsewhere refuses with its message, clears the busy mark, and removes nothing', async () => {
    await seedEnvironment(h, { container: 'running' });
    lockOutcome = new EnvironmentLockError('busy', 'The lock stayed held by another holder for 10 s.');
    const error = await rejection(h.service.delete(ENV_ID, deleteOptions()));
    expect(error.message).toBe(PipelineTexts.environmentLockBusy(REPO));
    expect(error.message).toBe(`${REPO} is busy with an operation from another window or computer; try again in a moment.`);
    expect(h.docker.log).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    expect(h.docker.volumes.size).toBeGreaterThan(0);
  });

  it('user decision D1: the worker cannot be opened: refused with the cause, nothing removed, the busy mark cleared', async () => {
    await seedEnvironment(h, { container: 'running' });
    lockOutcome = new EnvironmentLockError('unavailable', 'The helper channel to build-box was closed: it reaches another Docker engine.');
    const error = await rejection(h.service.delete(ENV_ID, deleteOptions()));
    expect(error.message).toBe(PipelineTexts.environmentLockUnavailable(REPO, lockOutcome.message));
    expect(error.message).toContain('reaches another Docker engine');
    expect(h.docker.log).toEqual([]);
    expect(await h.registry.get(ENV_ID)).toMatchObject({ id: ENV_ID });
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('user decision D1: the helper image cannot be built: refused with the cause before the lock, nothing removed', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'pull access denied for node');
    const error = await rejection(h.service.delete(ENV_ID, deleteOptions()));
    expect(error.message).toBe(PipelineTexts.environmentLockUnavailable(REPO, `${Messages.helperFailed} pull access denied for node`));
    expect(events).toEqual(['ensureImage']);
    expect(h.docker.log).toEqual([]);
    expect(await h.registry.get(ENV_ID)).toMatchObject({ id: ENV_ID });
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('user decision D1: a missing helper image is built first, then the lock is taken and the delete goes on', async () => {
    await seedEnvironment(h, { container: 'running' });
    let imagePresent = false;
    const ensure = h.helper.ensureImageUse.bind(h.helper);
    h.helper.ensureImageUse = async (options) => {
      if (!imagePresent) {
        events.push('build');
        imagePresent = true;
      }
      return ensure(options);
    };
    await h.service.delete(ENV_ID, deleteOptions());
    expect(events.slice(0, 3)).toEqual(['build', 'ensureImage', `lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`]);
    expect(events).toContain('docker rm (locked)');
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });

  it('releases the lock and the busy mark when a removal fails under the lock', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.docker.removeContainer = async () => {
      events.push('docker rm fails');
      throw new CommandError('docker rm', 1, '', 'Error response from daemon: device or resource busy');
    };
    await expect(h.service.delete(ENV_ID, deleteOptions())).rejects.toThrow(/resource busy/);
    expect(events.slice(-2)).toEqual(['docker rm fails', 'release']);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('is re-entrant: within a held lock of the environment it takes no second one', async () => {
    await seedEnvironment(h, { container: 'running' });
    await runWithEnvironmentLock(heldLock(ENV_ID), () => h.service.delete(ENV_ID, deleteOptions()));
    expect(events.filter((event) => event.startsWith('lock') || event === 'ensureImage')).toEqual([]);
    expect(events).toContain('docker rm (locked)');
    // Only the release of the outer holder (the test) counts; the delete released nothing.
    expect(releases).toBe(0);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });
});

describe('Stop under the environment lock (plan step 5, PR B)', () => {
  it('stops under the lock and releases it', async () => {
    await seedEnvironment(h, { container: 'running' });
    await h.service.stop(ENV_ID);
    expect(events).toEqual(['ensureImage', `lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`, 'busy=none', 'docker stop (locked)', 'release']);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('user decision D3: a lock held elsewhere refuses with its message and stops nothing', async () => {
    await seedEnvironment(h, { container: 'running' });
    lockOutcome = new EnvironmentLockError('busy', 'held');
    const error = await rejection(h.service.stop(ENV_ID));
    expect(error.message).toBe(PipelineTexts.environmentLockBusy(REPO));
    expect(h.docker.log).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
  });

  it('user decision D1: without a worker or a helper image it refuses and stops nothing; never the direct way', async () => {
    await seedEnvironment(h, { container: 'running' });
    lockOutcome = new EnvironmentLockError('unavailable', 'no image');
    expect((await rejection(h.service.stop(ENV_ID))).message).toBe(PipelineTexts.environmentLockUnavailable(REPO, 'no image'));
    lockOutcome = undefined;
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'no space left on device');
    expect((await rejection(h.service.stop(ENV_ID))).message).toContain('no space left on device');
    expect(h.docker.log).toEqual([]);
    expect(h.docker.execs).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
  });

  it('Docker not running stays the refusal of before: no image, no lock', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.docker.running = false;
    await h.service.stop(ENV_ID);
    expect(events).toEqual([]);
  });
});

describe('no unlocked path (plan step 5, PR B, D1: no unlocked path)', () => {
  // The mutant that drops only the re-entrance check (holdsEnvironmentLock) takes a second lock here and fails.
  it('Stop within a held lock of the environment takes no second lock and runs under the held one', async () => {
    await seedEnvironment(h, { container: 'running' });
    await runWithEnvironmentLock(heldLock(ENV_ID), () => h.service.stop(ENV_ID));
    expect(events).toEqual(['docker stop (locked)']);
    expect(releases).toBe(0);
  });

  it('the default lock of the testkit is taken and released by Stop and Delete (the lock is required)', async () => {
    const plain = createHarness();
    try {
      await seedEnvironment(plain, { container: 'running' });
      await plain.service.stop(ENV_ID);
      await plain.service.delete(ENV_ID, { progress: plain.progress, additionalVolumesToRemove: [] });
      expect(plain.lock.acquired).toEqual([ENV_ID, ENV_ID]);
      expect(plain.lock.released).toEqual([ENV_ID, ENV_ID]);
    } finally {
      plain.cleanup();
    }
  });
});
