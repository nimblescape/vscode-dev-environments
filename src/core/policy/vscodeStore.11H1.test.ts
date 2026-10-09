// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"; hazard 2 of the survey of 11H): the host access
// policy protects the shared VS Code server store. A repository can name the volume devenv-vscode in no spelling (its
// mounts, its runArgs, its Docker Compose model), read-only or not, whatever the switch of the checks says, and can mount
// nothing at or below its target /opt/devenv/vscode. Only the exact `--mount` that the override configuration adds is
// allowed, in the override configuration and in the merged configuration (which holds it for an existing container).
import { describe, expect, it } from 'vitest';
import { COMPOSE_CLEARED_LABELS, VSCODE_STORE_TARGET, VSCODE_STORE_VOLUME, composeProjectName, resourceName, vscodeStoreMount } from '../names';
import { buildOverrideConfig } from '../helper/devcontainerCli';
import { checkContainer, composeAccessReport, configFolderTarget, foreignVolumeName, hostAccessReport, type ComposeAccessInput, type HostAccessInput } from '.';

const ID = 'e0000001-0000-4000-8000-000000000001';
const OWN = resourceName('acme/api', ID);
const ENVIRONMENT = { id: ID, ownerId: '1001' };
const STORE_ITEM = 'volume devenv-vscode of the shared VS Code server store';
const INTERNAL = "mounts into the extension's internal folder are not supported";
const OUR_MOUNT = vscodeStoreMount(VSCODE_STORE_VOLUME);

function input(config: Record<string, unknown>, more: Partial<HostAccessInput> = {}): HostAccessInput {
  return { config, ownVolume: OWN, environment: ENVIRONMENT, ...more };
}

describe('the name and the target of the shared VS Code server store (plan step 11H1)', () => {
  it('are fixed: devenv-vscode, read-only at /opt/devenv/vscode', () => {
    expect(VSCODE_STORE_VOLUME).toBe('devenv-vscode');
    expect(VSCODE_STORE_TARGET).toBe('/opt/devenv/vscode');
    expect(OUR_MOUNT).toBe('type=volume,source=devenv-vscode,target=/opt/devenv/vscode,readonly');
    expect(foreignVolumeName('devenv-vscode')).toBe('the shared VS Code server store');
    // Only the exact name.
    expect(foreignVolumeName('devenv-vscode2')).toBeUndefined();
  });

  it('reserves the target and every path below it, not its parents or a folder that only starts like it', () => {
    expect(configFolderTarget('/opt/devenv/vscode')).toBe('/opt/devenv/vscode');
    expect(configFolderTarget('/opt/devenv/vscode/')).toBe('/opt/devenv/vscode');
    expect(configFolderTarget('/opt/devenv/vscode/server/stable')).toBe('/opt/devenv/vscode/server/stable');
    expect(configFolderTarget('/opt/devenv/x/../vscode/server')).toBe('/opt/devenv/vscode/server');
    expect(configFolderTarget('/opt/devenv')).toBeUndefined();
    expect(configFolderTarget('/opt')).toBeUndefined();
    expect(configFolderTarget('/opt/devenv/vscodex')).toBeUndefined();
  });
});

describe('a repository never names the store (plan step 11H1)', () => {
  // Each spelling of a single container, with the checks on and off (the class `protected` is never lifted).
  const spellings: Array<[string, Record<string, unknown>]> = [
    ['a mounts text', { mounts: ['source=devenv-vscode,target=/x,type=volume'] }],
    ['a read-only mounts text', { mounts: ['source=devenv-vscode,target=/x,type=volume,readonly'] }],
    ['a mounts object', { mounts: [{ type: 'volume', source: 'devenv-vscode', target: '/x' }] }],
    ['a read-only mounts object', { mounts: [{ type: 'volume', source: 'devenv-vscode', target: '/x', readonly: true }] }],
    ['--mount in runArgs', { runArgs: ['--mount', 'type=volume,source=devenv-vscode,target=/x,readonly'] }],
    ['--mount= in runArgs', { runArgs: ['--mount=type=volume,src=devenv-vscode,dst=/x'] }],
    ['-v in runArgs', { runArgs: ['-v', 'devenv-vscode:/x:ro'] }],
    ['--volume in runArgs', { runArgs: ['--volume', 'devenv-vscode:/x'] }],
    ['--volume= in runArgs', { runArgs: ['--volume=devenv-vscode:/x'] }],
  ];
  it.each(spellings.flatMap(([name, config]) => [true, false].map((checksOn) => [name, config, checksOn] as const)))('refuses %s (checks on: %s)', (_name, config, checksOn) => {
    expect(hostAccessReport(input(config), checksOn).hostAccess).toEqual([STORE_ITEM]);
  });

  it('refuses the name in the image metadata too', () => {
    expect(hostAccessReport({ ownVolume: OWN, environment: ENVIRONMENT, metadata: [{ mounts: ['source=devenv-vscode,target=/x,type=volume'] }] }, false).hostAccess).toEqual([STORE_ITEM]);
  });

  it.each([true, false])('refuses every mount at or below the target, of any kind (checks on: %s)', (checksOn) => {
    expect(hostAccessReport(input({ mounts: ['source=data,target=/opt/devenv/vscode/server,type=volume'] }), checksOn).unsupported).toEqual([`mount at /opt/devenv/vscode/server (${INTERNAL})`]);
    expect(hostAccessReport(input({ mounts: [{ type: 'tmpfs', target: '/opt/devenv/vscode' }] }), checksOn).unsupported).toEqual([`mount at /opt/devenv/vscode (${INTERNAL})`]);
    expect(hostAccessReport(input({ runArgs: ['--tmpfs', '/opt/devenv/vscode'] }), checksOn).unsupported).toEqual([`mount at /opt/devenv/vscode (${INTERNAL})`]);
    expect(hostAccessReport(input({ runArgs: ['-v', 'data:/opt/devenv/vscode/server/stable'] }), checksOn).unsupported).toEqual([`mount at /opt/devenv/vscode/server/stable (${INTERNAL})`]);
    // A parent of the target: the store is mounted over it.
    expect(hostAccessReport(input({ mounts: ['source=data,target=/opt/devenv,type=volume'] }), checksOn)).toEqual({ hostAccess: [], unsupported: [] });
  });
});

describe('the override configuration mounts the store, exactly so (plan step 11H1)', () => {
  const override = buildOverrideConfig({ environmentImage: 'img', volumeName: OWN, repositoryName: 'api', containerName: OWN, runArgs: [], vscodeStoreVolume: VSCODE_STORE_VOLUME });
  const runArgs = override.runArgs as string[];

  it('allows the mount of the override configuration at the stage finalRunArgs, with the checks on and off', () => {
    expect(runArgs.slice(-2)).toEqual(['--mount', OUR_MOUNT]);
    expect(checkContainer('finalRunArgs', { ...input({ runArgs }), checks: 'on' })).toEqual({ hostAccess: [], unsupported: [] });
    expect(checkContainer('finalRunArgs', { ...input({ runArgs }), checks: 'off' })).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('allows it in the merged configuration of an existing container, which holds the runArgs of the override', () => {
    expect(hostAccessReport(input({ runArgs: [] }, { merged: { runArgs } }))).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('refuses the same text in the runArgs of the repository: they are checked without the exemption', () => {
    // Decision of this PR (as `--tmpfs TOKEN_TMPFS`, unit 15): the exemption holds only for the lists of the override and
    // the merged configuration; the repository's own runArgs are checked as written, so a repository that writes the
    // text itself is refused at the stage configuration, before any override exists (its position does not matter).
    const own = input({ runArgs: ['--mount', OUR_MOUNT] });
    expect(checkContainer('configuration', { ...own, checks: 'on' })).toEqual({ hostAccess: [STORE_ITEM], unsupported: [`mount at /opt/devenv/vscode (${INTERNAL})`] });
    expect(checkContainer('configuration', { ...own, checks: 'off' })).toEqual({ hostAccess: [STORE_ITEM], unsupported: [`mount at /opt/devenv/vscode (${INTERNAL})`] });
    // Also when the merged configuration has it too.
    expect(hostAccessReport(input({ runArgs: ['--mount', OUR_MOUNT] }, { merged: { runArgs: ['--mount', OUR_MOUNT] } })).hostAccess).toEqual([STORE_ITEM]);
  });

  it.each([
    ['without readonly', 'type=volume,source=devenv-vscode,target=/opt/devenv/vscode'],
    ['readonly first', 'readonly,type=volume,source=devenv-vscode,target=/opt/devenv/vscode'],
    ['with src and dst', 'type=volume,src=devenv-vscode,dst=/opt/devenv/vscode,readonly'],
    ['ro=true', 'type=volume,source=devenv-vscode,target=/opt/devenv/vscode,ro=true'],
    ['another target', 'type=volume,source=devenv-vscode,target=/opt/vscode,readonly'],
    ['with a subpath', 'type=volume,source=devenv-vscode,target=/opt/devenv/vscode,readonly,volume-subpath=server'],
  ])('refuses any other text in the override configuration (%s)', (_name, value) => {
    const report = checkContainer('finalRunArgs', { ...input({ runArgs: ['--mount', value] }), checks: 'off' });
    expect(report.hostAccess.length + report.unsupported.length).toBeGreaterThan(0);
  });

  it('refuses -v with the store in the override configuration', () => {
    const report = checkContainer('finalRunArgs', { ...input({ runArgs: ['-v', 'devenv-vscode:/opt/devenv/vscode:ro'] }), checks: 'off' });
    expect(report.hostAccess).toEqual([STORE_ITEM]);
  });

  it('allows the mount of the store of the worker (a volume of the Docker tests) only when the input names it', () => {
    const test = vscodeStoreMount('devenv-test-vscode-x');
    const args = ['--mount', test];
    expect(checkContainer('finalRunArgs', { ...input({ runArgs: args }, { vscodeStoreVolume: 'devenv-test-vscode-x' }), checks: 'on' })).toEqual({ hostAccess: [], unsupported: [] });
    // Without it, the exemption is the one of devenv-vscode: the other volume at the reserved target is refused.
    expect(checkContainer('finalRunArgs', { ...input({ runArgs: args }), checks: 'on' }).unsupported).toEqual([`mount at /opt/devenv/vscode (${INTERNAL})`]);
    // With it, devenv-vscode itself is no longer exempt (the name stays protected).
    expect(checkContainer('finalRunArgs', { ...input({ runArgs: ['--mount', OUR_MOUNT] }, { vscodeStoreVolume: 'devenv-test-vscode-x' }), checks: 'on' }).hostAccess).toEqual([STORE_ITEM]);
  });

  it('leaves the other exemptions of the override configuration as they were', () => {
    const labels = COMPOSE_CLEARED_LABELS.flatMap((label) => ['--label', label]);
    expect(checkContainer('finalRunArgs', { ...input({ runArgs: [...labels, '--mount', OUR_MOUNT] }), checks: 'on' })).toEqual({ hostAccess: [], unsupported: [] });
  });
});

describe('a Docker Compose model never names the store (plan step 11H1)', () => {
  const PROJECT = composeProjectName('acme/api', ID);
  const report = (service: Record<string, unknown>, volumes: Record<string, unknown>, checksOn: boolean) => {
    const access: ComposeAccessInput = {
      model: { name: PROJECT, services: { app: { image: 'alpine:3.22', ...service }, db: { image: 'postgres:16' } }, volumes: volumes as never },
      devService: 'app',
      project: PROJECT,
      repositoryFolder: '/workspaces/api',
      ownVolume: OWN,
      engineApiVersion: '1.47',
      environment: { id: ID, ownerId: '1001' },
    };
    return composeAccessReport(access, checksOn);
  };

  it.each([true, false])('refuses the volume by its name in the long and the short syntax, and the key of the up model (checks on: %s)', (checksOn) => {
    // Long syntax, a key whose name is the store.
    expect(report({ volumes: [{ type: 'volume', source: 'store', target: '/x', read_only: true }] }, { store: { name: 'devenv-vscode', external: true } }, checksOn).hostAccess).toEqual([STORE_ITEM]);
    // Short syntax.
    expect(report({ volumes: ['store:/x:ro'] }, { store: { name: 'devenv-vscode', external: true } }, checksOn).hostAccess).toEqual([STORE_ITEM]);
    // The key of the up model (an external volume of the key's name is the store).
    expect(report({ volumes: [{ type: 'volume', source: 'devenv-vscode', target: '/x' }] }, { 'devenv-vscode': { external: true } }, checksOn)).toEqual({
      hostAccess: [STORE_ITEM],
      unsupported: ['volume key devenv-vscode (Dev Environments uses it)'],
    });
  });

  it.each([true, false])('refuses a mount of the dev service at or below the target (checks on: %s)', (checksOn) => {
    expect(report({ volumes: [{ type: 'volume', source: 'data', target: '/opt/devenv/vscode' }] }, { data: {} }, checksOn).unsupported).toEqual([`service app: mount at /opt/devenv/vscode (${INTERNAL})`]);
    expect(report({ tmpfs: ['/opt/devenv/vscode/server'] }, {}, checksOn).unsupported).toEqual([`service app: tmpfs /opt/devenv/vscode/server (${INTERNAL})`]);
  });
});
