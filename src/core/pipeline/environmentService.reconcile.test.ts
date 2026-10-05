// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C3 (decisions of 2026-10-03 and 2026-10-04): reconcileInWorker, the rebuild of the registry from the volumes
// by the worker of the Docker host of the operation (`reconcile`).
import type { EnvironmentOperationsDeps } from './environmentOperations';
import type { OperationFlow } from './environmentOperations';
import { describe, expect, it } from 'vitest';
import { OP_RECONCILE } from '../helperChannel/protocol';
import { RECONCILE_FLOW_TIMEOUT_MS, type EnvironmentServiceDeps } from './environmentService';
import { createHarness } from './environmentService.testkit';

type Flow = OperationFlow;

function harness(answer: unknown, overrides: Partial<EnvironmentServiceDeps & EnvironmentOperationsDeps> = {}) {
  const calls: Parameters<Flow>[] = [];
  const h = createHarness({ flow: async (...args) => (calls.push(args), answer), ...overrides });
  return { h, calls };
}

describe('reconcileInWorker (plan step 11C3)', () => {
  it('sends `reconcile` with the Docker host and the window of the operation, and answers the number of added entries', async () => {
    const { h, calls } = harness({ added: 2 });
    expect(await h.operations.reconcileInWorker({ passive: false })).toBe(2);
    expect(calls).toEqual([[OP_RECONCILE, { dockerHost: '', owner: expect.objectContaining({ windowId: expect.any(String) }) }, { timeoutMs: RECONCILE_FLOW_TIMEOUT_MS }]]);
  });

  it('in the background, the worker is made ready passively; a signal goes with the flow', async () => {
    const { h, calls } = harness({ added: 0 });
    const signal = new AbortController().signal;
    await h.operations.reconcileInWorker({ passive: true, signal });
    expect(calls[0][2]).toEqual({ timeoutMs: RECONCILE_FLOW_TIMEOUT_MS, passive: true, signal });
  });

  it('on a remote Docker host, it names that host', async () => {
    const { h, calls } = harness({ added: 1 }, { dockerTarget: async () => ({ kind: 'remote', host: 'ssh://box', endpoint: 'ssh://box' }) });
    await h.operations.reconcileInWorker({ passive: true });
    expect(calls[0][1]).toMatchObject({ dockerHost: 'ssh://box' });
  });

  it('never on an endpoint that is neither local nor SSH, and not while Docker does not run (Docker is not started)', async () => {
    const unsupported = harness({ added: 1 }, { dockerTarget: async () => ({ kind: 'unsupported', host: 'tcp://x:2375', endpoint: 'tcp://x:2375' }) });
    expect(await unsupported.h.operations.reconcileInWorker({ passive: false })).toBe(0);
    expect(unsupported.calls).toEqual([]);
    const stopped = harness({ added: 1 });
    stopped.h.docker.running = false;
    expect(await stopped.h.operations.reconcileInWorker({ passive: false })).toBe(0);
    expect(stopped.calls).toEqual([]);
    expect(stopped.h.dockerStarts).toBe(0);
  });

  it('an answer that is not a number of entries, and a failed flow, are failures', async () => {
    for (const odd of [{ added: -1 }, { added: 1.5 }, { added: 1001 }, { added: 1, more: true }, null, 'two']) {
      await expect(harness(odd).h.operations.reconcileInWorker({ passive: true }), JSON.stringify(odd)).rejects.toThrow('invalid value');
    }
    const failing = createHarness({
      flow: async () => {
        throw new Error('the worker could not be reached');
      },
    });
    await expect(failing.operations.reconcileInWorker({ passive: true })).rejects.toThrow('the worker could not be reached');
  });
});
