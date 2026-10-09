// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review 11F2 R1 (mutation testing): the wrappers of WorkspaceHelper around HelperImages. With HelperDeps.ownImage (the
// worker) every image call answers with that image and touches no Docker image (the worker has no Dockerfile and builds
// nothing); a step of the batch helper runs on that image with the socket of the engine of the operation (its recorded
// socket, else the endpoint of its context).
// Plan step 11I (U7, decision of 2026-10-08): WorkspaceHelper wraps no HelperImages and has no Docker port any more:
// its two image calls (those of the pipeline) give the own image, and a step runs on it with the socket of HelperDeps
// (the worker's own); the socket of the endpoint of a Docker context is HelperImages' (helperImages.rules.test.ts).
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { HelperBatchSession } from '../helperChannel/helperChannel';
import { silentLogger } from '../ports';
import { runWithBatchScope } from './batchScope';
import { WorkspaceHelper } from './workspaceHelper';

const OWN = { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` };

class SocketLock implements HeldEnvironmentLock {
  readonly environmentId = 'e';
  readonly lost = new Promise<string>(() => {});
  readonly opens: { image: string; socket: string }[] = [];
  async release(): Promise<void> {}
  async batch(p: { volume: string; image: string; socket: string }): Promise<HelperBatchSession> {
    this.opens.push({ image: p.image, socket: p.socket });
    return {
      session: 's',
      lost: new Promise<string>(() => {}),
      step: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      close: async () => {},
    };
  }
}

// Plan step 11I (U7): changed setup, the own image, the socket and containerRuns (before: a Docker port that refused
// every call, an engine, and an optional own image).
function helper(socket: string): WorkspaceHelper {
  return new WorkspaceHelper({
    logger: silentLogger,
    ownImage: OWN,
    socket,
    containerRuns: async () => {
      throw new Error('no container query');
    },
  });
}

async function ownershipFix(h: WorkspaceHelper): Promise<{ image: string; socket: string }[]> {
  const lock = new SocketLock();
  await runWithBatchScope(lock, 'vol', silentLogger, () => h.fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' }));
  return lock.opens;
}

describe('WorkspaceHelper with its own image (review 11F2 R1)', () => {
  // Plan step 11I (U7, decision of 2026-10-08): the test "checks, reads and prebuilds its own image without any Docker
  // image call" is deleted with the code that it tested (checkImagePresent, presentImage, prebuildImage and ensureImage
  // of WorkspaceHelper, and its Docker port).

  // Plan step 11I (U7): changed expectation, the two image calls that WorkspaceHelper keeps (before: also
  // checkImagePresent, presentImage and prebuildImage, which are removed, and no call of the Docker port, which is
  // removed).
  it('passes an abort through on each image call', async () => {
    const h = helper('/s.sock');
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    await expect(h.ensureImageUse({ signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.ensureImagePresent({ signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await h.ensureImageUse()).toEqual(OWN);
    expect(await h.ensureImagePresent()).toEqual(OWN);
  });

  // Plan step 11I (U7): changed setup, the socket is the one of HelperDeps (the worker's own socket; before: the
  // recorded socket of the engine of the operation).
  it('runs a step of the batch helper on its own image with the recorded socket of the engine', async () => {
    const opens = await ownershipFix(helper('/run/user/1000/docker.sock'));
    expect(opens).toEqual([{ image: OWN.id, socket: '/run/user/1000/docker.sock' }]);
  });

  // Plan step 11I (U7): the test "follows the endpoint of the Docker context of the operation for the socket when the
  // engine records none" is deleted with the code that it tested (WorkspaceHelper no longer computes a socket; the
  // worker gives its own, and the endpoint rule is helperDockerSocket's, tested in helperImages.rules.test.ts).
});
