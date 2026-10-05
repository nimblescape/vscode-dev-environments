// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #110 (plan step 11E3b), reviewer B: the probes of the mutation testing of registryLogins, the
// cancelable wait for the turn (turnOf) and the queue of the turns after a cancelled wait.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../ports';
import type { HostSide } from './hostSide';
import { registryLogins } from './workerServices';

/** Lets the pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('registryLogins, the wait for the turn, review round 2 of PR #110 (B)', () => {
  it('a turn that waited with a signal removes its abort listener when the wait ends (a long-lived signal keeps none)', async () => {
    const host = { secrets: { registry: async (registry: string) => ({ username: 'u', serveraddress: registry, password: 'p' }) } } as unknown as HostSide;
    const logins = registryLogins(host, () => undefined, silentLogger);
    const signal = new AbortController().signal;
    const listeners = new Set<unknown>();
    const add = vi.spyOn(signal, 'addEventListener');
    const remove = vi.spyOn(signal, 'removeEventListener');
    for (let i = 0; i < 3; i++) expect(await logins('ghcr.io', async (login) => login?.password, signal)).toBe('p');
    await settle();
    for (const [type, listener] of add.mock.calls) if (type === 'abort') listeners.add(listener);
    for (const [type, listener] of remove.mock.calls) if (type === 'abort') listeners.delete(listener);
    expect(add).toHaveBeenCalledTimes(3);
    expect(listeners.size).toBe(0);
  });

  it('a user who cancels while the login is asked: `use` never runs, the cancel is an AbortError, and the login is forgotten', async () => {
    let answer: () => void = () => undefined;
    const host = {
      secrets: {
        registry: (registry: string) => new Promise((resolve) => (answer = () => resolve({ username: 'u', serveraddress: registry, password: 'p' }))),
      },
    } as unknown as HostSide;
    let forgotten = 0;
    const logins = registryLogins(host, () => void forgotten++, silentLogger);
    const cancel = new AbortController();
    const used: unknown[] = [];
    const turn = logins('ghcr.io', async (login) => void used.push(login), cancel.signal);
    await settle();
    cancel.abort();
    answer();
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect(used).toEqual([]);
    expect(forgotten).toBe(1);
  });
});
