// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Error presentation (concept 6.5): a message names the situation and offers at most one action besides Show details.
// The complete error goes to the log (NFR-02).
import * as vscode from 'vscode';
import { isUserFacingError, type UserErrorCode } from '../core/errors';
import { Actions } from '../core/messages';
import { isAbortError, type Logger } from '../core/ports';
import { RegistryVersionError } from '../core/storage/registry';

// User-visible text that messages.ts lacks; to be moved there.
/** Message for an error without a plain-language message of its own. */
export const OPERATION_FAILED = 'The operation failed.';

/** Command of the welcome view and of the action "Sign in" (package.json). */
const SIGN_IN_COMMAND = 'devEnvironments.signIn';
/**
 * Command of the action "Install Docker…" (Show Docker Setup, hidden): shows the sidebar view, whose welcome view has
 * the steps of the Docker setup while the CLI is missing (a CLI lost since it was found is reported by ContainerAdapter).
 */
const INSTALL_DOCKER_COMMAND = 'devEnvironments.dockerSetup.show';
/**
 * Command of the action "Start Docker" (Linux, Docker Engine; local windows only): `sudo systemctl enable --now docker`
 * in a terminal, after a confirmation. The extension cannot start Docker Engine by itself (administrator rights).
 */
const START_DOCKER_COMMAND = 'devEnvironments.dockerSetup.start';

export interface ShowErrorOptions {
  logger: Logger;
  showLog: () => void;
  /** Runs the operation again (action Try again). Without it, Try again is not offered. A returned promise that
   *  rejects is logged. */
  retry?: () => unknown;
}

type ErrorAction = 'installDocker' | 'startDocker' | 'showDetails' | 'tryAgain' | 'signIn';

interface Presentation {
  message: string;
  severity: 'error' | 'warning';
  actions: ErrorAction[];
}

/** True for errors that mean "the user cancelled": nothing is shown. */
export function isCancellation(error: unknown): boolean {
  return (isUserFacingError(error) && error.code === 'cancelled') || isAbortError(error);
}

/**
 * Shows an error in a message with the actions of concept 6.5, and writes the complete error to the log.
 * Cancellations show nothing. Never throws; it does not wait for the user.
 */
export function showError(error: unknown, options: ShowErrorOptions): void {
  if (isCancellation(error)) {
    options.logger.info('The operation was cancelled.');
    return;
  }
  const presentation = present(error, options.retry !== undefined);
  options.logger.error(presentation.message, error);

  const labels = presentation.actions.map((action) => Actions[action]);
  const shown =
    presentation.severity === 'warning'
      ? vscode.window.showWarningMessage(presentation.message, ...labels)
      : vscode.window.showErrorMessage(presentation.message, ...labels);
  shown.then(
    (choice) => {
      const action = presentation.actions.find((candidate) => Actions[candidate] === choice);
      if (action) runAction(action, options);
    },
    (reason: unknown) => options.logger.error('Could not show the message.', reason),
  );
}

function present(error: unknown, canRetry: boolean): Presentation {
  if (error instanceof RegistryVersionError) {
    return { message: error.message, severity: 'error', actions: ['showDetails'] };
  }
  if (!isUserFacingError(error)) {
    return { message: OPERATION_FAILED, severity: 'error', actions: ['showDetails'] };
  }
  const rule = ACTIONS[error.code];
  let actions: ErrorAction[];
  if (rule === 'retry') actions = canRetry ? ['showDetails', 'tryAgain'] : ['showDetails'];
  else if (rule === 'retryOnly') actions = canRetry ? ['tryAgain'] : ['showDetails'];
  else actions = rule;
  // Start Docker of the Docker setup runs only in a local window (a terminal of a remote window runs on the remote
  // computer); the message names the command to run on the Docker host.
  if (vscode.env.remoteName !== undefined) actions = actions.filter((action) => action !== 'startDocker');
  return { message: error.message, severity: WARNINGS.has(error.code) ? 'warning' : 'error', actions };
}

// Concept 6.5 table: at most one action besides Show details.
// 'retry': Show details, plus Try again when the caller can retry. 'retryOnly': Try again (Show details without retry).
const ACTIONS: Record<UserErrorCode, ErrorAction[] | 'retry' | 'retryOnly'> = {
  dockerNotInstalled: ['installDocker'],
  dockerStartFailed: 'retry',
  buildFailed: 'retry',
  startFailed: 'retry',
  helperFailed: 'retry',
  cloneFailed: 'retry',
  firstOpenOffline: 'retryOnly',
  dockerEngineNotRunning: ['showDetails', 'startDocker'],
  noConfiguration: ['showDetails'],
  gitSwitchFailed: ['showDetails'],
  filesMissing: ['showDetails'],
  signInRequired: ['signIn'],
  hostAccess: ['showDetails'],
  unencryptedDockerConnection: ['showDetails'],
  otherAccount: [],
  cancelled: [],
  // Unit 7: never Start Docker or Install Docker… for a remote host.
  dockerHostUnreachable: 'retry',
  dockerEndpointUnsupported: ['showDetails'],
  otherDockerHost: ['showDetails'],
};

/** Situations that the user can resolve, rather than failures. */
const WARNINGS = new Set<UserErrorCode>([
  'noConfiguration',
  'gitSwitchFailed',
  'signInRequired',
  'hostAccess',
  'unencryptedDockerConnection',
  'otherAccount',
  'dockerEndpointUnsupported',
  'otherDockerHost',
]);

function runAction(action: ErrorAction, options: ShowErrorOptions): void {
  try {
    switch (action) {
      case 'installDocker':
        vscode.commands
          .executeCommand(INSTALL_DOCKER_COMMAND)
          .then(undefined, (error: unknown) => options.logger.error('Could not open the Docker setup.', error));
        return;
      case 'startDocker':
        vscode.commands
          .executeCommand(START_DOCKER_COMMAND)
          .then(undefined, (error: unknown) => options.logger.error('Docker could not be started.', error));
        return;
      case 'showDetails':
        options.showLog();
        return;
      case 'tryAgain':
        // A failed async retry must reach the log, not end as an unhandled rejection in the extension host.
        Promise.resolve(options.retry?.()).catch((error: unknown) => options.logger.error('Try again failed.', error));
        return;
      case 'signIn':
        vscode.commands
          .executeCommand(SIGN_IN_COMMAND)
          .then(undefined, (error: unknown) => options.logger.error('The sign-in failed.', error));
        return;
    }
  } catch (error) {
    options.logger.error('The action failed.', error);
  }
}
