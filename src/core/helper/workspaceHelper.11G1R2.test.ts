// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #114 (B, mutation testing of A-M2): a list of valid paths of the services well within the bound
// of the request (MAX_SERVICE_FOLDERS_REQUEST_CHARACTERS) stays a list: only an overlong list counts as the whole
// repository (where only the files of root change, so files of other owners would keep them).
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { silentLogger } from '../ports';
import { runWithBatchScope } from './batchScope';
import { batchStepCommand } from './batchSteps';
import { WorkspaceHelper } from './workspaceHelper';

const OWN = { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` };
const REPO = 'octo/hello';
const FOLDER = '/workspaces/hello';

class StepLock implements HeldEnvironmentLock {
  readonly environmentId = 'e';
  readonly lost = new Promise<string>(() => {});
  readonly steps: { kind: string; params: unknown; options: BatchStepOptions }[] = [];
  async release(): Promise<void> {}
  async batch(): Promise<HelperBatchSession> {
    return {
      session: 's',
      lost: new Promise<string>(() => {}),
      step: async (kind, params, options = {}) => {
        this.steps.push({ kind, params, options });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
      close: async () => {},
    };
  }
}

// Plan step 11I (U7, decision of 2026-10-08): changed setup, the helper of the worker takes its own image, the socket
// and containerRuns (before: a Docker port whose image calls answered and whose `docker run` threw, and an engine).
function helper(): WorkspaceHelper {
  return new WorkspaceHelper({
    logger: silentLogger,
    ownImage: OWN,
    socket: '/s.sock',
    containerRuns: async () => {
      throw new Error('no container query');
    },
  });
}

describe('WorkspaceHelper.fixRepositoryOwnership: the bound of the request (review round 2 of PR #114, B)', () => {
  it('keeps a list of valid paths of the services below the bound of the request', async () => {
    const lists: string[][] = [
      // Some ordinary services.
      Array.from({ length: 20 }, (_, i) => `${FOLDER}/services/service-${i}/data`),
      // About 200 KB of JSON: still well below the bound (1 MiB).
      Array.from({ length: 200 }, (_, i) => `${FOLDER}/s${i}/${'x'.repeat(1000)}`),
    ];
    for (const serviceFolders of lists) {
      const lock = new StepLock();
      await runWithBatchScope(lock, 'vol', silentLogger, () =>
        helper().fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid: '1000', gid: '1001', serviceFolders, image: OWN }),
      );
      expect(lock.steps).toHaveLength(1);
      const params = lock.steps[0].params as { serviceFolders: unknown };
      expect(Array.isArray(params.serviceFolders)).toBe(true);
      expect([...(params.serviceFolders as string[])].sort()).toEqual([...serviceFolders].sort());
      expect(() => batchStepCommand('repositoryOwnershipFix', lock.steps[0].params)).not.toThrow();
    }
  });
});
