// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #130 (reviewer B): four mutants of batchHelper.ts survived the whole unit suite. The tests of
// stepEnvironment look at all the variables of `up` only (of clone and composeHash at HOME, XDG_CONFIG_HOME, DOCKER_HOST
// and COMPOSE_PROJECT_NAME), and no test looks at BUILDX_BAKE_ENTITLEMENTS_FS in the environment that spawnStep gets
// (batch.test.ts checks that of `up` with toMatchObject, without it). Each probe names the mutants that it kills:
// - M11a: stepEnvironment sets BUILDX_BAKE_ENTITLEMENTS_FS=0 on every step (`{ ...base, ...step.env,
//   ...COMPOSE_REMOTE_OFF, BUILDX_BAKE_ENTITLEMENTS_FS: '0' }`): the check of bake off for every step, not build and up only.
// - M12b: stepEnvironment drops the variable for the steps without a secret
//   (`if (step.secret === undefined) delete env.BUILDX_BAKE_ENTITLEMENTS_FS;`): build loses it.
// - M12c: runStep gives the step process the environment of stepEnvironment without BUILDX_BAKE_ENTITLEMENTS_FS.
// - M12e: stepEnvironment lets the helper's own variables win over those of the step (`{ ...step.env, ...base,
//   ...COMPOSE_REMOTE_OFF }`): a helper environment with BUILDX_BAKE_ENTITLEMENTS_FS=1 turns the check on again for build
//   and up (the test "sets the variables on the step after those of the helper" has no variable in both).
import { describe, expect, it } from 'vitest';
import { BATCH_STEP_KINDS, batchStepCommand, type BatchStepKind } from '../core/helper/batchSteps';
import { COMPOSE_MODEL_PATH } from '../core/helper/compose';
import { CONFIG_FOLDER } from '../core/names';
import { batchHelperOperations, stepEnvironment } from './batchHelper';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const REPO = 'octo/hello';
const ID = 'env-1';
const CONFIG = '.devcontainer/devcontainer.json';
const FILES = { [COMPOSE_MODEL_PATH]: '{"name":"p"}' };
const COMPOSE_OVERRIDE = { dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app', shutdownAction: 'none' };

/** Valid inputs of every kind; build and up as for a Docker Compose configuration, with a variable of the request. */
const PARAMS: Record<BatchStepKind, Record<string, unknown>> = {
  clone: { repository: REPO },
  readFiles: { repository: REPO, configPath: CONFIG },
  listConfigs: { repository: REPO },
  readConfiguration: { repository: REPO, configPath: CONFIG, environmentId: ID, merged: true, override: COMPOSE_OVERRIDE, files: FILES, env: { A: 'b' } },
  build: { repository: REPO, configPath: CONFIG, imageName: 'p:1', override: COMPOSE_OVERRIDE, files: FILES, env: { A: 'b' } },
  composeModel: { repository: REPO, files: ['/workspaces/hello/compose.yml'], project: 'p' },
  composeHash: { repository: REPO, model: '{}', project: 'p' },
  createFolders: { repository: REPO, folders: ['/workspaces/hello/data'] },
  up: { repository: REPO, override: COMPOSE_OVERRIDE, environmentId: ID, removeExistingContainer: false, files: FILES, env: { A: 'b' } },
  runUserCommands: { repository: REPO, override: COMPOSE_OVERRIDE, environmentId: ID, containerId: 'abcdef012345', files: FILES, env: { A: 'b' } },
  gitFiles: { repository: REPO, identity: { name: 'n', email: 'e' } },
  ownershipFix: { folder: CONFIG_FOLDER, uid: '1000', gid: '1000' },
  repositoryOwnershipFix: { repository: REPO, uid: '1000', gid: '1000' },
};

const offFor = (kind: string): string | undefined => (kind === 'build' || kind === 'up' ? '0' : undefined);

function context(): OperationContext {
  return { signal: new AbortController().signal, ...contextSecrets(), progress: () => {}, log: () => {}, output: () => {} };
}

describe('review round 1 of PR #130 (reviewer B)', () => {
  it('gives the process of build and up, and of no other step, the entitlement check of bake off (M11a, M12b)', () => {
    const base = { PATH: '/usr/bin', HOME: '/root' };
    for (const kind of BATCH_STEP_KINDS) {
      expect(stepEnvironment(base, batchStepCommand(kind, PARAMS[kind])).BUILDX_BAKE_ENTITLEMENTS_FS, kind).toBe(offFor(kind));
    }
  });

  it('sets the variables of the step after those of the helper: a helper environment cannot turn the check on again for build and up (M12e)', () => {
    const base = { PATH: '/usr/bin', HOME: '/root', A: 'helper', BUILDX_BAKE_ENTITLEMENTS_FS: '1' };
    for (const kind of ['build', 'up'] as const) {
      const env = stepEnvironment(base, batchStepCommand(kind, PARAMS[kind]));
      expect(env.A, kind).toBe('b');
      expect(env.BUILDX_BAKE_ENTITLEMENTS_FS, kind).toBe('0');
    }
  });

  it('starts the process of build and up with the check off, and the other steps as root without it (M11a, M12c)', async () => {
    const spawned: Array<{ kind: string; command: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    let kind = '';
    const operations = batchHelperOperations({
      spawnStep: (command, env) => {
        spawned.push({ kind, command, env });
        return { exited: Promise.resolve({ exitCode: 0 }), killGroup: () => {} };
      },
      runQuiet: async () => {},
      // The steps as root read no owner and touch no file of the helper.
      fs: {} as never,
      env: { PATH: '/usr/bin', HOME: '/root' },
    });
    const rootKinds = ['readConfiguration', 'build', 'up', 'runUserCommands', 'gitFiles', 'ownershipFix', 'repositoryOwnershipFix'] as const;
    for (const next of rootKinds) {
      kind = next;
      expect(await operations[next](PARAMS[next], context()), next).toEqual({ exitCode: 0 });
    }
    expect(spawned.map((step) => [step.kind, step.command])).toEqual(rootKinds.map((each) => [each, batchStepCommand(each, PARAMS[each]).command]));
    for (const step of spawned) expect(step.env.BUILDX_BAKE_ENTITLEMENTS_FS, step.kind).toBe(offFor(step.kind));
  });
});
