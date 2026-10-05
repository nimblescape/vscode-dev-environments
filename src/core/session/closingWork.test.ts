// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #87 (B-R1-7 (a)): VS Code disposes context.subscriptions synchronously right after deactivate();
// the worker channels with their router, the preparation of the heartbeats, and the logger wait for the release.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ClosingWork } from './closingWork';
import { HeartbeatPreparation } from './heartbeatPreparation';

/** context.subscriptions and the way VS Code ends a window: deactivate(), then every disposable at once. */
function extensionHost() {
  const subscriptions: Array<{ dispose(): void }> = [];
  return {
    subscriptions,
    close(deactivate: () => Promise<void> | undefined): Promise<void> | undefined {
      const result = deactivate();
      for (const disposable of subscriptions) disposable.dispose();
      return result;
    },
  };
}

function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ClosingWork (review round 1 of PR #87, B-R1-7 (a))', () => {
  it('disposes the channels, the preparation and the logger only after the closing work settled; deactivate returns its promise', async () => {
    const closing = new ClosingWork();
    const host = extensionHost();
    const disposed: string[] = [];
    host.subscriptions.push(closing.deferred({ dispose: () => disposed.push('logger') }));
    const preparation = new HeartbeatPreparation();
    // heartbeatWiring pushes the preparation into the subscriptions it gets.
    closing.deferredSubscriptions(host.subscriptions).push({
      dispose: () => {
        preparation.dispose();
        disposed.push('preparation');
      },
    });
    host.subscriptions.push(closing.deferred({ dispose: () => disposed.push('channels and router') }));
    // Not deferred (for example the heartbeats): disposed at once.
    host.subscriptions.push({ dispose: () => disposed.push('heartbeats') });
    const release = deferred();
    let returned: Promise<void> | undefined;
    const result = host.close(() => (returned = closing.begin(() => release.promise)));
    expect(result).toBe(returned);
    expect(result).toBe(closing.promise);
    await flush();
    expect(disposed).toEqual(['heartbeats']);
    release.resolve();
    await result;
    await flush();
    expect(disposed).toEqual(['heartbeats', 'logger', 'preparation', 'channels and router']);
  });

  it('also after a closing work that rejects (it never rejects itself), and at once without closing work', async () => {
    const closing = new ClosingWork();
    const disposed: string[] = [];
    const release = deferred();
    const result = closing.begin(() => release.promise);
    closing.deferred({ dispose: () => disposed.push('channels') }).dispose();
    release.reject(new Error('engine gone'));
    await expect(result).resolves.toBeUndefined();
    await flush();
    expect(disposed).toEqual(['channels']);

    const none = new ClosingWork();
    expect(none.begin(() => undefined)).toBeUndefined();
    none.deferred({ dispose: () => disposed.push('at once') }).dispose();
    expect(disposed).toEqual(['channels', 'at once']);
    const before = new ClosingWork();
    before.deferred({ dispose: () => disposed.push('before deactivate') }).dispose();
    expect(disposed).toContain('before deactivate');
  });

  it('a deactivate that throws counts as no work; a second begin returns the first promise; each target is disposed once', async () => {
    const closing = new ClosingWork();
    expect(
      closing.begin(() => {
        throw new Error('sync failure');
      }),
    ).toBeUndefined();
    const other = new ClosingWork();
    const first = other.begin(() => Promise.resolve());
    expect(other.begin(() => Promise.reject(new Error('second')))).toBe(first);
    let count = 0;
    const disposable = other.deferred({
      dispose: () => {
        count += 1;
        throw new Error('dispose failed');
      },
    });
    disposable.dispose();
    disposable.dispose();
    await first;
    await flush();
    expect(count).toBe(1);
  });

  it('extension.ts wires the channels, the preparation and the logger through it, and deactivate returns its promise', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'vscode', 'extension.ts'), 'utf8');
    expect(source).toContain('context.subscriptions.push(closingWork.deferred(logger));');
    expect(source).toContain('subscriptions: closingWork.deferredSubscriptions(context.subscriptions),');
    // Plan step 11F2: changed expectation (before: docker.setRouter(undefined) and docker.setWorkerEngine(undefined) first):
    // the extension's Docker has no router and no worker engine any more, so the channels alone are disposed after it.
    expect(source).toMatch(/closingWork\.deferred\(\{\s*dispose: \(\) => \{\s*channels\.dispose\(\);/);
    expect(source).not.toMatch(/setRouter|setWorkerEngine/);
    expect(source).toContain('return closingWork.begin(() => coordinator?.deactivate());');
    expect(source).not.toContain('context.subscriptions.push(logger);');
  });
});
