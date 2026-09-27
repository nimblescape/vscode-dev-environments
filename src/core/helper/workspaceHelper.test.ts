// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageInfo } from '../docker/containerAdapter';
import { CommandError, UserFacingError } from '../errors';
import { GIT_SUMMARY_SCRIPT, configOwnershipFixCommand } from '../git/gitSummary';
import { abortError, type Logger, type RunOptions, type RunResult } from '../ports';
import { errorDetail } from '../pipeline/pipelineRules';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { DevcontainerCommandError } from './devcontainerCli';
import { HELPER_CHECK_INTERVAL_MS, helperImageTag, type BaseDigestLookup } from './helperImage';
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
  SWITCH_BRANCH_SCRIPT,
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
  helperRunArgs,
  isPassableEnvName,
  type HelperDeps,
  type HelperDocker,
} from './workspaceHelper';

const TOKEN = 'gho_0123456789abcdefSECRET';
const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const TAG = helperImageTag(DOCKERFILE);

type BuildOptions = Parameters<HelperDocker['buildImage']>[0];
type Handler = (args: string[], options: RunOptions) => Partial<RunResult> | Promise<Partial<RunResult>>;

interface Call {
  args: string[];
  options: RunOptions;
}

class FakeDocker implements HelperDocker {
  readonly images = new Set<string>();
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
    return this.images.has(reference) ? `id:${reference}` : undefined;
  }

  async buildImage(options: BuildOptions): Promise<void> {
    this.builds.push(options);
    await this.buildHandler(options);
    this.images.add(options.tag);
  }

  async listImagesByLabel(): Promise<ImageInfo[]> {
    this.listCalls++;
    return [...this.images].map((tag) => ({ id: `id:${tag}`, tags: [tag], createdAt: '' }));
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

/** Whether docker run arguments mount the Docker socket or the cache volume. */
function hasDockerAccess(args: string[]): boolean {
  return args.some((arg) => arg.includes('docker.sock') || arg.includes('devenv-helper-cache'));
}

function hasNoNetwork(args: string[]): boolean {
  const index = args.indexOf('--network');
  return index >= 0 && args[index + 1] === 'none';
}

/** The command after the image tag in docker run arguments. */
function commandOf(args: string[]): string[] {
  const index = args.findIndex((arg) => /^devenv-helper:/.test(arg));
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

function createHelper(env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'darwin'): WorkspaceHelper {
  return new WorkspaceHelper({
    docker,
    logger,
    dockerfilePath: path.join(dir, 'Dockerfile'),
    env,
    platform,
    clock: { now: () => Date.parse('2026-09-24T17:10:00Z') },
  });
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

describe('helperRunArgs', () => {
  it('builds the docker run arguments', () => {
    expect(
      helperRunArgs({
        tag: 'devenv-helper:abc',
        volumeName: 'devenv-acme-api-3f2a9c1e',
        socketPath: '/var/run/docker.sock',
        containerName: 'devenv-helper-1',
        env: { HOME: '/Users/me' },
        secrets: true,
        command: ['git', 'status'],
      }),
    ).toEqual([
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--name',
      'devenv-helper-1',
      '--label',
      'devenv.helper-run=true',
      '--mount',
      'type=volume,source=devenv-acme-api-3f2a9c1e,target=/workspaces',
      '--mount',
      'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--mount',
      'type=volume,source=devenv-helper-cache,target=/devenv-cache',
      '--tmpfs',
      '/run/devenv-secrets:rw,noexec,nosuid,nodev,size=1m,mode=0700',
      '-e',
      'HOME=/Users/me',
      'devenv-helper:abc',
      'git',
      'status',
    ]);
  });

  it('leaves out the Docker socket and the cache volume, and the network when asked', () => {
    const args = helperRunArgs({
      tag: 'devenv-helper:abc',
      volumeName: 'vol',
      socketPath: '/var/run/docker.sock',
      containerName: 'n',
      env: {},
      secrets: false,
      docker: false,
      network: false,
      command: ['git', 'status'],
    });
    expect(args).toEqual([
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--name',
      'n',
      '--label',
      'devenv.helper-run=true',
      '--mount',
      'type=volume,source=vol,target=/workspaces',
      '--network',
      'none',
      'devenv-helper:abc',
      'git',
      'status',
    ]);
  });

  it('hides the configuration folder of the volume with an empty tmpfs when asked, and only then', () => {
    const spec = {
      tag: 'devenv-helper:abc',
      volumeName: 'vol',
      socketPath: '/var/run/docker.sock',
      containerName: 'n',
      env: {},
      secrets: false,
      docker: false,
      network: false,
      command: ['node'],
    };
    expect(helperRunArgs({ ...spec, hideConfigFolder: true })).toEqual([
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--name',
      'n',
      '--label',
      'devenv.helper-run=true',
      '--mount',
      'type=volume,source=vol,target=/workspaces',
      '--mount',
      'type=tmpfs,destination=/workspaces/.devenv+',
      '--network',
      'none',
      'devenv-helper:abc',
      'node',
    ]);
    expect(helperRunArgs(spec).join(' ')).not.toContain('tmpfs');
  });

  it('quotes a mount field with a comma', () => {
    const args = helperRunArgs({
      tag: 't',
      volumeName: 'v',
      socketPath: '/run/a,b/docker.sock',
      containerName: 'n',
      env: {},
      secrets: false,
      command: [],
    });
    expect(args).toContain('type=bind,"source=/run/a,b/docker.sock",target=/var/run/docker.sock');
    expect(args).not.toContain('--tmpfs');
  });
});

describe('WorkspaceHelper.run', () => {
  it('builds the helper image once, then runs the command with the helper arguments', async () => {
    const helper = createHelper({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux');
    docker.handler = () => ({ stdout: 'ok\n' });
    const output: string[] = [];
    const result = await helper.run('vol', ['echo', 'ok'], { env: { HOME: '/home/me' }, onOutput: (text) => output.push(text) });
    await helper.run('vol', ['true']);

    expect(result.stdout).toBe('ok\n');
    expect(output).toContain('ok\n');
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0].tag).toBe(TAG);
    const args = docker.runs[0].args;
    expect(args.slice(0, 5)).toEqual(['run', '--rm', '-i', '--pull', 'never']);
    expect(args[args.indexOf('--name') + 1]).toMatch(/^devenv-helper-[0-9a-f]{12}$/);
    expect(args).toContain('type=bind,source=/run/user/1000/docker.sock,target=/var/run/docker.sock');
    expect(args).toContain('HOME=/home/me');
    expect(args).not.toContain('--tmpfs');
    expect(args.join(' ')).not.toContain('DOCKER_HOST');
    expect(commandOf(args)).toEqual(['echo', 'ok']);
    // Each run gets its own container name.
    expect(docker.runs[1].args[docker.runs[1].args.indexOf('--name') + 1]).not.toBe(args[args.indexOf('--name') + 1]);
  });

  it('does not pass reserved variables, and no variables at all to a run with credentials', async () => {
    const helper = createHelper();
    await helper.run('vol', ['true'], { env: { PATH: '/x', DOCKER_HOST: 'tcp://x', HOME: '/h' } });
    expect(docker.runs[0].args.filter((arg) => arg.includes('='))).toContain('HOME=/h');
    expect(docker.runs[0].args.join(' ')).not.toMatch(/PATH=|DOCKER_HOST=/);
    expect(logger.lines.some((line) => line.startsWith('warn') && line.includes('PATH'))).toBe(true);

    await helper.run('vol', ['true'], { env: { HOME: '/h' }, secrets: true, input: 'x' });
    expect(docker.runs[1].args).toContain('--tmpfs');
    expect(docker.runs[1].args).not.toContain('-e');
    expect(docker.runs[1].options.input).toBe('x');
  });

  it('never logs the values of variables', async () => {
    const helper = createHelper();
    await helper.run('vol', ['true'], { env: { API_KEY: 'value-of-the-key' } });
    expect(logger.lines.join('\n')).toContain('API_KEY');
    expect(logger.lines.join('\n')).not.toContain('value-of-the-key');
  });

  it('builds the image again when it was removed, and runs once more', async () => {
    const helper = createHelper();
    let first = true;
    docker.handler = () => {
      if (first) {
        first = false;
        return { exitCode: 125, stderr: `docker: Error response from daemon: No such image: ${TAG}\n` };
      }
      return { stdout: 'second\n' };
    };
    await helper.ensureImage();
    docker.images.delete(TAG);
    const result = await helper.run('vol', ['true']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('second\n');
    expect(docker.builds).toHaveLength(2);
    expect(docker.runs).toHaveLength(2);
  });

  it('removes the helper container when the signal aborts', async () => {
    const helper = createHelper();
    const controller = new AbortController();
    docker.handler = (args, options) => {
      if (args[0] !== 'run') return {};
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(abortError()));
        setTimeout(() => controller.abort(), 5);
      });
    };
    await expect(helper.run('vol', ['sleep', '60'], { signal: controller.signal })).rejects.toThrow(/cancelled/);
    const name = docker.runs[0].args[docker.runs[0].args.indexOf('--name') + 1];
    expect(docker.calls.map((call) => call.args)).toContainEqual(['rm', '-f', name]);
  });
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
    expect(state().images[TAG]).toEqual({
      baseImage: 'node:22-bookworm-slim',
      baseDigest: DIGEST,
      builtAt: iso(),
      checkedAt: iso(),
      lastUsedAt: iso(),
    });
  });

  it('uses the existing image when the registry cannot be reached', async () => {
    docker.images.add(TAG);
    const { helper, lookups, state, settled } = setup(async () => 'unreachable');
    expect(await helper.ensureImage()).toBe(TAG);
    await settled();
    expect(lookups).toHaveLength(1);
    expect(docker.builds).toHaveLength(0);
    expect(state().images[TAG].checkedAt).toBeUndefined();
    const result = await helper.run('vol', ['true']);
    expect(result.exitCode).toBe(0);
  });

  it('reuses the image for an hour; after that, ensureImage checks again, and the helper runs only record the use', async () => {
    const { helper, lookups, advance, iso, state, settled } = setup();
    await helper.ensureImage();
    const calls = docker.imageIdCalls;
    expect(calls).toBeGreaterThan(0);

    // A long-lived window: the helper runs of a stop, a delete, or a branch switch never check or rebuild.
    advance(HELPER_CHECK_INTERVAL_MS + HELPER_IMAGE_RECHECK_MS);
    await helper.run('vol', ['true']);
    expect(docker.imageIdCalls).toBe(calls);
    expect(lookups).toHaveLength(1);
    expect(state().images[TAG].lastUsedAt).toBe(iso());
    const used = iso();
    advance(10 * 60 * 1000);
    await helper.run('vol', ['true']);
    expect(state().images[TAG].lastUsedAt).toBe(used);

    // The open pipeline (ensureImage) runs ensureHelperImage again: the weekly check is due.
    await helper.ensureImage();
    await settled();
    expect(docker.imageIdCalls).toBe(calls + 1);
    expect(lookups).toHaveLength(2);
    expect(state().images[TAG].checkedAt).toBe(iso());
    await helper.ensureImage();
    expect(docker.imageIdCalls).toBe(calls + 1);
    expect(docker.builds).toHaveLength(1);
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

  it('never checks, rebuilds, or cleans up in the first helper run (a stop, a delete, a branch switch)', async () => {
    const w = newWindow();
    w.overdue();
    const result = await w.helper.run('vol', ['true'], { docker: false, network: false });
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
    const w = newWindow();
    let release: () => void = () => undefined;
    docker.buildHandler = () => new Promise<void>((resolve) => (release = resolve));
    const run = w.helper.run('vol', ['true'], { docker: false, network: false });
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
    expect(run.args).toContain('--tmpfs');
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

describe('WorkspaceHelper.switchBranch', () => {
  it('passes the token only on stdin and runs the switch script', async () => {
    await createHelper().switchBranch({ volumeName: 'vol', repository: 'acme/api', branch: 'feature/x', token: TOKEN });
    const run = docker.runs[0];
    expect(run.options.input).toBe(TOKEN);
    expect(run.args.some((arg) => arg.includes(TOKEN))).toBe(false);
    expect(run.args).toContain('--tmpfs');
    expect(commandOf(run.args)).toEqual(['sh', '-c', SWITCH_BRANCH_SCRIPT, 'sh', '/workspaces/api', 'feature/x', 'acme/api']);
  });

  it('shows the message of Git when Git refuses the switch', async () => {
    docker.handler = () => ({
      exitCode: 1,
      stderr:
        'error: Your local changes to the following files would be overwritten by checkout:\n\tREADME.md\nPlease commit your changes or stash them before you switch branches.\nAborting\n',
    });
    const error = await createHelper()
      .switchBranch({ volumeName: 'vol', repository: 'acme/api', branch: 'dev', token: TOKEN })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'gitSwitchFailed' });
    expect((error as Error).message).toBe(
      'The branch dev could not be checked out. error: Your local changes to the following files would be overwritten by checkout:\n\tREADME.md\nPlease commit your changes or stash them before you switch branches.\nAborting',
    );
  });

  it('throws a CommandError when the helper itself fails', async () => {
    docker.handler = () => ({ exitCode: 3, stderr: '/run/devenv-secrets is not a tmpfs mount.\n' });
    const error = await createHelper()
      .switchBranch({ volumeName: 'vol', repository: 'acme/api', branch: 'dev', token: TOKEN })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
  });
});

describe('WorkspaceHelper.prepareGit (concept section 9 "Git inside the container")', () => {
  const identity = { name: 'Hannes Stauss', email: '1001+scalarion@users.noreply.github.com' };

  // unit 15: prepareGit gets no token any more (the token goes into the memory of the dev container after its start,
  // writeContainerToken, tested in containerToken.test.ts): no stdin, no tmpfs, and no login argument.
  it('runs without the token, without the Docker socket, and without network', async () => {
    await createHelper().prepareGit({ volumeName: 'vol', repository: 'acme/api', identity });
    const run = docker.runs[0];
    expect(run.options.input).toBeUndefined();
    expect(run.args).not.toContain('--tmpfs');
    expect(run.args).not.toContain('-e');
    expect(run.args).not.toContain(`type=bind,source=${DOCKER_SOCKET},target=${DOCKER_SOCKET}`);
    expect(run.args.join(' ')).not.toContain('devenv-helper-cache');
    expect(run.args).toEqual(expect.arrayContaining(['--network', 'none']));
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
  it('ends the helper run after the time limit and removes its container', async () => {
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
      const name = docker.runs[0].args[docker.runs[0].args.indexOf('--name') + 1];
      expect(docker.calls.map((call) => call.args)).toContainEqual(['rm', '-f', name]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WorkspaceHelper.fixConfigOwnership (review round 15, K3)', () => {
  it('fixes the internal folder with numeric IDs, with only the workspace volume: no Docker socket, cache volume, or network', async () => {
    const result = await createHelper().fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1001', timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(docker.runs).toHaveLength(1);
    const run = docker.runs[0];
    expect(commandOf(run.args)).toEqual(configOwnershipFixCommand('/workspaces/.devenv+', '1000', '1001'));
    expect(run.args.join(' ')).toContain('source=vol,target=/workspaces');
    expect(hasDockerAccess(run.args)).toBe(false);
    expect(run.args).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(run.args).not.toContain('--tmpfs');
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
  it('runs Git and the file scripts without the Docker socket and the cache volume', async () => {
    const helper = createHelper();
    docker.handler = (args) => {
      const script = commandOf(args)[2];
      if (script === GIT_SUMMARY_SCRIPT) return { stdout: 'main\n0\n0\n0\n' };
      if (script === READ_FILES_SCRIPT) return { stdout: 'null\n' };
      if (script === LIST_CONFIGS_SCRIPT) return { stdout: '[]\n' };
      return {};
    };
    await helper.gitSummary({ volumeName: 'vol', repository: 'acme/api' });
    await helper.readConfigFiles({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer.json' });
    await helper.listConfigurations({ volumeName: 'vol', repository: 'acme/api' });
    await helper.switchBranch({ volumeName: 'vol', repository: 'acme/api', branch: 'dev', token: TOKEN });
    await helper.clone({ volumeName: 'vol', repository: 'acme/api', token: TOKEN });

    const [summary, readFiles, listConfigs, switchBranch, clone] = docker.runs.map((run) => run.args);
    for (const args of [summary, readFiles, listConfigs, switchBranch, clone]) {
      expect(hasDockerAccess(args)).toBe(false);
      expect(args).toContain('type=volume,source=vol,target=/workspaces');
    }
    // Only the runs that fetch or clone have network.
    expect([summary, readFiles, listConfigs].every(hasNoNetwork)).toBe(true);
    expect([switchBranch, clone].some(hasNoNetwork)).toBe(false);
  });

  // Unit 7: on a remote host the source of the socket mount is a path of that computer.
  it('mounts the socket of the engine of the operation (remote rootful, remote rootless, local)', async () => {
    let engine: HelperEngine = { key: 'box', socket: '/var/run/docker.sock' };
    const helper = new WorkspaceHelper({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' },
      platform: 'linux',
      engine: async () => engine,
    });
    docker.handler = () => ({ stdout: '{"configuration":{}}\n' });
    const read = () =>
      helper.readConfiguration({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer.json', environmentId: 'e' });
    await read();
    engine = { key: 'box', socket: '/run/user/1001/docker.sock' };
    await read();
    engine = { key: '', endpoint: 'unix:///run/user/1000/docker.sock' };
    await read();
    const sockets = docker.runs.map((run) => run.args.find((arg) => arg.includes('target=/var/run/docker.sock')));
    expect(sockets).toEqual([
      'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      'type=bind,source=/run/user/1001/docker.sock,target=/var/run/docker.sock',
      'type=bind,source=/run/user/1000/docker.sock,target=/var/run/docker.sock',
    ]);
  });

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

  it('gives the runs of the Dev Container CLI the Docker socket and the cache volume', async () => {
    const helper = createHelper();
    docker.handler = (args) =>
      commandOf(args)[0] === 'devcontainer'
        ? { stdout: '{"configuration":{}}\n' }
        : { stdout: '{"outcome":"success","containerId":"c1","imageName":"i:1"}\n' };
    await helper.readConfiguration({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer.json',
      environmentId: 'e',
    });
    await helper.build({ volumeName: 'vol', repository: 'acme/api', configPath: '.devcontainer.json', imageName: 'i:1' });
    await helper.up({ volumeName: 'vol', repository: 'acme/api', override: {}, environmentId: 'e', removeExistingContainer: false });

    expect(docker.runs).toHaveLength(3);
    for (const run of docker.runs) {
      expect(hasDockerAccess(run.args)).toBe(true);
      expect(hasNoNetwork(run.args)).toBe(false);
    }
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
      'devenv.environment-id=3f2a9c1e-5b7d',
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

    it('stops the read with the merged configuration after the time limit, removes its container, and reads without it', async () => {
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
      const name = docker.runs[0].args[docker.runs[0].args.indexOf('--name') + 1];
      expect(name).toMatch(/^devenv-helper-/);
      expect(docker.calls.map((call) => call.args)).toContainEqual(['rm', '-f', name]);
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
      const name = docker.runs[0].args[docker.runs[0].args.indexOf('--name') + 1];
      expect(docker.calls.map((call) => call.args)).toContainEqual(['rm', '-f', name]);
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
      'devenv.environment-id=3f2a9c1e-5b7d',
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
      containerId: 'c1',
      // review, PL-1/PL-2: runUserCommands takes the token (for the redaction of the output).
      token: TOKEN,
    });
    expect(result).toMatchObject({ outcome: 'success', containerId: 'c1' });
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
      'devenv.environment-id=3f2a9c1e-5b7d',
      '--container-id',
      'c1',
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

  it('composeModel runs the model script without the Docker socket, network, and the configuration folder, with the project name', async () => {
    docker.handler = () => ({ stdout: `${JSON.stringify(MODEL_OUTPUT)}\n` });
    const files = ['/workspaces/api/.devcontainer/compose.yml'];
    const result = await createHelper().composeModel({ volumeName: 'vol', repository: 'acme/api', files, project: 'devenv-3f2a9c1e' });
    expect(result).toEqual(MODEL_OUTPUT);
    const run = docker.runs[0];
    expect(hasDockerAccess(run.args)).toBe(false);
    expect(hasNoNetwork(run.args)).toBe(true);
    expect(run.args).toContain('type=tmpfs,destination=/workspaces/.devenv+');
    expect(run.args).toContain('COMPOSE_PROJECT_NAME=devenv-3f2a9c1e');
    expect(commandOf(run.args)).toEqual(['node', '-e', COMPOSE_MODEL_SCRIPT, '/workspaces/api', ...files]);
    expect(COMPOSE_MODEL_TIMEOUT_MS).toBe(60_000);
  });

  it('composeServiceHashes (recreate offer, review round 2): the hash script on the model at the path of up, without the Docker socket and network', async () => {
    const hash = 'c'.repeat(64);
    docker.handler = () => ({ stdout: `app ${hash}\ndb ${hash}\n` });
    const hashes = await createHelper().composeServiceHashes({ volumeName: 'vol', repository: 'acme/api', model: '{"services":{}}', project: 'devenv-3f2a9c1e' });
    expect(docker.runs[0].options.input).toBe('{"services":{}}');
    expect(hashes).toEqual(new Map([['app', hash], ['db', hash]]));
    const run = docker.runs[0];
    expect(hasDockerAccess(run.args)).toBe(false);
    expect(hasNoNetwork(run.args)).toBe(true);
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

  it('createRepositoryFolders runs its script without the Docker socket, network, and the configuration folder (review round 8, P8-2)', async () => {
    docker.handler = () => ({ stdout: '' });
    const folders = ['/workspaces/api/data/postgres', '/workspaces/api/logs'];
    await createHelper().createRepositoryFolders({ volumeName: 'vol', repository: 'acme/api', folders });
    const run = docker.runs[0];
    expect(hasDockerAccess(run.args)).toBe(false);
    expect(hasNoNetwork(run.args)).toBe(true);
    expect(run.args).toContain('type=tmpfs,destination=/workspaces/.devenv+');
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
    expect(hasDockerAccess(run.args)).toBe(true);
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
      'devenv.environment-id=3f2a9c1e-5b7d',
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
      containerId: 'c1',
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
      'devenv.environment-id=3f2a9c1e-5b7d',
      '--container-id',
      'c1',
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
