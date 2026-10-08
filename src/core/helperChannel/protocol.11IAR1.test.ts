// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #122 (reviewer B): probes for mutants of the protocol parsers (protocol.ts) that the tests of the
// PR left alive.
import { describe, expect, it } from 'vitest';
import { parseProbeValue, sameEngine } from './protocol';

describe('review round 1 of PR #122 (reviewer B): sameEngine and parseProbeValue', () => {
  // Kills the mutant that compares the IDs case-insensitively (or after any normalization): the values are compared
  // exactly, as the engines name them.
  it('sameEngine compares the ID and the root folder exactly', () => {
    expect(sameEngine({ id: 'abcd:efgh', rootDir: '/var/lib/docker' }, { id: 'ABCD:EFGH', rootDir: '/var/lib/docker' })).toBe(false);
    expect(sameEngine({ id: 'id', rootDir: '/var/lib/docker' }, { id: 'id', rootDir: '/var/lib/docker/' })).toBe(false);
    expect(sameEngine({ id: 'id', rootDir: '/var/lib/docker' }, { id: 'id', rootDir: '/var/lib/docker' })).toBe(true);
  });

  // Kills the mutant that drops the type check of serverVersion (the line is older than the PR; the worker is untrusted,
  // so a version that is no string is an invalid answer).
  it('parseProbeValue refuses a server version that is no string', () => {
    for (const serverVersion of [27, null, { v: '27' }, ['27']]) {
      expect(parseProbeValue({ serverVersion, detail: 'd', engine: { id: 'id', rootDir: '/r' } }), JSON.stringify(serverVersion)).toBeUndefined();
    }
  });
});
