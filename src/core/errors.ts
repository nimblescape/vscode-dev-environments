// Errors with a plain-language message for the user (NFR-02). Technical details go to the log.

export type UserErrorCode =
  | 'dockerNotInstalled'
  | 'dockerStartFailed'
  | 'dockerEngineNotRunning'
  | 'helperFailed'
  | 'cloneFailed'
  | 'firstOpenOffline'
  | 'composeNotSupported'
  | 'noConfiguration'
  | 'buildFailed'
  | 'startFailed'
  | 'filesMissing'
  | 'gitSwitchFailed'
  | 'signInRequired'
  | 'cancelled';

export class UserFacingError extends Error {
  constructor(
    readonly code: UserErrorCode,
    message: string,
    /** Technical details for the log. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}

/** A command that ended with a non-zero exit code. */
export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} failed with exit code ${exitCode}: ${(stderr || stdout).trim().slice(-2000)}`);
    this.name = 'CommandError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
