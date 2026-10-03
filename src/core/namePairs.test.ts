// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User decisions 2026-10-03: the readable pair `<adjective>-<scientist>` of the names of an environment.
import { describe, expect, it } from 'vitest';
import { ADJECTIVES, SCIENTISTS, namePair, trailingPair } from './namePairs';

describe('the word lists', () => {
  it.each([
    ['ADJECTIVES', ADJECTIVES],
    ['SCIENTISTS', SCIENTISTS],
  ])('%s has no duplicates and only words of [a-z]+', (_name, list) => {
    expect(list.length).toBeGreaterThan(50);
    expect(new Set(list).size).toBe(list.length);
    for (const word of list) expect(word).toMatch(/^[a-z]+$/);
  });
});

describe('namePair', () => {
  it('is <adjective>-<scientist> from the lists', () => {
    for (const seed of ['a', 'b', '11111111-2222-4333-8444-555555555555', 'ssh://user@host:22', '']) {
      const [adjective, scientist, ...rest] = namePair(seed).split('-');
      expect(rest).toEqual([]);
      expect(ADJECTIVES).toContain(adjective);
      expect(SCIENTISTS).toContain(scientist);
    }
  });

  it('is deterministic and depends on the seed', () => {
    expect(namePair('11111111-2222-4333-8444-555555555555')).toBe(namePair('11111111-2222-4333-8444-555555555555'));
    const pairs = new Set(Array.from({ length: 50 }, (_, index) => namePair(`seed-${index}`)));
    expect(pairs.size).toBeGreaterThan(40);
  });

  it('is pinned for a fixed environment ID', () => {
    // Pinned on purpose: the lists and the hash are part of every name. Changing a word, the order of the lists, or the
    // way the pair is derived renames every existing environment (volumes, containers, images, Compose projects).
    expect(namePair('3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b')).toBe('hardy-liskov');
    expect(namePair('11111111-2222-4333-8444-555555555555')).toBe('tidy-berners');
  });
});

describe('trailingPair', () => {
  it('gives the pair at the end of a name', () => {
    expect(trailingPair('devenv-acme-api-tidy-berners')).toBe('tidy-berners');
    expect(trailingPair(`x-${namePair('seed')}`)).toBe(namePair('seed'));
  });

  it.each(['devenv-acme-api', 'tidy-berners', 'devenv-acme-api-tidy-nobody', 'devenv-acme-api-nobody-berners', 'devenv-acme-api-tidy-berners-', 'devenv-acme-api-Tidy-berners', 'devenv-x-tidy-berners_1'])(
    'gives undefined for %j',
    (name) => {
      expect(trailingPair(name)).toBeUndefined();
    },
  );
});
