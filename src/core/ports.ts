// Interfaces through which code in src/core receives what it needs. Code in src/core never imports `vscode`.
import type { ProgressStep } from './messages';
import type { GitHubAccount } from './types';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  /** Raw output of a tool (Docker, the Dev Container CLI, Git). Appended as it is. */
  output(text: string): void;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  output() {},
};

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function isoTime(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/** Waits `ms` milliseconds. Rejects with an `AbortError` when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const error = new Error('The operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export interface RunOptions {
  /** Complete environment of the process. Default: the environment of this process. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to standard input, then standard input is closed. Without it, standard input is closed at once. */
  input?: string;
  /** The process is killed after this time. */
  timeoutMs?: number;
  /** The process is killed when the signal aborts, and `run` rejects with an `AbortError`. */
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface RunResult {
  /** `null` when the process ended through a signal (for example after a timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a program without a shell. `run` resolves also for a non-zero exit code.
 * It rejects when the program cannot be started (the error has `code === 'ENOENT'` if it does not exist),
 * and with an `AbortError` when the signal aborts.
 */
export interface ProcessRunner {
  run(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** Progress of one operation, shown in one notification (concept 6.5). */
export interface ProgressReporter {
  /** Starts a step. Steps that are not needed are not reported. */
  step(step: ProgressStep): void;
  /** Additional text for the current step, for example the reason for an update. */
  detail(message: string): void;
}

export const silentProgress: ProgressReporter = { step() {}, detail() {} };

export interface Credentials {
  username: string;
  password: string;
}

/** Access to the GitHub session of VS Code (concept section 9). */
export interface GitHubAuth {
  /** Token of the session with the scopes `repo` and `read:org`. `interactive: false` never shows a dialog. */
  getToken(options: { interactive: boolean }): Promise<string | undefined>;
  /**
   * The account of the same session as getToken: the GitHub user ID and the login. `undefined` when no session exists
   * (not signed in). `interactive: false` never shows a dialog.
   */
  getAccount(options: { interactive: boolean }): Promise<GitHubAccount | undefined>;
  /** Credentials for ghcr.io from the session with the additional scope `read:packages`. */
  getPackagesCredentials(options: { interactive: boolean }): Promise<Credentials | undefined>;
}

/** Decisions and messages that the open pipeline needs from the user interface. */
export interface PipelineUi {
  /** Security (concept section 9): first open of a repository of another owner. */
  confirmUntrustedRepository(repository: string): Promise<boolean>;
  /** Concept 7.12: the devcontainer.json changed since the last build. */
  configurationChanged(repository: string): Promise<'rebuildNow' | 'later'>;
  /** Concept 7.12: the workspace volume is missing. `undefined` means cancel. */
  filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined>;
  /** Non-blocking information message. */
  info(message: string): void;
  /** Non-blocking warning message. */
  warn(message: string): void;
  /** Non-blocking message "The registry … requires a sign-in." with the action Sign in (only for ghcr.io). */
  registrySignIn(registry: string): void;
}
