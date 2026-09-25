// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Decisions and messages of the open pipeline (PipelineUi) in VS Code (concept 6.5, 7.12, section 9).
import * as vscode from 'vscode';
import { Actions, Messages } from '../core/messages';
import { systemClock, type Clock, type Logger, type PipelineUi } from '../core/ports';
import type { VsCodeGitHubAuth } from './auth';

/** Identical non-blocking messages within this time are shown once. */
export const MESSAGE_DEDUPLICATION_MS = 60_000;

/** The only registry for which the GitHub session can provide credentials (scope `read:packages`). */
const GITHUB_PACKAGES_REGISTRY = 'ghcr.io';

export class VsCodePipelineUi implements PipelineUi {
  private readonly lastShown = new Map<string, number>();

  constructor(
    private readonly auth: VsCodeGitHubAuth,
    private readonly logger: Logger,
    private readonly showLog: () => void,
    private readonly clock: Clock = systemClock,
  ) {}

  // The questions are modal: the pipeline waits for the answer, and a notification that moves to the notification
  // center unanswered would leave the pipeline waiting without a visible question.

  async confirmUntrustedRepository(repository: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      Messages.untrustedRepository(repository),
      { modal: true },
      Actions.open,
    );
    return choice === Actions.open;
  }

  async configurationChanged(repository: string): Promise<'rebuildNow' | 'later'> {
    const rebuildNow: vscode.MessageItem = { title: Actions.rebuildNow };
    const later: vscode.MessageItem = { title: Actions.later, isCloseAffordance: true };
    const choice = await vscode.window.showInformationMessage(
      Messages.configurationChanged,
      { modal: true, detail: repository },
      rebuildNow,
      later,
    );
    return choice === rebuildNow ? 'rebuildNow' : 'later';
  }

  /**
   * Concept 7.5: asks whether the entry of an older version of `repository` is assigned to the account `login`
   * (EnvironmentClaims in the mode `interactive`). True for Assign; Not now and a dismissed dialog are false.
   */
  async confirmAssignment(repository: string, login: string): Promise<boolean> {
    const assign: vscode.MessageItem = { title: Actions.assign };
    const notNow: vscode.MessageItem = { title: Actions.notNow, isCloseAffordance: true };
    const choice = await vscode.window.showWarningMessage(
      Messages.assignOlderEnvironment(repository, login),
      { modal: true },
      assign,
      notNow,
    );
    return choice === assign;
  }

  async filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined> {
    const choice = await vscode.window.showWarningMessage(
      Messages.filesMissing,
      { modal: true, detail: repository },
      Actions.cloneAgain,
      Actions.deleteEnvironment,
    );
    if (choice === Actions.cloneAgain) return 'cloneAgain';
    if (choice === Actions.deleteEnvironment) return 'deleteEnvironment';
    return undefined;
  }

  info(message: string): void {
    if (!this.shouldShow(`info:${message}`)) return;
    this.logger.info(message);
    vscode.window
      .showInformationMessage(message)
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  warn(message: string): void {
    if (!this.shouldShow(`warn:${message}`)) return;
    this.logger.warn(message);
    vscode.window.showWarningMessage(message, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.showLog();
      },
      (error: unknown) => this.logger.error('Could not show the message.', error),
    );
  }

  registrySignIn(registry: string): void {
    const message = Messages.registrySignIn(registry);
    if (!this.shouldShow(`registry:${registry.toLowerCase()}`)) return;
    this.logger.info(message);
    if (registry.toLowerCase() !== GITHUB_PACKAGES_REGISTRY) {
      vscode.window
        .showInformationMessage(message)
        .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
      return;
    }
    vscode.window
      .showInformationMessage(message, Actions.signIn)
      .then(async (choice) => {
        if (choice !== Actions.signIn) return;
        // The next connection uses the session through the credentials provider of the image check.
        const credentials = await this.auth.getPackagesCredentials({ interactive: true });
        this.logger.info(
          credentials
            ? `Signed in for ${registry}. The next connection uses the sign-in.`
            : `The sign-in for ${registry} was not completed.`,
        );
      })
      .then(undefined, (error: unknown) => this.logger.error(`The sign-in for ${registry} failed.`, error));
  }

  private shouldShow(key: string): boolean {
    const now = this.clock.now();
    for (const [entry, shownAt] of this.lastShown) {
      if (now - shownAt >= MESSAGE_DEDUPLICATION_MS) this.lastShown.delete(entry);
    }
    if (this.lastShown.has(key)) return false;
    this.lastShown.set(key, now);
    return true;
  }
}
