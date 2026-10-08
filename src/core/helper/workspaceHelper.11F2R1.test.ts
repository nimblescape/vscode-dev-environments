// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review 11F2 R1 (mutation testing): the wrappers of WorkspaceHelper around HelperImages. With HelperDeps.ownImage (the
// worker) every image call answers with that image and touches no Docker image (the worker has no Dockerfile and builds
// nothing); a step of the batch helper runs on that image with the socket of the engine of the operation (its recorded
// socket, else the endpoint of its context).
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { HelperBatchSession } from '../helperChannel/helperChannel';
import { silentLogger } from '../ports';
import { runWithBatchScope } from './batchScope';
import { WorkspaceHelper, type HelperDocker } from './workspaceHelper';
import type { HelperEngine } from './helperImages';

const OWN = { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` };

/** A Docker port on which every image call fails: the worker touches no helper image. */
function noImageDocker(touched: string[]): HelperDocker {
  const refuse = (name: string) => async (): Promise<never> => {
    touched.push(name);
    throw new Error(`${name} must not be called`);
  };
  return {
    imageExists: refuse('imageExists'),
    imageId: refuse('imageId'),
    buildImage: refuse('buildImage'),
    listImagesByLabel: refuse('listImagesByLabel'),
    removeImage: refuse('removeImage'),
    run: refuse('run'),
  };
}

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

function helper(touched: string[], engine: () => Promise<HelperEngine>, ownImage: typeof OWN | undefined = OWN, platform: NodeJS.Platform = 'linux'): WorkspaceHelper {
  return new WorkspaceHelper({
    docker: noImageDocker(touched),
    logger: silentLogger,
    dockerfilePath: '/nonexistent/Dockerfile',
    env: {},
    platform,
    engine,
    ownImage,
  });
}

async function ownershipFix(h: WorkspaceHelper): Promise<{ image: string; socket: string }[]> {
  const lock = new SocketLock();
  await runWithBatchScope(lock, 'vol', silentLogger, () => h.fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' }));
  return lock.opens;
}

describe('WorkspaceHelper with its own image (review 11F2 R1)', () => {
  it('checks, reads and prebuilds its own image without any Docker image call', async () => {
    const touched: string[] = [];
    const h = helper(touched, async () => ({ key: 'box', socket: '/s.sock' }));
    await expect(h.checkImagePresent()).resolves.toBeUndefined();
    expect(await h.presentImage()).toEqual(OWN);
    expect(await h.prebuildImage({ signal: new AbortController().signal })).toEqual(OWN);
    expect(await h.ensureImage()).toBe(OWN.tag);
    expect(touched).toEqual([]);
  });

  it('passes an abort through on each image call', async () => {
    const touched: string[] = [];
    const h = helper(touched, async () => ({ key: 'box', socket: '/s.sock' }));
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    await expect(h.checkImagePresent({ signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.presentImage({ signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.prebuildImage({ signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.ensureImageUse({ signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(touched).toEqual([]);
  });

  it('runs a step of the batch helper on its own image with the recorded socket of the engine', async () => {
    const touched: string[] = [];
    const opens = await ownershipFix(helper(touched, async () => ({ key: 'box', socket: '/run/user/1000/docker.sock' })));
    expect(opens).toEqual([{ image: OWN.id, socket: '/run/user/1000/docker.sock' }]);
    expect(touched).toEqual([]);
  });

  it('follows the endpoint of the Docker context of the operation for the socket when the engine records none', async () => {
    const opens = await ownershipFix(helper([], async () => ({ key: '', endpoint: 'unix:///run/user/1000/docker.sock' })));
    expect(opens).toEqual([{ image: OWN.id, socket: '/run/user/1000/docker.sock' }]);
  });
});
