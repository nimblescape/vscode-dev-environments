// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ATTACHED_CONTAINER,
  ATTACHED_CONTAINER_ACTIVATION_EVENT,
  ATTACHED_SHUTDOWN_ACTION,
  DEV_CONTAINERS_VOLUMES,
  devContainersSettings,
  exposingLocalPortHostValues,
  forwardingHelperReachesGit,
  hasDevContainersVolumeLabel,
  isDevContainersCloneVolumeName,
  SKIP_POST_ATTACH_ARG,
} from './devContainers';

describe('authority of attached containers (NFR-06)', () => {
  it('is activated by package.json for the authority of attached containers', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      activationEvents: string[];
    };
    expect(ATTACHED_CONTAINER_ACTIVATION_EVENT).toBe(`onResolveRemoteAuthority:${ATTACHED_CONTAINER}`);
    expect(manifest.activationEvents).toContain(`onResolveRemoteAuthority:${ATTACHED_CONTAINER}`);
  });

  it('names the remote of attached containers attached-container', () => {
    expect(ATTACHED_CONTAINER).toBe('attached-container');
  });
});

describe('settings of the Dev Containers extension for the container (concept section 9 "Git inside the container")', () => {
  it.each<[string, boolean | string]>([
    ['dev.containers.copyGitConfig', false],
    ['remote.containers.copyGitConfig', false],
    ['dev.containers.gitCredentialHelperConfigLocation', 'none'],
    ['dev.containers.dockerCredentialHelper', false],
    ['dev.containers.githubCLILoginWithToken', false],
  ])('%s is %s', (key, value) => {
    expect(devContainersSettings()[key]).toBe(value);
  });

  it('has only these flat keys, as the extension reads them', () => {
    const settings = devContainersSettings();
    expect(Object.keys(settings)).toHaveLength(5);
    for (const value of Object.values(settings)) expect(typeof value === 'boolean' || typeof value === 'string').toBe(true);
  });

  /**
   * What the Dev Containers extension reads for the container (remote-containers 0.470.0, extension.js): the settings of
   * all entries of the label merged with Object.assign in their order (function Coe; the override configuration is the
   * last entry), read by class kv (`getConfiguration`: new key || old key; `getNewConfiguration`: new key), with the
   * user setting only for `undefined` and `null` (`??`). The user of these tests switched every forwarding on.
   */
  function effective(entries: Array<Record<string, unknown>>): Record<string, unknown> {
    const settings: Record<string, unknown> = Object.assign({}, ...entries);
    const user = { copyGitConfig: true, gitCredentialHelperConfigLocation: 'global', dockerCredentialHelper: true, githubCLILoginWithToken: true };
    const getConfiguration = (name: string) => settings[`dev.containers.${name}`] || settings[`remote.containers.${name}`];
    const getNewConfiguration = (name: string) => settings[`dev.containers.${name}`];
    return {
      copyGitConfig: getConfiguration('copyGitConfig') ?? user.copyGitConfig,
      gitCredentialHelperConfigLocation: getConfiguration('gitCredentialHelperConfigLocation') ?? user.gitCredentialHelperConfigLocation,
      dockerCredentialHelper: getNewConfiguration('dockerCredentialHelper') ?? user.dockerCredentialHelper,
      githubCLILoginWithToken: getNewConfiguration('githubCLILoginWithToken') ?? user.githubCLILoginWithToken,
    };
  }

  const NOTHING_FORWARDED = { copyGitConfig: false, gitCredentialHelperConfigLocation: 'none', dockerCredentialHelper: false, githubCLILoginWithToken: false };

  it.each<[string, Record<string, unknown>]>([
    ['no settings', {}],
    [
      'a repository that switches everything on with the new keys',
      {
        'dev.containers.copyGitConfig': true,
        'dev.containers.gitCredentialHelperConfigLocation': 'global',
        'dev.containers.dockerCredentialHelper': true,
        'dev.containers.githubCLILoginWithToken': true,
      },
    ],
    [
      'a repository that switches everything on with the old keys',
      {
        'remote.containers.copyGitConfig': true,
        'remote.containers.gitCredentialHelperConfigLocation': 'system',
        'remote.containers.dockerCredentialHelper': true,
        'remote.containers.githubCLILoginWithToken': true,
      },
    ],
  ])('forwards nothing of the computer for a container with %s', (_name, repository) => {
    expect(effective([repository, devContainersSettings()])).toEqual(NOTHING_FORWARDED);
  });

  it('needs both keys of copyGitConfig: a false under the new key alone falls through to the old key', () => {
    const repository = { 'remote.containers.copyGitConfig': true };
    expect(effective([repository, { 'dev.containers.copyGitConfig': false }]).copyGitConfig).toBe(true);
    expect(effective([repository, devContainersSettings()]).copyGitConfig).toBe(false);
  });
});

describe('other internal details of the Dev Containers extension', () => {
  it('keeps the values that the override configuration and `up` pass', () => {
    expect(ATTACHED_SHUTDOWN_ACTION).toBe('none');
    expect(SKIP_POST_ATTACH_ARG).toBe('--skip-post-attach');
  });

  it.each<[string, unknown, unknown[]]>([
    ['no customizations', undefined, []],
    ['a flat key', { vscode: { settings: { 'remote.localPortHost': 'allInterfaces' } } }, ['allInterfaces']],
    ['a nested key', { vscode: { settings: { remote: { localPortHost: 'allInterfaces' } } } }, ['allInterfaces']],
    ['localhost', { vscode: { settings: { 'remote.localPortHost': 'localhost' } } }, []],
    ['entries of the merged configuration, in order', { vscode: [{ settings: { 'remote.localPortHost': '0.0.0.0' } }, { settings: { remote: { localPortHost: 'x' } } }] }, ['0.0.0.0', 'x']],
  ])('values of remote.localPortHost that expose ports: %s', (_name, customizations, expected) => {
    expect(exposingLocalPortHostValues(customizations)).toEqual(expected);
  });

  it.each<[string, boolean]>([
    ['vsc-api-0123456789abcdef0123456789abcdef', true],
    [`api-${'a'.repeat(64)}`, true],
    ['api-0123456789ABCDEF0123456789ABCDEF', false],
    ['api-node_modules', false],
    ['vscode', false],
  ])('clone volume name %j: %s', (name, expected) => {
    expect(isDevContainersCloneVolumeName(name)).toBe(expected);
  });

  it('knows the volumes of the Dev Containers extension by name and by label', () => {
    expect(DEV_CONTAINERS_VOLUMES).toEqual(['vscode', 'vsc-remote-containers']);
    expect(hasDevContainersVolumeLabel({ 'vsch.local.repository': 'x' })).toBe(true);
    expect(hasDevContainersVolumeLabel({ 'dev.container.volume': 'true' })).toBe(true);
    expect(hasDevContainersVolumeLabel({ 'devenv.environment-id': 'x', 'com.docker.compose.project': 'p' })).toBe(false);
  });

  it.each<[number, number, boolean]>([
    [1, 8, true],
    [2, 8, true],
    [2, 9, false],
    [2, 31, false],
    [3, 0, false],
  ])('Git %i.%i and the forwarding credential helper: reached %s', (major, minor, expected) => {
    expect(forwardingHelperReachesGit(major, minor)).toBe(expected);
  });
});
