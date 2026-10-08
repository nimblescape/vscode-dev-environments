// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (U7, decision of 2026-10-08): the WorkspaceHelper of the worker (workerServiceDeps) takes the worker's own
// helper image and socket (OwnHelper), the logger and containerRuns, and nothing of the helper image of the extension (no
// Docker port that could build, list or remove a helper image, no Dockerfile, no environment or platform of the
// computer); a step of its batch helper runs on the own image with the own socket.
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { runWithBatchScope } from '../helper/batchScope';
import type { HelperBatchSession } from '../helperChannel/helperChannel';
import { silentLogger } from '../ports';
import type { DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { workerServiceDeps } from './workerServices';

const OWN = { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` };
/** The socket of a rootless engine, so that a default socket (/var/run/docker.sock) would show. */
const SOCKET = '/run/user/1000/docker.sock';

function workerHelper(engine: DockerEngine = unusedEngine()) {
  return workerServiceDeps({
    host: { questions: {}, state: {}, records: {}, secrets: {} } as unknown as HostSide,
    engine,
    secretOf: () => undefined,
    forgetSecret: () => undefined,
    logger: silentLogger,
    ownHelper: { image: OWN, socket: SOCKET },
    dockerHost: 'build-box',
    owner: { windowId: 'w', pid: 1 },
    environmentLock: async () => {
      throw new Error('no lock in this test');
    },
  }).helper;
}

describe("the worker's WorkspaceHelper (plan step 11I, U7)", () => {
  it("runs a step of the batch helper on the worker's own image with the worker's socket", async () => {
    const opens: Array<{ volume: string; image: string; socket: string }> = [];
    const lock: HeldEnvironmentLock = {
      environmentId: 'e',
      lost: new Promise<string>(() => {}),
      release: async () => {},
      batch: async (p): Promise<HelperBatchSession> => {
        opens.push(p);
        return {
          session: 's',
          lost: new Promise<string>(() => {}),
          step: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
          close: async () => {},
        };
      },
    };
    await runWithBatchScope(lock, 'vol', silentLogger, () =>
      workerHelper().fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' }),
    );
    expect(opens).toEqual([{ volume: 'vol', image: OWN.id, socket: SOCKET }]);
  });

  it('holds nothing of the helper image of the extension, and gives its own image for the two image calls of the pipeline', async () => {
    const helper = workerHelper();
    const deps = (helper as unknown as { deps: Record<string, unknown> }).deps;
    expect(Object.keys(deps).sort()).toEqual(['containerRuns', 'logger', 'ownImage', 'socket']);
    for (const removed of ['ensureImage', 'checkImagePresent', 'presentImage', 'engineKey', 'prebuildImage', 'runImage']) {
      expect((helper as unknown as Record<string, unknown>)[removed], removed).toBeUndefined();
    }
    expect(await helper.ensureImageUse()).toEqual(OWN);
    expect(await helper.ensureImagePresent()).toEqual(OWN);
  });

  // Review round 1 of PR #129 (B-L4): whether a container runs (after a failed lifecycle command of `up`) is read with
  // the signal of the step, so a cancelled open does not wait for an inspect that the engine does not answer.
  it('reads whether a container runs with the signal of the step', async () => {
    const seen: AbortSignal[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      container: (_reference, signal) =>
        new Promise((_resolve, reject) => {
          if (signal) seen.push(signal);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    const deps = (workerHelper(engine) as unknown as { deps: { containerRuns: (id: string, signal?: AbortSignal) => Promise<boolean> } }).deps;
    const controller = new AbortController();
    const runs = deps.containerRuns('c'.repeat(64), controller.signal);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    controller.abort();
    await expect(runs).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen[0].aborted).toBe(true);
  });
});
