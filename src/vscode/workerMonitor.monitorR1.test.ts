// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of plan step 11D1 (mutation probes): workerMonitor.
import { describe, expect, it } from 'vitest';
import type { DockerTarget } from '../core/docker/dockerHost';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { MONITOR_EXEC_TIMEOUT_MS } from '../core/worker/monitorFlow';
import { MONITOR_FLOW_TIMEOUT_MS, workerMonitor, type TargetFlow } from './workerMonitor';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const TARGET = { kind: 'remote', host: 'ssh://box', endpoint: 'ssh://box', context: 'box' } as DockerTarget;
const LOCAL = { kind: 'local', host: '' } as DockerTarget;
const ENVIRONMENT = { id: ID, repository: 'acme/api', containerName: 'devenv-acme-api-brave-noether' } as Environment;

function monitorWith(answer: () => unknown) {
  const calls: Parameters<TargetFlow>[] = [];
  const lines: string[] = [];
  const flow: TargetFlow = async (...args) => {
    calls.push(args);
    const value = answer();
    if (value instanceof Error) throw value;
    return value;
  };
  const logger = { ...silentLogger, warn: (text: string) => lines.push(`warn ${text}`), info: (text: string) => lines.push(`info ${text}`) };
  return { monitor: workerMonitor({ flow, owner: () => ({ windowId: 'window-1', pid: 7 }), logger }), calls, lines };
}

describe('workerMonitor (review B-R1 probes, plan step 11D1)', () => {
  it('the time limit of a flow covers the command in the worker (WM1)', () => {
    expect(MONITOR_FLOW_TIMEOUT_MS).toBeGreaterThan(MONITOR_EXEC_TIMEOUT_MS);
  });

  it('the image settings: an answer that does not fit is false and logged with what was sent (WM5, WM6)', async () => {
    const { monitor, lines } = monitorWith(() => ({ sent: 'yes' }));
    expect(await monitor.monitorSettings(TARGET, { settings: { prefixes: ['ghcr.io/acme/base'], schedule: '7 6 * * *', timeZone: 'UTC' } })).toBe(false);
    expect(lines).toEqual(['warn The image settings could not be given to the Session Monitor: the worker answered with an invalid value']);
  });

  it('containerExists: the time limit and the signal; parameters beyond the checks send nothing; the local Docker is named (WM10, WM11, WM12, WM17)', async () => {
    const signal = new AbortController().signal;
    const { monitor, calls } = monitorWith(() => ({ state: 'running' }));
    await monitor.containerExists(TARGET, ENVIRONMENT, signal);
    expect(calls[0][2]).toEqual({ target: TARGET, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, signal });
    const odd = monitorWith(() => ({ state: 'running' }));
    expect(await odd.monitor.containerExists(TARGET, { ...ENVIRONMENT, containerName: 'bad name/x' } as Environment)).toBe(false);
    expect(odd.calls).toEqual([]);
    expect(odd.lines).toEqual(['info The container of acme/api could not be checked on ssh://box: its parameters are beyond the checks of the worker']);
    const local = monitorWith(() => new Error('no worker'));
    expect(await local.monitor.containerExists(LOCAL, ENVIRONMENT)).toBe(false);
    expect(local.lines).toEqual(['info The container of acme/api could not be checked on the local Docker: no worker']);
  });

  it('recordGitState: the time limit and the signal (WM15, WM16)', async () => {
    const signal = new AbortController().signal;
    const { monitor, calls } = monitorWith(() => ({ recorded: false }));
    expect(await monitor.recordGitState(TARGET, ENVIRONMENT, signal)).toBe(false);
    expect(calls[0][2]).toEqual({ target: TARGET, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, signal });
  });
});
