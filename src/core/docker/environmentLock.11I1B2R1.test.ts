// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR #119 review round 1 (B, mutation testing): probes for the end of the scope of a held environment lock.
import { describe, expect, it } from 'vitest';
import { holdsEnvironmentLock, runWithEnvironmentLock, type HeldEnvironmentLock } from './environmentLock';

function fakeLock(environmentId: string): HeldEnvironmentLock {
  return { environmentId, lost: new Promise<string>(() => {}), release: async () => {} };
}

const later = <T>(fn: () => T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(fn()), 5));

describe('the end of the scope of a held environment lock (PR #119, B-R1)', () => {
  it('a timer left behind by a function that threw does not see the lock', async () => {
    let seen!: Promise<boolean>;
    await expect(
      runWithEnvironmentLock(fakeLock('env-1'), async () => {
        seen = later(() => holdsEnvironmentLock('env-1'));
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(await seen).toBe(false);
  });

  it('a lock taken from a timer of an ended scope does not inherit the environments of that scope', async () => {
    let inner!: Promise<[boolean, boolean]>;
    await runWithEnvironmentLock(fakeLock('env-1'), async () => {
      inner = new Promise((resolve) =>
        setTimeout(() => {
          void runWithEnvironmentLock(fakeLock('env-2'), async () => [holdsEnvironmentLock('env-1'), holdsEnvironmentLock('env-2')] as [boolean, boolean]).then(resolve);
        }, 5),
      );
    });
    expect(await inner).toEqual([false, true]);
  });
});
