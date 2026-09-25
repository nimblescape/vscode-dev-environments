// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Small concurrency helpers of the controller. No `vscode` import, so they are unit-tested.

/**
 * Runs an async function at most once at a time.
 * - `join()` returns the running execution, or starts one ("reuse the running refresh").
 * - `request()` makes sure that an execution starts after this call: when one is running, one more runs after it.
 *   Several requests during one execution share that one extra execution ("the latest state is rendered once").
 */
export class CoalescingTask<T> {
  private running: Promise<T> | undefined;
  private queued: Promise<T> | undefined;

  constructor(private readonly fn: () => Promise<T>) {}

  /** True while an execution runs. */
  get busy(): boolean {
    return this.running !== undefined;
  }

  join(): Promise<T> {
    return this.queued ?? this.running ?? this.start();
  }

  request(): Promise<T> {
    if (this.queued) return this.queued;
    const running = this.running;
    if (!running) return this.start();
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    const queued = settled.then(() => {
      if (this.queued === queued) this.queued = undefined;
      return this.start();
    });
    this.queued = queued;
    return queued;
  }

  private start(): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = this.fn();
    } catch (error) {
      promise = Promise.reject(error);
    }
    const running = promise.finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }
}

/**
 * At most one operation per key (per environment, keyed by repository) at a time in this window. A second request for a
 * running key is not started.
 */
export class OperationGate {
  private readonly running = new Map<string, string>();

  /** Label of the operation that runs for `key`, if any. */
  runningFor(key: string): string | undefined {
    return this.running.get(normalizeKey(key));
  }

  /** Keys with a running operation. */
  keys(): string[] {
    return [...this.running.keys()];
  }

  /**
   * Runs `fn` when no operation runs for `key`; resolves with `{ started: true, value }`. Otherwise resolves with
   * `{ started: false, running }` (the label of the running operation) and does not call `fn`. Rejects when `fn` rejects.
   */
  async run<T>(
    key: string,
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ started: true; value: T } | { started: false; running: string }> {
    const normalized = normalizeKey(key);
    const running = this.running.get(normalized);
    if (running !== undefined) return { started: false, running };
    this.running.set(normalized, label);
    try {
      return { started: true, value: await fn() };
    } finally {
      this.running.delete(normalized);
    }
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/** Allows an action at most once per interval (for example a refresh on window focus). */
export class Throttle {
  private last: number | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True, and remembers the time, if the last allowed call was at least `intervalMs` ago (or never). */
  tryAcquire(): boolean {
    const now = this.now();
    if (this.last !== undefined && now - this.last < this.intervalMs && now >= this.last) return false;
    this.last = now;
    return true;
  }
}

/** Runs `fn` for each item with at most `limit` calls at the same time. Keeps the order of the results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
