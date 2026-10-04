// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #100 (B, mutation probes): the operation `monitorEnsure` passes its cancel and its log.
import { describe, expect, it } from 'vitest';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { monitorEnsureOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const OWN: OwnHelper = { image: { tag: 'devenv-helper:0123456789ab', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const IMAGES = { prefixes: [] as string[], schedule: '7 6 * * *', timeZone: 'UTC' };

function contextOf() {
  const controller = new AbortController();
  const lines: string[] = [];
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets({}),
    progress: () => {},
    log: (text) => lines.push(text),
    output: () => {},
    docker: async () => {
      throw new Error('No Docker CLI call.');
    },
  };
  return { context, controller, lines };
}

describe('monitorEnsure probes (review round 1 of PR #100, B)', () => {
  it('the cancel of the operation reaches the calls of the engine', async () => {
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: (_kind, _name, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    };
    const { context, controller } = contextOf();
    const ensuring = monitorEnsureOperation(() => engine, async () => OWN, () => 'script')({ images: IMAGES }, context);
    setTimeout(() => controller.abort(), 20);
    await expect(ensuring).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('the ensure logs to the log of the operation', async () => {
    const engine: DockerEngine = { ...unusedEngine(), inspect: async () => undefined, createAttached: async () => ({ kind: 'ready' }) };
    const { context, lines } = contextOf();
    await monitorEnsureOperation(() => engine, async () => OWN, () => 'script')({ images: IMAGES }, context);
    expect(lines.some((line) => line.startsWith('The Session Monitor on the Docker host was created'))).toBe(true);
  });
});
