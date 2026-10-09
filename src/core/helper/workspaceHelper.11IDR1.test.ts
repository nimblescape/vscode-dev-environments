// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #125 (reviewer B): the local checks that WorkspaceHelper keeps after plan step 11I (PR D) no longer
// build the command of a step (the batch helper builds it, batchStepCommand). They still refuse an invalid repository
// name, configuration path or user/group ID before the step is sent: with the plain Error of the check, without a batch
// session or a step, and without refusing the batch scope of the operation (D1), so a later valid step still runs. Each
// probe names the mutant that it kills (the mutant removes or narrows one of these checks; the batch helper's own check
// then refuses the step in the session, which refuses the whole scope as BatchHelperUnavailableError).
import { describe, expect, it } from 'vitest';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { BatchHelperUnavailableError, UserFacingError } from '../errors';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { silentLogger, type RunResult } from '../ports';
import { runWithBatchScope } from './batchScope';
import { batchStepCommand } from './batchSteps';
import { WorkspaceHelper } from './workspaceHelper';

const OWN = { tag: 'devenv-helper:own', id: `sha256:${'b'.repeat(64)}` };
const REPO = 'acme/api';
const BAD_REPO = 'acme/a b';
const CONFIG = '.devcontainer/devcontainer.json';
const BAD_CONFIG = '../outside.json';
const ENV_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const CONTAINER = 'c'.repeat(64);
const TOKEN = 'ghp_probetoken1234';

/**
 * A lock whose batch session checks each step as the batch helper does (batchStepCommand: a BatchStepError for inputs
 * beyond its checks) and records it; `listConfigs` answers an empty list, every other step exit code 0.
 */
class CheckingLock implements HeldEnvironmentLock {
  readonly environmentId = 'e';
  readonly lost = new Promise<string>(() => {});
  /** The sessions opened. */
  opened = 0;
  /** The kinds of the steps that reached the session. */
  readonly steps: string[] = [];
  async release(): Promise<void> {}
  async batch(): Promise<HelperBatchSession> {
    this.opened++;
    return {
      session: `s${this.opened}`,
      lost: new Promise<string>(() => {}),
      step: async (kind: string, params: unknown, _options: BatchStepOptions = {}): Promise<RunResult> => {
        this.steps.push(kind);
        batchStepCommand(kind, params);
        return { exitCode: 0, stdout: kind === 'listConfigs' ? '[]\n' : '', stderr: '', timedOut: false };
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

/**
 * Runs `call` in a batch scope, then a valid listConfigurations in the same scope; gives the rejection of `call`, the
 * result of the valid step and the lock.
 */
async function refusedInScope(call: (h: WorkspaceHelper) => Promise<unknown>): Promise<{ error: unknown; after: unknown; lock: CheckingLock }> {
  const lock = new CheckingLock();
  const { error, after } = await runWithBatchScope(lock, 'vol', silentLogger, async () => {
    const h = helper();
    // `build` is no async method: its checks throw at the call (as before plan step 11I), the others reject.
    const error = await Promise.resolve()
      .then(() => call(h))
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    const after = await h.listConfigurations({ volumeName: 'vol', repository: REPO, image: OWN }).catch((reason: unknown) => reason);
    return { error, after };
  });
  return { error, after, lock };
}

/** The refusal of a local check: its plain Error, before any step; the scope still runs the next step. */
function expectLocalRefusal(result: { error: unknown; after: unknown; lock: CheckingLock }, message: string): void {
  expect(result.error).toBeInstanceOf(Error);
  expect(result.error).not.toBeInstanceOf(UserFacingError);
  expect(result.error).not.toBeInstanceOf(BatchHelperUnavailableError);
  expect((result.error as Error).message).toBe(message);
  // Only the valid step after it reached the batch helper, and it ran.
  expect(result.lock.steps).toEqual(['listConfigs']);
  expect(result.after).toEqual([]);
}

const REPOSITORY_REFUSED = `Invalid repository name: ${BAD_REPO}`;
const CONFIG_REFUSED = `Invalid configuration path: ${BAD_CONFIG}`;

describe('review round 1 of PR #125 (reviewer B): the local checks of WorkspaceHelper before a step', () => {
  // Mutant WH-clone-repo: clone without checkRepository.
  it('clone refuses an invalid repository name before its step', async () => {
    expectLocalRefusal(await refusedInScope((h) => h.clone({ volumeName: 'vol', repository: BAD_REPO, token: TOKEN, image: OWN })), REPOSITORY_REFUSED);
  });

  // Mutants WH-readFiles-repo and WH-readFiles-cfg: readConfigFiles without checkRepository / checkConfigPath.
  it('readConfigFiles refuses an invalid repository name and an invalid configuration path before its step', async () => {
    expectLocalRefusal(await refusedInScope((h) => h.readConfigFiles({ volumeName: 'vol', repository: BAD_REPO, configPath: CONFIG, image: OWN })), REPOSITORY_REFUSED);
    expectLocalRefusal(await refusedInScope((h) => h.readConfigFiles({ volumeName: 'vol', repository: REPO, configPath: BAD_CONFIG, image: OWN })), CONFIG_REFUSED);
  });

  // Mutant WH-listConfigs-repo: listConfigurations without checkRepository.
  it('listConfigurations refuses an invalid repository name before its step', async () => {
    expectLocalRefusal(await refusedInScope((h) => h.listConfigurations({ volumeName: 'vol', repository: BAD_REPO, image: OWN })), REPOSITORY_REFUSED);
  });

  // Mutants WH-readConf-repo and WH-readConf-cfg: readConfigurationOutput without checkRepository / checkConfigPath (both
  // the read with the merged configuration and the one without it).
  it('readConfiguration refuses an invalid repository name and an invalid configuration path before its step', async () => {
    for (const merged of [false, true]) {
      expectLocalRefusal(
        await refusedInScope((h) => h.readConfiguration({ volumeName: 'vol', repository: BAD_REPO, configPath: CONFIG, environmentId: ENV_ID, merged, image: OWN })),
        REPOSITORY_REFUSED,
      );
      expectLocalRefusal(
        await refusedInScope((h) => h.readConfiguration({ volumeName: 'vol', repository: REPO, configPath: BAD_CONFIG, environmentId: ENV_ID, merged, image: OWN })),
        CONFIG_REFUSED,
      );
    }
  });

  // Mutants WH-build-repo and WH-build-cfg: build without checkRepository / checkConfigPath.
  it('build refuses an invalid repository name and an invalid configuration path before its step', async () => {
    expectLocalRefusal(await refusedInScope((h) => h.build({ volumeName: 'vol', repository: BAD_REPO, configPath: CONFIG, imageName: 'devenv-api', image: OWN })), REPOSITORY_REFUSED);
    expectLocalRefusal(await refusedInScope((h) => h.build({ volumeName: 'vol', repository: REPO, configPath: BAD_CONFIG, imageName: 'devenv-api', image: OWN })), CONFIG_REFUSED);
  });

  // Mutants WH-up-repo and WH-ruc-repo: up / runUserCommands without checkRepository.
  it('up and runUserCommands refuse an invalid repository name before their step', async () => {
    expectLocalRefusal(
      await refusedInScope((h) => h.up({ volumeName: 'vol', repository: BAD_REPO, override: {}, environmentId: ENV_ID, removeExistingContainer: false, image: OWN })),
      REPOSITORY_REFUSED,
    );
    expectLocalRefusal(
      await refusedInScope((h) =>
        h.runUserCommands({ volumeName: 'vol', repository: BAD_REPO, override: {}, environmentId: ENV_ID, containerId: CONTAINER, token: TOKEN, image: OWN }),
      ),
      REPOSITORY_REFUSED,
    );
  });

  // Mutant WH-git-repo: prepareGit without checkRepository.
  it('prepareGit refuses an invalid repository name before its step', async () => {
    expectLocalRefusal(await refusedInScope((h) => h.prepareGit({ volumeName: 'vol', repository: BAD_REPO, identity: { name: 'Octo Cat', email: 'octo@example.com' }, image: OWN })), REPOSITORY_REFUSED);
  });

  // Mutants WH-cfgfix-ids and WH-cfgfix-uidonly: fixConfigOwnership without checkNumericIds, or with the user ID only.
  it('fixConfigOwnership refuses a user or a group ID that is no number before its step', async () => {
    const fix = (uid: string, gid: string) => (h: WorkspaceHelper) => h.fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid, gid, image: OWN });
    expectLocalRefusal(await refusedInScope(fix('vscode', '1000')), 'Invalid user or group ID: "vscode":"1000"');
    expectLocalRefusal(await refusedInScope(fix('1000', 'staff')), 'Invalid user or group ID: "1000":"staff"');
  });

  // Mutants WH-repofix-ids and WH-repofix-uidonly: fixRepositoryOwnership without checkNumericIds, or with the user ID
  // only (workspaceHelper.11G1.test.ts refuses a bad user ID, never a bad group ID).
  it('fixRepositoryOwnership refuses a group ID that is no number before its step', async () => {
    const fix = (uid: string, gid: string) => (h: WorkspaceHelper) => h.fixRepositoryOwnership({ volumeName: 'vol', repository: REPO, uid, gid, image: OWN });
    expectLocalRefusal(await refusedInScope(fix('1000', 'staff')), 'Invalid user or group ID: "1000":"staff"');
    expectLocalRefusal(await refusedInScope(fix('-1', '1000')), 'Invalid user or group ID: "-1":"1000"');
  });

  // Mutant WH-msg-kind: the internal error of a step outside a batch scope names the kind of the step (plan step 11I,
  // PR D: without its command); workspaceHelper.test.ts only matches `\w+` there.
  it('names the kind of a step that ran outside the batch helper of an operation', async () => {
    await expect(helper().listConfigurations({ volumeName: 'vol', repository: REPO })).rejects.toThrow(
      /^Internal error: the workspace helper step listConfigs on the volume vol ran outside the batch helper of an operation; it was not run\.$/,
    );
    await expect(helper().fixConfigOwnership({ volumeName: 'vol', folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' })).rejects.toThrow(
      /^Internal error: the workspace helper step ownershipFix on the volume vol /,
    );
  });
});

// PR #125 review round 1 (B L2): StreamOptions.input is removed; the check of the helper files (writeAndRunInput) stays a
// local check of every step that takes files.
describe('review round 1 of PR #125 (B L2): the local check of the helper files before a step', () => {
  const BAD_FILE = '/tmp/other/compose.json';
  const files = { [BAD_FILE]: '{}' };
  it('readConfiguration, build, up and runUserCommands refuse a file outside the override folder before their step', async () => {
    const refused = `Invalid helper file: ${BAD_FILE}`;
    expectLocalRefusal(
      await refusedInScope((h) => h.readConfiguration({ volumeName: 'vol', repository: REPO, configPath: CONFIG, environmentId: ENV_ID, merged: true, files, image: OWN })),
      refused,
    );
    expectLocalRefusal(await refusedInScope((h) => h.build({ volumeName: 'vol', repository: REPO, configPath: CONFIG, imageName: 'devenv-api', files, image: OWN })), refused);
    expectLocalRefusal(
      await refusedInScope((h) => h.up({ volumeName: 'vol', repository: REPO, override: {}, environmentId: ENV_ID, removeExistingContainer: false, files, image: OWN })),
      refused,
    );
    expectLocalRefusal(
      await refusedInScope((h) =>
        h.runUserCommands({ volumeName: 'vol', repository: REPO, override: {}, environmentId: ENV_ID, containerId: CONTAINER, files, token: TOKEN, image: OWN }),
      ),
      refused,
    );
  });
});
