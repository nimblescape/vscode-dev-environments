// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Progress of one operation in one notification (concept 6.5, implementation notes 13): the plain steps, the reason of
// an update, and "Show details" for the output channel.
import * as vscode from 'vscode';
import { Actions, Steps, type ProgressStep } from '../core/messages';
import type { ProgressReporter } from '../core/ports';

/** Command that opens the output channel (package.json). */
export const SHOW_LOG_COMMAND = 'devEnvironments.showLog';

/**
 * User decision 2026-09-28: the link "Show details" of a progress notification opens the output channel and closes the
 * notification (the operation goes on; the status bar shows it). Its argument is the ID of the operation.
 */
export const SHOW_PROGRESS_DETAILS_COMMAND = 'devEnvironments.showProgressDetails';

// A progress notification cannot have buttons besides Cancel, but its message renders links, also command links.
const SHOW_DETAILS_LINK = `[${Actions.showDetails}](command:${SHOW_LOG_COMMAND})`;

/** The link "Show details" of the notification of operation `id`: opens the output channel and closes the notification. */
function showDetailsLink(id: number): string {
  return `[${Actions.showDetails}](command:${SHOW_PROGRESS_DETAILS_COMMAND}?${encodeURIComponent(JSON.stringify([id]))})`;
}

export interface ProgressRun<T> {
  /** For example `Messages.opening(repository)`. */
  title: string;
  /** Repository of the operation, for the status bar (`Updating owner/name…`). */
  repository?: string;
  /** Shows a Cancel button that aborts the signal. Default: false. */
  cancellable?: boolean;
  task: (progress: ProgressReporter, signal: AbortSignal) => Promise<T>;
}

export interface BusyChange {
  busy: boolean;
  /** Title of the newest running operation. */
  title?: string;
  /**
   * Repository of the newest running operation that has one. An operation without a repository (for example a short
   * Stop) that starts while a pipeline runs does not hide the pipeline's "Updating owner/name…".
   */
  repository?: string;
}

const busyEmitter = new vscode.EventEmitter<BusyChange>();
/** Fires when an operation starts, and when the last running operation ends (for the status bar "Updating …"). */
export const onDidChangeBusy: vscode.Event<BusyChange> = busyEmitter.event;

interface RunningOperation {
  title: string;
  repository?: string;
  /** User decision 2026-09-28: the ID in the link "Show details" of its notification (hideProgressNotification). */
  id: number;
  /** Closes its notification; the operation goes on. */
  hide?: () => void;
}
let nextOperationId = 1;
const running: RunningOperation[] = [];

/** The newest running operation (its title and repository), or `undefined`. */
export function currentOperation(): Readonly<{ title: string; repository?: string }> | undefined {
  const newest = running[running.length - 1];
  if (!newest) return undefined;
  return newest.repository === undefined ? { title: newest.title } : { title: newest.title, repository: newest.repository };
}

function busyChange(): BusyChange {
  const newest = currentOperation();
  if (!newest) return { busy: false };
  let repository: string | undefined;
  for (let index = running.length - 1; index >= 0 && repository === undefined; index--) {
    repository = running[index].repository;
  }
  return repository === undefined ? { busy: true, title: newest.title } : { busy: true, title: newest.title, repository };
}

/**
 * Text of the notification: the title, the current step and its detail, then the link "Show details" (with the ID of
 * the operation: it also closes the notification, showDetailsLink; without: it only opens the output channel).
 */
export function progressMessage(title: string, step: ProgressStep | undefined, detail: string | undefined, id?: number): string {
  const parts = [title];
  if (step) parts.push(`${Steps[step]}.`);
  if (detail) parts.push(detail);
  parts.push(id === undefined ? SHOW_DETAILS_LINK : showDetailsLink(id));
  return parts.join(' ');
}

/**
 * User decision 2026-09-28: closes the progress notification of the running operation `id` (the argument of the link
 * "Show details"). The operation goes on and settles as before; the status bar shows it while it runs. Its Cancel button
 * is gone with the notification. An unknown or ended operation is ignored.
 */
export function hideProgressNotification(id: unknown): void {
  const operation = running.find((candidate) => candidate.id === id);
  operation?.hide?.();
}

/**
 * Runs `task` with one progress notification. The message shows the current step (`Steps[step]`) and its detail,
 * followed by the link "Show details" (command `devEnvironments.showProgressDetails` with the ID of the operation: it
 * opens the output channel and closes the notification, while the task goes on). Cancel aborts the signal. The promise
 * settles with the result of the task.
 */
export function runWithProgress<T>(run: ProgressRun<T>): Promise<T> {
  const operation: RunningOperation = { title: run.title, repository: run.repository, id: nextOperationId++ };
  running.push(operation);
  busyEmitter.fire(busyChange());

  const controller = new AbortController();
  let started = false;
  const result = new Promise<T>((resolve, reject) => {
    // The title is part of the message (not the `title` option), so that the notification does not show "title: step".
    vscode.window
      .withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: run.cancellable ?? false },
        async (progress, token) => {
          const cancellation = token.onCancellationRequested(() => controller.abort());
          let finished = false;
          let step: ProgressStep | undefined;
          let detail: string | undefined;
          const show = () => {
            if (!finished) progress.report({ message: progressMessage(run.title, step, detail, operation.id) });
          };
          const reporter: ProgressReporter = {
            step(next) {
              step = next;
              detail = undefined;
              show();
            },
            detail(message) {
              detail = message;
              show();
            },
          };
          // User decision 2026-09-28: "Show details" closes the notification (the callback returns), the task goes on.
          let hide: () => void = () => undefined;
          const hidden = new Promise<void>((resolveHidden) => {
            hide = resolveHidden;
          });
          // The callback returns; its `finally` stops the reports to the closed notification.
          operation.hide = () => hide();
          show();
          started = true;
          try {
            // Also a task that throws before it returns its promise (the rejection is passed on).
            const task = Promise.resolve().then(() => run.task(reporter, controller.signal));
            task.then(resolve, reject);
            await Promise.race([task.then(() => undefined, () => undefined), hidden]);
          } finally {
            finished = true;
            cancellation.dispose();
          }
        },
      )
      // Only a notification that could not be shown fails the operation; once the task runs, it settles the result.
      .then(undefined, (error: unknown) => {
        if (!started) reject(error);
      });
  });

  return result.finally(() => {
    const index = running.indexOf(operation);
    if (index >= 0) running.splice(index, 1);
    busyEmitter.fire(busyChange());
  });
}
