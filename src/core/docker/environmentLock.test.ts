// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the scope of a held environment lock. Plan step 11I1, PR B2: the Docker calls of ContainerAdapter in
// it (through the worker that held the lock, also a docker exec with a secret input) are gone with that routing; their
// tests were removed with it.
import { describe, expect, it } from 'vitest';
import { holdsEnvironmentLock, runWithEnvironmentLock, type HeldEnvironmentLock } from './environmentLock';

/** A held lock that is never lost. */
function fakeLock(environmentId = 'env-1') {
  const lock: HeldEnvironmentLock = { environmentId, lost: new Promise<string>(() => {}), release: async () => {} };
  return { lock };
}

describe('the scope of a held environment lock (plan step 5, PR B)', () => {
  // Plan step 11I1, PR B2: changed expectation (before: also that a loss of the outer lock counted in the inner scope,
  // read through heldEnvironmentLock, which is gone with the routing of ContainerAdapter).
  it('knows the environments whose lock it holds, also nested, and ends with the scope', async () => {
    const outer = fakeLock('env-1');
    const inner = fakeLock('env-2');
    expect(holdsEnvironmentLock('env-1')).toBe(false);
    await runWithEnvironmentLock(outer.lock, async () => {
      expect(holdsEnvironmentLock('env-1')).toBe(true);
      expect(holdsEnvironmentLock('env-2')).toBe(false);
      await runWithEnvironmentLock(inner.lock, async () => {
        expect(holdsEnvironmentLock('env-1')).toBe(true);
        expect(holdsEnvironmentLock('env-2')).toBe(true);
      });
      expect(holdsEnvironmentLock('env-2')).toBe(false);
    });
    expect(holdsEnvironmentLock('env-1')).toBe(false);
  });

  // Plan step 11I1, PR B2: changed expectation (before: a `docker ps` of ContainerAdapter in the timer ran directly, not
  // through the lock's worker; that routing is gone): the timer no longer sees the lock of the ended scope.
  it('a timer that the scope left behind does not run in it after it ended', async () => {
    const { lock } = fakeLock();
    let later!: Promise<boolean>;
    await runWithEnvironmentLock(lock, async () => {
      expect(holdsEnvironmentLock('env-1')).toBe(true);
      later = new Promise((resolve) => setTimeout(() => resolve(holdsEnvironmentLock('env-1')), 5));
    });
    expect(await later).toBe(false);
  });

  it('returns the result of its function and ends the scope also when it throws', async () => {
    const { lock } = fakeLock();
    expect(await runWithEnvironmentLock(lock, async () => 42)).toBe(42);
    await expect(
      runWithEnvironmentLock(lock, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(holdsEnvironmentLock('env-1')).toBe(false);
  });
});
