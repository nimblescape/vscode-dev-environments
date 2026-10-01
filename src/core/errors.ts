// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Errors with a plain-language message for the user (NFR-02). Technical details go to the log.

export type UserErrorCode =
  | 'dockerNotInstalled'
  | 'dockerStartFailed'
  | 'dockerEngineNotRunning'
  | 'helperFailed'
  | 'cloneFailed'
  | 'firstOpenOffline'
  | 'noConfiguration'
  | 'buildFailed'
  | 'startFailed'
  | 'filesMissing'
  | 'signInRequired'
  | 'hostAccess'
  | 'unencryptedDockerConnection'
  | 'otherAccount'
  | 'dockerHostUnreachable'
  | 'dockerEndpointUnsupported'
  | 'otherDockerHost'
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

/**
 * User decision of 2026-10-01 (D1): "refuse the operation, a helper that cannot be opened is an inconsistent state, we
 * already defined that." The refusal of the batch scope of an open (src/core/helper/batchScope.ts: a session that cannot
 * be opened, a lost lock, a step without a batch kind, …), with Messages.batchHelperUnavailable. Its code stays
 * `helperFailed`, so that every rule of a failed helper still applies to it (a helperFailed in Step 8 fails the open,
 * the container of a failed `up` is withdrawn); but it is told apart from a helperFailed of the helper image
 * (isBatchHelperUnavailable): the rule of 2026-09-29, under which a running, current container opens as it is when the
 * helper cannot be prepared at the start, does not apply to it. Start, Rebuild and Select configuration are refused.
 */
export class BatchHelperUnavailableError extends UserFacingError {
  readonly batchHelperUnavailable = true;
  constructor(message: string, detail?: string) {
    super('helperFailed', message, detail);
  }
}

/** Whether `error` is the refusal of the batch scope (BatchHelperUnavailableError). */
export function isBatchHelperUnavailable(error: unknown): error is BatchHelperUnavailableError {
  return error instanceof BatchHelperUnavailableError;
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
