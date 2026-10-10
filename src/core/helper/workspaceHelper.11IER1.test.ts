// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #129 (reviewer B): probes for the mutants of workspaceHelper.ts that the suite let survive.
// - W14: containerRuns swallows an AbortError of HelperDeps.containerRuns (`if (isAbortError(error)) throw error;`
//   removed): the abort counts as "not running", so `up` rejects with the failure of the lifecycle command, not the cancel.
// - W15, W20: the signal of `up` does not reach HelperDeps.containerRuns (dropped in containerRuns, or in
//   keptAfterLifecycleFailure).
// - W18: the warning of a state query that failed is not logged.
// - W05: ensureImageUse and ensureImagePresent give HelperDeps.ownImage itself, not the copy that the PR describes.
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { HelperBatchSession } from '../helperChannel/helperChannel';
import { abortError, isAbortError, type Logger } from '../ports';
import { runWithBatchScope } from './batchScope';
import { DevcontainerCommandError } from './devcontainerCli';
import { WorkspaceHelper, type HelperDeps } from './workspaceHelper';

const OWN = { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` };
const CONTAINER_ID = '4f1c2b3a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a';
const DESCRIPTION = 'postStartCommand from devcontainer.json failed.';

/** A lock whose batch helper answers every step as `up` with a failed lifecycle command of CONTAINER_ID (exit code 1). */
function lifecycleFailureLock(): HeldEnvironmentLock {
  const stdout = `${JSON.stringify({ outcome: 'error', message: 'Command failed: /bin/sh -c npm start', description: DESCRIPTION, containerId: CONTAINER_ID })}\n`;
  return {
    environmentId: 'e',
    lost: new Promise<string>(() => {}),
    release: async () => {},
    batch: async (): Promise<HelperBatchSession> => ({
      session: 's',
      lost: new Promise<string>(() => {}),
      step: async () => ({ exitCode: 1, stdout, stderr: '', timedOut: false }),
      close: async () => {},
    }),
  };
}

function recordingLogger(lines: string[]): Logger {
  return {
    info: (message) => void lines.push(`info ${message}`),
    warn: (message) => void lines.push(`warn ${message}`),
    error: (message) => void lines.push(`error ${message}`),
    output: () => undefined,
  };
}

function up(containerRuns: HelperDeps['containerRuns'], lines: string[] = [], signal?: AbortSignal): Promise<unknown> {
  const logger = recordingLogger(lines);
  const helper = new WorkspaceHelper({ logger, ownImage: OWN, socket: '/var/run/docker.sock', containerRuns });
  return runWithBatchScope(lifecycleFailureLock(), 'vol', logger, () =>
    helper.up({ volumeName: 'vol', repository: 'acme/api', override: {}, environmentId: 'e', removeExistingContainer: false, signal }),
  );
}

describe('review round 1 of PR #129 (reviewer B): the state query of a kept container, and the own image', () => {
  it('passes an abort of the state query of HelperDeps.containerRuns through (W14)', async () => {
    const error = await up(async () => {
      throw abortError();
    }).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(DevcontainerCommandError);
  });

  it('gives HelperDeps.containerRuns the signal of the operation (W15, W20)', async () => {
    const signal = new AbortController().signal;
    const asked: Array<[string, AbortSignal | undefined]> = [];
    await expect(
      up(
        async (containerId, given) => {
          asked.push([containerId, given]);
          return true;
        },
        [],
        signal,
      ),
    ).resolves.toEqual({ outcome: 'success', containerId: CONTAINER_ID, lifecycleCommandFailure: DESCRIPTION });
    expect(asked).toHaveLength(1);
    expect(asked[0][0]).toBe(CONTAINER_ID);
    expect(asked[0][1]).toBe(signal);
  });

  it('logs a warning with the container and the cause when the state cannot be read, and keeps nothing (W18)', async () => {
    const lines: string[] = [];
    const error = await up(async () => {
      throw new Error('the engine is gone');
    }, lines).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevcontainerCommandError);
    expect(lines).toContain(`warn The state of the container ${CONTAINER_ID.slice(0, 12)} could not be read: the engine is gone`);
  });

  // Cleanup after plan step 11 (PR C2, A4): the two image calls of the pipeline are one (ownImageUse), so the copy is
  // asserted once (before: also for ensureImagePresent, removed).
  it('gives a copy of the own image for the two image calls of the pipeline (W05)', async () => {
    const own = { ...OWN };
    const helper = new WorkspaceHelper({ logger: recordingLogger([]), ownImage: own, socket: '/var/run/docker.sock', containerRuns: async () => false });
    const use = await helper.ownImageUse();
    expect(use).toEqual(OWN);
    expect(use).not.toBe(own);
    use.id = 'changed by a caller';
    expect(await helper.ownImageUse()).toEqual(OWN);
  });
});
