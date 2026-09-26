// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Runs the preview jobs of the repository groups editor in a worker thread (groupsPreviewWorker.ts) with a time limit:
// a regular expression with a nested repetition can take seconds for one name, and the extension host must not wait
// for it. After the limit, the worker is stopped (Worker.terminate stops even a running regular expression) and the
// next job starts a new one. No `vscode` import.
import { Worker } from 'worker_threads';
import type { PreviewJob, PreviewJobMessage, PreviewRun } from './repositoryGroupsEditorModel';

/** Time limit of one preview job. */
export const PREVIEW_TIME_LIMIT_MS = 1000;

export interface PreviewRunner {
  /** Runs one job after the jobs before it; never rejects. */
  run(job: Omit<PreviewJob, 'id'>): Promise<PreviewRun>;
  dispose(): void;
}

export class PreviewWorkerRunner implements PreviewRunner {
  private worker: Worker | undefined;
  private nextId = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly scriptPath: string,
    private readonly timeLimitMs = PREVIEW_TIME_LIMIT_MS,
  ) {}

  run(job: Omit<PreviewJob, 'id'>): Promise<PreviewRun> {
    const result = this.chain.then(() => this.runNow(job));
    this.chain = result.catch(() => undefined);
    return result;
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }

  private runNow(job: Omit<PreviewJob, 'id'>): Promise<PreviewRun> {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = this.worker ?? new Worker(this.scriptPath);
      } catch {
        resolve({ failed: true });
        return;
      }
      this.worker = worker;
      const id = ++this.nextId;
      const run: PreviewRun = {};
      let phase: 'preview' | 'test' = 'preview';
      let slowEntry: number | undefined;
      let done = false;
      const finish = (result: PreviewRun) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        resolve(result);
      };
      const stop = () => {
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate();
      };
      const onMessage = (message: PreviewJobMessage) => {
        if (message.id !== id) return;
        if (message.type === 'probe') {
          slowEntry = message.entryIndex;
        } else if (message.type === 'preview') {
          run.preview = message.preview;
          phase = 'test';
        } else {
          if (message.test) run.test = message.test;
          finish(run);
        }
      };
      const onError = () => {
        stop();
        finish({ ...run, failed: true });
      };
      const onExit = () => {
        if (this.worker === worker) this.worker = undefined;
        finish({ ...run, failed: true });
      };
      const timer = setTimeout(() => {
        stop();
        finish(
          phase === 'preview'
            ? { previewTooSlow: true, ...(slowEntry !== undefined ? { slowEntry } : {}) }
            : { ...run, testTooSlow: true },
        );
      }, this.timeLimitMs);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ ...job, id });
    });
  }
}
