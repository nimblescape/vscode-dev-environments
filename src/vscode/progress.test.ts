// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Messages } from '../core/messages';
import type { ProgressReporter } from '../core/ports';
import { currentOperation, onDidChangeBusy, progressMessage, runWithProgress, type BusyChange } from './progress';
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
    expect(runs[0].messages.map((message) => message.replace(' [Show details](command:devEnvironments.showLog)', ''))).toEqual([
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

  it('ends the busy state also when the notification cannot be shown', async () => {
    fakeVscode.window.withProgress.mockRejectedValue(new Error('no window'));
    await expect(runWithProgress({ title: 'x', task: async () => 1 })).rejects.toThrow('no window');
    expect(currentOperation()).toBeUndefined();
  });
});
