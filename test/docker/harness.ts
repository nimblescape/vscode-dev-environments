// Shared parts of the Docker test files: the run of the global setup, a log file per test file, the timings, and fakes
// for the user interface, the GitHub session, and the network. Everything else is the real core modules.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, inject } from 'vitest';
import { findExecutable } from '../../src/core/docker/dockerCli';
import { nodeHttpsTransport, type HttpTransport } from '../../src/core/http';
import { DockerCredentialStore, withGitHubPackagesFallback } from '../../src/core/imageCheck/credentials';
import type { CheckOutcome, ConfigReferences, ImageChecker } from '../../src/core/imageCheck/imageCheck';
import { RegistryClient } from '../../src/core/imageCheck/registryClient';
import type { ProgressStep } from '../../src/core/messages';
import { errorDetail } from '../../src/core/pipeline/pipelineRules';
import {
  abortError,
  sleep,
  type GitHubAuth,
  type Logger,
  type PipelineUi,
  type ProcessRunner,
  type ProgressReporter,
} from '../../src/core/ports';
import { DockerCli, failureMarker, testDockerEnv, type DockerTestRun } from './dockerRun';

/** resources/helper/Dockerfile: the real workspace helper. */
export const HELPER_DOCKERFILE = path.resolve(__dirname, '../../resources/helper/Dockerfile');

/** Token for the helper runs. The tests clone only public repositories, so Git never sends it. */
export const DUMMY_TOKEN = 'dummy-token-of-the-docker-tests';

export const fakeAuth: GitHubAuth = {
  getToken: async () => DUMMY_TOKEN,
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

  async filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined> {
    this.events.push({ kind: 'filesMissing', text: repository });
    return undefined;
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
