// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G3, review B (mutation testing), on the start of the batch helper (workerBatchSession, as the `batch`
// operation starts it): an inspect of the volume that fails (not a 404) starts nothing (a create with a volume that may
// be missing would make an empty one without our labels), and the started helper's output is registered with the
// server's pause (OperationContext.pausable) and removed from it when the helper ends.
import { describe, expect, it } from 'vitest';
import { EngineError, type DockerEngine, type EngineAttachedRun } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { workerBatchSession, type BatchDeps } from './batch';
import { contextSecrets } from './operationContext.testkit';
import { OperationError, type OperationContext, type Pausable } from './server';

const VOLUME = 'devenv-vol-1';
const P = { volume: VOLUME, image: `sha256:${'a'.repeat(64)}`, socket: '/var/run/docker.sock' };

function contextOf(pausable?: OperationContext['pausable']): OperationContext {
  return {
    signal: new AbortController().signal,
    ...contextSecrets(),
    progress: () => {},
    log: () => {},
    output: () => {},
    ...(pausable === undefined ? {} : { pausable }),
  };
}

describe('the start of the batch helper (plan step 11G3, review B)', () => {
  it('an inspect of the volume that fails (not a 404) fails the start and starts nothing', async () => {
    const calls: string[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async () => {
        calls.push('inspect');
        throw new EngineError('the engine failed', 500);
      },
      runAttached: async () => {
        calls.push('run');
        throw new EngineError('not to be started', 500);
      },
      containerIds: async () => (calls.push('ps'), []),
    };
    const deps: BatchDeps = { engineOf: () => engine, readScript: () => 'the script' };
    const failure = await workerBatchSession(deps, contextOf(), P).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationError);
    expect(failure).toMatchObject({ code: 'failed' });
    expect((failure as Error).message).toContain('could not be inspected');
    expect(calls).toEqual(['inspect']);
  });

  it('registers the output of the started helper with the pause of the server, and removes it when the helper ends', async () => {
    const events: string[] = [];
    let resolveExit!: (value: { exitCode: number | null }) => void;
    const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
    const run: EngineAttachedRun = {
      id: 'c'.repeat(64),
      // A helper that never answers: the open of its channel fails, and it is killed.
      process: { write: () => true, end: () => {}, kill: () => resolveExit({ exitCode: null }), onStdout: () => {}, onStderr: () => {}, exited },
      pause: () => events.push('pause'),
      resume: () => events.push('resume'),
    };
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async () => ({ Name: VOLUME }),
      runAttached: async () => run,
      containerIds: async () => [],
    };
    const registered: Pausable[] = [];
    const pausable = (target: Pausable) => {
      registered.push(target);
      return () => events.push('removed');
    };
    const deps: BatchDeps = { engineOf: () => engine, readScript: () => 'the script', openTimeoutMs: 20 };
    const failure = await workerBatchSession(deps, contextOf(pausable), P).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationError);
    expect(registered).toEqual([run]);
    expect(events).toEqual(['removed']);
  });
});
