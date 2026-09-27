// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMOTE_STOP_AFTER_SECONDS,
  MAX_HEARTBEAT_ENVIRONMENTS,
  REMOTE_MONITOR_SCRIPT_PATH,
  clampLimitSeconds,
  forgetCommand,
  heartbeatCommand,
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
  const valid = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: false }] };

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
    ['an environment with an invalid id', { ...valid, environments: [{ id: '../x', keepRunning: true }] }],
    ['an environment with keepRunning as text', { ...valid, environments: [{ id: ID, keepRunning: 'true' }] }],
    ['an environment with an unknown key', { ...valid, environments: [{ id: ID, keepRunning: true, x: 1 }] }],
    ['an environment that is no object', { ...valid, environments: [ID] }],
    [
      'too many environments',
      { ...valid, environments: Array.from({ length: MAX_HEARTBEAT_ENVIRONMENTS + 1 }, () => ({ id: ID, keepRunning: false })) },
    ],
  ])('refuses %s', (_name, value) => {
    expect(parseHeartbeatInput(typeof value === 'string' ? value : input(value))).toBeUndefined();
  });

  it('accepts the largest number of environments', () => {
    const environments = Array.from({ length: MAX_HEARTBEAT_ENVIRONMENTS }, () => ({ id: ID, keepRunning: true }));
    expect(parseHeartbeatInput(input({ ...valid, environments }))?.environments).toHaveLength(MAX_HEARTBEAT_ENVIRONMENTS);
  });

  it('refuses a text that is too long', () => {
    expect(parseHeartbeatInput(' '.repeat(40_000) + input(valid))).toBeUndefined();
  });
});

describe('records and their file names', () => {
  it('parses a valid record and refuses invalid ones', () => {
    expect(parseHeartbeatRecord(input({ at: 1000, keepRunning: true, limitSeconds: 600 }))).toEqual({ at: 1000, keepRunning: true, limitSeconds: 600 });
    for (const value of [
      { at: -1, keepRunning: true, limitSeconds: 600 },
      { at: 1.5, keepRunning: true, limitSeconds: 600 },
      { at: 1000, keepRunning: 'yes', limitSeconds: 600 },
      { at: 1000, keepRunning: true, limitSeconds: 59 },
      { at: 1000, keepRunning: true, limitSeconds: 86_401 },
      { at: 1000, keepRunning: true },
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
    const heartbeat = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: true }] };
    expect(heartbeatCommand(heartbeat)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat', JSON.stringify(heartbeat)]);
    expect(recordsCommand(ID)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'records', ID]);
    expect(forgetCommand(SOURCE, ID)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID]);
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
    // Review round 1 of PR #39 (F2): another computer keeps it running, however old its record.
    expect(inUseByOtherComputer({ now, records: [{ source: OTHER, at: now - 30 * 24 * 3_600_000, keepRunning: true }] }, SOURCE)).toBe(true);
    expect(inUseByOtherComputer({ now, records: [{ source: SOURCE, at: 1, keepRunning: true }] }, SOURCE)).toBe(false);
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
