// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Hotfix review 4: Q1 (the workspace folder of a repository named *.code-workspace) and Q2 (bind sources are shown
// normalized, so that the truncation of an item cannot hide what the mount reaches).
import { describe, expect, it } from 'vitest';
import { helperCliVariables } from './cliVariables';
import { MAX_ITEM_LENGTH, hostAccessReport, mountedVolumeNames } from './hostAccess';

const OWN = 'devenv-acme-api-3f2a9c1e';

describe('hotfix review 4, Q1: a repository named *.code-workspace', () => {
  it('checks the volume that the CLI mounts for ${localWorkspaceFolderBasename}', () => {
    const variables = helperCliVariables('mallory/evil.code-workspace');
    const input = { ownVolume: 'devenv-evil.code-workspace-11111111', environment: { id: 'attackerenv', ownerId: '1' }, variables };
    const metadata = [{ mounts: ['type=volume,source=${localWorkspaceFolderBasename}-node_modules,target=/x'] }];
    // hotfix review 5, A5-1: `up` mounts evil.code-workspace-node_modules (the repository folder), not workspaces-node_modules.
    expect(mountedVolumeNames({ ...input, metadata })).toEqual(['evil.code-workspace-node_modules']);
    const victim = { 'devenv.environment-id': 'victimenv', 'devenv.owner-id': '2', 'devenv.volume': 'additional' };
    // hotfix review 5, A5-1: the volume that `up` mounts.
    const report = hostAccessReport({ ...input, metadata, volumeLabels: { 'evil.code-workspace-node_modules': victim } }, false);
    expect(report.hostAccess).toHaveLength(1);
    // hotfix review 5, A5-1: the item names the volume that `up` mounts.
    expect(report.hostAccess[0]).toContain('evil.code-workspace-node_modules');
  });
});

describe('hotfix review 4, Q2: bind sources are shown normalized', () => {
  const hidden = '/Users/me/proj/src' + '/.'.repeat(60) + '/../../../../..' + '/Users/me/.ssh' + '/.'.repeat(60);

  it('a bind mount of `mounts`', () => {
    const report = hostAccessReport({ ownVolume: OWN, metadata: [{ mounts: [`type=bind,source=${hidden},target=/cache`] }] }, true);
    expect(report.hostAccess).toEqual(['bind mount /Users/me/.ssh']);
  });

  it('a volume of type volume with a path, and a mount without a type', () => {
    const report = hostAccessReport({ ownVolume: OWN, config: { mounts: [`type=volume,source=${hidden},target=/a`, `source=${hidden},target=/b`] } }, true);
    expect(report.hostAccess).toEqual(['bind mount /Users/me/.ssh']);
  });

  it('a bind mount of -v in runArgs', () => {
    const report = hostAccessReport({ ownVolume: OWN, config: { runArgs: ['-v', `${hidden}:/cache`] } }, true);
    expect(report.hostAccess).toEqual(['bind mount /Users/me/.ssh']);
  });

  it('a Windows drive path, and relative paths', () => {
    const drive = 'C:\\Users\\me\\proj' + '\\.'.repeat(80) + '\\..\\..\\.ssh';
    expect(hostAccessReport({ ownVolume: OWN, config: { runArgs: ['-v', `${drive}:/cache`] } }, true).hostAccess).toEqual(['bind mount C:\\Users\\.ssh']);
    const relative = hostAccessReport({ ownVolume: OWN, config: { runArgs: ['-v', './a/../b:/x', '-v', `.${'/.'.repeat(120)}/../../etc:/y`] } }, true);
    expect(relative.hostAccess).toEqual(['bind mount ./b', 'bind mount ../../etc']);
  });

  it('a long normalized source is still truncated', () => {
    const long = `/${'a'.repeat(1000)}/${'./'.repeat(50)}z`;
    const [item] = hostAccessReport({ ownVolume: OWN, config: { mounts: [`type=bind,source=${long},target=/x`] } }, true).hostAccess;
    expect(item).toHaveLength(MAX_ITEM_LENGTH + 1);
    expect(item.endsWith('aaa/z')).toBe(true);
  });
});
