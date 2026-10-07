// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G1 ("No extra containers"): WorkspaceHelper.fixRepositoryOwnership runs the ownership fix of the repository
// folder as the step repositoryOwnershipFix of the batch helper of the operation, with parameters that the step accepts.
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { MAX_SERVICE_FOLDERS } from '../git/gitSummary';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { silentLogger, type RunResult } from '../ports';
import { runWithBatchScope } from './batchScope';
import { batchStepCommand } from './batchSteps';
import { WorkspaceHelper, type HelperDocker } from './workspaceHelper';

const OWN = { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` };
const REPO = 'octo/hello';
const FOLDER = '/workspaces/hello';

const noDocker: HelperDocker = {
  imageExists: async () => true,
  imageId: async () => OWN.id,
  buildImage: async () => OWN.id,
  listImagesByLabel: async () => [],
  removeImage: async () => true,
  run: async () => {
    throw new Error('no docker run');
  },
};

/** A lock whose batch session records each step and answers `result`. */
class StepLock implements HeldEnvironmentLock {
  readonly environmentId = 'e';
  readonly lost = new Promise<string>(() => {});
  readonly steps: { kind: string; params: unknown; options: BatchStepOptions }[] = [];
  constructor(private readonly result: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false }) {}
  async release(): Promise<void> {}
  async batch(): Promise<HelperBatchSession> {
    return {
      session: 's',
      lost: new Promise<string>(() => {}),
      step: async (kind, params, options = {}) => {
        this.steps.push({ kind, params, options });
        return this.result;
      },
      close: async () => {},
    };
  }
}

function helper(): WorkspaceHelper {
  return new WorkspaceHelper({
    docker: noDocker,
    logger: silentLogger,
    dockerfilePath: '/nonexistent/Dockerfile',
    env: {},
    platform: 'linux',
    engine: async () => ({ key: 'box', socket: '/s.sock' }),
    ownImage: OWN,
  });
}

describe('WorkspaceHelper.fixRepositoryOwnership (plan step 11G1)', () => {
  it('runs the step repositoryOwnershipFix with the repository, the IDs, the time limit and the signal, and gives its result', async () => {
    const lock = new StepLock({ exitCode: 1, stdout: '', stderr: '/workspaces/hello is not a folder.', timedOut: false });
    const controller = new AbortController();
    const result = await runWithBatchScope(lock, 'vol', silentLogger, () =>
      helper().fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1001', timeoutMs: 600_000, image: OWN, signal: controller.signal }),
    );
    expect(result.exitCode).toBe(1);
    expect(lock.steps).toHaveLength(1);
    const [step] = lock.steps;
    expect(step.kind).toBe('repositoryOwnershipFix');
    expect(step.params).toEqual({ repository: REPO, uid: '1000', gid: '1001' });
    expect(step.options.timeoutMs).toBe(600_000);
    expect(step.options.signal).toBe(controller.signal);
    // No secret.
    expect(step.options.secrets).toBeUndefined();
    expect(() => batchStepCommand(step.kind, step.params)).not.toThrow();
  });

  it('bounds the paths of the services as the pipeline does, so that the step accepts them', async () => {
    const lock = new StepLock();
    const pg = `${FOLDER}/pgdata`;
    const many = Array.from({ length: MAX_SERVICE_FOLDERS + 1 }, (_, i) => `${FOLDER}/data-${i}`);
    await runWithBatchScope(lock, 'vol', silentLogger, async () => {
      const h = helper();
      await h.fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1000', serviceFolders: [pg, pg, `${pg}/base`, '/elsewhere', `${FOLDER}/.git/x`] });
      await h.fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1000', serviceFolders: many });
      await h.fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1000', serviceFolders: 'repository' });
      await h.fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1000', serviceFolders: [] });
    });
    expect(lock.steps.map((step) => (step.params as { serviceFolders?: unknown }).serviceFolders)).toEqual([[pg], 'repository', 'repository', []]);
    for (const step of lock.steps) expect(() => batchStepCommand(step.kind, step.params)).not.toThrow();
  });

  it('refuses IDs that are no numbers and a bad repository before any step, and runs only in the batch scope of an operation', async () => {
    const lock = new StepLock();
    await runWithBatchScope(lock, 'vol', silentLogger, async () => {
      await expect(helper().fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: 'vscode', gid: '1000' })).rejects.toThrow('Invalid user or group ID');
      await expect(helper().fixRepositoryOwnership({ volumeName: 'vol', repository: '../x', uid: '1000', gid: '1000' })).rejects.toThrow();
    });
    expect(lock.steps).toEqual([]);
    await expect(helper().fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1000' })).rejects.toThrow('ran outside the batch helper of an operation');
  });

  it('review round 1 of PR #114 (A-M2): sends the whole repository for paths of services that the step would refuse', async () => {
    const cases: string[][] = [
      [`${FOLDER}/data\tdir`],
      [`${FOLDER}/data\u007f`],
      // Within MAX_SERVICE_FOLDERS, but over the bound of the request.
      Array.from({ length: 300 }, (_, i) => `${FOLDER}/${'d'.repeat(4000)}${i}`),
    ];
    for (const serviceFolders of cases) {
      const lock = new StepLock();
      await runWithBatchScope(lock, 'vol', silentLogger, () =>
        helper().fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1001', serviceFolders, image: OWN }),
      );
      expect(lock.steps).toHaveLength(1);
      expect(lock.steps[0].params).toEqual({ repository: REPO, uid: '1000', gid: '1001', serviceFolders: 'repository' });
      expect(() => batchStepCommand('repositoryOwnershipFix', lock.steps[0].params)).not.toThrow();
    }
    // A valid path stays as it is.
    const lock = new StepLock();
    await runWithBatchScope(lock, 'vol', silentLogger, () =>
      helper().fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1001', serviceFolders: [`${FOLDER}/data`], image: OWN }),
    );
    expect(lock.steps[0].params).toEqual({ repository: REPO, uid: '1000', gid: '1001', serviceFolders: [`${FOLDER}/data`] });
  });
});
