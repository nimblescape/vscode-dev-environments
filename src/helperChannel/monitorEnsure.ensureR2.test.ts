// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #100 (B, mutation probes): the log driver of the spec reaches the create of the monitor
// container, and the operation `monitorEnsure` of the worker gets the script of this bundle.
import { describe, expect, it, vi } from 'vitest';
import type { MonitorRunSpec } from '../core/remoteMonitor/monitorEngine';
import type { EngineApi, EngineRequest } from './engineApi';
import { dockerEngine, type EngineHijack } from './engineClient';
import stubScript from './monitorScript.stub';

const captured = vi.hoisted(() => ({ script: undefined as (() => string) | undefined }));
vi.mock('./flowOperations', async (original) => {
  const actual = await original<typeof import('./flowOperations')>();
  return {
    ...actual,
    monitorEnsureOperation: (...args: Parameters<typeof actual.monitorEnsureOperation>) => {
      captured.script = args[2];
      return actual.monitorEnsureOperation(...args);
    },
  };
});

const SPEC: MonitorRunSpec = {
  name: 'devenv-session-monitor',
  image: 'sha256:' + 'a'.repeat(64),
  labels: {},
  restartPolicy: 'on-failure',
  network: 'none',
  log: { driver: 'json-file', maxSize: '1m', maxFile: '2' },
  mounts: { socket: '/var/run/docker.sock', volume: 'devenv-session-monitor', volumeTarget: '/state' },
  env: {},
  command: ['node'],
};

describe('the monitor ensure, round 2 probes (review round 2 of PR #100)', () => {
  it('the create takes the log driver of the spec', async () => {
    const requests: EngineRequest[] = [];
    const api: EngineApi = async (request) => {
      requests.push(request);
      return { status: 500, body: JSON.stringify({ message: 'refused' }), truncated: false };
    };
    const hijack = (() => {
      throw new Error('no attach expected');
    }) as unknown as EngineHijack;
    const spec = { ...SPEC, log: { ...SPEC.log, driver: 'local' } } as unknown as MonitorRunSpec;
    expect(await dockerEngine(api, hijack).createAttached(spec, { input: 'x\n', readyText: 'ready', timeoutMs: 5_000 })).toMatchObject({ kind: 'exited' });
    expect(requests[0].json).toMatchObject({ HostConfig: { LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '2' } } } });
  });

  it('the operation gets the script of the bundle', async () => {
    await import('./operations');
    expect(captured.script?.()).toBe(stubScript);
  });
});
