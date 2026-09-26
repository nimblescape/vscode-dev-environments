// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import { CommandError, UserFacingError } from '../errors';
import { OWNERSHIP_FIX_SCRIPT } from '../git/gitSummary';
import { HOME_GIT_CONFIG_SCRIPT, devContainersSettings, homeGitConfigCommand } from '../helper/containerGit';
import { runArgsProblems } from '../helper/hostAccess';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import { ensureHelperImage, helperImageTag, type HelperImageDocker } from '../helper/helperImage';
import type { EnsureImageOptions } from '../helper/workspaceHelper';
import { Messages } from '../messages';
import {
  LABEL_ENVIRONMENT_ID,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  environmentImageName,
  environmentImageRepository,
  resourceName,
} from '../names';
import { abortError } from '../ports';
import type { Environment, GitHubAccount, WindowStatus } from '../types';
import { PipelineTexts, type EnvironmentServiceDeps, type RepositoryTarget } from './environmentService';
import {
  ACCOUNT,
  BASE_IMAGE,
  OTHER_ACCOUNT,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  OTHER_ID,
  PID,
  REPO,
  T0,
  TOKEN,
  WINDOW_ID,
  additionalVolumeLabels,
  checked,
  createHarness,
  imageConfigWithUser,
  seedEnvironment,
  type Harness,
} from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH, configHash } from './pipelineRules';

const TARGET: RepositoryTarget = {
  repository: REPO,
  defaultBranch: 'main',
  configPaths: [DEFAULT_CONFIG_PATH],
  trusted: true,
};

const IMAGE_1 = environmentImageName(ENV_ID, 1);
const IMAGE_2 = environmentImageName(ENV_ID, 2);
const NAME = resourceName(REPO, ENV_ID);

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

/** Replaces the harness of this test with one that has other dependencies. */
function recreate(overrides: Partial<EnvironmentServiceDeps>): Harness {
  h.cleanup();
  return createHarness(overrides);
}

function options<T extends object = object>(extra?: T): { progress: typeof h.progress } & T {
  return { progress: h.progress, ...(extra ?? ({} as T)) };
}

async function entry(id = ENV_ID): Promise<Environment | undefined> {
  return h.registry.get(id);
}

async function pendingIds(): Promise<string[]> {
  return (await h.sessionFiles.readPendings()).map((p) => p.environmentId);
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UserFacingError);
    return error as UserFacingError;
  }
  throw new Error('The promise did not reject.');
}

type ClaimSpy = ReturnType<typeof fakeClaims>;

/**
 * EnvironmentClaims.claim for the service: gives each entry of `environmentIds` without owner to the account when `grant`
 * resolves to true (GitHub confirmed the access). Never throws, like EnvironmentClaims.
 */
function fakeClaims(grant: () => Promise<boolean>) {
  return vi.fn(async (account: GitHubAccount, _token: string, claimOptions: { environmentIds?: readonly string[]; mode?: string } = {}) => {
    const claimed: string[] = [];
    for (const id of claimOptions.environmentIds ?? []) {
      if (!(await grant())) continue;
      const updated = await h.registry.updateEnvironment(id, (e) => {
        e.owner ??= { ...account };
      });
      if (updated?.owner?.id === account.id) claimed.push(id);
    }
    return claimed;
  });
}

/** A git summary script run through docker exec: 4 lines. */
function gitExecOutput(branch: string, counts = [0, 0, 0]): string {
  return `${branch}\n${counts.join('\n')}\n`;
}

describe('open: first open', () => {
  it('creates the environment: entry, volume with labels, clone, pull, build, up, ownership, record', async () => {
    h.docker.execHandler = (_container, command) =>
      command[0] === 'sh' && command[2]?.includes('rev-list') ? { stdout: gitExecOutput('main') } : {};
    const result = await h.service.open(TARGET, options());

    const env = await h.registry.findForAccount(REPO, ACCOUNT.id);
    expect(env).toBeDefined();
    const id = env!.id;
    const name = resourceName(REPO, id);
    expect(result.containerName).toBe(name);
    expect(result.remoteWorkspaceFolder).toBe('/workspaces/api');
    expect(env!.volumeName).toBe(name);
    expect(h.docker.volumes.get(name)).toEqual({ [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    // Concept 7.5: the environment belongs to the account that creates it.
    expect(env!.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toEqual([{ volumeName: name, repository: REPO, branch: 'main', token: TOKEN }]);
    expect(h.docker.log).toContain(`pull ${BASE_IMAGE}`);
    const image = environmentImageName(id, 1);
    expect(h.helper.calls).toContain(`build ${image}`);
    expect(h.helper.calls).toContain(`up ${image}`);
    expect(h.helper.ups[0].override).toMatchObject({
      image,
      workspaceMount: `source=${name},target=/workspaces,type=volume`,
      workspaceFolder: '/workspaces/api',
      shutdownAction: 'none',
    });
    expect(h.helper.ups[0].override.runArgs).toEqual(['--label', 'devenv.container-version=3', '--name', name]);
    expect(h.helper.ups[0].override).not.toHaveProperty('initializeCommand');
    // Concept section 9: the token and the Git configuration are in the volume before `up` runs the lifecycle commands.
    expect(h.helper.calls.indexOf('prepareGit')).toBeLessThan(h.helper.calls.indexOf(`up ${image}`));
    expect(h.helper.gitPreparations).toEqual([
      { volumeName: name, repository: REPO, token: TOKEN, identity: { name: 'octo', email: '1001+octo@users.noreply.github.com' } },
    ]);

    expect(env!.buildRecord).toMatchObject({
      environmentImage: image,
      buildNumber: 1,
      configPath: DEFAULT_CONFIG_PATH,
      configHash: configHash(DEFAULT_CONFIG_TEXT),
      images: { [BASE_IMAGE]: DIGEST_NEW },
      features: { [FEATURE]: FEATURE_DIGEST },
    });
    expect(env!.lastBuildNumber).toBe(1);
    expect(env!.busy).toBeUndefined();
    expect(env!.remoteUser).toBe('vscode');
    expect(env!.remoteWorkspaceFolder).toBe('/workspaces/api');
    expect(env!.gitSummary).toMatchObject({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 0 });
    expect(result.environment.id).toBe(id);

    const ownership = h.docker.execs.find((e) => e.user === 'root');
    expect(ownership?.command.slice(-2)).toEqual(['/workspaces/api', 'vscode']);
    // The configuration folder of the container gets the remote user too (written before `up`).
    expect(h.docker.execs.filter((e) => e.command[2] === OWNERSHIP_FIX_SCRIPT).map((e) => e.command[4])).toEqual([
      '/workspaces/api',
      '/workspaces/.devenv+',
    ]);
    // Before the first attach: the ~/.gitconfig of the remote user, which keeps the Dev Containers extension from copying
    // the Git configuration of the computer.
    expect(h.docker.execs.find((e) => e.command[2] === HOME_GIT_CONFIG_SCRIPT)).toMatchObject({ user: 'root', command: homeGitConfigCommand('vscode') });
    expect(await pendingIds()).toEqual([id]);
    expect(h.progress.steps).toEqual(['downloadingRepository', 'checkingImage', 'downloadingImage', 'preparing', 'starting']);
    expect(h.progress.details).toEqual([]);
    expect(h.helper.silentlyCreatedVolumes).toEqual([]);
  });

  it('clones the selected branch', async () => {
    await h.service.open(TARGET, options({ branch: 'feature-x' }));
    expect(h.helper.clones[0].branch).toBe('feature-x');
  });

  it('asks before the first open of a repository of another owner', async () => {
    h.ui.trust = false;
    const error = await rejection(h.service.open({ ...TARGET, trusted: false }, options()));
    expect(error.code).toBe('cancelled');
    expect(h.ui.prompts).toEqual([`untrusted ${REPO}`]);
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);

    h.ui.trust = true;
    await h.service.open({ ...TARGET, trusted: false }, options());
    expect(await h.registry.findForAccount(REPO, ACCOUNT.id)).toBeDefined();
  });

  it('does not ask for a trusted owner', async () => {
    await h.service.open(TARGET, options());
    expect(h.ui.prompts).toEqual([]);
  });

  it('requires a GitHub sign-in', async () => {
    h.token = undefined;
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('signInRequired');
    expect(await h.registry.list()).toEqual([]);
  });

  it('reports a first open without internet access and removes what it created', async () => {
    h.helper.cloneError = new CommandError('git clone', 128, '', "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com");
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('firstOpenOffline');
    expect(error.message).toBe(Messages.firstOpenOffline);
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
    expect(await pendingIds()).toEqual([]);
  });

  it('reports other clone failures as cloneFailed', async () => {
    h.helper.cloneError = new CommandError('git clone', 128, '', "fatal: unable to access '…': The requested URL returned error: 403");
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('cloneFailed');
    expect(error.detail).toContain('403');
    expect(await h.registry.list()).toEqual([]);
  });

  it('reports a token that github.com rejects in the clone to the sign-in state (the sign-in fix)', async () => {
    h.helper.cloneError = new CommandError(
      'git clone',
      128,
      '',
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/acme/api.git/'",
    );
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('cloneFailed');
    expect(h.rejectedTokens).toEqual([h.token]);
  });

  it('does not report the token for a clone failure of another kind', async () => {
    h.helper.cloneError = new CommandError('git clone', 128, '', "remote: Repository not found.\nfatal: repository 'https://github.com/acme/api.git/' not found");
    await rejection(h.service.open(TARGET, options()));
    expect(h.rejectedTokens).toEqual([]);
  });

  it('reports a failed build as firstOpenOffline when the registry was unreachable', async () => {
    h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
    h.helper.buildError = () => new DevcontainerCommandError('devcontainer build', 1, '', 'failed to solve');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('firstOpenOffline');
    // No pull without a registry; no information message without a local image.
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
    expect(h.ui.infos).toEqual([]);
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
  });

  it('reports a failed build as buildFailed and removes the volume, the entry, and the image tags', async () => {
    h.helper.buildError = (image) => {
      h.docker.images.add(image); // a partial result
      return new DevcontainerCommandError('devcontainer build', 1, '', 'Dockerfile syntax error');
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(error.message).toBe(Messages.buildFailed);
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
    expect([...h.docker.images].filter((image) => image.startsWith('devenv-'))).toEqual([]);
  });

  it('removes the container when up fails on a first open', async () => {
    h.helper.upError = () => new DevcontainerCommandError('devcontainer up', 1, '', 'port is already allocated');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(error.message).toBe(PipelineTexts.startFailed);
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.containers.size).toBe(0);
  });

  it('ends with cancelled when the signal aborts, and removes what it created', async () => {
    const controller = new AbortController();
    h.helper.onBuild = () => controller.abort();
    const error = await rejection(h.service.open(TARGET, options({ signal: controller.signal })));
    expect(error.code).toBe('cancelled');
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
    expect(await pendingIds()).toEqual([]);
  });

  it('marks the environment busy (create) while it is prepared', async () => {
    let busy: Environment['busy'];
    h.helper.onBuild = async () => {
      busy = (await h.registry.findForAccount(REPO, ACCOUNT.id))?.busy;
    };
    await h.service.open(TARGET, options());
    expect(busy).toMatchObject({ operation: 'create', pid: PID, windowId: WINDOW_ID });
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id))?.busy).toBeUndefined();
  });

  it('writes the pending connection file before up, so the new container is in use from its start', async () => {
    const pendingAtUp: string[][] = [];
    const original = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      pendingAtUp.push(await pendingIds());
      return original(p);
    };
    await h.service.open(TARGET, options());
    const id = (await h.registry.findForAccount(REPO, ACCOUNT.id))!.id;
    expect(pendingAtUp).toEqual([[id]]);
    expect(await pendingIds()).toEqual([id]);
  });

  it('skips the ownership fix for root', async () => {
    h.helper.remoteUser = 'root';
    await h.service.open(TARGET, options());
    expect(h.docker.execs.some((e) => e.command[2] === OWNERSHIP_FIX_SCRIPT)).toBe(false);
    expect(h.docker.runs).toEqual([]);
    // Root gets the ~/.gitconfig too.
    expect(h.docker.execs.some((e) => e.command[2] === HOME_GIT_CONFIG_SCRIPT && e.command[4] === 'root')).toBe(true);
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id))?.remoteUser).toBe('root');
  });

  it('gives the cloned files to the remote user before up runs the lifecycle commands', async () => {
    let runsAtUp = -1;
    const original = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      runsAtUp = h.docker.runs.length;
      return original(p);
    };
    await h.service.open(TARGET, options());
    const env = (await h.registry.findForAccount(REPO, ACCOUNT.id))!;
    expect(h.docker.runs).toHaveLength(1);
    expect(runsAtUp).toBe(1);
    const run = h.docker.runs[0];
    expect(run.image).toBe(environmentImageName(env.id, 1));
    expect(run.all).toEqual(
      expect.arrayContaining(['--rm', '--user', 'root', '--network', 'none', '--entrypoint', 'sh', `type=volume,source=${env.volumeName},target=/workspaces`]),
    );
    expect(run.args[0]).toBe('-c');
    expect(run.args.slice(-2)).toEqual(['/workspaces/api', 'vscode']);
    // The fix after up stays, for files that up itself creates as root.
    expect(h.docker.execs.some((e) => e.user === 'root')).toBe(true);
  });

  it('gives the cloned files to the user of --user in runArgs when no remoteUser is set (rule of the Dev Container CLI)', async () => {
    const { remoteUser: _remoteUser, ...config } = h.helper.config;
    h.helper.config = { ...config, runArgs: ['--user', 'node:staff'] };
    const build = h.helper.build.bind(h.helper);
    h.helper.build = async (p) => {
      const result = await build(p);
      h.docker.imageConfigs.set(p.imageName, { User: 'root', Labels: { 'devcontainer.metadata': JSON.stringify([{ id: 'base' }]) } });
      return result;
    };
    await h.service.open(TARGET, options());
    expect(h.helper.ups[0].override.runArgs).toEqual(expect.arrayContaining(['--user', 'node:staff']));
    expect(h.docker.runs).toHaveLength(1);
    expect(h.docker.runs[0].args.slice(-2)).toEqual(['/workspaces/api', 'node']);
  });

  it('continues when the files cannot be given to the remote user before up', async () => {
    h.docker.runError = new CommandError('docker run', 1, '', 'sh: find: not found');
    await h.service.open(TARGET, options());
    expect(h.docker.runs).toHaveLength(1);
    expect(h.helper.ups).toHaveLength(1);
    expect(h.logger.warnings.some((w) => w.includes('could not be changed before the container was created'))).toBe(true);
  });

  it('uses the environment that another window of the account created in the meantime (one per repository and account)', async () => {
    const registry = h.registry;
    const original = registry.add.bind(registry);
    let raced = false;
    registry.add = async (environment: Environment) => {
      if (!raced) {
        raced = true;
        await seedEnvironment(h, { container: 'stopped' });
      }
      return original(environment);
    };
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).toBe(ENV_ID);
    expect((await h.registry.list()).map((e) => e.id)).toEqual([ENV_ID]);
    expect(h.helper.clones).toEqual([]);
  });

  it('falls back to the first configuration on the branch and says so', async () => {
    h.helper.files = { '.devcontainer/python/devcontainer.json': { configText: DEFAULT_CONFIG_TEXT } };
    await h.service.open(TARGET, options({ branch: 'feature-x' }));
    expect(h.ui.infos).toEqual([Messages.configurationNotFound(DEFAULT_CONFIG_PATH, 'python')]);
    const env = await h.registry.findForAccount(REPO, ACCOUNT.id);
    expect(env?.configPath).toBe('.devcontainer/python/devcontainer.json');
    expect(env?.buildRecord?.configPath).toBe('.devcontainer/python/devcontainer.json');
  });

  it('uses the first configuration silently for an unknown repository without configuration paths', async () => {
    h.helper.files = { '.devcontainer.json': { configText: DEFAULT_CONFIG_TEXT } };
    await h.service.open({ ...TARGET, configPaths: [] }, options());
    expect(h.ui.infos).toEqual([]);
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id))?.configPath).toBe('.devcontainer.json');
  });

  it('reports a repository without configuration and cleans up', async () => {
    h.helper.files = {};
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('noConfiguration');
    expect(error.message).toBe(Messages.noConfiguration(REPO));
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
  });

  it('refuses Docker Compose configurations', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "dockerComposeFile": "docker-compose.yml", "service": "app" }' };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('composeNotSupported');
    expect(error.message).toBe(Messages.composeNotSupported);
    expect(await h.registry.list()).toEqual([]);
  });

  it('warns about configurations that depend on the computer and continues', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = {
      configText: '{ "image": "ubuntu", "containerEnv": { "SRC": "${localWorkspaceFolder}/data" } }',
    };
    await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.computerDependent('${localWorkspaceFolder}')]);
    expect(h.helper.ups).toHaveLength(1);
  });

  it('passes no value of ${localEnv:…} to the helper, and names the variables in one warning', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = {
      configText: '{ "image": "ubuntu", "containerEnv": { "A": "${localEnv:FOO}", "B": "${localEnv:MISSING:x}", "C": "${localEnv:FOO}" } }',
    };
    await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.localEnvNotPassed('FOO, MISSING')]);
    // The value of the computer (FOO=local-foo in the harness) reaches no helper run.
    expect(JSON.stringify([h.helper.builds, h.helper.ups, h.helper.gitPreparations])).not.toContain('local-foo');
  });

  it('names the variables of ${localEnv:…} that get the values of the workspace helper (for example HOME)', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = {
      configText: '{ "image": "ubuntu", "containerEnv": { "A": "${localEnv:HOME}/x", "B": "${localEnv:FOO}", "C": "${env:PATH}" } }',
    };
    await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.localEnvNotPassed('HOME, FOO, PATH', 'HOME, PATH')]);
  });

  it('stores shutdownAction none and the additional named volumes', async () => {
    h.helper.config = {
      image: BASE_IMAGE,
      shutdownAction: 'none',
      mounts: ['source=api-data,target=/data,type=volume', { target: '/x', type: 'tmpfs' }],
    };
    await h.service.open(TARGET, options());
    const env = await h.registry.findForAccount(REPO, ACCOUNT.id);
    expect(env?.shutdownActionNone).toBe(true);
    expect(env?.additionalVolumes).toEqual(['api-data']);
  });

  it('reports the Docker start as a step', async () => {
    h.dockerStopped = true;
    await h.service.open(TARGET, options());
    expect(h.progress.steps[0]).toBe('startingDocker');
  });

  it('does not create anything when Docker cannot be started', async () => {
    h.dockerStartError = new UserFacingError('dockerStartFailed', Messages.dockerStartFailed);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('dockerStartFailed');
    expect(await h.registry.list()).toEqual([]);
  });

  it('shows the build of the helper image as a detail of the current step, so the steps keep their order', async () => {
    const original = h.helper.ensureImage.bind(h.helper);
    let first = true;
    h.helper.ensureImage = async (opts?: { onOutput?: (text: string) => void }) => {
      if (first) {
        opts?.onOutput?.('Step 1/5 : FROM node');
        opts?.onOutput?.('Step 2/5 : RUN apt-get install git');
      }
      first = false;
      return original();
    };
    await h.service.open(TARGET, options());
    // Concept 6.5: no step comes back after a later one, and "Preparing environment" is the build of the environment.
    expect(h.progress.steps).toEqual(['downloadingRepository', 'checkingImage', 'downloadingImage', 'preparing', 'starting']);
    expect(h.progress.details).toEqual([PipelineTexts.preparingHelper, '']);
    expect(h.logger.outputs).toEqual(expect.arrayContaining(['Step 1/5 : FROM node', 'Step 2/5 : RUN apt-get install git']));
  });
});

describe('open: existing environment', () => {
  it('starts a stopped, up-to-date environment with up only', async () => {
    await seedEnvironment(h);
    h.docker.execHandler = (_c, command) => (command[0] === 'git' ? { stdout: 'feature-y\n' } : {});
    const result = await h.service.open(TARGET, options());

    expect(h.checker.calls).toHaveLength(1);
    expect(h.helper.calls.filter((c) => /^(build|up|clone)/.test(c))).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.log.filter((l) => l.startsWith('pull'))).toEqual([]);
    expect(result.containerName).toBe(NAME);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
    const env = await entry();
    expect(env?.lastUsedAt).not.toBe('2026-09-20T10:00:00.000Z');
    // The branch comes from the container; the counts stay.
    expect(env?.gitSummary).toMatchObject({ branch: 'feature-y', uncommittedFiles: 3, unpushedCommits: 4, stashes: 1 });
    expect(env?.buildRecord?.environmentImage).toBe(IMAGE_1);
    // No ownership fix for a container that only starts.
    expect(h.docker.execs.some((e) => e.user === 'root')).toBe(false);
    expect(await pendingIds()).toEqual([ENV_ID]);
    expect(h.progress.steps).toEqual(['checkingImage', 'starting']);
    expect(h.helper.silentlyCreatedVolumes).toEqual([]);
    // Nothing was cloned: no ownership fix before up.
    expect(h.docker.runs).toEqual([]);
  });

  it('keeps the pending connection file fresh while a long step runs', async () => {
    h.cleanup();
    h = createHarness({ pendingRefreshMs: 5 });
    await seedEnvironment(h, { container: null });
    let writes = 0;
    const originalWrite = h.sessionFiles.writePending.bind(h.sessionFiles);
    h.sessionFiles.writePending = async (id: string, windowId: string) => {
      writes++;
      return originalWrite(id, windowId);
    };
    let writesDuringUp = 0;
    const originalUp = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      // For example postCreateCommand of a new container: longer than a pending file counts (concept 7.9).
      const before = writes;
      await new Promise((resolve) => setTimeout(resolve, 60));
      writesDuringUp = writes - before;
      return originalUp(p);
    };
    await h.service.open(TARGET, options());
    expect(writesDuringUp).toBeGreaterThanOrEqual(3);
    expect(await pendingIds()).toEqual([ENV_ID]);
  });

  it('stops refreshing the pending connection file when the pipeline fails, and removes it', async () => {
    h.cleanup();
    h = createHarness({ pendingRefreshMs: 5 });
    await seedEnvironment(h, { image: false, container: null });
    h.helper.upError = () => new DevcontainerCommandError('devcontainer up', 1, '', 'postCreateCommand failed');
    const originalUp = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return originalUp(p);
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await pendingIds()).toEqual([]);
  });

  it('opens an environment by its ID', async () => {
    await seedEnvironment(h);
    const result = await h.service.openEnvironment(ENV_ID, options());
    expect(result.environment.id).toBe(ENV_ID);
    expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
  });

  it('rejects an unknown environment ID', async () => {
    const error = await rejection(h.service.openEnvironment(OTHER_ID, options()));
    expect(error.message).toBe(PipelineTexts.environmentMissing);
  });

  it('does nothing with a running, up-to-date container', async () => {
    await seedEnvironment(h, { container: 'running' });
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.helper.builds).toEqual([]);
  });

  it('updates to a newer image: pull, build, replace, new record, old images removed', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    const oldBase = `mcr.microsoft.com/devcontainers/base@${DIGEST_OLD}`;
    h.docker.images.add(oldBase);
    let busyDuringBuild: Environment['busy'];
    h.helper.onBuild = async () => {
      busyDuringBuild = (await entry())?.busy;
    };

    await h.service.open(TARGET, options());

    expect(h.docker.log).toContain(`pull ${BASE_IMAGE}`);
    expect(h.progress.details).toEqual([Messages.newerImage]);
    expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
    expect(busyDuringBuild).toMatchObject({ operation: 'update', windowId: WINDOW_ID });
    const env = await entry();
    expect(env?.busy).toBeUndefined();
    expect(env?.buildRecord).toMatchObject({ environmentImage: IMAGE_2, buildNumber: 2, images: { [BASE_IMAGE]: DIGEST_NEW } });
    expect(env?.lastBuildNumber).toBe(2);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    expect(h.docker.images.has(IMAGE_2)).toBe(true);
    expect(h.docker.log).toContain(`rmi ${oldBase}`);
    // The old image goes only after the new container exists (concept 7.7 update order).
    const upIndex = h.helper.calls.indexOf(`up ${IMAGE_2} --remove-existing-container`);
    expect(upIndex).toBeGreaterThan(h.helper.calls.indexOf(`build ${IMAGE_2}`));
    expect(h.docker.log.indexOf(`rmi ${IMAGE_1}`)).toBeGreaterThan(h.docker.log.indexOf(`pull ${BASE_IMAGE}`));
    // A replaced container gets the ownership fix.
    expect(h.docker.execs.some((e) => e.user === 'root')).toBe(true);
    expect(h.progress.steps).toEqual(['checkingImage', 'downloadingImage', 'preparing', 'starting']);
  });

  it('keeps the tag of the base image that the pull moved to the new image (classic image store)', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    const oldBase = `mcr.microsoft.com/devcontainers/base@${DIGEST_OLD}`;
    h.docker.images.add(oldBase);
    h.docker.images.add(BASE_IMAGE);
    h.docker.imageIds.set(oldBase, 'sha256:old-base');
    h.docker.imageIds.set(BASE_IMAGE, 'sha256:old-base');
    const pull = h.docker.pullImage.bind(h.docker);
    h.docker.pullImage = async (reference, pullOptions) => {
      await pull(reference, pullOptions);
      h.docker.imageIds.set(reference, 'sha256:new-base');
    };
    await h.service.open(TARGET, options());
    expect(h.docker.images.has(oldBase)).toBe(false);
    expect(h.docker.images.has(BASE_IMAGE)).toBe(true);
    expect(h.docker.log).not.toContain(`rmi ${BASE_IMAGE}`);
  });

  it('keeps a base image that another environment still uses', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    await seedEnvironment(h, {
      id: OTHER_ID,
      repository: 'acme/web',
      container: null,
      record: { images: { [BASE_IMAGE]: DIGEST_OLD }, environmentImage: environmentImageName(OTHER_ID, 1) },
    });
    await h.service.open(TARGET, options());
    expect(h.docker.log.filter((l) => l.includes(`@${DIGEST_OLD}`))).toEqual([]);
  });

  it('pulls only the changed images on an update', async () => {
    h.helper.config = { build: { dockerfile: 'Dockerfile' }, features: {} };
    h.helper.files[DEFAULT_CONFIG_PATH] = {
      configText: '{ "build": { "dockerfile": "Dockerfile" } }',
      dockerfilePath: '.devcontainer/Dockerfile',
      dockerfileText: 'FROM node:22 AS build\nFROM ubuntu:24.04\n',
    };
    const hash = configHash('{ "build": { "dockerfile": "Dockerfile" } }', 'FROM node:22 AS build\nFROM ubuntu:24.04\n');
    await seedEnvironment(h, { record: { configHash: hash, images: { 'node:22': DIGEST_OLD, 'ubuntu:24.04': DIGEST_NEW }, features: {} } });
    h.checker.outcome = checked({ 'node:22': DIGEST_NEW, 'ubuntu:24.04': DIGEST_NEW });
    await h.service.open(TARGET, options());
    expect(h.docker.log.filter((l) => l.startsWith('pull'))).toEqual(['pull node:22']);
    expect((await entry())?.buildRecord?.images).toEqual({ 'node:22': DIGEST_NEW, 'ubuntu:24.04': DIGEST_NEW });
  });

  it('skips the update without a registry and starts the local environment', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
    await h.service.open(TARGET, options());
    expect(h.ui.infos).toEqual([Messages.registryUnreachable]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
    expect((await entry())?.buildRecord?.images).toEqual({ [BASE_IMAGE]: DIGEST_OLD });
  });

  it('keeps the old container when the build fails, and warns', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.helper.buildError = () => new DevcontainerCommandError('devcontainer build', 1, '', 'Feature download failed');
    const result = await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    expect(h.helper.ups).toEqual([expect.objectContaining({ image: IMAGE_1, removeExistingContainer: false })]);
    expect(result.containerName).toBe(NAME);
    const env = await entry();
    expect(env?.buildRecord).toMatchObject({ environmentImage: IMAGE_1, images: { [BASE_IMAGE]: DIGEST_OLD } });
    expect(env?.busy).toBeUndefined();
    expect(h.docker.images.has(IMAGE_1)).toBe(true);
  });

  it('keeps the old environment when a download of an update fails', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.docker.images.add(BASE_IMAGE);
    h.docker.pullError = () => new CommandError('docker pull', 1, '', 'net/http: TLS handshake timeout');
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
  });

  it('creates the container again from the previous image when the replacement fails', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs') : undefined);
    const result = await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([
      `up ${IMAGE_2} --remove-existing-container`,
      `up ${IMAGE_1} --remove-existing-container`,
    ]);
    expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_1);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ image: IMAGE_1, state: 'running' })]);
    expect(result.containerName).toBe(NAME);
  });

  it('creates a removed container from the environment image without a registry', async () => {
    await seedEnvironment(h, { container: null });
    h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
    await h.service.open(TARGET, options());
    expect(h.ui.infos).toEqual([Messages.registryUnreachable]);
    expect(h.helper.calls.filter((c) => c.startsWith('up') || c.startsWith('build'))).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.containersOf(ENV_ID)[0]).toMatchObject({ name: NAME, state: 'running' });
    // A new container gets the ownership fix.
    expect(h.docker.execs.find((e) => e.user === 'root')?.command.slice(-2)).toEqual(['/workspaces/api', 'vscode']);
  });

  it('builds a removed environment image again', async () => {
    await seedEnvironment(h, { image: false });
    await h.service.open(TARGET, options());
    expect(h.docker.log).toContain(`pull ${BASE_IMAGE}`);
    expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
  });

  it('starts the existing container without a registry when the environment image is missing, without a build', async () => {
    await seedEnvironment(h, { image: false });
    h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
    await h.service.open(TARGET, options());
    // Concept 7.7 "Without internet access": the container exists → it starts; the next connection builds.
    expect(h.helper.builds).toEqual([]);
    expect(h.ui.infos).toEqual([Messages.registryUnreachable]);
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.ups).toEqual([expect.objectContaining({ image: IMAGE_1, removeExistingContainer: false })]);
    expect((await entry())?.busy).toBeUndefined();
  });

  it('starts the existing container without a registry when the build record is missing (registry restored)', async () => {
    await seedEnvironment(h, { record: null, container: 'stopped' });
    h.docker.images.add(IMAGE_1);
    h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
    await h.service.open(TARGET, options());
    // Concept 7.5: the next connection with internet access rebuilds.
    expect(h.helper.builds).toEqual([]);
    expect(h.ui.infos).toEqual([Messages.registryUnreachable]);
    expect(h.helper.ups).toEqual([expect.objectContaining({ image: IMAGE_1, removeExistingContainer: false })]);
    expect((await entry())?.buildRecord).toBeUndefined();
  });

  it('still tries a build without a registry when no container exists', async () => {
    await seedEnvironment(h, { image: false, container: null });
    h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
    h.helper.buildError = () => new DevcontainerCommandError('devcontainer build', 1, '', 'dial tcp: lookup ghcr.io: no such host');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(h.helper.builds).toHaveLength(1);
  });

  it('fails with buildFailed without any old container or image', async () => {
    await seedEnvironment(h, { image: false, container: null });
    h.helper.buildError = () => new DevcontainerCommandError('devcontainer build', 1, '', 'failed');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    const env = await entry();
    expect(env).toBeDefined();
    expect(env?.busy).toBeUndefined();
    expect(await pendingIds()).toEqual([]);
  });

  it('rebuilds an environment without build record (registry restored from volumes)', async () => {
    await seedEnvironment(h, { record: null, container: 'stopped' });
    h.docker.images.add(IMAGE_1); // the image of the existing container
    await h.service.open(TARGET, options());
    // The existing tag is not reused, so the old container keeps its image until it is replaced.
    expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
    const env = await entry();
    expect(env?.buildRecord).toMatchObject({ buildNumber: 2, images: { [BASE_IMAGE]: DIGEST_NEW } });
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });

  describe('missing workspace volume', () => {
    it('asks and never creates an empty volume without an answer', async () => {
      await seedEnvironment(h, { volume: false, container: null });
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('cancelled');
      expect(h.ui.prompts).toEqual([`filesMissing ${REPO}`]);
      expect(h.docker.volumes.size).toBe(0);
      expect(h.helper.calls).toEqual([]);
      expect(await pendingIds()).toEqual([]);
    });

    it('clones again on the default branch and continues', async () => {
      await seedEnvironment(h, { volume: false, container: null });
      h.ui.filesMissingAnswer = 'cloneAgain';
      h.docker.execHandler = (_c, command) => (command[0] === 'sh' && command[2]?.includes('rev-list') ? { stdout: gitExecOutput('main') } : {});
      await h.service.open(TARGET, options());
      expect(h.docker.volumes.get(NAME)).toEqual({ [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
      expect(h.helper.clones).toEqual([{ volumeName: NAME, repository: REPO, branch: 'main', token: TOKEN }]);
      expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
      expect(h.docker.runs.map((run) => run.image)).toEqual([IMAGE_1]);
      expect(h.docker.execs.some((e) => e.user === 'root')).toBe(true);
      expect((await entry())?.gitSummary).toMatchObject({ branch: 'main', uncommittedFiles: 0, stashes: 0 });
    });

    it('keeps a selected configuration when the files are cloned again', async () => {
      await seedEnvironment(h, { volume: false, container: null });
      h.ui.filesMissingAnswer = 'cloneAgain';
      const python = '.devcontainer/python/devcontainer.json';
      h.helper.files[python] = { configText: '{ "image": "python:3.12" }' };
      h.helper.config = { image: 'python:3.12' };
      h.checker.outcome = checked({ 'python:3.12': DIGEST_NEW });
      await h.service.openEnvironment(ENV_ID, options({ configPath: python, forceRebuild: true }));
      expect(h.helper.builds.map((build) => build.configPath)).toEqual([python]);
      const env = await entry();
      expect(env?.configPath).toBe(python);
      expect(env?.buildRecord?.configPath).toBe(python);
    });

    it('removes the new volume again when the clone fails', async () => {
      await seedEnvironment(h, { volume: false, container: null });
      h.ui.filesMissingAnswer = 'cloneAgain';
      h.helper.cloneError = new CommandError('git clone', 128, '', 'Could not resolve host: github.com');
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('firstOpenOffline');
      expect(h.docker.volumes.size).toBe(0);
      expect((await entry())?.busy).toBeUndefined();
    });

    it('deletes the environment when asked', async () => {
      await seedEnvironment(h, { volume: false, container: null });
      h.ui.filesMissingAnswer = 'deleteEnvironment';
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('cancelled');
      expect(await h.registry.list()).toEqual([]);
      expect(h.docker.images.has(IMAGE_1)).toBe(false);
      expect(h.docker.volumes.size).toBe(0);
    });
  });

  describe('changed configuration', () => {
    beforeEach(async () => {
      await seedEnvironment(h, { record: { configHash: 'sha256:old' } });
    });

    it('asks, and "Rebuild now" builds and replaces', async () => {
      h.ui.configurationChangedAnswer = 'rebuildNow';
      let busy: Environment['busy'];
      h.helper.onBuild = async () => {
        busy = (await entry())?.busy;
      };
      await h.service.open(TARGET, options());
      expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
      expect(busy?.operation).toBe('rebuild');
      expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
      expect((await entry())?.buildRecord?.configHash).toBe(configHash(DEFAULT_CONFIG_TEXT));
    });

    it('"Later" starts the existing environment without an update', async () => {
      h.ui.configurationChangedAnswer = 'later';
      h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_OLD });
      await h.service.open(TARGET, options());
      expect(h.checker.calls).toEqual([]);
      expect(h.helper.builds).toEqual([]);
      expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
      expect((await entry())?.buildRecord?.configHash).toBe('sha256:old');
    });
  });

  it('starts the existing container when the configuration is broken', async () => {
    await seedEnvironment(h);
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "dockerComposeFile": "compose.yml" }' };
    await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.composeNotSupported]);
    expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
    expect(h.helper.builds).toEqual([]);
  });

  it('starts the existing container when read-configuration fails', async () => {
    await seedEnvironment(h);
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
    await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
  });

  it('reports a broken configuration as buildFailed when nothing exists to start', async () => {
    await seedEnvironment(h, { image: false, container: null });
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(error.detail).toContain('SyntaxError');
  });

  it('rebuilds on request even without a changed digest', async () => {
    await seedEnvironment(h);
    h.settings.updateImagesOnConnect = false;
    let busy: Environment['busy'];
    h.helper.onBuild = async () => {
      busy = (await entry())?.busy;
    };
    await h.service.openEnvironment(ENV_ID, options({ forceRebuild: true }));
    expect(h.checker.calls).toHaveLength(1);
    expect(h.docker.log).toContain(`pull ${BASE_IMAGE}`);
    expect(busy?.operation).toBe('rebuild');
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
    expect(h.progress.details).toEqual([]);
  });

  it('uses a local base image when its download fails during a rebuild, without recording the new digest', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.docker.images.add(BASE_IMAGE);
    h.docker.pullError = () => new CommandError('docker pull', 1, '', 'toomanyrequests');
    await h.service.openEnvironment(ENV_ID, options({ forceRebuild: true }));
    expect(h.helper.calls).toContain(`build ${IMAGE_2}`);
    expect((await entry())?.buildRecord?.images).toEqual({ [BASE_IMAGE]: DIGEST_OLD });
  });

  it('increments the build number past the registry and the local tags', async () => {
    await seedEnvironment(h, { record: { buildNumber: 2, environmentImage: environmentImageName(ENV_ID, 2) }, extra: { lastBuildNumber: 5 } });
    h.docker.images.add(environmentImageName(ENV_ID, 7));
    await h.service.openEnvironment(ENV_ID, options({ forceRebuild: true }));
    const image8 = environmentImageName(ENV_ID, 8);
    expect(h.helper.calls).toContain(`build ${image8}`);
    const env = await entry();
    expect(env?.buildRecord?.buildNumber).toBe(8);
    expect(env?.lastBuildNumber).toBe(8);
    expect(await h.docker.listImageTags(environmentImageRepository(ENV_ID))).toEqual([image8]);
  });

  it('switches the configuration and rebuilds', async () => {
    await seedEnvironment(h);
    const python = '.devcontainer/python/devcontainer.json';
    h.helper.files[python] = { configText: '{ "image": "python:3.12" }' };
    h.helper.config = { image: 'python:3.12' };
    h.checker.outcome = checked({ 'python:3.12': DIGEST_NEW });
    await h.service.open(TARGET, options({ configPath: python }));
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.builds[0].configPath).toBe(python);
    const env = await entry();
    expect(env?.configPath).toBe(python);
    expect(env?.buildRecord).toMatchObject({ configPath: python, images: { 'python:3.12': DIGEST_NEW }, features: {} });
  });

  it('does not check images when the setting is off', async () => {
    await seedEnvironment(h);
    h.settings.updateImagesOnConnect = false;
    await h.service.open(TARGET, options());
    expect(h.checker.calls).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    expect(h.progress.steps).toEqual(['starting']);
  });

  it('keeps the order of the steps when the setting is off and the environment image is missing', async () => {
    await seedEnvironment(h, { image: false });
    h.settings.updateImagesOnConnect = false;
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.progress.steps).toEqual(['checkingImage', 'downloadingImage', 'preparing', 'starting']);
  });

  it('keeps the order of the steps when "Rebuild now" follows a changed configuration with the setting off', async () => {
    await seedEnvironment(h, { record: { configHash: 'sha256:old' } });
    h.settings.updateImagesOnConnect = false;
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.open(TARGET, options());
    expect(h.progress.steps).toEqual(['checkingImage', 'downloadingImage', 'preparing', 'starting']);
  });

  it('shows a build of the helper image during a reconnect as a detail of "Checking for a newer image"', async () => {
    await seedEnvironment(h);
    const original = h.helper.ensureImage.bind(h.helper);
    h.helper.ensureImage = async (opts?: { onOutput?: (text: string) => void }) => {
      opts?.onOutput?.('Step 1/5 : FROM node');
      return original();
    };
    await h.service.open(TARGET, options());
    expect(h.progress.steps).toEqual(['checkingImage', 'starting']);
    expect(h.progress.details).toEqual([PipelineTexts.preparingHelper, '']);
  });

  it('shows the rebuild of an existing helper image from a new base image as an update, not as a first preparation', async () => {
    await seedEnvironment(h);
    const original = h.helper.ensureImage.bind(h.helper);
    h.helper.ensureImage = async (opts?: EnsureImageOptions) => {
      opts?.onBuild?.('refresh');
      opts?.onOutput?.('#5 [2/4] RUN apt-get update');
      return original();
    };
    await h.service.open(TARGET, options());
    expect(h.progress.steps).toEqual(['checkingImage', 'starting']);
    expect(h.progress.details).toEqual([PipelineTexts.updatingHelper, '']);
    expect(PipelineTexts.updatingHelper).not.toMatch(/once/);
  });

  it('checks the base image of the helper only when the setting updateImagesOnConnect is on', async () => {
    await seedEnvironment(h);
    const seen: Array<boolean | undefined> = [];
    const original = h.helper.ensureImage.bind(h.helper);
    h.helper.ensureImage = async (opts?: EnsureImageOptions) => {
      seen.push(opts?.checkBaseImage);
      return original();
    };
    await h.service.open(TARGET, options());
    await h.service.stop(ENV_ID);
    h.settings.updateImagesOnConnect = false;
    await h.service.open(TARGET, options());
    expect(seen).toEqual([true, false]);
  });

  it('does not wait for the check of the base image of the helper: the image check runs meanwhile, so both share its time limit', async () => {
    await seedEnvironment(h);
    const dockerfilePath = path.join(h.root, 'helper', 'Dockerfile');
    fs.mkdirSync(path.dirname(dockerfilePath), { recursive: true });
    fs.writeFileSync(dockerfilePath, 'FROM node:24-trixie-slim\n');
    const tag = helperImageTag('FROM node:24-trixie-slim\n');
    const eightDaysAgo = new Date(T0 - 8 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      h.paths.helperState,
      JSON.stringify({
        version: 1,
        images: { [tag]: { baseImage: 'node:24-trixie-slim', baseDigest: DIGEST_OLD, checkedAt: eightDaysAgo, lastUsedAt: eightDaysAgo } },
        lastCleanupAt: new Date(T0).toISOString(),
      }),
    );
    const helperDocker: HelperImageDocker = {
      imageExists: async () => true,
      imageId: async () => 'sha256:helper',
      buildImage: async () => {
        throw new Error('no build expected');
      },
      listImagesByLabel: async () => [],
      removeImage: async () => false,
    };
    // The registry does not answer the helper: its lookup runs until its time limit (5 seconds) ends it.
    let lookupSignal: AbortSignal | undefined;
    let answer: (value: 'unreachable') => void = () => undefined;
    const checks: Array<Promise<void>> = [];
    h.helper.ensureImage = (opts?: EnsureImageOptions) =>
      ensureHelperImage(helperDocker, dockerfilePath, {
        ...opts,
        statePath: h.paths.helperState,
        clock: { now: () => T0 },
        baseDigest: (_reference, signal) => {
          lookupSignal = signal;
          return new Promise((resolve) => (answer = resolve));
        },
        onBaseImageCheck: (check) => checks.push(check),
      });
    let helperLookupRunning: boolean | undefined;
    const check = h.checker.check.bind(h.checker);
    h.checker.check = async (references) => {
      helperLookupRunning = lookupSignal !== undefined && !lookupSignal.aborted;
      return check(references);
    };

    await h.service.open(TARGET, options());
    expect(h.checker.calls).toHaveLength(1);
    // The image check started while the lookup of the helper still ran: the two waits overlap, and the start is delayed
    // by one time limit at most (NFR-08), not by two.
    expect(helperLookupRunning).toBe(true);

    answer('unreachable');
    await Promise.all(checks);
    expect(lookupSignal?.aborted).toBe(true);
    expect(JSON.parse(fs.readFileSync(h.paths.helperState, 'utf8')).images[tag]).toMatchObject({
      checkedAt: eightDaysAgo,
      attemptedAt: new Date(T0).toISOString(),
    });
  });

  it('offers the sign-in once per registry that requires it', async () => {
    await seedEnvironment(h);
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, {}, { authRequired: ['ghcr.io', 'registry-1.docker.io'], failed: [FEATURE] });
    await h.service.open(TARGET, options());
    expect(h.ui.signIns).toEqual(['ghcr.io', 'docker.io']);
    expect(h.helper.builds).toEqual([]);
  });

  it('treats a failing image check like an unreachable registry', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.checker.error = new Error('unexpected');
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
  });

  it('waits for the busy mark of another live window, then gives up', async () => {
    await seedEnvironment(h, { extra: { busy: { operation: 'rebuild', since: '2026-09-24T15:39:00.000Z', pid: 999, windowId: 'window-2' } } });
    h.alivePids.add(999);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(error.message).toBe(PipelineTexts.environmentBusy(REPO));
    expect(h.sleeps.length).toBe(4);
    expect(h.helper.calls).toEqual([]);
    expect((await entry())?.busy?.windowId).toBe('window-2');
  });

  it('continues when the other window clears its busy mark', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, extra: { busy: { operation: 'rebuild', since: '2026-09-24T15:39:00.000Z', pid: 999, windowId: 'window-2' } } });
    h.alivePids.add(999);
    const originalGet = h.registry.get.bind(h.registry);
    let reads = 0;
    h.registry.get = async (id: string) => {
      if (++reads === 1) await h.registry.updateEnvironment(ENV_ID, (e) => void delete e.busy);
      return originalGet(id);
    };
    await h.service.open(TARGET, options());
    expect(h.sleeps.length).toBe(1);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
  });

  it('ignores the busy mark of an ended process', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, extra: { busy: { operation: 'rebuild', since: '2026-09-24T15:39:00.000Z', pid: 999, windowId: 'window-2' } } });
    await h.service.open(TARGET, options());
    expect(h.sleeps).toEqual([]);
    expect((await entry())?.busy).toBeUndefined();
  });

  it('ignores a busy mark older than six hours although a process with its ID exists (reused process ID)', async () => {
    const since = new Date(T0 - BUSY_MARK_MAX_AGE_MS - 60_000).toISOString();
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, extra: { busy: { operation: 'rebuild', since, pid: 999, windowId: 'window-2' } } });
    h.alivePids.add(999);
    await h.service.open(TARGET, options());
    expect(h.sleeps).toEqual([]);
    expect(h.helper.calls).toContain(`up ${IMAGE_2} --remove-existing-container`);
  });

  it('clears a busy mark that an ended window left behind, also when this open needs no build', async () => {
    await seedEnvironment(h, { extra: { busy: { operation: 'update', since: '2026-09-24T15:39:00.000Z', pid: 999, windowId: 'window-2' } } });
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect((await entry())?.busy).toBeUndefined();
  });

  it('keeps a live busy mark that another window set while this open ran', async () => {
    await seedEnvironment(h);
    h.alivePids.add(999);
    const mark = { operation: 'rebuild' as const, since: new Date(T0).toISOString(), pid: 999, windowId: 'window-2' };
    const exec = h.docker.exec.bind(h.docker);
    h.docker.exec = async (container, command, execOptions) => {
      if (command.includes('--show-current')) {
        await h.registry.updateEnvironment(ENV_ID, (e) => {
          e.busy = mark;
        });
      }
      return exec(container, command, execOptions);
    };
    await h.service.open(TARGET, options());
    expect((await entry())?.busy).toEqual(mark);
  });

  it('ends as cancelled when Cancel is pressed during the Git read after the start; the read gets the signal', async () => {
    await seedEnvironment(h);
    const controller = new AbortController();
    h.docker.execHandler = (_container, command) => {
      if (command.includes('--show-current')) controller.abort();
      return { stdout: 'main\n' };
    };
    const error = await rejection(h.service.open(TARGET, options({ signal: controller.signal })));
    expect(error.code).toBe('cancelled');
    const read = h.docker.execs.find((call) => call.command.includes('--show-current'));
    expect(read?.signal).toBe(controller.signal);
    expect(await pendingIds()).toEqual([]);
    expect((await entry())?.lastUsedAt).toBe('2026-09-20T10:00:00.000Z');
  });

  describe('with window status files', () => {
    const mark = { operation: 'rebuild' as const, since: '2026-09-24T15:39:00.000Z', pid: 999, windowId: 'window-2' };

    it('ignores the busy mark of a live process whose window has no recent status file', async () => {
      const statuses: WindowStatus[] = [];
      h = recreate({ windowStatuses: async () => statuses });
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, extra: { busy: mark } });
      h.alivePids.add(999);
      await h.service.open(TARGET, options());
      expect(h.sleeps).toEqual([]);
      expect((await entry())?.busy).toBeUndefined();
    });

    it('waits for the busy mark when its window has a recent status file of the same process', async () => {
      const statuses: WindowStatus[] = [
        { windowId: 'window-2', pid: 999, environmentId: null, state: 'active', updatedAt: new Date(T0).toISOString() },
      ];
      h = recreate({ windowStatuses: async () => statuses });
      await seedEnvironment(h, { extra: { busy: mark } });
      h.alivePids.add(999);
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.message).toBe(PipelineTexts.environmentBusy(REPO));
    });

    it('falls back to the process check when the status files cannot be read', async () => {
      h = recreate({
        windowStatuses: async () => {
          throw new Error('unreadable');
        },
      });
      await seedEnvironment(h, { extra: { busy: mark } });
      h.alivePids.add(999);
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.message).toBe(PipelineTexts.environmentBusy(REPO));
    });
  });

  it('clears its busy mark and the pending file when the update fails without fallback', async () => {
    await seedEnvironment(h, { image: false, container: null });
    h.helper.upError = () => new DevcontainerCommandError('devcontainer up', 1, '', 'failed');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect((await entry())?.busy).toBeUndefined();
    expect(await pendingIds()).toEqual([]);
  });

  it('ends with cancelled and clears the busy mark when the signal aborts during a build', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    const controller = new AbortController();
    h.helper.onBuild = () => controller.abort();
    const error = await rejection(h.service.open(TARGET, options({ signal: controller.signal })));
    expect(error.code).toBe('cancelled');
    const env = await entry();
    expect(env?.busy).toBeUndefined();
    expect(env?.buildRecord?.environmentImage).toBe(IMAGE_1);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
  });

  it('ends with cancelled for an already aborted signal', async () => {
    await seedEnvironment(h);
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(h.service.open(TARGET, options({ signal: controller.signal })));
    expect(error.code).toBe('cancelled');
    expect(h.helper.calls).toEqual([]);
  });

  it('starts a stopped container with docker start when the helper cannot be prepared', async () => {
    await seedEnvironment(h);
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    const result = await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.helperFailed]);
    const container = h.docker.containersOf(ENV_ID)[0];
    expect(h.docker.log).toContain(`start ${container.id}`);
    expect(container.state).toBe('running');
    expect(result.containerName).toBe(NAME);
  });

  it('fails with helperFailed when neither the helper nor a container is available', async () => {
    await seedEnvironment(h, { container: null });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.helper.calls.filter((c) => c === 'ensureImage')).toHaveLength(1);
  });

  it('starts the old container again when the replacement fails before it was removed', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
    const before = h.docker.containersOf(ENV_ID)[0].id;
    h.helper.upFailsBeforeRemoval = true;
    h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid override') : undefined);
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${IMAGE_1}`]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: before, state: 'running' })]);
    // No ownership fix for the old container.
    expect(h.docker.execs.some((e) => e.command.join(' ').includes('chown'))).toBe(false);
  });

  it('creates the container again from the image of the old container when a replacement without record fails', async () => {
    await seedEnvironment(h, { record: null, container: 'stopped' });
    h.docker.images.add(IMAGE_1);
    h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'bad runArgs') : undefined);
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([
      `up ${IMAGE_2} --remove-existing-container`,
      `up ${IMAGE_1} --remove-existing-container`,
    ]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ image: IMAGE_1, state: 'running' })]);
    expect((await entry())?.buildRecord).toBeUndefined();
  });

  it('does not report a deleted entry as a build failure', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.helper.onBuild = async () => {
      await h.registry.remove(ENV_ID);
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.noEnvironment(REPO));
    expect(h.ui.warnings).toEqual([]);
  });

  it('shows the reason "newer image" only after a comparison with a build record', async () => {
    await seedEnvironment(h, { record: null, container: null });
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.progress.details).toEqual([]);
  });

  describe('interrupted first open', () => {
    const staleCreate = { operation: 'create' as const, since: '2026-09-24T15:00:00.000Z', pid: 999, windowId: 'window-old' };

    it('completes the clone first, then prepares the environment', async () => {
      await seedEnvironment(h, { record: null, container: null, extra: { busy: staleCreate } });
      await h.service.open(TARGET, options());
      expect(h.helper.clones).toEqual([{ volumeName: NAME, repository: REPO, branch: 'main', token: TOKEN }]);
      expect(h.helper.calls).toContain(`build ${IMAGE_1}`);
      const env = await entry();
      expect(env?.busy).toBeUndefined();
      expect(env?.buildRecord?.environmentImage).toBe(IMAGE_1);
      expect(h.progress.steps[0]).toBe('downloadingRepository');
    });

    it('restores the mark of the ended window when the clone fails again, so the next open retries', async () => {
      await seedEnvironment(h, { record: null, container: null, extra: { busy: staleCreate } });
      h.helper.cloneError = new CommandError('git clone', 128, '', 'Could not resolve host: github.com');
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('firstOpenOffline');
      // Not a mark of this (live) window: the environment must not look busy, and other windows must not wait for it.
      expect((await entry())?.busy).toEqual(staleCreate);

      h.helper.cloneError = undefined;
      await h.service.open(TARGET, options());
      expect(h.helper.clones).toHaveLength(2);
      expect((await entry())?.busy).toBeUndefined();
    });

    it('restores the mark of the ended window when the resumed clone is cancelled', async () => {
      await seedEnvironment(h, { record: null, container: null, extra: { busy: staleCreate } });
      const controller = new AbortController();
      h.helper.onClone = () => controller.abort();
      const error = await rejection(h.service.open(TARGET, options({ signal: controller.signal })));
      expect(error.code).toBe('cancelled');
      expect((await entry())?.busy).toEqual(staleCreate);
    });
  });

  it('runs operations on the same repository one after the other', async () => {
    await seedEnvironment(h);
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    h.helper.onBuild = async () => {
      order.push('build start');
      await blocked;
      order.push('build end');
    };
    const first = h.service.openEnvironment(ENV_ID, options({ forceRebuild: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = h.service.stop(ENV_ID).then(() => order.push('stop'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['build start', 'build end', 'stop']);
  });
});

describe('open: selected configuration missing on the branch', () => {
  const PYTHON = '.devcontainer/python/devcontainer.json';
  const PYTHON_TEXT = '{ "image": "python:3.12" }';

  beforeEach(async () => {
    // Built with the selected configuration python; now on a branch (release-1) that has only the default one.
    await seedEnvironment(h, {
      record: { configPath: PYTHON, configHash: configHash(PYTHON_TEXT), images: { 'python:3.12': DIGEST_NEW }, features: {} },
      extra: { configPath: PYTHON },
    });
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
  });

  /** Back on a branch (main) with both configurations. */
  function onMain(): void {
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT }, [PYTHON]: { configText: PYTHON_TEXT } };
    h.helper.config = { image: 'python:3.12' };
    h.checker.outcome = checked({ 'python:3.12': DIGEST_NEW });
    h.ui.prompts.length = 0;
  }

  it('keeps the selection when the user answers "Later", so it applies again on a branch that has it', async () => {
    await h.service.open(TARGET, options());
    expect(h.ui.infos).toEqual([Messages.configurationNotFound(PYTHON, 'default')]);
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
    expect(h.helper.builds).toEqual([]);
    expect((await entry())?.configPath).toBe(PYTHON);

    onMain();
    await h.service.open(TARGET, options());
    expect(h.helper.calls).toContain(`readConfiguration ${PYTHON}`);
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    expect((await entry())?.configPath).toBe(PYTHON);
  });

  it('builds the fallback on "Rebuild now", and the selection again on a branch that has it', async () => {
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.open(TARGET, options());
    let env = await entry();
    expect(env?.buildRecord?.configPath).toBe(DEFAULT_CONFIG_PATH);
    expect(env?.configPath).toBe(PYTHON);

    onMain();
    await h.service.open(TARGET, options());
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
    expect(h.helper.builds.map((build) => build.configPath)).toEqual([DEFAULT_CONFIG_PATH, PYTHON]);
    env = await entry();
    expect(env?.buildRecord?.configPath).toBe(PYTHON);
    expect(env?.configPath).toBe(PYTHON);
  });

  it('configurationChanged compares the build record with the configuration that the pipeline would use', async () => {
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.open(TARGET, options());
    // Built from the fallback of this branch: nothing to ask after a branch switch to it.
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(false);
    onMain();
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
  });
});

describe('open: registry lost', () => {
  const OLD_NAME = resourceName(REPO, OTHER_ID);

  beforeEach(() => {
    h.docker.volumes.set(OLD_NAME, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
  });

  it('uses the labeled volume of the repository instead of creating a second environment (Docker was stopped)', async () => {
    h.docker.running = false;
    h.dockerStopped = true;
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).toBe(OTHER_ID);
    expect((await h.registry.list()).map((e) => e.id)).toEqual([OTHER_ID]);
    expect([...h.docker.volumes.keys()]).toEqual([OLD_NAME]);
    expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([]);
    expect(h.helper.clones).toEqual([]);
    // Without a build record, the environment is built again (concept 7.5).
    expect(h.helper.calls).toContain(`build ${environmentImageName(OTHER_ID, 1)}`);
    expect((await h.registry.get(OTHER_ID))?.buildRecord?.environmentImage).toBe(environmentImageName(OTHER_ID, 1));
  });

  it('uses the labeled volume of the repository when registry.json is invalid', async () => {
    fs.writeFileSync(h.paths.registry, '{ broken');
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).toBe(OTHER_ID);
    expect((await h.registry.list()).map((e) => e.id)).toEqual([OTHER_ID]);
    expect(h.helper.clones).toEqual([]);
  });

  it('restores the owner from the volume label; its login follows at the open', async () => {
    const result = await h.service.open(TARGET, options());
    expect(result.environment.owner).toEqual(ACCOUNT);
  });

  /** A harness whose service claims entries without owner (fakeClaims), with a restored volume without owner. */
  function withClaims(grant: () => Promise<boolean>): ClaimSpy {
    const claim = fakeClaims(grant);
    h = recreate({ claims: { claim } });
    h.docker.volumes.set(OLD_NAME, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO });
    return claim;
  }

  it('creates an environment of the account next to a restored volume of another account, without a claim (concept D-3)', async () => {
    const claim = withClaims(async () => true);
    h.docker.volumes.set(OLD_NAME, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    const result = await h.service.open(TARGET, options());
    expect(claim).not.toHaveBeenCalled();
    expect(result.environment.id).not.toBe(OTHER_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toEqual([expect.objectContaining({ volumeName: result.environment.volumeName, token: TOKEN })]);
    // The environment of the other account is restored, stays as it is, and is not named.
    expect(await h.registry.get(OTHER_ID)).toMatchObject({ volumeName: OLD_NAME, owner: { id: OTHER_ACCOUNT.id } });
    expect(h.docker.volumes.get(OLD_NAME)).toEqual({ [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    expect(h.docker.containersOf(OTHER_ID)).toEqual([]);
    expect([...h.ui.infos, ...h.ui.warnings]).toEqual([]);
  });

  it('claims a restored volume of an older version (without owner) for the account, and uses it', async () => {
    const claim = withClaims(async () => true);
    const result = await h.service.open(TARGET, options());
    // Start is a command of the user: the claim may ask (EnvironmentClaims, mode interactive).
    expect(claim).toHaveBeenCalledWith(ACCOUNT, TOKEN, expect.objectContaining({ environmentIds: [OTHER_ID], mode: 'interactive' }));
    expect(result.environment.id).toBe(OTHER_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect((await h.registry.list()).map((e) => e.id)).toEqual([OTHER_ID]);
    expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([]);
    expect(h.helper.clones).toEqual([]);
  });

  it('leaves a restored volume of an older version hidden when the claim fails, and creates an environment of the account', async () => {
    const claim = withClaims(async () => false);
    const result = await h.service.open(TARGET, options());
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(ACCOUNT, TOKEN, expect.objectContaining({ environmentIds: [OTHER_ID], mode: 'interactive' }));
    expect(result.environment.id).not.toBe(OTHER_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toEqual([expect.objectContaining({ volumeName: result.environment.volumeName })]);
    // The entry of the older version keeps its volume and stays without owner, so the account that created it can claim it.
    expect((await h.registry.get(OTHER_ID))?.owner).toBeUndefined();
    expect(h.docker.volumes.has(OLD_NAME)).toBe(true);
    expect(h.ui.warnings).toEqual([]);

    // The next open uses the environment of the account; the entry of the older version is not asked about again.
    const again = await h.service.open(TARGET, options());
    expect(again.environment.id).toBe(result.environment.id);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(h.helper.clones).toHaveLength(1);
  });

  it('leaves a restored volume of an older version hidden without claims, and creates an environment of the account', async () => {
    h.docker.volumes.set(OLD_NAME, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO });
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).not.toBe(OTHER_ID);
    expect((await h.registry.list()).map((e) => e.id).sort()).toEqual([OTHER_ID, result.environment.id].sort());
    expect((await h.registry.get(OTHER_ID))?.owner).toBeUndefined();
  });

  it('refuses the restored entry of an older version as not assigned when it is opened by its ID and the claim fails', async () => {
    let online = false;
    const claim = withClaims(async () => online);
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    const error = await rejection(h.service.openEnvironment(OTHER_ID, options()));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(error.message).toBe(Messages.olderEnvironmentNotAssigned(REPO));
    expect(error.code).not.toBe('otherAccount');
    expect((await h.registry.get(OTHER_ID))?.owner).toBeUndefined();
    expect(h.helper.calls).toEqual([]);

    // Try again, with GitHub reachable: the open claims it and uses it.
    online = true;
    const result = await h.service.openEnvironment(OTHER_ID, options());
    expect(claim).toHaveBeenCalledTimes(2);
    expect(result.environment.id).toBe(OTHER_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toEqual([]);
  });

  it('creates the environment when only volumes of other repositories exist, and restores those', async () => {
    h.docker.volumes.delete(OLD_NAME);
    h.docker.volumes.set(resourceName('acme/web', OTHER_ID), { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/web' });
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).not.toBe(OTHER_ID);
    expect(h.helper.clones).toHaveLength(1);
    expect((await h.registry.list()).map((e) => e.repository).sort()).toEqual(['acme/api', 'acme/web']);
  });

  it('restores no volume that has the labels of an environment but another name (labels that a mount could set)', async () => {
    h.docker.volumes.delete(OLD_NAME);
    h.docker.volumes.set('myvol', { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    // The name of another repository's environment with the labels of this repository.
    h.docker.volumes.set(resourceName('acme/web', OTHER_ID), { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    expect(await h.service.reconcileFromVolumes()).toBe(0);
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).not.toBe(OTHER_ID);
    expect(result.environment.volumeName).toBe(resourceName(REPO, result.environment.id));
    expect(h.helper.gitPreparations.map((preparation) => preparation.volumeName)).toEqual([result.environment.volumeName]);
  });
});

describe('open: failed lifecycle command', () => {
  const POST_START_FAILED = 'postStartCommand from devcontainer.json failed.';
  const POST_CREATE_FAILED = 'postCreateCommand from devcontainer.json failed.';

  it('opens a stopped environment whose postStartCommand fails, with a warning', async () => {
    await seedEnvironment(h);
    h.helper.lifecycleFailure = () => POST_START_FAILED;
    const result = await h.service.open(TARGET, options());
    expect(result.containerName).toBe(NAME);
    expect(h.ui.warnings).toEqual([PipelineTexts.lifecycleCommandFailed('postStartCommand')]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ state: 'running', image: IMAGE_1 })]);
    // The window connects: the container stays in use.
    expect(await pendingIds()).toEqual([ENV_ID]);
    expect((await entry())?.busy).toBeUndefined();
  });

  it('keeps a new environment whose postCreateCommand fails on the first open', async () => {
    // The remote user is only in the metadata of the image (not in the configuration that read-configuration returns).
    h.helper.config = { image: BASE_IMAGE, features: { [FEATURE]: {} } };
    h.helper.remoteUser = 'node';
    h.helper.lifecycleFailure = () => POST_CREATE_FAILED;
    const result = await h.service.open(TARGET, options());
    const env = (await h.registry.findForAccount(REPO, ACCOUNT.id))!;
    const image = environmentImageName(env.id, 1);
    expect(result.environment.id).toBe(env.id);
    expect(env.buildRecord?.environmentImage).toBe(image);
    expect(h.docker.volumes.has(env.volumeName)).toBe(true);
    expect(h.docker.images.has(image)).toBe(true);
    expect(h.docker.containersOf(env.id)).toEqual([expect.objectContaining({ state: 'running', image })]);
    expect(env.remoteUser).toBe('node');
    expect(h.docker.execs.find((e) => e.user === 'root')?.command.slice(-2)).toEqual(['/workspaces/api', 'node']);
    expect(h.ui.warnings).toEqual([PipelineTexts.lifecycleCommandFailed('postCreateCommand')]);
  });

  it('keeps the new container of an update whose postCreateCommand fails', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.helper.lifecycleFailure = (image) => (image === IMAGE_2 ? POST_CREATE_FAILED : undefined);
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_2);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ state: 'running', image: IMAGE_2 })]);
    expect(h.ui.warnings).toEqual([PipelineTexts.lifecycleCommandFailed('postCreateCommand')]);
  });

  it('warns about a failed command that the helper reports with the kept container', async () => {
    await seedEnvironment(h);
    h.helper.lifecycleFailureReport = 'result';
    h.helper.lifecycleFailure = () => 'migrate of postStartCommand from devcontainer.json failed.';
    await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([PipelineTexts.lifecycleCommandFailed('postStartCommand')]);
    expect((await entry())?.remoteUser).toBe('vscode');
    expect(await pendingIds()).toEqual([ENV_ID]);
  });

  it('fails as before when the container does not run after the failed command', async () => {
    await seedEnvironment(h);
    h.helper.upError = () =>
      new DevcontainerCommandError('devcontainer up', 1, '', '', { outcome: 'error', description: POST_START_FAILED, containerId: 'container-gone' });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.ui.warnings).toEqual([]);
    expect(await pendingIds()).toEqual([]);
  });

  it('fails as before for another error of up after the container was started', async () => {
    await seedEnvironment(h);
    // The CLI names the container also for other errors after its start: only a failed lifecycle command counts.
    h.helper.lifecycleFailure = () => 'An error occurred setting up the container.';
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.ui.warnings).toEqual([]);
  });
});

describe('open: private image on ghcr.io', () => {
  const PRIVATE_IMAGE = 'ghcr.io/acme/private-base:latest';
  const SESSION = { registry: 'ghcr.io', username: 'octocat', password: 'gho_packages' };

  function usePrivateImage(): void {
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: `{ "image": "${PRIVATE_IMAGE}" }` };
    h.helper.config = { image: PRIVATE_IMAGE };
    h.checker.outcome = checked({ [PRIVATE_IMAGE]: DIGEST_NEW });
    // Docker has no credentials for ghcr.io.
    h.docker.pullError = (_reference, credentials) =>
      credentials ? undefined : new CommandError('docker pull', 1, '', 'Error response from daemon: denied');
  }

  it('downloads the image with the credentials of the GitHub session', async () => {
    const asked: string[] = [];
    h = recreate({
      pullCredentials: async (reference) => {
        asked.push(reference);
        return reference.startsWith('ghcr.io/') ? { ...SESSION } : undefined;
      },
    });
    usePrivateImage();
    await h.service.open(TARGET, options());
    expect(asked).toEqual([PRIVATE_IMAGE]);
    expect(h.docker.pulls).toEqual([{ reference: PRIVATE_IMAGE, credentials: SESSION }]);
    expect(h.helper.builds).toHaveLength(1);
    expect([...h.logger.infos, ...h.logger.warnings].join('\n')).not.toContain(SESSION.password);
  });

  const UNENCRYPTED = () =>
    new UserFacingError('unencryptedDockerConnection', Messages.unencryptedDockerConnection, 'The Docker endpoint tcp://10.0.0.5:2375 is not encrypted.');

  it('downloads without the GitHub sign-in when the connection to Docker is not encrypted (a public image)', async () => {
    h = recreate({ pullCredentials: async () => ({ ...SESSION }) });
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: `{ "image": "${PRIVATE_IMAGE}" }` };
    h.helper.config = { image: PRIVATE_IMAGE };
    h.checker.outcome = checked({ [PRIVATE_IMAGE]: DIGEST_NEW });
    h.docker.pullError = (_reference, credentials) => (credentials ? UNENCRYPTED() : undefined);
    await h.service.open(TARGET, options());
    expect(h.docker.pulls).toEqual([{ reference: PRIVATE_IMAGE, credentials: SESSION }, { reference: PRIVATE_IMAGE }]);
    expect(h.helper.builds).toHaveLength(1);
    expect(h.logger.warnings.some((w) => w.includes('tcp://10.0.0.5:2375') && w.includes('without the GitHub sign-in'))).toBe(true);
  });

  it('names the unencrypted connection when the image also fails without the sign-in', async () => {
    h = recreate({ pullCredentials: async () => ({ ...SESSION }) });
    usePrivateImage();
    h.docker.pullError = (_reference, credentials) =>
      credentials ? UNENCRYPTED() : new CommandError('docker pull', 1, '', 'Error response from daemon: denied');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('unencryptedDockerConnection');
    expect(error.message).toBe(Messages.unencryptedDockerConnection);
    expect(error.detail).toContain('denied');
    expect(h.docker.pulls).toEqual([{ reference: PRIVATE_IMAGE, credentials: SESSION }, { reference: PRIVATE_IMAGE }]);
    expect(h.helper.builds).toEqual([]);
  });

  it('pulls with the credentials of Docker when there are no others', async () => {
    h = recreate({ pullCredentials: async () => undefined });
    await h.service.open(TARGET, options());
    expect(h.docker.pulls).toEqual([{ reference: BASE_IMAGE }]);
  });

  it('pulls with the credentials of Docker when the credentials cannot be read', async () => {
    h = recreate({
      pullCredentials: async () => {
        throw new Error('keychain locked');
      },
    });
    await h.service.open(TARGET, options());
    expect(h.docker.pulls).toEqual([{ reference: BASE_IMAGE }]);
    expect(h.logger.warnings.some((w) => w.includes('keychain locked'))).toBe(true);
  });
});

describe('stop', () => {
  it('records the Git summary from the container, then stops it', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.docker.execHandler = () => ({ stdout: gitExecOutput('feature-z', [5, 6, 2]) });
    await h.service.stop(ENV_ID);
    const container = h.docker.containersOf(ENV_ID)[0];
    expect(h.docker.execs[0]).toMatchObject({ container: container.id, user: 'vscode' });
    expect(h.docker.execs[0].command.slice(-1)).toEqual(['/workspaces/api']);
    expect((await entry())?.gitSummary).toMatchObject({ branch: 'feature-z', uncommittedFiles: 5, unpushedCommits: 6, stashes: 2 });
    expect(container.state).toBe('stopped');
    expect(h.docker.log).toEqual([`stop ${container.id}`]);
  });

  it('keeps the previous summary when Git fails, and stops anyway', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.docker.execHandler = () => ({ exitCode: 127, stderr: 'Git is not installed.' });
    await h.service.stop(ENV_ID);
    expect((await entry())?.gitSummary).toMatchObject({ branch: 'main', uncommittedFiles: 3 });
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('does nothing when Docker does not run', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.docker.running = false;
    await h.service.stop(ENV_ID);
    expect(h.docker.execs).toEqual([]);
    expect(h.docker.log).toEqual([]);
    expect(h.dockerStarts).toBe(0);
  });

  it('does nothing for a stopped container or an unknown environment', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await h.service.stop(ENV_ID);
    await h.service.stop(OTHER_ID);
    expect(h.docker.log).toEqual([]);
  });

  it('does not stop a container that another live window is updating', async () => {
    const busy = { operation: 'update' as const, since: '2026-09-24T15:39:00.000Z', pid: 999, windowId: 'window-2' };
    await seedEnvironment(h, { container: 'running', extra: { busy } });
    h.alivePids.add(999);
    const error = await rejection(h.service.stop(ENV_ID));
    expect(error.message).toBe(PipelineTexts.environmentBusy(REPO));
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
    expect(h.docker.log).toEqual([]);

    // The mark of an ended process does not count.
    h.alivePids.delete(999);
    await h.service.stop(ENV_ID);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });
});

describe('delete', () => {
  it('removes container, images, unused base images, volume, entry, and the files of the environment', async () => {
    await seedEnvironment(h, {
      container: 'running',
      record: { images: { [BASE_IMAGE]: DIGEST_OLD } },
      extra: { additionalVolumes: ['api-data', 'shared-cache'] },
    });
    await seedEnvironment(h, {
      id: OTHER_ID,
      repository: 'acme/web',
      container: null,
      extra: { additionalVolumes: ['shared-cache'] },
    });
    h.docker.images.add(environmentImageName(ENV_ID, 3));
    h.docker.volumes.set('api-data', additionalVolumeLabels());
    h.docker.volumes.set('shared-cache', additionalVolumeLabels());
    await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
    await h.sessionFiles.writeOperation({ environmentId: ENV_ID, operation: 'delete', requestedAt: new Date(0).toISOString(), requestedBy: WINDOW_ID, reason: 'manual' });
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: new Date(0).toISOString() });

    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: ['api-data', 'shared-cache'] }));

    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    expect(h.docker.images.has(environmentImageName(ENV_ID, 3))).toBe(false);
    expect(h.docker.log).toContain(`rmi mcr.microsoft.com/devcontainers/base@${DIGEST_OLD}`);
    expect(h.docker.volumes.has(NAME)).toBe(false);
    expect(h.docker.volumes.has('api-data')).toBe(false);
    expect(h.docker.volumes.has('shared-cache')).toBe(true);
    expect((await h.registry.list()).map((e) => e.id)).toEqual([OTHER_ID]);
    expect(await pendingIds()).toEqual([]);
    expect(await h.sessionFiles.readOperations()).toEqual([]);
    expect(await h.sessionFiles.readReopen()).toBeUndefined();
    // The other environment keeps its image.
    expect(h.docker.images.has(environmentImageName(OTHER_ID, 1))).toBe(true);
  });

  it('removes only the confirmed additional volumes, and keeps a volume that another program created under a recorded name', async () => {
    // `late` was recorded after the question (for example by a rebuild in another window); `db` now belongs to Compose.
    await seedEnvironment(h, { extra: { additionalVolumes: ['api-data', 'db', 'late'] } });
    h.docker.volumes.set('api-data', additionalVolumeLabels());
    h.docker.volumes.set('db', { 'com.docker.compose.project': 'shop', 'com.docker.compose.volume': 'db' });
    h.docker.volumes.set('late', additionalVolumeLabels());
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: ['api-data', 'db', 'gone'] }));
    expect(h.docker.volumes.has('api-data')).toBe(false);
    expect(h.docker.volumes.has('db')).toBe(true);
    expect(h.docker.volumes.has('late')).toBe(true);
    expect(h.logger.infos).toContain('The volume db is kept, because the Docker Compose project shop created it.');
  });

  it('keeps a recorded volume that the policy gives to something else by its name, also when the user confirmed it', async () => {
    await seedEnvironment(h, { extra: { additionalVolumes: ['vscode', 'api-data'] } });
    h.docker.volumes.set('vscode', {});
    h.docker.volumes.set('api-data', additionalVolumeLabels());
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: ['vscode', 'api-data'] }));
    expect(h.docker.volumes.has('vscode')).toBe(true);
    expect(h.docker.volumes.has('api-data')).toBe(false);
  });

  it('removes only volumes whose labels make them its own, and names why it keeps each other one', async () => {
    await seedEnvironment(h, { extra: { additionalVolumes: ['own', 'legacy', 'other-env', 'other-owner', 'no-owner'] } });
    h.docker.volumes.set('own', additionalVolumeLabels());
    // Recorded by a version before the labels: the user removes it.
    h.docker.volumes.set('legacy', {});
    h.docker.volumes.set('other-env', additionalVolumeLabels(OTHER_ID));
    h.docker.volumes.set('other-owner', additionalVolumeLabels(ENV_ID, OTHER_ACCOUNT));
    // A volume without an owner label (an entry of an older version) is its own by the ID.
    h.docker.volumes.set('no-owner', additionalVolumeLabels(ENV_ID, null));
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: ['own', 'legacy', 'other-env', 'other-owner', 'no-owner'] }));
    expect(h.docker.volumes.has('own')).toBe(false);
    expect(h.docker.volumes.has('no-owner')).toBe(false);
    expect(h.docker.volumes.has('legacy')).toBe(true);
    expect(h.docker.volumes.has('other-env')).toBe(true);
    expect(h.docker.volumes.has('other-owner')).toBe(true);
    const unlabeled = 'its labels do not show that this environment created it (for example, a version of Dev Environments before these labels created it)';
    expect(h.logger.infos).toEqual(
      expect.arrayContaining([
        `The volume legacy is kept, because ${unlabeled}.`,
        'The volume other-env is kept, because another environment created it.',
        'The volume other-owner is kept, because another environment created it.',
      ]),
    );
    expect(h.docker.log.filter((line) => line.startsWith('volume rm ') && !line.endsWith(NAME))).toEqual(['volume rm own', 'volume rm no-owner']);
  });

  it('names for the question only the volumes that Delete would remove', async () => {
    await seedEnvironment(h, { extra: { additionalVolumes: ['own', 'legacy', 'gone', 'shared'] } });
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: null, extra: { additionalVolumes: ['shared'] } });
    h.docker.volumes.set('own', additionalVolumeLabels());
    h.docker.volumes.set('legacy', {});
    h.docker.volumes.set('shared', additionalVolumeLabels());
    expect(await h.service.removableAdditionalVolumes(ENV_ID)).toEqual(['own']);
    expect(await h.service.removableAdditionalVolumes('f0000001-0000-4000-8000-000000000001')).toEqual([]);
  });

  it('removes the tag of an unused base image that the removal by digest keeps (classic image store)', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    const oldBase = `mcr.microsoft.com/devcontainers/base@${DIGEST_OLD}`;
    // The classic image store: the tag and the digest reference name the same image; `docker image rm <digest
    // reference>` removes only that reference.
    h.docker.images.add(oldBase);
    h.docker.images.add(BASE_IMAGE);
    h.docker.imageIds.set(oldBase, 'sha256:base');
    h.docker.imageIds.set(BASE_IMAGE, 'sha256:base');
    h.docker.images.add('mcr.microsoft.com/devcontainers/base:other');
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: [] }));
    expect(h.docker.log.filter((line) => line.startsWith('rmi mcr.'))).toEqual([`rmi ${oldBase}`, `rmi ${BASE_IMAGE}`]);
    expect(h.docker.images.has(BASE_IMAGE)).toBe(false);
    expect(h.docker.images.has('mcr.microsoft.com/devcontainers/base:other')).toBe(true);
  });

  it('keeps additional volumes unless asked, and a reopen record of another environment', async () => {
    await seedEnvironment(h, { extra: { additionalVolumes: ['api-data'] } });
    h.docker.volumes.set('api-data', {});
    h.sessionFiles.writeReopenSync({ environmentId: OTHER_ID, closedAt: new Date(0).toISOString() });
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: [] }));
    expect(h.docker.volumes.has('api-data')).toBe(true);
    expect((await h.sessionFiles.readReopen())?.environmentId).toBe(OTHER_ID);
  });

  it('keeps a base image that another environment uses', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', record: { images: { [BASE_IMAGE]: DIGEST_OLD }, environmentImage: environmentImageName(OTHER_ID, 1) } });
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: [] }));
    expect(h.docker.log.filter((l) => l.includes(DIGEST_OLD))).toEqual([]);
  });

  it('keeps the entry and clears the busy mark when the volume cannot be removed', async () => {
    await seedEnvironment(h);
    h.docker.volumesInUse.add(NAME);
    await expect(h.service.delete(ENV_ID, options({ additionalVolumesToRemove: [] }))).rejects.toBeInstanceOf(CommandError);
    const env = await entry();
    expect(env).toBeDefined();
    expect(env?.busy).toBeUndefined();
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it('marks the environment busy while it is deleted', async () => {
    await seedEnvironment(h);
    let busy: Environment['busy'];
    const original = h.docker.removeVolume.bind(h.docker);
    h.docker.removeVolume = async (name: string) => {
      busy = (await entry())?.busy;
      return original(name);
    };
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: [] }));
    expect(busy?.operation).toBe('delete');
  });

  it('removes only the files of an environment that is not in the registry', async () => {
    await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: [] }));
    expect(await pendingIds()).toEqual([]);
    expect(h.docker.log).toEqual([]);
  });
});

describe('safetyCheck', () => {
  it('reads the Git state through the helper and records it', async () => {
    await seedEnvironment(h);
    const summary = await h.service.safetyCheck(ENV_ID, options());
    expect(summary).toMatchObject({ branch: 'main', uncommittedFiles: 2, unpushedCommits: 1 });
    expect((await entry())?.gitSummary).toMatchObject({ uncommittedFiles: 2, unpushedCommits: 1 });
  });

  it('returns undefined when the volume is missing, without creating one', async () => {
    await seedEnvironment(h, { volume: false });
    expect(await h.service.safetyCheck(ENV_ID, options())).toBeUndefined();
    expect(h.helper.calls).toEqual([]);
    expect(h.docker.volumes.size).toBe(0);
  });

  it('returns the last recorded state when Git cannot read the repository, so known changes are still named', async () => {
    const env = await seedEnvironment(h);
    h.helper.gitSummaryResult = new CommandError('git summary', 2, '', "sh: cd: can't cd to /workspaces/api");
    expect(await h.service.safetyCheck(ENV_ID, options())).toEqual(env.gitSummary);
  });

  it('returns undefined when Git cannot read the repository and no state is recorded', async () => {
    await seedEnvironment(h, { extra: { gitSummary: undefined } });
    h.helper.gitSummaryResult = new CommandError('git summary', 2, '', "sh: cd: can't cd to /workspaces/api");
    expect(await h.service.safetyCheck(ENV_ID, options())).toBeUndefined();
  });

  it('starts Docker when needed', async () => {
    await seedEnvironment(h);
    h.dockerStopped = true;
    await h.service.safetyCheck(ENV_ID, options());
    expect(h.progress.steps).toEqual(['startingDocker']);
  });
});

describe('switchBranch', () => {
  it('switches with the token and records the branch', async () => {
    await seedEnvironment(h);
    let busy: Environment['busy'];
    const original = h.helper.switchBranch.bind(h.helper);
    h.helper.switchBranch = async (p) => {
      busy = (await entry())?.busy;
      return original(p);
    };
    await h.service.switchBranch(ENV_ID, 'feature-x', options());
    expect(h.helper.calls).toEqual(['switchBranch feature-x']);
    expect(busy?.operation).toBe('switchBranch');
    const env = await entry();
    expect(env?.gitSummary).toMatchObject({ branch: 'feature-x', uncommittedFiles: 3 });
    expect(env?.busy).toBeUndefined();
  });

  it('passes the message of Git and clears the busy mark', async () => {
    await seedEnvironment(h);
    h.helper.switchError = new UserFacingError('gitSwitchFailed', Messages.gitSwitchFailed('feature-x', 'error: Your local changes would be overwritten'));
    const error = await rejection(h.service.switchBranch(ENV_ID, 'feature-x', options()));
    expect(error.code).toBe('gitSwitchFailed');
    const env = await entry();
    expect(env?.gitSummary?.branch).toBe('main');
    expect(env?.busy).toBeUndefined();
    expect(h.rejectedTokens).toEqual([]);
  });

  it('reports a token that github.com rejects in the fetch of Switch branch to the sign-in state (the sign-in fix)', async () => {
    await seedEnvironment(h);
    h.helper.switchError = new UserFacingError(
      'gitSwitchFailed',
      Messages.gitSwitchFailed('feature-x', "fatal: Authentication failed for 'https://github.com/acme/api.git/'"),
      "fatal: Authentication failed for 'https://github.com/acme/api.git/'",
    );
    const error = await rejection(h.service.switchBranch(ENV_ID, 'feature-x', options()));
    expect(error.code).toBe('gitSwitchFailed');
    expect(h.rejectedTokens).toEqual([h.token]);
    expect((await entry())?.busy).toBeUndefined();
  });

  it('reports missing files without creating a volume', async () => {
    await seedEnvironment(h, { volume: false });
    const error = await rejection(h.service.switchBranch(ENV_ID, 'feature-x', options()));
    expect(error.code).toBe('filesMissing');
    expect(h.docker.volumes.size).toBe(0);
  });
});

describe('configuration queries', () => {
  it('configurationChanged compares path and hash with the build record', async () => {
    await seedEnvironment(h);
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(false);
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "image": "ubuntu" }' };
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
  });

  it('configurationChanged is true when the configuration is missing on the branch or no record exists', async () => {
    await seedEnvironment(h);
    h.helper.files = {};
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', record: null });
    expect(await h.service.configurationChanged(OTHER_ID, options())).toBe(true);
  });

  it('configurationChanged is false for a missing volume or environment', async () => {
    await seedEnvironment(h, { volume: false });
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(false);
    expect(await h.service.configurationChanged(OTHER_ID, options())).toBe(false);
    expect(h.docker.volumes.size).toBe(0);
  });

  it('listConfigurations lists the configurations in the volume', async () => {
    await seedEnvironment(h);
    h.helper.configurations = ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'];
    expect(await h.service.listConfigurations(ENV_ID, options())).toEqual(h.helper.configurations);
  });

  it('listConfigurations reports missing files', async () => {
    await seedEnvironment(h, { volume: false });
    const error = await rejection(h.service.listConfigurations(ENV_ID, options()));
    expect(error.code).toBe('filesMissing');
  });
});

describe('inspectStates and currentBranch', () => {
  it('reports container and volume state per environment', async () => {
    await seedEnvironment(h, { container: 'running' });
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: null, volume: false });
    const states = await h.service.inspectStates();
    expect(states?.get(ENV_ID)).toEqual({ container: 'running', volume: true });
    expect(states?.get(OTHER_ID)).toEqual({ container: 'missing', volume: false });
  });

  it('finds a volume without labels by its name', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.docker.volumes.set(NAME, {});
    expect((await h.service.inspectStates())?.get(ENV_ID)).toEqual({ container: 'stopped', volume: true });
  });

  it('returns undefined when Docker does not run, without starting it', async () => {
    await seedEnvironment(h);
    h.docker.running = false;
    expect(await h.service.inspectStates()).toBeUndefined();
    expect(h.dockerStarts).toBe(0);
  });

  it('currentBranch reads the branch from the container', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.docker.execHandler = () => ({ stdout: 'feature-q\n' });
    expect(await h.service.currentBranch(ENV_ID)).toBe('feature-q');
    expect(h.docker.execs[0]).toMatchObject({ container: NAME, user: 'vscode' });
    h.docker.execHandler = () => ({ exitCode: 1, stderr: 'container is not running' });
    expect(await h.service.currentBranch(ENV_ID)).toBeUndefined();
    h.docker.execHandler = () => ({ stdout: '\n' });
    expect(await h.service.currentBranch(ENV_ID)).toBeUndefined();
  });
});

describe('reconcileFromVolumes', () => {
  it('adds an entry for each labeled volume that the registry lacks', async () => {
    await seedEnvironment(h);
    const name = resourceName('acme/web', OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/web' });
    h.docker.volumes.set('bad', { [LABEL_ENVIRONMENT_ID]: '../x', [LABEL_REPOSITORY]: 'acme/bad' });
    h.docker.volumes.set('duplicate', {
      [LABEL_ENVIRONMENT_ID]: '11111111-2222-3333-4444-555555555555',
      [LABEL_REPOSITORY]: 'ACME/api',
      [LABEL_OWNER_ID]: ACCOUNT.id,
    });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    const added = await h.registry.get(OTHER_ID);
    expect(added).toMatchObject({
      repository: 'acme/web',
      volumeName: name,
      containerName: name,
      configPath: DEFAULT_CONFIG_PATH,
    });
    expect(added?.buildRecord).toBeUndefined();
    expect(await h.registry.list()).toHaveLength(2);
    expect(await h.service.reconcileFromVolumes()).toBe(0);
  });

  it('restores the additional volumes by their labels, so that another account cannot take them over', async () => {
    const name = resourceName('acme/api', OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/api', [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    h.docker.volumes.set('api-node_modules', additionalVolumeLabels(OTHER_ID, OTHER_ACCOUNT));
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toEqual(['api-node_modules']);
    // The first open of the signed-in account is refused the volume of the other account's restored environment.
    h.helper.config = { image: BASE_IMAGE, mounts: ['source=api-node_modules,target=/n,type=volume'] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('volume api-node_modules of another environment'));
  });

  it('restores only the volumes whose labels make them its own: not anonymous ones, not those of other programs, environments, or owners', async () => {
    const name = resourceName('acme/api', OTHER_ID);
    const anonymous = 'ab'.repeat(32);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/api' });
    h.docker.volumes.set('api-node_modules', additionalVolumeLabels(OTHER_ID, null));
    h.docker.volumes.set(anonymous, { 'com.docker.volume.anonymous': '' });
    h.docker.volumes.set('shop_db', { 'com.docker.compose.project': 'shop' });
    // Mounted by the container, but without the labels (a version before them, or `${devcontainerId}`).
    h.docker.volumes.set('api-history', {});
    h.docker.volumes.set('x-cache', additionalVolumeLabels('f0000001-0000-4000-8000-000000000001'));
    for (const volumes of [[name, 'api-node_modules', anonymous, 'api-history'], [name, 'api-node_modules', 'shop_db']]) {
      const container = h.docker.addContainer({ environmentId: OTHER_ID, name, state: 'stopped', image: environmentImageName(OTHER_ID, 1) });
      h.docker.containers.set(container.id, { ...container, volumes });
    }
    const other = h.docker.addContainer({ environmentId: 'f0000001-0000-4000-8000-000000000001', name: 'x', state: 'stopped', image: 'x' });
    h.docker.containers.set(other.id, { ...other, volumes: ['x-cache'] });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toEqual(['api-node_modules']);
  });

  it('lets a declined claim of a restored entry with only anonymous volumes create an environment of the account', async () => {
    const name = resourceName(REPO, OTHER_ID);
    const anonymous = 'cd'.repeat(32);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO });
    const container = h.docker.addContainer({ environmentId: OTHER_ID, name, state: 'stopped', image: environmentImageName(OTHER_ID, 1) });
    h.docker.containers.set(container.id, { ...container, volumes: [name, anonymous] });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toBeUndefined();
  });

  it('restores no volume that the policy gives to something else by its name', async () => {
    const name = resourceName(REPO, OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO });
    h.docker.volumes.set('api-node_modules', additionalVolumeLabels(OTHER_ID, null));
    const foreign = ['vscode', 'vsc-remote-containers', `api-${'0f'.repeat(16)}`, 'devenv-helper-cache', 'devenv-acme-web-12345678'];
    const container = h.docker.addContainer({ environmentId: OTHER_ID, name, state: 'stopped', image: environmentImageName(OTHER_ID, 1) });
    h.docker.containers.set(container.id, { ...container, volumes: [name, ...foreign, 'api-node_modules'] });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toEqual(['api-node_modules']);
  });

  it('restores one environment per repository and owner: two accounts, and one entry of an older version (concept D-3)', async () => {
    const ids = ['a0000001-0000-4000-8000-000000000001', 'a0000002-0000-4000-8000-000000000002', 'a0000003-0000-4000-8000-000000000003'];
    const skippedIds = ['b0000004-0000-4000-8000-000000000004', 'b0000005-0000-4000-8000-000000000005'];
    const volume = (id: string, owner: GitHubAccount | undefined): void => {
      const labels: Record<string, string> = { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: REPO };
      if (owner) labels[LABEL_OWNER_ID] = owner.id;
      h.docker.volumes.set(resourceName(REPO, id), labels);
    };
    volume(ids[0], ACCOUNT);
    volume(ids[1], OTHER_ACCOUNT);
    volume(ids[2], undefined);
    // A second volume of the same repository and owner is not added.
    volume(skippedIds[0], OTHER_ACCOUNT);
    volume(skippedIds[1], undefined);
    expect(await h.service.reconcileFromVolumes()).toBe(3);
    const entries = await h.registry.list();
    expect(entries.map((e) => [e.id, e.owner?.id])).toEqual([
      [ids[0], ACCOUNT.id],
      [ids[1], OTHER_ACCOUNT.id],
      [ids[2], undefined],
    ]);
    expect(h.logger.warnings.filter((warning) => warning.includes('another environment of the same owner'))).toEqual(
      skippedIds.map((id) => `The volume ${resourceName(REPO, id)} belongs to a repository that has another environment of the same owner. It is not added.`),
    );
    // Each account finds its own environment of the repository.
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id))?.id).toBe(ids[0]);
    expect((await h.registry.findForAccount(REPO, OTHER_ACCOUNT.id))?.id).toBe(ids[1]);
    expect((await h.registry.findUnowned(REPO))?.id).toBe(ids[2]);
  });

  it('does nothing when Docker does not run', async () => {
    h.docker.running = false;
    expect(await h.service.reconcileFromVolumes()).toBe(0);
  });
});

describe('abort while waiting for another operation', () => {
  it('ends the wait with cancelled', async () => {
    await seedEnvironment(h);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    h.helper.onBuild = () => blocked;
    const first = h.service.openEnvironment(ENV_ID, options({ forceRebuild: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const controller = new AbortController();
    const second = h.service.openEnvironment(ENV_ID, options({ signal: controller.signal }));
    controller.abort(abortError());
    const error = await rejection(second);
    expect(error.code).toBe('cancelled');
    release();
    await first;
  });
});

describe('accounts (concept 7.5, section 9 "Accounts")', () => {
  it('refuses to open an environment of another account by its ID, before it starts Docker or anything else', async () => {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT });
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('otherAccount');
    expect(error.message).toBe(Messages.otherAccount(REPO));
    expect(h.dockerStarts).toBe(0);
    expect(h.helper.calls).toEqual([]);
    expect(await pendingIds()).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('opens the repository of an environment of another account in an environment of the account (concept D-3)', async () => {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT });
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).not.toBe(ENV_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toEqual([expect.objectContaining({ volumeName: result.environment.volumeName, token: TOKEN })]);
    // The environment of the other account is not touched: no token, no start, no pending connection.
    expect(h.helper.gitPreparations.map((call) => call.volumeName)).toEqual([result.environment.volumeName]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
    expect(await pendingIds()).toEqual([result.environment.id]);
    expect((await entry())?.owner).toEqual(OTHER_ACCOUNT);
  });

  it('hides an entry of an older version without owner until a claim: the open is refused as not assigned', async () => {
    await seedEnvironment(h, { owner: null });
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).not.toBe('otherAccount');
    expect(error.message).toBe(Messages.olderEnvironmentNotAssigned(REPO));
    expect((await rejection(h.service.stop(ENV_ID))).message).toBe(Messages.olderEnvironmentNotAssigned(REPO));
    expect((await rejection(h.service.switchBranch(ENV_ID, 'dev', options()))).message).toBe(Messages.olderEnvironmentNotAssigned(REPO));
    expect(h.helper.calls).toEqual([]);
  });

  it('claims an entry of an older version at an open that no claim reached before (a retry, a reopen)', async () => {
    const claim = fakeClaims(async () => true);
    h = recreate({ claims: { claim } });
    await seedEnvironment(h, { owner: null });
    const result = await h.service.openEnvironment(ENV_ID, options());
    expect(claim).toHaveBeenCalledWith(ACCOUNT, TOKEN, expect.objectContaining({ environmentIds: [ENV_ID], mode: 'interactive' }));
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect((await entry())?.owner).toEqual(ACCOUNT);
    expect(h.helper.ups).toHaveLength(1);
  });

  it('claims without a question for an operation that is not interactive, and never for an entry of another account', async () => {
    const claim = fakeClaims(async () => false);
    h = recreate({ claims: { claim } });
    await seedEnvironment(h, { owner: null, container: 'running' });
    expect((await rejection(h.service.stop(ENV_ID))).message).toBe(Messages.olderEnvironmentNotAssigned(REPO));
    expect(claim).toHaveBeenCalledWith(ACCOUNT, TOKEN, expect.objectContaining({ environmentIds: [ENV_ID], mode: 'auto' }));
    expect(h.docker.log).toEqual([]);

    claim.mockClear();
    await h.registry.updateEnvironment(ENV_ID, (e) => {
      e.owner = OTHER_ACCOUNT;
    });
    expect((await rejection(h.service.openEnvironment(ENV_ID, options()))).code).toBe('otherAccount');
    expect((await rejection(h.service.switchBranch(ENV_ID, 'dev', options()))).code).toBe('otherAccount');
    expect(claim).not.toHaveBeenCalled();
  });

  it('asks for a sign-in: without an account, no environment is available', async () => {
    await seedEnvironment(h);
    h.token = undefined;
    expect((await rejection(h.service.openEnvironment(ENV_ID, options()))).code).toBe('signInRequired');
    expect((await rejection(h.service.stop(ENV_ID))).code).toBe('signInRequired');
  });

  it('refuses stop, delete, the safety check, a branch switch, and the configuration questions for another account', async () => {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT, container: 'running' });
    const operations: Array<[string, () => Promise<unknown>]> = [
      ['stop', () => h.service.stop(ENV_ID)],
      ['delete', () => h.service.delete(ENV_ID, options({ additionalVolumesToRemove: [] }))],
      ['safetyCheck', () => h.service.safetyCheck(ENV_ID, options())],
      ['switchBranch', () => h.service.switchBranch(ENV_ID, 'dev', options())],
      ['listConfigurations', () => h.service.listConfigurations(ENV_ID, options())],
      ['configurationChanged', () => h.service.configurationChanged(ENV_ID, options())],
    ];
    for (const [name, operation] of operations) {
      const error = await rejection(operation());
      expect(`${name}: ${error.code}`).toBe(`${name}: otherAccount`);
    }
    expect(h.docker.log).toEqual([]);
    expect(h.helper.calls).toEqual([]);
    expect(await entry()).toBeDefined();
    expect(h.docker.volumes.has(NAME)).toBe(true);
  });

  it('updates the login of the owner at an open (an owner restored from a label, or a renamed account)', async () => {
    await seedEnvironment(h, { owner: { id: ACCOUNT.id, login: '' } });
    await h.service.openEnvironment(ENV_ID, options());
    expect((await entry())?.owner).toEqual(ACCOUNT);
  });

  it('refuses when the session changes between the questions for the token and for the account', async () => {
    const service = recreate({
      auth: { getToken: vi.fn().mockResolvedValueOnce(TOKEN).mockResolvedValue('gho_other'), getAccount: async () => ACCOUNT },
    });
    h = service;
    await seedEnvironment(h);
    expect((await rejection(h.service.openEnvironment(ENV_ID, options()))).code).toBe('signInRequired');
    expect(h.helper.gitPreparations).toEqual([]);
  });
});

describe('container-only Git (concept section 9 "Git inside the container")', () => {
  it('writes the token of the owner at every open, also when the container runs already', async () => {
    await seedEnvironment(h, { container: 'running' });
    await h.service.openEnvironment(ENV_ID, options());
    h.token = 'gho_new_session';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.gitPreparations.map((call) => call.token)).toEqual([TOKEN, 'gho_new_session']);
    expect(h.helper.ups).toEqual([]);
  });

  it('writes it before `up`, once per open, and passes the variables of container-only Git', async () => {
    await seedEnvironment(h);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call === 'prepareGit' || call.startsWith('up'))).toEqual(['prepareGit', `up ${IMAGE_1}`]);
    expect(h.helper.ups[0].override).toMatchObject({
      containerEnv: expect.objectContaining({ GIT_CONFIG_GLOBAL: '/workspaces/.devenv+/gitconfig', DOCKER_CONFIG: '/workspaces/.devenv+/docker' }),
      remoteEnv: expect.objectContaining({ GIT_CONFIG_GLOBAL: '/workspaces/.devenv+/gitconfig', GIT_SSH_COMMAND: 'ssh -o IdentityAgent=none' }),
    });
    // The token is never part of the override configuration (variables of the container).
    expect(JSON.stringify(h.helper.ups[0].override)).not.toContain(TOKEN);
  });

  it('warns and opens the environment when the token cannot be written', async () => {
    await seedEnvironment(h);
    h.helper.prepareGitError = new CommandError('prepare Git', 4, '', 'The folder /workspaces/api does not exist.');
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.warnings).toEqual([Messages.gitSetupFailed]);
    expect(h.helper.ups).toHaveLength(1);
  });

  it('takes the identity from the GitHub profile of the account, once per window, with the session as fallback', async () => {
    const viewer = vi.fn(async () => ({ databaseId: 1001, login: 'octo', name: 'Octo Cat' }));
    h = recreate({ viewer });
    await seedEnvironment(h);
    await h.service.openEnvironment(ENV_ID, options());
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.gitPreparations.map((call) => call.identity)).toEqual([
      { name: 'Octo Cat', email: '1001+octo@users.noreply.github.com' },
      { name: 'Octo Cat', email: '1001+octo@users.noreply.github.com' },
    ]);
    expect(viewer).toHaveBeenCalledTimes(1);

    h = recreate({ viewer: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')) });
    await seedEnvironment(h);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.gitPreparations[0].identity).toEqual({ name: 'octo', email: '1001+octo@users.noreply.github.com' });
  });

  it('asks GitHub for the profile before the image check, not after it, so both time limits run at once', async () => {
    const events: string[] = [];
    const viewer = vi.fn(async () => {
      events.push('viewer');
      return { databaseId: 1001, login: 'octo', name: 'Octo Cat' };
    });
    h = recreate({
      viewer,
      imageChecker: {
        check: async () => {
          events.push('image check');
          return checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
        },
      },
    });
    await seedEnvironment(h);
    await h.service.openEnvironment(ENV_ID, options());
    expect(events).toEqual(['viewer', 'image check']);
    expect(h.helper.gitPreparations[0].identity.name).toBe('Octo Cat');
  });

  it('asks a new environment for the profile while the repository is cloned', async () => {
    const viewer = vi.fn(async () => ({ databaseId: 1001, login: 'octo', name: 'Octo Cat' }));
    h = recreate({ viewer });
    h.helper.onClone = () => {
      expect(viewer).toHaveBeenCalledTimes(1);
    };
    await h.service.open(TARGET, options());
    expect(h.helper.gitPreparations.map((call) => call.identity.name)).toEqual(['Octo Cat']);
    expect(viewer).toHaveBeenCalledTimes(1);
  });

  it('does not ask again for 10 minutes after a failed question; the fallback is used meanwhile', async () => {
    let now = T0;
    const viewer = vi.fn(async () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')));
    h = recreate({ viewer, clock: { now: () => now } });
    await seedEnvironment(h, { container: 'running' });
    const fallback = { name: 'octo', email: '1001+octo@users.noreply.github.com' };
    await h.service.openEnvironment(ENV_ID, options());
    now += 9 * 60_000;
    await h.service.openEnvironment(ENV_ID, options());
    expect(viewer).toHaveBeenCalledTimes(1);
    expect(h.helper.gitPreparations.map((call) => call.identity)).toEqual([fallback, fallback]);

    now += 2 * 60_000;
    viewer.mockResolvedValue({ databaseId: 1001, login: 'octo', name: 'Octo Cat' } as never);
    await h.service.openEnvironment(ENV_ID, options());
    expect(viewer).toHaveBeenCalledTimes(2);
    expect(h.helper.gitPreparations[2].identity.name).toBe('Octo Cat');
  });

  it('ends a question that GitHub does not answer after its time limit, with the fallback', async () => {
    const viewer = vi.fn(() => new Promise<never>(() => undefined));
    h = recreate({ viewer, viewerTimeoutMs: 20 });
    await seedEnvironment(h, { container: 'running' });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.gitPreparations[0].identity).toEqual({ name: 'octo', email: '1001+octo@users.noreply.github.com' });
  });

  it('ends as cancelled when Cancel is pressed while the question for the profile runs, without waiting for GitHub', async () => {
    const controller = new AbortController();
    const viewer = vi.fn(() => new Promise<never>(() => undefined));
    h = recreate({
      viewer,
      viewerTimeoutMs: 60_000,
      imageChecker: {
        check: async () => {
          controller.abort();
          return checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
        },
      },
    });
    await seedEnvironment(h, { container: 'running' });
    const error = await rejection(h.service.openEnvironment(ENV_ID, options({ signal: controller.signal })));
    expect(error.code).toBe('cancelled');
    expect(viewer).toHaveBeenCalledTimes(1);
    expect(h.helper.gitPreparations).toEqual([]);
  });

  it.each<[string, 'stopped' | 'running', Record<string, string>]>([
    ['a stopped container without the label (version 1)', 'stopped', {}],
    ['a running container without the label', 'running', {}],
    ['a container of an older version', 'stopped', { 'devenv.container-version': '1' }],
    ['a container of the version before (without the settings of the Dev Containers extension)', 'running', { 'devenv.container-version': '2' }],
  ])('creates %s again from the environment image, without a build; the volume stays', async (_name, state, labels) => {
    await seedEnvironment(h, { container: state, containerLabels: labels });
    const before = h.docker.containersOf(ENV_ID)[0].id;
    const result = await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    const containers = h.docker.containersOf(ENV_ID);
    expect(containers).toHaveLength(1);
    expect(containers[0].id).not.toBe(before);
    expect(containers[0].labels['devenv.container-version']).toBe('3');
    expect(h.docker.volumes.has(NAME)).toBe(true);
    expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
    expect(result.containerName).toBe(NAME);
    // A new container: the ~/.gitconfig of the remote user before the first attach.
    expect(h.docker.execs.some((e) => e.command[2] === HOME_GIT_CONFIG_SCRIPT)).toBe(true);
    // The files outside the volume are lost: the progress says so.
    expect(h.progress.details).toEqual([Messages.containerRecreated]);
  });

  it('switches off the forwarding of the Dev Containers extension in the override configuration of the container', async () => {
    await seedEnvironment(h, { container: null });
    await h.service.openEnvironment(ENV_ID, options());
    const override = h.helper.ups[0].override;
    expect(override.customizations).toEqual({ vscode: { settings: devContainersSettings() } });
    // Only through the settings: the variables of the Dev Containers extension keep their values.
    for (const env of [override.containerEnv, override.remoteEnv]) {
      for (const name of ['SSH_AUTH_SOCK', 'REMOTE_CONTAINERS_IPC', 'BROWSER', 'GNUPGHOME']) expect(env).not.toHaveProperty(name);
    }
    expect((override.runArgs as string[]).slice(-4)).toEqual(['--label', 'devenv.container-version=3', '--name', NAME]);
  });

  it('starts a current container as it is', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.execs.some((e) => e.command[2] === HOME_GIT_CONFIG_SCRIPT)).toBe(false);
    expect(h.progress.details).not.toContain(Messages.containerRecreated);
  });

  it('says so when a build replaces an old container, and names only the newer image for an update', async () => {
    await seedEnvironment(h, { container: 'stopped', containerLabels: {}, image: false });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.progress.details).toEqual([Messages.containerRecreated]);

    h.cleanup();
    h = createHarness();
    await seedEnvironment(h, { container: 'stopped', containerLabels: {}, record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.progress.details).toEqual([Messages.newerImage]);
  });

  describe.each<[string, (harness: Harness) => void]>([
    ['the configuration cannot be read', (harness) => {
      harness.helper.readConfigurationError = new DevcontainerCommandError('devcontainer read-configuration', 1, '', 'syntax error');
    }],
    ['the branch has no configuration', (harness) => {
      harness.helper.files = {};
    }],
    ['the configuration uses Docker Compose', (harness) => {
      harness.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: '{ "dockerComposeFile": "compose.yml", "service": "app" }' } };
    }],
  ])('an old container while %s', (_name, breakConfiguration) => {
    const CONFIG = { image: BASE_IMAGE, runArgs: ['--network=host', '--cap-add=SYS_PTRACE'], appPort: [3000] };

    it('is created again without the configuration, and again with it once it can be read', async () => {
      await seedEnvironment(h, { container: 'stopped', containerLabels: {} });
      h.helper.config = { ...CONFIG, features: { [FEATURE]: {} }, remoteUser: 'vscode' };
      const files = h.helper.files;
      breakConfiguration(h);
      const original = h.docker.containersOf(ENV_ID)[0].id;

      // The old container is replaced (it forwards the Git credentials of the computer), but the new one is provisional.
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
      const provisional = h.docker.containersOf(ENV_ID)[0];
      expect(provisional.id).not.toBe(original);
      expect(provisional.labels).toMatchObject({ 'devenv.container-version': '3', 'devenv.container-config': 'unknown' });
      expect(h.progress.details).toContain(Messages.containerRecreated);

      // While the configuration stays broken, the provisional container is only started.
      provisional.state = 'stopped';
      h.helper.calls.length = 0;
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([provisional.id]);

      // The configuration can be read again: the container gets its runArgs and appPort.
      h.helper.readConfigurationError = undefined;
      h.helper.files = files;
      h.docker.containersOf(ENV_ID)[0].state = 'stopped';
      h.helper.calls.length = 0;
      h.progress.details.length = 0;
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
      const last = h.helper.ups[h.helper.ups.length - 1];
      expect(last.override.runArgs).toEqual(expect.arrayContaining(['--network=host', '--cap-add=SYS_PTRACE']));
      expect(last.override.runArgs).not.toContain('devenv.container-config=unknown');
      expect(last.override.appPort).toEqual(['127.0.0.1:3000:3000']);
      const final = h.docker.containersOf(ENV_ID);
      expect(final).toHaveLength(1);
      expect(final[0].id).not.toBe(provisional.id);
      expect(final[0].labels['devenv.container-config']).toBeUndefined();
      expect(h.progress.details).toEqual([Messages.containerConfigApplied]);
      expect(h.helper.builds).toEqual([]);

      // From now on, it is current.
      final[0].state = 'stopped';
      h.helper.calls.length = 0;
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    });
  });

  it('never starts an old container with docker start when the workspace helper is not available', async () => {
    await seedEnvironment(h, { container: 'stopped', containerLabels: {} });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('builds when an old container has no environment image, and refuses to start it offline', async () => {
    await seedEnvironment(h, { container: 'stopped', containerLabels: {}, image: false });
    h.checker.outcome = { status: 'unreachable', registries: ['mcr.microsoft.com'] };
    h.helper.buildError = () => new DevcontainerCommandError('devcontainer build', 1, '', 'failed to resolve source metadata');
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('buildFailed');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
    expect(h.docker.volumes.has(NAME)).toBe(true);
  });
});

describe('the ~/.gitconfig of a new container when root may not write it (concept section 9, --cap-drop)', () => {
  const homeRuns = () => h.docker.execs.filter((exec) => exec.command[2] === HOME_GIT_CONFIG_SCRIPT);
  const DENIED = 'sh: 1: cannot create /home/vscode/.gitconfig: Permission denied';

  it('runs the script once, as root, when root may write it', async () => {
    await seedEnvironment(h, { container: null });
    await h.service.openEnvironment(ENV_ID, options());
    expect(homeRuns().map((exec) => exec.user)).toEqual(['root']);
  });

  it('lets the remote user write it when root may not (a container without the rights of root)', async () => {
    await seedEnvironment(h, { container: null });
    h.docker.execHandler = (_container, command, user) =>
      command[2] === HOME_GIT_CONFIG_SCRIPT && user === 'root' ? { exitCode: 2, stderr: DENIED } : {};
    await h.service.openEnvironment(ENV_ID, options());
    expect(homeRuns().map((exec) => ({ user: exec.user, command: exec.command }))).toEqual([
      { user: 'root', command: homeGitConfigCommand('vscode') },
      { user: 'vscode', command: homeGitConfigCommand('vscode') },
    ]);
    expect(h.logger.infos.some((line) => line.includes('could not be prepared as root') && line.includes(DENIED))).toBe(true);
    expect(h.logger.warnings.filter((line) => line.includes('Git configuration'))).toEqual([]);
  });

  it('warns when neither root nor the remote user may write it, and still opens the environment', async () => {
    await seedEnvironment(h, { container: null });
    h.docker.execHandler = (_container, command) => (command[2] === HOME_GIT_CONFIG_SCRIPT ? { exitCode: 2, stderr: DENIED } : {});
    await h.service.openEnvironment(ENV_ID, options());
    expect(homeRuns().map((exec) => exec.user)).toEqual(['root', 'vscode']);
    expect(h.logger.warnings.filter((line) => line.includes('Git configuration of vscode'))).toEqual([
      `The Git configuration of vscode in the container could not be prepared: ${DENIED}`,
    ]);
    expect(h.helper.ups).toHaveLength(1);
  });

  it('does not run it again when the remote user is root', async () => {
    h.helper.remoteUser = 'root';
    h.docker.execHandler = (_container, command) => (command[2] === HOME_GIT_CONFIG_SCRIPT ? { exitCode: 2, stderr: 'denied' } : {});
    await h.service.open(TARGET, options());
    expect(homeRuns().map((exec) => exec.user)).toEqual(['root']);
    expect(h.logger.warnings).toContain('The Git configuration of root in the container could not be prepared: denied');
  });
});

describe('the Git version of a new container (concept section 9 "Git inside the container")', () => {
  function gitVersion(stdout: string, exitCode = 0): void {
    h.docker.execHandler = (_container, command) => (command[0] === 'git' && command[1] === '--version' ? { exitCode, stdout } : {});
  }

  function versionChecks(): Array<{ user?: string; index: number }> {
    return h.docker.execs
      .map((exec, index) => ({ exec, index }))
      .filter(({ exec }) => exec.command[0] === 'git' && exec.command[1] === '--version')
      .map(({ exec, index }) => ({ user: exec.user, index }));
  }

  it('warns about Git before 2.9, whose credential requests may reach the computer', async () => {
    await seedEnvironment(h, { container: null });
    gitVersion('git version 2.8.6\n');
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.warnings).toEqual([Messages.oldGit('2.8.6')]);
    // As the remote user, after its ~/.gitconfig was written.
    const home = h.docker.execs.findIndex((exec) => exec.command[2] === HOME_GIT_CONFIG_SCRIPT);
    expect(versionChecks()).toEqual([{ user: 'vscode', index: expect.any(Number) }]);
    expect(versionChecks()[0].index).toBeGreaterThan(home);
    expect(h.helper.ups).toHaveLength(1);
  });

  it('only logs Git 2.9 to 2.31, which reads the configuration of the volume through ~/.gitconfig', async () => {
    await seedEnvironment(h, { container: null });
    gitVersion('git version 2.30.2\n');
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.warnings).toEqual([]);
    expect(h.logger.infos.some((line) => line.includes('git version 2.30.2') && line.includes('GIT_CONFIG_GLOBAL'))).toBe(true);
  });

  it.each<[string, string, number]>([
    ['a current Git', 'git version 2.39.5\n', 0],
    ['a container without Git', 'sh: git: not found\n', 127],
    ['an output that is not known', 'something else\n', 0],
  ])('says nothing for %s', async (_name, stdout, exitCode) => {
    await seedEnvironment(h, { container: null });
    gitVersion(stdout, exitCode);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.warnings).toEqual([]);
    expect(h.helper.ups).toHaveLength(1);
  });

  it('does not check a container that exists already', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    gitVersion('git version 2.8.6\n');
    await h.service.openEnvironment(ENV_ID, options());
    expect(versionChecks()).toEqual([]);
    expect(h.ui.warnings).toEqual([]);
  });
});

describe('host access policy in the pipeline (concept section 9 "Host access")', () => {
  it('refuses a first open before any build, and leaves nothing behind', async () => {
    h.helper.config = { image: BASE_IMAGE, privileged: true, mounts: ['source=/Users/x,target=/x,type=bind'] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('bind mount /Users/x, privileged mode'));
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
    expect(await h.registry.list()).toEqual([]);
  });

  it('names the settings that the policy does not know apart from those that need the computer, with the same code', async () => {
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--pull=always', '--privileged'] };
    const mixed = await rejection(h.service.open(TARGET, options()));
    expect(mixed.code).toBe('hostAccess');
    expect(mixed.message).toBe(Messages.hostAccessAndUnsupported('privileged mode', '--pull'));
    expect(mixed.detail).toContain('access to the computer: privileged mode');
    expect(mixed.detail).toContain('not supported: --pull');

    h.helper.config = { image: BASE_IMAGE, runArgs: ['--pull=always'], build: { options: ['--progress=plain'] } };
    const unsupported = await rejection(h.service.open(TARGET, options()));
    expect(unsupported.code).toBe('hostAccess');
    expect(unsupported.message).toBe(Messages.unsupportedOptions('--pull, build option --progress'));
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });

  it.each<[string, string[]]>([
    ['a --name as the value of --label', ['--label', '--name', '--privileged']],
    ['a --name as the value of -e', ['-e', '--name', '--privileged']],
    ['a --name with its value', ['--name', 'mine', '--privileged']],
    ['a --name before a bind mount', ['--name=mine', '-v/Users/hs:/host']],
    ['labels around --name and --init', ['--label', '--name', '--init', '--label', '--privileged']],
    ['a --name of its own', ['--name', 'mine', '--init']],
  ])('never gives Docker what the policy refuses, for runArgs with %s', async (_name, runArgs) => {
    await seedEnvironment(h, { container: null });
    h.helper.config = { image: BASE_IMAGE, runArgs };
    const error = await h.service.openEnvironment(ENV_ID, options()).then(
      () => undefined,
      (caught: unknown) => caught as UserFacingError,
    );
    if (error) {
      expect(error.code).toBe('hostAccess');
      expect(h.helper.ups).toEqual([]);
      return;
    }
    // What Docker gets passes the policy as a whole: the extension's --label and --name included.
    const given = h.helper.ups[0].override.runArgs as string[];
    expect(runArgsProblems(given, NAME)).toEqual([]);
    expect(given.slice(-2)).toEqual(['--name', NAME]);
    expect(given.filter((arg) => arg === '--name')).toHaveLength(runArgs.includes('--label') ? 2 : 1);
  });

  it.each<[string, unknown[], string[] | undefined]>([
    // Restrictions summary, finding 1: the exact inputs. `undefined`: refused before any build.
    ['--name as a label before a bind mount', ['--label', '--name', '--init', '--label', '-v/Users:/host'], ['--label', '--name', '--init', '--label', '-v/Users:/host']],
    ['a number before a bind mount', ['--label', 3, '--label', '-v/Users:/host'], undefined],
    ['a number before --privileged', ['--label', 3, '--label', '--privileged'], undefined],
    ['a number before a port on all addresses', ['--label', 3, '--label', '-p0.0.0.0:80:80'], undefined],
    ['--rm as a label before a bind mount', ['--label', '--rm', '--init', '--label', '-v/Users:/host'], ['--label', '--rm', '--init', '--label', '-v/Users:/host']],
    ['--rm, -it, the platform, and --cap-drop', ['--rm', '-it', '--platform', 'linux/amd64', '--cap-drop', 'ALL'], ['--platform', 'linux/amd64', '--cap-drop', 'ALL']],
    ['a flag without its value at the end', ['--init', '-e'], undefined],
  ])('gives Docker exactly the runArgs that the policy checked, for %s', async (_name, runArgs, passed) => {
    await seedEnvironment(h, { container: null });
    // The configuration as the CLI reads it: JSON, so the list may have entries that are no text.
    h.helper.config = { image: BASE_IMAGE, runArgs: runArgs as string[] };
    if (passed === undefined) {
      expect((await rejection(h.service.openEnvironment(ENV_ID, options()))).code).toBe('hostAccess');
      expect(h.helper.builds).toEqual([]);
      expect(h.helper.ups).toEqual([]);
      return;
    }
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups[0].override.runArgs).toEqual([...passed, '--label', 'devenv.container-version=3', '--name', NAME]);
  });

  it('removes --rm, -i, -t, -d, and --name before up, and names them in the log', async () => {
    await seedEnvironment(h, { container: null });
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--rm', '-it', '--cap-drop', 'ALL', '-d', '--name', 'mine', '--label', '--rm'] };
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups[0].override.runArgs).toEqual(['--cap-drop', 'ALL', '--label', '--rm', '--label', 'devenv.container-version=3', '--name', NAME]);
    const lines = h.logger.infos.filter((line) => line.startsWith(`Removed from the runArgs of ${REPO}: `));
    expect(lines).toHaveLength(1);
    for (const removed of ['--rm (Dev Environments stops, starts, and recreates the container', '-it (the container runs without a terminal', '-d (the Dev Container CLI stays attached', '--name mine (the container gets the name of the environment)']) {
      expect(lines[0]).toContain(removed);
    }
    // The --rm that is the value of --label is passed on, and not named.
    expect(lines[0].match(/--rm \(/g)).toHaveLength(1);
  });

  it('logs no removal when the runArgs have nothing to remove', async () => {
    await seedEnvironment(h, { container: null });
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--init', '--label', '--rm'] };
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.logger.infos.filter((line) => line.startsWith('Removed from the runArgs'))).toEqual([]);
  });

  it('refuses a Feature that mounts the Docker socket (merged configuration), before any build', async () => {
    h.helper.merged = { mounts: [{ source: '/var/run/docker.sock', target: '/var/run/docker-host.sock', type: 'bind' }] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('bind mount /var/run/docker.sock');
    expect(h.helper.builds).toEqual([]);
  });

  it('keeps an existing environment whose configuration is refused, and starts nothing (NFR-07)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--privileged'] };
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('hostAccess');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
    expect(h.docker.volumes.has(NAME)).toBe(true);
    expect(await entry()).toBeDefined();
  });

  it('refuses a rebuild and a configuration selection of a refused configuration', async () => {
    await seedEnvironment(h);
    h.helper.config = { image: BASE_IMAGE, initializeCommand: 'docker login' };
    expect((await rejection(h.service.openEnvironment(ENV_ID, options({ forceRebuild: true })))).code).toBe('hostAccess');
    expect((await rejection(h.service.openEnvironment(ENV_ID, options({ configPath: DEFAULT_CONFIG_PATH })))).code).toBe('hostAccess');
    expect(h.helper.builds).toEqual([]);
  });

  it('checks the metadata of the environment image before a container is created from it', async () => {
    // The configuration cannot be read (merged configuration unknown), the image asks for privileged mode.
    await seedEnvironment(h, { container: null });
    h.docker.imageConfigs.set(IMAGE_1, imageConfigWithUser('vscode', [{ id: 'docker-in-docker', privileged: true }]));
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'offline');
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('privileged mode'));
    expect(h.helper.ups).toEqual([]);
  });

  describe('a new image of an update whose metadata needs the computer (concept 7.7)', () => {
    const SOCKET_MOUNT = { id: 'docker-outside-of-docker', mounts: [{ source: '/var/run/docker.sock', target: '/x', type: 'bind' }] };
    const REFUSED = Messages.updateRefused('bind mount /var/run/docker.sock');
    const NEWER_FEATURE = `sha256:${'e'.repeat(64)}`;

    async function refusedUpdate(): Promise<unknown> {
      return (await entry())?.refusedUpdate;
    }

    beforeEach(() => {
      h.helper.buildMetadata = [SOCKET_MOUNT];
    });

    it('is not used: the old container starts, with a warning, and the refusal is remembered', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      const result = await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.builds.map((b) => b.imageName)).toEqual([IMAGE_2]);
      expect(h.helper.ups.map((u) => [u.image, u.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
      expect(h.docker.containersOf(ENV_ID).map((c) => [c.id, c.state])).toEqual([[before, 'running']]);
      expect(h.ui.warnings).toEqual([REFUSED]);
      expect(h.docker.images.has(IMAGE_2)).toBe(false);
      expect(h.docker.images.has(IMAGE_1)).toBe(true);
      expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_1);
      expect((await entry())?.buildRecord?.images).toEqual({ [BASE_IMAGE]: DIGEST_OLD });
      expect(await refusedUpdate()).toEqual({
        configPath: DEFAULT_CONFIG_PATH,
        configHash: configHash(DEFAULT_CONFIG_TEXT),
        images: { [BASE_IMAGE]: DIGEST_NEW },
        features: { [FEATURE]: FEATURE_DIGEST },
        items: 'bind mount /var/run/docker.sock',
      });
      expect(result.environment.busy).toBeUndefined();
    });

    it('is not built again for the same digests, until a digest changes', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      await h.service.openEnvironment(ENV_ID, options());
      h.docker.containersOf(ENV_ID)[0].state = 'stopped';

      // The same update: no pull, no build; the old container starts, and the user learns why again.
      h.ui.warnings.length = 0;
      h.docker.log.length = 0;
      h.progress.steps.length = 0;
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.builds).toHaveLength(1);
      expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
      expect(h.helper.ups.map((u) => [u.image, u.removeExistingContainer])).toEqual([
        [IMAGE_1, false],
        [IMAGE_1, false],
      ]);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([before]);
      expect(h.ui.warnings).toEqual([REFUSED]);
      expect(h.progress.steps).not.toContain('preparing');

      // A newer Feature: the update is tried again (and refused again).
      h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: NEWER_FEATURE });
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.builds).toHaveLength(2);
      expect(((await refusedUpdate()) as { features: unknown }).features).toEqual({ [FEATURE]: NEWER_FEATURE });

      // The Feature does not need the computer anymore: the update is used, and the refusal is forgotten.
      h.helper.buildMetadata = [];
      h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.builds).toHaveLength(3);
      const record = (await entry())?.buildRecord;
      expect(record?.environmentImage).toBe(environmentImageName(ENV_ID, 4));
      expect(await refusedUpdate()).toBeUndefined();
    });

    it('is tried again when the configuration changes', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
      await h.service.openEnvironment(ENV_ID, options());
      expect(await refusedUpdate()).toBeDefined();
      h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: `${DEFAULT_CONFIG_TEXT}\n` } };
      h.ui.configurationChangedAnswer = 'rebuildNow';
      h.helper.buildMetadata = [];
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.builds).toHaveLength(2);
      expect(await refusedUpdate()).toBeUndefined();
    });

    it('creates a missing container from the old image, whose metadata is checked again', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: null });
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.ups.map((u) => [u.image, u.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.image)).toEqual([IMAGE_1]);
      expect(h.docker.runs).toEqual([]);
      expect(h.ui.warnings).toEqual([REFUSED]);
      expect(h.docker.images.has(IMAGE_2)).toBe(false);

      // The old image needs the computer too: nothing starts.
      h.docker.containers.clear();
      h.docker.imageConfigs.set(IMAGE_1, imageConfigWithUser('vscode', [{ id: 'dind', privileged: true }]));
      const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
      expect(error.code).toBe('hostAccess');
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    });

    it('ends the open without an old container or image to fall back to', async () => {
      await seedEnvironment(h, { container: null, image: false });
      const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
      expect(error.code).toBe('hostAccess');
      expect(error.message).toBe(Messages.hostAccess('bind mount /var/run/docker.sock'));
      expect(h.helper.ups).toEqual([]);
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
      expect(h.docker.images.has(IMAGE_2)).toBe(false);
      expect(await refusedUpdate()).toBeUndefined();
    });

    it('falls back the same way after a requested rebuild', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      await h.service.openEnvironment(ENV_ID, options({ forceRebuild: true }));
      expect(h.helper.builds.map((b) => b.imageName)).toEqual([IMAGE_2]);
      expect(h.helper.ups.map((u) => [u.image, u.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([before]);
      expect(h.ui.warnings).toEqual([REFUSED]);
      expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_1);
    });
  });

  it('binds published ports to 127.0.0.1 in the override configuration', async () => {
    h.helper.config = { image: BASE_IMAGE, appPort: [3000, '8080:80'], runArgs: ['-p', '9000:90', '--network', 'host'] };
    await h.service.open(TARGET, options());
    expect(h.helper.ups[0].override.appPort).toEqual(['127.0.0.1:3000:3000', '127.0.0.1:8080:80']);
    expect(h.helper.ups[0].override.runArgs).toEqual(expect.arrayContaining(['-p', '127.0.0.1:9000:90', '--network', 'host']));
  });

  it('refuses labels of Dev Environments and variables of container-only Git before any build (findings 5 and 6)', async () => {
    h.helper.config = {
      image: BASE_IMAGE,
      runArgs: ['--label', 'devenv.environment-id=someone-else', '-e', 'GIT_CONFIG_GLOBAL=/tmp/gitconfig'],
      remoteEnv: { GIT_CONFIG_PARAMETERS: "'credential.helper=store'" },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(
      Messages.hostAccessAndUnsupported('variable GIT_CONFIG_GLOBAL in runArgs, variable GIT_CONFIG_PARAMETERS in remoteEnv', 'label devenv.environment-id'),
    );
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });

  it('refuses the cache volume of the Dev Containers extension before any build (finding 4)', async () => {
    h.helper.config = { image: BASE_IMAGE, mounts: ['source=vscode,target=/vscode,type=volume'] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('volume vscode of the Dev Containers extension'));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses an existing volume of another program by its labels, and reads only the labels of the mounted volumes (finding 4)', async () => {
    h.docker.volumes.set('shop_db', { 'com.docker.compose.project': 'shop', 'com.docker.compose.volume': 'db' });
    h.helper.config = { image: BASE_IMAGE, mounts: ['source=shop_db,target=/db,type=volume', 'source=cache,target=/c,type=volume'] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('volume shop_db of the Docker Compose project shop'));
    expect(h.docker.volumeInspections).toEqual([['shop_db', 'cache']]);
    expect(h.helper.builds).toEqual([]);
  });

  it('reads no labels for a configuration without named volumes', async () => {
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
    expect(h.docker.volumeInspections).toEqual([]);
  });

  describe('named volumes of environments of other accounts (finding 4)', () => {
    const SHARED = 'shared-cache';

    /** An environment of another repository that uses the volume SHARED. `null`: an entry of an older version. */
    async function otherEnvironment(owner: GitHubAccount | null): Promise<void> {
      await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', owner, container: null, extra: { additionalVolumes: [SHARED] } });
    }

    it('are refused before any build', async () => {
      await otherEnvironment(OTHER_ACCOUNT);
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE, mounts: [`source=${SHARED},target=/cache,type=volume`] };
      const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
      expect(error.code).toBe('hostAccess');
      expect(error.message).toBe(Messages.hostAccess(`volume ${SHARED} of another environment`));
      expect(h.helper.builds).toEqual([]);
      expect(h.helper.ups).toEqual([]);
    });

    it('are refused when an entry of an older version without owner of the same repository uses them: it may hold the work of another person', async () => {
      await seedEnvironment(h, { id: OTHER_ID, owner: null, container: null, extra: { additionalVolumes: [SHARED] } });
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE, runArgs: ['-v', `${SHARED}:/cache`] };
      const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
      expect(error.message).toBe(Messages.hostAccess(`volume ${SHARED} of another environment`));
      expect(h.helper.ups).toEqual([]);
    });

    it('are refused when an entry of an older version without owner of another repository uses them', async () => {
      await otherEnvironment(null);
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE, runArgs: ['-v', `${SHARED}:/cache`] };
      const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
      expect(error.message).toBe(Messages.hostAccess(`volume ${SHARED} of another environment`));
    });

    it('are allowed when the environment recorded them itself: entries of one person shared them before the separation', async () => {
      await otherEnvironment(null);
      await seedEnvironment(h, { container: null, extra: { additionalVolumes: [SHARED] } });
      h.helper.config = { image: BASE_IMAGE, runArgs: ['-v', `${SHARED}:/cache`] };
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.ups).toHaveLength(1);
    });

    it('are allowed when the environment recorded them itself, also when another account uses them', async () => {
      await otherEnvironment(OTHER_ACCOUNT);
      await seedEnvironment(h, { container: null, extra: { additionalVolumes: [SHARED] } });
      h.helper.config = { image: BASE_IMAGE, runArgs: ['-v', `${SHARED}:/cache`] };
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.ups).toHaveLength(1);
    });

    it('are not recorded when only `up` names them: a name with ${devcontainerId} gets no labels (Dev Container CLI 0.89.0)', async () => {
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE, mounts: ['source=${devcontainerId}-history,target=/h,type=volume'] };
      h.helper.containerVolumes = ['0k5q7r2m-history', 'ab'.repeat(32), 'vscode'];
      // Docker creates the volumes of the mounts at `up`, without labels.
      const up = h.helper.up.bind(h.helper);
      h.helper.up = async (p) => {
        for (const volume of h.helper.containerVolumes) if (!h.docker.volumes.has(volume)) h.docker.volumes.set(volume, {});
        return up(p);
      };
      await h.service.openEnvironment(ENV_ID, options());
      // Not created before `up` (the name is not known then), so not labeled and not recorded.
      expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([]);
      expect((await h.registry.get(ENV_ID))?.additionalVolumes).toBeUndefined();
      // Delete keeps it.
      await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: ['0k5q7r2m-history'] }));
      expect(h.docker.volumes.has('0k5q7r2m-history')).toBe(true);
    });

    it('are created with the labels of the environment before `up`, recorded, and removed by Delete', async () => {
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE, mounts: ['source=api-history,target=/h,type=volume'], runArgs: ['-v', 'api-cache:/c'] };
      h.docker.volumes.set('api-existing', { 'com.example': 'x' });
      h.docker.imageConfigs.set(IMAGE_1, imageConfigWithUser('vscode', [{ id: 'feature', mounts: [{ type: 'volume', source: 'feature-store', target: '/f' }, 'source=api-existing,target=/e,type=volume'] }]));
      let createdAtUp: string[] = [];
      const up = h.helper.up.bind(h.helper);
      h.helper.up = async (p) => {
        createdAtUp = h.docker.log.filter((line) => line.startsWith('volume create'));
        return up(p);
      };
      await h.service.openEnvironment(ENV_ID, options());
      expect(createdAtUp).toEqual(['volume create api-history', 'volume create api-cache', 'volume create feature-store']);
      for (const name of ['api-history', 'api-cache', 'feature-store']) expect(h.docker.volumes.get(name)).toEqual(additionalVolumeLabels());
      // An existing volume keeps its labels and is not the environment's.
      expect(h.docker.volumes.get('api-existing')).toEqual({ 'com.example': 'x' });
      expect((await h.registry.get(ENV_ID))?.additionalVolumes).toEqual(['api-history', 'api-cache', 'feature-store']);
      await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: ['api-history', 'api-cache', 'feature-store'] }));
      for (const name of ['api-history', 'api-cache', 'feature-store']) expect(h.docker.volumes.has(name)).toBe(false);
      expect(h.docker.volumes.has('api-existing')).toBe(true);
    });

    it('creates no volume when the container exists already', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      h.helper.config = { image: BASE_IMAGE, mounts: ['source=api-history,target=/h,type=volume'] };
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([]);
    });

    it('are recorded from a container whose `up` failed after it created the container, at once and at the next open', async () => {
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE };
      // An own volume that the container mounts, whose record was lost.
      h.docker.volumes.set('0k5q7r2m-history', additionalVolumeLabels());
      h.helper.containerVolumes = ['0k5q7r2m-history'];
      const up = h.helper.up.bind(h.helper);
      let fail = true;
      h.helper.up = async (p) => {
        const result = await up(p);
        if (fail) throw new Error('up failed after the container was created');
        return result;
      };
      await rejection(h.service.openEnvironment(ENV_ID, options()));
      expect((await h.registry.get(ENV_ID))?.additionalVolumes).toEqual(['0k5q7r2m-history']);
      // An entry without it (for example of a version before this record) gets it at the next open of the container.
      await h.registry.updateEnvironment(ENV_ID, (entry) => {
        delete entry.additionalVolumes;
      });
      fail = false;
      await h.service.openEnvironment(ENV_ID, options());
      expect((await h.registry.get(ENV_ID))?.additionalVolumes).toEqual(['0k5q7r2m-history']);
    });

    it('are recorded from the merged configuration too (a Feature of an existing container), when their labels make them its own', async () => {
      await seedEnvironment(h);
      h.helper.merged = { mounts: ['source=feature-cache,target=/c,type=volume', 'source=legacy-cache,target=/l,type=volume'] };
      h.docker.volumes.set('feature-cache', additionalVolumeLabels());
      h.docker.volumes.set('legacy-cache', {});
      await h.service.openEnvironment(ENV_ID, options());
      expect((await h.registry.get(ENV_ID))?.additionalVolumes).toEqual(['feature-cache']);
    });

    it('are recorded with the parser of the policy: a quoted --mount field, and a volume of a Feature in the image metadata', async () => {
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE, mounts: ['"source=quoted-cache",target=/q,type=volume'] };
      h.docker.imageConfigs.set(IMAGE_1, imageConfigWithUser('vscode', [{ id: 'feature', mounts: [{ type: 'volume', source: 'feature-store', target: '/f' }] }]));
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.ups).toHaveLength(1);
      expect((await h.registry.get(ENV_ID))?.additionalVolumes).toEqual(['quoted-cache', 'feature-store']);
      // The next open keeps the volume of the Feature (it is not in the configuration).
      await h.service.openEnvironment(ENV_ID, options());
      expect((await h.registry.get(ENV_ID))?.additionalVolumes).toEqual(['quoted-cache', 'feature-store']);
    });

    it.each<[string, GitHubAccount | null]>([['an environment of the same account', ACCOUNT]])('are allowed when %s uses them', async (_name, owner) => {
      await otherEnvironment(owner);
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE, runArgs: ['-v', `${SHARED}:/cache`] };
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.ups).toHaveLength(1);
      expect(h.helper.ups[0].override.runArgs).toEqual(expect.arrayContaining(['-v', `${SHARED}:/cache`]));
    });

    it('are refused in the metadata of the environment image before a container is created from it', async () => {
      await otherEnvironment(OTHER_ACCOUNT);
      await seedEnvironment(h, { container: null });
      h.docker.imageConfigs.set(IMAGE_1, imageConfigWithUser('vscode', [{ id: 'feature', mounts: [{ type: 'volume', source: SHARED, target: '/c' }] }]));
      h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'offline');
      const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
      expect(error.message).toBe(Messages.hostAccess(`volume ${SHARED} of another environment`));
      expect(h.helper.ups).toEqual([]);
    });
  });
});
