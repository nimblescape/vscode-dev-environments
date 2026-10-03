// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: Stop and Delete under the lock of the environment on the Docker host (EnvironmentService
// withEnvironmentLock). User decision D1: the helper image is ensured (built when missing) and the worker opened before;
// when that fails, the operation is refused and nothing is stopped or removed. User decision D2: Stop and Delete in step 5.
// User decision D3: a lock held elsewhere is refused after the wait, with its message. The busy mark comes first, then
// the lock; both are released in `finally`.
//
// Plan step 6, PR A (user decision D2): Start, Rebuild, Select configuration and Clone again under the same lock. An open
// of an existing environment takes it after the start of Docker and the wait for another window's operation, around
// everything through the pipeline; a first open after its registry entry, before the volume. A refusal leaves no busy
// mark and nothing changed (a first open removes its new registry entry again). Re-entrant: the Delete of Clone again
// takes no second lock; the redirects of a first open to an existing environment take one lock of that environment.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentLockError, holdsEnvironmentLock, runWithEnvironmentLock, type HeldEnvironmentLock } from '../docker/environmentLock';
import { CommandError, UserFacingError } from '../errors';
import { Messages } from '../messages';
import { LABEL_ENVIRONMENT_ID } from '../names';
import { ENVIRONMENT_LOCK_WAIT_SECONDS, PipelineTexts, type RepositoryTarget } from './environmentService';
import { ACCOUNT, ENV_ID, PID, REPO, T0, WINDOW_ID, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { isBusyMarkLive } from '../busy';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

let h: Harness;
/** What happened, in order: `ensureImage`, `build`, `lock <id> <wait>`, `busy=<operation>` at the lock, `docker …`, `release`. */
let events: string[];
/** How the next lock ends: held, or an error. */
let lockOutcome: Error | undefined;
let releases: number;
/** Plan step 6, PR A: the IDs of the locks asked for, in order. */
let lockedIds: string[];
/** Plan step 6, PR A: when set, each sleep of the service (the wait for another window's busy mark) is the event `busy wait` and runs this. */
let onSleep: (() => Promise<void>) | undefined;

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
  lockedIds = [];
  onSleep = undefined;
  h = createHarness({
    sleep: async () => {
      if (onSleep === undefined) return;
      events.push('busy wait');
      await onSleep();
    },
    environmentLock: async (environmentId, waitSeconds) => {
      lockedIds.push(environmentId);
      events.push(`lock ${environmentId} ${waitSeconds}`);
      const busy = (await h.registry.get(environmentId))?.busy;
      events.push(`busy=${busy?.operation ?? 'none'}`);
      if (lockOutcome) throw lockOutcome;
      return heldLock(environmentId);
    },
  });
  // PR #74 review round 1, A-R1-1: the image before the lock is the non-maintaining ensureImagePresent (event
  // `ensureImage`); the maintaining ensureImageUse would add its own event, which no expectation of Stop or Delete has.
  const ensure = h.helper.ensureImagePresent.bind(h.helper);
  h.helper.ensureImagePresent = async (options) => {
    events.push('ensureImage');
    return ensure(options);
  };
  const maintain = h.helper.ensureImageUse.bind(h.helper);
  h.helper.ensureImageUse = async (options) => {
    events.push('ensureImageUse (maintaining)');
    return maintain(options);
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
    // PR #74 review round 1, A-R1-1: the missing image is built by the non-maintaining ensureImagePresent.
    const ensure = h.helper.ensureImagePresent.bind(h.helper);
    h.helper.ensureImagePresent = async (options) => {
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

  // PR #74 review round 1, A-R1-1: an earlier check recorded a new base digest, so the maintaining ensure would wait for
  // a `--pull --no-cache` rebuild (here: forever). Stop does not run it: it only ensures that the tag exists.
  it('A-R1-1: a pending rebuild of the maintaining ensure does not delay Stop: only the tag is ensured, then the lock', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.helper.ensureImageUse = () => {
      events.push('ensureImageUse (maintaining)');
      return new Promise(() => {});
    };
    await h.service.stop(ENV_ID);
    expect(events).toEqual(['ensureImage', `lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`, 'busy=none', 'docker stop (locked)', 'release']);
    expect(h.helper.calls).toContain('ensureImagePresent');
    expect(h.helper.calls).not.toContain('ensureImage');
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('A-R1-1: a failed build of the missing tag refuses Stop with the D1 message, before the lock, with no fallback', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'failed to solve: node:22');
    const error = await rejection(h.service.stop(ENV_ID));
    expect(error.message).toBe(PipelineTexts.environmentLockUnavailable(REPO, `${Messages.helperFailed} failed to solve: node:22`));
    expect(events).toEqual(['ensureImage']);
    expect(h.docker.log).toEqual([]);
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

// ---------------------------------------------------------------------------------------------------------------------
// Plan step 6, PR A (user decision D2): Start, Rebuild, Select configuration and Clone again under the environment lock.

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

function openOptions<T extends object = object>(extra?: T): { progress: typeof h.progress } & T {
  return { progress: h.progress, ...(extra ?? ({} as T)) };
}

/** The environment ID of a workspace volume (by its label; the seeded environment for a volume that is gone). */
function idOfVolume(name: string): string {
  return h.docker.volumes.get(name)?.[LABEL_ENVIRONMENT_ID] ?? lockedIds.at(-1) ?? ENV_ID;
}

/** ` (locked)` while the running operation holds the lock of the environment of `volumeName`. */
function lockedSuffix(volumeName: string): string {
  return holdsEnvironmentLock(idOfVolume(volumeName)) ? ' (locked)' : '';
}

/** The events without the container steps of Delete (`docker stop`, `docker rm`) and the maintaining ensure of the open. */
function openEvents(): string[] {
  return events.filter((event) => !event.startsWith('docker stop') && !event.startsWith('docker rm') && event !== 'ensureImageUse (maintaining)');
}

/** The read of a first open before its registry entry (unusedEnvironmentId: the volume name is free); nothing is created. */
const FREE_NAME_CHECK = 'docker volume exists';

describe('Start, Rebuild, Select configuration and Clone again under the environment lock (plan step 6, PR A)', () => {
  beforeEach(() => {
    // The Docker and helper steps of the open, each with whether it ran under the lock of its environment.
    const volumeExists = h.docker.volumeExists.bind(h.docker);
    h.docker.volumeExists = async (name) => {
      events.push(`docker volume exists${lockedSuffix(name)}`);
      return volumeExists(name);
    };
    // Review round 3 of PR #88 (A-R3-1): the read of whose the workspace volume is (workspaceVolumeOwnership).
    const inspectVolumes = h.docker.inspectVolumes.bind(h.docker);
    h.docker.inspectVolumes = async (names) => {
      if (names.length === 1 && names[0].startsWith('devenv-')) events.push(`docker volume inspect${lockedSuffix(names[0])}`);
      return inspectVolumes(names);
    };
    const createVolume = h.docker.createVolume.bind(h.docker);
    h.docker.createVolume = async (name, labels) => {
      events.push(`docker volume create${holdsEnvironmentLock(labels[LABEL_ENVIRONMENT_ID]) ? ' (locked)' : ''}`);
      return createVolume(name, labels);
    };
    const removeVolume = h.docker.removeVolume.bind(h.docker);
    h.docker.removeVolume = async (name) => {
      events.push(`docker volume rm${lockedSuffix(name)}`);
      return removeVolume(name);
    };
    const clone = h.helper.clone.bind(h.helper);
    h.helper.clone = async (p) => {
      events.push(`clone${lockedSuffix(p.volumeName)}`);
      return clone(p);
    };
    const build = h.helper.build.bind(h.helper);
    h.helper.build = async (p) => {
      events.push(`build${lockedSuffix(p.volumeName)}`);
      return build(p);
    };
    const up = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      events.push(`up${lockedSuffix(p.volumeName)}`);
      return up(p);
    };
  });

  it('Start: the lock after the start of Docker and the wait for another window, before the volume check and the pipeline', async () => {
    // Another live window holds a busy mark; it ends during the first wait.
    await seedEnvironment(h, { extra: { busy: { operation: 'rebuild', since: new Date(h.clock.now()).toISOString(), pid: 7777, windowId: 'window-2' } } });
    h.alivePids.add(7777);
    onSleep = async () => {
      await h.registry.updateEnvironment(ENV_ID, (entry) => {
        delete entry.busy;
      });
    };
    await h.service.open(TARGET, openOptions());
    expect(h.dockerStarts).toBe(1);
    // Review round 3 of PR #88 (A-R3-1): changed expectation, the open reads whose the volume is (before: whether it exists).
    expect(openEvents().slice(0, 5)).toEqual(['busy wait', 'ensureImage', `lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`, 'busy=none', 'docker volume inspect (locked)']);
    expect(openEvents()).toContain('up (locked)');
    expect(openEvents()).not.toContain('up');
    expect(openEvents().at(-1)).toBe('release');
    expect(lockedIds).toEqual([ENV_ID]);
    expect(releases).toBe(1);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('Rebuild: builds and starts under the lock', async () => {
    await seedEnvironment(h, { container: 'running' });
    await h.service.openEnvironment(ENV_ID, openOptions({ forceRebuild: true }));
    expect(lockedIds).toEqual([ENV_ID]);
    expect(openEvents()).toEqual(expect.arrayContaining(['build (locked)', 'up (locked)']));
    expect(openEvents().filter((event) => event === 'build' || event === 'up')).toEqual([]);
    expect(openEvents().at(-1)).toBe('release');
    expect(releases).toBe(1);
  });

  it('Select configuration: applies the selected configuration under the lock', async () => {
    await seedEnvironment(h, { container: 'running' });
    await h.service.openEnvironment(ENV_ID, openOptions({ configPath: DEFAULT_CONFIG_PATH }));
    expect(lockedIds).toEqual([ENV_ID]);
    expect(openEvents()).toEqual(expect.arrayContaining(['build (locked)', 'up (locked)']));
    expect(openEvents().filter((event) => event === 'build' || event === 'up')).toEqual([]);
    expect(openEvents().at(-1)).toBe('release');
    expect(releases).toBe(1);
  });

  it('Clone again: the question, the new volume and the clone under the lock', async () => {
    await seedEnvironment(h, { volume: false, container: null });
    h.ui.filesMissingAnswer = 'cloneAgain';
    await h.service.open(TARGET, openOptions());
    expect(lockedIds).toEqual([ENV_ID]);
    expect(openEvents().slice(0, 7)).toEqual([
      'ensureImage',
      `lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`,
      'busy=none',
      // Review round 3 of PR #88 (A-R3-1): changed expectation, the open reads whose the volume is (before: whether it exists).
      'docker volume inspect (locked)',
      'docker volume create (locked)',
      // Review round 4 of PR #88 (A-R4-1): changed expectation, and whose the new volume is before the clone.
      'docker volume inspect (locked)',
      'clone (locked)',
    ]);
    expect(openEvents()).toContain('up (locked)');
    expect(openEvents().at(-1)).toBe('release');
    expect(h.ui.prompts).toEqual([`filesMissing ${REPO}`]);
  });

  it('re-entrant: the Delete of "files missing" runs under the held lock and takes no second one', async () => {
    await seedEnvironment(h, { volume: false, container: 'stopped' });
    h.ui.filesMissingAnswer = 'deleteEnvironment';
    const error = await rejection(h.service.open(TARGET, openOptions()));
    expect(error.code).toBe('cancelled');
    expect(lockedIds).toEqual([ENV_ID]);
    expect(events.filter((event) => event === 'ensureImage')).toHaveLength(1);
    expect(events).toContain('docker rm (locked)');
    expect(events).toContain('docker volume rm (locked)');
    expect(events.at(-1)).toBe('release');
    expect(releases).toBe(1);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
  });

  it('the resumed clone of an interrupted first open runs under the lock', async () => {
    const staleCreate = { operation: 'create' as const, since: '2026-09-24T15:00:00.000Z', pid: 999, windowId: 'window-old' };
    await seedEnvironment(h, { record: null, container: null, extra: { busy: staleCreate } });
    await h.service.open(TARGET, openOptions());
    // Review round 3 of PR #88 (A-R3-1): changed expectation, the open reads whose the volume is (before: whether it exists).
    expect(openEvents().slice(0, 5)).toEqual(['ensureImage', `lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`, 'busy=create', 'docker volume inspect (locked)', 'clone (locked)']);
    expect(openEvents()).toContain('up (locked)');
    expect(openEvents().at(-1)).toBe('release');
  });

  it.each([
    ['D3: busy', () => new EnvironmentLockError('busy', 'The lock stayed held by another holder for 10 s.'), PipelineTexts.environmentLockBusy(REPO)],
    ['D1: no worker', () => new EnvironmentLockError('unavailable', 'no worker'), PipelineTexts.environmentLockUnavailable(REPO, 'no worker')],
  ] as const)('a refused lock (%s) of Start changes nothing and leaves no busy mark or pending file', async (_name, refusal, message) => {
    await seedEnvironment(h, { container: 'stopped' });
    lockOutcome = refusal();
    const error = await rejection(h.service.open(TARGET, openOptions()));
    expect(error.message).toBe(message);
    expect(events).toEqual(['ensureImage', `lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`, 'busy=none']);
    expect(h.docker.log).toEqual([]);
    expect(h.helper.calls).toEqual(['ensureImagePresent']);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  it('a refused lock of Rebuild and of Select configuration builds nothing', async () => {
    await seedEnvironment(h, { container: 'running' });
    lockOutcome = new EnvironmentLockError('busy', 'held');
    expect((await rejection(h.service.openEnvironment(ENV_ID, openOptions({ forceRebuild: true })))).message).toBe(PipelineTexts.environmentLockBusy(REPO));
    expect((await rejection(h.service.openEnvironment(ENV_ID, openOptions({ configPath: DEFAULT_CONFIG_PATH })))).message).toBe(PipelineTexts.environmentLockBusy(REPO));
    expect(h.helper.calls).toEqual(['ensureImagePresent', 'ensureImagePresent']);
    expect(h.docker.log).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('a refused lock of Clone again asks nothing, creates no volume, and keeps a stale create mark as it was', async () => {
    const staleCreate = { operation: 'create' as const, since: '2026-09-24T15:00:00.000Z', pid: 999, windowId: 'window-old' };
    await seedEnvironment(h, { volume: false, container: null, extra: { busy: staleCreate } });
    h.ui.filesMissingAnswer = 'cloneAgain';
    lockOutcome = new EnvironmentLockError('busy', 'held');
    await rejection(h.service.open(TARGET, openOptions()));
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.clones).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(staleCreate);
  });

  it('D1: a missing helper image that cannot be built refuses Start before the lock; nothing is started', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'pull access denied for node');
    const error = await rejection(h.service.open(TARGET, openOptions()));
    expect(error.message).toBe(PipelineTexts.environmentLockUnavailable(REPO, `${Messages.helperFailed} pull access denied for node`));
    expect(events).toEqual(['ensureImage']);
    expect(h.docker.log).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  describe('first open', () => {
    it('takes the lock after the registry entry (with its create mark), before the volume, and clones and starts under it', async () => {
      await h.service.open(TARGET, openOptions());
      const [id] = lockedIds;
      expect(lockedIds).toEqual([id]);
      expect((await h.registry.list()).map((entry) => entry.id)).toEqual([id]);
      expect(openEvents().slice(0, 7)).toEqual([
        FREE_NAME_CHECK,
        'ensureImage',
        `lock ${id} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`,
        'busy=create',
        'docker volume create (locked)',
        // Review round 2 of PR #88 (A-R2-2): changed expectation, the labels of the new volume are read (requireOwnVolume).
        'docker volume inspect (locked)',
        'clone (locked)',
      ]);
      expect(openEvents()).toContain('up (locked)');
      expect(openEvents().at(-1)).toBe('release');
      expect((await h.registry.get(id))?.busy).toBeUndefined();
    });

    it.each([
      ['D3: busy', () => new EnvironmentLockError('busy', 'held'), PipelineTexts.environmentLockBusy(REPO)],
      ['D1: no worker', () => new EnvironmentLockError('unavailable', 'no worker'), PipelineTexts.environmentLockUnavailable(REPO, 'no worker')],
    ] as const)('a refused lock (%s) removes the new registry entry and creates nothing on Docker', async (_name, refusal, message) => {
      lockOutcome = refusal();
      const error = await rejection(h.service.open(TARGET, openOptions()));
      expect(error.message).toBe(message);
      expect(events).toEqual([FREE_NAME_CHECK, 'ensureImage', `lock ${lockedIds[0]} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`, 'busy=create']);
      expect(await h.registry.list()).toEqual([]);
      expect(h.docker.log).toEqual([]);
      expect(h.docker.volumes.size).toBe(0);
      expect(h.helper.calls).toEqual(['ensureImagePresent']);
      expect(await h.sessionFiles.readPendings()).toEqual([]);
    });

    it('a lock wait that is cancelled removes the new registry entry too', async () => {
      const controller = new AbortController();
      h = recreateWithLock(async () => {
        controller.abort();
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      });
      const error = await rejection(h.service.open(TARGET, openOptions({ signal: controller.signal })));
      expect(error.code).toBe('cancelled');
      expect(await h.registry.list()).toEqual([]);
      expect(h.docker.log).toEqual([]);
    });

    it('D1: a helper image that cannot be built refuses the first open; the new registry entry is removed again', async () => {
      h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'no space left on device');
      const error = await rejection(h.service.open(TARGET, openOptions()));
      expect(error.message).toBe(PipelineTexts.environmentLockUnavailable(REPO, `${Messages.helperFailed} no space left on device`));
      expect(events).toEqual([FREE_NAME_CHECK, 'ensureImage']);
      expect(await h.registry.list()).toEqual([]);
      expect(h.docker.volumes.size).toBe(0);
    });

    it('a failed clone is removed again under the lock, before the release', async () => {
      h.helper.cloneError = new CommandError('git clone', 128, '', 'Repository not found');
      await rejection(h.service.open(TARGET, openOptions()));
      const [id] = lockedIds;
      expect(openEvents()).toEqual([
        FREE_NAME_CHECK,
        'ensureImage',
        `lock ${id} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`,
        'busy=create',
        'docker volume create (locked)',
        // Review rounds 2 and 1 of PR #88 (A-R2-2, A-R1-4): changed expectation, the labels of the volume are read after its
        // creation and before its removal, both under the lock.
        'docker volume inspect (locked)',
        'clone (locked)',
        'docker volume inspect (locked)',
        'docker volume rm (locked)',
        'release',
      ]);
      expect(await h.registry.list()).toEqual([]);
      expect(h.docker.volumes.size).toBe(0);
    });

    it('redirect: a first open that restores the environment from its volume opens it with one lock of its ID', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      // The registry lost the entry; the labelled volume stays.
      await h.registry.remove(ENV_ID);
      await h.service.open(TARGET, openOptions());
      expect(lockedIds).toEqual([ENV_ID]);
      expect(releases).toBe(1);
      expect(openEvents()).toContain('up (locked)');
      expect((await h.registry.get(ENV_ID))?.owner.id).toBe(ACCOUNT.id);
    });

    it('redirect: a first open whose entry another window created meanwhile opens that one with one lock of its ID', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      // The lookup of `open` misses the entry (it is created "meanwhile"), so `add` of the first open conflicts.
      const find = h.registry.findForAccount.bind(h.registry);
      let lookups = 0;
      h.registry.findForAccount = async (...args: Parameters<typeof find>) => (++lookups === 1 ? undefined : find(...args));
      const add = h.registry.add.bind(h.registry);
      h.registry.add = async (environment) => {
        if (environment.id !== ENV_ID) throw new Error('One environment per repository and account.');
        return add(environment);
      };
      await h.service.open(TARGET, openOptions());
      expect(lockedIds).toEqual([ENV_ID]);
      expect(releases).toBe(1);
      expect(openEvents()).toContain('up (locked)');
      expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
    });
  });

  // Review round 5 of PR #88 (B-R5-2, mutant L2): the listing of Select configuration reads whose the volume is under
  // the lock (A-R4-2), so the volume cannot change between the check and the listing of the helper.
  it('B-R5-2: Select configuration reads whose the volume is under the lock, before the listing of the helper', async () => {
    await seedEnvironment(h, { container: 'running' });
    const listConfigurations = h.helper.listConfigurations.bind(h.helper);
    h.helper.listConfigurations = async (p) => {
      events.push(`listConfigurations${lockedSuffix(p.volumeName)}`);
      return listConfigurations(p);
    };
    await h.service.listConfigurations(ENV_ID, openOptions());
    const listing = openEvents().filter((event) => !event.startsWith('docker volume exists'));
    const lock = listing.indexOf(`lock ${ENV_ID} ${ENVIRONMENT_LOCK_WAIT_SECONDS}`);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(listing.slice(lock + 1).filter((event) => event.startsWith('docker volume inspect') || event.startsWith('listConfigurations'))).toEqual([
      'docker volume inspect (locked)',
      'listConfigurations (locked)',
    ]);
    expect(listing.filter((event) => event === 'docker volume inspect')).toEqual([]);
    expect(lockedIds).toEqual([ENV_ID]);
  });
});

/** A harness of this file whose lock is `take` (for a lock that does something else than hold or refuse). */
function recreateWithLock(take: () => Promise<HeldEnvironmentLock>): Harness {
  h.cleanup();
  return createHarness({ environmentLock: take });
}

// PR #78 review round 1 (A-R1-1): a failed first open whose volume cannot be removed (for example the lock was lost, so
// every Docker call fails) keeps its registry entry with the create mark, so the interrupted clone is completed later.
describe('a failed first open whose volume cannot be removed (PR #78 review round 1, A-R1-1)', () => {
  function failing() {
    const h = createHarness({});
    h.helper.cloneError = new Error('clone cut off');
    const remove = h.docker.removeVolume.bind(h.docker);
    let lost = true;
    h.docker.removeVolume = async (name: string) => {
      if (lost) throw new CommandError(`docker volume rm ${name}`, null, '', 'The lock of the environment on the Docker host was lost (worker lost); docker volume rm was not run.');
      return remove(name);
    };
    return {
      h,
      heal: () => {
        lost = false;
        h.helper.cloneError = undefined;
      },
    };
  }

  it('keeps the entry with its create mark and the volume; the next open completes the clone', async () => {
    const { h, heal } = failing();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    const [entry] = await h.registry.list();
    expect(entry?.busy?.operation).toBe('create');
    expect(h.docker.volumes.has(entry!.volumeName)).toBe(true);
    heal();
    const before = h.helper.calls.length;
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.helper.calls.slice(before)).toContain('clone main');
    expect((await h.registry.get(entry!.id))?.busy).toBeUndefined();
  });

  it('keeps the create mark when the resumed clone fails again in the same window, so a later open still clones', async () => {
    const { h, heal } = failing();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    const [entry] = await h.registry.list();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    expect((await h.registry.get(entry!.id))?.busy?.operation).toBe('create');
    heal();
    const before = h.helper.calls.length;
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.helper.calls.slice(before)).toContain('clone main');
    expect((await h.registry.get(entry!.id))?.busy).toBeUndefined();
  });

  it('Delete in the same window removes the kept environment', async () => {
    const { h, heal } = failing();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    const [entry] = await h.registry.list();
    heal();
    await h.service.delete(entry!.id, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
  });

  // PR #78 review round 2 (A-R2-1): the kept create mark of this window counts as ended, so it blocks nothing while this
  // window lives (the sidebar of every window, other windows' Start and Delete); any window's next open completes the clone.
  const statuses = (now: number) =>
    [
      { windowId: WINDOW_ID, pid: PID, updatedAt: new Date(now).toISOString(), environmentId: null, state: 'idle' },
      { windowId: 'window-2', pid: 777, updatedAt: new Date(now).toISOString(), environmentId: null, state: 'idle' },
    ] as never[];

  it.each([
    ['after the failed first open', false],
    ['after a resume that fails again in the same window', true],
  ])('%s, the kept create mark is not live; another window resumes the clone (PR #78 review round 2, A-R2-1)', async (_name, resumeFailsFirst) => {
    const { h, heal } = failing();
    await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    if (resumeFailsFirst) await expect(h.service.open(TARGET, { progress: h.progress })).rejects.toThrow();
    const [entry] = await h.registry.list();
    expect(entry?.busy?.operation).toBe('create');
    const now = T0 + 60_000;
    expect(isBusyMarkLive(entry!.busy!, { now, isAlive: (pid) => pid === PID || pid === 777, windowStatuses: statuses(now) })).toBe(false);
    const other = createHarness({
      registry: h.registry,
      sessionFiles: h.sessionFiles,
      docker: h.docker,
      helper: h.helper,
      owner: { windowId: 'window-2', pid: 777 },
      isProcessAlive: (pid) => pid === PID || pid === 777,
      windowStatuses: async () => statuses(Date.now()),
      sleep: async () => {},
    });
    heal();
    const before = h.helper.calls.length;
    await other.service.openEnvironment(entry!.id, { progress: h.progress });
    expect(h.helper.calls.slice(before)).toContain('clone');
    expect((await h.registry.get(entry!.id))?.busy).toBeUndefined();
  });
});
