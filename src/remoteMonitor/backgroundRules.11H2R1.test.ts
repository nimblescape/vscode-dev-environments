// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H2 (reviewer B, mutation testing: its probes, adopted): the 14 days of the cleanup of the shared VS
// Code server store in absolute times (the existing tests use SERVER_UNUSED_MS itself, so a shorter time survived), a time
// far in the future counts as used, and a cron schedule without any time never makes the run due (parseCacheSchedule
// refuses it now, D3). And the new rules of the round: the state of the failed fetches (A-L4), a version that no open used
// or that a running container runs (A-M1, A-M2), and the commits in the processes of a container (A-M2).
import { describe, expect, it } from 'vitest';
import { cacheRunDue } from '../core/remoteMonitor/cacheSettings';
import { parseCronSchedule } from '../core/remoteMonitor/cron';
import {
  CLOCK_RESET_MS,
  FETCH_RETRY_MS,
  MAX_FAILED_FETCHES,
  SERVER_UNUSED_MS,
  commitsInProcesses,
  fetchRetryDue,
  parseCacheRunState,
  serversToRemove,
} from './backgroundRules';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const commit = (n: number) => n.toString(16).padStart(40, '0');

describe('11H2 review round 1 (B): the cleanup keeps a version used within 14 days (absolute times)', () => {
  it('SERVER_UNUSED_MS is 14 days', () => {
    expect(SERVER_UNUSED_MS).toBe(14 * DAY);
  });

  it('a version beyond the two newest used 13 days ago stays; one used 14 days ago goes', () => {
    const released = [commit(5), commit(4), commit(3), commit(2)];
    const stored = [
      { commit: commit(5), usedAt: NOW - 30 * DAY },
      { commit: commit(4), usedAt: NOW - 30 * DAY },
      { commit: commit(3), usedAt: NOW - 13 * DAY },
      { commit: commit(2), usedAt: NOW - 14 * DAY },
    ];
    expect(serversToRemove(stored, released, NOW)).toEqual([commit(2)]);
  });

  it('a version whose time lies far in the future (a clock that was ahead) counts as used now, however far', () => {
    const released = [commit(5), commit(4), commit(3)];
    const stored = [
      { commit: commit(5), usedAt: NOW - 30 * DAY },
      { commit: commit(4), usedAt: NOW - 30 * DAY },
      { commit: commit(3), usedAt: NOW + 30 * DAY },
    ];
    expect(serversToRemove(stored, released, NOW)).toEqual([]);
  });
});

describe('11H2 review round 1 (B): a cron schedule that has no time', () => {
  // Review round 1 of 11H2 (reviewer B, D3): parseCacheSchedule refuses such a schedule now (cacheSettings.test.ts); the
  // rule of the run itself stays: never due once a run is known.
  it('is never due once a run is known (30 February)', () => {
    const cron = parseCronSchedule('0 0 30 2 *')!;
    expect(cacheRunDue({ kind: 'cron', cron, text: '0 0 30 2 *' }, NOW - 400 * DAY, NOW, 'UTC')).toBe(false);
  });
});

describe('11H2 review round 1 (A-M1, A-M2): a version that no open used, and one that a running container runs', () => {
  const released = [commit(5), commit(4), commit(3), commit(2), commit(1)];

  it('a version that no open used counts as unused; among the unnamed ones it is the oldest', () => {
    const stored = [
      { commit: commit(5), usedAt: undefined },
      { commit: commit(4), usedAt: undefined },
      { commit: commit(3), usedAt: undefined },
      { commit: commit(2), usedAt: NOW - DAY },
    ];
    expect(serversToRemove(stored, released, NOW)).toEqual([commit(3)]);
    const unnamed = [
      { commit: 'a'.repeat(40), usedAt: undefined },
      { commit: 'b'.repeat(40), usedAt: NOW - 20 * DAY },
      { commit: 'c'.repeat(40), usedAt: NOW - 30 * DAY },
    ];
    expect(serversToRemove(unnamed, [], NOW)).toEqual(['a'.repeat(40)]);
  });

  it('a version that a running container runs always stays', () => {
    const stored = [1, 2, 3, 4, 5].map((n) => ({ commit: commit(n), usedAt: NOW - 30 * DAY }));
    expect(serversToRemove(stored, released, NOW, new Set([commit(2), 'f'.repeat(40)])).sort()).toEqual([commit(1), commit(3)]);
  });

  it('finds the commits that stand alone in the processes of a container', () => {
    const c = commit(7);
    const found = commitsInProcesses([
      ['1000', '42', `/home/u/.vscode-server/bin/${c}/node`, `/home/u/.vscode-server-insiders/bin/${commit(8)}/out/server-main.js`],
      ['1000', '43', `/opt/devenv/vscode/server/stable/linux-x64/${commit(9)}/node --x`],
      ['1000', '44', `/home/u/.vscode-server/cli/servers/Stable-${commit(10)}/server/node`],
      // Not a commit: longer hex strings, upper case, too short.
      ['root', '1', `sha256:${'a'.repeat(64)} ${'b'.repeat(41)} ${'C'.repeat(40)} ${'d'.repeat(39)}`],
    ]);
    expect([...found].sort()).toEqual([c, commit(8), commit(9), commit(10)].sort());
    expect(commitsInProcesses([])).toEqual(new Set());
  });
});

describe('11H2 review round 1 (A-L4): the failed fetches of the run', () => {
  const VERSION = `stable-linux-x64-${commit(3)}`;

  it('are read strictly from the state: names of versions with a time, at most MAX_FAILED_FETCHES; else none', () => {
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: 1, failedFetches: { [VERSION]: NOW } }))).toEqual({ lastEndAt: 1, failedFetches: { [VERSION]: NOW } });
    expect(parseCacheRunState(JSON.stringify({ failedFetches: {} }))).toEqual({ failedFetches: {} });
    const many = Object.fromEntries(Array.from({ length: MAX_FAILED_FETCHES + 1 }, (_, n) => [`insider-linux-arm64-${commit(n)}`, NOW]));
    for (const failedFetches of [{ '../x': NOW }, { [VERSION]: -1 }, { [VERSION]: '1' }, { [`${VERSION}0`]: NOW }, [VERSION], null, many]) {
      expect(parseCacheRunState(JSON.stringify({ lastEndAt: 1, failedFetches })), JSON.stringify(failedFetches)).toEqual({ lastEndAt: 1 });
    }
  });

  it('a version is tried again a day after its failure, or when that time lies more than an hour ahead', () => {
    expect(FETCH_RETRY_MS).toBe(DAY);
    expect(fetchRetryDue(undefined, NOW)).toBe(true);
    expect(fetchRetryDue(NOW - DAY + 1, NOW)).toBe(false);
    expect(fetchRetryDue(NOW - DAY, NOW)).toBe(true);
    expect(fetchRetryDue(NOW + CLOCK_RESET_MS, NOW)).toBe(false);
    expect(fetchRetryDue(NOW + CLOCK_RESET_MS + 1, NOW)).toBe(true);
  });
});
