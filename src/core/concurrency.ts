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

/** Kinds of the requests of a RequestLimiter: a page of a list, a batch of lookups, or another request. */
export type RequestKind = 'list' | 'lookup' | 'other';

/**
 * Runs at most `limit` functions at the same time, whatever their kind. While a list is open (`openList`), lookups leave
 * one slot free, so the next page of a list does not wait for a slow lookup; list pages and other requests go before
 * waiting lookups. More open lists share that slot with the other free slots: the lookups are the larger part of the
 * work, so they keep the rest. Each kind waits in the order of its calls.
 */
export class RequestLimiter {
  private active = 0;
  private activeLookups = 0;
  private openLists = 0;
  private readonly waiting: Array<{ lookup: boolean; start: () => void }> = [];
  /** The most functions that ran at the same time. */
  peak = 0;

  constructor(private readonly limit: number) {}

  /** A list starts loading its pages one after another. Call the returned function when its last page arrived. */
  openList(): () => void {
    this.openLists++;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.openLists--;
      this.pump();
    };
  }

  /** True if a lookup started now would run at once: a slot for lookups is free, and no lookup waits. */
  lookupIdle(): boolean {
    return this.active < this.max() && this.activeLookups < this.lookupLimit() && !this.waiting.some((entry) => entry.lookup);
  }

  async run<T>(fn: () => Promise<T>, kind: RequestKind): Promise<T> {
    const lookup = kind === 'lookup';
    await new Promise<void>((resolve) => {
      this.waiting.push({ lookup, start: resolve });
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      if (lookup) this.activeLookups--;
      this.pump();
    }
  }

  private max(): number {
    return Math.max(1, this.limit);
  }

  private lookupLimit(): number {
    return this.openLists > 0 ? Math.max(1, this.max() - 1) : this.max();
  }

  /** Starts waiting functions while slots are free: first list pages and other requests, then lookups. */
  private pump(): void {
    while (this.active < this.max()) {
      let index = this.waiting.findIndex((entry) => !entry.lookup);
      if (index < 0 && this.activeLookups < this.lookupLimit()) index = this.waiting.findIndex((entry) => entry.lookup);
      if (index < 0) return;
      const [entry] = this.waiting.splice(index, 1);
      this.active++;
      if (entry.lookup) this.activeLookups++;
      this.peak = Math.max(this.peak, this.active);
      entry.start();
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
