// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker setup (concept 6.1 step 2, 7.3): the context keys of the welcome view, the Docker row, and the walkthrough
// "Set up Docker for Dev Environments", and the command that opens the walkthrough. The rules are pure functions in
// src/core/docker/dockerSetup.ts.
import * as vscode from 'vscode';
import type { ContainerAdapter } from '../core/docker/containerAdapter';
import {
  INITIAL_DOCKER_SETUP_STATE,
  MISSING_CLI_CHECK_MS,
  changedContextValues,
  needsMissingCliCheck,
  nextDockerSetupState,
  type DockerSetupEvent,
  type DockerSetupState,
} from '../core/docker/dockerSetup';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';

/** The walkthrough of package.json (`contributes.walkthroughs`), with the ID of this extension (publisher.name). */
export const DOCKER_WALKTHROUGH_ID = 'nimblescape.vscode-dev-environments#dockerSetup';
// Internal VS Code command (not extension API): opens a walkthrough of the Welcome page. Arguments: the walkthrough ID
// (`publisher.extension#walkthrough`) and `toSide`.
export const OPEN_WALKTHROUGH_COMMAND = 'workbench.action.openWalkthrough';

// User-visible texts that messages.ts lacks; to be moved there.
export const DockerSetupUiTexts = {
  /** A terminal of a remote window runs on the remote computer, not on this one. */
  localWindowNeeded: 'Open a local window to install Docker.',
} as const;

export interface DockerSetupDeps {
  docker: Pick<ContainerAdapter, 'isInstalled'>;
  logger: Logger;
  /** The CLI was found or lost: the sidebar shows or hides the Docker row. */
  onDidChangeInstalled: () => void;
  /** For tests: MISSING_CLI_CHECK_MS. */
  timing?: { missingCheckMs?: number };
}

export class DockerSetup implements vscode.Disposable {
  private state: DockerSetupState = INITIAL_DOCKER_SETUP_STATE;
  /** The state that the context keys show; `undefined` until they were set once. */
  private shown: DockerSetupState | undefined;
  private missingTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: DockerSetupDeps) {}

  /** True while no Docker CLI is found. */
  get dockerMissing(): boolean {
    return !this.state.cliFound;
  }

  /** Sets the context keys; while the CLI is missing, it is looked up again every 10 seconds. No `docker info`. */
  initialize(): void {
    this.checkCli();
  }

  /** Looks for the CLI (ContainerAdapter looks a missing CLI up again, at most every 10 seconds). */
  checkCli(): boolean {
    let found: boolean;
    try {
      found = this.deps.docker.isInstalled();
    } catch (error) {
      this.deps.logger.warn(`The Docker CLI could not be looked up: ${errorMessage(error)}`);
      found = false;
    }
    this.apply({ kind: 'cli', found });
    return found;
  }

  /** The result of a `docker info` that ran anyway (ContainerAdapter option `onDaemonStatus`). */
  reportDaemonStatus(running: boolean): void {
    this.apply({ kind: 'engine', running });
  }

  /** Command devEnvironments.installDocker: opens the walkthrough (only in a local window). */
  async openWizard(): Promise<void> {
    if (this.refuseInRemoteWindow()) return;
    await vscode.commands.executeCommand(OPEN_WALKTHROUGH_COMMAND, DOCKER_WALKTHROUGH_ID, false);
  }

  dispose(): void {
    this.disposed = true;
    this.stopMissingTimer();
  }

  /** In a remote window, a terminal would run on the remote computer: the user is asked to open a local window. */
  private refuseInRemoteWindow(): boolean {
    if (vscode.env.remoteName === undefined) return false;
    this.deps.logger.info(`Docker is installed only from a local window (this window: ${vscode.env.remoteName}).`);
    vscode.window
      .showInformationMessage(DockerSetupUiTexts.localWindowNeeded)
      .then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
    return true;
  }

  private apply(event: DockerSetupEvent): void {
    if (this.disposed) return;
    const before = this.state;
    const first = this.shown === undefined;
    this.state = nextDockerSetupState(before, event);
    for (const [key, value] of changedContextValues(this.shown, this.state)) {
      vscode.commands.executeCommand('setContext', key, value).then(undefined, (error: unknown) => {
        this.deps.logger.warn(`Could not set the context key ${key}: ${errorMessage(error)}`);
      });
    }
    this.shown = this.state;
    // The first check only sets the keys: the sidebar reads `dockerMissing` when it renders.
    if (!first && before.cliFound !== this.state.cliFound) {
      this.deps.logger.info(this.state.cliFound ? 'The Docker CLI was found.' : 'The Docker CLI was not found.');
      this.deps.onDidChangeInstalled();
    }
    this.updateMissingTimer();
  }

  private updateMissingTimer(): void {
    if (!needsMissingCliCheck(this.state)) {
      this.stopMissingTimer();
      return;
    }
    if (this.missingTimer) return;
    this.missingTimer = setInterval(() => this.checkCli(), this.deps.timing?.missingCheckMs ?? MISSING_CLI_CHECK_MS);
  }

  private stopMissingTimer(): void {
    if (this.missingTimer) clearInterval(this.missingTimer);
    this.missingTimer = undefined;
  }
}
