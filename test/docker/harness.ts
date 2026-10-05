// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared parts of the Docker test files: the run of the global setup, a log file per test file, the timings, and fakes
// for the user interface, the GitHub session, and the network. Everything else is the real core modules.
import type { DeleteConfirmation } from '../../src/core/pipeline/deleteCheck';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, expect, inject } from 'vitest';
import type { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { findExecutable } from '../../src/core/docker/dockerCli';
import { helperImageTag } from '../../src/core/helper/helperImage';
import { nodeHttpsTransport, type HttpTransport } from '../../src/core/http';
import { DockerCredentialStore, withGitHubPackagesFallback } from '../../src/core/imageCheck/credentials';
import type { CheckOutcome, ConfigReferences, ImageChecker } from '../../src/core/imageCheck/imageCheck';
import { RegistryClient } from '../../src/core/imageCheck/registryClient';
import type { ProgressStep } from '../../src/core/messages';
import { LABEL_BUILD_RECORD, LABEL_ENVIRONMENT_ID, LABEL_HELPER_RUN, LABEL_OWNER_ID, LABEL_REPOSITORY, WORKSPACES_ROOT } from '../../src/core/names';
import { errorDetail } from '../../src/core/pipeline/pipelineRules';
import {
  abortError,
  sleep,
  type GitHubAuth,
  type Logger,
  type PipelineUi,
  type ProcessRunner,
  type ProgressReporter,
  type RunResult,
} from '../../src/core/ports';
import type { Environment } from '../../src/core/types';
import { DockerCli, TEST_RUN_LABEL, failureMarker, testDockerEnv, type DockerTestRun } from './dockerRun';
import { EnvironmentService, type EnvironmentServiceDeps } from '../../src/core/pipeline/environmentService';
import { EnvironmentOperations, type EnvironmentOperationsDeps } from '../../src/core/pipeline/environmentOperations';

/** resources/helper/Dockerfile: the real workspace helper. */
export const HELPER_DOCKERFILE = path.resolve(__dirname, '../../resources/helper/Dockerfile');

/**
 * Plan step 7 (user decision of 2026-10-01): the per-step path of WorkspaceHelper (and WorkspaceHelper.run) is removed. A
 * command of a test (the seed of a volume, or a check of what it holds) in a plain container of the helper image (its
 * tag; the caller has ensured it) on `volume` at /workspaces, as root, without the Docker socket and without network,
 * through `docker` (so with its Docker context). It is the arrangement of a test, never a step of the extension; it
 * carries the label of the helper runs and is removed when it ends (`--rm`).
 */
export function runInVolume(docker: Pick<ContainerAdapter, 'run'>, volume: string, command: readonly string[], input?: string): Promise<RunResult> {
  const tag = helperImageTag(fs.readFileSync(HELPER_DOCKERFILE, 'utf8'));
  const args = ['run', '--rm', '-i', '--pull', 'never', '--label', `${LABEL_HELPER_RUN}=true`, '--network', 'none', '--mount', `type=volume,source=${volume},target=${WORKSPACES_ROOT}`, tag, ...command];
  return docker.run(args, { input });
}

/**
 * User decisions 2026-10-03: the environment image of `entry` (its build record) carries the labels of the environment
 * (environment ID, repository, owner) and its build record as JSON, and the record pins the ID of that image (`docker
 * image inspect -f {{.Id}}`). Returns the labels of the image.
 */
export function expectLabelledEnvironmentImage(cli: DockerCli, entry: Environment | undefined): Record<string, string> {
  const record = entry?.buildRecord;
  expect(record).toBeDefined();
  const image = record!.environmentImage;
  const labels = cli.image(image)?.Config.Labels ?? {};
  expect(labels).toMatchObject({ [LABEL_ENVIRONMENT_ID]: entry!.id, [LABEL_REPOSITORY]: entry!.repository, [LABEL_OWNER_ID]: entry!.owner.id });
  expect(JSON.parse(labels[LABEL_BUILD_RECORD] ?? '{}')).toMatchObject({ environmentImage: image, buildNumber: record!.buildNumber, configPath: record!.configPath });
  expect(record!.imageId).toBe(cli.ok(['image', 'inspect', '-f', '{{.Id}}', image]));
  return labels;
}

/** Token for the helper runs. The tests clone only public repositories, so Git never sends it. */
export const DUMMY_TOKEN = 'dummy-token-of-the-docker-tests';

/** The account of the fake GitHub session; the environments of the tests belong to it. */
export const TEST_ACCOUNT = { id: '4242', login: 'devenv-test' };

export const fakeAuth: GitHubAuth = {
  getToken: async () => DUMMY_TOKEN,
  getAccount: async () => TEST_ACCOUNT,
  getPackagesCredentials: async () => undefined,
};

export interface DockerTestContext {
  run: DockerTestRun;
  /** Environment of the Docker calls: the Docker configuration of the run, without credentials. */
  env: NodeJS.ProcessEnv;
  cli: DockerCli;
  log: TestLog;
}

/**
 * The run of the global setup and the log of a test file. Call it in the body of a `describe`: each test writes its name
 * to the log, and a failed test prints the end of the log and keeps the run folder.
 */
export function dockerTestContext(name: string): DockerTestContext {
  const run = inject('dockerTest');
  const env = testDockerEnv(run);
  const log = new TestLog(path.join(run.runDir, 'logs', `${name}.log`));
  beforeEach(({ task, onTestFailed }) => {
    log.info(`===== ${task.name} =====`);
    onTestFailed(() => {
      fs.writeFileSync(failureMarker(run), '');
      console.error(`End of ${log.file}:\n${log.tail(150)}`);
    });
  });
  return { run, env, cli: new DockerCli(run.dockerPath, env), log };
}

/**
 * Plan step 5, PR B: a volume of its own for the lock files of the workers of a test file (ChannelOpenDeps.stateVolume),
 * so that the volume of the Session Monitor of the engine is never created or touched; with the label of the run, so
 * that removeRunObjects removes it. Created now when it is missing; returns its name.
 */
export function testStateVolume(context: Pick<DockerTestContext, 'run' | 'cli'>, name: string): string {
  const volume = `devenv-test-state-${name}-${context.run.runId}`;
  if (context.cli.volume(volume) === undefined) context.cli.ok(['volume', 'create', '--label', `${TEST_RUN_LABEL}=${context.run.runId}`, volume]);
  return volume;
}

/** Logger of the core modules. Messages and the output of the tools go to one file per test file. */
export class TestLog implements Logger {
  private readonly started = Date.now();

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  info(message: string): void {
    this.write('INFO ', message);
  }

  warn(message: string): void {
    this.write('WARN ', message);
  }

  error(message: string, error?: unknown): void {
    this.write('ERROR', error === undefined ? message : `${message}: ${errorDetail(error)}`);
  }

  output(text: string): void {
    fs.appendFileSync(this.file, text);
  }

  /** The last lines of the log. */
  tail(lines: number): string {
    const text = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '';
    return text.split('\n').slice(-lines).join('\n');
  }

  private write(level: string, message: string): void {
    const seconds = ((Date.now() - this.started) / 1000).toFixed(1).padStart(6);
    fs.appendFileSync(this.file, `[${seconds}] ${level} ${message}\n`);
  }
}

/** Durations of the scenarios of a test file; `print` shows them at the end of the file. */
export class Timings {
  private readonly rows: string[] = [];

  /** Runs `fn` and records its duration. */
  async measure<T>(name: string, fn: () => Promise<T>, detail?: (result: T) => string): Promise<T> {
    const started = Date.now();
    const result = await fn();
    this.add(name, Date.now() - started, detail?.(result));
    return result;
  }

  add(name: string, ms: number, detail?: string): void {
    this.rows.push(`${name}: ${(ms / 1000).toFixed(1)} s${detail ? ` (${detail})` : ''}`);
  }

  print(title: string): void {
    if (this.rows.length > 0) console.log(`${title}\n${this.rows.map((row) => `  ${row}`).join('\n')}`);
  }
}

/** Progress of one operation: the steps in order, and the details. */
export class RecordingProgress implements ProgressReporter {
  readonly steps: ProgressStep[] = [];
  readonly details: string[] = [];
  private readonly startedAt = new Map<ProgressStep, number>();
  private readonly created = Date.now();

  step(step: ProgressStep): void {
    this.steps.push(step);
    this.startedAt.set(step, Date.now());
  }

  detail(message: string): void {
    // An empty detail removes the detail of the current step.
    if (message !== '') this.details.push(message);
  }

  /** The steps with their durations, for the timings: `checkingImage 0.4 s, starting 0.6 s`. */
  summary(): string {
    const now = Date.now();
    return this.steps
      .map((step, index) => {
        const start = this.startedAt.get(step) ?? this.created;
        const end = index + 1 < this.steps.length ? this.startedAt.get(this.steps[index + 1]) ?? now : now;
        return `${step} ${((end - start) / 1000).toFixed(1)} s`;
      })
      .join(', ');
  }
}

/** The order of the steps in concept 6.5. */
const STEP_ORDER: ProgressStep[] = [
  'startingDocker',
  'downloadingRepository',
  'checkingImage',
  'downloadingImage',
  'preparing',
  'starting',
  'connecting',
];

/** True if the steps follow the order of concept 6.5 and none repeats. */
export function inConceptOrder(steps: readonly ProgressStep[]): boolean {
  return steps.every((step, index) => index === 0 || STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(steps[index - 1]));
}

/** Records the decisions and messages of the pipeline; it confirms, answers "Later", and cancels "files missing". */
export class FakeUi implements PipelineUi {
  readonly events: Array<{ kind: string; text: string }> = [];

  async confirmUntrustedRepository(repository: string): Promise<boolean> {
    this.events.push({ kind: 'confirmUntrustedRepository', text: repository });
    return true;
  }

  async configurationChanged(repository: string): Promise<'rebuildNow' | 'later'> {
    this.events.push({ kind: 'configurationChanged', text: repository });
    return 'later';
  }

  async configurationKindChanged(repository: string, message: string): Promise<'rebuildNow' | 'later'> {
    this.events.push({ kind: 'configurationKindChanged', text: `${repository}: ${message}` });
    return 'later';
  }

  // Plan step 11C2b: the questions of Delete; by default Delete, Keep, nothing ticked.
  deleteAnswer: 'delete' | 'open' | undefined = 'delete';
  additionalVolumesAnswer: 'remove' | 'keep' | undefined = 'keep';
  serviceDataAnswer: string[] | undefined = [];

  async confirmDelete(_repository: string, _confirmation?: DeleteConfirmation): Promise<'delete' | 'open' | undefined> {
    return this.deleteAnswer;
  }

  async deleteAdditionalVolumes(): Promise<'remove' | 'keep' | undefined> {
    return this.additionalVolumesAnswer;
  }

  async deleteServiceData(): Promise<string[] | undefined> {
    return this.serviceDataAnswer;
  }

  async filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined> {
    this.events.push({ kind: 'filesMissing', text: repository });
    return undefined;
  }

  /** Recreate offer (user request 2026-09-26): the answer to recreateContainer; default Cancel. */
  recreateAnswer = false;

  async recreateContainer(repository: string, question: { message: string; detail: string }): Promise<boolean> {
    this.events.push({ kind: 'recreateContainer', text: `${repository}: ${question.message}` });
    return this.recreateAnswer;
  }

  info(message: string): void {
    this.events.push({ kind: 'info', text: message });
  }

  warn(message: string): void {
    this.events.push({ kind: 'warn', text: message });
  }

  registrySignIn(registry: string): void {
    this.events.push({ kind: 'registrySignIn', text: registry });
  }

  /** The events after the first `count` events. */
  since(count: number): Array<{ kind: string; text: string }> {
    return this.events.slice(count);
  }
}

/**
 * The HTTPS transport of the extension; a request that the registry answers with HTTP 429 is sent again after a pause
 * (1 s, then 2 s, within the 5-second limit of the image check). Registries limit the request rate of anonymous
 * clients, and the tests read digests right after Docker pulled from the same registry.
 */
export const registryTransport: HttpTransport = {
  async request(request, signal) {
    for (let attempt = 1; ; attempt++) {
      const response = await nodeHttpsTransport.request(request, signal);
      if (response.status !== 429 || attempt > 2) return response;
      await sleep(attempt * 1000, signal);
    }
  },
};

/** A computer without network: each request fails at once, as a failed name resolution does. */
export const offlineTransport: HttpTransport = {
  async request(request) {
    const error = new Error(`getaddrinfo ENOTFOUND ${new URL(request.url).host}`) as NodeJS.ErrnoException;
    error.code = 'ENOTFOUND';
    throw error;
  },
};

/** A registry that never answers: only the time limit of the check ends the requests. */
export const hangingTransport: HttpTransport = {
  request(_request, signal) {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  },
};

/**
 * The registry client of the extension (src/vscode/extension.ts): the Docker credentials, then the GitHub session for
 * ghcr.io. With the Docker configuration of the run (no credentials) and the fake session, it never has credentials.
 */
export function registryClient(transport: HttpTransport, runner: ProcessRunner, env: NodeJS.ProcessEnv, log: Logger): RegistryClient {
  const credentials = new DockerCredentialStore(runner, {
    env,
    platform: process.platform,
    homeDir: os.homedir(),
    findExecutable: (name) => findExecutable(name, env, process.platform),
    logger: log,
  });
  return new RegistryClient(transport, withGitHubPackagesFallback(credentials.provider(), fakeAuth), log);
}

export interface CheckRecord {
  label: string;
  /** Start of the check (Date.now()). */
  startedAt: number;
  ms: number;
  status: string;
}

/** An image checker that records the duration and the result of each check. */
export function timedChecker(inner: ImageChecker, label: string, records: CheckRecord[]): Pick<ImageChecker, 'check'> {
  return {
    async check(references: ConfigReferences, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CheckOutcome> {
      const started = Date.now();
      try {
        const outcome = await inner.check(references, options);
        records.push({ label, startedAt: started, ms: Date.now() - started, status: outcome.status });
        return outcome;
      } catch (error) {
        records.push({ label, startedAt: started, ms: Date.now() - started, status: `threw ${String(error)}` });
        throw error;
      }
    },
  };
}

/** The current registry digest of an image reference, read with the checker of the extension. */
export async function registryDigest(checker: Pick<ImageChecker, 'check'>, reference: string): Promise<string> {
  const outcome = await checker.check({ images: [reference], features: [] });
  if (outcome.status !== 'checked' || outcome.images[reference] === undefined) {
    throw new Error(`The digest of ${reference} could not be read: ${JSON.stringify(outcome)}`);
  }
  return outcome.images[reference];
}

/** Plan step 11F1: the deps of a pipeline of a Docker test, with the flows of the window to the worker. */
export type PipelineTestDeps = EnvironmentServiceDeps & Pick<EnvironmentOperationsDeps, 'flow' | 'workerRefresh'>;

/**
 * Plan step 11F1: the pipeline of a Docker test (EnvironmentService, as the worker runs it) and, on the same records, the
 * operations of the window (EnvironmentOperations: Stop, the refresh and the opens that it sends to the worker).
 */
export function pipelineWithOperations(deps: PipelineTestDeps): EnvironmentService & { operations: EnvironmentOperations } {
  const operations = new EnvironmentOperations({
    ...deps,
    // The engine of the tests runs; nothing to start.
    startDocker: deps.startDocker ?? (async () => {}),
    dockerRunning: () => deps.docker.isRunning(),
  });
  return Object.assign(new EnvironmentService(deps), { operations });
}
