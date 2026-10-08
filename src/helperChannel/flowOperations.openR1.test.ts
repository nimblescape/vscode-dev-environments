// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of PR #111 (mutation probes): the operation `open` passes the trust of the repository to its
// pipeline as the extension sent it (B1-76): the first open of an untrusted repository asks the confirmation of the user,
// and a refusal ends it as a cancel before anything is created.
import { describe, expect, it } from 'vitest';
import { OP_OPEN, type AskKind } from '../core/helperChannel/protocol';
import { silentLogger } from '../core/ports';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { FLOW_REQUESTS, type HostSide } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { OwnHelper } from '../core/worker/ownHelper';
import { openOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const OWN: OwnHelper = { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const PARAMS = {
  dockerHost: '',
  owner: { windowId: 'window-1', pid: 4242 },
  monitorSource: '0123456789abcdef0123456789abcdef',
  settings: { updateImagesOnConnect: true, hostAccessChecks: 'on' as const, waitingTimeSeconds: 12, stopOnClose: true, respectShutdownActionNone: false },
  images: { prefixes: [] as string[], schedule: '7 6 * * *', timeZone: 'UTC' },
  repository: 'acme/api',
  target: { configPaths: [], trusted: false },
};

function run() {
  const asks: string[] = [];
  const confirmations: string[] = [];
  const records = new Proxy({}, { get: () => async () => undefined }) as HostSide['records'];
  const host = {
    questions: { confirmUntrustedRepository: async (repository: string) => (confirmations.push(repository), false) },
    state: { account: async () => ({ id: '1001', login: 'octo' }) },
    records,
    secrets: { token: async () => 'gho_x' },
  } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_OPEN], { repository: 'acme/api', dockerHost: '' });
  const controller = new AbortController();
  const secrets = contextSecrets({}, async (kind: AskKind, payload) => {
    asks.push(`${kind} ${(payload as { call: string }).call}`);
    const answer = await handler(kind, payload, new AbortController().signal);
    // As the channel does: the secrets of an answer go to the operation, never into its value.
    Object.assign(secrets.secrets, answer.secrets ?? {});
    return answer.value;
  });
  const context: OperationContext = {
    signal: controller.signal,
    ...secrets,
    progress: () => {},
    log: () => {},
    output: () => {},
  };
  const operation = openOperation(
    () => unusedEngine(),
    async () => OWN,
    async () => {
      throw new Error('No batch helper in this test.');
    },
    () => 'monitor script',
  );
  return { result: operation(PARAMS, context), asks, confirmations };
}

describe('the operation open of the worker (review B, round 1 of PR #111)', () => {
  it('B1-76: the first open of an untrusted repository asks the confirmation; refused, nothing is created', async () => {
    const { result, asks, confirmations } = run();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(confirmations).toEqual(['acme/api']);
    expect(asks).not.toContain('record createEnvironment');
  });
});
