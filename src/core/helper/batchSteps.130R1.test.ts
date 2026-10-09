// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #130 (reviewer B): mutant M14 of batchSteps.ts survived the whole unit suite: `up` with Compose
// override files loses BAKE_FS_ENTITLEMENTS_OFF (`env: files === undefined ? { ...stepEnv(kind, p.env),
// ...BAKE_FS_ENTITLEMENTS_OFF } : stepEnv(kind, p.env)`). That is the very run the user decision of 2026-10-09 is about
// (the `up` of a Docker Compose configuration, which builds a missing image through bake), but the tests look at the
// variables of `up` only without files (batchSteps.test.ts, batchScope.test.ts B-R1-4, workspaceHelper.test.ts), and the
// tests of `up` with files (workspaceHelper.test.ts, batchScope.test.ts B-R2-2) at its command, its input and
// COMPOSE_PROJECT_NAME only. The probe asks for the variable on build and up with every combination of their optional
// inputs (Compose files, an override, the variables of the request, removeExistingContainer).
import { describe, expect, it } from 'vitest';
import { batchStepCommand } from './batchSteps';
import { COMPOSE_MODEL_PATH } from './compose';

const REPO = 'octo/hello';
const ID = 'env-1';
const COMPOSE_OVERRIDE = { dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app', shutdownAction: 'none' };

describe('review round 1 of PR #130 (reviewer B)', () => {
  it('runs build and up with the entitlement check of bake off for every combination of their optional inputs (M14: up with Compose files)', () => {
    const files = { [COMPOSE_MODEL_PATH]: '{"name":"p"}' };
    let checked = 0;
    for (const withFiles of [false, true]) {
      for (const withEnv of [false, true]) {
        const optional = { ...(withFiles ? { files } : {}), ...(withEnv ? { env: { COMPOSE_PROJECT_NAME: 'p' } } : {}) };
        const expected = { ...(withEnv ? { COMPOSE_PROJECT_NAME: 'p' } : {}), BUILDX_BAKE_ENTITLEMENTS_FS: '0' };
        for (const removeExistingContainer of [false, true]) {
          const up = batchStepCommand('up', { repository: REPO, override: COMPOSE_OVERRIDE, environmentId: ID, removeExistingContainer, ...optional });
          expect(up.env, `up files=${withFiles} env=${withEnv} removeExistingContainer=${removeExistingContainer}`).toEqual(expected);
          checked++;
        }
        for (const withOverride of [false, true]) {
          const build = batchStepCommand('build', {
            repository: REPO,
            configPath: '.devcontainer/devcontainer.json',
            imageName: 'p:1',
            ...(withOverride ? { override: COMPOSE_OVERRIDE } : {}),
            ...optional,
          });
          expect(build.env, `build files=${withFiles} env=${withEnv} override=${withOverride}`).toEqual(expected);
          checked++;
        }
      }
    }
    expect(checked).toBe(16);
  });
});
