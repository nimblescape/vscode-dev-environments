// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR H (reviewer B): the maintaining ensure of the preparation of the worker for an open runs as an
// operation on the target of that worker (inTarget: runWithDockerTarget in extension.ts), as ensureImagePresent does, so
// its Docker calls, its engine key and its state file are those of that engine. Kills B11 (the maintaining ensure
// called without inTarget; the tests of PR H run inTarget as `fn()`, so they could not see it).
import { AsyncLocalStorage } from 'async_hooks';
import { describe, expect, it } from 'vitest';
import type { DockerTarget } from '../docker/dockerHost';
import type { HelperImageUse } from '../helper/helperImage';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
import { heartbeatHelperImage } from './heartbeatHelperImage';
import { HeartbeatPreparation } from './heartbeatPreparation';

const REMOTE: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'devenv-remote-11111111' };
const IMAGE: HelperImageUse = { tag: 'devenv-helper:0123456789ab', id: 'sha256:1111' };

describe('the preparation of the worker for an open runs on its target (review round 1 of PR H, reviewer B)', () => {
  it('calls the maintaining ensure as an operation on the target of the worker, as the ensure of the others (B11)', async () => {
    const ambient = new AsyncLocalStorage<DockerTarget>();
    const calls: Array<{ kind: string; target: DockerTarget | undefined }> = [];
    const helper = {
      ensureImagePresent: async (): Promise<HelperImageUse> => {
        calls.push({ kind: 'present', target: ambient.getStore() });
        return IMAGE;
      },
      ensureImageUse: async (): Promise<HelperImageUse> => {
        calls.push({ kind: 'maintain', target: ambient.getStore() });
        return IMAGE;
      },
      presentImage: async (): Promise<HelperImageUse | undefined> => IMAGE,
    };
    const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => 0 });
    const image = heartbeatHelperImage({ preparation, helper, inTarget: (target, fn) => ambient.run(target, fn), onOutput: () => {} });
    await image.prepareWorker(REMOTE, undefined, { checkBaseImage: true });
    await image.prepareWorker(REMOTE, undefined);
    expect(calls).toEqual([
      { kind: 'maintain', target: REMOTE },
      { kind: 'present', target: REMOTE },
    ]);
    preparation.dispose();
  });
});
