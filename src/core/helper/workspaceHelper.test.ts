// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (U7, decision of 2026-10-08): the steps of WorkspaceHelper, which runs only in the worker, from the
// worker's own helper image (HelperDeps.ownImage) or the pinned image of an open (`image`), with the worker's socket.
// The tests of the helper image of a window (its build, cache, maintenance, record and the background prebuild), which
// ran through WorkspaceHelper while it delegated to HelperImages, moved to helperImages.rules.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeProjectName } from '../names';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { CommandError, UserFacingError, isUserFacingError } from '../errors';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { configOwnershipFixCommand } from '../git/gitSummary';
import { abortError, type Logger, type RunOptions, type RunResult } from '../ports';
import { errorDetail } from '../pipeline/pipelineRules';
import { runWithBatchScope } from './batchScope';
import type { BatchStepKind } from './batchStepKinds';
import { batchStepCommand } from './batchSteps';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { DevcontainerCommandError } from './devcontainerCli';
import {
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
import type { HelperImageUse } from './helperImage';
import { COMPOSE_MODEL_TIMEOUT_MS, MERGED_CONFIGURATION_TIMEOUT_MS, WorkspaceHelper } from './workspaceHelper';
import { isPassableEnvName } from './stepInputs';

// User decisions 2026-10-03: the names of an environment are resourceName (before: devenv-<8 hex>).
const NAME_ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = composeProjectName('acme/api', NAME_ID);

const TOKEN = 'gho_0123456789abcdefSECRET';
/**
 * Plan step 11I (U7, decision of 2026-10-08): the worker's own helper image, from which every step runs (before: the
 * helper image of the window, which the WorkspaceHelper built from a Dockerfile of the test through HelperImages).
 */
const OWN: HelperImageUse = { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` };
/** Plan step 11I (U7): the source of the socket mount of the engine (HelperDeps.socket, the worker's own). */
const SOCKET = '/var/run/docker.sock';

type Handler = (args: string[], options: RunOptions) => Partial<RunResult> | Promise<Partial<RunResult>>;

interface Call {
  args: string[];
  options: RunOptions;
}

/**
 * The engine of the steps: each step of a BridgeLock session is one `docker run` here. Plan step 11I (U7, decision of
 * 2026-10-08): only that; WorkspaceHelper has no Docker port (before: the calls of the helper image of the window too,
 * which helperImages.rules.test.ts fakes now).
 */
class FakeDocker {
  readonly calls: Call[] = [];
  handler: Handler = () => ({});
  /** Whether the fake sends stdout and stderr of the result to the output callbacks. */
  forwardOutput = true;

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

let docker: FakeDocker;
let logger: RecordingLogger;
/**
 * Plan step 11I (U7, decision of 2026-10-08): the answers of HelperDeps.containerRuns by container ID (`true`: it runs;
 * an Error: its state cannot be read; no answer: an Error too), and each container asked, in order. Before: the `docker
 * container inspect` of the fallback over the Docker CLI, which is removed (the worker's engine answers).
 */
let containerAnswers: Map<string, boolean | Error>;
let containerQueries: string[];

async function containerRuns(containerId: string): Promise<boolean> {
  containerQueries.push(containerId);
  const answer = containerAnswers.get(containerId) ?? new Error(`No such container: ${containerId}`);
  if (answer instanceof Error) throw answer;
  return answer;
}

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
            input: step.secret === 'stdin' ? options.secrets?.token : step.input,
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
  // user decision 2026-10-02: Delete runs no Git: WorkspaceHelper.gitSummary is removed (no step of it to batch).
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
 * a batch scope on `vol`, which takes the pinned image of an open, or else the worker's own image (plan step 11I, U7;
 * before: the image of the window).
 */
function helperStep(helper: WorkspaceHelper, options: { image?: HelperImageUse; signal?: AbortSignal; lock?: BridgeLock } = {}): Promise<RunResult> {
  const { lock, ...rest } = options;
  return batched(helper, lock === undefined ? undefined : () => lock).fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000', ...rest });
}

/**
 * Plan step 11I (U7, decision of 2026-10-08): the WorkspaceHelper of the worker (workerServices.ts): its own image, its
 * socket and containerRuns (before: a Docker port, the Dockerfile of the helper image of a window, its environment and
 * platform, and a clock).
 */
function plainHelper(): WorkspaceHelper {
  return new WorkspaceHelper({ logger, ownImage: OWN, socket: SOCKET, containerRuns });
}

function createHelper(): WorkspaceHelper {
  // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the volume steps run in a batch scope.
  return batched(plainHelper());
}

/** The image reference of each `docker run` from index `from` on. */
const references = (from = 0) => docker.runs.slice(from).map((run) => run.args.find((arg) => arg.startsWith('sha256:') || arg.startsWith('devenv-helper:')));

beforeEach(() => {
  docker = new FakeDocker();
  logger = new RecordingLogger();
  containerAnswers = new Map();
  containerQueries = [];
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

// Plan step 11I (U7, decision of 2026-10-08): the tests of WorkspaceHelper of the describes "WorkspaceHelper without a
// previous helper image" and "WorkspaceHelper.prebuildImage and HelperPrebuild" that test its steps (the others moved
// to helperImages.rules.test.ts).
describe('WorkspaceHelper with the image of an open (user decision 2026-09-29)', () => {
  it('fails with helperFailed without a build when the current image of an open is gone at a run (review round 2 of PR #64, A-N1; review round 3 of PR #64, P2)', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    // Plan step 11I (U7, decision of 2026-10-08): changed setup, the image of the open is the worker's own image
    // (before: the current tag of the window, pinned by the ID of its image), and the helper has no Docker port, so it
    // can build nothing (before: the count of the builds stayed).
    const helper = plainHelper();
    const image = await helper.ensureImageUse();
    expect(image).toEqual(OWN);
    // Changed expectation (review round 3 of PR #64, P2): before, the same tag was built again and the run went on with
    // it; a pinned run now uses the image ID, and when that image is gone the open ends with helperFailed: nothing is
    // built (a build may give another image).
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the batch helper of
    // the open is started with the pinned image ID and cannot be started when that image is gone (the worker's
    // `docker run --pull never` fails), so the step is refused (helperFailed, D1); nothing is built, and no other image is
    // used (was: the per-step `docker run` failed with "No such image" and logged it).
    const lock = new BridgeLock();
    lock.openError = new Error(`docker: Error response from daemon: No such image: ${OWN.id}`);
    const runs = docker.runs.length;
    const error = await helperStep(helper, { image, lock }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'helperFailed' });
    expect((error as UserFacingError).detail).toContain(`No such image: ${OWN.id}`);
    expect(lock.opens).toEqual([OWN.id]);
    expect(docker.runs).toHaveLength(runs);
    expect(logger.lines.join('\n')).not.toContain('It is built again');
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
      // Plan step 11I (U7, decision of 2026-10-08): changed setup, the image of the open is another image than the
      // worker's own, which the helper gives otherwise (before: the image that the open pinned, after which another
      // window rebuilt the tag and another open of the window switched the cache of the helper to the new image).
      const helper = plainHelper();
      const pinned: HelperImageUse = { tag: OWN.tag, id: `sha256:${'7'.repeat(64)}` };
      expect(await helper.ensureImageUse()).toEqual(OWN);
      docker.handler = (args) => {
        if (args[0] !== 'run') return {};
        return { stdout: '{"outcome":"success","containerId":"cccc","configuration":{},"services":{}}\n' };
      };
      const before = docker.runs.length;
      // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the call runs in a batch scope.
      await call(batched(helper), pinned).catch(() => undefined);
      const used = references(before);
      expect(used.length).toBeGreaterThan(0);
      expect(used.every((reference) => reference === pinned.id)).toBe(true);
    });
  });
});

// Review round 16 of PR #64 (R16-1): only a docker run that finds no helper image counts as a missing helper image.
// Plan step 11I (U7, decision of 2026-10-08): changed setup, the helper of the worker (before: the helper of a window
// with a state file); it has no cache of a helper image and no Docker port, so it builds nothing.
describe('R16-1: only a docker run that fails with exit code 125 and "No such image" counts as a missing helper image', () => {
  const cases: Array<[string, Partial<RunResult>]> = [
    ['a command that reports a missing image of its own (exit code 1)', { exitCode: 1, stderr: 'Error: No such image: sha256:abc\n' }],
    ['another docker run error (exit code 125)', { exitCode: 125, stderr: 'docker: Error response from daemon: Conflict. The container name "/x" is already in use.\n' }],
  ];

  it.each(cases)('pinned run: %s is the result of the run', async (_name, failure) => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const helper = plainHelper();
    const use = await helper.ensureImageUse();
    docker.handler = (args) => (args[0] === 'run' ? failure : {});
    const result = await helperStep(helper, { image: use });
    expect(result).toMatchObject(failure);
    expect(docker.runs).toHaveLength(1);
    // The cache of the window is kept: the next open reuses the image without a build. Plan step 11I (U7): changed
    // expectation, the next open gets the own image again, and nothing counts builds (before: one build, of the first
    // ensure).
    expect(await helper.ensureImageUse()).toEqual(use);
    expect(logger.lines.join('\n')).not.toContain('was removed');
  });

  it.each(cases)('unpinned run: %s is the result of the run, which is not run again', async (_name, failure) => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; a batch step (helperStep).
    const helper = plainHelper();
    await helper.ensureImageUse();
    docker.handler = (args) => (args[0] === 'run' ? failure : {});
    const result = await helperStep(helper);
    expect(result).toMatchObject(failure);
    expect(docker.runs).toHaveLength(1);
    expect(logger.lines.join('\n')).not.toContain('It is built again');
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

  // unit 15: prepareGit gets no token any more (the token goes into the memory of the dev container after its start;
  // plan step 11I, PR B: the script `tokenWrite` of the registry, tested in environmentService.test.ts and
  // containerToken.test.ts): no stdin, no tmpfs, and no login argument.
  it('runs without the token, as the step gitFiles', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step gitFiles of the batch helper (root, as before; the
    // per-step mounts and `--network none` are gone, Q2 of 2026-10-01); still no token, no input and no variable.
    await createHelper().prepareGit({ volumeName: 'vol', repository: 'acme/api', identity });
    const run = docker.runs[0];
    expect(bridge.kinds).toEqual(['gitFiles']);
    expect(run.options.input).toBeUndefined();
    // Follow-up of plan step 11I (the links of the owner): changed expectation, GIT_FILES_SCRIPT is a Node.js script, so
    // its command has the `-e` of `node -e`; still no `-e` (a variable) among the arguments of the run before it.
    const command = commandOf(run.args);
    expect(run.args.slice(0, run.args.length - command.length)).not.toContain('-e');
    // Review round 1 of that follow-up (B-L1): changed expectation, `--` before the arguments of the script.
    expect(command).toEqual(['node', '-e', GIT_FILES_SCRIPT, '--', 'api', identity.name, identity.email, CONTAINER_CREDENTIAL_HELPER]);
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
      stdout: `a log line on stdout\n{"outcome":"success","imageName":["${PROJECT}:2"]}\n`,
      stderr: '[2026] Start: Run: docker buildx build\n',
    });
    const output: string[] = [];
    const result = await createHelper().build({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer/python/devcontainer.json',
      imageName: `${PROJECT}:2`,
      onOutput: (text) => output.push(text),
    });
    expect(result).toEqual({ outcome: 'success', imageName: [`${PROJECT}:2`] });
    expect(output.join('')).toContain('a log line on stdout\n');
    expect(output.join('')).toContain('docker buildx build');
    expect(output.join('')).not.toContain('"outcome"');
    const configFile = '/workspaces/api/.devcontainer/python/devcontainer.json';
    // Follow-up of PR #121: every build runs through WRITE_AND_RUN_SCRIPT, for its lockfile rule (was: BUILD_SCRIPT), with
    // no files of the extension.
    expect(commandOf(docker.runs[0].args)).toEqual([
      'node',
      '-e',
      WRITE_AND_RUN_SCRIPT,
      '/tmp/devenv-override',
      configFile,
      '',
      'build',
      '--workspace-folder',
      '/workspaces/api',
      '--config',
      configFile,
      '--image-name',
      `${PROJECT}:2`,
      '--user-data-folder',
      '/devenv-cache',
    ]);
    expect(JSON.parse(docker.runs[0].options.input ?? '')).toEqual({ files: {} });
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
    const override = { image: `${PROJECT}:2`, shutdownAction: 'none' };
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
    // User decision of 2026-10-09 (Buildx 0.37.2): changed expectation: the only variable of up is the entitlement check of
    // bake turned off (was: no variable).
    expect(run.args.filter((_arg, index) => run.args[index - 1] === '-e')).toEqual(['BUILDX_BAKE_ENTITLEMENTS_FS=0']);
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
    const override = { image: `${PROJECT}:2`, shutdownAction: 'none' };
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
  const MODEL_OUTPUT = { version: '2.29.1', dollarEscaped: true, model: { name: PROJECT, services: { app: { image: 'x' } } }, dockerfiles: {}, realPaths: {}, inputsHash: 'abc' };

  it('composeModel runs the model script as the owner of the repository, with the project name', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step composeModel of the batch helper runs as the owner of the
    // repository, with CONFIG_FOLDER closed (was: a per-step run without the socket and network, with a tmpfs over it).
    docker.handler = () => ({ stdout: `${JSON.stringify(MODEL_OUTPUT)}\n` });
    const files = ['/workspaces/api/.devcontainer/compose.yml'];
    const result = await createHelper().composeModel({ volumeName: 'vol', repository: 'acme/api', files, project: PROJECT });
    expect(result).toEqual(MODEL_OUTPUT);
    const run = docker.runs[0];
    expect(bridge.kinds).toEqual(['composeModel']);
    expect(batchStepCommand('composeModel', { repository: 'acme/api', files, project: PROJECT }).owner).toBe('/workspaces/api');
    expect(run.args).toContain(`COMPOSE_PROJECT_NAME=${PROJECT}`);
    expect(commandOf(run.args)).toEqual(['node', '-e', COMPOSE_MODEL_SCRIPT, '/workspaces/api', ...files]);
    expect(COMPOSE_MODEL_TIMEOUT_MS).toBe(60_000);
  });

  it('composeServiceHashes (recreate offer, review round 2): the hash script on the model at the path of up', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step composeHash of the batch helper (was: a per-step run
    // without the socket and network).
    const hash = 'c'.repeat(64);
    docker.handler = () => ({ stdout: `app ${hash}\ndb ${hash}\n` });
    const hashes = await createHelper().composeServiceHashes({ volumeName: 'vol', repository: 'acme/api', model: '{"services":{}}', project: PROJECT });
    expect(docker.runs[0].options.input).toBe('{"services":{}}');
    expect(hashes).toEqual(new Map([['app', hash], ['db', hash]]));
    const run = docker.runs[0];
    expect(bridge.kinds).toEqual(['composeHash']);
    expect(run.args).toContain(`COMPOSE_PROJECT_NAME=${PROJECT}`);
    expect(commandOf(run.args)).toEqual(['node', '-e', COMPOSE_HASH_SCRIPT, COMPOSE_MODEL_PATH, PROJECT]);
    docker.handler = () => ({ exitCode: 1, stderr: 'unknown flag: --hash' });
    await expect(createHelper().composeServiceHashes({ volumeName: 'vol', repository: 'acme/api', model: '{}', project: 'p' })).rejects.toBeInstanceOf(CommandError);
  });

  it('composeModel returns the message of Docker Compose, and throws when the helper fails', async () => {
    docker.handler = () => ({ stdout: '{"error":"yaml: bad"}\n' });
    const p = { volumeName: 'vol', repository: 'acme/api', files: ['/workspaces/api/compose.yml'], project: PROJECT };
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
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step
    // createFolders of the batch helper runs as the owner of the repository; CONFIG_FOLDER stays open,
    // closeConfigFolder is only for the Compose steps (was: a per-step run without the socket and network, with a tmpfs
    // over it).
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
      env: { COMPOSE_PROJECT_NAME: PROJECT },
    });
    expect(result).toEqual({ config: { service: 'app' } });
    const run = docker.runs[0];
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step readConfiguration of the batch helper (root, with the
    // socket of the helper; was: a per-step run with the socket and the cache volume mounted).
    expect(bridge.kinds).toEqual(['readConfiguration']);
    expect(run.args).toContain(`COMPOSE_PROJECT_NAME=${PROJECT}`);
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
    docker.handler = () => ({ stdout: `{"outcome":"success","imageName":["${PROJECT}:2"]}\n` });
    const override = { dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app' };
    await createHelper().build({
      volumeName: 'vol',
      repository: 'acme/api',
      configPath: '.devcontainer/devcontainer.json',
      imageName: `${PROJECT}:2`,
      override,
      files: { [COMPOSE_MODEL_PATH]: '{}', [COMPOSE_DEV_DOCKERFILE]: 'FROM x\n' },
      env: { COMPOSE_PROJECT_NAME: PROJECT },
    });
    const run = docker.runs[0];
    expect(run.args).toContain(`COMPOSE_PROJECT_NAME=${PROJECT}`);
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
      `${PROJECT}:2`,
      '--user-data-folder',
      '/devenv-cache',
    ]);
    expect(Object.keys(JSON.parse(run.options.input ?? '').files)).toEqual([COMPOSE_MODEL_PATH, COMPOSE_DEV_DOCKERFILE, OVERRIDE_CONFIG_PATH]);
  });

  it('up with files writes them with the override configuration and passes the project name', async () => {
    docker.handler = () => ({ stdout: `{"outcome":"success","containerId":"c1","composeProjectName":"${PROJECT}"}\n` });
    const override = { dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app', shutdownAction: 'none' };
    const result = await createHelper().up({
      volumeName: 'vol',
      repository: 'acme/api',
      override,
      environmentId: '3f2a9c1e-5b7d',
      removeExistingContainer: false,
      files: { [COMPOSE_MODEL_PATH]: `{"name":"${PROJECT}"}` },
      env: { COMPOSE_PROJECT_NAME: PROJECT },
    });
    expect(result).toMatchObject({ outcome: 'success', containerId: 'c1' });
    const run = docker.runs[0];
    expect(run.args).toContain(`COMPOSE_PROJECT_NAME=${PROJECT}`);
    const command = commandOf(run.args);
    expect(command.slice(0, 7)).toEqual(['node', '-e', WRITE_AND_RUN_SCRIPT, '/tmp/devenv-override', '', '', 'up']);
    expect(command).toContain('--override-config');
    expect(JSON.parse(run.options.input ?? '')).toEqual({
      files: { [COMPOSE_MODEL_PATH]: `{"name":"${PROJECT}"}`, [OVERRIDE_CONFIG_PATH]: JSON.stringify(override, null, 2) },
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
      files: { [COMPOSE_MODEL_PATH]: `{"name":"${PROJECT}"}` },
      env: { COMPOSE_PROJECT_NAME: PROJECT },
      // review, PL-1/PL-2: runUserCommands takes the token (for the redaction of the output).
      token: TOKEN,
    });
    const run = docker.runs[0];
    expect(run.args).toContain(`COMPOSE_PROJECT_NAME=${PROJECT}`);
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
      files: { [COMPOSE_MODEL_PATH]: `{"name":"${PROJECT}"}`, [OVERRIDE_CONFIG_PATH]: JSON.stringify(override, null, 2) },
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

  /**
   * The result of the CLI: run-user-commands names no container. Plan step 11I (U7, decision of 2026-10-08): changed
   * setup, `running` answers containerRuns (before: the answer of `docker container inspect`, `inspect`).
   */
  function answer(description: string, running: boolean): void {
    const stdout = `${JSON.stringify({ outcome: 'error', message: 'Command failed: /bin/sh -c npm install', description })}\n`;
    docker.handler = (args) => (args[0] === 'run' ? { exitCode: 1, stdout } : {});
    containerAnswers.set(CONTAINER_ID, running);
  }

  function runUserCommands(): Promise<unknown> {
    // review, PL-1/PL-2: runUserCommands takes the token (for the redaction of the output).
    return createHelper().runUserCommands({ volumeName: 'vol', repository: 'acme/api', override: {}, environmentId: 'e', containerId: CONTAINER_ID, token: TOKEN });
  }

  it('keeps the container that runs, with the description of the CLI', async () => {
    const description = 'postCreateCommand from devcontainer.json failed.';
    answer(description, true);
    await expect(runUserCommands()).resolves.toEqual({ outcome: 'success', containerId: CONTAINER_ID, lifecycleCommandFailure: description });
    expect(logger.lines.some((line) => line.startsWith('warn') && line.includes(description))).toBe(true);
  });

  it('throws the error with the container ID when the container does not run', async () => {
    answer('postStartCommand from devcontainer.json failed.', false);
    const error = await runUserCommands().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevcontainerCommandError);
    expect(error).toMatchObject({ command: 'devcontainer run-user-commands', result: { containerId: CONTAINER_ID } });
  });

  it('throws for other errors without asking Docker', async () => {
    answer('An error occurred running user commands in the container.', true);
    await expect(runUserCommands()).rejects.toBeInstanceOf(DevcontainerCommandError);
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, containerRuns is not asked (before: no `docker
    // container` call).
    expect(containerQueries).toEqual([]);
  });
});

describe('review PL-1: the token in the output of run-user-commands and up', () => {
  const CONTAINER_ID = '4f1c2b3a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a';
  const RESULT = '{"outcome":"success","result":"done"}\n';

  /**
   * The helper run sends `stdout` and `stderr` in these chunks (in this order) and ends with `exitCode`. Plan step 11I
   * (U7, decision of 2026-10-08): changed setup, `running` answers containerRuns (before: the answer of `docker
   * container inspect`, `inspect`, which without one said that the container does not run).
   */
  function streams(p: { stdout?: string[]; stderr?: string[]; exitCode?: number; running?: boolean }): void {
    docker.forwardOutput = false;
    containerAnswers.set(CONTAINER_ID, p.running ?? false);
    docker.handler = (args, options) => {
      if (args[0] !== 'run') return {};
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
      running: false,
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

  /**
   * `up` ends with `upStdout` and exit code 1; containerRuns answers `running` (an Error: the state cannot be read).
   * Plan step 11I (U7, decision of 2026-10-08): changed setup (before: `docker container inspect` answered with
   * `inspect`).
   */
  function answer(upStdout: string, running: boolean | Error): void {
    docker.handler = (args) => (args[0] === 'run' ? { exitCode: 1, stdout: upStdout } : {});
    containerAnswers.set(CONTAINER_ID, running);
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
    answer(lifecycleFailure(description), true);
    await expect(up()).resolves.toEqual({ outcome: 'success', containerId: CONTAINER_ID, lifecycleCommandFailure: description });
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the state of the container is asked of the
    // engine of the worker (HelperDeps.containerRuns; before: `docker container inspect --format {{json
    // .State.Status}}` of the fallback over the Docker CLI, which is removed).
    expect(containerQueries).toEqual([CONTAINER_ID]);
    expect(logger.lines.some((line) => line.startsWith('warn') && line.includes(description))).toBe(true);
  });

  it('throws when the container does not run', async () => {
    answer(lifecycleFailure('postStartCommand from devcontainer.json failed.'), false);
    await expect(up()).rejects.toBeInstanceOf(DevcontainerCommandError);
  });

  it('throws when the state of the container cannot be read', async () => {
    answer(lifecycleFailure('postStartCommand from devcontainer.json failed.'), new Error('Error: No such container'));
    await expect(up()).rejects.toBeInstanceOf(DevcontainerCommandError);
    expect(containerQueries).toEqual([CONTAINER_ID]);
  });

  it('throws for other errors, also with a container ID, without asking Docker', async () => {
    answer(lifecycleFailure('An error occurred setting up the container.'), true);
    await expect(up()).rejects.toBeInstanceOf(DevcontainerCommandError);
    answer(lifecycleFailure('postStartCommand from devcontainer.json failed.', null), true);
    await expect(up()).rejects.toBeInstanceOf(DevcontainerCommandError);
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, containerRuns is not asked (before: no `docker
    // container` call).
    expect(containerQueries).toEqual([]);
  });
});

describe('plan step 7 (user decision of 2026-10-01): no volume step outside the batch scope of an operation', () => {
  it('every volume step outside a scope throws an internal error (D1) and starts no container, builds nothing, and runs nothing', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed setup, the helper of the worker (before: with a Docker port).
    const helper = plainHelper();
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
      // user decision 2026-10-02: Delete runs no Git: changed expectation, WorkspaceHelper.gitSummary is removed (no case).
    ];
    for (const [name, call] of calls) {
      const error = await call().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error, name).toBeInstanceOf(Error);
      // Plan step 11I (PR D): changed, the message names the kind of the step without its command (WorkspaceHelper no longer
      // builds one; before: "step <kind> (<command>) on the volume").
      expect((error as Error).message, name).toMatch(/^Internal error: the workspace helper step \w+ on the volume vol ran outside the batch helper of an operation; it was not run\.$/);
      expect((error as Error).message, name).not.toContain(TOKEN);
      expect(isUserFacingError(error), name).toBe(false);
    }
    expect(docker.calls).toEqual([]);
    // Plan step 11I (U7): changed expectation, the helper has no Docker port, so it builds nothing (before: no build of
    // the helper image); it asks for no container either.
    expect(containerQueries).toEqual([]);
    // (readConfiguration reads once more without the merged configuration after its first read failed.)
    expect(logger.lines.filter((line) => line.startsWith('error Internal error'))).toHaveLength(calls.length + 1);
    expect(logger.lines.join('\n')).not.toContain(TOKEN);
  });
});
