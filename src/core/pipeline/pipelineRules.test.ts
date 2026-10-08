// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import { DEVCONTAINER_ID_PLACEHOLDER, environmentDevcontainerId, helperCliVariables } from '../helper/cliVariables';
import {
  baseImageKey,
  COMPOSE_VOLUME_KEY,
  composeMountVolumes,
  composeConfigurationChange,
  composeRecordOf,
  hasComposeRecord,
  configHash,
  containerIsCurrent,
  digestReference,
  errorDetail,
  configRemoteUser,
  containerUserName,
  devMountFolders,
  verifiedIdentityTargets,
  workspaceIdentityMounts,
  imageRemoteUser,
  imagesToPull,
  isComposeContainer,
  isGitHubTokenRejected,
  isNetworkFailure,
  isRefusedUpdate,
  isRepositoryName,
  isUnrestrictedContainer,
  isRootUser,
  MAX_REFUSED_ITEMS_LENGTH,
  lifecycleHookFailure,
  lifecycleHookName,
  needsBuild,
  nextBuildNumber,
  nonEmptyString,
  recordDigests,
  refusedUpdateOf,
  shouldCheckImages,
  stringList,
  containerMetadataUser,
  sharedNamespaceServices,
  builtOtherServices,
  type ImageCheckState,
} from './pipelineRules';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

function checkedState(upToDate: boolean, changedImages: string[] = []): ImageCheckState {
  return {
    kind: 'checked',
    outcome: { status: 'checked', images: {}, features: {}, authRequired: [], failed: [] },
    upToDate,
    changedImages,
    changedFeatures: [],
  };
}

describe('configHash', () => {
  it('is sha256 of the configuration text plus the Dockerfile text', () => {
    const expected = crypto.createHash('sha256').update('{ }FROM ubuntu\n').digest('hex');
    expect(configHash('{ }', 'FROM ubuntu\n')).toBe(`sha256:${expected}`);
    expect(configHash('{ }')).toBe(`sha256:${crypto.createHash('sha256').update('{ }').digest('hex')}`);
    expect(configHash('{ "a": 1 }')).not.toBe(configHash('{ "a": 2 }'));
  });
});

describe('containerIsCurrent (concept section 9: containers of an older setup are created again)', () => {
  // Versions reset to 1 (user decision 2026-09-27), here and in the expectations of
  // nimblescape.devenv.container-version below.
  it.each<[string, Record<string, string>, boolean]>([
    ['the current version', { 'nimblescape.devenv.container-version': '1' }, true],
    ['a newer version', { 'nimblescape.devenv.container-version': '2' }, true],
    ['an older value (a label other than 1, below it)', { 'nimblescape.devenv.container-version': '0' }, false],
    ['no label', { 'nimblescape.devenv.environment-id': 'x' }, false],
    ['an invalid label', { 'nimblescape.devenv.container-version': 'two' }, false],
    ['an empty label', { 'nimblescape.devenv.container-version': '' }, false],
  ])('%s', (_name, labels, expected) => {
    expect(containerIsCurrent(labels)).toBe(expected);
  });

  it('counts a container created without the configuration as current only while the configuration cannot be read', () => {
    const provisional = { 'nimblescape.devenv.container-version': '1', 'nimblescape.devenv.container-config': 'unknown' };
    expect(containerIsCurrent(provisional)).toBe(false);
    expect(containerIsCurrent(provisional, true)).toBe(false);
    expect(containerIsCurrent(provisional, false)).toBe(true);
    expect(containerIsCurrent({ 'nimblescape.devenv.container-version': '1' }, false)).toBe(true);
    expect(containerIsCurrent({ 'nimblescape.devenv.container-config': 'unknown' }, false)).toBe(false);
  });
});

describe('containerIsCurrent and the switch of the host access checks (concept section 9 "Host access")', () => {
  const unrestricted = { 'nimblescape.devenv.container-version': '1', 'nimblescape.devenv.host-access': 'unrestricted' };

  it.each<[string, Record<string, string>, 'on' | 'off', boolean, boolean]>([
    // [name, labels, switch, current with the configuration known, current without it]
    ['a container of the checks-off time, checks on', unrestricted, 'on', false, false],
    ['a container of the checks-off time, checks off', unrestricted, 'off', true, true],
    ['a container with the checks, checks on', { 'nimblescape.devenv.container-version': '1' }, 'on', true, true],
    ['a container with the checks, checks off (it has less access)', { 'nimblescape.devenv.container-version': '1' }, 'off', true, true],
    ['another value of the label, checks on', { 'nimblescape.devenv.container-version': '1', 'nimblescape.devenv.host-access': 'other' }, 'on', true, true],
    ['an older version of the checks-off time, checks off', { 'nimblescape.devenv.container-version': '0', 'nimblescape.devenv.host-access': 'unrestricted' }, 'off', false, false],
    ['a container of the checks-off time without the configuration, checks off', { ...unrestricted, 'nimblescape.devenv.container-config': 'unknown' }, 'off', false, true],
  ])('%s', (_name, labels, checks, current, currentWithoutConfiguration) => {
    expect(containerIsCurrent(labels, true, checks)).toBe(current);
    expect(containerIsCurrent(labels, false, checks)).toBe(currentWithoutConfiguration);
  });

  it('treats the checks as on by default', () => {
    expect(containerIsCurrent(unrestricted)).toBe(false);
    expect(isUnrestrictedContainer(unrestricted)).toBe(true);
    expect(isUnrestrictedContainer({ 'nimblescape.devenv.container-version': '1' })).toBe(false);
    expect(isUnrestrictedContainer({ 'nimblescape.devenv.host-access': 'Unrestricted' })).toBe(false);
  });
});

describe('a refused update and the switch of the host access checks', () => {
  const key = { configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:x', images: { a: 'sha256:1' }, features: {} };

  it('matches only an update with the same state of the switch (absent: on)', () => {
    const refusedOn = { ...key, items: 'privileged mode' };
    const refusedOff = { ...key, items: 'variable GH_TOKEN in containerEnv', hostAccessChecks: 'off' as const };
    expect(isRefusedUpdate(refusedOn, key)).toBe(true);
    expect(isRefusedUpdate(refusedOn, { ...key, hostAccessChecks: 'off' })).toBe(false);
    expect(isRefusedUpdate(refusedOff, { ...key, hostAccessChecks: 'off' })).toBe(true);
    expect(isRefusedUpdate(refusedOff, key)).toBe(false);
  });

  it('reads the state of the switch of a stored refusal, and drops a record with an invalid one', () => {
    const refused = { ...key, items: 'x', hostAccessChecks: 'off' };
    expect(refusedUpdateOf({ refusedUpdate: refused })).toEqual(refused);
    expect(refusedUpdateOf({ refusedUpdate: { ...key, items: 'x' } })).toEqual({ ...key, items: 'x' });
    expect(refusedUpdateOf({ refusedUpdate: { ...key, items: 'x', hostAccessChecks: 'on' } })).toBeUndefined();
    expect(refusedUpdateOf({ refusedUpdate: { ...key, items: 'x', hostAccessChecks: true } })).toBeUndefined();
  });
});

describe('refused updates (concept 7.7: a new image that the host access policy refuses)', () => {
  const refused = {
    configPath: '.devcontainer/devcontainer.json',
    configHash: 'sha256:1',
    images: { 'node:20': 'sha256:AA' },
    features: { 'ghcr.io/x/f:1': 'sha256:bb' },
    items: 'bind mount /var/run/docker.sock',
  };
  const { items: _items, ...key } = refused;

  it('reads a valid field of the registry entry, and nothing else', () => {
    expect(refusedUpdateOf({ refusedUpdate: refused })).toEqual(refused);
    expect(refusedUpdateOf({})).toBeUndefined();
    expect(refusedUpdateOf({ refusedUpdate: { ...refused, images: { a: 1 } } })).toBeUndefined();
    expect(refusedUpdateOf({ refusedUpdate: { ...refused, items: undefined } })).toBeUndefined();
    expect(refusedUpdateOf({ refusedUpdate: 'x' })).toBeUndefined();
  });

  it('bounds the items of a stored refusal when they are read (hotfix review 4, Q3)', () => {
    // 100 KB, as a registry changed by hand could hold them.
    const items = `bind mount /${'a'.repeat(100 * 1024)}, and 20 more`;
    const read = refusedUpdateOf({ refusedUpdate: { ...refused, items } });
    expect(read?.items).toHaveLength(MAX_REFUSED_ITEMS_LENGTH + 1);
    expect(read?.items.startsWith('bind mount /aaa')).toBe(true);
    expect(read?.items.endsWith('aaa, and 20 more')).toBe(true);
    expect(read).toEqual({ ...refused, items: read?.items });
  });

  it('recognizes the same update: same configuration and digests, ignoring the case of the digests', () => {
    expect(isRefusedUpdate(refused, { ...key, images: { 'node:20': 'sha256:aa' } })).toBe(true);
    expect(isRefusedUpdate(undefined, key)).toBe(false);
    expect(isRefusedUpdate(refused, { ...key, configHash: 'sha256:2' })).toBe(false);
    expect(isRefusedUpdate(refused, { ...key, configPath: '.devcontainer/other/devcontainer.json' })).toBe(false);
    expect(isRefusedUpdate(refused, { ...key, features: { 'ghcr.io/x/f:1': 'sha256:cc' } })).toBe(false);
    expect(isRefusedUpdate(refused, { ...key, images: { ...key.images, 'redis:7': 'sha256:dd' } })).toBe(false);
    expect(isRefusedUpdate(refused, { ...key, images: {} })).toBe(false);
  });
});

describe('shouldCheckImages', () => {
  const base = { hasRecord: true, imagePresent: true, forced: false, skipUpdate: false, updateImagesOnConnect: true };

  it.each([
    ['setting on', {}, true],
    ['setting off, everything present', { updateImagesOnConnect: false }, false],
    ['setting off, no record', { updateImagesOnConnect: false, hasRecord: false }, true],
    ['setting off, forced', { updateImagesOnConnect: false, forced: true }, true],
    ['setting off, image missing', { updateImagesOnConnect: false, imagePresent: false }, true],
    ['"Later" for a changed configuration', { skipUpdate: true }, false],
    ['"Later" with the image missing', { skipUpdate: true, imagePresent: false }, false],
  ])('%s', (_name, change, expected) => {
    expect(shouldCheckImages({ ...base, ...change })).toBe(expected);
  });
});

describe('needsBuild', () => {
  const base = { hasRecord: true, imagePresent: true, forced: false, skipUpdate: false, containerExists: true };
  const unreachable = { kind: 'unreachable' } as ImageCheckState;

  it.each([
    ['up to date', {}, checkedState(true), false],
    ['newer digest', {}, checkedState(false, ['ubuntu']), true],
    ['newer digest, but "Later"', { skipUpdate: true }, checkedState(false, ['ubuntu']), false],
    ['registry unreachable', {}, unreachable, false],
    ['check skipped', {}, { kind: 'skipped' } as ImageCheckState, false],
    ['forced', { forced: true }, unreachable, true],
    ['no record', { hasRecord: false }, checkedState(true), true],
    ['image missing, even with "Later"', { imagePresent: false, skipUpdate: true }, { kind: 'skipped' } as ImageCheckState, true],
    // Concept 7.7 "Without internet access": the existing container starts; the next connection builds.
    ['no record, registry unreachable, container exists', { hasRecord: false }, unreachable, false],
    ['image missing, registry unreachable, container exists', { imagePresent: false }, unreachable, false],
    ['no record, registry unreachable, no container', { hasRecord: false, containerExists: false }, unreachable, true],
    ['image missing, registry unreachable, no container', { imagePresent: false, containerExists: false }, unreachable, true],
  ])('%s', (_name, change, check, expected) => {
    expect(needsBuild({ ...base, ...change, check })).toBe(expected);
  });
});

describe('imagesToPull', () => {
  const images = ['node:22', 'ubuntu:24.04'];

  it('pulls nothing without a registry', () => {
    expect(imagesToPull({ images, check: { kind: 'unreachable' }, hasRecord: false, imagePresent: false, forced: true })).toEqual([]);
  });

  it('pulls all images without a record, when forced, or when the environment image is missing', () => {
    const check = checkedState(true);
    expect(imagesToPull({ images, check, hasRecord: false, imagePresent: false, forced: false })).toEqual(images);
    expect(imagesToPull({ images, check, hasRecord: true, imagePresent: true, forced: true })).toEqual(images);
    expect(imagesToPull({ images, check: { kind: 'skipped' }, hasRecord: true, imagePresent: false, forced: false })).toEqual(images);
  });

  it('pulls only the changed images on an update', () => {
    const check = checkedState(false, ['ubuntu:24.04']);
    expect(imagesToPull({ images, check, hasRecord: true, imagePresent: true, forced: false })).toEqual(['ubuntu:24.04']);
    expect(imagesToPull({ images, check: checkedState(true), hasRecord: true, imagePresent: true, forced: false })).toEqual([]);
  });
});

describe('recordDigests', () => {
  it('uses the current digest, else the previous one, else leaves the reference out', () => {
    expect(recordDigests(['a', 'b', 'c'], { a: D2 }, { a: D1, b: D1 })).toEqual({ a: D2, b: D1 });
  });

  it('keeps the previous digest for a reference whose pull failed', () => {
    expect(recordDigests(['a', 'b'], { a: D2, b: D2 }, { a: D1 }, new Set(['a', 'b']))).toEqual({ a: D1 });
  });

  it('works without a check and without a previous record', () => {
    expect(recordDigests(['a'], undefined, undefined)).toEqual({});
  });

  it('does not read inherited properties', () => {
    expect(recordDigests(['constructor', 'toString'], {}, {})).toEqual({});
  });
});

describe('nextBuildNumber', () => {
  const repository = 'devenv-3f2a9c1e';

  it('is one more than the highest number of registry, record, and local tags', () => {
    expect(nextBuildNumber({ tags: [], repository })).toBe(1);
    expect(nextBuildNumber({ lastBuildNumber: 3, recordBuildNumber: 2, tags: [], repository })).toBe(4);
    expect(nextBuildNumber({ lastBuildNumber: 3, tags: [`${repository}:9`, `${repository}:10`], repository })).toBe(11);
  });

  it('ignores tags of other repositories and tags that are not numbers', () => {
    expect(nextBuildNumber({ tags: ['devenv-other:50', `${repository}:latest`, `${repository}:7-uid`], repository })).toBe(1);
  });
});

describe('isNetworkFailure', () => {
  it.each([
    "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443 after 3 ms: Couldn't connect to server",
    'fatal: unable to access \'https://github.com/a/b.git/\': Operation timed out after 300000 milliseconds',
    'ERROR: failed to solve: DeadlineExceeded: dial tcp: lookup registry-1.docker.io: no such host',
    'Get "https://ghcr.io/v2/": net/http: TLS handshake timeout',
    'getaddrinfo ENOTFOUND ghcr.io',
    'connect ECONNREFUSED 127.0.0.1:443',
    'Temporary failure in name resolution',
    "fatal: unable to access 'https://github.com/a/b.git/': gnutls_handshake() failed",
  ])('%s', (text) => {
    expect(isNetworkFailure(text)).toBe(true);
  });

  it.each([
    "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
    "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found",
    'fatal: Authentication failed',
    'Dockerfile parse error line 3: unknown instruction: RUNN',
  ])('not: %s', (text) => {
    expect(isNetworkFailure(text)).toBe(false);
  });
});

describe('errorDetail', () => {
  it('adds the end of stderr to the message of a CommandError when the message lacks it', () => {
    const error = new CommandError('devcontainer build', 1, '', 'line 1\nline 2');
    expect(errorDetail(error)).toBe(error.message);
    const plain = new CommandError('devcontainer build', 1, '', 'x');
    plain.message = 'devcontainer build failed: Feature error';
    expect(errorDetail(plain)).toBe('devcontainer build failed: Feature error\nx');
  });

  it('is the message for other errors', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail('text')).toBe('text');
  });
});

describe('base images', () => {
  it('baseImageKey treats equal references on the same registry as equal', () => {
    expect(baseImageKey('ubuntu', D1)).toBe(baseImageKey('docker.io/library/ubuntu:24.04', D1.toUpperCase().replace('SHA256', 'sha256')));
    expect(baseImageKey('ubuntu', D1)).not.toBe(baseImageKey('ubuntu', D2));
    expect(baseImageKey('ghcr.io/a/b:1', D1)).not.toBe(baseImageKey('docker.io/a/b:1', D1));
  });

  it('digestReference names the local image by repository and digest', () => {
    expect(digestReference('ubuntu:24.04', D1)).toBe(`docker.io/library/ubuntu@${D1}`);
    expect(digestReference('mcr.microsoft.com/devcontainers/base:ubuntu', D2)).toBe(`mcr.microsoft.com/devcontainers/base@${D2}`);
    expect(digestReference('localhost:5000/team/image', D1)).toBe(`localhost:5000/team/image@${D1}`);
  });

  it('digestReference rejects invalid references and digests', () => {
    expect(digestReference('${BASE}', D1)).toBeUndefined();
    expect(digestReference('ubuntu', 'sha256:abc')).toBeUndefined();
    expect(digestReference(`ubuntu@${D1}`, D2)).toBeUndefined();
  });
});

describe('imageRemoteUser', () => {
  const metadata = (entries: unknown) => ({ Labels: { 'devcontainer.metadata': JSON.stringify(entries) } });

  it('takes the last remoteUser of the metadata label', () => {
    expect(imageRemoteUser(metadata([{ remoteUser: 'vscode' }, { id: 'feature' }, { remoteUser: 'node' }]))).toBe('node');
    expect(imageRemoteUser(metadata({ remoteUser: 'dev' }))).toBe('dev');
  });

  it('falls back to containerUser, then to the user of the image, then to root', () => {
    expect(imageRemoteUser(metadata([{ containerUser: 'app' }, { id: 'x' }]))).toBe('app');
    expect(imageRemoteUser({ User: '1000:1000', Labels: {} })).toBe('1000');
    expect(imageRemoteUser({ User: 'node', Labels: null })).toBe('node');
    expect(imageRemoteUser({ User: '', Labels: { 'devcontainer.metadata': 'not json' } })).toBe('root');
    expect(imageRemoteUser(undefined)).toBe('root');
  });

  // Dev Container CLI 0.89.0: `docker run -u <containerUser> …runArgs`, so the last --user of the runArgs is the user of
  // the container; remoteUser = last remoteUser, else that user, else root; `user:group` → user; `0` → root.
  it.each<[string, unknown, readonly unknown[] | undefined, string]>([
    ['runArgs --user with a root image', { User: 'root', Labels: {} }, ['--user', 'node'], 'node'],
    ['runArgs --user= with an image without a user', { User: '', Labels: {} }, ['--user=node'], 'node'],
    ['runArgs -u before containerUser of the metadata', metadata([{ containerUser: 'app' }]), ['-u', 'dev'], 'dev'],
    ['the last --user of the runArgs wins, as in docker run', { User: 'root' }, ['-u', 'a', '--init', '--user', 'b', '-uc'], 'c'],
    ['remoteUser of the metadata wins over runArgs --user', metadata([{ remoteUser: 'vscode' }]), ['--user', 'node'], 'vscode'],
    ['a --user that is the value of another flag does not count', { User: 'node' }, ['--label', '--user'], 'node'],
    ['an empty last --user leaves the user of the image', { User: 'node' }, ['--user', 'x', '--user='], 'node'],
    ['user:group of the runArgs', { User: 'root' }, ['--user', 'node:staff'], 'node'],
    ['user:group of the remoteUser', metadata([{ remoteUser: '1000:1000' }]), undefined, '1000'],
    ['user:group of containerUser', metadata([{ containerUser: 'app:app' }]), [], 'app'],
    ['numeric 0 of the runArgs is root', { User: 'node' }, ['--user', '0'], 'root'],
    ['numeric 0:0 of the image is root', { User: '0:0' }, undefined, 'root'],
    ['numeric 0 of the remoteUser is root', metadata([{ remoteUser: '0' }]), undefined, 'root'],
    ['numeric users other than 0 stay', { User: 'root' }, ['-u', '1000'], '1000'],
  ])('%s', (_name, config, runArgs, expected) => {
    expect(imageRemoteUser(config, runArgs)).toBe(expected);
  });

  // hotfix review 2, P3: the CLI substitutes each entry of the label at `up` before it reads the users.
  describe('reads the users of the label as the Dev Container CLI substitutes them', () => {
    const variables = helperCliVariables('acme/api');

    it.each<[string, unknown, readonly unknown[] | undefined, string]>([
      ['a default of a variable that is not set in the helper', metadata([{ remoteUser: '${localEnv:DEVUSER:vscode}' }]), undefined, 'vscode'],
      ['a default in containerUser', metadata([{ remoteUser: '' }, { containerUser: '${localEnv:NOPE:node}' }]), undefined, 'node'],
      ['an empty result does not count (the earlier entry wins)', metadata([{ remoteUser: 'vscode' }, { remoteUser: '${localEnv:NOPE}' }]), undefined, 'vscode'],
      ['the basename of the workspace folder', metadata([{ remoteUser: '${localWorkspaceFolderBasename}' }]), undefined, 'api'],
      ['a containerUser with a leftover under a remoteUser', metadata([{ containerUser: '${localEnv:TERM}', remoteUser: 'vscode' }]), undefined, 'vscode'],
      ['a containerUser with a leftover under runArgs --user', metadata([{ containerUser: '${localEnv:TERM}' }]), ['--user', 'node'], 'node'],
    ])('%s', (_name, config, runArgs, expected) => {
      expect(imageRemoteUser(config, runArgs, variables)).toBe(expected);
    });

    it.each<[string, unknown]>([
      ['a remoteUser with a variable of the helper whose value is not known', metadata([{ remoteUser: '${localEnv:TERM:vscode}' }])],
      ['a containerUser with such a variable', metadata([{ containerUser: '${env:HOSTNAME}' }])],
      ['${containerEnv:…}', metadata([{ remoteUser: '${containerEnv:USER}' }])],
    ])('is not known for %s', (_name, config) => {
      expect(imageRemoteUser(config, undefined, variables)).toBeUndefined();
    });

    it('uses the variables of the workspace helper without the variables of the pipeline', () => {
      expect(imageRemoteUser(metadata([{ remoteUser: '${localEnv:DEVUSER:vscode}' }]))).toBe('vscode');
      expect(imageRemoteUser(metadata([{ remoteUser: '${localEnv:TERM:vscode}' }]))).toBeUndefined();
    });
  });
});

describe('configRemoteUser', () => {
  it.each<[string, { remoteUser?: unknown; containerUser?: unknown } | undefined, readonly unknown[] | undefined, string | undefined]>([
    ['remoteUser first', { remoteUser: 'vscode', containerUser: 'app' }, ['--user', 'node'], 'vscode'],
    ['then runArgs --user', { containerUser: 'app' }, ['--user', 'node'], 'node'],
    ['then containerUser', { containerUser: 'app:app' }, [], 'app'],
    ['0 is root', { remoteUser: '0' }, undefined, 'root'],
    ['none', {}, undefined, undefined],
    ['no configuration', undefined, undefined, undefined],
  ])('%s', (_name, config, runArgs, expected) => {
    expect(configRemoteUser(config, runArgs)).toBe(expected);
  });
});

describe('containerUserName', () => {
  it.each([
    ['node', 'node'],
    ['node:staff', 'node'],
    ['0', 'root'],
    ['0:0', 'root'],
    ['1000:1000', '1000'],
    [':1000', 'root'],
    ['root', 'root'],
  ])('%s → %s', (user, expected) => {
    expect(containerUserName(user)).toBe(expected);
  });
});

describe('small helpers', () => {
  it('isRootUser', () => {
    expect(isRootUser('root')).toBe(true);
    expect(isRootUser('0')).toBe(true);
    expect(isRootUser('vscode')).toBe(false);
  });

  it('isRepositoryName', () => {
    expect(isRepositoryName('acme/api')).toBe(true);
    expect(isRepositoryName('acme')).toBe(false);
    expect(isRepositoryName('a/b/c')).toBe(false);
    expect(isRepositoryName('a /b')).toBe(false);
    expect(isRepositoryName(undefined)).toBe(false);
  });

  it('stringList and nonEmptyString', () => {
    expect(stringList(['--cap-add', 3, 'SYS_PTRACE'])).toEqual(['--cap-add', 'SYS_PTRACE']);
    expect(stringList('x')).toBeUndefined();
    expect(nonEmptyString('vscode')).toBe('vscode');
    expect(nonEmptyString(' ')).toBeUndefined();
    expect(nonEmptyString(1)).toBeUndefined();
  });
});

describe('lifecycleHookFailure', () => {
  const failed = (description: string, containerId = 'c1') =>
    ({ outcome: 'error', message: 'Command failed: npm run db:migrate', description, containerId }) as const;

  it('names the failed lifecycle command of an error result with a container', () => {
    expect(lifecycleHookFailure(failed('postStartCommand from devcontainer.json failed.'))).toBe('postStartCommand');
    expect(lifecycleHookFailure(failed('postCreateCommand from devcontainer.json failed.'))).toBe('postCreateCommand');
    expect(lifecycleHookFailure(failed("onCreateCommand from Feature 'ghcr.io/devcontainers/features/node:1' failed."))).toBe('onCreateCommand');
    expect(lifecycleHookFailure(failed('migrate of postStartCommand from devcontainer.json failed.'))).toBe('postStartCommand');
    expect(lifecycleHookFailure(failed('updateContentCommand failed.'))).toBe('updateContentCommand');
  });

  it('ignores other errors, interrupted commands, success, and results without a container', () => {
    expect(lifecycleHookFailure(failed('An error occurred setting up the container.'))).toBeUndefined();
    expect(lifecycleHookFailure(failed('postStartCommand from devcontainer.json interrupted.'))).toBeUndefined();
    expect(lifecycleHookFailure(failed('The initializeCommand in the devcontainer.json failed.'))).toBeUndefined();
    expect(lifecycleHookFailure({ outcome: 'error', description: 'postStartCommand from devcontainer.json failed.' })).toBeUndefined();
    expect(lifecycleHookFailure(failed('postStartCommand from devcontainer.json failed.', ' '))).toBeUndefined();
    expect(lifecycleHookFailure({ outcome: 'success', containerId: 'c1', description: 'postStartCommand from devcontainer.json failed.' })).toBeUndefined();
    expect(lifecycleHookFailure(undefined)).toBeUndefined();
  });

  it('lifecycleHookName reads a description', () => {
    expect(lifecycleHookName('postAttachCommand from devcontainer.json failed.')).toBe('postAttachCommand');
    expect(lifecycleHookName('xpostStartCommand from devcontainer.json failed.')).toBeUndefined();
    expect(lifecycleHookName(undefined)).toBeUndefined();
  });
});

describe('isGitHubTokenRejected', () => {
  it.each([
    "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/acme/api.git/'",
    "fatal: Authentication failed for 'https://github.com/acme/api.git/'",
    "fatal: Authentication failed for 'https://x-access-token@github.com/acme/api.git/'",
    'remote: Invalid username or password.',
    "fatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 401",
  ])('a rejected token: %s', (text) => {
    expect(isGitHubTokenRejected(text)).toBe(true);
  });

  it.each([
    "remote: Repository not found.\nfatal: repository 'https://github.com/acme/api.git/' not found",
    "fatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 403",
    "fatal: Authentication failed for 'https://git.example.com/acme/api.git/'",
    "fatal: Authentication failed for 'https://github.com.evil.example/acme/api.git/'",
    "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com",
    "error: pathspec 'feature' did not match any file(s) known to git",
  ])('not a rejected token: %s', (text) => {
    expect(isGitHubTokenRejected(text)).toBe(false);
  });
});

describe('Docker Compose rules (unit 6)', () => {
  const record = { builtAt: '', environmentImage: 'devenv-3f2a9c1e:1', buildNumber: 1, configPath: 'c', configHash: 'h', images: {}, features: {} };
  const valid = { service: 'app', images: [], serviceImages: [], version: '2.40.3', inputsHash: 'sha256:x' };

  it.each([
    ['no compose part', undefined, undefined],
    ['a valid part', { ...valid, images: ['devenv-3f2a9c1e-app'] }, { ...valid, images: ['devenv-3f2a9c1e-app'] }],
    ['no list of service images', { service: 'app', images: [], version: '2.40.3', inputsHash: 'sha256:x' }, undefined],
    ['no Compose version', { service: 'app', images: [], serviceImages: [], inputsHash: 'sha256:x' }, undefined],
    ['no hash of the files', { service: 'app', images: [], serviceImages: [], version: '2.40.3' }, undefined],
    ['an empty service', { service: '', images: [] }, undefined],
    ['images that are no list of texts', { service: 'app', images: [1] }, undefined],
    ['no object', 'app', undefined],
  ])('composeRecordOf: %s', (_name, compose, expected) => {
    expect(composeRecordOf({ ...record, compose } as never)).toEqual(expected);
  });

  it('hasComposeRecord: the key `compose` with an object decides the kind, also for a part that composeRecordOf rejects (PR #68 review round 4, A-R4-2)', () => {
    expect(hasComposeRecord(undefined)).toBe(false);
    expect(hasComposeRecord(record as never)).toBe(false);
    expect(hasComposeRecord({ ...record, compose: valid } as never)).toBe(true);
    // A part of an earlier version, without the hash of the files: not valid, but still Docker Compose.
    const older = { service: 'app', images: [], serviceImages: [], version: '2.40.3' };
    expect(composeRecordOf({ ...record, compose: older } as never)).toBeUndefined();
    expect(hasComposeRecord({ ...record, compose: older } as never)).toBe(true);
    expect(hasComposeRecord({ ...record, compose: 'app' } as never)).toBe(false);
    expect(hasComposeRecord({ ...record, compose: ['app'] } as never)).toBe(false);
  });

  it('composeRecordOf keeps the service images, the Compose version, and the hash of the files (review round 1, D5, P-4)', () => {
    const compose = { service: 'app', images: [], serviceImages: ['postgres:16'], version: '2.40.3', inputsHash: 'sha256:x' };
    expect(composeRecordOf({ ...record, compose } as never)).toEqual(compose);
    expect(composeRecordOf({ ...record, compose: { ...compose, serviceImages: [1] } } as never)).toBeUndefined();
    expect(composeRecordOf({ ...record, compose: { ...compose, version: 2 } } as never)).toBeUndefined();
  });

  it.each<[string, Record<string, unknown> | undefined, { configHash: string; inputsHash: string; version: string }, string]>([
    ['the same model, files, and version', { version: '2.40', inputsHash: 'f' }, { configHash: 'h', inputsHash: 'f', version: '2.40' }, 'unchanged'],
    ['other files', { version: '2.40', inputsHash: 'f' }, { configHash: 'h', inputsHash: 'g', version: '2.40' }, 'changed'],
    ['other files and another version', { version: '2.40', inputsHash: 'f' }, { configHash: 'h2', inputsHash: 'g', version: '2.41' }, 'changed'],
    ['the same files, another model of the same version', { version: '2.40', inputsHash: 'f' }, { configHash: 'h2', inputsHash: 'f', version: '2.40' }, 'changed'],
    ['the same files, another model of another version', { version: '2.40', inputsHash: 'f' }, { configHash: 'h2', inputsHash: 'f', version: '2.41' }, 'rebaseline'],
    ['the same files and model, another version', { version: '2.40', inputsHash: 'f' }, { configHash: 'h', inputsHash: 'f', version: '2.41' }, 'rebaseline'],
    ['no compose part', undefined, { configHash: 'h2', inputsHash: 'f', version: '2.41' }, 'changed'],
  ])('composeConfigurationChange: %s (review round 1, P-4)', (_name, compose, current, expected) => {
    const withCompose = compose === undefined ? record : { ...record, compose: { service: 'app', images: [], serviceImages: [], ...compose } };
    expect(composeConfigurationChange(withCompose as never, current)).toBe(expected);
  });

  it('isComposeContainer: only a container of the project of the environment', () => {
    // Review round 2 (D2-4): changed input, a container of Compose also has a label that only containers have.
    expect(isComposeContainer({ 'com.docker.compose.project': 'devenv-3f2a9c1e', 'com.docker.compose.container-number': '1' }, 'devenv-3f2a9c1e')).toBe(true);
    expect(isComposeContainer({ 'com.docker.compose.project': 'devenv-3f2a9c1e', 'com.docker.compose.config-hash': 'x' }, 'devenv-3f2a9c1e')).toBe(true);
    expect(isComposeContainer({ 'com.docker.compose.project': 'api_devcontainer', 'com.docker.compose.container-number': '1' }, 'devenv-3f2a9c1e')).toBe(false);
    expect(isComposeContainer({}, 'devenv-3f2a9c1e')).toBe(false);
  });

  it('isComposeContainer: not by the labels that an image of the project gave a single container (review round 2, D2-4)', () => {
    const fromImage = { 'com.docker.compose.project': 'devenv-3f2a9c1e', 'com.docker.compose.service': 'app', 'com.docker.compose.version': '2.40.3' };
    expect(isComposeContainer(fromImage, 'devenv-3f2a9c1e')).toBe(false);
  });

  it('composeMountVolumes: named volumes of mounts become volumes of the project, unless external', () => {
    expect(
      composeMountVolumes('devenv-3f2a9c1e', [
        ['source=cache,target=/cache,type=volume', 'source=/tmp,target=/tmp,type=bind', 'type=tmpfs,target=/run'],
        { source: 'shared', target: '/shared', type: 'volume', external: true },
        undefined,
        [{ source: 'cache', target: '/other', type: 'volume' }],
      ]),
      // review round 17, D17-1: with the sources that are no key of a Compose volume.
    ).toEqual({ names: ['devenv-3f2a9c1e_cache', 'shared'], sources: ['cache'], skipped: [] });
  });

  it('composeMountVolumes: sources substituted as the CLI does at up, with the real ID; the rest is skipped (review round 17, D17-1)', () => {
    const id = environmentDevcontainerId('3f2a9c1e-0000-4000-8000-000000000001');
    const variables = { ...helperCliVariables('acme/api'), devcontainerId: id };
    const mounts = [
      [{ source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' }],
      ['source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume'],
      // A variable of the process whose value is not known, and a name that Compose does not accept as a key.
      ['source=${localEnv:TERM}-x,target=/x,type=volume', 'source=a@b,target=/y,type=volume'],
      { source: 'shared-${localEnv:TERM}', target: '/s', type: 'volume', external: true },
    ];
    expect(composeMountVolumes('devenv-3f2a9c1e', mounts, variables)).toEqual({
      names: [`devenv-3f2a9c1e_dind-var-lib-docker-${id}`, 'devenv-3f2a9c1e_api-node_modules'],
      sources: [`dind-var-lib-docker-${id}`, 'api-node_modules'],
      skipped: ['${localEnv:TERM}-x', 'a@b', 'shared-${localEnv:TERM}'],
    });
    // Without the variables, a source with `${…}` is never a volume of the model (and never the placeholder of the checks).
    const raw = composeMountVolumes('devenv-3f2a9c1e', mounts);
    expect(raw.sources).toEqual([]);
    expect(raw.names).toEqual([]);
    expect(JSON.stringify(composeMountVolumes('devenv-3f2a9c1e', mounts, variables))).not.toContain(DEVCONTAINER_ID_PLACEHOLDER);
    for (const source of composeMountVolumes('devenv-3f2a9c1e', mounts, variables).sources) expect(source).toMatch(COMPOSE_VOLUME_KEY);
  });
});

describe('workspace-volume mounts at their own canonical path (review round 14, P14-1)', () => {
  const env = { repository: 'acme/api', volumeName: 'acme-api-3f2a9c1e' };
  const V = env.volumeName;
  const container = {
    mountTargets: [
      { type: 'volume', volume: V, target: '/workspaces' },
      { type: 'volume', volume: V, target: '/workspaces/api', subpath: 'api' },
      { type: 'volume', volume: V, target: '/workspaces/api/src/', subpath: 'api/src/' },
      { type: 'volume', volume: V, target: '/workspaces/api/lib', subpath: 'api/./x/../lib' },
      // ./data:/workspaces/api/pgview: an alias.
      { type: 'volume', volume: V, target: '/workspaces/api/pgview', subpath: 'api/data' },
      // Subpath not known, another volume, a subpath outside the repository.
      { type: 'volume', volume: V, target: '/workspaces/api/docs' },
      { type: 'volume', volume: 'other', target: '/workspaces/api/tools', subpath: 'api/tools' },
      { type: 'bind', target: '/workspaces/api/bin', subpath: 'api/bin' },
    ],
  };
  const root = `/var/lib/docker/volumes/${V}/_data`;
  const info = (lines: string[]) => ['1 0 0:30 / / rw - overlay overlay rw', ...lines].join('\n');

  it('names the candidates lexically, below the repository folder only', () => {
    expect(workspaceIdentityMounts(container, env)).toEqual([
      { target: '/workspaces/api/src', subpath: 'api/src' },
      { target: '/workspaces/api/lib', subpath: 'api/lib' },
    ]);
    expect(workspaceIdentityMounts(undefined, env)).toEqual([]);
  });

  it('verifies them with /proc/self/mountinfo: same device, and the root of /workspaces joined with the subpath', () => {
    const candidates = workspaceIdentityMounts(container, env);
    expect(
      verifiedIdentityTargets(
        candidates,
        info([`2 1 8:1 ${root} /workspaces rw - ext4 /dev/sda1 rw`, `3 1 8:1 ${root}/api/src /workspaces/api/src rw - ext4 /dev/sda1 rw`, `4 1 8:1 ${root}/api/lib /workspaces/api/lib rw`]),
      ),
    ).toEqual(new Set(['/workspaces/api/src', '/workspaces/api/lib']));
    // A link in the volume: lib -> data, Docker mounted data there.
    expect(verifiedIdentityTargets(candidates, info([`2 1 8:1 ${root} /workspaces rw`, `4 1 8:1 ${root}/api/data /workspaces/api/lib rw`]))).toEqual(new Set());
    // Another device, a mount over it later (the last line counts), no mount at /workspaces, an empty text.
    expect(verifiedIdentityTargets(candidates, info([`2 1 8:1 ${root} /workspaces rw`, `3 1 8:2 ${root}/api/src /workspaces/api/src rw`]))).toEqual(new Set());
    expect(
      verifiedIdentityTargets(candidates, info([`2 1 8:1 ${root} /workspaces rw`, `3 1 8:1 ${root}/api/src /workspaces/api/src rw`, `5 3 0:50 / /workspaces/api/src rw - tmpfs tmpfs rw`])),
    ).toEqual(new Set());
    expect(verifiedIdentityTargets(candidates, info([`3 1 8:1 ${root}/api/src /workspaces/api/src rw`]))).toEqual(new Set());
    expect(verifiedIdentityTargets(candidates, '')).toEqual(new Set());
    // A volume that is its own file system (root `/`), and the kernel's escapes.
    const spaced = [{ target: '/workspaces/api/my src', subpath: 'api/my src' }];
    expect(verifiedIdentityTargets(spaced, info(['2 1 0:77 / /workspaces rw', '3 1 0:77 /api/my\\040src /workspaces/api/my\\040src rw']))).toEqual(new Set(['/workspaces/api/my src']));
  });

  it('leaves the verified targets out of devMountFolders, and keeps a real alias (pgview) protected', () => {
    expect(devMountFolders(container, env, 'on', new Set(['/workspaces/api/src', '/workspaces/api/pgview', '/workspaces/api/tools', '/workspaces/api/bin']))).toEqual([
      '/workspaces/api/lib',
      '/workspaces/api/pgview',
      '/workspaces/api/docs',
      '/workspaces/api/tools',
      '/workspaces/api/bin',
    ]);
    // Without verification: all protected, as before.
    expect(devMountFolders(container, env, 'on')).toEqual([
      '/workspaces/api/src',
      '/workspaces/api/lib',
      '/workspaces/api/pgview',
      '/workspaces/api/docs',
      '/workspaces/api/tools',
      '/workspaces/api/bin',
    ]);
  });
});

describe('devMountFolders (review round 12, D12-2)', () => {
  const env = { repository: 'acme/api', volumeName: 'acme-api-3f2a9c1e' };
  it('names the targets below the repository of every mount but the workspace volume', () => {
    expect(
      devMountFolders(
        {
          mountTargets: [
            { type: 'volume', volume: 'acme-api-3f2a9c1e', target: '/workspaces' },
            { type: 'volume', volume: 'acme-api-3f2a9c1e', target: '/workspaces/api/src' },
            { type: 'volume', volume: 'node_modules', target: '/workspaces/api/node_modules/' },
            { type: 'volume', target: '/workspaces/api/.cache//x' },
            { type: 'tmpfs', target: '/workspaces/api/tmp' },
            { type: 'bind', target: '/workspaces/api/node_modules/sub' },
            { type: 'bind', target: '/workspaces/api' },
            { type: 'bind', target: '/workspaces/api/../other' },
            { type: 'volume', volume: 'x', target: '/workspaces/api/.git/x' },
            { type: 'volume', volume: 'y', target: 'relative' },
            { type: 'bind', target: '/home/vscode' },
          ],
        },
        env,
        'on',
      ),
      // Review round 13, D13-1: the subpath mount of the workspace volume at /workspaces/api/src is protected too (an
      // alias of files of the volume, which `find -xdev` walks); before: left out like the mount at /workspaces.
      // Review round 15, K4: the volume at /workspaces/api/.git/x is protected too (before: dropped by the filter of .git).
    ).toEqual(['/workspaces/api/src', '/workspaces/api/node_modules', '/workspaces/api/.cache/x', '/workspaces/api/tmp', '/workspaces/api/.git/x']);
    expect(devMountFolders(undefined, env, 'on')).toEqual([]);
    expect(devMountFolders({}, env, 'on')).toEqual([]);
  });

  it('protects the alias mounts of the workspace volume below the repository, only not the mount at /workspaces (review round 13, D13-1)', () => {
    const mounts = (targets: string[]) => ({
      mountTargets: [
        { type: 'volume', volume: 'acme-api-3f2a9c1e', target: '/workspaces' },
        ...targets.map((target) => ({ type: 'volume', volume: 'acme-api-3f2a9c1e', target })),
      ],
    });
    // ./data:/workspaces/api/pgview of the dev service, rewritten to a subpath of the workspace volume (db mounts ./data).
    expect(devMountFolders(mounts(['/workspaces/api/pgview']), env, 'on')).toEqual(['/workspaces/api/pgview']);
    // `..` (the subpath `` or `api/..`) mounted below the repository; the repository folder itself is not protected.
    expect(devMountFolders(mounts(['/workspaces/api/parent/', '/workspaces/api', '/workspaces/api/']), env, 'on')).toEqual(['/workspaces/api/parent']);
    expect(devMountFolders(mounts(['/workspaces/', '/workspaces/other']), env, 'on')).toEqual([]);
  });

  it('gives an anonymous volume of the dev container the full fix, and keeps named volumes and binds protected (review round 13, D13-3)', () => {
    const anonymous = 'a'.repeat(64);
    const container = {
      mountTargets: [
        { type: 'volume', volume: anonymous, target: '/workspaces/api/node_modules' },
        { type: 'volume', volume: 'api-cache', target: '/workspaces/api/.cache' },
        { type: 'volume', volume: `${'b'.repeat(63)}g`, target: '/workspaces/api/x' },
        { type: 'bind', target: '/workspaces/api/host' },
        { type: 'bind', volume: anonymous, target: '/workspaces/api/odd' },
      ],
    };
    expect(devMountFolders(container, env, 'on')).toEqual(['/workspaces/api/.cache', '/workspaces/api/x', '/workspaces/api/host', '/workspaces/api/odd']);
    // With the checks off, a configuration may name the anonymous volume of another container: it stays protected.
    expect(devMountFolders(container, env, 'off')).toEqual([
      '/workspaces/api/node_modules',
      '/workspaces/api/.cache',
      '/workspaces/api/x',
      '/workspaces/api/host',
      '/workspaces/api/odd',
    ]);
  });

  it('keeps the targets in .git: a volume that db shares, and a bind of the computer with the checks off (review round 15, K4)', () => {
    const container = {
      mountTargets: [
        { type: 'volume', volume: 'proj_pgdata', target: '/workspaces/api/.git/pg' },
        { type: 'bind', target: '/workspaces/api/.git/hooks' },
        { type: 'volume', volume: 'proj_pgdata', target: '/workspaces/api/sub/.git/pg/' },
      ],
    };
    expect(devMountFolders({ mountTargets: container.mountTargets.slice(0, 1) }, env, 'on')).toEqual(['/workspaces/api/.git/pg']);
    expect(devMountFolders(container, env, 'off')).toEqual(['/workspaces/api/.git/pg', '/workspaces/api/.git/hooks', '/workspaces/api/sub/.git/pg']);
    // Still not the repository folder, `..`, or a path outside of it.
    expect(devMountFolders({ mountTargets: [{ type: 'bind', target: '/workspaces/api/.git/../..' }] }, env, 'off')).toEqual([]);
  });
});

describe('containerMetadataUser (recreate offer, review round 3, F1)', () => {
  const meta = (entries: unknown) => ({ 'devcontainer.metadata': JSON.stringify(entries) });

  it('takes the last remoteUser of the label of the container, else its containerUser', () => {
    expect(containerMetadataUser(meta([{ remoteUser: 'vscode' }, { remoteUser: 'node' }]))).toBe('node');
    expect(containerMetadataUser(meta([{ containerUser: 'dev' }]))).toBe('dev');
    expect(containerMetadataUser(meta([{ containerUser: 'dev' }, { remoteUser: 'node' }]))).toBe('node');
  });

  it('substitutes variables as the CLI does, and knows no user for an unknown value', () => {
    expect(containerMetadataUser(meta([{ remoteUser: '${localEnv:NOT_SET:fallback}' }]), helperCliVariables('acme/api'))).toBe('fallback');
    expect(containerMetadataUser(meta([{ remoteUser: '${containerEnv:USER}' }]), helperCliVariables('acme/api'))).toBeUndefined();
  });

  it('knows no user without a label, with an invalid one, or with one that names none', () => {
    expect(containerMetadataUser({})).toBeUndefined();
    expect(containerMetadataUser({ 'devcontainer.metadata': '{' })).toBeUndefined();
    expect(containerMetadataUser(meta([{ customizations: {} }]))).toBeUndefined();
  });
});

describe('sharedNamespaceServices (recreate offer, review round 3, G2)', () => {
  it('names each other service with service: network_mode, ipc, pid, or volumes_from', () => {
    const model = {
      services: {
        app: { network_mode: 'service:db' },
        db: {},
        a: { network_mode: 'service:db' },
        b: { ipc: 'service:db', pid: 'service:db' },
        c: { volumes_from: ['db:ro'] },
        d: { network_mode: 'host', ipc: 'shareable', pid: 'container:x', volumes_from: [] },
      },
    };
    expect(sharedNamespaceServices(model, 'app')).toEqual(['a: network_mode service:db', 'b: ipc service:db', 'b: pid service:db', 'c: volumes_from db:ro']);
    expect(sharedNamespaceServices({ services: { app: {}, db: {} } }, 'app')).toEqual([]);
  });
});

describe('builtOtherServices (recreate offer, review round 4, H1)', () => {
  const model = {
    services: {
      app: { build: { context: '.' } },
      db: { image: 'postgres:16' },
      worker: { build: { context: './worker' } },
      tools: { build: null },
    },
  };

  it('names the other services with build: that the up builds: all of them, or those of runServices', () => {
    expect(builtOtherServices(model, 'app')).toEqual(['worker']);
    expect(builtOtherServices(model, 'app', [])).toEqual(['worker']);
    expect(builtOtherServices(model, 'app', ['db'])).toEqual([]);
    expect(builtOtherServices(model, 'app', ['db', 'worker'])).toEqual(['worker']);
    expect(builtOtherServices({ services: { app: {}, db: { image: 'x' } } }, 'app')).toEqual([]);
  });
});
