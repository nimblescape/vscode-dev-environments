// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { AsyncLocalStorage } from 'async_hooks';
import * as crypto from 'crypto';
import { getEventListeners } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageInfo } from '../docker/containerAdapter';
import { preparingWorker } from '../docker/workerPreparation';
import { LOCAL_DOCKER_TARGET, type DockerTarget } from '../docker/dockerHost';
import { operationDockerTarget } from '../docker/dockerTargets';
import { REMOTE_INFO_TIMEOUT_MS } from '../docker/remoteDocker';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { CommandError, UserFacingError, isUserFacingError } from '../errors';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { GIT_SUMMARY_SCRIPT, configOwnershipFixCommand } from '../git/gitSummary';
import { abortError, type Logger, type RunOptions, type RunResult } from '../ports';
import { errorDetail } from '../pipeline/pipelineRules';
import { runWithBatchScope } from './batchScope';
import { batchStepCommand, type BatchStepKind } from './batchSteps';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { DevcontainerCommandError } from './devcontainerCli';
import { HELPER_CHECK_INTERVAL_MS, HELPER_GENERATION, helperImageTag, type BaseDigestLookup } from './helperImage';
import { HELPER_PREBUILD_TIMEOUT_MS, HelperPrebuild, dockerEngineAnswers, type HelperPrebuildDeps } from './helperPrebuild';
import type { HelperState } from './helperState';
import {
  BUILD_SCRIPT,
  CLONE_SCRIPT,
  COMPOSE_HASH_SCRIPT,
  COMPOSE_MODEL_SCRIPT,
  CREATE_FOLDERS_SCRIPT,
  GIT_FILES_SCRIPT,
  LIST_CONFIGS_SCRIPT,
  OVERRIDE_CONFIG_PATH,
  READ_FILES_SCRIPT,
  UP_SCRIPT,
  WRITE_AND_RUN_SCRIPT,
} from './scripts';
import { COMPOSE_DEV_DOCKERFILE, COMPOSE_MODEL_PATH } from './compose';
import {
  COMPOSE_MODEL_TIMEOUT_MS,
  DOCKER_SOCKET,
  HELPER_IMAGE_RECHECK_MS,
  MERGED_CONFIGURATION_TIMEOUT_MS,
  WorkspaceHelper,
  helperDockerSocket,
  helperStatePathFor,
  type HelperEngine,
  isPassableEnvName,
  type HelperDeps,
  type HelperDocker,
  type HelperImageUse,
} from './workspaceHelper';

const TOKEN = 'gho_0123456789abcdefSECRET';
const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const TAG = helperImageTag(DOCKERFILE);
/** Plan step 6, PR D: a remote SSH engine for the background prebuild. */
const REMOTE_TARGET: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'devenv-build-box' };

type BuildOptions = Parameters<HelperDocker['buildImage']>[0];
type Handler = (args: string[], options: RunOptions) => Partial<RunResult> | Promise<Partial<RunResult>>;

interface Call {
  args: string[];
  options: RunOptions;
}

/**
 * The image ID of the fake for a tag: a full `sha256:` ID, which helper.json keeps (review round 1 of PR #64, S5: an ID
 * of another form, like the former `id:<tag>`, is dropped).
 */
function fakeImageId(tag: string): string {
  return `sha256:${crypto.createHash('sha256').update(tag).digest('hex')}`;
}

class FakeDocker implements HelperDocker {
  readonly images = new Set<string>();
  /** Image IDs that differ from fakeImageId(tag): a tag that points to another image now. */
  readonly ids = new Map<string, string>();
  readonly builds: BuildOptions[] = [];
  readonly calls: Call[] = [];
  buildHandler: (options: BuildOptions) => Promise<void> = async () => undefined;
  handler: Handler = () => ({});
  /** Whether the fake sends stdout and stderr of the result to the output callbacks. */
  forwardOutput = true;

  /** Calls of imageId: each one is a run of ensureHelperImage with a state file. */
  imageIdCalls = 0;
  /** Calls of listImagesByLabel: the cleanup, or the removal of the previous image after a rebuild. */
  listCalls = 0;
  readonly removals: string[] = [];

  async imageExists(reference: string): Promise<boolean> {
    return this.images.has(reference);
  }

  async imageId(reference: string): Promise<string | undefined> {
    this.imageIdCalls++;
    return this.images.has(reference) ? this.idOf(reference) : undefined;
  }

  idOf(tag: string): string {
    return this.ids.get(tag) ?? fakeImageId(tag);
  }

  /** Review round 3 of PR #64 (P4): returns the ID of the built image, as ContainerAdapter.buildImage finds it by its build label. */
  async buildImage(options: BuildOptions): Promise<string | undefined> {
    this.builds.push(options);
    await this.buildHandler(options);
    this.images.add(options.tag);
    return this.idOf(options.tag);
  }

  async listImagesByLabel(): Promise<ImageInfo[]> {
    this.listCalls++;
    return [...this.images].map((tag) => ({ id: this.idOf(tag), tags: [tag], createdAt: '' }));
  }

  async removeImage(reference: string): Promise<boolean> {
    this.removals.push(reference);
    return this.images.delete(reference);
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    const result = await this.handler([...args], options);
    const full: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result };
    if (this.forwardOutput && full.stdout) options.onStdout?.(full.stdout);
    if (this.forwardOutput && full.stderr) options.onStderr?.(full.stderr);
    return full;
  }

  /** Calls of `docker run` (the helper runs), without other Docker calls such as `rm -f`. */
  get runs(): Call[] {
    return this.calls.filter((call) => call.args[0] === 'run');
  }
}

/** The command after the image reference `image` in docker run arguments. */
function commandOfImage(args: string[], image: string): string[] {
  const index = args.indexOf(image);
  expect(index).toBeGreaterThan(0);
  return args.slice(index + 1);
}

/**
 * The command after the image in docker run arguments. Plan step 7 (user decision of 2026-10-01): the per-step path is
 * removed; a step of the batch helper runs with the image ID of its session (was: the helper tag of a per-step run).
 */
function commandOf(args: string[]): string[] {
  const index = args.findIndex((arg) => /^devenv-helper:/.test(arg) || /^sha256:[0-9a-f]{64}$/.test(arg));
  expect(index).toBeGreaterThan(0);
  return args.slice(index + 1);
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(text: string): void {
    this.lines.push(`output ${text}`);
  }
}

let dir: string;
let docker: FakeDocker;
let logger: RecordingLogger;

/**
 * Plan step 7 (user decision of 2026-10-01): the per-step path is removed. Every volume step of WorkspaceHelper runs in
 * the batch helper of an operation; in these tests a fake lock opens sessions that run each step as one
 * `docker run [-e NAME=value…] <image ID> <command>` of the FakeDocker, with the command, variables and input that the
 * batch helper builds for it (batchStepCommand), the secret as the input of a step that takes it on stdin, and its
 * output to the step. So the tests still see what each step runs. `openError`: the session cannot be opened (D1).
 */
class BridgeLock implements HeldEnvironmentLock {
  readonly environmentId = 'e';
  readonly lost = new Promise<string>(() => {});
  /** The image of each session opened, in order. */
  readonly opens: string[] = [];
  /** The kind of each step, in order. */
  readonly kinds: BatchStepKind[] = [];
  openError: Error | undefined;
  async docker(): Promise<RunResult> {
    throw new Error('The fake lock runs no plain Docker call.');
  }
  async release(): Promise<void> {}
  batch = async (p: { volume: string; image: string; socket: string }): Promise<HelperBatchSession> => {
    this.opens.push(p.image);
    if (this.openError !== undefined) throw this.openError;
    const session: HelperBatchSession = {
      session: `s${this.opens.length}`,
      lost: new Promise<string>(() => {}),
      step: async (kind: BatchStepKind, params: unknown, options: BatchStepOptions = {}): Promise<RunResult> => {
        this.kinds.push(kind);
        const step = batchStepCommand(kind, params);
        const env = Object.entries(step.env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
        // The time limit of the step ends it (the helper kills its process group) and reports `timedOut`.
        const limit = new AbortController();
        const timer = options.timeoutMs !== undefined ? setTimeout(() => limit.abort(), options.timeoutMs) : undefined;
        const signal = options.signal !== undefined ? AbortSignal.any([options.signal, limit.signal]) : limit.signal;
        try {
          return await docker.run(['run', ...env, p.image, ...step.command], {
            input: step.secret === 'stdin' ? options.secret : step.input,
            signal,
            onStdout: (text) => options.onOutput?.('stdout', text),
            onStderr: (text) => options.onOutput?.('stderr', text),
          });
        } catch (error) {
          if (limit.signal.aborted && !options.signal?.aborted) return { exitCode: null, stdout: '', stderr: '', timedOut: true };
          throw error;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
      close: async () => {},
    };
    return session;
  };
}

/** The volume steps of WorkspaceHelper (each one a step of the batch helper). */
const VOLUME_METHODS = new Set([
  'clone',
  'readConfigFiles',
  'listConfigurations',
  'readConfiguration',
  'build',
  'composeModel',
  'composeServiceHashes',
  'createRepositoryFolders',
  'up',
  'runUserCommands',
  'prepareGit',
  'fixConfigOwnership',
  'gitSummary',
]);

/** The lock of the last scope that batched() opened. */
let bridge: BridgeLock;

/**
 * Plan step 7 (user decision of 2026-10-01): the per-step path is removed. `helper` with each volume step run in a batch
 * scope of its own (on its volume, with a BridgeLock), as an operation runs it; the other methods unchanged.
 */
function batched(helper: WorkspaceHelper, lock?: () => BridgeLock): WorkspaceHelper {
  return new Proxy(helper, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || !VOLUME_METHODS.has(property) || typeof value !== 'function') return value;
      return (p: { volumeName: string }) => {
        bridge = lock?.() ?? new BridgeLock();
        return runWithBatchScope(bridge, p.volumeName, logger, () => (value as (p: unknown) => Promise<unknown>).call(target, p));
      };
    },
  });
}

/**
 * Plan step 7 (user decision of 2026-10-01): the per-step path is removed, and with it WorkspaceHelper.run. A helper step
 * of the tests of the helper image (was: `helperStep(helper, { image })`): the ownership fix of CONFIG_FOLDER in
 * a batch scope on `vol`, which takes the pinned image of an open, or else the image of the window.
 */
function helperStep(helper: WorkspaceHelper, options: { image?: HelperImageUse; signal?: AbortSignal; lock?: BridgeLock } = {}): Promise<RunResult> {
  const { lock, ...rest } = options;
  return batched(helper, lock === undefined ? undefined : () => lock).fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000', ...rest });
}

function createHelper(env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'darwin'): WorkspaceHelper {
  // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the volume steps run in a batch scope.
  return batched(
    new WorkspaceHelper({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env,
      platform,
      clock: { now: () => Date.parse('2026-09-24T17:10:00Z') },
    }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
  docker = new FakeDocker();
  logger = new RecordingLogger();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('helperDockerSocket', () => {
  it('uses /var/run/docker.sock by default and with Docker Desktop', () => {
    expect(helperDockerSocket({}, 'linux')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///Users/me/.docker/run/docker.sock' }, 'darwin')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, 'win32')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///home/me/.docker/desktop/docker.sock' }, 'linux')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'tcp://10.0.0.1:2376' }, 'linux')).toBe(DOCKER_SOCKET);
  });

  it('uses the path of a unix:// DOCKER_HOST on Linux (for example rootless Docker)', () => {
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux')).toBe('/run/user/1000/docker.sock');
  });

  // Unit 7: the endpoint of the current Docker context, like DOCKER_HOST (a context of a local rootless engine).
  it('uses the endpoint of the current Docker context with the same rules', () => {
    expect(helperDockerSocket({}, 'linux', 'unix:///run/user/1000/docker.sock')).toBe('/run/user/1000/docker.sock');
    expect(helperDockerSocket({}, 'linux', 'unix:///home/me/.docker/desktop/docker.sock')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({}, 'darwin', 'unix:///Users/me/.docker/run/docker.sock')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///run/user/1/docker.sock' }, 'linux', '')).toBe('/run/user/1/docker.sock');
  });
});

describe('helperStatePathFor (unit 7)', () => {
  it('keeps helper.json for the local Docker and gives each remote host a file of its own', () => {
    expect(helperStatePathFor('/s/helper.json', '')).toBe('/s/helper.json');
    const box = helperStatePathFor('/s/helper.json', 'box');
    expect(box).toMatch(/^\/s\/helper-remote-[0-9a-f]{16}\.json$/);
    expect(helperStatePathFor('/s/helper.json', 'me@box')).not.toBe(box);
  });
});

describe('isPassableEnvName', () => {
  it.each(['HOME', 'USERPROFILE', 'GITHUB_USER', 'ProgramFiles(x86)', 'http_proxy'])('passes %s', (name) => {
    expect(isPassableEnvName(name)).toBe(true);
  });

  it.each(['PATH', 'Path', 'DOCKER_HOST', 'docker_context', 'BUILDX_BUILDER', 'LD_PRELOAD', 'NODE_OPTIONS', 'TMPDIR', 'A=B', ''])(
    'never passes %s',
    (name) => {
      expect(isPassableEnvName(name)).toBe(false);
    },
  );
});

describe('WorkspaceHelper.ensureImage', () => {
  it('shares one build between concurrent callers', async () => {
    const helper = createHelper();
    const tags = await Promise.all([helper.ensureImage(), helper.ensureImage(), helper.ensureImage()]);
    expect(tags).toEqual([TAG, TAG, TAG]);
    expect(docker.builds).toHaveLength(1);
  });

  it('reports a failed build as helperFailed and tries again at the next call', async () => {
    const helper = createHelper();
    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'network error');
    };
    const error = await helper.ensureImage().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'helperFailed', message: 'The workspace helper could not be prepared.' });
    expect((error as UserFacingError).detail).toContain('network error');

    docker.buildHandler = async () => undefined;
    await expect(helper.ensureImage()).resolves.toBe(TAG);
    expect(docker.builds).toHaveLength(2);
  });

  it('passes other user-facing errors through', async () => {
    const helper = createHelper();
    docker.imageExists = async () => {
      throw new UserFacingError('dockerNotInstalled', 'Docker Desktop is not installed.');
    };
    await expect(helper.ensureImage()).rejects.toMatchObject({ code: 'dockerNotInstalled' });
  });

  it('fails with helperFailed when the Dockerfile cannot be read', async () => {
    fs.rmSync(path.join(dir, 'Dockerfile'));
    await expect(createHelper().ensureImage()).rejects.toMatchObject({ code: 'helperFailed' });
  });
});

describe('WorkspaceHelper.ensureImage with a state file (implementation notes 7)', () => {
  const START = Date.parse('2026-09-24T12:00:00Z');
  const DIGEST = `sha256:${'a'.repeat(64)}`;

  function setup(answer: () => Promise<string | 'unreachable' | undefined> = async () => DIGEST) {
    let now = START;
    const lookups: string[] = [];
    const checks: Array<Promise<void>> = [];
    const baseDigest: BaseDigestLookup = (reference) => {
      lookups.push(reference);
      return answer();
    };
    const statePath = path.join(dir, 'storage', 'helper.json');
    const deps: HelperDeps = {
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'darwin',
      clock: { now: () => now },
      statePath,
      baseDigest,
      onBaseImageCheck: (check) => checks.push(check),
    };
    return {
      helper: new WorkspaceHelper(deps),
      lookups,
      advance: (ms: number) => {
        now += ms;
      },
      iso: (offsetMs = 0) => new Date(now + offsetMs).toISOString(),
      state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState,
      /** Waits for the checks of the base image that ensureImage started in the background. */
      settled: () => Promise.all(checks.splice(0)),
    };
  }

  it('builds a new helper with --pull and records the digest of its base image', async () => {
    const { helper, lookups, state, iso } = setup();
    expect(await helper.ensureImage()).toBe(TAG);
    expect(lookups).toEqual(['node:22-bookworm-slim']);
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true });
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    expect(state().images[TAG]).toEqual({
      baseImage: 'node:22-bookworm-slim',
      baseDigest: DIGEST,
      builtAt: iso(),
      checkedAt: iso(),
      lastUsedAt: iso(),
      // Changed expectation (review round 1 of PR #64, S5): the fake gives full sha256: IDs, the only form helper.json keeps.
      imageId: fakeImageId(TAG),
      // Changed expectation (review round 2 of PR #64, A-N2): the build records the helper generation.
      generation: HELPER_GENERATION,
    });
  });

  it('uses the existing image when the registry cannot be reached', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    docker.images.add(TAG);
    const { helper, lookups, state, settled } = setup(async () => 'unreachable');
    expect(await helper.ensureImage()).toBe(TAG);
    await settled();
    expect(lookups).toHaveLength(1);
    expect(docker.builds).toHaveLength(0);
    expect(state().images[TAG].checkedAt).toBeUndefined();
    const result = await helperStep(helper);
    expect(result.exitCode).toBe(0);
  });

  it('reuses the image for an hour; after that, ensureImage checks again, and the helper runs only record the use', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const { helper, lookups, advance, iso, state, settled } = setup();
    await helper.ensureImage();
    const calls = docker.imageIdCalls;
    expect(calls).toBeGreaterThan(0);

    // A long-lived window: the helper runs of a stop or a delete never check or rebuild.
    // 2026-10-01: the Switch branch command was dropped (user decision).
    advance(HELPER_CHECK_INTERVAL_MS + HELPER_IMAGE_RECHECK_MS);
    await helperStep(helper);
    expect(docker.imageIdCalls).toBe(calls);
    expect(lookups).toHaveLength(1);
    expect(state().images[TAG].lastUsedAt).toBe(iso());
    const used = iso();
    advance(10 * 60 * 1000);
    await helperStep(helper);
    expect(state().images[TAG].lastUsedAt).toBe(used);

    // The open pipeline (ensureImage) runs ensureHelperImage again: the weekly check is due.
    await helper.ensureImage();
    await settled();
    expect(docker.imageIdCalls).toBe(calls + 1);
    expect(lookups).toHaveLength(2);
    expect(state().images[TAG].checkedAt).toBe(iso());
    await helper.ensureImage();
    // Changed expectation (review round 4 of PR #64, R4-1): an open that reuses the cache checks once that the tag still
    // has the cached image (one imageId call), without running ensureHelperImage again.
    expect(docker.imageIdCalls).toBe(calls + 2);
    expect(lookups).toHaveLength(2);
    expect(docker.builds).toHaveLength(1);
  });
});

describe('WorkspaceHelper reuses its cached helper image only while the tag still has it (review round 4 of PR #64, R4-1)', () => {
  const START = Date.parse('2026-09-24T12:00:00Z');
  const I1 = fakeImageId(TAG);
  const I2 = `sha256:${'2'.repeat(64)}`;
  const DIGEST_A = `sha256:${'a'.repeat(64)}`;
  const DIGEST_B = `sha256:${'b'.repeat(64)}`;

  /** Two windows with the same Docker engine and the same helper.json. */
  function windows() {
    const now = START;
    const statePath = path.join(dir, 'storage', 'helper.json');
    const window = (baseDigest?: BaseDigestLookup) =>
      new WorkspaceHelper({ docker, logger, dockerfilePath: path.join(dir, 'Dockerfile'), env: {}, platform: 'darwin', clock: { now: () => now }, statePath, baseDigest });
    // docker run answers "No such image" for an image ID that no tag has anymore (the engine removed that image).
    docker.handler = (args) => {
      if (args[0] !== 'run') return {};
      const reference = args.find((arg) => arg.startsWith('sha256:'));
      if (reference !== undefined && ![...docker.images].some((tag) => docker.idOf(tag) === reference)) {
        return { exitCode: 125, stderr: `docker: Error response from daemon: No such image: ${reference}.\n` };
      }
      return {};
    };
    return { a: window(), b: window(async () => DIGEST_B), statePath };
  }

  it('gives the next open of window A the image that window B rebuilt, without a build, after B removed the old image', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const { a, b, statePath } = windows();
    const first = await a.ensureImageUse();
    expect(first).toEqual({ tag: TAG, id: I1 });
    expect((await helperStep(a, { image: first })).exitCode).toBe(0);
    // Window B rebuilds the tag from a new base image (a check asked for it); the image I1 is gone.
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState;
    saved.images[TAG] = { ...saved.images[TAG], baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B };
    fs.writeFileSync(statePath, JSON.stringify(saved));
    docker.buildHandler = async () => {
      docker.ids.set(TAG, I2);
    };
    expect(await b.ensureImageUse()).toEqual({ tag: TAG, id: I2 });
    const builds = docker.builds.length;
    // Within the hour of its cache, the next open of window A pins the new image and succeeds.
    const second = await a.ensureImageUse();
    expect(second).toEqual({ tag: TAG, id: I2 });
    expect(docker.builds).toHaveLength(builds);
    expect((await helperStep(a, { image: second })).exitCode).toBe(0);
    expect(docker.runs[docker.runs.length - 1].args).toContain(I2);
  });

  it('builds the tag again for the next open of window A after a prune removed it', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const { a } = windows();
    expect(await a.ensureImageUse()).toEqual({ tag: TAG, id: I1 });
    // docker image prune -a.
    docker.images.delete(TAG);
    docker.buildHandler = async () => {
      docker.ids.set(TAG, I2);
    };
    const image = await a.ensureImageUse();
    expect(image).toEqual({ tag: TAG, id: I2 });
    expect(docker.builds).toHaveLength(2);
    expect((await helperStep(a, { image })).exitCode).toBe(0);
  });

  it('resets the cache of the window when its image is gone, and keeps it when Docker cannot answer the check', async () => {
    const { a } = windows();
    await a.ensureImageUse();
    // Another window moved the tag; the pinned image of this open is gone.
    docker.ids.set(TAG, I2);
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed, and with it the reset of the cache by a
    // pinned run that found its image gone (a batch helper with that image cannot be started, the step is refused). Changed
    // expectation: the next open finds the moved tag by the check of its cached image and resolves the new image.
    expect(await a.ensureImageUse()).toEqual({ tag: TAG, id: I2 });

    // Docker does not answer the check of the cached image: the cache stays.
    const calls = docker.imageIdCalls;
    const imageId = docker.imageId.bind(docker);
    docker.imageId = async () => {
      throw new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
    };
    expect(await a.ensureImageUse()).toEqual({ tag: TAG, id: I2 });
    docker.imageId = imageId;
    expect(docker.imageIdCalls).toBe(calls);
    expect(docker.builds).toHaveLength(1);
    expect(logger.lines.join('\n')).toContain(`The workspace helper image ${TAG} could not be checked`);
  });

  it('awaits the new cache when it was replaced during the check', async () => {
    const { a } = windows();
    await a.ensureImageUse();
    const I3 = `sha256:${'3'.repeat(64)}`;
    const calls = docker.imageIdCalls;
    const imageId = docker.imageId.bind(docker);
    let replaced = false;
    docker.imageId = async (reference) => {
      if (!replaced) {
        replaced = true;
        // Meanwhile, a run outside an open found its image missing and reset the cache (resetImage).
        (a as unknown as { resetImage(): void }).resetImage();
        docker.ids.set(TAG, I2);
        // The new (pending) result of another caller; this caller awaits it and does not reset it.
        (a as unknown as { imagePromise: Promise<HelperImageUse> }).imagePromise = Promise.resolve({ tag: TAG, id: I3 });
      }
      return imageId(reference);
    };
    expect(await a.ensureImageUse()).toEqual({ tag: TAG, id: I3 });
    expect(docker.imageIdCalls).toBe(calls + 1);
  });
});

describe('WorkspaceHelper keeps the helper image of each engine apart for overlapping opens (review round 8 of PR #64, R8-1)', () => {
  const REMOTE_ID = `sha256:${'r'.repeat(64)}`;

  /**
   * One window with two engines: the local Docker and a remote one (key `box`). Each operation keeps its engine, as the
   * Docker target of an open does (AsyncLocalStorage); the Docker calls go to the engine of the operation.
   */
  function engines() {
    const als = new AsyncLocalStorage<string>();
    const local = new FakeDocker();
    const remote = new FakeDocker();
    remote.ids.set(TAG, REMOTE_ID);
    const dispatch = new Proxy({} as HelperDocker, {
      get: (_target, property) => {
        const target = als.getStore() === 'box' ? remote : local;
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const helper = new WorkspaceHelper({
      docker: dispatch,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'linux',
      clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
      statePath: path.join(dir, 'storage', 'helper.json'),
      engine: async () => ({ key: als.getStore() ?? '' }),
    });
    const onRemote = <T>(action: () => Promise<T>): Promise<T> => als.run('box', action);
    return { helper, local, remote, onRemote };
  }

  /** A build of `docker` that waits for `release`. */
  function blockBuild(docker: FakeDocker): { release: () => void } {
    const gate = { release: () => undefined as void };
    docker.buildHandler = () =>
      new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    return gate;
  }

  it('gives a local open the local image when a remote open replaced the cache during the check of the cached image', async () => {
    const { helper, local, remote, onRemote } = engines();
    expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    // The next local open checks the cached image (cachedImageCurrent); the check waits.
    const imageId = local.imageId.bind(local);
    let answer: (() => void) | undefined;
    local.imageId = (reference) =>
      new Promise((resolve) => {
        answer = () => resolve(imageId(reference));
      });
    const first = helper.ensureImageUse();
    await vi.waitFor(() => expect(answer).toBeDefined());
    local.imageId = imageId;
    // Meanwhile, an open on the remote engine replaces the cache with the image of its engine.
    expect(await onRemote(() => helper.ensureImageUse())).toEqual({ tag: TAG, id: REMOTE_ID });
    answer?.();
    expect(await first).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(local.builds).toHaveLength(1);
    expect(remote.builds).toHaveLength(1);
  });

  it('gives a local open that joins the prebuild the local image when a remote open replaced the cache meanwhile', async () => {
    const { helper, local, remote, onRemote } = engines();
    const localBuild = blockBuild(local);
    const pre = helper.prebuildImage({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(local.builds).toHaveLength(1));
    // The local open joins the prebuild (the result of a helper run without the maintenance).
    const first = helper.ensureImageUse();
    // Meanwhile, an open on the remote engine starts the build of its engine.
    const remoteBuild = blockBuild(remote);
    const second = onRemote(() => helper.ensureImageUse());
    await vi.waitFor(() => expect(remote.builds).toHaveLength(1));
    localBuild.release();
    expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    remoteBuild.release();
    expect(await first).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await second).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(local.builds).toHaveLength(1);
    expect(remote.builds).toHaveLength(1);
  });

  // Review round 20 of PR #64 (B-R20-5d): a replaced (stale) ensure touches neither the cache nor the progress of the new one.
  it('a replaced ensure that fails later leaves the cache of the other engine alone: no second build', async () => {
    const { helper, local, remote, onRemote } = engines();
    let fail: (() => void) | undefined;
    let failed = false;
    // The build with --pull waits for `fail`; the retry without --pull fails at once.
    local.buildHandler = () =>
      failed
        ? Promise.reject(new CommandError('docker build', 1, '', 'network unreachable'))
        : new Promise<void>((_resolve, reject) => {
            fail = () => {
              failed = true;
              reject(new CommandError('docker build', 1, '', 'network unreachable'));
            };
          });
    const first = helper.ensureImageUse().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fail).toBeDefined());
    const remoteBuild = blockBuild(remote);
    const second = onRemote(() => helper.ensureImageUse());
    await vi.waitFor(() => expect(remote.builds).toHaveLength(1));
    // The replaced local ensure fails while the remote build runs.
    fail?.();
    expect(await first).toMatchObject({ code: 'helperFailed' });
    // Another remote open joins the running remote build.
    const third = onRemote(() => helper.ensureImageUse());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remote.builds).toHaveLength(1);
    remoteBuild.release();
    expect(await second).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(await third).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(remote.builds).toHaveLength(1);
  });

  it('a replaced ensure that succeeds later does not put its image into the cache of the other engine', async () => {
    const { helper, local, onRemote } = engines();
    const localBuild = blockBuild(local);
    const first = helper.ensureImageUse();
    await vi.waitFor(() => expect(local.builds).toHaveLength(1));
    expect(await onRemote(() => helper.ensureImageUse())).toEqual({ tag: TAG, id: REMOTE_ID });
    localBuild.release();
    expect(await first).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    // The next remote open reuses its cache: no "has another image now".
    expect(await onRemote(() => helper.ensureImageUse())).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(logger.lines.join('\n')).not.toContain('It is prepared again');
  });

  it('a replaced ensure that starts its build later gives no build progress to an open of the other engine', async () => {
    const { helper, local, remote, onRemote } = engines();
    remote.images.add(TAG);
    // The local ensure waits before it finds its tag missing.
    const imageId = local.imageId.bind(local);
    let answer: (() => void) | undefined;
    local.imageId = (reference) =>
      new Promise((resolve) => {
        answer = () => resolve(imageId(reference));
      });
    const first = helper.ensureImageUse();
    await vi.waitFor(() => expect(answer).toBeDefined());
    local.imageId = imageId;
    expect(await onRemote(() => helper.ensureImageUse())).toEqual({ tag: TAG, id: REMOTE_ID });
    answer?.();
    expect(await first).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(local.builds).toHaveLength(1);
    const onBuild = vi.fn();
    expect(await onRemote(() => helper.ensureImageUse({ onBuild }))).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(remote.builds).toEqual([]);
    expect(onBuild).not.toHaveBeenCalled();
  });
});

describe('WorkspaceHelper without a previous helper image (user decision 2026-09-29)', () => {
  /** A helper image of an older extension version that this installation built. It is never used. */
  const OLDER = 'devenv-helper:0123456789ab';
  const START = Date.parse('2026-09-24T12:00:00Z');

  function setup() {
    let now = START;
    const statePath = path.join(dir, 'storage', 'helper.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    docker.images.add(OLDER);
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, images: { [OLDER]: { builtAt: '2026-09-20T12:00:00.000Z', imageId: fakeImageId(OLDER), generation: HELPER_GENERATION } } }),
    );
    const helper = new WorkspaceHelper({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'darwin',
      clock: { now: () => now },
      statePath,
    });
    return {
      helper,
      advance: (ms: number) => {
        now += ms;
      },
      state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState,
    };
  }

  const offline = async (): Promise<void> => {
    throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
  };

  /** The image reference of each `docker run` from index `from` on. */
  const references = (from = 0) => docker.runs.slice(from).map((run) => run.args.find((arg) => arg.startsWith('sha256:') || arg.startsWith('devenv-helper:')));

  it('fails with helperFailed when the current tag cannot be built, never runs an older helper image, and builds the tag again at the next ensureImage', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    // user decision 2026-09-29: no previous helper image. Changed expectation: before, the older helper image of this
    // installation was returned and the helper runs used it by its image ID.
    const { helper, advance } = setup();
    docker.buildHandler = offline;
    const error = await helper.ensureImageUse().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'helperFailed' });
    expect((error as UserFacingError).message).toBe('The workspace helper could not be prepared.');
    await expect(helperStep(helper)).rejects.toMatchObject({ code: 'helperFailed' });
    expect(docker.runs).toEqual([]);
    expect(logger.lines.join('\n')).not.toContain('previous helper');

    // The next open (online again) builds the current tag and uses it.
    docker.buildHandler = async () => undefined;
    advance(60_000);
    expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    await helperStep(helper);
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step runs in a
    // batch helper, which is started with the image ID of the current tag (was: the tag).
    expect(references()).toEqual([fakeImageId(TAG)]);
  });

  it('fails with helperFailed without a build when the current image of an open is gone at a run (review round 2 of PR #64, A-N1; review round 3 of PR #64, P2)', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const { helper } = setup();
    // Review round 3 of PR #64 (P2): the open pins the current tag by the ID of its image.
    const image = await helper.ensureImageUse();
    expect(image).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    // Changed expectation (review round 3 of PR #64, P2): before, the same tag was built again and the run went on with
    // it; a pinned run now uses the image ID, and when that image is gone the open ends with helperFailed: nothing is
    // built (a build may give another image).
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the batch helper of
    // the open is started with the pinned image ID and cannot be started when that image is gone (the worker's
    // `docker run --pull never` fails), so the step is refused (helperFailed, D1); nothing is built, and no other image is
    // used (was: the per-step `docker run` failed with "No such image" and logged it).
    docker.images.delete(TAG);
    const lock = new BridgeLock();
    lock.openError = new Error(`docker: Error response from daemon: No such image: ${fakeImageId(TAG)}`);
    const builds = docker.builds.length;
    const runs = docker.runs.length;
    const error = await helperStep(helper, { image, lock }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'helperFailed' });
    expect((error as UserFacingError).detail).toContain(`No such image: ${fakeImageId(TAG)}`);
    expect(lock.opens).toEqual([fakeImageId(TAG)]);
    expect(docker.runs).toHaveLength(runs);
    expect(docker.builds).toHaveLength(builds);
    expect(logger.lines.join('\n')).not.toContain('It is built again');
  });

  it('keeps the runs of an open on the image ID of its current tag when another window rebuilds the tag in the middle of the open (review round 3 of PR #64, P2)', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const { helper } = setup();
    const image = await helper.ensureImageUse();
    expect(image.id).toBe(fakeImageId(TAG));
    await helperStep(helper, { image });
    // Another window rebuilds the tag (--pull --no-cache): the tag points to another image now.
    const rebuilt = `sha256:${'7'.repeat(64)}`;
    docker.ids.set(TAG, rebuilt);
    await helperStep(helper, { image });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the volume steps run in a batch scope.
    await batched(helper).prepareGit({ volumeName: 'vol', repository: 'o/a', identity: { name: 'A', email: 'a@example.com' }, image });
    expect(references()).toEqual([fakeImageId(TAG), fakeImageId(TAG), fakeImageId(TAG)]);
    // Plan step 7 (user decision of 2026-10-01): changed expectation (was: a run outside an open uses the tag): a step
    // outside an open (Delete's check, the picker) runs after the ensure of withEnvironmentLock (ensureImagePresent),
    // with the image that the tag has now, by its ID.
    await helper.ensureImagePresent();
    await helperStep(helper);
    expect(docker.runs[docker.runs.length - 1].args).toContain(rebuilt);
    expect(docker.runs[docker.runs.length - 1].args).not.toContain(fakeImageId(TAG));
  });

  it('pins the image that the ensure of the open awaited when the cache of the window is replaced while it is pending (review round 3 of PR #64, P1)', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    // user decision 2026-09-29: no previous helper image. Changed expectation: before, the open was offline and pinned the
    // previous helper; now the pending ensure of the open builds the current tag while a helper run of another Docker
    // engine replaces the cache, and the open still gets the image that its ensure built.
    const { helper } = setup();
    let engineKey = '';
    (helper as unknown as { deps: HelperDeps }).deps.engine = async () => ({ key: engineKey });
    let release: () => void = () => undefined;
    let first = true;
    docker.buildHandler = async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
    };
    const pending = helper.ensureImageUse();
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    // A helper run for another engine replaces the cache while the build of the open still runs.
    engineKey = 'ssh://build-box';
    const other = helperStep(helper).catch((e: unknown) => e);
    await vi.waitFor(() => expect(docker.runs.length).toBeGreaterThan(0));
    release();
    const image = await pending;
    expect(image).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    await other;
    engineKey = '';
    const before = docker.runs.length;
    await helperStep(helper, { image });
    expect(references(before)).toEqual([fakeImageId(TAG)]);
  });

  describe('every public method runs the helper image of the open that it gets as `image` (review round 3 of PR #64, P7)', () => {
    const OVERRIDE = { image: 'devenv-x:1' };
    const cases: Array<[string, (helper: WorkspaceHelper, image: HelperImageUse) => Promise<unknown>]> = [
      ['run', (helper, image) => helperStep(helper, { image })],
      ['clone', (helper, image) => helper.clone({ volumeName: 'vol', repository: 'o/a', token: TOKEN, image })],
      ['readConfigFiles', (helper, image) => helper.readConfigFiles({ volumeName: 'vol', repository: 'o/a', configPath: '.devcontainer/devcontainer.json', image })],
      ['listConfigurations', (helper, image) => helper.listConfigurations({ volumeName: 'vol', repository: 'o/a', image })],
      [
        'readConfiguration (merged)',
        (helper, image) => helper.readConfiguration({ volumeName: 'vol', repository: 'o/a', configPath: '.devcontainer/devcontainer.json', environmentId: 'e', image }),
      ],
      [
        'readConfiguration (without the merged configuration, with an override)',
        (helper, image) =>
          helper.readConfiguration({ volumeName: 'vol', repository: 'o/a', configPath: '.devcontainer/devcontainer.json', environmentId: 'e', merged: false, override: OVERRIDE, image }),
      ],
      ['build', (helper, image) => helper.build({ volumeName: 'vol', repository: 'o/a', configPath: '.devcontainer/devcontainer.json', imageName: 'devenv-x:1', image })],
      [
        'build (with an override)',
        (helper, image) => helper.build({ volumeName: 'vol', repository: 'o/a', configPath: '.devcontainer/devcontainer.json', imageName: 'devenv-x:1', override: OVERRIDE, image }),
      ],
      ['composeModel', (helper, image) => helper.composeModel({ volumeName: 'vol', repository: 'o/a', files: ['/workspaces/a/compose.yaml'], project: 'p', image })],
      ['composeServiceHashes', (helper, image) => helper.composeServiceHashes({ volumeName: 'vol', repository: 'o/a', model: '{}', project: 'p', image })],
      ['createRepositoryFolders', (helper, image) => helper.createRepositoryFolders({ volumeName: 'vol', repository: 'o/a', folders: ['/workspaces/a/data'], image })],
      ['up', (helper, image) => helper.up({ volumeName: 'vol', repository: 'o/a', override: OVERRIDE, environmentId: 'e', removeExistingContainer: false, image })],
      [
        'runUserCommands',
        (helper, image) => helper.runUserCommands({ volumeName: 'vol', repository: 'o/a', override: OVERRIDE, environmentId: 'e', containerId: 'c'.repeat(64), token: TOKEN, image }),
      ],
      ['prepareGit', (helper, image) => helper.prepareGit({ volumeName: 'vol', repository: 'o/a', identity: { name: 'A', email: 'a@example.com' }, image })],
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the batch step ownershipFix takes CONFIG_FOLDER only (was: /workspaces/.devenv).
      ['fixConfigOwnership', (helper, image) => helper.fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000', image })],
    ];

    it.each(cases)('%s', async (_name, call) => {
      // user decision 2026-09-29: no previous helper image. Changed expectation: before, open A pinned a previous helper
      // and another open switched the cache to the current tag; now another window rebuilds the tag, and another open
      // of this window switches the cache to the new image.
      const { helper } = setup();
      const pinned = await helper.ensureImageUse();
      expect(pinned).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      const rebuilt = `sha256:${'7'.repeat(64)}`;
      docker.ids.set(TAG, rebuilt);
      expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: rebuilt });
      docker.handler = (args) => {
        if (args[0] !== 'run') return {};
        return { stdout: '{"outcome":"success","containerId":"cccc","configuration":{},"services":{}}\n' };
      };
      const before = docker.runs.length;
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the call runs in a batch scope.
      await call(batched(helper), pinned).catch(() => undefined);
      const used = references(before);
      expect(used.length).toBeGreaterThan(0);
      expect(used.every((reference) => reference === fakeImageId(TAG))).toBe(true);
    });
  });
});

describe('WorkspaceHelper.prebuildImage and HelperPrebuild (background prebuild, user decision 2026-09-29)', () => {
  const statePath = () => path.join(dir, 'storage', 'helper.json');

  function stateHelper(engine?: () => Promise<HelperEngine>): WorkspaceHelper {
    return new WorkspaceHelper({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'darwin',
      clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
      statePath: statePath(),
      engine,
    });
  }

  /** A build that waits for `release` and ends with an AbortError when its signal aborts. */
  function blockingBuild(): { release: () => void } {
    const gate = { release: () => undefined as void };
    docker.buildHandler = (options) =>
      new Promise<void>((resolve, reject) => {
        gate.release = resolve;
        options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    return gate;
  }

  function prebuild(helper: WorkspaceHelper, overrides: Partial<HelperPrebuildDeps> = {}): HelperPrebuild {
    return new HelperPrebuild({
      helper,
      dockerRunning: async () => true,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      statePath: statePath(),
      logger,
      ...overrides,
    });
  }

  it('builds a missing tag once: an open that starts during the prebuild waits for it and does not build again', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const helper = stateHelper();
    const gate = blockingBuild();
    const pre = helper.prebuildImage({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const open = helper.ensureImageUse();
    const run = helperStep(helper);
    gate.release();
    expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect((await run).exitCode).toBe(0);
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true });
  });

  it('joins the build of an open that runs already', async () => {
    const helper = stateHelper();
    const gate = blockingBuild();
    const open = helper.ensureImageUse();
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const pre = helper.prebuildImage({ signal: new AbortController().signal });
    gate.release();
    expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
  });

  it('is cancelled by its signal; an open that waited for it builds for itself', async () => {
    const helper = stateHelper();
    blockingBuild();
    const controller = new AbortController();
    const pre = helper.prebuildImage({ signal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const open = helper.ensureImageUse();
    docker.buildHandler = async () => undefined;
    controller.abort();
    expect(await pre).toMatchObject({ name: 'AbortError' });
    expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(2);
  });

  it('PR #77 review round 1 (A-R1-1): a prebuild whose build stalls ends at its time limit; an open and a worker preparation that waited for it build for themselves', async () => {
    const helper = stateHelper(async () => ({ key: 'build-box', socket: DOCKER_SOCKET }));
    blockingBuild();
    const pre = prebuild(helper, { timeoutMs: 200 }).start(REMOTE_TARGET);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const user = new AbortController();
    const cancelled = helper.ensureImageUse({ signal: user.signal }).catch((e: unknown) => e);
    user.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    const open = helper.ensureImageUse({ signal: new AbortController().signal });
    const lock = helper.ensureImagePresent({ signal: new AbortController().signal });
    docker.buildHandler = async () => undefined;
    expect(await pre).toBe('failed');
    expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await lock).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds[0].signal?.aborted).toBe(true);
  });

  it('PR #77 review round 2 (B-R2-1): without timeoutMs (as extension.ts starts it) a stalled prebuild ends at HELPER_PREBUILD_TIMEOUT_MS, at most 30 minutes', async () => {
    expect(HELPER_PREBUILD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(HELPER_PREBUILD_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gate = blockingBuild();
    try {
      const helper = stateHelper(async () => ({ key: 'build-box', socket: DOCKER_SOCKET }));
      let settled = false;
      const pre = prebuild(helper).start(REMOTE_TARGET);
      void pre.then(() => { settled = true; });
      // Not vi.waitFor: under fake timers it would advance the clock itself. Wait by the real clock (only setTimeout is
      // fake), not by a fixed number of turns: a loaded CI runner needed more than 500 (PR #78 CI, 2026-10-01).
      const deadline = Date.now() + 10_000;
      while (docker.builds.length === 0 && Date.now() < deadline) await new Promise((r) => setImmediate(r));
      expect(docker.builds).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(HELPER_PREBUILD_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pre).toBe('failed');
      expect(docker.builds[0].signal?.aborted).toBe(true);
    } finally {
      gate.release();
      vi.useRealTimers();
    }
  });

  // Review round 16 of PR #64 (R16-2): a caller that joined the build of another caller that is cancelled builds for itself.
  it('R16-2: an open that joined the build of another open that is cancelled builds for itself', async () => {
    const helper = stateHelper();
    blockingBuild();
    const a = new AbortController();
    const openA = helper.ensureImageUse({ signal: a.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const openB = helper.ensureImageUse();
    docker.buildHandler = async () => undefined;
    a.abort();
    expect(await openA).toMatchObject({ name: 'AbortError' });
    expect(await openB).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(2);
  });

  it('R16-2: a helper run that joined the build of an open that is cancelled builds for itself', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const helper = stateHelper();
    blockingBuild();
    const a = new AbortController();
    const openA = helper.ensureImageUse({ signal: a.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const run = helperStep(helper);
    docker.buildHandler = async () => undefined;
    a.abort();
    expect(await openA).toMatchObject({ name: 'AbortError' });
    expect((await run).exitCode).toBe(0);
    expect(docker.builds).toHaveLength(2);
    expect(docker.runs).toHaveLength(1);
  });

  // Review round 16 of PR #64 (R16-1): only a docker run that finds no helper image counts as a missing helper image.
  describe('R16-1: only a docker run that fails with exit code 125 and "No such image" counts as a missing helper image', () => {
    const cases: Array<[string, Partial<RunResult>]> = [
      ['a command that reports a missing image of its own (exit code 1)', { exitCode: 1, stderr: 'Error: No such image: sha256:abc\n' }],
      ['another docker run error (exit code 125)', { exitCode: 125, stderr: 'docker: Error response from daemon: Conflict. The container name "/x" is already in use.\n' }],
    ];

    it.each(cases)('pinned run: %s is the result of the run', async (_name, failure) => {
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
      const helper = stateHelper();
      const use = await helper.ensureImageUse();
      docker.handler = (args) => (args[0] === 'run' ? failure : {});
      const result = await helperStep(helper, { image: use });
      expect(result).toMatchObject(failure);
      expect(docker.runs).toHaveLength(1);
      // The cache of the window is kept: the next open reuses the image without a build.
      expect(await helper.ensureImageUse()).toEqual(use);
      expect(docker.builds).toHaveLength(1);
      expect(logger.lines.join('\n')).not.toContain('was removed');
    });

    it.each(cases)('unpinned run: %s is the result of the run, which is not run again', async (_name, failure) => {
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
      const helper = stateHelper();
      await helper.ensureImageUse();
      docker.handler = (args) => (args[0] === 'run' ? failure : {});
      const result = await helperStep(helper);
      expect(result).toMatchObject(failure);
      expect(docker.runs).toHaveLength(1);
      expect(logger.lines.join('\n')).not.toContain('It is built again');
    });
  });

  // Changed expectation (Plan step 6, PR D: the prebuild runs on every engine): this was "builds nothing when the Docker
  // context is a remote host" (prebuildImage returned undefined, HelperPrebuild answered `remote`).
  it('builds the missing tag also when the Docker context is a remote host (Plan step 6, PR D)', async () => {
    const helper = stateHelper(async () => ({ key: 'build-box', socket: DOCKER_SOCKET }));
    expect(await helper.prebuildImage({ signal: new AbortController().signal })).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await helper.engineKey()).toBe('build-box');
    expect(docker.builds).toHaveLength(1);
  });

  // Changed expectation (Plan step 6, PR D): this was "asks no Docker engine whether it runs when the Docker context is a
  // remote host" (review round 17 of PR #64, R17-2). The prebuild now runs as an operation on the remote target, so its
  // `docker info` goes to that host (with our own SSH check first, dockerEngineAnswers), and only when the state file of
  // that host does not know the tag (the test below: not due, nothing asked).
  it('prebuilds a remote target as an operation on it, with the state file of that engine (Plan step 6, PR D)', async () => {
    const helper = stateHelper(async () => ({ key: operationDockerTarget()?.host ?? '', socket: DOCKER_SOCKET }));
    const targetsOfBuild: Array<DockerTarget | undefined> = [];
    docker.buildHandler = async () => {
      targetsOfBuild.push(operationDockerTarget());
    };
    const running = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => true);
    expect(await prebuild(helper, { dockerRunning: running }).start(REMOTE_TARGET)).toBe('built');
    expect(running).toHaveBeenCalledTimes(1);
    expect(running.mock.calls[0][0]).toBe(REMOTE_TARGET);
    // The build ran within the operation on the remote target (its Docker calls get the context of that host).
    expect(targetsOfBuild).toEqual([REMOTE_TARGET]);
    // The record is in the state file of the remote engine, not in helper.json of the local Docker.
    const remoteState = JSON.parse(fs.readFileSync(helperStatePathFor(statePath(), 'build-box'), 'utf8')) as HelperState;
    expect(remoteState.images[TAG]?.builtAt).toBeDefined();
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('keeps "is due" per engine: a record of one engine does not count for another (Plan step 6, PR D)', async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(
      helperStatePathFor(statePath(), 'build-box'),
      JSON.stringify({ version: 1, images: { [TAG]: { builtAt: '2026-09-20T12:00:00.000Z' } } }),
    );
    const engine = async (): Promise<HelperEngine> => ({ key: operationDockerTarget()?.host ?? '', socket: DOCKER_SOCKET });
    // The remote host knows the tag: not due, and neither it nor its Docker is asked.
    const running = vi.fn(async () => true);
    expect(await prebuild(stateHelper(engine), { dockerRunning: running }).start(REMOTE_TARGET)).toBe('notDue');
    expect(running).not.toHaveBeenCalled();
    expect(docker.builds).toEqual([]);
    expect(docker.imageIdCalls).toBe(0);
    // helper.json of the local Docker does not know it: the local Docker is due and gets the build.
    expect(await prebuild(stateHelper(engine), { dockerRunning: running }).start(LOCAL_DOCKER_TARGET)).toBe('built');
    expect(running).toHaveBeenCalledWith(LOCAL_DOCKER_TARGET, expect.any(AbortSignal));
    expect(docker.builds).toHaveLength(1);
    // A new remote host has no record yet: it is due and its Docker is asked (the fake Docker of this test has the tag
    // already, so it is found there).
    const other: DockerTarget = { kind: 'remote', host: 'other-box', endpoint: 'ssh://other-box', context: 'devenv-other-box' };
    expect(await prebuild(stateHelper(engine), { dockerRunning: running }).start(other)).toBe('present');
    expect(running).toHaveBeenCalledWith(other, expect.any(AbortSignal));
    expect(fs.existsSync(helperStatePathFor(statePath(), 'other-box'))).toBe(true);
  });

  it('does nothing on a remote host whose Docker does not answer, and never on an unsupported endpoint (Plan step 6, PR D)', async () => {
    const engine = async (): Promise<HelperEngine> => ({ key: operationDockerTarget()?.host ?? '', socket: DOCKER_SOCKET });
    expect(await prebuild(stateHelper(engine), { dockerRunning: async () => false }).start(REMOTE_TARGET)).toBe('dockerNotRunning');
    expect(docker.builds).toEqual([]);
    expect(docker.imageIdCalls).toBe(0);
    expect(logger.lines.join('\n')).toContain('Docker is not running');
    const running = vi.fn(async () => true);
    const unsupported: DockerTarget = { kind: 'unsupported', host: 'tcp://10.0.0.5:2375', endpoint: 'tcp://10.0.0.5:2375' };
    expect(await prebuild(stateHelper(engine), { dockerRunning: running }).start(unsupported)).toBe('unsupported');
    expect(running).not.toHaveBeenCalled();
    expect(docker.builds).toEqual([]);
  });

  describe('dockerEngineAnswers (Plan step 6, PR D)', () => {
    function sshRunner(result: Partial<RunResult>) {
      return { run: vi.fn(async (_file: string, _args: readonly string[], _options?: RunOptions): Promise<RunResult> => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result })) };
    }

    it('asks the local Docker with docker info only, and never starts it', async () => {
      const runner = sshRunner({});
      const daemonStatus = vi.fn(async () => ({ running: false }));
      const deps = { daemonStatus, ssh: { runner, sshPath: '/usr/bin/ssh', env: {} }, logger };
      expect(await dockerEngineAnswers(LOCAL_DOCKER_TARGET, deps, new AbortController().signal)).toBe(false);
      expect(daemonStatus).toHaveBeenCalledTimes(1);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('checks a remote host with ssh -o BatchMode=yes first, so no question is ever asked; then docker info with the remote time limit', async () => {
      const runner = sshRunner({});
      const daemonStatus = vi.fn(async (_signal: AbortSignal, _timeoutMs?: number) => ({ running: true }));
      const deps = { daemonStatus, ssh: { runner, sshPath: '/usr/bin/ssh', env: {} }, logger };
      expect(await dockerEngineAnswers(REMOTE_TARGET, deps, new AbortController().signal)).toBe(true);
      expect(runner.run).toHaveBeenCalledTimes(1);
      const [file, args, options] = runner.run.mock.calls[0];
      expect(file).toBe('/usr/bin/ssh');
      expect(args).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes']));
      expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
      expect(daemonStatus).toHaveBeenCalledWith(expect.any(AbortSignal), REMOTE_INFO_TIMEOUT_MS);
    });

    it('answers false without docker info when the SSH check of a remote host fails, and false for an unsupported endpoint', async () => {
      const runner = sshRunner({ exitCode: 255, stderr: 'build-box: Permission denied (publickey).' });
      const daemonStatus = vi.fn(async () => ({ running: true }));
      const deps = { daemonStatus, ssh: { runner, sshPath: '/usr/bin/ssh', env: {} }, logger };
      expect(await dockerEngineAnswers(REMOTE_TARGET, deps, new AbortController().signal)).toBe(false);
      expect(daemonStatus).not.toHaveBeenCalled();
      expect(logger.lines.join('\n')).toContain('cannot be reached over SSH');
      const unsupported: DockerTarget = { kind: 'unsupported', host: 'tcp://10.0.0.5:2375', endpoint: 'tcp://10.0.0.5:2375' };
      expect(await dockerEngineAnswers(unsupported, deps, new AbortController().signal)).toBe(false);
      expect(daemonStatus).not.toHaveBeenCalled();
      expect(runner.run).toHaveBeenCalledTimes(1);
    });

    it('PR #77 review round 1 (A-R1-2): answers false without docker info for a remote host that our ssh cannot check (no unattended question)', async () => {
      const runner = sshRunner({});
      const daemonStatus = vi.fn(async () => ({ running: true }));
      const deps = { daemonStatus, ssh: { runner, sshPath: '/usr/bin/ssh', env: {} }, logger };
      const odd: DockerTarget = { kind: 'remote', host: 'me@corp.example@build-box', endpoint: 'ssh://me@corp.example@build-box', context: 'odd' };
      expect(await dockerEngineAnswers(odd, deps, new AbortController().signal)).toBe(false);
      expect(runner.run).not.toHaveBeenCalled();
      expect(daemonStatus).not.toHaveBeenCalled();
    });
  });

  // Review round 5 of PR #64, R5-2: helper.json alone decides whether the prebuild is due; there is no extension version
  // to remember anymore (the expectation on the saved version is gone).
  // Review round 7 of PR #64 (R7-3): a caller whose signal is already aborted when it would start the shared ensure
  // starts nothing (no build, no Docker call) and leaves no unhandled rejection behind.
  it('a cancelled caller starts no shared ensure and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      docker.buildHandler = async (options) => {
        if (options.signal?.aborted) throw abortError();
      };
      const helper = stateHelper();
      await expect(helper.prebuildImage({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      await expect(helper.ensureImageUse({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      expect(docker.builds).toEqual([]);
      expect(docker.imageIdCalls).toBe(0);
      // Cancelled during the check of a cached image: the tag is gone, so the cache is reset, and nothing starts.
      await helper.ensureImageUse();
      expect(docker.builds).toHaveLength(1);
      docker.images.delete(TAG);
      const controller = new AbortController();
      const imageId = docker.imageId.bind(docker);
      docker.imageId = async (...args: Parameters<typeof docker.imageId>) => {
        controller.abort();
        return imageId(...args);
      };
      await expect(helper.ensureImageUse({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(docker.builds).toHaveLength(1);
      docker.imageId = imageId;
      await helper.ensureImageUse();
      expect(docker.builds).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('HelperPrebuild builds the tag that helper.json does not know, logs it, and the next open does not build', async () => {
    const helper = stateHelper();
    const task = prebuild(helper);
    expect(await task.start()).toBe('built');
    expect(logger.lines).toContain('info The workspace helper image is built in the background.');
    expect(logger.lines).toContain(`info The workspace helper image ${TAG} was built in the background.`);
    expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
    // start() runs once.
    expect(await task.start()).toBe('built');
    expect(docker.builds).toHaveLength(1);
    // Review round 5 of PR #64, R5-2: a window that starts later finds the record of the build and does nothing.
    const running = vi.fn(async () => true);
    expect(await prebuild(stateHelper(), { dockerRunning: running }).start()).toBe('notDue');
    expect(running).not.toHaveBeenCalled();
  });

  it('HelperPrebuild runs when helper.json does not know the current tag, and finds an existing tag', async () => {
    docker.images.add(TAG);
    const helper = stateHelper();
    expect(await prebuild(helper).start()).toBe('present');
    expect(docker.builds).toEqual([]);
    expect(logger.lines).toContain(`info The workspace helper image ${TAG} is ready.`);
  });

  it('HelperPrebuild asks Docker nothing when it is not due', async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ version: 1, images: { [TAG]: { builtAt: '2026-09-20T12:00:00.000Z' } } }));
    let asked = false;
    const helper = stateHelper(async () => {
      asked = true;
      return { key: '' };
    });
    const running = vi.fn(async () => true);
    // Review round 5 of PR #64, R5-2: a live record of the current tag is enough (no version).
    expect(await prebuild(helper, { dockerRunning: running }).start()).toBe('notDue');
    // Changed expectation (Plan step 6, PR D): the engine is read for the key of its state file (in the extension the
    // target of the operation, no Docker call); this was `false`. Docker itself is still not asked (below).
    expect(asked).toBe(true);
    expect(running).not.toHaveBeenCalled();
    expect(docker.imageIdCalls).toBe(0);
    // A tag that the cleanup removed is not known.
    fs.writeFileSync(statePath(), JSON.stringify({ version: 1, images: { [TAG]: { removedAt: '2026-09-20T12:00:00.000Z' } } }));
    expect(await prebuild(helper, { dockerRunning: running }).start()).toBe('built');
  });

  // Review round 5 of PR #64, R5-2: no version to remember (the expectation on the saved version is gone).
  // Changed expectation (review round 6 of PR #64, R6-1: no cross-window lock): the expectation that no lock file exists is gone.
  it('HelperPrebuild does not build when Docker is not running', async () => {
    const helper = stateHelper();
    expect(await prebuild(helper, { dockerRunning: async () => false }).start()).toBe('dockerNotRunning');
    expect(docker.builds).toEqual([]);
    expect(logger.lines.join('\n')).toContain('Docker is not running');
  });

  // Review round 5 of PR #64, R5-2: no version to remember (the expectation on the saved version is gone).
  // Changed expectation (review round 6 of PR #64, R6-1: no cross-window lock): the expectations on the lock file are gone.
  it('HelperPrebuild is cancelled by dispose, and a failed build is logged', async () => {
    const helper = stateHelper();
    blockingBuild();
    const task = prebuild(helper);
    const outcome = task.start();
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    task.dispose();
    expect(await outcome).toBe('cancelled');
    // The docker build got the signal of the prebuild.
    expect(docker.builds[0].signal?.aborted).toBe(true);

    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
    };
    expect(await prebuild(helper).start()).toBe('failed');
    expect(logger.lines.join('\n')).toContain('The workspace helper image could not be prepared in the background');
  });

  // Changed expectation (review round 6 of PR #64, R6-1: no cross-window lock): this replaces the test "two windows over
  // the same helper.json: exactly one build, the other window is busy".
  it('HelperPrebuild disposed while it reads helper.json asks Docker nothing (review round 20 of PR #64, B-R20-5b)', async () => {
    const helper = {
      // Plan step 6, PR D: engineKey replaces usesLocalEngine (the prebuild reads the state file of the engine).
      engineKey: vi.fn(async () => ''),
      prebuildImage: vi.fn(async (options: { signal: AbortSignal }) => {
        if (options.signal.aborted) throw abortError();
        return { tag: TAG, id: fakeImageId(TAG) };
      }),
    };
    const running = vi.fn(async () => true);
    const task = prebuild(stateHelper(), { helper, dockerRunning: running });
    const outcome = task.start();
    task.dispose();
    expect(await outcome).toBe('cancelled');
    expect(helper.engineKey).not.toHaveBeenCalled();
    expect(running).not.toHaveBeenCalled();
    expect(helper.prebuildImage).not.toHaveBeenCalled();
  });

  it('HelperPrebuild disposed during the build is cancelled, also when the build then fails with another error (review round 20 of PR #64, B-R20-5c)', async () => {
    const helper = {
      // Plan step 6, PR D: engineKey replaces usesLocalEngine.
      engineKey: vi.fn(async () => ''),
      prebuildImage: vi.fn(
        (options: { signal: AbortSignal }) =>
          new Promise<HelperImageUse>((_resolve, reject) => {
            // The killed docker build ends with an ordinary failure, which the helper reports as helperFailed.
            options.signal.addEventListener('abort', () => reject(new UserFacingError('helperFailed', 'The workspace helper could not be prepared.', 'exit code 143')), { once: true });
          }),
      ),
    };
    const task = prebuild(stateHelper(), { helper });
    const outcome = task.start();
    await vi.waitFor(() => expect(helper.prebuildImage).toHaveBeenCalled());
    task.dispose();
    expect(await outcome).toBe('cancelled');
    expect(logger.lines.join('\n')).not.toContain('could not be prepared in the background');
  });

  it('HelperPrebuild is cancelled, without a warning, when a step fails with another error after dispose (review round 20 of PR #64, B-R20-5c)', async () => {
    let task: HelperPrebuild | undefined;
    const helper = {
      // Deactivation while the Docker context is read; the read then fails with an ordinary error. Plan step 6, PR D:
      // engineKey replaces usesLocalEngine (read for the state file of the engine).
      engineKey: async (): Promise<string> => {
        task?.dispose();
        throw new Error('the Docker context cannot be read');
      },
      prebuildImage: async () => ({ tag: TAG, id: fakeImageId(TAG) }),
    };
    task = prebuild(stateHelper(), { helper });
    expect(await task.start()).toBe('cancelled');
    expect(logger.lines.join('\n')).not.toContain('could not be prepared in the background');
  });

  describe('windows without a cross-window lock (review round 6 of PR #64, R6-1)', () => {
    it('two windows that start together may each build; a window that starts later is not due and asks Docker nothing', async () => {
      const releases: Array<() => void> = [];
      docker.buildHandler = () => new Promise<void>((resolve) => releases.push(resolve));
      const first = prebuild(stateHelper()).start();
      const second = prebuild(stateHelper()).start();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(2));
      for (const release of releases) release();
      expect(await Promise.all([first, second])).toEqual(['built', 'built']);
      expect(logger.lines.join('\n')).not.toContain('another window');
      const builds = docker.builds.length;
      const imageIdCalls = docker.imageIdCalls;
      let asked = false;
      const third = stateHelper(async () => {
        asked = true;
        return { key: '' };
      });
      const running = vi.fn(async () => true);
      expect(await prebuild(third, { dockerRunning: running }).start()).toBe('notDue');
      // Changed expectation (Plan step 6, PR D): the engine is read for the key of its state file (no Docker call); this
      // was `false`. Docker itself is still not asked (below).
      expect(asked).toBe(true);
      expect(running).not.toHaveBeenCalled();
      expect(docker.builds).toHaveLength(builds);
      expect(docker.imageIdCalls).toBe(imageIdCalls);
    });

    it('asks Docker nothing for a live record of the current tag', async () => {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify({ version: 1, images: { [TAG]: { builtAt: '2026-09-20T12:00:00.000Z' } } }));
      const helper = { engineKey: vi.fn(async () => ''), prebuildImage: vi.fn(async () => ({ tag: TAG, id: fakeImageId(TAG) })) };
      const running = vi.fn(async () => true);
      expect(await prebuild(stateHelper(), { helper, dockerRunning: running }).start()).toBe('notDue');
      // Changed expectation (Plan step 6, PR D): the engine key is read now (it picks the state file of the engine; in
      // the extension it is the target of the operation, no Docker call); this was "usesLocalEngine not called".
      expect(helper.engineKey).toHaveBeenCalledTimes(1);
      expect(helper.prebuildImage).not.toHaveBeenCalled();
      expect(running).not.toHaveBeenCalled();
      expect(docker.imageIdCalls).toBe(0);
    });
  });

  // Review round 5 of PR #64, R5-3 (a): the prebuild does no maintenance.
  it('does no maintenance: no rebuild that a check asked for, no check of the base image, no cleanup', async () => {
    docker.images.add(TAG);
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    const old = '2026-09-01T12:00:00.000Z';
    const record = {
      baseImage: 'node:22-bookworm-slim',
      baseDigest: `sha256:${'a'.repeat(64)}`,
      latestBaseDigest: `sha256:${'b'.repeat(64)}`,
      builtAt: old,
      checkedAt: old,
      lastUsedAt: old,
    };
    fs.writeFileSync(statePath(), JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: old }));
    const helper = stateHelper();
    expect(await helper.prebuildImage({ signal: new AbortController().signal })).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toEqual([]);
    expect(docker.listCalls).toBe(0);
    expect(docker.removals).toEqual([]);
  });

  describe('a caller that joins the shared build can cancel its wait and gets the progress (review round 5 of PR #64, R5-1)', () => {
    it('an open that waits for the prebuild ends at once when its signal aborts; the prebuild goes on and its result is reused', async () => {
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const controller = new AbortController();
      let openError: unknown;
      // Its onBuild tells when it waits for the build (the build has started).
      let waits = false;
      const open = helper
        .ensureImageUse({ signal: controller.signal, onBuild: () => (waits = true) })
        .catch((error: unknown) => (openError = error));
      await vi.waitFor(() => expect(waits).toBe(true));
      controller.abort();
      await vi.waitFor(() => expect(openError).toMatchObject({ name: 'AbortError' }));
      await open;
      // The shared build did not get the abort.
      expect(docker.builds[0].signal?.aborted).toBe(false);
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
      expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    });

    // Review round 21 of PR #64 (B-R21-1): the abort of an open that waits for the build of a helper run (here the
    // prebuild) keeps that still-running build in the cache, so a helper run that starts before it ends joins it.
    it('an open that cancels its wait keeps the running prebuild in the cache; a later helper run joins it', async () => {
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const controller = new AbortController();
      let waits = false;
      const open = helper.ensureImageUse({ signal: controller.signal, onBuild: () => (waits = true) });
      await vi.waitFor(() => expect(waits).toBe(true));
      controller.abort();
      await expect(open).rejects.toMatchObject({ name: 'AbortError' });
      const run = helperStep(helper);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The run waits for the build of the prebuild; it starts no build of its own (checked before the release, which a
      // second build would replace).
      expect(docker.builds).toHaveLength(1);
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect((await run).exitCode).toBe(0);
      expect(docker.builds).toHaveLength(1);
      expect(docker.runs).toHaveLength(1);
    });

    it('a helper run that waits for the prebuild ends at once when its signal aborts, without a docker run', async () => {
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const controller = new AbortController();
      let runError: unknown;
      const run = helperStep(helper, { signal: controller.signal }).catch((error: unknown) => (runError = error));
      // The run waits for the build now (the engine is known at once).
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runError).toBeUndefined();
      controller.abort();
      await vi.waitFor(() => expect(runError).toMatchObject({ name: 'AbortError' }));
      await run;
      expect(docker.runs).toEqual([]);
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
      expect(docker.runs).toEqual([]);
    });

    it('a caller whose signal was aborted before it joins ends at once', async () => {
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      await expect(helper.ensureImageUse({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      await expect(helperStep(helper, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    });

    // Review round 6 of PR #64, R6-5: renamed to what it covers (prebuildImage awaits usesLocalEngine first, so the open
    // creates the shared promise and the prebuild joins it); the test below covers the prebuild that owns the promise.
    // Plan step 6, PR D: prebuildImage no longer awaits usesLocalEngine (it goes to the shared ensure at once); the
    // expectations stay: one build, and every caller that joins before or after its start gets its progress.
    it('a prebuild that joins an open that has not started its build yet; a later open gets create', async () => {
      const helper = stateHelper();
      const gate = blockingBuild();
      const own: string[] = [];
      const pre = helper.prebuildImage({ signal: new AbortController().signal, onBuild: (kind) => own.push(kind) });
      // Joins before the build started (the Dockerfile is not read yet).
      const early: string[] = [];
      const first = helper.ensureImageUse({ onBuild: (kind) => early.push(kind) });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      // Joins after the build started.
      const late: string[] = [];
      const second = helper.ensureImageUse({ onBuild: (kind) => late.push(kind) });
      await vi.waitFor(() => expect(late).toEqual(['create']));
      gate.release();
      await pre;
      await first;
      await second;
      expect(own).toEqual(['create']);
      expect(early).toEqual(['create']);
      expect(late).toEqual(['create']);
      expect(docker.builds).toHaveLength(1);
      // A caller that reuses the result later gets no progress.
      const after: string[] = [];
      await helper.ensureImageUse({ onBuild: (kind) => after.push(kind) });
      expect(after).toEqual([]);
    });

    // Review round 6 of PR #64, R6-5: the prebuild owns the shared promise (it waits for the digest of the base image);
    // an open that joins it before the build started gets create when the build starts, and does not start its own.
    it('an open that joins the promise of the prebuild before its build started gets create when it starts', async () => {
      let asked = false;
      let releaseDigest: (digest: string) => void = () => undefined;
      const helper = new WorkspaceHelper({
        docker,
        logger,
        dockerfilePath: path.join(dir, 'Dockerfile'),
        env: {},
        platform: 'darwin',
        clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
        statePath: statePath(),
        baseDigest: () => {
          asked = true;
          return new Promise<string>((resolve) => (releaseDigest = resolve));
        },
      });
      const gate = blockingBuild();
      const controller = new AbortController();
      const pre = helper.prebuildImage({ signal: controller.signal });
      await vi.waitFor(() => expect(asked).toBe(true));
      const early: string[] = [];
      const open = helper.ensureImageUse({ onBuild: (kind) => early.push(kind) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(early).toEqual([]);
      releaseDigest('sha256:' + 'a'.repeat(64));
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      // The build is the one of the prebuild.
      expect(docker.builds[0].signal).toBe(controller.signal);
      await vi.waitFor(() => expect(early).toEqual(['create']));
      gate.release();
      await pre;
      await open;
      expect(docker.builds).toHaveLength(1);
    });

    it('a prebuild that joins the build of an open gets its progress', async () => {
      const helper = createHelper();
      const gate = blockingBuild();
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const kinds: string[] = [];
      const pre = helper.prebuildImage({ signal: new AbortController().signal, onBuild: (kind) => kinds.push(kind) });
      await vi.waitFor(() => expect(kinds).toEqual(['create']));
      gate.release();
      await open;
      await pre;
      expect(docker.builds).toHaveLength(1);
    });

    // Review round 20 of PR #64 (B-R20-5e): the cleanup of a caller that joined the shared build.
    it('a caller that cancelled its wait before the build started gets no progress of that build', async () => {
      let releaseDigest: (digest: string) => void = () => undefined;
      let asked = false;
      const helper = new WorkspaceHelper({
        docker,
        logger,
        dockerfilePath: path.join(dir, 'Dockerfile'),
        env: {},
        platform: 'darwin',
        clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
        statePath: statePath(),
        baseDigest: () => {
          asked = true;
          return new Promise<string>((resolve) => (releaseDigest = resolve));
        },
      });
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(asked).toBe(true));
      const controller = new AbortController();
      const kinds: string[] = [];
      const open = helper.ensureImageUse({ signal: controller.signal, onBuild: (kind) => kinds.push(kind) }).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      expect(await open).toMatchObject({ name: 'AbortError' });
      releaseDigest('sha256:' + 'a'.repeat(64));
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(kinds).toEqual([]);
    });

    it('a helper run that joined the prebuild leaves no abort listener on its signal', async () => {
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const controller = new AbortController();
      const run = helperStep(helper, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      gate.release();
      await pre;
      expect((await run).exitCode).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    });

    it('a caller that joins a promise that only finds the existing tag gets no onBuild', async () => {
      docker.images.add(TAG);
      const helper = stateHelper();
      const kinds: string[] = [];
      const pre = helper.prebuildImage({ signal: new AbortController().signal, onBuild: (kind) => kinds.push(kind) });
      const open = helper.ensureImageUse({ onBuild: (kind) => kinds.push(kind) });
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(kinds).toEqual([]);
      expect(docker.builds).toEqual([]);
    });
  });
});

describe('WorkspaceHelper helper runs in a new window (implementation notes 7)', () => {
  const START = Date.parse('2026-09-24T12:00:00Z');
  const DIGEST_A = `sha256:${'a'.repeat(64)}`;
  const DIGEST_B = `sha256:${'b'.repeat(64)}`;

  function newWindow() {
    let now = START;
    const lookups: string[] = [];
    const checks: Array<Promise<void>> = [];
    const statePath = path.join(dir, 'storage', 'helper.json');
    const helper = new WorkspaceHelper({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'darwin',
      clock: { now: () => now },
      statePath,
      baseDigest: async (reference) => {
        lookups.push(reference);
        return DIGEST_B;
      },
      onBaseImageCheck: (check) => checks.push(check),
    });
    const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
    return {
      helper,
      lookups,
      iso,
      advance: (ms: number) => {
        now += ms;
      },
      state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState,
      settled: () => Promise.all(checks.splice(0)),
      /** The helper exists, its weekly check and the cleanup are 8 days overdue, and its base image changed. */
      overdue: () => {
        docker.images.add(TAG);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const old = iso(-8 * 24 * 60 * 60 * 1000);
        const record = { baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, builtAt: old, checkedAt: old, lastUsedAt: old };
        fs.writeFileSync(statePath, JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: old }));
      },
    };
  }

  // 2026-10-01: the Switch branch command was dropped (user decision).
  it('never checks, rebuilds, or cleans up in the first helper run (a stop, a delete)', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const w = newWindow();
    w.overdue();
    const result = await helperStep(w.helper);
    expect(result.exitCode).toBe(0);
    await w.settled();
    expect(docker.runs).toHaveLength(1);
    expect(w.lookups).toEqual([]);
    expect(docker.builds).toEqual([]);
    expect(docker.listCalls).toBe(0);
    expect(docker.removals).toEqual([]);
    expect(w.state().images[TAG].lastUsedAt).toBe(w.iso());
    expect(w.state().images[TAG].checkedAt).toBe(w.iso(-8 * 24 * 60 * 60 * 1000));

    // The open pipeline (ensureImage) in the same window does the maintenance: the check (in the background) and the
    // cleanup. The rebuild that the check asks for comes with the next ensureImage.
    await w.helper.ensureImage();
    await w.settled();
    expect(w.lookups).toHaveLength(1);
    expect(docker.listCalls).toBe(1);
    expect(w.state().images[TAG].latestBaseDigest).toBe(DIGEST_B);
    w.advance(HELPER_IMAGE_RECHECK_MS);
    await w.helper.ensureImage();
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ pull: true, noCache: true });
  });

  it('builds a missing tag once in the first helper run, and the open pipeline then maintains without a second build', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const w = newWindow();
    let release: () => void = () => undefined;
    docker.buildHandler = () => new Promise<void>((resolve) => (release = resolve));
    const run = helperStep(w.helper);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const ensured = w.helper.ensureImage();
    release();
    expect((await run).exitCode).toBe(0);
    expect(await ensured).toBe(TAG);
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ pull: true });
    // ensureImage ran ensureHelperImage again, with the maintenance: the cleanup is due in a new state file.
    expect(docker.listCalls).toBe(1);
  });
});

describe('WorkspaceHelper.clone', () => {
  it('passes the token only on stdin, with the tmpfs mount', async () => {
    const helper = createHelper();
    await helper.clone({ volumeName: 'vol', repository: 'acme/api', branch: 'dev', token: TOKEN });
    const run = docker.runs[0];
    expect(run.options.input).toBe(TOKEN);
    expect(run.args.some((arg) => arg.includes(TOKEN))).toBe(false);
    expect(run.options.env).toBeUndefined();
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the token is the secret of the step (the input of the clone in the batch helper,
    // which keeps it in its own tmpfs); the per-step tmpfs mount is gone.
    expect(bridge.kinds).toEqual(['clone']);
    expect(run.args).not.toContain('-e');
    expect(commandOf(run.args)).toEqual(['sh', '-c', CLONE_SCRIPT, 'sh', 'acme/api', 'api', 'dev']);
    expect(logger.lines.join('\n')).not.toContain(TOKEN);
  });

  it('uses the default branch without a branch', async () => {
    await createHelper().clone({ volumeName: 'vol', repository: 'acme/api', token: TOKEN });
    expect(commandOf(docker.runs[0].args).slice(-3)).toEqual(['acme/api', 'api', '']);
  });

  it('throws a CommandError without the token when the clone fails', async () => {
    docker.handler = () => ({ exitCode: 128, stderr: `fatal: could not read Password for 'https://${TOKEN}@github.com'\n` });
    const output: string[] = [];
    const error = await createHelper()
      .clone({ volumeName: 'vol', repository: 'acme/api', token: TOKEN, onOutput: (text) => output.push(text) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).exitCode).toBe(128);
    expect((error as CommandError).message).not.toContain(TOKEN);
    expect((error as CommandError).stderr).toContain('***');
    expect(output.join('')).not.toContain(TOKEN);
  });

  it('refuses an empty token and invalid repository names before any Docker call', async () => {
    const helper = createHelper();
    await expect(helper.clone({ volumeName: 'vol', repository: 'acme/api', token: '' })).rejects.toMatchObject({
      code: 'signInRequired',
    });
    await expect(helper.clone({ volumeName: 'vol', repository: 'acme/a b', token: TOKEN })).rejects.toThrow(/Invalid repository/);
    await expect(helper.clone({ volumeName: 'vol', repository: 'acme/..', token: TOKEN })).rejects.toThrow(/Invalid repository/);
    expect(docker.calls).toHaveLength(0);
  });
});

describe('WorkspaceHelper.prepareGit (concept section 9 "Git inside the container")', () => {
  const identity = { name: 'Hannes Stauss', email: '1001+scalarion@users.noreply.github.com' };

  // unit 15: prepareGit gets no token any more (the token goes into the memory of the dev container after its start,
  // writeContainerToken, tested in containerToken.test.ts): no stdin, no tmpfs, and no login argument.
  it('runs without the token, as the step gitFiles', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step gitFiles of the batch helper (root, as before; the
    // per-step mounts and `--network none` are gone, Q2 of 2026-10-01); still no token, no input and no variable.
    await createHelper().prepareGit({ volumeName: 'vol', repository: 'acme/api', identity });
    const run = docker.runs[0];
    expect(bridge.kinds).toEqual(['gitFiles']);
    expect(run.options.input).toBeUndefined();
    expect(run.args).not.toContain('-e');
    expect(commandOf(run.args)).toEqual(['sh', '-c', GIT_FILES_SCRIPT, 'sh', 'api', identity.name, identity.email, CONTAINER_CREDENTIAL_HELPER]);
  });

  it('throws a CommandError when the script fails', async () => {
    docker.handler = () => ({ exitCode: 4, stdout: '', stderr: 'The folder /workspaces/api does not exist.\n' });
    const output: string[] = [];
    const error = await createHelper()
      .prepareGit({ volumeName: 'vol', repository: 'acme/api', identity, onOutput: (text) => output.push(text) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).stderr).toContain('The folder /workspaces/api does not exist.');
  });

  // unit 15: was "refuses an empty token before any Docker call"; without a token, an invalid repository name is what
  // stops it before any Docker call.
  it('refuses an invalid repository name before any Docker call', async () => {
    await expect(createHelper().prepareGit({ volumeName: 'vol', repository: 'acme', identity })).rejects.toThrow();
    expect(docker.calls).toHaveLength(0);
  });
});

// Greenfield (user decision 2026-09-27): removeGitToken, which ran this test, is gone; the time limit of a helper run
// stays (fixConfigOwnership).
describe('WorkspaceHelper helper run with a time limit', () => {
  it('ends the helper run after the time limit', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the batch helper ends the step at its time limit (its
    // process group); there is no per-step container to remove (was: `docker rm -f` of the helper container).
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    docker.handler = (args, options) => {
      if (args[0] !== 'run') return {};
      started();
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(abortError())));
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = createHelper().fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1001', timeoutMs: 30_000 });
      const caught = result.catch((e: unknown) => e);
      await running;
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await caught;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/did not end within 30 seconds/);
      expect(bridge.kinds).toEqual(['ownershipFix']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WorkspaceHelper.fixConfigOwnership (review round 15, K3)', () => {
  it('fixes the internal folder with numeric IDs, as the step ownershipFix', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step ownershipFix of the batch helper (was: a per-step run
    // with only the workspace volume, without the Docker socket, the cache volume and network).
    const result = await createHelper().fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1001', timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(docker.runs).toHaveLength(1);
    const run = docker.runs[0];
    expect(commandOf(run.args)).toEqual(configOwnershipFixCommand('/workspaces/.devenv+', '1000', '1001'));
    expect(bridge.kinds).toEqual(['ownershipFix']);
    expect(run.args).not.toContain('-e');
  });

  it('refuses IDs that are not numbers before any run', async () => {
    await expect(createHelper().fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: 'vscode', gid: '1000' })).rejects.toThrow();
    expect(docker.runs).toEqual([]);
  });

  it('returns a non-zero exit code', async () => {
    docker.handler = () => ({ exitCode: 1, stderr: '/workspaces/.devenv+ is not a folder.\n' });
    const result = await createHelper().fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' });
    expect(result.exitCode).toBe(1);
  });
});

describe('WorkspaceHelper file and Git queries', () => {
  it('readConfigFiles returns the files, or undefined for a missing configuration', async () => {
    const helper = createHelper();
    docker.handler = () => ({ stdout: '{"configText":"{}","dockerfilePath":".devcontainer/Dockerfile","dockerfileText":"FROM x"}\n' });
    expect(await helper.readConfigFiles({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer/devcontainer.json' })).toEqual({
      configText: '{}',
      dockerfilePath: '.devcontainer/Dockerfile',
      dockerfileText: 'FROM x',
    });
    expect(commandOf(docker.runs[0].args)).toEqual(['node', '-e', READ_FILES_SCRIPT, '/workspaces/api', '.devcontainer/devcontainer.json']);

    docker.handler = () => ({ stdout: 'null\n' });
    expect(await helper.readConfigFiles({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer.json' })).toBeUndefined();
  });

  it('readConfigFiles rejects paths outside of the repository', async () => {
    const helper = createHelper();
    for (const configPath of ['../x/devcontainer.json', '/etc/devcontainer.json', '.devcontainer/../../x', '']) {
      await expect(helper.readConfigFiles({ volumeName: 'vol', repository: 'acme/api', configPath })).rejects.toThrow(
        /Invalid configuration path/,
      );
    }
    expect(docker.runs).toHaveLength(0);
  });

  it('readConfigFiles takes a configuration path with a backslash, as the discovery lists it (review round 6, note of S)', async () => {
    const helper = createHelper();
    docker.handler = () => ({ stdout: '{"configText":"{}"}\n' });
    const configPath = '.devcontainer/a\\b/devcontainer.json';
    expect(await helper.readConfigFiles({ volumeName: 'vol', repository: 'acme/api', configPath })).toEqual({ configText: '{}' });
    expect(commandOf(docker.runs[0].args)).toEqual(['node', '-e', READ_FILES_SCRIPT, '/workspaces/api', configPath]);
    // Still refused: a path outside of the repository, with a backslash too.
    for (const outside of ['..\\x/../devcontainer.json', '/a\\b/devcontainer.json', '.devcontainer/a\\b/../../../x']) {
      await expect(helper.readConfigFiles({ volumeName: 'vol', repository: 'acme/api', configPath: outside })).rejects.toThrow(/Invalid configuration path/);
    }
  });

  it('listConfigurations returns the list of the script', async () => {
    docker.handler = () => ({ stdout: '[".devcontainer/devcontainer.json",".devcontainer/python/devcontainer.json"]\n' });
    expect(await createHelper().listConfigurations({ volumeName: 'vol', repository: 'acme/api' })).toEqual([
      '.devcontainer/devcontainer.json',
      '.devcontainer/python/devcontainer.json',
    ]);
    expect(commandOf(docker.runs[0].args)).toEqual(['node', '-e', LIST_CONFIGS_SCRIPT, '/workspaces/api']);
  });

  it('gitSummary parses the output of the script', async () => {
    docker.handler = () => ({ stdout: 'main\n1\n2\n0\n' });
    expect(await createHelper().gitSummary({ volumeName: 'vol', repository: 'acme/api' })).toEqual({
      branch: 'main',
      uncommittedFiles: 1,
      unpushedCommits: 2,
      stashes: 0,
      recordedAt: '2026-09-24T17:10:00.000Z',
    });
    expect(commandOf(docker.runs[0].args)).toEqual(['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', '/workspaces/api']);
  });

  it('throws CommandError when a query fails', async () => {
    docker.handler = () => ({ exitCode: 128, stderr: 'fatal: not a git repository\n' });
    await expect(createHelper().gitSummary({ volumeName: 'vol', repository: 'acme/api' })).rejects.toBeInstanceOf(CommandError);
  });
});

describe('Docker access of the helper runs', () => {
  // Plan step 7 (user decision of 2026-10-01): the per-step path is removed, and with it the tests of the mounts of the
  // per-step runs (the socket of the engine for the batch helper: batchScope.test.ts, B-R1-7).
  it('does not reuse the helper image of another engine (the Docker context changed)', async () => {
    let engine: HelperEngine = { key: '' };
    const statePath = path.join(dir, 'helper.json');
    const helper = new WorkspaceHelper({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'linux',
      statePath,
      engine: async () => engine,
    });
    await helper.ensureImage();
    expect(docker.builds).toHaveLength(1);
    // The remote engine does not have the image: it is built there, with its own state file.
    docker.images.clear();
    engine = { key: 'box', socket: '/var/run/docker.sock' };
    await helper.ensureImage();
    expect(docker.builds).toHaveLength(2);
    expect(fs.existsSync(helperStatePathFor(statePath, 'box'))).toBe(true);
    // The same engine again: reused.
    await helper.ensureImage();
    expect(docker.builds).toHaveLength(2);
  });
});

describe('WorkspaceHelper Dev Container CLI calls', () => {
  it('readConfiguration returns the configuration and the merged configuration, and passes no variable of the computer', async () => {
    docker.handler = () => ({
      stdout: '{"configuration":{"image":"node:22","runArgs":["--init"]},"mergedConfiguration":{"privileged":true},"workspace":{}}\n',
      stderr: '[2026] @devcontainers/cli 0.89.0.\n',
    });
    const output: string[] = [];
    const result = await createHelper().readConfiguration({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer/devcontainer.json',
      environmentId: '3f2a9c1e-5b7d',
      onOutput: (text) => output.push(text),
    });
    expect(result).toEqual({ config: { image: 'node:22', runArgs: ['--init'] }, merged: { privileged: true } });
    expect(output.join('')).toContain('@devcontainers/cli');
    const args = docker.runs[0].args;
    expect(args).not.toContain('-e');
    expect(commandOf(args)).toEqual([
      'devcontainer',
      'read-configuration',
      '--workspace-folder',
      '/workspaces/api',
      '--config',
      '/workspaces/api/.devcontainer/devcontainer.json',
      '--id-label',
      'nimblescape.devenv.environment-id=3f2a9c1e-5b7d',
      '--include-merged-configuration',
    ]);
  });

  it('readConfiguration reads the configuration again without the merged configuration when that fails (offline, private image)', async () => {
    docker.handler = (args) =>
      args.includes('--include-merged-configuration')
        ? { exitCode: 1, stderr: 'Error fetching image details: getaddrinfo ENOTFOUND ghcr.io\n' }
        : { stdout: '{"configuration":{"image":"ghcr.io/acme/private:1"}}\n' };
    const result = await createHelper().readConfiguration({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer/devcontainer.json',
      environmentId: 'e',
    });
    expect(result).toEqual({ config: { image: 'ghcr.io/acme/private:1' } });
    expect(docker.runs).toHaveLength(2);
    expect(logger.lines.some((line) => line.startsWith('warn') && line.includes('merged configuration'))).toBe(true);
    // A broken configuration fails also without it.
    docker.handler = () => ({ exitCode: 1, stderr: 'Dev container config (…) must contain a JSON object literal.\n' });
    await expect(
      createHelper().readConfiguration({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer.json', environmentId: 'e' }),
    ).rejects.toBeInstanceOf(CommandError);
  });

  describe('readConfiguration on a network that drops packets (the CLI waits for the registries)', () => {
    /** The run with the merged configuration hangs until its signal aborts; the run without it answers. */
    function hangingMergedRead(): Promise<void> {
      return new Promise((started) => {
        docker.handler = (args, options) => {
          if (args[0] !== 'run') return {};
          if (!args.includes('--include-merged-configuration')) return { stdout: '{"configuration":{"image":"node:22"}}\n' };
          started();
          return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(abortError())));
        };
      });
    }

    const read = (signal?: AbortSignal) =>
      createHelper().readConfiguration({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer.json', environmentId: 'e', signal });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops the read with the merged configuration after the time limit, and reads without it', async () => {
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the batch helper ends the step (no per-step container to remove).
      const started = hangingMergedRead();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const result = read();
      await started;
      await vi.advanceTimersByTimeAsync(MERGED_CONFIGURATION_TIMEOUT_MS - 1);
      expect(docker.runs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({ config: { image: 'node:22' } });
      expect(docker.runs).toHaveLength(2);
      expect(docker.runs[1].args).not.toContain('--include-merged-configuration');
      expect(bridge.kinds).toEqual(['readConfiguration', 'readConfiguration']);
      expect(logger.lines.some((line) => line.startsWith('warn') && line.includes('merged configuration') && line.includes('10 seconds'))).toBe(true);
    });

    it('ends at once on a cancel during the read with the merged configuration', async () => {
      const started = hangingMergedRead();
      const controller = new AbortController();
      const result = read(controller.signal);
      await started;
      controller.abort();
      await expect(result).rejects.toThrow(/cancelled/);
      expect(docker.runs).toHaveLength(1);
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the cancel ends the step in the batch helper (no per-step
      // container to remove); its signal aborted.
      expect(docker.runs[0].options.signal?.aborted).toBe(true);
    });

    it('reads without the merged configuration and without a time limit when the caller does not need it', async () => {
      docker.handler = () => ({ stdout: '{"configuration":{"image":"node:22"},"mergedConfiguration":{"privileged":true}}\n' });
      const result = await createHelper().readConfiguration({
        volumeName: 'vol',
        repository: 'acme/api',
        configPath: '.devcontainer.json',
        environmentId: 'e',
        merged: false,
      });
      expect(result).toEqual({ config: { image: 'node:22' } });
      expect(docker.runs).toHaveLength(1);
      expect(docker.runs[0].args).not.toContain('--include-merged-configuration');
    });
  });

  it('build returns the result and sends every other output line to onOutput', async () => {
    docker.handler = () => ({
      stdout: 'a log line on stdout\n{"outcome":"success","imageName":["devenv-3f2a9c1e:2"]}\n',
      stderr: '[2026] Start: Run: docker buildx build\n',
    });
    const output: string[] = [];
    const result = await createHelper().build({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer/python/devcontainer.json',
      imageName: 'devenv-3f2a9c1e:2',
      onOutput: (text) => output.push(text),
    });
    expect(result).toEqual({ outcome: 'success', imageName: ['devenv-3f2a9c1e:2'] });
    expect(output.join('')).toContain('a log line on stdout\n');
    expect(output.join('')).toContain('docker buildx build');
    expect(output.join('')).not.toContain('"outcome"');
    const configFile = '/workspaces/api/.devcontainer/python/devcontainer.json';
    expect(commandOf(docker.runs[0].args)).toEqual([
      'sh',
      '-c',
      BUILD_SCRIPT,
      'sh',
      configFile,
      'build',
      '--workspace-folder',
      '/workspaces/api',
      '--config',
      configFile,
      '--image-name',
      'devenv-3f2a9c1e:2',
      '--user-data-folder',
      '/devenv-cache',
    ]);
  });

  it('build filters the result line also when it arrives in pieces', async () => {
    docker.forwardOutput = false;
    docker.handler = (_args, options) => {
      for (const piece of ['log 1\nlog', ' 2\n{"outcome":', '"success"}']) options.onStdout?.(piece);
      return { stdout: 'log 1\nlog 2\n{"outcome":"success"}' };
    };
    const output: string[] = [];
    await createHelper().build({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer/devcontainer.json',
      imageName: 'i:1',
      onOutput: (text) => output.push(text),
    });
    expect(output).toEqual(['log 1\n', 'log 2\n']);
  });

  it('build throws DevcontainerCommandError for an error outcome', async () => {
    docker.handler = () => ({
      exitCode: 1,
      stdout: '{"outcome":"error","message":"Command failed: docker pull x","description":"An error occurred building the container."}\n',
    });
    const error = await createHelper()
      .build({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer/devcontainer.json', imageName: 'i:1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DevcontainerCommandError);
    expect((error as DevcontainerCommandError).result?.message).toBe('Command failed: docker pull x');
    expect((error as Error).message).toContain('Command failed: docker pull x');
  });

  it('build throws DevcontainerCommandError when there is no result', async () => {
    docker.handler = () => ({ exitCode: null, stderr: 'killed' });
    await expect(
      createHelper().build({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer/devcontainer.json', imageName: 'i:1' }),
    ).rejects.toBeInstanceOf(DevcontainerCommandError);
  });

  it('up passes the override configuration on stdin and returns the result', async () => {
    docker.handler = () => ({
      stdout: '{"outcome":"success","containerId":"c1","remoteUser":"vscode","remoteWorkspaceFolder":"/workspaces/api"}\n',
    });
    const override = { image: 'devenv-3f2a9c1e:2', shutdownAction: 'none' };
    const result = await createHelper().up({
      volumeName: 'vol',
      repository: 'acme/api',
      override,
      environmentId: '3f2a9c1e-5b7d',
      removeExistingContainer: true,
    });
    expect(result).toMatchObject({ outcome: 'success', containerId: 'c1', remoteWorkspaceFolder: '/workspaces/api' });
    const run = docker.runs[0];
    expect(JSON.parse(run.options.input ?? '')).toEqual(override);
    expect(run.args).not.toContain('-e');
    expect(commandOf(run.args)).toEqual([
      'sh',
      '-c',
      UP_SCRIPT,
      'sh',
      OVERRIDE_CONFIG_PATH,
      'up',
      '--workspace-folder',
      '/workspaces/api',
      '--override-config',
      OVERRIDE_CONFIG_PATH,
      '--id-label',
      'nimblescape.devenv.environment-id=3f2a9c1e-5b7d',
      '--user-data-folder',
      '/devenv-cache',
      '--update-remote-user-uid-default',
      'never',
      // lifecycle token (user decision 2026-09-27): up runs no lifecycle command; run-user-commands runs them after the token.
      '--skip-post-create',
      '--skip-post-attach',
      '--remove-existing-container',
    ]);
  });

  it('runUserCommands passes the override configuration on stdin and names the container of up (lifecycle token)', async () => {
    docker.handler = () => ({ stdout: '{"outcome":"success","result":"done"}\n' });
    const override = { image: 'devenv-3f2a9c1e:2', shutdownAction: 'none' };
    const result = await createHelper().runUserCommands({
      volumeName: 'vol',
      repository: 'acme/api',
      override,
      environmentId: '3f2a9c1e-5b7d',
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the batch step takes a Docker container ID (12 to 64 hex digits; was: 'c1').
      containerId: 'c1c1c1c1c1c1',
      // review, PL-1/PL-2: runUserCommands takes the token (for the redaction of the output).
      token: TOKEN,
    });
    expect(result).toMatchObject({ outcome: 'success', containerId: 'c1c1c1c1c1c1' });
    // The token is only redacted: it is no argument, variable, or input of the helper.
    expect(JSON.stringify(docker.calls)).not.toContain(TOKEN);
    const run = docker.runs[0];
    expect(JSON.parse(run.options.input ?? '')).toEqual(override);
    expect(run.args).not.toContain('-e');
    expect(commandOf(run.args)).toEqual([
      'sh',
      '-c',
      UP_SCRIPT,
      'sh',
      OVERRIDE_CONFIG_PATH,
      'run-user-commands',
      '--workspace-folder',
      '/workspaces/api',
      '--override-config',
      OVERRIDE_CONFIG_PATH,
      '--id-label',
      'nimblescape.devenv.environment-id=3f2a9c1e-5b7d',
      '--container-id',
      'c1c1c1c1c1c1',
      '--user-data-folder',
      '/devenv-cache',
      '--skip-post-attach',
    ]);
  });

  it('up throws DevcontainerCommandError when the exit code is not 0', async () => {
    docker.handler = () => ({ exitCode: 1, stdout: '{"outcome":"error","message":"no space"}\n' });
    await expect(
      createHelper().up({
        volumeName: 'vol',
        repository: 'acme/api',
        override: {},
        environmentId: 'e',
        removeExistingContainer: false,
        }),
    ).rejects.toMatchObject({ name: 'DevcontainerCommandError', exitCode: 1 });
  });
});

describe('WorkspaceHelper Docker Compose runs', () => {
  const MODEL_OUTPUT = { version: '2.29.1', dollarEscaped: true, model: { name: 'devenv-3f2a9c1e', services: { app: { image: 'x' } } }, dockerfiles: {}, realPaths: {}, inputsHash: 'abc' };

  it('composeModel runs the model script as the owner of the repository, with the project name', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step composeModel of the batch helper runs as the owner of the
    // repository, with CONFIG_FOLDER closed (was: a per-step run without the socket and network, with a tmpfs over it).
    docker.handler = () => ({ stdout: `${JSON.stringify(MODEL_OUTPUT)}\n` });
    const files = ['/workspaces/api/.devcontainer/compose.yml'];
    const result = await createHelper().composeModel({ volumeName: 'vol', repository: 'acme/api', files, project: 'devenv-3f2a9c1e' });
    expect(result).toEqual(MODEL_OUTPUT);
    const run = docker.runs[0];
    expect(bridge.kinds).toEqual(['composeModel']);
    expect(batchStepCommand('composeModel', { repository: 'acme/api', files, project: 'devenv-3f2a9c1e' }).owner).toBe('/workspaces/api');
    expect(run.args).toContain('COMPOSE_PROJECT_NAME=devenv-3f2a9c1e');
    expect(commandOf(run.args)).toEqual(['node', '-e', COMPOSE_MODEL_SCRIPT, '/workspaces/api', ...files]);
    expect(COMPOSE_MODEL_TIMEOUT_MS).toBe(60_000);
  });

  it('composeServiceHashes (recreate offer, review round 2): the hash script on the model at the path of up', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step composeHash of the batch helper (was: a per-step run
    // without the socket and network).
    const hash = 'c'.repeat(64);
    docker.handler = () => ({ stdout: `app ${hash}\ndb ${hash}\n` });
    const hashes = await createHelper().composeServiceHashes({ volumeName: 'vol', repository: 'acme/api', model: '{"services":{}}', project: 'devenv-3f2a9c1e' });
    expect(docker.runs[0].options.input).toBe('{"services":{}}');
    expect(hashes).toEqual(new Map([['app', hash], ['db', hash]]));
    const run = docker.runs[0];
    expect(bridge.kinds).toEqual(['composeHash']);
    expect(run.args).toContain('COMPOSE_PROJECT_NAME=devenv-3f2a9c1e');
    expect(commandOf(run.args)).toEqual(['node', '-e', COMPOSE_HASH_SCRIPT, COMPOSE_MODEL_PATH, 'devenv-3f2a9c1e']);
    docker.handler = () => ({ exitCode: 1, stderr: 'unknown flag: --hash' });
    await expect(createHelper().composeServiceHashes({ volumeName: 'vol', repository: 'acme/api', model: '{}', project: 'p' })).rejects.toBeInstanceOf(CommandError);
  });

  it('composeModel returns the message of Docker Compose, and throws when the helper fails', async () => {
    docker.handler = () => ({ stdout: '{"error":"yaml: bad"}\n' });
    const p = { volumeName: 'vol', repository: 'acme/api', files: ['/workspaces/api/compose.yml'], project: 'devenv-3f2a9c1e' };
    expect(await createHelper().composeModel(p)).toEqual({ error: 'yaml: bad' });
    docker.handler = () => ({ exitCode: 1, stderr: 'boom' });
    await expect(createHelper().composeModel(p)).rejects.toBeInstanceOf(CommandError);
  });

  it.each<[string, string[]]>([
    ['no file', []],
    ['a file outside the repository', ['/workspaces/other/compose.yml']],
    ['a file with ..', ['/workspaces/api/../other/compose.yml']],
    ['the configuration folder', ['/workspaces/.devenv+/compose.yml']],
  ])('composeModel refuses %s before any Docker call', async (_name, files) => {
    await expect(createHelper().composeModel({ volumeName: 'vol', repository: 'acme/api', files, project: 'p' })).rejects.toThrow(/Invalid compose files/);
    expect(docker.calls).toHaveLength(0);
  });

  it('createRepositoryFolders runs its script as the owner of the repository (review round 8, P8-2)', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step createFolders of the batch helper runs as the owner of the
    // repository, with CONFIG_FOLDER closed (was: a per-step run without the socket and network, with a tmpfs over it).
    docker.handler = () => ({ stdout: '' });
    const folders = ['/workspaces/api/data/postgres', '/workspaces/api/logs'];
    await createHelper().createRepositoryFolders({ volumeName: 'vol', repository: 'acme/api', folders });
    const run = docker.runs[0];
    expect(bridge.kinds).toEqual(['createFolders']);
    expect(batchStepCommand('createFolders', { repository: 'acme/api', folders }).owner).toBe('/workspaces/api');
    expect(commandOf(run.args)).toEqual(['node', '-e', CREATE_FOLDERS_SCRIPT, '/workspaces/api', ...folders]);
    docker.handler = () => ({ exitCode: 2, stderr: '/workspaces/api/out leads out of the repository' });
    await expect(createHelper().createRepositoryFolders({ volumeName: 'vol', repository: 'acme/api', folders })).rejects.toBeInstanceOf(CommandError);
  });

  it.each<[string, string[]]>([
    ['a folder outside the repository', ['/workspaces/other/data']],
    ['a folder with ..', ['/workspaces/api/../other']],
    ['the repository folder itself', ['/workspaces/api']],
  ])('createRepositoryFolders refuses %s before any Docker call', async (_name, folders) => {
    await expect(createHelper().createRepositoryFolders({ volumeName: 'vol', repository: 'acme/api', folders })).rejects.toThrow(/Invalid folders/);
    expect(docker.calls).toHaveLength(0);
  });

  it('readConfiguration with an override writes it and the files into the helper, and passes the project name', async () => {
    docker.handler = () => ({ stdout: '{"configuration":{"service":"app"}}\n' });
    const override = { dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app' };
    const result = await createHelper().readConfiguration({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer/devcontainer.json',
      environmentId: '3f2a9c1e-5b7d',
      merged: false,
      override,
      files: { [COMPOSE_MODEL_PATH]: '{"services":{}}' },
      env: { COMPOSE_PROJECT_NAME: 'devenv-3f2a9c1e' },
    });
    expect(result).toEqual({ config: { service: 'app' } });
    const run = docker.runs[0];
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step readConfiguration of the batch helper (root, with the
    // socket of the helper; was: a per-step run with the socket and the cache volume mounted).
    expect(bridge.kinds).toEqual(['readConfiguration']);
    expect(run.args).toContain('COMPOSE_PROJECT_NAME=devenv-3f2a9c1e');
    expect(commandOf(run.args)).toEqual([
      'node',
      '-e',
      WRITE_AND_RUN_SCRIPT,
      '/tmp/devenv-override',
      '',
      '',
      'read-configuration',
      '--workspace-folder',
      '/workspaces/api',
      '--config',
      '/workspaces/api/.devcontainer/devcontainer.json',
      '--id-label',
      'nimblescape.devenv.environment-id=3f2a9c1e-5b7d',
      '--override-config',
      OVERRIDE_CONFIG_PATH,
    ]);
    expect(JSON.parse(run.options.input ?? '')).toEqual({
      files: { [COMPOSE_MODEL_PATH]: '{"services":{}}', [OVERRIDE_CONFIG_PATH]: JSON.stringify(override, null, 2) },
    });
  });

  it('build with our copy of the configuration names it with --config and keeps the repository configuration for the lockfile', async () => {
    docker.handler = () => ({ stdout: '{"outcome":"success","imageName":["devenv-3f2a9c1e:2"]}\n' });
    const override = { dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app' };
    await createHelper().build({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer/devcontainer.json',
      imageName: 'devenv-3f2a9c1e:2',
      override,
      files: { [COMPOSE_MODEL_PATH]: '{}', [COMPOSE_DEV_DOCKERFILE]: 'FROM x\n' },
      env: { COMPOSE_PROJECT_NAME: 'devenv-3f2a9c1e' },
    });
    const run = docker.runs[0];
    expect(run.args).toContain('COMPOSE_PROJECT_NAME=devenv-3f2a9c1e');
    expect(commandOf(run.args)).toEqual([
      'node',
      '-e',
      WRITE_AND_RUN_SCRIPT,
      '/tmp/devenv-override',
      '/workspaces/api/.devcontainer/devcontainer.json',
      OVERRIDE_CONFIG_PATH,
      'build',
      '--workspace-folder',
      '/workspaces/api',
      '--config',
      OVERRIDE_CONFIG_PATH,
      '--image-name',
      'devenv-3f2a9c1e:2',
      '--user-data-folder',
      '/devenv-cache',
    ]);
    expect(Object.keys(JSON.parse(run.options.input ?? '').files)).toEqual([COMPOSE_MODEL_PATH, COMPOSE_DEV_DOCKERFILE, OVERRIDE_CONFIG_PATH]);
  });

  it('up with files writes them with the override configuration and passes the project name', async () => {
    docker.handler = () => ({ stdout: '{"outcome":"success","containerId":"c1","composeProjectName":"devenv-3f2a9c1e"}\n' });
    const override = { dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app', shutdownAction: 'none' };
    const result = await createHelper().up({
      volumeName: 'vol',
      repository: 'acme/api',
      override,
      environmentId: '3f2a9c1e-5b7d',
      removeExistingContainer: false,
      files: { [COMPOSE_MODEL_PATH]: '{"name":"devenv-3f2a9c1e"}' },
      env: { COMPOSE_PROJECT_NAME: 'devenv-3f2a9c1e' },
    });
    expect(result).toMatchObject({ outcome: 'success', containerId: 'c1' });
    const run = docker.runs[0];
    expect(run.args).toContain('COMPOSE_PROJECT_NAME=devenv-3f2a9c1e');
    const command = commandOf(run.args);
    expect(command.slice(0, 7)).toEqual(['node', '-e', WRITE_AND_RUN_SCRIPT, '/tmp/devenv-override', '', '', 'up']);
    expect(command).toContain('--override-config');
    expect(JSON.parse(run.options.input ?? '')).toEqual({
      files: { [COMPOSE_MODEL_PATH]: '{"name":"devenv-3f2a9c1e"}', [OVERRIDE_CONFIG_PATH]: JSON.stringify(override, null, 2) },
    });
  });

  it('runUserCommands with files writes them with the override configuration and passes the project name (lifecycle token)', async () => {
    docker.handler = () => ({ stdout: '{"outcome":"success","result":"done"}\n' });
    const override = { dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app', shutdownAction: 'none' };
    await createHelper().runUserCommands({
      volumeName: 'vol',
      repository: 'acme/api',
      override,
      environmentId: '3f2a9c1e-5b7d',
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the batch step takes a Docker container ID (12 to 64 hex digits; was: 'c1').
      containerId: 'c1c1c1c1c1c1',
      files: { [COMPOSE_MODEL_PATH]: '{"name":"devenv-3f2a9c1e"}' },
      env: { COMPOSE_PROJECT_NAME: 'devenv-3f2a9c1e' },
      // review, PL-1/PL-2: runUserCommands takes the token (for the redaction of the output).
      token: TOKEN,
    });
    const run = docker.runs[0];
    expect(run.args).toContain('COMPOSE_PROJECT_NAME=devenv-3f2a9c1e');
    const command = commandOf(run.args);
    expect(command.slice(0, 7)).toEqual(['node', '-e', WRITE_AND_RUN_SCRIPT, '/tmp/devenv-override', '', '', 'run-user-commands']);
    expect(command.slice(7)).toEqual([
      '--workspace-folder',
      '/workspaces/api',
      '--override-config',
      OVERRIDE_CONFIG_PATH,
      '--id-label',
      'nimblescape.devenv.environment-id=3f2a9c1e-5b7d',
      '--container-id',
      'c1c1c1c1c1c1',
      '--user-data-folder',
      '/devenv-cache',
      '--skip-post-attach',
    ]);
    expect(JSON.parse(run.options.input ?? '')).toEqual({
      files: { [COMPOSE_MODEL_PATH]: '{"name":"devenv-3f2a9c1e"}', [OVERRIDE_CONFIG_PATH]: JSON.stringify(override, null, 2) },
    });
  });

  it.each<[string, string]>([
    ['a file outside the override folder', '/tmp/other/compose.json'],
    ['a file with ..', '/tmp/devenv-override/../x.json'],
    ['a file with an empty segment', '/tmp/devenv-override//x.json'],
  ])('refuses %s before any Docker call', async (_name, file) => {
    await expect(
      createHelper().up({
        volumeName: 'vol',
        repository: 'acme/api',
        override: {},
        environmentId: 'e',
        removeExistingContainer: false,
        files: { [file]: '{}' },
      }),
    ).rejects.toThrow(/Invalid helper file/);
    expect(docker.runs).toHaveLength(0);
  });
});

describe('WorkspaceHelper.runUserCommands with a failed lifecycle command (lifecycle token, user decision 2026-09-27)', () => {
  const CONTAINER_ID = '4f1c2b3a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a';

  /** The result of the CLI: run-user-commands names no container. */
  function answer(description: string, inspect: Partial<RunResult>): void {
    const stdout = `${JSON.stringify({ outcome: 'error', message: 'Command failed: /bin/sh -c npm install', description })}\n`;
    docker.handler = (args) => (args[0] === 'run' ? { exitCode: 1, stdout } : inspect);
  }

  function runUserCommands(): Promise<unknown> {
    // review, PL-1/PL-2: runUserCommands takes the token (for the redaction of the output).
    return createHelper().runUserCommands({ volumeName: 'vol', repository: 'acme/api', override: {}, environmentId: 'e', containerId: CONTAINER_ID, token: TOKEN });
  }

  it('keeps the container that runs, with the description of the CLI', async () => {
    const description = 'postCreateCommand from devcontainer.json failed.';
    answer(description, { stdout: '"running"\n' });
    await expect(runUserCommands()).resolves.toEqual({ outcome: 'success', containerId: CONTAINER_ID, lifecycleCommandFailure: description });
    expect(logger.lines.some((line) => line.startsWith('warn') && line.includes(description))).toBe(true);
  });

  it('throws the error with the container ID when the container does not run', async () => {
    answer('postStartCommand from devcontainer.json failed.', { stdout: '"exited"\n' });
    const error = await runUserCommands().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevcontainerCommandError);
    expect(error).toMatchObject({ command: 'devcontainer run-user-commands', result: { containerId: CONTAINER_ID } });
  });

  it('throws for other errors without asking Docker', async () => {
    answer('An error occurred running user commands in the container.', { stdout: '"running"\n' });
    await expect(runUserCommands()).rejects.toBeInstanceOf(DevcontainerCommandError);
    expect(docker.calls.filter((call) => call.args[0] === 'container')).toHaveLength(0);
  });
});

describe('review PL-1: the token in the output of run-user-commands and up', () => {
  const CONTAINER_ID = '4f1c2b3a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a';
  const RESULT = '{"outcome":"success","result":"done"}\n';

  /** The helper run sends `stdout` and `stderr` in these chunks (in this order) and ends with `exitCode`. */
  function streams(p: { stdout?: string[]; stderr?: string[]; exitCode?: number; inspect?: Partial<RunResult> }): void {
    docker.forwardOutput = false;
    docker.handler = (args, options) => {
      if (args[0] !== 'run') return p.inspect ?? {};
      for (const chunk of p.stderr ?? []) options.onStderr?.(chunk);
      for (const chunk of p.stdout ?? []) options.onStdout?.(chunk);
      return { exitCode: p.exitCode ?? 0, stdout: (p.stdout ?? []).join(''), stderr: (p.stderr ?? []).join('') };
    };
  }

  function runUserCommands(output: string[]): Promise<unknown> {
    return createHelper().runUserCommands({
      volumeName: 'vol',
      repository: 'acme/api',
      override: {},
      environmentId: 'e',
      containerId: CONTAINER_ID,
      token: TOKEN,
      onOutput: (text) => output.push(text),
    });
  }

  it('replaces the token in whole lines of stdout and stderr, and keeps the other output in its order', async () => {
    streams({ stderr: [`+ curl -H "Authorization: token ${TOKEN}" x\n`, 'next\n'], stdout: [`Token: ${TOKEN}\n`, 'done\n', RESULT] });
    const output: string[] = [];
    await runUserCommands(output);
    expect(output.join('')).toBe('+ curl -H "Authorization: token ***" x\nnext\nToken: ***\ndone\n');
  });

  it('replaces a token split across two chunks of stderr (line-buffered), and passes a last line without a newline on', async () => {
    const half = TOKEN.length / 2;
    streams({ stderr: ['first\n  - Token: ', TOKEN.slice(0, half), `${TOKEN.slice(half)} end\nsecond`], stdout: [RESULT] });
    const output: string[] = [];
    await runUserCommands(output);
    expect(output.join('')).not.toContain(TOKEN.slice(0, half));
    expect(output.join('')).not.toContain(TOKEN.slice(half));
    expect(output.join('')).toBe('first\n  - Token: *** end\nsecond');
  });

  it('holds back only a bounded part of a long line without a newline, and still replaces a token split at its end', async () => {
    const long = 'x'.repeat(70 * 1024);
    const half = 5;
    streams({ stderr: [`${long}${TOKEN.slice(0, half)}`, `${TOKEN.slice(half)}\n`], stdout: [RESULT] });
    const output: string[] = [];
    await runUserCommands(output);
    // The long line went on before its end arrived.
    expect(output.length).toBeGreaterThanOrEqual(2);
    expect(output[0].length).toBeGreaterThan(64 * 1024);
    expect(output.join('')).toBe(`${long}***\n`);
  });

  it('replaces the token in the stdout and stderr of the error (errorDetail, the log)', async () => {
    const half = 7;
    const result = { outcome: 'error', message: `Command failed: /bin/sh -c echo ${TOKEN}`, description: 'postCreateCommand from devcontainer.json failed.' };
    streams({
      stderr: [`npm ERR! ${TOKEN.slice(0, half)}`, `${TOKEN.slice(half)}\n`],
      stdout: [`${TOKEN}\n`, `${JSON.stringify(result)}\n`],
      exitCode: 1,
      inspect: { stdout: '"exited"\n' },
    });
    const output: string[] = [];
    const error = await runUserCommands(output).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevcontainerCommandError);
    const failure = error as DevcontainerCommandError;
    expect(failure.stderr).toBe('npm ERR! ***\n');
    expect(failure.stdout).not.toContain(TOKEN);
    expect(failure.message).not.toContain(TOKEN);
    expect(failure.result).toMatchObject({ outcome: 'error', containerId: CONTAINER_ID });
    expect(errorDetail(failure)).not.toContain(TOKEN);
    expect(output.join('')).toBe('npm ERR! ***\n***\n');
    expect(logger.lines.join('\n')).not.toContain(TOKEN);
  });

  it('up replaces the token in its output and its error too', async () => {
    streams({ stderr: [`a ${TOKEN.slice(0, 4)}`, `${TOKEN.slice(4)} b\n`], stdout: [`${TOKEN}\n`], exitCode: 1 });
    const output: string[] = [];
    const error = await createHelper()
      .up({ volumeName: 'vol', repository: 'acme/api', override: {}, environmentId: 'e', removeExistingContainer: false, token: TOKEN, onOutput: (text) => output.push(text) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevcontainerCommandError);
    expect((error as DevcontainerCommandError).stderr).toBe('a *** b\n');
    expect((error as DevcontainerCommandError).stdout).toBe('***\n');
    expect(output.join('')).toBe('a *** b\n***\n');
  });
});

describe('WorkspaceHelper.up with a failed lifecycle command', () => {
  const CONTAINER_ID = '4f1c2b3a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a';

  function lifecycleFailure(description: string, containerId: string | null = CONTAINER_ID): string {
    const result = { outcome: 'error', message: 'Command failed: /bin/sh -c npm install', description, containerId: containerId ?? undefined };
    return `${JSON.stringify(result)}\n`;
  }

  /** `up` ends with `upStdout` and exit code 1; `docker container inspect` answers with `inspect`. */
  function answer(upStdout: string, inspect: Partial<RunResult>): void {
    docker.handler = (args) => (args[0] === 'run' ? { exitCode: 1, stdout: upStdout } : inspect);
  }

  function up(): Promise<unknown> {
    return createHelper().up({
      volumeName: 'vol',
      repository: 'acme/api',
      override: {},
      environmentId: 'e',
      removeExistingContainer: false,
    });
  }

  it.each([
    'postStartCommand from devcontainer.json failed.',
    'postCreateCommand from devcontainer.json failed.',
    "onCreateCommand from Feature 'ghcr.io/devcontainers/features/node:1' failed.",
    'install of updateContentCommand from devcontainer.json failed.',
  ])('keeps a container that runs after "%s"', async (description) => {
    answer(lifecycleFailure(description), { stdout: '"running"\n' });
    await expect(up()).resolves.toEqual({ outcome: 'success', containerId: CONTAINER_ID, lifecycleCommandFailure: description });
    expect(docker.calls.map((call) => call.args)).toContainEqual([
      'container',
      'inspect',
      '--format',
      '{{json .State.Status}}',
      CONTAINER_ID,
    ]);
    expect(logger.lines.some((line) => line.startsWith('warn') && line.includes(description))).toBe(true);
  });

  it('throws when the container does not run', async () => {
    answer(lifecycleFailure('postStartCommand from devcontainer.json failed.'), { stdout: '"exited"\n' });
    await expect(up()).rejects.toBeInstanceOf(DevcontainerCommandError);
  });

  it('throws when the state of the container cannot be read', async () => {
    answer(lifecycleFailure('postStartCommand from devcontainer.json failed.'), { exitCode: 1, stderr: 'Error: No such container\n' });
    await expect(up()).rejects.toBeInstanceOf(DevcontainerCommandError);
  });

  it('throws for other errors, also with a container ID, without asking Docker', async () => {
    answer(lifecycleFailure('An error occurred setting up the container.'), { stdout: '"running"\n' });
    await expect(up()).rejects.toBeInstanceOf(DevcontainerCommandError);
    answer(lifecycleFailure('postStartCommand from devcontainer.json failed.', null), { stdout: '"running"\n' });
    await expect(up()).rejects.toBeInstanceOf(DevcontainerCommandError);
    expect(docker.calls.filter((call) => call.args[0] === 'container')).toHaveLength(0);
  });
});

// PR #74 review round 1, A-R1-1: the helper image before the environment lock (Stop, Delete) only makes sure that the
// tag exists on the engine of the operation (local or remote alike); it does no maintenance.
describe('WorkspaceHelper.ensureImagePresent (PR #74 review round 1, A-R1-1)', () => {
  const statePath = () => path.join(dir, 'storage', 'helper.json');
  const REMOTE: HelperEngine = { key: 'ssh://build-box', socket: '/var/run/docker.sock' };

  function helperOn(engine: HelperEngine, baseDigest?: BaseDigestLookup): WorkspaceHelper {
    return new WorkspaceHelper({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'linux',
      clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
      statePath: statePath(),
      engine: async () => engine,
      baseDigest,
    });
  }

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])('on %s, a recorded new base digest rebuilds nothing, checks nothing, and cleans up nothing', async (_name, engine) => {
    docker.images.add(TAG);
    const file = helperStatePathFor(statePath(), engine.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = '2026-09-01T12:00:00.000Z';
    const record = {
      baseImage: 'node:22-bookworm-slim',
      baseDigest: `sha256:${'a'.repeat(64)}`,
      latestBaseDigest: `sha256:${'b'.repeat(64)}`,
      builtAt: old,
      checkedAt: old,
      lastUsedAt: old,
      imageId: fakeImageId(TAG),
      generation: HELPER_GENERATION,
    };
    fs.writeFileSync(file, JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: old }));
    // A `--pull --no-cache` rebuild would never end here, so a Stop that waited for it would hang.
    docker.buildHandler = () => new Promise<void>(() => {});
    const lookup = vi.fn<BaseDigestLookup>(async () => `sha256:${'c'.repeat(64)}`);
    const helper = helperOn(engine, lookup);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
    expect(docker.listCalls).toBe(0);
    expect(docker.removals).toEqual([]);
  });

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])('on %s, builds a missing tag', async (_name, engine) => {
    const helper = helperOn(engine);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG });
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): the helper image makes the state for the worker consistent, so its Docker
  // calls run in the scope of the worker preparation (ContainerAdapter runs them directly; the worker is opened from it).
  it('checks and builds the helper image in the scope of the worker preparation, also for an open', async () => {
    const scopes: boolean[] = [];
    const imageId = docker.imageId.bind(docker);
    docker.imageId = async (reference: string) => {
      scopes.push(preparingWorker());
      return imageId(reference);
    };
    docker.buildHandler = async () => {
      scopes.push(preparingWorker());
    };
    const helper = helperOn(REMOTE);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
    // PR #76 review round 1 (B-R1-1): with a warm cache, the check of the cached image runs in the scope too (else it
    // would go through the router, which prepares the image again, without end).
    const warm = scopes.length;
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(scopes.length).toBeGreaterThan(warm);
    docker.images.delete(TAG);
    await helper.ensureImageUse();
    expect(docker.builds).toHaveLength(2);
    expect(scopes.length).toBeGreaterThanOrEqual(4);
    expect(scopes.every((inScope) => inScope)).toBe(true);
    expect(preparingWorker()).toBe(false);
  });

  // PR #76 review round 1 (A-R1-1, A-R1-2): the refresh of the sidebar only checks the helper tag: it never builds it and
  // never waits for a pending build; its check runs in the scope of the worker preparation.
  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])('on %s, checkImagePresent checks the tag, never builds it, and never waits for a pending build', async (_name, engine) => {
    const helper = helperOn(engine);
    const scopes: boolean[] = [];
    const imageId = docker.imageId.bind(docker);
    docker.imageId = async (reference: string) => {
      scopes.push(preparingWorker());
      return imageId(reference);
    };
    await expect(helper.checkImagePresent()).rejects.toMatchObject({ code: 'helperFailed' });
    expect(docker.builds).toHaveLength(0);
    const finish = heldBuild();
    const open = helper.ensureImageUse();
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const settled = helper.checkImagePresent().then(() => 'resolved', (error: unknown) => (isUserFacingError(error) ? error.code : 'other'));
    expect(await orHung(settled, 200)).toBe('helperFailed');
    finish();
    await open;
    await expect(helper.checkImagePresent()).resolves.toBeUndefined();
    expect(docker.builds).toHaveLength(1);
    expect(scopes.length).toBeGreaterThanOrEqual(3);
    expect(scopes.every((inScope) => inScope)).toBe(true);
  });

  it('builds the tag again when it was deleted after it was cached (by itself or by an open)', async () => {
    const helper = helperOn(REMOTE);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    docker.images.delete(TAG);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(2);
    expect(docker.images.has(TAG)).toBe(true);

    await helper.ensureImageUse();
    docker.images.delete(TAG);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(3);
    expect(logger.lines.join('\n')).toContain(`The workspace helper image ${TAG} was removed. It is prepared again.`);
  });

  it('fails like ensureImage when the missing tag cannot be built', async () => {
    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'failed to solve: node:22-bookworm-slim: not found');
    };
    const helper = helperOn(REMOTE);
    await expect(helper.ensureImagePresent()).rejects.toMatchObject({ code: 'helperFailed' });
    expect(docker.images.has(TAG)).toBe(false);
  });

  // PR #74 review round 2, A-R2-1: a pending maintaining ensure of an open in the same window (a `--pull --no-cache`
  // rebuild, the cleanup) is not joined when the tag exists: the Stop could not cancel that wait.
  const NEW_ID = `sha256:${'e'.repeat(64)}`;

  /** A helper.json on `engine` that asks the next maintaining ensure for a `--pull --no-cache` rebuild of TAG. */
  function recordNewBaseDigest(engine: HelperEngine): void {
    const file = helperStatePathFor(statePath(), engine.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = '2026-09-01T12:00:00.000Z';
    const record = {
      baseImage: 'node:22-bookworm-slim',
      baseDigest: `sha256:${'a'.repeat(64)}`,
      latestBaseDigest: `sha256:${'b'.repeat(64)}`,
      builtAt: old,
      checkedAt: old,
      lastUsedAt: old,
      imageId: fakeImageId(TAG),
      generation: HELPER_GENERATION,
    };
    fs.writeFileSync(file, JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: old }));
  }

  /**
   * A build that ends only when the returned function is called (with an error, or with success). After a failure, each
   * later build (the retry without `--pull`) fails at once with the same error.
   */
  function heldBuild(): (error?: Error) => void {
    let finish: ((error?: Error) => void) | undefined;
    let failure: Error | undefined;
    docker.buildHandler = () =>
      failure !== undefined
        ? Promise.reject(failure)
        : new Promise<void>((resolve, reject) => {
            finish = (error) => (error ? reject(error) : resolve());
          });
    return (error) => {
      failure = error;
      finish?.(error);
    };
  }

  /** `promise`, or 'HUNG' when it has not settled after `ms`. */
  function orHung<T>(promise: Promise<T>, ms = 1000): Promise<T | 'HUNG'> {
    return Promise.race([promise, new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), ms))]);
  }

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])(
    'on %s, uses the existing tag at once while a maintaining rebuild of an open hangs, and leaves that rebuild untouched (PR #74 review round 2, A-R2-1)',
    async (_name, engine) => {
      docker.images.add(TAG);
      recordNewBaseDigest(engine);
      const finish = heldBuild();
      const helper = helperOn(engine);
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true, noCache: true });

      // PR #74 review round 2, A-R2-1: resolves at once with the ID of the tag, without waiting for the rebuild.
      expect(await orHung(helper.ensureImagePresent())).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      // PR #74 review round 2, A-R2-1: the rebuild promise of the open is untouched: a second open joins it.
      const second = helper.ensureImageUse();
      docker.ids.set(TAG, NEW_ID);
      finish();
      expect(await open).toEqual({ tag: TAG, id: NEW_ID });
      expect(await second).toEqual({ tag: TAG, id: NEW_ID });
      expect(docker.builds).toHaveLength(1);
      // PR #74 review round 2, A-R2-1: afterwards, the cached result of the open is used.
      expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: NEW_ID });
      expect(docker.builds).toHaveLength(1);
    },
  );

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])(
    'on %s, joins a pending maintaining ensure when the tag is missing, and resolves when it does (PR #74 review round 2, A-R2-1)',
    async (_name, engine) => {
      const finish = heldBuild();
      const helper = helperOn(engine);
      const asked: string[] = [];
      const imageId = docker.imageId.bind(docker);
      docker.imageId = async (reference) => {
        asked.push(reference);
        return imageId(reference);
      };
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const before = asked.length;
      const present = helper.ensureImagePresent();
      // PR #74 review round 2, A-R2-1: the tag is checked first; it is missing, so the pending ensure is joined.
      await vi.waitFor(() => expect(asked.slice(before)).toEqual([TAG]));
      expect(await orHung(present, 200)).toBe('HUNG');
      finish();
      expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(await present).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    },
  );

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])(
    'on %s, a cancelled Delete stops waiting for the joined maintaining ensure at once, and the build goes on (PR #74 review round 3, B-R3-1)',
    async (_name, engine) => {
      const finish = heldBuild();
      const helper = helperOn(engine);
      const asked: string[] = [];
      const imageId = docker.imageId.bind(docker);
      docker.imageId = async (reference) => {
        asked.push(reference);
        return imageId(reference);
      };
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const before = asked.length;
      const controller = new AbortController();
      const present = helper.ensureImagePresent({ signal: controller.signal });
      // PR #74 review round 3, B-R3-1: the tag is missing, so the pending ensure is joined; the abort ends that wait.
      await vi.waitFor(() => expect(asked.slice(before)).toEqual([TAG]));
      const settled = present.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.name : 'other'),
      );
      controller.abort();
      expect(await orHung(settled, 200)).toBe('AbortError');
      finish();
      expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    },
  );

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])(
    'on %s, joins the pending maintaining ensure when the tag cannot be checked, and fails (D1) when that ensure fails, without a fallback (PR #74 review round 2, A-R2-1)',
    async (_name, engine) => {
      const finish = heldBuild();
      const helper = helperOn(engine);
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      // PR #74 review round 2, A-R2-1: a failing imageId is no answer: the pending ensure is joined, not bypassed.
      docker.imageId = async () => {
        throw new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
      };
      const present = helper.ensureImagePresent();
      await vi.waitFor(() => expect(logger.lines.join('\n')).toContain(`The workspace helper image ${TAG} could not be checked`));
      expect(await orHung(present, 200)).toBe('HUNG');
      finish(new CommandError('docker build', 1, '', 'failed to solve: node:22-bookworm-slim: not found'));
      await expect(open).rejects.toMatchObject({ code: 'helperFailed' });
      const builds = docker.builds.length;
      // PR #74 review round 2, A-R2-1: the D1 refusal: the failure of the joined ensure, no other image, no build of its own.
      await expect(present).rejects.toMatchObject({ code: 'helperFailed' });
      expect(docker.builds).toHaveLength(builds);
      expect(docker.images.has(TAG)).toBe(false);
    },
  );
});

describe('plan step 7 (user decision of 2026-10-01): no volume step outside the batch scope of an operation', () => {
  it('every volume step outside a scope throws an internal error (D1) and starts no container, builds nothing, and runs nothing', async () => {
    const helper = new WorkspaceHelper({ docker, logger, dockerfilePath: path.join(dir, 'Dockerfile'), env: {}, platform: 'linux' });
    const OVERRIDE = { image: 'devenv-x:1' };
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['clone', () => helper.clone({ volumeName: 'vol', repository: 'o/a', token: TOKEN })],
      ['readConfigFiles', () => helper.readConfigFiles({ volumeName: 'vol', repository: 'o/a', configPath: '.devcontainer/devcontainer.json' })],
      ['listConfigurations', () => helper.listConfigurations({ volumeName: 'vol', repository: 'o/a' })],
      ['readConfiguration', () => helper.readConfiguration({ volumeName: 'vol', repository: 'o/a', configPath: '.devcontainer/devcontainer.json', environmentId: 'e' })],
      ['build', () => helper.build({ volumeName: 'vol', repository: 'o/a', configPath: '.devcontainer/devcontainer.json', imageName: 'devenv-x:1' })],
      ['composeModel', () => helper.composeModel({ volumeName: 'vol', repository: 'o/a', files: ['/workspaces/a/compose.yaml'], project: 'p' })],
      ['composeServiceHashes', () => helper.composeServiceHashes({ volumeName: 'vol', repository: 'o/a', model: '{}', project: 'p' })],
      ['createRepositoryFolders', () => helper.createRepositoryFolders({ volumeName: 'vol', repository: 'o/a', folders: ['/workspaces/a/data'] })],
      ['up', () => helper.up({ volumeName: 'vol', repository: 'o/a', override: OVERRIDE, environmentId: 'e', removeExistingContainer: false })],
      ['runUserCommands', () => helper.runUserCommands({ volumeName: 'vol', repository: 'o/a', override: OVERRIDE, environmentId: 'e', containerId: 'c'.repeat(64), token: TOKEN })],
      ['prepareGit', () => helper.prepareGit({ volumeName: 'vol', repository: 'o/a', identity: { name: 'A', email: 'a@example.com' } })],
      ['fixConfigOwnership', () => helper.fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' })],
      ['gitSummary', () => helper.gitSummary({ volumeName: 'vol', repository: 'o/a' })],
    ];
    for (const [name, call] of calls) {
      const error = await call().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error, name).toBeInstanceOf(Error);
      expect((error as Error).message, name).toMatch(/^Internal error: the workspace helper step \w+ \(.*\) on the volume vol ran outside the batch helper of an operation; it was not run\.$/s);
      expect((error as Error).message, name).not.toContain(TOKEN);
      expect(isUserFacingError(error), name).toBe(false);
    }
    expect(docker.calls).toEqual([]);
    expect(docker.builds).toEqual([]);
    // (readConfiguration reads once more without the merged configuration after its first read failed.)
    expect(logger.lines.filter((line) => line.startsWith('error Internal error'))).toHaveLength(calls.length + 1);
    expect(logger.lines.join('\n')).not.toContain(TOKEN);
  });
});
