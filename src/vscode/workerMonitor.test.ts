// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D1: the calls of this window to the Session Monitor of an engine, as operations of the worker of that
// engine (workerMonitor), and the flow with its own target (extensionFlow).
import { describe, expect, it, vi } from 'vitest';
import type { DockerTarget } from '../core/docker/dockerHost';
import type { OperationOptions } from '../core/helperChannel/helperChannel';
import { OP_HEARTBEAT, OP_MONITOR_ENSURE, OP_RECORD_GIT_STATE, OP_WINDOW_STATE } from '../core/helperChannel/protocol';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';
import { MONITOR_ENSURE_FLOW_TIMEOUT_MS, MONITOR_FLOW_TIMEOUT_MS } from '../core/pipeline/operationBase';
import { workerMonitor, type TargetFlow } from './workerMonitor';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const TARGET = { kind: 'remote', host: 'ssh://box', endpoint: 'ssh://box', context: 'box' } as DockerTarget;
const ENVIRONMENT = { id: ID, repository: 'acme/api', containerName: 'devenv-acme-api-brave-noether' } as Environment;
const HEARTBEAT = { source: '0123456789abcdef0123456789abcdef', limitSeconds: 600, environments: [] };

function monitorWith(answer: (op: string) => unknown) {
  const calls: Parameters<TargetFlow>[] = [];
  const lines: string[] = [];
  const flow: TargetFlow = async (...args) => {
    calls.push(args);
    const value = answer(args[0]);
    if (value instanceof Error) throw value;
    return value;
  };
  const logger = { ...silentLogger, warn: (text: string) => lines.push(`warn ${text}`), info: (text: string) => lines.push(`info ${text}`) };
  return { monitor: workerMonitor({ flow, owner: () => ({ windowId: 'window-1', pid: 7 }), logger }), calls, lines };
}

describe('the calls of a window to the Session Monitor, as operations of the worker (plan step 11D1)', () => {
  it('a heartbeat goes to the worker of its engine, with the signal; its answer is checked', async () => {
    const signal = new AbortController().signal;
    const { monitor, calls } = monitorWith(() => ({ ok: false, missing: true, detail: 'gone' }));
    expect(await monitor.heartbeat(TARGET, HEARTBEAT, signal)).toEqual({ ok: false, missing: true, detail: 'gone' });
    expect(calls).toEqual([[OP_HEARTBEAT, { heartbeat: HEARTBEAT }, { target: TARGET, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, signal }]]);
    // An answer that does not fit, and a worker that cannot be reached, are failures (never `missing`, so no repair).
    expect(await monitorWith(() => ({ ok: 'yes' })).monitor.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: false, missing: false, detail: 'the worker answered the heartbeat with an invalid value' });
    expect(await monitorWith(() => new Error('the worker could not be reached')).monitor.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: false, missing: false, detail: 'the worker could not be reached' });
  });

  it('the container of an environment exists unless the worker reads it as missing; a failure counts as not there', async () => {
    for (const [state, exists] of [['running', true], ['stopped', true], ['missing', false]] as const) {
      const { monitor, calls } = monitorWith(() => ({ state }));
      expect(await monitor.containerExists(TARGET, ENVIRONMENT), state).toBe(exists);
      expect(calls[0].slice(0, 2)).toEqual([OP_WINDOW_STATE, { environmentId: ID, containerName: ENVIRONMENT.containerName, checks: 'off' }]);
      expect(calls[0][2].target).toBe(TARGET);
    }
    const failing = monitorWith(() => new Error('no worker'));
    expect(await failing.monitor.containerExists(TARGET, ENVIRONMENT)).toBe(false);
    expect(failing.lines).toEqual(['info The container of acme/api could not be checked on ssh://box: no worker']);
    expect(await monitorWith(() => ({ state: 'gone' })).monitor.containerExists(TARGET, ENVIRONMENT)).toBe(false);
  });

  it('the Git state of a release: the environment, the host of its engine and this window; an answer that does not fit throws', async () => {
    const { monitor, calls } = monitorWith(() => ({ recorded: true }));
    expect(await monitor.recordGitState(TARGET, ENVIRONMENT)).toBe(true);
    expect(calls[0].slice(0, 2)).toEqual([OP_RECORD_GIT_STATE, { environmentId: ID, dockerHost: 'ssh://box', owner: { windowId: 'window-1', pid: 7 } }]);
    await expect(monitorWith(() => ({ recorded: 'yes' })).monitor.recordGitState(TARGET, ENVIRONMENT)).rejects.toThrow('invalid value');
    // A window whose ID is not known yet sends nothing.
    const early = workerMonitor({ flow: vi.fn(), owner: () => ({ windowId: '', pid: 7 }), logger: silentLogger });
    await expect(early.recordGitState(TARGET, ENVIRONMENT)).rejects.toThrow('cannot be sent');
  });

  it('extensionFlow: a flow with its own target goes to that engine, with the requests of its operation for its environment', async () => {
    const recorded: unknown[][] = [];
    const registry = { updateEnvironment: async (id: string) => void recorded.push([id]) };
    const deps = { registry, sessionFiles: {}, ui: {}, auth: {}, credentials: {}, settings: () => ({}), windowId: 'w1', pid: 1, clock: { now: () => 0 }, isProcessAlive: () => true, logger: silentLogger } as unknown as HostSideDeps;
    const sent: { target: unknown; options: OperationOptions }[] = [];
    const channels = { flow: vi.fn(async (target: unknown, _op: string, _p: unknown, options: OperationOptions = {}) => (sent.push({ target, options }), { recorded: true })) };
    const current = vi.fn(async () => ({ kind: 'local' }) as DockerTarget);
    const flow = extensionFlow(channels as never, current, extensionHostSide(deps), silentLogger);
    await flow(OP_RECORD_GIT_STATE, { environmentId: ID, dockerHost: 'ssh://box', owner: { windowId: 'w1', pid: 1 } }, { target: TARGET });
    expect(sent[0].target).toBe(TARGET);
    expect(current).not.toHaveBeenCalled();
    const onAsk = sent[0].options.onAsk!;
    const signal = new AbortController().signal;
    const summary = { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T12:00:00.000Z' };
    await onAsk('record', { call: 'recordGitSummary', args: [ID, summary] }, signal);
    expect(recorded).toEqual([[ID]]);
    // Another environment, and a request that the operation may not send, are refused.
    await expect(onAsk('record', { call: 'recordGitSummary', args: ['6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', summary] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    await expect(onAsk('record', { call: 'remove', args: [ID, {}] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    // Without a target: the current engine.
    await flow(OP_HEARTBEAT, { heartbeat: HEARTBEAT }, {});
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('plan step 11D2: the ensure of the monitor goes to the worker of its engine with the image maintenance; a failure rejects', async () => {
    const images = { prefixes: ['ghcr.io/acme/base'], schedule: '7 6 * * *', timeZone: 'UTC' };
    const signal = new AbortController().signal;
    const { monitor, calls } = monitorWith(() => ({ outcome: 'created' }));
    await expect(monitor.monitorEnsure(TARGET, images, signal)).resolves.toBeUndefined();
    expect(calls).toEqual([[OP_MONITOR_ENSURE, { images }, { target: TARGET, timeoutMs: MONITOR_ENSURE_FLOW_TIMEOUT_MS, signal }]]);
    expect(MONITOR_ENSURE_FLOW_TIMEOUT_MS).toBeGreaterThan(60_000 + 25_500);
    await expect(monitorWith(() => new Error('docker run failed: No such image')).monitor.monitorEnsure(TARGET, images)).rejects.toThrow('docker run failed: No such image');
    await expect(monitorWith(() => ({ outcome: 'failed' })).monitor.monitorEnsure(TARGET, images)).rejects.toThrow('invalid value');
    const invalid = monitorWith(() => ({ outcome: 'created' }));
    await expect(invalid.monitor.monitorEnsure(TARGET, { ...images, schedule: 'daily' })).rejects.toThrow('cannot be sent');
    expect(invalid.calls).toEqual([]);
  });
});
