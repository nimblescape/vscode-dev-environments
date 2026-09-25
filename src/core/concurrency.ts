// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Limits of parallel work, for example of requests to GitHub. No `vscode` import.

/** Runs at most `limit` functions at the same time; the others wait in the order of their calls. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** A `priority` call waits before the others (for example the next page of a list before more lookups). */
  async run<T>(fn: () => Promise<T>, priority = false): Promise<T> {
    if (this.active >= Math.max(1, this.limit)) {
      await new Promise<void>((resolve) => (priority ? this.waiting.unshift(resolve) : this.waiting.push(resolve)));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      // The slot goes directly to the next waiting call, so a new call cannot take it in between.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * Runs `fn` for every item at the same time (a Semaphore limits the real work) and resolves with the results in the order
 * of the items. The first failure aborts the signal that the other calls get, and the call rejects with that failure.
 * An abort of `signal` reaches every call.
 */
export async function allOrAbort<T, R>(
  items: readonly T[],
  fn: (item: T, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.all(
      items.map((item) =>
        fn(item, controller.signal).catch((error: unknown) => {
          controller.abort();
          throw error;
        }),
      ),
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
