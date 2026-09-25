import * as crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import {
  baseImageKey,
  configHash,
  digestReference,
  errorDetail,
  imageRemoteUser,
  imagesToPull,
  isNetworkFailure,
  isRepositoryName,
  isRootUser,
  lifecycleHookFailure,
  lifecycleHookName,
  needsBuild,
  nextBuildNumber,
  nonEmptyString,
  recordDigests,
  shouldCheckImages,
  stringList,
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
