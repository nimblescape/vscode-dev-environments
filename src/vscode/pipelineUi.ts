// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Decisions and messages of the open pipeline (PipelineUi) in VS Code (concept 6.5, 7.12, section 9).
import * as vscode from 'vscode';
import { Actions, MAX_LISTED_NAMES, Messages, formatChanges, listSome, recordedStateNote } from '../core/messages';
import type { DeleteConfirmation } from '../core/pipeline/deleteCheck';
import { ControllerTexts } from './controllerTexts';
import { systemClock, type Clock, type Logger, type PipelineUi } from '../core/ports';
import type { VsCodeGitHubAuth } from './auth';
import { GITHUB_PACKAGES_REGISTRY } from '../core/imageCheck/credentials';

/** Identical non-blocking messages within this time are shown once. */
export const MESSAGE_DEDUPLICATION_MS = 60_000;

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
   * Plan step 11C2b (moved from the controller's Delete): the confirmation with the changes ("Delete anyway", "Open
   * environment"), else the plain one; the note of an out-of-date recorded state in the locale of this computer (review
   * round 1 of PR #87, A-R1-4), the data of services in the repository (review round 9, D9-2), and the other window that
   * closes its connection.
   */
  async confirmDelete(repository: string, confirmation: DeleteConfirmation): Promise<'delete' | 'open' | undefined> {
    const stateNote = recordedStateNote(confirmation.recordedAt !== undefined ? { recordedAt: confirmation.recordedAt } : undefined, confirmation.lastSeenInUse);
    const repositoryDataText = confirmation.repositoryData.length > 0 ? ` ${Messages.deleteRepositoryServiceData(listSome(confirmation.repositoryData))}` : '';
    const otherWindow = confirmation.otherWindow ? ` ${ControllerTexts.otherWindowClosesConnection(repository)}` : '';
    // Review round 1 of 11C2b (A-R1-M2): the counts, worded here.
    const changes = confirmation.changes ? formatChanges(confirmation.changes) : '';
    if (changes !== '') {
      const choice = await vscode.window.showWarningMessage(
        `${Messages.deleteUnsaved(repository, changes)}${stateNote}${repositoryDataText}${otherWindow}`,
        { modal: true },
        Actions.openEnvironment,
        Actions.deleteAnyway,
      );
      return choice === Actions.deleteAnyway ? 'delete' : choice === Actions.openEnvironment ? 'open' : undefined;
    }
    const choice = await vscode.window.showWarningMessage(`${Messages.deleteConfirm(repository)}${stateNote}${repositoryDataText}${otherWindow}`, { modal: true }, Actions.delete);
    return choice === Actions.delete ? 'delete' : undefined;
  }

  /** Plan step 11C2b: the additional volumes that Delete may remove (moved from the controller's Delete). */
  async deleteAdditionalVolumes(volumes: readonly string[]): Promise<'remove' | 'keep' | undefined> {
    // Review round 2 of 11C2b (A-R2-L-a): a message of normal length (the names come from the worker); review round 3
    // (A-R3-L2): every name that Remove removes is in its detail.
    const choice = await vscode.window.showWarningMessage(
      Messages.deleteAdditionalVolumes(listSome(volumes)),
      { modal: true, ...(volumes.length > MAX_LISTED_NAMES ? { detail: volumes.join('\n') } : {}) },
      Actions.remove,
      Actions.keep,
    );
    return choice === Actions.remove ? 'remove' : choice === Actions.keep ? 'keep' : undefined;
  }

  /** Plan step 11C2b (D-19, review round 3 P3-4): the data of the services, none ticked (moved from the controller's Delete). */
  async deleteServiceData(volumes: readonly string[], possibly: readonly string[]): Promise<string[] | undefined> {
    const placeHolder = possibly.length > 0 ? Messages.deleteServiceDataPossiblePlaceholder : Messages.deleteServiceDataPlaceholder;
    const picked = await vscode.window.showQuickPick(
      volumes.map((name) => ({
        label: name,
        description: possibly.includes(name) ? Messages.deleteServiceDataPossibleItem : Messages.deleteServiceDataItem,
        picked: false,
      })),
      { title: Messages.deleteServiceDataTitle, placeHolder, canPickMany: true, ignoreFocusOut: true },
    );
    return picked === undefined ? undefined : picked.map((item) => item.label);
  }

  async configurationKindChanged(repository: string, message: string): Promise<'rebuildNow' | 'later'> {
    const rebuildNow: vscode.MessageItem = { title: Actions.rebuildNow };
    // Keeping the kind is the answer of a dismissed dialog (it removes nothing).
    const later: vscode.MessageItem = { title: Actions.later, isCloseAffordance: true };
    const choice = await vscode.window.showWarningMessage(message, { modal: true, detail: repository }, rebuildNow, later);
    return choice === rebuildNow ? 'rebuildNow' : 'later';
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

  async recreateContainer(repository: string, question: { message: string; detail: string }): Promise<boolean> {
    // The modal adds Cancel, the answer of a dismissed dialog (it removes nothing).
    const choice = await vscode.window.showWarningMessage(question.message, { modal: true, detail: question.detail }, Actions.recreateContainer);
    this.logger.info(`${repository}: ${choice === Actions.recreateContainer ? 'Recreate' : 'Cancel'} was chosen.`);
    return choice === Actions.recreateContainer;
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
