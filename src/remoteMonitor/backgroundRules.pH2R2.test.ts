// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11H2 (reviewer B, mutation testing): probes for the rules of round 1 that no test pinned: the bound
// of the failed fetches in absolute numbers (16 kept, 17 refused; the existing test uses MAX_FAILED_FETCHES itself), an
// insider use whose time lies in the future (a clock that was ahead) counts as a use now, and every commit of a field of
// a process line counts (not only the first). Pure rules; nothing touches the disk.
import { describe, expect, it } from 'vitest';
import { MAX_FAILED_FETCHES, SERVER_UNUSED_MS, commitsInProcesses, parseCacheRunState, qualitiesToFetch } from './backgroundRules';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const commit = (n: number) => n.toString(16).padStart(40, '0');
const failures = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`insider-linux-arm64-${commit(n + 1)}`, NOW - n]));

describe('11H2 review round 2 (B): the bound of the failed fetches', () => {
  it('is 16: a state with 16 failed fetches keeps them all, one with 17 keeps none', () => {
    expect(MAX_FAILED_FETCHES).toBe(16);
    expect(parseCacheRunState(JSON.stringify({ failedFetches: failures(16) })).failedFetches).toEqual(failures(16));
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: 1, failedFetches: failures(17) }))).toEqual({ lastEndAt: 1 });
  });
});

describe('11H2 review round 2 (B): the insider rule', () => {
  it('an insider use whose time lies in the future (a clock that was ahead) counts as a use now, however far', () => {
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW + SERVER_UNUSED_MS + 30 * DAY }], NOW)).toEqual(['stable', 'insider']);
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW - 14 * DAY }], NOW)).toEqual(['stable']);
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW - 14 * DAY + 1 }], NOW)).toEqual(['stable', 'insider']);
  });
});

describe('11H2 review round 2 (B): the commits in the processes of a container', () => {
  it('finds every commit of a field, also a second one in the same command line', () => {
    const line = `/home/u/.vscode-server/bin/${commit(7)}/node /home/u/.vscode-server/bin/${commit(8)}/out/server-main.js`;
    expect([...commitsInProcesses([['1000', '42', line]])].sort()).toEqual([commit(7), commit(8)]);
  });
});
