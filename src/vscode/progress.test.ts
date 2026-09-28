// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Messages } from '../core/messages';
import type { ProgressReporter } from '../core/ports';
import { currentOperation, hideProgressNotification, onDidChangeBusy, progressMessage, runWithProgress, type BusyChange } from './progress';
import { EventEmitter, fakeVscode, resetFakeVscode } from './testing/fakeVscode';

interface FakeProgressRun {
  options: { location: number; cancellable?: boolean; title?: string };
  messages: string[];
  cancel(): void;
}

/** withProgress that records the reported messages and offers a Cancel button to the test. */
function scriptWithProgress(): FakeProgressRun[] {
  const runs: FakeProgressRun[] = [];
  fakeVscode.window.withProgress.mockImplementation(async (options, task) => {
    const cancellation = new EventEmitter<void>();
    const run: FakeProgressRun = { options, messages: [], cancel: () => cancellation.fire() };
    runs.push(run);
    return task(
      { report: (value: { message?: string }) => run.messages.push(value.message ?? '') },
      { isCancellationRequested: false, onCancellationRequested: cancellation.event },
    );
  });
  return runs;
}

describe('progressMessage', () => {
  it('shows the title, the step of concept 6.5, the detail, and the link Show details', () => {
    expect(progressMessage('Opening acme/api…', undefined, undefined)).toBe(
      'Opening acme/api… [Show details](command:devEnvironments.showLog)',
    );
    expect(progressMessage('Opening acme/api…', 'downloadingImage', Messages.newerImage)).toBe(
      'Opening acme/api… Downloading the new image. A newer image is available. The environment is updated. Your files are kept. [Show details](command:devEnvironments.showLog)',
    );
  });
});

describe('runWithProgress', () => {
  beforeEach(() => resetFakeVscode());

  it('shows one notification with the steps and returns the result of the task', async () => {
    const runs = scriptWithProgress();
    const result = await runWithProgress({
      title: 'Opening acme/api…',
      task: async (progress: ProgressReporter) => {
        progress.step('checkingImage');
        progress.step('downloadingImage');
        progress.detail(Messages.newerImage);
        progress.step('starting');
        return 42;
      },
    });
    expect(result).toBe(42);
    expect(runs).toHaveLength(1);
    expect(runs[0].options).toEqual({ location: fakeVscode.ProgressLocation.Notification, cancellable: false });
    // User decision 2026-09-28: changed expectation, the link Show details names the operation (and closes the
    // notification, see below).
    expect(runs[0].messages.every((message) => /\[Show details\]\(command:devEnvironments\.showProgressDetails\?%5B\d+%5D\)$/.test(message))).toBe(true);
    expect(runs[0].messages.map((message) => message.replace(/ \[Show details\]\(command:[^)]*\)$/, ''))).toEqual([
      'Opening acme/api…',
      'Opening acme/api… Checking for a newer image.',
      'Opening acme/api… Downloading the new image.',
      `Opening acme/api… Downloading the new image. ${Messages.newerImage}`,
      'Opening acme/api… Starting environment.',
    ]);
  });

  it('aborts the signal when the user selects Cancel', async () => {
    const runs = scriptWithProgress();
    const promise = runWithProgress({
      title: 'Opening acme/api…',
      cancellable: true,
      task: (_progress, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await Promise.resolve();
    expect(runs[0].options.cancellable).toBe(true);
    runs[0].cancel();
    await expect(promise).rejects.toThrow('aborted');
  });

  it('reports busy while operations run, with the newest operation, and not busy after the last one', async () => {
    scriptWithProgress();
    const changes: BusyChange[] = [];
    const subscription = onDidChangeBusy((change) => changes.push(change));
    let finishFirst!: () => void;
    let failSecond!: (error: Error) => void;
    const first = runWithProgress({
      title: 'Opening acme/api…',
      repository: 'acme/api',
      task: () => new Promise<void>((resolve) => (finishFirst = resolve)),
    });
    const second = runWithProgress({
      title: 'Opening acme/web…',
      repository: 'acme/web',
      task: () => new Promise<void>((_resolve, reject) => (failSecond = reject)),
    });
    await Promise.resolve();
    expect(currentOperation()).toEqual({ title: 'Opening acme/web…', repository: 'acme/web' });

    failSecond(new Error('failed'));
    await expect(second).rejects.toThrow('failed');
    expect(currentOperation()).toEqual({ title: 'Opening acme/api…', repository: 'acme/api' });
    finishFirst();
    await first;
    expect(currentOperation()).toBeUndefined();
    subscription.dispose();

    expect(changes).toEqual([
      { busy: true, title: 'Opening acme/api…', repository: 'acme/api' },
      { busy: true, title: 'Opening acme/web…', repository: 'acme/web' },
      { busy: true, title: 'Opening acme/api…', repository: 'acme/api' },
      { busy: false },
    ]);
  });

  it('keeps the repository of a running pipeline while an operation without a repository runs', async () => {
    scriptWithProgress();
    const changes: BusyChange[] = [];
    const subscription = onDidChangeBusy((change) => changes.push(change));
    let finishPipeline!: () => void;
    let finishStop!: () => void;
    const pipeline = runWithProgress({
      title: 'Opening acme/api…',
      repository: 'acme/api',
      task: () => new Promise<void>((resolve) => (finishPipeline = resolve)),
    });
    const stop = runWithProgress({ title: 'Stopping acme/web…', task: () => new Promise<void>((resolve) => (finishStop = resolve)) });
    await Promise.resolve();
    finishPipeline();
    await pipeline;
    finishStop();
    await stop;
    subscription.dispose();

    expect(changes).toEqual([
      { busy: true, title: 'Opening acme/api…', repository: 'acme/api' },
      { busy: true, title: 'Stopping acme/web…', repository: 'acme/api' },
      { busy: true, title: 'Stopping acme/web…' },
      { busy: false },
    ]);
  });

  it('closes the notification on Show details, and the operation goes on and settles (user decision 2026-09-28)', async () => {
    let notificationClosed = false;
    const runs: FakeProgressRun[] = [];
    fakeVscode.window.withProgress.mockImplementation(async (options, task) => {
      const cancellation = new EventEmitter<void>();
      const run: FakeProgressRun = { options, messages: [], cancel: () => cancellation.fire() };
      runs.push(run);
      const value = await task(
        { report: (report: { message?: string }) => run.messages.push(report.message ?? '') },
        { isCancellationRequested: false, onCancellationRequested: cancellation.event },
      );
      notificationClosed = true;
      return value;
    });
    let finish: (value: number) => void = () => undefined;
    let reporter: ProgressReporter | undefined;
    const promise = runWithProgress({
      title: 'Opening acme/api…',
      repository: 'acme/api',
      cancellable: true,
      task: (progress) => {
        reporter = progress;
        progress.step('downloadingImage');
        return new Promise<number>((resolve) => {
          finish = resolve;
        });
      },
    });
    await Promise.resolve();
    const link = /command:devEnvironments\.showProgressDetails\?([^)]*)\)$/.exec(runs[0].messages.at(-1) ?? '');
    expect(link).not.toBeNull();
    const [id] = JSON.parse(decodeURIComponent(link![1])) as [number];
    // Another ID closes nothing.
    hideProgressNotification(id + 1000);
    hideProgressNotification('x');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationClosed).toBe(false);
    hideProgressNotification(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationClosed).toBe(true);
    // The operation goes on: still busy (the status bar shows it), and no more reports to the closed notification.
    expect(currentOperation()).toEqual({ title: 'Opening acme/api…', repository: 'acme/api' });
    const reported = runs[0].messages.length;
    reporter!.step('starting');
    expect(runs[0].messages).toHaveLength(reported);
    finish(7);
    await expect(promise).resolves.toBe(7);
    expect(currentOperation()).toBeUndefined();
  });

  it('passes a failure of the task on after Show details closed the notification', async () => {
    const runs = scriptWithProgress();
    let fail: (error: Error) => void = () => undefined;
    const promise = runWithProgress({
      title: 'x',
      task: () =>
        new Promise<number>((_resolve, reject) => {
          fail = reject;
        }),
    });
    await Promise.resolve();
    const [id] = JSON.parse(decodeURIComponent(/\?([^)]*)\)$/.exec(runs[0].messages.at(-1) ?? '')![1])) as [number];
    hideProgressNotification(id);
    fail(new Error('failed'));
    await expect(promise).rejects.toThrow('failed');
    expect(currentOperation()).toBeUndefined();
  });

  it('ends the busy state also when the notification cannot be shown', async () => {
    fakeVscode.window.withProgress.mockRejectedValue(new Error('no window'));
    await expect(runWithProgress({ title: 'x', task: async () => 1 })).rejects.toThrow('no window');
    expect(currentOperation()).toBeUndefined();
  });
});
