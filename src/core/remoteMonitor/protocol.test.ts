// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  isImagePrefix,
  DEFAULT_REMOTE_STOP_AFTER_SECONDS,
  MAX_HEARTBEAT_ENVIRONMENTS,
  REMOTE_MONITOR_SCRIPT_PATH,
  clampLimitSeconds,
  forgetCommand,
  heartbeatCommand,
  isUnderRecordsLock,
  monitorExecFailure,
  heartbeatFileName,
  inUseByOtherComputer,
  isRemoteEnvironmentId,
  isSourceId,
  parseHeartbeatFileName,
  parseHeartbeatInput,
  parseHeartbeatRecord,
  parseRecordsOutput,
  recordsCommand,
  remoteMonitorLabelValue,
} from './protocol';

const SOURCE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

const input = (value: unknown): string => JSON.stringify(value);

describe('ids of the heartbeat protocol', () => {
  it.each<[unknown, boolean]>([
    [SOURCE, true],
    [SOURCE.toUpperCase(), false],
    [SOURCE.slice(1), false],
    [`${SOURCE}0`, false],
    ['../../etc/passwd000000000000000000', false],
    [42, false],
  ])('source %j → %s', (value, expected) => {
    expect(isSourceId(value)).toBe(expected);
  });

  it.each<[unknown, boolean]>([
    [ID, true],
    [ID.toUpperCase(), false],
    [ID.slice(1), false],
    ['3f2a9c1e/5b7d-4e8a-9c0f-2d1e6a7b8c9d', false],
    ['3f2a9c1e.5b7d-4e8a-9c0f-2d1e6a7b8c9d', false],
    [undefined, false],
  ])('environment id %j → %s', (value, expected) => {
    expect(isRemoteEnvironmentId(value)).toBe(expected);
  });
});

describe('parseHeartbeatInput (strict)', () => {
  const valid = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: false, seq: 1_790_000_000_000 }] };

  it('accepts a valid heartbeat, also without environments', () => {
    expect(parseHeartbeatInput(input(valid))).toEqual(valid);
    expect(parseHeartbeatInput(input({ ...valid, environments: [] }))).toEqual({ ...valid, environments: [] });
  });

  it('clamps the limit to one minute..one day', () => {
    expect(parseHeartbeatInput(input({ ...valid, limitSeconds: 5 }))?.limitSeconds).toBe(60);
    expect(parseHeartbeatInput(input({ ...valid, limitSeconds: 10_000_000 }))?.limitSeconds).toBe(86_400);
  });

  it.each<[string, unknown]>([
    ['not JSON', '{'],
    ['an array', [valid]],
    ['null', null],
    ['an unknown key', { ...valid, extra: 1 }],
    ['a missing key', { source: SOURCE, limitSeconds: 600 }],
    ['an invalid source', { ...valid, source: 'x' }],
    ['a limit that is no integer', { ...valid, limitSeconds: 60.5 }],
    ['a limit as text', { ...valid, limitSeconds: '600' }],
    ['environments that are no list', { ...valid, environments: {} }],
    ['an environment with an invalid id', { ...valid, environments: [{ id: '../x', keepRunning: true, seq: 1 }] }],
    ['an environment with keepRunning as text', { ...valid, environments: [{ id: ID, keepRunning: 'true', seq: 1 }] }],
    ['an environment with an unknown key', { ...valid, environments: [{ id: ID, keepRunning: true, seq: 1, x: 1 }] }],
    // Review round 2 of PR #39 (L1): every entry carries its seq, a safe non-negative integer.
    ['an environment without seq', { ...valid, environments: [{ id: ID, keepRunning: true }] }],
    ['a negative seq', { ...valid, environments: [{ id: ID, keepRunning: true, seq: -1 }] }],
    ['a seq that is no integer', { ...valid, environments: [{ id: ID, keepRunning: true, seq: 1.5 }] }],
    ['a seq beyond the safe integers', { ...valid, environments: [{ id: ID, keepRunning: true, seq: 2 ** 60 }] }],
    ['a seq as text', { ...valid, environments: [{ id: ID, keepRunning: true, seq: '1' }] }],
    ['an environment that is no object', { ...valid, environments: [ID] }],
    [
      'too many environments',
      { ...valid, environments: Array.from({ length: MAX_HEARTBEAT_ENVIRONMENTS + 1 }, () => ({ id: ID, keepRunning: false, seq: 1 })) },
    ],
  ])('refuses %s', (_name, value) => {
    expect(parseHeartbeatInput(typeof value === 'string' ? value : input(value))).toBeUndefined();
  });

  // Review round 3 of PR #39 (N1).
  it('accepts clearOnly as a boolean, and true only without keepRunning', () => {
    const entry = (extra: Record<string, unknown>) => input({ ...valid, environments: [{ id: ID, keepRunning: false, seq: 1, ...extra }] });
    expect(parseHeartbeatInput(entry({ clearOnly: true }))?.environments).toEqual([{ id: ID, keepRunning: false, seq: 1, clearOnly: true }]);
    expect(parseHeartbeatInput(entry({ clearOnly: false }))?.environments).toEqual([{ id: ID, keepRunning: false, seq: 1 }]);
    expect(parseHeartbeatInput(entry({ clearOnly: true, keepRunning: true }))).toBeUndefined();
    expect(parseHeartbeatInput(entry({ clearOnly: 'yes' }))).toBeUndefined();
    expect(parseHeartbeatInput(entry({ clearOnly: 1 }))).toBeUndefined();
  });

  it('accepts the largest number of environments', () => {
    const environments = Array.from({ length: MAX_HEARTBEAT_ENVIRONMENTS }, () => ({ id: ID, keepRunning: true, seq: 0 }));
    expect(parseHeartbeatInput(input({ ...valid, environments }))?.environments).toHaveLength(MAX_HEARTBEAT_ENVIRONMENTS);
  });

  it('refuses a text that is too long', () => {
    expect(parseHeartbeatInput(' '.repeat(40_000) + input(valid))).toBeUndefined();
  });
});

describe('records and their file names', () => {
  it('parses a valid record and refuses invalid ones', () => {
    expect(parseHeartbeatRecord(input({ at: 1000, keepRunning: true, limitSeconds: 600, seq: 7 }))).toEqual({ at: 1000, keepRunning: true, limitSeconds: 600, seq: 7 });
    for (const value of [
      { at: -1, keepRunning: true, limitSeconds: 600, seq: 7 },
      { at: 1.5, keepRunning: true, limitSeconds: 600, seq: 7 },
      { at: 1000, keepRunning: 'yes', limitSeconds: 600, seq: 7 },
      { at: 1000, keepRunning: true, limitSeconds: 59, seq: 7 },
      { at: 1000, keepRunning: true, limitSeconds: 86_401, seq: 7 },
      { at: 1000, keepRunning: true, seq: 7 },
      // A record without seq is invalid (review round 2 of PR #39, L1).
      { at: 1000, keepRunning: true, limitSeconds: 600 },
      { at: 1000, keepRunning: true, limitSeconds: 600, seq: -3 },
      [1000],
    ]) {
      expect(parseHeartbeatRecord(input(value)), JSON.stringify(value)).toBeUndefined();
    }
    expect(parseHeartbeatRecord('not json')).toBeUndefined();
  });

  it('names a record <source>.<environment id>.json, and parses only such names', () => {
    const name = heartbeatFileName(SOURCE, ID);
    expect(name).toBe(`${SOURCE}.${ID}.json`);
    expect(parseHeartbeatFileName(name)).toEqual({ source: SOURCE, environmentId: ID });
    for (const other of [`.${name}.12.tmp`, `${SOURCE}.${ID}.json.bak`, `${SOURCE}.${ID}`, 'x.json', `../${name}`]) {
      expect(parseHeartbeatFileName(other), other).toBeUndefined();
    }
    expect(() => heartbeatFileName('../x', ID)).toThrow();
    expect(() => heartbeatFileName(SOURCE, '../x')).toThrow();
  });
});

describe('the subcommands of the remote monitor', () => {
  it('passes the heartbeat as one JSON argument, and the ids as arguments', () => {
    const heartbeat = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: true, seq: 5 }] };
    // Review round 2 of PR #58: the heartbeat runs under the kernel lock of the records and a time limit; review round 3
    // (F7): a lock that stays busy has its own exit code, and (F6) `forget` runs under the same lock.
    const locked = ['flock', '-w', '5', '-E', '75', '/state/.heartbeats.lock', 'timeout', '-s', 'KILL', '10'];
    expect(heartbeatCommand(heartbeat)).toEqual([...locked, 'node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat', JSON.stringify(heartbeat)]);
    expect(recordsCommand(ID)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'records', ID]);
    expect(forgetCommand(SOURCE, ID)).toEqual([...locked, 'node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID]);
  });

  // Review round 3 of PR #58 (F7): a busy lock and the time limit are named in the log, not only their exit codes.
  // Review round 4 (H2): 137 is any SIGKILL, and only commands under the lock get these texts.
  it('names the reason of a failed command under the lock of the records', () => {
    expect(monitorExecFailure(75, '', true)).toBe('the heartbeat records stayed locked by another command for 5 s');
    expect(monitorExecFailure(137, '', true)).toBe('the command was killed (its limit of 10 s, or a kill from outside)');
    expect(monitorExecFailure(2, 'Invalid heartbeat.\n', true)).toBe('Invalid heartbeat.');
    expect(monitorExecFailure(1, ' ', true)).toBe('exit code 1');
    expect(monitorExecFailure(137, '', false)).toBe('exit code 137');
    expect(monitorExecFailure(75, '', false)).toBe('exit code 75');
    expect(isUnderRecordsLock(heartbeatCommand({ source: SOURCE, limitSeconds: 600, environments: [] }))).toBe(true);
    expect(isUnderRecordsLock(forgetCommand(SOURCE, ID))).toBe(true);
    expect(isUnderRecordsLock(recordsCommand(ID))).toBe(false);
  });

  it('parses the output of records, and refuses anything else', () => {
    const output = { now: 5000, records: [{ source: SOURCE, at: 4000, keepRunning: false }] };
    expect(parseRecordsOutput(`${input(output)}\n`)).toEqual(output);
    expect(parseRecordsOutput('')).toBeUndefined();
    expect(parseRecordsOutput(input({ now: 'x', records: [] }))).toBeUndefined();
    expect(parseRecordsOutput(input({ now: 1, records: [{ source: 'x', at: 1, keepRunning: false }] }))).toBeUndefined();
  });

  it('counts only a fresh record of another computer as "in use from another computer" (shared engine)', () => {
    const now = 1_000_000;
    expect(inUseByOtherComputer({ now, records: [{ source: OTHER, at: now - 89_000, keepRunning: false }] }, SOURCE)).toBe(true);
    expect(inUseByOtherComputer({ now, records: [{ source: OTHER, at: now - 91_000, keepRunning: false }] }, SOURCE)).toBe(false);
    // The own record never counts.
    expect(inUseByOtherComputer({ now, records: [{ source: SOURCE, at: now, keepRunning: false }] }, SOURCE)).toBe(false);
    expect(inUseByOtherComputer({ now, records: [] }, SOURCE)).toBe(false);
    // Another computer keeps it running, however old its record, as long as this computer made no newer choice.
    const old = now - 30 * 24 * 3_600_000;
    expect(inUseByOtherComputer({ now, records: [{ source: OTHER, at: old, keepRunning: true }] }, SOURCE)).toBe(true);
    expect(inUseByOtherComputer({ now, records: [{ source: SOURCE, at: 1, keepRunning: true }] }, SOURCE)).toBe(false);
    // Review round 2 of PR #39 (M1): the newest record decides. A newer record of this computer overrules an older keep
    // of another one (for example a computer that no longer sends); a keep that is at least as new still holds.
    const own = (at: number) => ({ source: SOURCE, at, keepRunning: false });
    expect(inUseByOtherComputer({ now, records: [{ source: OTHER, at: old, keepRunning: true }, own(old + 1)] }, SOURCE)).toBe(false);
    expect(inUseByOtherComputer({ now, records: [{ source: OTHER, at: old + 1, keepRunning: true }, own(old)] }, SOURCE)).toBe(true);
    expect(inUseByOtherComputer({ now, records: [{ source: OTHER, at: old, keepRunning: true }, own(old)] }, SOURCE)).toBe(true);
    // A fresh heartbeat of another computer counts whatever this computer sent.
    expect(inUseByOtherComputer({ now, records: [{ source: OTHER, at: now - 1000, keepRunning: false }, own(now)] }, SOURCE)).toBe(true);
  });
});

describe('limits and the label', () => {
  it('clamps a limit, and gives the default for a value that is no number', () => {
    expect(clampLimitSeconds(600)).toBe(600);
    expect(clampLimitSeconds(1)).toBe(60);
    expect(clampLimitSeconds(1e9)).toBe(86_400);
    expect(clampLimitSeconds(Number.NaN)).toBe(DEFAULT_REMOTE_STOP_AFTER_SECONDS);
  });

  it('labels the container with 12 hex digits of the script and the helper tag', () => {
    const label = remoteMonitorLabelValue('script', 'devenv-helper:1');
    expect(label).toMatch(/^[0-9a-f]{12}$/);
    expect(remoteMonitorLabelValue('script', 'devenv-helper:1')).toBe(label);
    expect(remoteMonitorLabelValue('script2', 'devenv-helper:1')).not.toBe(label);
    expect(remoteMonitorLabelValue('script', 'devenv-helper:2')).not.toBe(label);
  });
});

// Review round 9 of PR #57 (T2): the pattern of the setting and isImagePrefix agree, so no pattern that the settings UI
// accepts is left out without a word.
describe('the pattern of devEnvLauncher.remoteImageUpdates', () => {
  it('accepts exactly what the code takes', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
      contributes: { configuration: Array<{ properties?: Record<string, { items?: { pattern?: string } }> }> | { properties?: Record<string, { items?: { pattern?: string } }> } };
    };
    const sections = ([] as Array<{ properties?: Record<string, { items?: { pattern?: string } }> }>).concat(manifest.contributes.configuration);
    const pattern = new RegExp(sections.find((section) => section.properties?.['devEnvLauncher.remoteImageUpdates'])!.properties!['devEnvLauncher.remoteImageUpdates'].items!.pattern!);
    for (const value of [
      'ghcr.io/majikmate/devcontainer-dev*',
      'ghcr.io/majikmate/devcontainer-dev',
      `ghcr.io/${'a'.repeat(120)}*`,
      `ghcr.io/${'a'.repeat(121)}`,
      'ghcr.io/a..b*',
      'docker.io/library/ubuntu*',
      'owner/repo*',
      'localhost:5000/a/b*',
      'registry:5000/x*',
      'GHCR.io/x*',
    ]) {
      expect(pattern.test(value), value).toBe(isImagePrefix(value.replace(/\*$/, '')));
    }
  });
});
