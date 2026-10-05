// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4d: the window's memory of the containers whose lifecycle mark could not be recorded.
import { describe, expect, it } from 'vitest';
import { windowLifecycleMemory } from './lifecycleMemory';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const FULL = 'a'.repeat(64);

describe('windowLifecycleMemory (plan step 11E4d)', () => {
  it('one container per environment; a new one replaces it; only that container is forgotten', async () => {
    const memory = windowLifecycleMemory();
    expect(await memory.get(ID)).toBeUndefined();
    await memory.remember(ID, FULL);
    await memory.remember('other', 'b'.repeat(64));
    expect(await memory.get(ID)).toBe(FULL);
    await memory.forget(ID, 'c'.repeat(64));
    expect(await memory.get(ID)).toBe(FULL);
    // The same container by its short ID (sameContainer).
    await memory.forget(ID, FULL.slice(0, 12));
    expect(await memory.get(ID)).toBeUndefined();
    expect(await memory.get('other')).toBe('b'.repeat(64));
    await memory.remember(ID, FULL);
    await memory.remember(ID, 'd'.repeat(64));
    expect(await memory.get(ID)).toBe('d'.repeat(64));
  });

  it('each window has its own', async () => {
    const one = windowLifecycleMemory();
    await one.remember(ID, FULL);
    expect(await windowLifecycleMemory().get(ID)).toBeUndefined();
  });
});
