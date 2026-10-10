// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR C6, B7): the shared checks of the shape of a value (before: a copy in each module).
import { describe, expect, it } from 'vitest';
import { hasExactKeys, hasOnlyKeys, isRecord } from './valueChecks';

describe('the shared checks of the shape of a value (cleanup PR C6, B7)', () => {
  it('isRecord: an object that is not null and not an array', () => {
    for (const value of [{}, { a: 1 }, Object.create(null), new Date(0)]) expect(isRecord(value)).toBe(true);
    for (const value of [null, undefined, [], [1], 'a', 1, true, () => {}]) expect(isRecord(value), typeof value).toBe(false);
  });

  it('hasOnlyKeys: every required key, and no key beyond the required and the optional ones', () => {
    expect(hasOnlyKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
    expect(hasOnlyKeys({ a: 1 }, ['a'], ['b'])).toBe(true);
    expect(hasOnlyKeys({ a: 1, b: 2 }, ['a'], ['b'])).toBe(true);
    expect(hasOnlyKeys({ b: 2 }, ['a'], ['b'])).toBe(false);
    expect(hasOnlyKeys({ a: 1, c: 3 }, ['a'], ['b'])).toBe(false);
    expect(hasOnlyKeys({ a: undefined }, ['a'])).toBe(true);
  });

  it('hasExactKeys: the own keys are exactly the given ones', () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ b: 2, a: 1 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, c: 3 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys(Object.create({ a: 1, b: 2 }) as Record<string, unknown>, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({}, [])).toBe(true);
  });
});
