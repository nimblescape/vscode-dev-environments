// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Hotfix review 3, C3-2: the items of a refusal are bounded in length, not only in number.
import { describe, expect, it } from 'vitest';
import { resourceName } from '../names';
import { helperCliVariables } from './cliVariables';
import { MAX_ITEM_LENGTH, MAX_LISTED_ITEMS, hostAccessProblems, hostAccessReport, truncated } from '../policy';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
// User decisions 2026-10-03: one name per environment (resourceName); the project, the volume, and the container share it.
const OWN = resourceName('acme/api', ID);
const variables = helperCliVariables('acme/api');
const half = MAX_ITEM_LENGTH / 2;

describe('hotfix review 3, C3-2: long items', () => {
  it('truncates a long item after ${devcontainerId} is named as the configuration writes it', () => {
    const mount = `type=bind,src=/x/\${devcontainerId:y}/${'a'.repeat(1000)}z,dst=/y`;
    const whole = `bind mount /x/\${devcontainerId}/${'a'.repeat(1000)}z`;
    expect(hostAccessProblems({ ownVolume: OWN, variables, metadata: [{ mounts: [mount] }] })).toEqual([`${whole.slice(0, half)}…${whole.slice(-half)}`]);
  });

  it('truncates an item with a long leftover variable, and keeps why it is refused', () => {
    const entry = `\${localEnv:TERM:${'B'.repeat(5000)}}`;
    const [item] = hostAccessReport({ ownVolume: OWN, variables, config: { runArgs: [entry] } }).unsupported;
    expect(item).toHaveLength(MAX_ITEM_LENGTH + 1);
    expect(item.startsWith(`runArgs "\${localEnv:TERM:${'B'.repeat(50)}`)).toBe(true);
    expect(item.endsWith(`${'B'.repeat(50)}}, which cannot be checked`)).toBe(true);
  });

  it('keeps the report small for many long items', () => {
    const runArgs: string[] = [];
    // Each entry is different, and its substitution is longer than the entry (a default value with many variables).
    for (let i = 0; i < 100; i++) runArgs.push(`\${localEnv:TERM:${i}${'${localEnv:TERM}'.repeat(200)}}`);
    const report = hostAccessReport({ ownVolume: OWN, variables, config: { runArgs } });
    expect(report.unsupported).toHaveLength(MAX_LISTED_ITEMS + 1);
    for (const item of report.unsupported) expect(item.length).toBeLessThanOrEqual(MAX_ITEM_LENGTH + 1);
    expect(report.unsupported.join(', ').length).toBeLessThan((MAX_LISTED_ITEMS + 1) * (MAX_ITEM_LENGTH + 3));
    expect(report.unsupported[MAX_LISTED_ITEMS]).toBe('and 80 more');
  });

  it('keeps the start and the end, and does not cut a surrogate pair in half', () => {
    expect(truncated('short', 200)).toBe('short');
    expect(truncated(`${'x'.repeat(100)}-${'y'.repeat(100)}`, 200)).toBe(`${'x'.repeat(100)}…${'y'.repeat(100)}`);
    expect(truncated(`${'x'.repeat(99)}😀${'-'.repeat(50)}😀${'y'.repeat(99)}`, 200)).toBe(`${'x'.repeat(99)}…${'y'.repeat(99)}`);
  });
});
