// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #87 (B-R1-7 (a)): the close-time wiring of the extension. VS Code calls deactivate() and then, at
// once and synchronously, disposes context.subscriptions. The release of deactivate() (SessionCoordinator.deactivate:
// the Git record and the short release, bounded by CLOSE_RELEASE_BOUNDS) still needs the worker channels, the
// preparation of the heartbeats (HeartbeatPreparation: a worker that must be opened again), and the logger.
// So these are registered through `deferred`: their disposal waits until the closing work settled (it never rejects; it
// is bounded). Before deactivate() (or without closing work), they are disposed at once. No `vscode`.

export interface Disposable {
  dispose(): void;
}

export class ClosingWork {
  private work: Promise<void> | undefined;
  private begun = false;

  /** The work of deactivate(); undefined before it began or when there was none. */
  get promise(): Promise<void> | undefined {
    return this.work;
  }

  /**
   * deactivate(): runs `start` once and returns its promise (also to VS Code, which waits for it). Never throws; a
   * `start` that throws counts as no work. A second call returns the same promise.
   */
  begin(start: () => Promise<void> | undefined): Promise<void> | undefined {
    if (this.begun) return this.work;
    this.begun = true;
    try {
      const started = start();
      this.work = started?.then(
        () => undefined,
        () => undefined,
      );
    } catch {
      this.work = undefined;
    }
    return this.work;
  }

  /**
   * A disposable for context.subscriptions that disposes `target` only after the closing work settled (at once when
   * there is none). An error of `target.dispose()` is ignored.
   */
  deferred(target: Disposable): Disposable {
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      try {
        target.dispose();
      } catch {
        // The window closes; nothing to report to.
      }
    };
    return {
      dispose: () => {
        const work = this.work;
        if (work === undefined) dispose();
        else void work.then(dispose);
      },
    };
  }

  /** `subscriptions` whose entries are disposed only after the closing work (for heartbeatWiring and the like). */
  deferredSubscriptions(subscriptions: { push(disposable: Disposable): unknown }): { push(disposable: Disposable): unknown } {
    return { push: (disposable) => subscriptions.push(this.deferred(disposable)) };
  }
}
