// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of plan step 11D1 (mutation probes): the operations monitorSettings and recordGitState (plan step
// 11E6, decision D1 of 2026-10-05: the image settings and list come with the open, giveMonitorImages).
import { describe, expect, it } from 'vitest';
import { LOCK_UNAVAILABLE_CODE, OP_RECORD_GIT_STATE, type AskKind } from '../core/helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { type DockerEngine, type EngineContainer, type EngineExecOptions } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { FLOW_REQUESTS, type HostSide } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { OwnHelper } from '../core/worker/ownHelper';
import { contextLogger, giveMonitorImages, recordGitStateOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devenv-acme-api-brave-noether';
const OWN: OwnHelper = { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const ENVIRONMENT = {
  id: ID,
  repository: 'acme/api',
  owner: { id: '42', login: 'octo' },
  volumeName: NAME,
  containerName: NAME,
  configPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: '2026-10-01T00:00:00.000Z',
  remoteUser: 'node',
} as unknown as Environment;
const SETTINGS = { prefixes: ['ghcr.io/acme/base'], schedule: '7 6 * * *', timeZone: 'UTC' };
const PARAMS = { environmentId: ID, dockerHost: '', owner: { windowId: 'window-1', pid: 4242 } };
type Exec = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };

function contextOf(ask: OperationContext['ask'] = async () => undefined, secrets: Record<string, string> = {}) {
  const controller = new AbortController();
  const lines: { text: string; level?: string }[] = [];
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets(secrets, ask),
    progress: () => {},
    log: (text, level) => lines.push({ text, level }),
    output: () => {},
  };
  return { context, controller, lines };
}

function engineOf(exec: (options?: EngineExecOptions) => Promise<Exec>, containers: EngineContainer[] = []) {
  const execs: { container: string; options?: EngineExecOptions }[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async () => ({ apiVersion: '1.48', version: '29.0.0' }),
    containers: async () => containers,
    container: async (reference) => containers.find((c) => c.name === reference || c.id === reference),
    exec: async (container, _command, options) => (execs.push({ container, options }), exec(options)),
  };
  return { engine, execs };
}

const ok = async (): Promise<Exec> => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
const aborted = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));

function recordGitState(setup: { secrets?: Record<string, string>; ownHelperOf?: (controller: AbortController) => Promise<OwnHelper>; exec?: (controller: AbortController) => Promise<Exec> } = {}) {
  const asks: { kind: AskKind; call: string }[] = [];
  const answer = (kind: AskKind, call: string) => async () => (asks.push({ kind, call }), call === 'get' ? ENVIRONMENT : undefined);
  const host = { records: { get: answer('record', 'get'), recordGitSummary: answer('record', 'recordGitSummary') }, questions: {}, state: {}, secrets: {} } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_RECORD_GIT_STATE], { environmentId: ID });
  const { context, controller } = contextOf(async (kind, payload) => (await handler(kind, payload, new AbortController().signal)).value, setup.secrets);
  const containers: EngineContainer[] = [{ id: 'c'.repeat(64), name: NAME, state: 'running', rawState: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ID }, image: `${NAME}:1` }];
  const { engine, execs } = engineOf(setup.exec ? () => setup.exec!(controller) : async () => ({ exitCode: 0, stdout: 'main\n2\n1\n0\n', stderr: '', timedOut: false }), containers);
  const operation = recordGitStateOperation(
    () => engine,
    setup.ownHelperOf ? () => setup.ownHelperOf!(controller) : async () => OWN,
    async () => {
      throw new Error('The Git state of a release opens no batch helper.');
    },
  );
  return { result: operation(PARAMS, context), asks, execs, controller };
}

describe('the monitor operations (review B-R1 probes, plan step 11D1)', () => {
  // Plan step 11E6 (decision D1 of 2026-10-05): changed, `monitorSettings` is removed (FO7, a secret, is the open's check
  // now: openOperation refuses one); the open gives the settings and the list after its ensure (giveMonitorImages).
  it('the images of an open: the signal is passed on; a cancel ends them (FO9, FO10)', async () => {
    const { engine, execs } = engineOf(ok);
    const { context } = contextOf();
    await giveMonitorImages(engine, { images: SETTINGS }, contextLogger(context), context.signal);
    expect(execs[0].options?.signal).toBe(context.signal);
    const aborting = contextOf();
    const hanging = engineOf(() => (aborting.controller.abort(), aborted()));
    await expect(giveMonitorImages(hanging.engine, { images: SETTINGS }, contextLogger(aborting.context), aborting.context.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('the images of an open: a failure of the settings is logged as a warning that names them (FO8, FO12)', async () => {
    const failing = engineOf(async () => ({ exitCode: 2, stdout: '', stderr: 'Invalid settings.', timedOut: false }));
    const { context, lines } = contextOf();
    expect(await giveMonitorImages(failing.engine, { images: SETTINGS }, contextLogger(context), context.signal)).toBe(false);
    expect(lines).toEqual([{ text: 'The image settings could not be given to the Session Monitor: Invalid settings.', level: 'warn' }]);
  });

  it('recordGitState: refuses a secret before anything runs (FO15)', async () => {
    const { result, asks, execs } = recordGitState({ secrets: { token: 'gho_x' } });
    await expect(result).rejects.toMatchObject({ code: 'invalid' });
    expect(asks).toEqual([]);
    expect(execs).toEqual([]);
  });

  it('recordGitState: a cancel during the read records nothing and is cancelled (FO16, FO17)', async () => {
    const { result, asks } = recordGitState({
      exec: async (controller) => (controller.abort(), { exitCode: 0, stdout: 'main\n2\n1\n0\n', stderr: '', timedOut: false }),
    });
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(asks.map((ask) => ask.call)).not.toContain('recordGitSummary');
  });

  it('recordGitState: the helper image that cannot be read is lockUnavailable, or cancelled after a cancel (FO19, FO20)', async () => {
    const failing = recordGitState({
      ownHelperOf: async () => {
        throw new Error('no image');
      },
    });
    await expect(failing.result).rejects.toMatchObject({ code: LOCK_UNAVAILABLE_CODE });
    const cancelled = recordGitState({
      ownHelperOf: async (controller) => {
        controller.abort();
        throw new Error('aborted');
      },
    });
    await expect(cancelled.result).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancelled.execs).toEqual([]);
  });
});
