// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import { devContainersSettings } from '../devContainers';
import { CommandError, UserFacingError } from '../errors';
import { OWNERSHIP_FIX_SCRIPT } from '../git/gitSummary';
import { HOME_GIT_CONFIG_SCRIPT, homeGitConfigCommand } from '../helper/containerGit';
import { TOKEN_WRITE_SCRIPT, tokenWriteCommand } from '../helper/containerToken';
import { MAX_CONFIG_TEXT_LENGTH } from '../helper/analysisLimits';
import { MAX_DOCKERFILE_LENGTH } from '../imageCheck/dockerfile';
import {
  ANALYSIS_FAILED_ITEM,
  analysisFailure,
  analysisInternalItem,
  inProcessAnalyzer,
  type AnalysisFailure,
  type AnalysisJob,
  type ConfigurationAnalyzer,
} from '../helper/configurationAnalysis';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import { ensureHelperImageUse, helperImageTag, type HelperImageDocker } from '../helper/helperImage';
import type { EnsureImageOptions } from '../helper/workspaceHelper';
import { Messages } from '../messages';
import {
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_ENVIRONMENT_ID,
  LABEL_HOST_ACCESS,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  configurationName,
  environmentImageName,
  environmentImageRepository,
  resourceName,
} from '../names';
import { abortError } from '../ports';
import type { Environment, GitHubAccount, WindowStatus } from '../types';
import {
  MAX_REFUSED_ITEMS_LENGTH,
  PipelineTexts,
  afterUpClause,
  kindSwitchFailure,
  lifecycleMarkClears,
  withdrawnOutcome,
  type EnvironmentServiceDeps,
  type RepositoryTarget,
} from './environmentService';
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
  type SeedOptions,
  CLEARED_COMPOSE_LABELS,
  TOKEN_TMPFS_ARGS,
  CONFIG_PATH_LABEL,
} from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH, configHash } from './pipelineRules';
import { hostAccessProblems } from '../policy';

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

/** The ownership fix after `up` in the dev container (OWNERSHIP_FIX_SCRIPT as root). */
function isOwnershipFix(exec: { user?: string; command: readonly string[] }): boolean {
  return exec.user === 'root' && exec.command[2] === OWNERSHIP_FIX_SCRIPT;
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
    // Review round 2 (D2-1): changed expectation, with the labels of Docker Compose set empty. Review round 4, D4-2:
    // changed expectation, with the label nimblescape.devenv.config-path. unit 15: changed expectation, the tmpfs of
    // the token.
    expect(h.helper.ups[0].override.runArgs).toEqual([
      '--label',
      // Versions reset to 1 (user decision 2026-09-27), here and in the expectations of
      // nimblescape.devenv.container-version below.
      'nimblescape.devenv.container-version=1',
      ...CONFIG_PATH_LABEL,
      ...CLEARED_COMPOSE_LABELS,
      '--name',
      name,
      '--hostname',
      'api',
      '--tmpfs',
      '/run/devenv:rw,nosuid,nodev,noexec,size=1m,mode=0700',
    ]);
    expect(h.helper.ups[0].override).not.toHaveProperty('initializeCommand');
    // Concept section 9: the Git configuration is in the volume before `up` runs the lifecycle commands.
    expect(h.helper.calls.indexOf('prepareGit')).toBeLessThan(h.helper.calls.indexOf(`up ${image}`));
    // unit 15: changed expectation, no token in the volume; it goes into the memory of the container after `up`.
    expect(h.helper.gitPreparations).toEqual([{ volumeName: name, repository: REPO, identity: { name: 'octo', email: '1001+octo@users.noreply.github.com' } }]);
    expect(h.docker.tokenWrites()).toEqual([
      { container: h.docker.containersOf(env!.id)[0].id, user: 'root', remoteUser: 'vscode', login: 'octo', token: TOKEN },
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

    // Lifecycle token (user decision 2026-09-27): the token write (also as root) now comes before the ownership fix after up.
    const ownership = h.docker.execs.find(isOwnershipFix);
    expect(ownership?.command.slice(-2)).toEqual(['/workspaces/api', 'vscode']);
    // The configuration folder of the container gets the remote user too (written before `up`). Review round 15, K3: in a
    // helper container that mounts only the workspace volume, with the numeric IDs of the remote user (before: a second
    // OWNERSHIP_FIX_SCRIPT for /workspaces/.devenv+ in the dev container).
    expect(h.docker.execs.filter((e) => e.command[2] === OWNERSHIP_FIX_SCRIPT).map((e) => e.command[4])).toEqual(['/workspaces/api']);
    expect(h.helper.configOwnershipFixes).toEqual([{ volumeName: env!.volumeName, folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' }]);
    // Before the first attach: the ~/.gitconfig of the remote user, which keeps the Dev Containers extension from copying
    // the Git configuration of the computer.
    expect(h.docker.execs.find((e) => e.command[2] === HOME_GIT_CONFIG_SCRIPT)).toMatchObject({ user: 'root', command: homeGitConfigCommand('vscode') });
    expect(await pendingIds()).toEqual([id]);
    expect(h.progress.steps).toEqual(['downloadingRepository', 'checkingImage', 'downloadingImage', 'preparing', 'starting']);
    expect(h.progress.details).toEqual([]);
    expect(h.helper.silentlyCreatedVolumes).toEqual([]);
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

  // User decision 2026-09-28: the container is made only from an image that the engine has after the build.
  it('reports a build that ended without its image as buildFailed and starts no container', async () => {
    const build = h.helper.build.bind(h.helper);
    h.helper.build = async (p) => {
      const result = await build(p);
      h.docker.images.delete(p.imageName); // the connection to a remote engine broke at the end of the build
      return result;
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
    expect(h.docker.containers.size).toBe(0);
    expect(await h.registry.list()).toEqual([]);
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
    // Lifecycle token (user decision 2026-09-27): the token write (also as root) now comes before the ownership fix after up.
    expect(h.docker.execs.some(isOwnershipFix)).toBe(true);
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

  // hotfix review 2, P3: the CLI substitutes the label at `up` before it reads the remote user.
  describe('a remote user of the label with a variable', () => {
    const labelUser = (remoteUser: string): void => {
      const { remoteUser: _remoteUser, ...config } = h.helper.config;
      h.helper.config = config;
      const build = h.helper.build.bind(h.helper);
      h.helper.build = async (p) => {
        const result = await build(p);
        h.docker.imageConfigs.set(p.imageName, imageConfigWithUser(remoteUser));
        return result;
      };
    };

    it('gives the cloned files to the user that the CLI resolves before up', async () => {
      labelUser('${localEnv:DEVUSER:vscode}');
      await h.service.open(TARGET, options());
      expect(h.docker.runs).toHaveLength(1);
      expect(h.docker.runs[0].args.slice(-2)).toEqual(['/workspaces/api', 'vscode']);
    });

    it('skips the fix before up when the user is not known, and gives the files to the user that up reports', async () => {
      labelUser('${localEnv:TERM:vscode}');
      await h.service.open(TARGET, options());
      expect(h.docker.runs).toEqual([]);
      expect(h.logger.infos.some((line) => line.includes('is not known before the container is created'))).toBe(true);
      // Lifecycle token (user decision 2026-09-27): the token write (also as root) now comes before the ownership fix after up.
      expect(h.docker.execs.find(isOwnershipFix)?.command.slice(-2)).toEqual(['/workspaces/api', 'vscode']);
    });

    it('does not store the text of the label as the remote user after a failed lifecycle command', async () => {
      labelUser('${localEnv:TERM:vscode}');
      h.helper.lifecycleFailure = () => 'postCreateCommand from devcontainer.json failed.';
      await h.service.open(TARGET, options());
      const env = (await h.registry.findForAccount(REPO, ACCOUNT.id))!;
      expect(env.remoteUser).toBeUndefined();
      expect(h.docker.execs.some((e) => e.command.includes('${localEnv:TERM:vscode}'))).toBe(false);
    });
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

  it('lists and reads the fallback configuration with the helper image of the open (review round 3 of PR #64, P7)', async () => {
    h.helper.files = { '.devcontainer/python/devcontainer.json': { configText: DEFAULT_CONFIG_TEXT } };
    // 2026-10-01: the Switch branch command was dropped (user decision). The open has no branch option.
    await h.service.open(TARGET, options());
    expect(h.ui.infos).toEqual([Messages.configurationNotFound(DEFAULT_CONFIG_PATH, 'python')]);
    // user decision 2026-09-29: no previous helper image. Changed expectation: the helper image of the open is the
    // current tag with its image ID (before, a previous helper).
    const previous = { tag: 'devenv-helper:test', id: h.helper.currentHelperImageId };
    const used = h.helper.helperImages.filter((entry) => entry.call === 'listConfigurations' || entry.call === 'readConfigFiles');
    expect(used.filter((entry) => entry.call === 'listConfigurations')).toHaveLength(1);
    // The read of the missing configuration and the read of the fallback.
    expect(used.filter((entry) => entry.call === 'readConfigFiles').length).toBeGreaterThanOrEqual(2);
    expect(used.filter((entry) => JSON.stringify(entry.image) !== JSON.stringify(previous))).toEqual([]);
  });

  it('falls back to the first configuration on the branch and says so', async () => {
    h.helper.files = { '.devcontainer/python/devcontainer.json': { configText: DEFAULT_CONFIG_TEXT } };
    // 2026-10-01: the Switch branch command was dropped (user decision). The open has no branch option.
    await h.service.open(TARGET, options());
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

  // Spec u6: Docker Compose configurations are supported (compose tests in environmentService.compose.test.ts); what is
  // refused now is a compose file outside of the repository (resolveComposeFiles), before the model run.
  it('refuses a Docker Compose configuration whose compose file is outside of the repository', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "dockerComposeFile": "../../docker-compose.yml", "service": "app" }' };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.unsupportedOptions('dockerComposeFile "../../docker-compose.yml" (outside of the repository)'));
    expect(h.helper.composeModels).toEqual([]);
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
    const original = h.helper.ensureImageUse.bind(h.helper);
    let first = true;
    h.helper.ensureImageUse = async (opts?: { onOutput?: (text: string) => void }) => {
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
    // No ownership fix for a container that only starts. unit 15: changed expectation, the only exec as root is the write
    // of the token into its memory. review, PL-1/PL-2: and ~/.gitconfig before the lifecycle commands (the script writes
    // only a missing or empty file).
    expect(h.docker.execs.some((e) => e.user === 'root' && e.command[2] !== TOKEN_WRITE_SCRIPT && e.command[2] !== HOME_GIT_CONFIG_SCRIPT)).toBe(false);
    expect(h.docker.tokenWrites()).toHaveLength(1);
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
      // PR #52 CI (a busy runner delayed the 5 ms timer): the step lasts until three refreshes ran, at most 5 s, instead
      // of a fixed 60 ms; the assertion below is unchanged.
      const until = Date.now() + 5_000;
      while (writes - before < 3 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
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
    // Lifecycle token (user decision 2026-09-27): the token write (also as root) now comes before the ownership fix after up.
    expect(h.docker.execs.some(isOwnershipFix)).toBe(true);
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

  // Review round 1 (F6): when the check of the built image fails, the update falls back and removes that image.
  it('keeps the old container and removes the new image when its check after the build fails', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    const imageExists = h.docker.imageExists.bind(h.docker);
    h.docker.imageExists = async (reference: string) => {
      if (reference === h.helper.builds[0]?.imageName) throw new Error('Cannot connect to the Docker daemon');
      return imageExists(reference);
    };
    await h.service.open(TARGET, options());
    const built = h.helper.builds[0]?.imageName;
    expect(built).toBeDefined();
    expect(built).not.toBe(IMAGE_1);
    expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    expect(h.helper.ups).toEqual([expect.objectContaining({ image: IMAGE_1, removeExistingContainer: false })]);
    expect(h.docker.images.has(built!)).toBe(false);
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
    // Lifecycle token (user decision 2026-09-27): the token write (also as root) now comes before the ownership fix after up.
    expect(h.docker.execs.find(isOwnershipFix)?.command.slice(-2)).toEqual(['/workspaces/api', 'vscode']);
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
      // Plan step 6, PR A: changed expectation, the question is asked under the lock, so the helper image of the worker
      // was ensured before it (D1); no helper run.
      expect(h.helper.calls).toEqual(['ensureImagePresent']);
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
      // Lifecycle token (user decision 2026-09-27): the token write (also as root) now comes before the ownership fix after up.
      expect(h.docker.execs.some(isOwnershipFix)).toBe(true);
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
    // Spec u6: Docker Compose is supported; a compose file that Docker Compose cannot read is the broken configuration.
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "dockerComposeFile": "compose.yml", "service": "app" }' };
    h.helper.composeOutput = { error: 'yaml: line 3: mapping values are not allowed in this context' };
    await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.composeConfigurationFailed]);
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
    const original = h.helper.ensureImageUse.bind(h.helper);
    h.helper.ensureImageUse = async (opts?: { onOutput?: (text: string) => void }) => {
      opts?.onOutput?.('Step 1/5 : FROM node');
      return original();
    };
    await h.service.open(TARGET, options());
    expect(h.progress.steps).toEqual(['checkingImage', 'starting']);
    expect(h.progress.details).toEqual([PipelineTexts.preparingHelper, '']);
  });

  it('shows the rebuild of an existing helper image from a new base image as an update, not as a first preparation', async () => {
    await seedEnvironment(h);
    const original = h.helper.ensureImageUse.bind(h.helper);
    h.helper.ensureImageUse = async (opts?: EnsureImageOptions) => {
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
    const original = h.helper.ensureImageUse.bind(h.helper);
    h.helper.ensureImageUse = async (opts?: EnsureImageOptions) => {
      seen.push(opts?.checkBaseImage);
      return original();
    };
    await h.service.open(TARGET, options());
    await h.service.stop(ENV_ID);
    h.settings.updateImagesOnConnect = false;
    await h.service.open(TARGET, options());
    // PR #74 review round 1, A-R1-1: changed expectation: the Stop between the opens ensures the helper image before its
    // lock without the maintenance (ensureImagePresent), so only the opens reach ensureImageUse (before: [true, true, false]).
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
    h.helper.ensureImageUse = (opts?: EnsureImageOptions) =>
      ensureHelperImageUse(helperDocker, dockerfilePath, {
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

  it('fails with helperFailed and starts nothing when the helper cannot be prepared for a stopped container', async () => {
    await seedEnvironment(h);
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;
    // Changed expectation (no docker start fallback, user decision 2026-09-29): before, the container was
    // started with docker start after a warning; now the open fails with helperFailed, without the warning.
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.message).toBe(Messages.helperFailed);
    expect(h.ui.warnings).toEqual([]);
    const container = h.docker.containersOf(ENV_ID)[0];
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(container.state).toBe('stopped');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.tokenWrites()).toEqual([]);
  });

  // Review round 10 of PR #64 (R10-3): at Step 5 the configuration is not known yet, so a running container created
  // without it counts as current and opens as it is.
  it('opens a running container that was created without the configuration without the workspace helper', async () => {
    await seedEnvironment(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'nimblescape.devenv.container-config': 'unknown' } });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;
    const result = await h.service.open(TARGET, options());
    expect(result.containerName).toBe(NAME);
    expect(h.ui.warnings).toEqual([Messages.helperFailed]);
    expect(h.helper.ups).toEqual([]);
  });

  it('opens a running container without the workspace helper, and starts nothing', async () => {
    // No docker start fallback, user decision 2026-09-29: a running container is not started, so it
    // still opens without the helper (as before).
    await seedEnvironment(h, { container: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;
    const result = await h.service.open(TARGET, options());
    expect(result.containerName).toBe(NAME);
    expect(h.ui.warnings).toEqual([Messages.helperFailed]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });

  it('fails with helperFailed at once, without a warning, for a running container that is outdated (review round 1 of PR #64, L2)', async () => {
    // Before: the open warned with helperFailed, logged that the environment is started, and then failed with the same
    // text; the outdated container would be created again, which needs the helper.
    await seedEnvironment(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('helperFailed');
    expect(error.message).toBe(Messages.helperFailed);
    expect(h.ui.warnings).toEqual([]);
    expect(h.logger.errors.join('\n')).not.toContain('The existing environment is started');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
  });

  it('logs that a running current container is opened as it is when the helper is not available (review round 1 of PR #64, L2)', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;
    await h.service.open(TARGET, options());
    // Changed expectation (review round 2 of PR #64, B2): the log line names the helper, not the configuration.
    expect(h.logger.errors).toEqual([`The workspace helper is not available for ${REPO}. The running environment is opened as it is. ${Messages.helperFailed}`]);
  });

  it('uses no helper for the rest of the open when a helper run of the open fails with helperFailed (review round 2 of PR #64, A-N1)', async () => {
    // The helper image of the open was removed at a helper run: the run fails with helperFailed instead of switching the
    // helper image; a running container that is current opens as it is, without further helper runs.
    await seedEnvironment(h, { container: 'running' });
    h.helper.readConfigurationError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'5'.repeat(64)}`);
    const result = await h.service.open(TARGET, options());
    expect(result.containerName).toBe(NAME);
    expect(h.helper.calls).not.toContain('prepareGit');
    expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([]);
  });

  it('logs that a stopped container is started without the configuration that cannot be read (review round 1 of PR #64, L2)', async () => {
    await seedEnvironment(h);
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
    await h.service.open(TARGET, options());
    expect(h.logger.errors.filter((line) => line.startsWith('The configuration of'))).toEqual([
      expect.stringMatching(new RegExp(`^The configuration of ${REPO} could not be used\\. The existing environment is started without it\\. `)),
    ]);
    expect(h.helper.calls).toContain(`up ${IMAGE_1}`);
  });

  it('resolves the helper image once per open (review round 2 of PR #64, A-N1)', async () => {
    // The first open prepares the helper before the clone and again before the configuration; the second time resolves
    // nothing again. user decision 2026-09-29: no previous helper image. Changed input: before, with a previous helper.
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((c) => c === 'ensureImage')).toHaveLength(1);
    expect(h.helper.calls.filter((c) => c.startsWith('up'))).toHaveLength(1);
  });

  it('passes the helper image of the open to every helper run of the open (review round 2 of PR #64, A-N1)', async () => {
    // A first open (clone, configuration, build, up, lifecycle commands), and a reconnect after the tag was rebuilt: every
    // helper run of an open gets the image that the open resolved once. user decision 2026-09-29: no previous helper
    // image. Changed expectation: before, the first open used a previous helper and the reconnect the current tag; now
    // both use the current tag, each with the image ID that its open resolved.
    const firstId = `sha256:${'5'.repeat(64)}`;
    h.helper.currentHelperImageId = firstId;
    await h.service.open(TARGET, options());
    const previous = { tag: 'devenv-helper:test', id: firstId };
    const calls = h.helper.helperImages.map((entry) => entry.call);
    expect(calls).toEqual(expect.arrayContaining(['clone', 'readConfigFiles', 'readConfiguration', 'build', 'up', 'runUserCommands', 'prepareGit']));
    expect(h.helper.helperImages.filter((entry) => JSON.stringify(entry.image) !== JSON.stringify(previous))).toEqual([]);

    await h.service.stop(ENV_ID);
    h.helper.helperImages.length = 0;
    h.helper.currentHelperImageId = `sha256:${'4'.repeat(64)}`;
    await h.service.open(TARGET, options());
    expect(h.helper.helperImages.length).toBeGreaterThan(0);
    // Changed expectation (review round 3 of PR #64, P2): the current tag is pinned by the ID of its image, too.
    const current = { tag: 'devenv-helper:test', id: h.helper.currentHelperImageId };
    expect(h.helper.helperImages.filter((entry) => JSON.stringify(entry.image) !== JSON.stringify(current))).toEqual([]);
  });

  it('fails with helperFailed when neither the helper nor a container is available', async () => {
    await seedEnvironment(h, { container: null });
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.helper.calls.filter((c) => c === 'ensureImage')).toHaveLength(1);
  });

  it('unit 15: writes no token into a container when the helper cannot be prepared', async () => {
    await seedEnvironment(h);
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;
    // Changed expectation (no docker start fallback, user decision 2026-09-29): before, docker start
    // started the container without the helper and the token was written into its memory; now nothing starts, so no
    // token is written.
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('helperFailed');
    expect(h.docker.tokenWrites()).toEqual([]);
  });

  it('starts the old container again when the replacement fails before it was removed', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
    const before = h.docker.containersOf(ENV_ID)[0].id;
    h.helper.upFailsBeforeRemoval = true;
    h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid override') : undefined);
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${IMAGE_1}`]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: before, state: 'running' })]);
    // No ownership fix for the old container. unit 15: changed expectation, the write of the token (which gives its files
    // to the remote user with chown) is no ownership fix. review, PL-1/PL-2: nor is ~/.gitconfig before the lifecycle
    // commands (HOME_GIT_CONFIG_SCRIPT gives only a file that it creates to the remote user).
    expect(
      h.docker.execs.some((e) => e.command[2] !== TOKEN_WRITE_SCRIPT && e.command[2] !== HOME_GIT_CONFIG_SCRIPT && e.command.join(' ').includes('chown')),
    ).toBe(false);
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

  describe('the helper image of the open is gone during the update (review round 3 of PR #64, P6)', () => {
    const gone = () => new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);

    it('(a) a build that fails with helperFailed ends the open with helperFailed, without "started instead" and without a buildFailed warning', async () => {
      // Reproduced: the build failed with helperFailed, updateFailed logged that the existing environment is started
      // instead and warned with buildFailed, and then the start failed with helperFailed.
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
      h.helper.buildError = gone;
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.ui.warnings).toEqual([]);
      expect(h.logger.infos.join('\n')).not.toContain('started instead');
      expect(h.helper.ups).toEqual([]);
      expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
    });

    it('(a2) a stopped container that the restore started does not open as it is when a later helper run fails with helperFailed (review round 10 of PR #64, R10-1)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs') : undefined);
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${IMAGE_1}`]);
      // User decision 2026-09-29 (a helperFailed during an update fails the open): the 'update' variant of helperFailedOpenedAsItIs no longer exists (before: not.toContain that warning); no
      // "opened as it is" warning at all.
      expect(h.ui.warnings.filter((line) => line.includes('opened as it is'))).toEqual([]);
      expect(h.logger.errors.filter((line) => line.includes('opened as it is'))).toEqual([]);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([before]);
    });

    it('(b) an `up` of the new image that fails with helperFailed ends the open with helperFailed, without the start of the previous image', async () => {
      // Reproduced: the restore with the previous environment image needs the helper too; its failure became startFailed,
      // and helperFailed was never shown.
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_2 ? gone() : undefined);
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
      expect(h.ui.warnings).toEqual([]);
      expect(h.docker.images.has(IMAGE_2)).toBe(false);
      expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_1);
    });

    it('(b) a restore with the previous image that fails with helperFailed ends the open with helperFailed, not startFailed', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
      h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs') : gone());
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${IMAGE_1} --remove-existing-container`]);
    });

    it('(b) a restore with the previous image that fails otherwise ends the open with startFailed, not through the helperFailed path (review round 20 of PR #64, B-R20-2)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
      h.helper.upError = () => new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs');
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('startFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${IMAGE_1} --remove-existing-container`]);
    });

    it('(b) a running container whose restore fails otherwise does not open as it is (review round 20 of PR #64, B-R20-2)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = () => new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs');
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('startFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${IMAGE_1}`]);
      // User decision 2026-09-29 (a helperFailed during an update fails the open): the 'update' variant of helperFailedOpenedAsItIs no longer exists (before: not.toContain that warning); no
      // "opened as it is" warning at all.
      expect(h.ui.warnings.filter((line) => line.includes('opened as it is'))).toEqual([]);
    });

    it('(c) a build that fails with another UserFacingError is a failed build: the running container starts with the buildFailed warning and the Git setup (review round 20 of PR #64, B-R20-3)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      h.helper.buildError = () => new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled, 'docker: not found');
      const result = await h.service.open(TARGET, options());
      expect(result.containerName).toBe(NAME);
      expect(h.ui.warnings).toEqual([Messages.buildFailed]);
      expect(h.helper.calls).toContain('prepareGit');
    });

    it('(c) a build that fails with helperFailed ends the open with helperFailed although the container still runs: no buildFailed and no gitSetupFailed warning, no Git setup', async () => {
      // Reproduced: the running container opened, with the warnings buildFailed and gitSetupFailed (prepareGit ran).
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      h.helper.buildError = gone;
      // User decision 2026-09-29 (a helperFailed during an update fails the open): changed expectation (before: the running container opened as it is
      // with helperFailedOpenedAsItIs('update')).
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.builds).toHaveLength(1);
      expect(h.ui.warnings).toEqual([]);
      expect(h.helper.calls).not.toContain('prepareGit');
      expect(h.helper.ups).toEqual([]);
      // Review round 1 of PR #68 (A-R1-3): changed expectation, also true for a first open, a Rebuild and a selected
      // configuration (before: "The update could not be completed.").
      expect(h.logger.errors).toEqual([`The workspace helper is not available for ${REPO}. The build or start of its environment could not be completed; the open ends. ${Messages.helperFailed}`]);
      expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
      expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_1);
    });

    it('(c) an `up` of the new image that fails with helperFailed before the container was removed ends the open with helperFailed although the container still runs', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_2 ? gone() : undefined);
      // User decision 2026-09-29 (a helperFailed during an update fails the open): changed expectation (before: the running container opened as it is
      // with helperFailedOpenedAsItIs('update')).
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
      expect(h.ui.warnings).toEqual([]);
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: before, state: 'running' })]);
      expect(h.docker.images.has(IMAGE_2)).toBe(false);
    });

    it('(c) a Git setup before the `up` of the new image that fails with helperFailed ends the open with helperFailed although the container still runs: no gitSetupFailed warning, no `up` (review round 11 of PR #64, R11-2)', async () => {
      // Reproduced: prepareGit turned the helperFailed into the gitSetupFailed warning, and `up` then failed the same way:
      // the warnings were [gitSetupFailed, helperFailedOpenedAsItIs('update')].
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.prepareGitError = gone();
      h.helper.upError = (image) => (image === IMAGE_2 ? gone() : undefined);
      // User decision 2026-09-29 (a helperFailed during an update fails the open): changed expectation (before: the running container opened as it is
      // with helperFailedOpenedAsItIs('update')).
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.ui.warnings).toEqual([]);
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([]);
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: before, state: 'running' })]);
      expect(h.docker.images.has(IMAGE_2)).toBe(false);
    });

    it('(c) a running container created without the configuration, which can be read now, does not open as it is when the build fails with helperFailed (review round 9 of PR #64, R9-1)', async () => {
      await seedEnvironment(h, {
        record: { images: { [BASE_IMAGE]: DIGEST_OLD } },
        container: 'running',
        containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'nimblescape.devenv.container-config': 'unknown' },
      });
      h.helper.buildError = gone;
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.ui.warnings).toEqual([]);
      expect(h.logger.errors.filter((line) => line.includes('opened as it is'))).toEqual([]);
      expect(h.helper.ups).toEqual([]);
      expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
    });

    it('(c) a rebuild whose build fails with helperFailed ends the open with helperFailed although the container still runs (review round 4 of PR #64, R4-4)', async () => {
      await seedEnvironment(h, { container: 'running' });
      h.helper.buildError = gone;
      // User decision 2026-09-29 (a helperFailed during an update fails the open): changed expectation (before: the running container opened as it is
      // with helperFailedOpenedAsItIs('rebuild')).
      const error = await rejection(h.service.openEnvironment(ENV_ID, options({ forceRebuild: true })));
      expect(error.code).toBe('helperFailed');
      expect(h.ui.warnings).toEqual([]);
      expect(h.helper.ups).toEqual([]);
      expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
    });

    it('(c) "Rebuild now" after a configuration change whose build fails with helperFailed ends the open with helperFailed (review round 4 of PR #64, R4-4)', async () => {
      await seedEnvironment(h, { container: 'running' });
      h.helper.files['.devcontainer/devcontainer.json'] = { configText: '{ "image": "node:22", "remoteUser": "node" }' };
      h.ui.configurationChangedAnswer = 'rebuildNow';
      h.helper.buildError = gone;
      // User decision 2026-09-29 (a helperFailed during an update fails the open): changed expectation (before: the running container opened as it is
      // with helperFailedOpenedAsItIs('rebuild')).
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.ui.prompts).toContain(`configurationChanged ${REPO}`);
      expect(h.ui.warnings).toEqual([]);
    });

    it('(c) a selected configuration whose build fails with helperFailed ends the open with helperFailed and is not applied: the previous one stays selected (review round 4 of PR #64, R4-4)', async () => {
      const env = await seedEnvironment(h, { container: 'running' });
      const python = '.devcontainer/python/devcontainer.json';
      h.helper.files[python] = { configText: '{ "image": "python:3.12" }' };
      h.helper.config = { image: 'python:3.12' };
      h.checker.outcome = checked({ 'python:3.12': DIGEST_NEW });
      h.helper.buildError = gone;
      // User decision 2026-09-29 (a helperFailed during an update fails the open): changed expectation (before: the running container opened as it is
      // with helperFailedOpenedAsItIs('configuration', <previous configuration>)).
      const error = await rejection(h.service.openEnvironment(ENV_ID, options({ configPath: python })));
      expect(error.code).toBe('helperFailed');
      expect((await entry())?.configPath).toBe(env.configPath);
      expect(h.ui.warnings).toEqual([]);
      expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
    });

    it('R14-1 a rebuild whose Step 5 helper run fails with helperFailed says that it was not rebuilt', async () => {
      await seedEnvironment(h, { container: 'running' });
      h.helper.readConfigurationError = gone();
      const result = await h.service.openEnvironment(ENV_ID, options({ forceRebuild: true }));
      expect(result.containerName).toBe(NAME);
      expect(h.ui.warnings).toEqual([Messages.helperFailedOpenedAsItIs('rebuild')]);
    });

    it('R14-1 a selected configuration whose helper cannot be prepared is not applied, and the user learns it', async () => {
      const env = await seedEnvironment(h, { container: 'running' });
      const python = '.devcontainer/python/devcontainer.json';
      h.helper.files[python] = { configText: '{ "image": "python:3.12" }' };
      h.helper.config = { image: 'python:3.12' };
      h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'apt-get failed');
      // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
      // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
      // before anything is changed (environmentService.lock.test.ts).
      h.helper.tagPresent = true;
      const result = await h.service.openEnvironment(ENV_ID, options({ configPath: python }));
      expect(result.containerName).toBe(NAME);
      expect((await entry())?.configPath).toBe(env.configPath);
      expect(h.ui.warnings).toEqual([Messages.helperFailedOpenedAsItIs('configuration', configurationName(env.configPath))]);
    });

    it('R14-1 a plain open whose helper cannot be prepared keeps the helperFailed warning', async () => {
      await seedEnvironment(h, { container: 'running' });
      h.helper.readConfigurationError = gone();
      const result = await h.service.open(TARGET, options());
      expect(result.containerName).toBe(NAME);
      expect(h.ui.warnings).toEqual([Messages.helperFailed]);
    });

    // Review round 15 of PR #64 (R15-2): only a helperFailed gets the helper warning; a broken configuration keeps buildFailed.
    it('R15-2 a rebuild with a broken configuration keeps the buildFailed warning, not the helper warning', async () => {
      await seedEnvironment(h, { container: 'running' });
      h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
      const result = await h.service.openEnvironment(ENV_ID, options({ forceRebuild: true }));
      expect(result.containerName).toBe(NAME);
      expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    });

    it('R15-2 a selected configuration that cannot be read keeps the buildFailed warning, not the helper warning', async () => {
      const env = await seedEnvironment(h, { container: 'running' });
      const python = '.devcontainer/python/devcontainer.json';
      h.helper.files[python] = { configText: '{ "image": "python:3.12" }' };
      h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
      const result = await h.service.openEnvironment(ENV_ID, options({ configPath: python }));
      expect(result.containerName).toBe(NAME);
      expect((await entry())?.configPath).toBe(env.configPath);
      expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    });

    it('a container that `up` replaced does not open as it is when runUserCommands fails with helperFailed (review round 4 of PR #64, R4-7 M1)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(before).toBeDefined();
      // Review round 1 of PR #68 (A-R1-1): changed expectation. The new container that `up` created (its lifecycle commands
      // did not run) is removed, and so is its image, so that the next open creates it again with all lifecycle commands
      // (before: the new container stayed running, and the next open opened it as it is).
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
      expect(h.docker.log).toContain(`rmi ${IMAGE_2}`);
      expect(h.docker.images.has(IMAGE_2)).toBe(false);
      expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_1);
      expect(error.detail).toContain('its lifecycle commands could not run. It was removed; the next open creates it again.');
      expect(h.ui.warnings).toEqual([]);
      // The next open, with the helper back, creates the container from the previous image and runs the lifecycle commands.
      // Review round 2 of PR #68 (A-R2-5): changed expectation (before: the checker still reported DIGEST_NEW, so the next
      // open built IMAGE_3, and only one `up` was counted, whatever happened to the container). With the updates off, only
      // the removal of the container makes the next open create it from IMAGE_1 and run its lifecycle commands.
      h.settings.updateImagesOnConnect = false;
      h.helper.userCommandsError = undefined;
      const runs = h.helper.userCommandRuns.length;
      h.helper.calls.length = 0;
      await h.service.open(TARGET, options());
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
      expect(h.helper.builds).toHaveLength(1);
      expect(h.helper.userCommandRuns.length).toBe(runs + 1);
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ image: IMAGE_1, state: 'running' })]);
    });

    /** Review round 2 of PR #68: the next open with the helper back and the updates off runs `up` and the lifecycle commands. */
    async function nextOpenRunsLifecycle(expectedUp: string, open: () => Promise<unknown> = () => h.service.open(TARGET, options())): Promise<void> {
      h.settings.updateImagesOnConnect = false;
      h.helper.userCommandsError = undefined;
      h.helper.upError = () => undefined;
      h.helper.upFailsBeforeRemoval = false;
      const runs = h.helper.userCommandRuns.length;
      h.helper.calls.length = 0;
      await open();
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([expectedUp]);
      expect(h.helper.userCommandRuns.length).toBe(runs + 1);
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ state: 'running' })]);
    }

    it('R2B-1 the removal of the replaced container fails: it is stopped, and the detail says so (review round 2 of PR #68, B-R2-1, A-R2-2)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.userCommandsError = gone();
      const remove = h.docker.removeContainer.bind(h.docker);
      h.docker.removeContainer = async () => {
        throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
      };
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.message).toBe(Messages.helperFailed);
      // Adapted to the root fix of round 2 (the validated test expected the plain helper detail): the container is stopped.
      expect(error.detail).toBe(
        `The container was created again from the new environment image, but its lifecycle commands could not run. It could not be removed and was stopped; the next open starts it and runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).not.toContain(before);
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ image: IMAGE_2, state: 'stopped' })]);
      expect(h.logger.warnings.join('\n')).toContain('Cannot connect to the Docker daemon');
      h.docker.removeContainer = remove;
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
    });

    it('R2B-1b neither the removal nor the stop of the replaced container works: the detail says so (review round 2 of PR #68, A-R2-2)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      h.helper.userCommandsError = gone();
      h.docker.removeContainer = async () => {
        throw new CommandError('docker rm', 1, '', 'Cannot connect to the Docker daemon');
      };
      h.docker.stopContainer = async () => {
        throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
      };
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      // Review round 3 of PR #68 (A-R3-5): changed expectation (before: "… It could be neither removed nor stopped. No such
      // image: …"): the registry marks the container, so the next open runs its lifecycle commands.
      expect(error.detail).toBe(
        `The container was created again from the new environment image, but its lifecycle commands could not run. It could be neither removed nor stopped; the next open runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`,
      );
    });

    it('R2B-2 the detail after the removal keeps the message and the detail of the helper error', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.message).toBe(Messages.helperFailed);
      expect(error.detail).toBe(`The container was created again from the new environment image, but its lifecycle commands could not run. It was removed; the next open creates it again. No such image: sha256:${'4'.repeat(64)}`);
    });

    it('R2B-2b the detail ends with errorDetail of an error without its own detail (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed);
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toMatch(/^The container was created again from the new environment image, but its lifecycle commands could not run\. It was removed; the next open creates it again\. \S/);
    });

    it('R2B-3 a failed lookup of the replaced container is logged, and the container of `up` is removed all the same (review round 2 of PR #68, B-R2-2)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      h.helper.userCommandsError = gone();
      // Adapted to the root fix of round 2: the lookup after run-user-commands is the listing of the containers (before:
      // findContainer, whose failure ended with the plain helper detail).
      const list = h.docker.listEnvironmentContainers.bind(h.docker);
      h.docker.listEnvironmentContainers = async () => {
        if (h.helper.userCommandRuns.length > 0) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
        return list();
      };
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toContain(`It was removed; the next open creates it again. No such image: sha256:${'4'.repeat(64)}`);
      expect(h.logger.warnings.join('\n')).toContain('could not be listed after its lifecycle commands could not run: ');
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
      h.docker.listEnvironmentContainers = list;
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
    });

    it('R2B-3b the containers cannot be listed before `up`: logged, and the container of `up` is only stopped, never removed (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      h.helper.userCommandsError = gone();
      const list = h.docker.listEnvironmentContainers.bind(h.docker);
      h.docker.listEnvironmentContainers = async () => {
        if (new Error().stack?.includes('containersBeforeUp')) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
        return list();
      };
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.logger.warnings.join('\n')).toContain('could not be listed before up: ');
      expect(error.detail).toContain('It was stopped; the next open starts it again and runs its lifecycle commands.');
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ image: IMAGE_2, state: 'stopped' })]);
      h.docker.listEnvironmentContainers = list;
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
    });

    it('the sentences about the container whose lifecycle commands could not run (review round 2 of PR #68)', () => {
      const name = NAME;
      // Review round 3 of PR #68 (A-R3-1): UpWithdrawn carries the container ID.
      const id = 'c1';
      expect(withdrawnOutcome({ outcome: 'removed', id, created: true, name })).toBe('It was removed; the next open creates it again.');
      expect(withdrawnOutcome({ outcome: 'removed', id, created: true, name }, true)).toBe('It was removed.');
      expect(withdrawnOutcome({ outcome: 'stopped', id, created: false, name })).toBe('It was stopped; the next open starts it again and runs its lifecycle commands.');
      expect(withdrawnOutcome({ outcome: 'stoppedAfterRemovalFailed', id, created: true, name })).toBe(
        'It could not be removed and was stopped; the next open starts it and runs its lifecycle commands.',
      );
      expect(withdrawnOutcome({ outcome: 'kept', id, created: true, name })).toBe('It could be neither removed nor stopped.');
      expect(withdrawnOutcome({ outcome: 'kept', id, created: false, name })).toBe('It could not be stopped.');
      expect(withdrawnOutcome({ outcome: 'unchanged', id, created: false, name })).toBe('It runs as before this open.');
    });

    it('review round 3 of PR #68 (A-R3-1, A-R3-4, A-R3-5): the sentences in a switch, for a window that uses it, and for a marked container', () => {
      const name = NAME;
      const id = 'c1';
      // A-R3-1: in a switch, no sentence about the next open (it does not start this container).
      expect(withdrawnOutcome({ outcome: 'stopped', id, created: false, name }, true)).toBe('It was stopped.');
      expect(withdrawnOutcome({ outcome: 'stoppedAfterRemovalFailed', id, created: true, name }, true)).toBe('It could not be removed and was stopped.');
      expect(withdrawnOutcome({ outcome: 'unchanged', id, created: false, name }, true)).toBe('It runs as before this open.');
      // A-R3-4.
      expect(withdrawnOutcome({ outcome: 'inUse', id, created: false, name })).toBe('It was left running: another window is connected to it.');
      expect(withdrawnOutcome({ outcome: 'inUse', id, created: false, name }, true)).toBe('It was left running: another window is connected to it.');
      expect(withdrawnOutcome({ outcome: 'inUse', id, created: false, name, marked: true })).toBe('It was left running: another window is connected to it.');
      // A-R3-4: the files of the windows could not be read (when in doubt, the container stays).
      expect(withdrawnOutcome({ outcome: 'useUnknown', id, created: false, name })).toBe('It was left running: it could not be checked whether another window is connected to it.');
      expect(withdrawnOutcome({ outcome: 'useUnknown', id, created: false, name, marked: true })).toBe(
        'It was left running: it could not be checked whether another window is connected to it; the next open runs its lifecycle commands.',
      );
      expect(withdrawnOutcome({ outcome: 'useUnknown', id, created: false, name, marked: true }, true)).toBe(
        'It was left running: it could not be checked whether another window is connected to it.',
      );
      // A-R3-5: the mark makes the next open run its lifecycle commands (not in a switch, which keeps the previous configuration).
      expect(withdrawnOutcome({ outcome: 'kept', id, created: true, name, marked: true })).toBe('It could be neither removed nor stopped; the next open runs its lifecycle commands.');
      expect(withdrawnOutcome({ outcome: 'kept', id, created: false, name, marked: true })).toBe('It could not be stopped; the next open runs its lifecycle commands.');
      expect(withdrawnOutcome({ outcome: 'kept', id, created: undefined, name, marked: true })).toBe('It could not be stopped; the next open runs its lifecycle commands.');
      expect(withdrawnOutcome({ outcome: 'kept', id, created: true, name, marked: true }, true)).toBe('It could be neither removed nor stopped.');
    });

    it('R2B-6 Cancel during run-user-commands that fails with helperFailed ends as cancelled', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const controller = new AbortController();
      Object.defineProperty(h.helper, 'userCommandsError', {
        configurable: true,
        get: () => {
          controller.abort();
          return gone();
        },
      });
      const error = await rejection(h.service.open(TARGET, options({ signal: controller.signal })));
      expect(error.code).toBe('cancelled');
    });

    it('N1 a first open whose run-user-commands fails with helperFailed says that the new environment is removed again (review round 2 of PR #68)', async () => {
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(
        `The container was created, but its lifecycle commands could not run. The new environment is removed again; open the repository again to create it. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(await h.registry.findForAccount(REPO, ACCOUNT.id)).toBeUndefined();
      expect([...h.docker.containers.values()]).toEqual([]);
    });

    it('a container that `up` created where none was does not open as it is when run-user-commands fails with helperFailed (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: null });
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(
        `The container was created from the environment image, but its lifecycle commands could not run. It was removed; the next open creates it again. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
    });

    it('A-R2-1 the restore creates the container again from the previous image, and its run-user-commands fails with helperFailed: it is removed (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      // `up` of the new image removes the old container and fails for its own reason; the restore creates it again.
      h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs') : undefined);
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${IMAGE_1} --remove-existing-container`]);
      expect(error.detail).toBe(
        `The update failed, and the container was created again from the previous environment image, but its lifecycle commands could not run. It was removed; the next open creates it again. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
      expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_1);
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
    });

    it('A-R2-1 the restore starts the stopped previous container, and its run-user-commands fails with helperFailed: it is stopped again (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs') : undefined);
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`, `up ${IMAGE_1}`]);
      expect(error.detail).toBe(
        `The update failed, and the previous container was started again, but its lifecycle commands could not run. It was stopped; the next open starts it again and runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: before, state: 'stopped' })]);
      expect(h.docker.log).toContain(`stop ${before}`);
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
      expect(h.docker.containersOf(ENV_ID)[0].id).toBe(before);
    });

    it('A-R2-1 the restore finds the previous container running: it is left as it is, and the detail says so (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.upFailsBeforeRemoval = true;
      h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs') : undefined);
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(`The update failed. The previous container runs as before this open. No such image: sha256:${'4'.repeat(64)}`);
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: before, state: 'running' })]);
      expect(h.docker.log.filter((line) => line.startsWith('stop ') || line.startsWith('rm '))).toEqual([]);
      // B-R4-3 (review round 4 of PR #68): it ran before this open, so it is not marked (Environment.lifecycleIncomplete).
      expect((await entry())?.lifecycleIncomplete).toBeUndefined();
    });

    it('Step 9: a stopped container that `up` started is stopped again when run-user-commands fails with helperFailed (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
      expect(error.detail).toBe(
        `The container was started, but its lifecycle commands could not run. It was stopped; the next open starts it again and runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: before, state: 'stopped' })]);
      // B-R4-3 (review round 4 of PR #68): a stopped container needs no mark (the next open starts it and runs them).
      expect((await entry())?.lifecycleIncomplete).toBeUndefined();
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
      expect(h.docker.containersOf(ENV_ID)[0].id).toBe(before);
    });

    it('Step 9: a container that `up` created where none was is removed when run-user-commands fails with helperFailed (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { container: null });
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.builds).toEqual([]);
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
      expect(error.detail).toBe(
        `The container was created, but its lifecycle commands could not run. It was removed; the next open creates it again. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
    });

    it('the container of `up` is told from the containers before it by its whole ID, not by a prefix (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      expect(before).toBe('container-1');
      // Containers of another environment, so that the container that `up` creates gets the ID container-10, which starts
      // with the ID of the running container before `up`.
      for (let i = 0; i < 8; i++) h.docker.addContainer({ environmentId: OTHER_ID, name: `other-${i}`, state: 'stopped', image: IMAGE_1 });
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.userCommandRuns.at(-1)?.containerId).toBe('container-10');
      expect(error.detail).toContain('It was removed; the next open creates it again.');
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    });

    it('Step 9: an outdated container that `up` created again is removed when run-user-commands fails with helperFailed (review round 2 of PR #68)', async () => {
      await seedEnvironment(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
      expect(error.detail).toBe(
        `The container was created again, but its lifecycle commands could not run. It was removed; the next open creates it again. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containersOf(ENV_ID)).toEqual([]);
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
      expect(h.docker.containersOf(ENV_ID)[0].id).not.toBe(before);
    });

    it('B-R3-a a stopped container that `up` started and that cannot be stopped again: the detail says so', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      h.helper.userCommandsError = gone();
      h.docker.stopContainer = async () => {
        throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
      };
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      // Review round 3 of PR #68 (A-R3-5): changed expectation (before: "… It could not be stopped. No such image: …", as
      // reviewer B validated it on the head of round 3): the registry marks the container, so the next open runs its
      // lifecycle commands.
      expect(error.detail).toBe(`The container was started, but its lifecycle commands could not run. It could not be stopped; the next open runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`);
    });

    it('B-R3-b a container that `up` created is removed, not stopped first', async () => {
      await seedEnvironment(h, { container: null });
      h.helper.userCommandsError = gone();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      const created = h.helper.userCommandRuns.at(-1)!.containerId;
      expect(h.docker.log).toContain(`rm ${created}`);
      expect(h.docker.log).not.toContain(`stop ${created}`);
    });

    it('A-R3-5 (review round 3 of PR #68): Step 9, the container can be neither stopped nor removed: the registry marks it, and the next open runs `up` and its lifecycle commands and clears the mark', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      const container = h.docker.containersOf(ENV_ID)[0];
      h.helper.userCommandsError = gone();
      const stop = h.docker.stopContainer.bind(h.docker);
      h.docker.stopContainer = async () => {
        throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
      };
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id, state: 'running' })]);
      expect((await entry())?.lifecycleIncomplete).toBe(container.id);
      // The next open (helper back, updates off): the running container is not opened as it is.
      h.docker.stopContainer = stop;
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
      expect(h.helper.userCommandRuns.at(-1)?.containerId).toBe(container.id);
      expect(h.docker.containersOf(ENV_ID)[0].id).toBe(container.id);
      expect((await entry())?.lifecycleIncomplete).toBeUndefined();
    });

    it('A-R3-5 (review round 3 of PR #68): a running container of the mark is not opened as it is when the helper fails at Step 5', async () => {
      await seedEnvironment(h, { container: 'running' });
      const container = h.docker.containersOf(ENV_ID)[0];
      await h.registry.updateEnvironment(ENV_ID, (environment) => {
        environment.lifecycleIncomplete = container.id;
      });
      h.helper.readConfigurationError = gone();
      const log = h.docker.log.length;
      // Without the mark, it opens as it is (R14-1 a plain open whose helper cannot be prepared keeps the helperFailed warning).
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.ups).toEqual([]);
      expect(h.docker.log.slice(log).filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
      expect((await entry())?.lifecycleIncomplete).toBe(container.id);
      // B-R4-1 (review round 4 of PR #68), the plain open: no warning or log that it opens as it is.
      expect(h.ui.warnings).toEqual([]);
      expect(h.logger.errors.filter((line) => line.includes('opened as it is'))).toEqual([]);
    });

    it('A-R3-5 (review round 3 of PR #68): a mark that names another container does not keep the running container from opening as it is, and the open clears it', async () => {
      await seedEnvironment(h, { container: 'running' });
      await h.registry.updateEnvironment(ENV_ID, (environment) => {
        environment.lifecycleIncomplete = 'f'.repeat(64);
      });
      h.settings.updateImagesOnConnect = false;
      const result = await h.service.open(TARGET, options());
      expect(result.containerName).toBe(NAME);
      expect(h.helper.ups).toEqual([]);
      expect((await entry())?.lifecycleIncomplete).toBeUndefined();
    });

    it('B-R4-1 (review round 4 of PR #68): a running container of the mark, a Rebuild whose helper fails at Step 5: no warning or log that it opens as it is', async () => {
      await seedEnvironment(h, { container: 'running' });
      const container = h.docker.containersOf(ENV_ID)[0];
      await h.registry.updateEnvironment(ENV_ID, (environment) => {
        environment.lifecycleIncomplete = container.id;
      });
      h.helper.readConfigurationError = gone();
      const error = await rejection(h.service.openEnvironment(ENV_ID, options({ forceRebuild: true })));
      expect(error.code).toBe('helperFailed');
      expect(h.ui.warnings).toEqual([]);
      expect(h.logger.errors.filter((line) => line.includes('opened as it is'))).toEqual([]);
      expect(h.helper.ups).toEqual([]);
      expect((await entry())?.lifecycleIncomplete).toBe(container.id);
    });

    /** B-R4-2: the registry refuses every write that sets Environment.lifecycleIncomplete (a lock or a full disk). */
    function markWritesFail(): () => void {
      const update = h.registry.updateEnvironment.bind(h.registry);
      h.registry.updateEnvironment = (async (id: string, mutator: (entry: Environment) => void) =>
        update(id, (entry) => {
          const probe = structuredClone(entry);
          mutator(probe);
          if (probe.lifecycleIncomplete !== undefined && entry.lifecycleIncomplete === undefined) throw new Error('registry locked');
          mutator(entry);
        })) as typeof h.registry.updateEnvironment;
      return () => {
        h.registry.updateEnvironment = update;
      };
    }

    it('B-R4-2 (review round 4 of PR #68): the mark cannot be recorded: the detail does not promise that the next open runs the lifecycle commands', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      const container = h.docker.containersOf(ENV_ID)[0];
      h.helper.userCommandsError = gone();
      const stop = h.docker.stopContainer.bind(h.docker);
      h.docker.stopContainer = async () => {
        throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
      };
      const restore = markWritesFail();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      // PR #68 review round 4, B-R4-2: changed expectation of reviewer B's test (before: "… It could not be stopped. No
      // such image: …"): the detail says that it could not be recorded, as the spec of B-R4-2 (e) asks.
      expect(error.detail).toBe(
        `The container was started, but its lifecycle commands could not run. It could not be stopped, and it could not be recorded that its lifecycle commands did not run: stop or rebuild the environment before working in it. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect((await entry())?.lifecycleIncomplete).toBeUndefined();
      expect(h.logger.warnings.join('\n')).toContain('Could not record the container whose lifecycle commands did not run: registry locked');
      // B-R4-2 (a): nothing says that the next open runs them; (b) the write was tried twice, with a pause.
      expect(h.logger.warnings.join('\n')).not.toContain('The next open runs them');
      expect(h.logger.warnings.filter((line) => line.includes('Could not record the container'))).toHaveLength(2);
      expect(h.logger.errors.join('\n')).toContain(`The container ${NAME} of ${REPO} runs without its lifecycle commands, and this could not be recorded.`);
      expect(h.ui.warnings).toEqual([Messages.lifecycleNotRecorded(REPO)]);
      // B-R4-2 (d): the stop of this container was tried once more.
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id, state: 'running' })]);
      // B-R4-2 (c): the next open of this window does not open it as it is: `up` and the lifecycle commands run.
      restore();
      h.docker.stopContainer = stop;
      await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
      expect(h.helper.userCommandRuns.at(-1)?.containerId).toBe(container.id);
      // And the open after it opens it as it is again (the remembered mark went with the lifecycle commands).
      h.helper.calls.length = 0;
      await h.service.open(TARGET, options());
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([]);
    });

    it('B-R4-2 (review round 4 of PR #68): the mark cannot be recorded, and the second stop works: the container is stopped', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      const container = h.docker.containersOf(ENV_ID)[0];
      h.helper.userCommandsError = gone();
      const stop = h.docker.stopContainer.bind(h.docker);
      let stops = 0;
      h.docker.stopContainer = async (ref) => {
        if (++stops === 1) throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
        return stop(ref);
      };
      markWritesFail();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.detail).toBe(
        `The container was started, but its lifecycle commands could not run. It was stopped; the next open starts it again and runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id, state: 'stopped' })]);
      expect(h.ui.warnings).toEqual([]);
    });

    it('B-R4-2 (review round 4 of PR #68): the files of the windows cannot be read and the mark cannot be recorded: nothing is stopped, and the detail says so', async () => {
      h = recreate({
        windowStatuses: async () => {
          throw new Error('unreadable');
        },
      });
      await seedEnvironment(h, { container: 'stopped' });
      h.helper.userCommandsError = gone();
      markWritesFail();
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(
        `The container was started, but its lifecycle commands could not run. It was left running: it could not be checked whether another window is connected to it, and it could not be recorded that its lifecycle commands did not run: stop or rebuild the environment before working in it. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ state: 'running' })]);
      expect(h.ui.warnings).toEqual([Messages.lifecycleNotRecorded(REPO)]);
      expect(h.logger.warnings.join('\n')).not.toContain('The next open runs them');
    });

    it('A-R4-6 (review round 4 of PR #68): the busy mark of the withdrawal cannot be written: as when the files cannot be read, nothing is touched, and the mark is written', async () => {
      await seedEnvironment(h, { container: 'stopped' });
      const container = h.docker.containersOf(ENV_ID)[0];
      h.helper.userCommandsError = gone();
      const update = h.registry.updateEnvironment.bind(h.registry);
      h.registry.updateEnvironment = (async (id: string, mutator: (entry: Environment) => void) =>
        update(id, (entry) => {
          const probe = structuredClone(entry);
          mutator(probe);
          if (probe.busy !== undefined && entry.busy === undefined && probe.busy.operation === 'update') throw new Error('registry locked');
          mutator(entry);
        })) as typeof h.registry.updateEnvironment;
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(error.detail).toBe(
        `The container was started, but its lifecycle commands could not run. It was left running: it could not be checked whether another window is connected to it; the next open runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`,
      );
      expect(h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
      expect((await entry())?.lifecycleIncomplete).toBe(container.id);
      expect(h.logger.warnings.join('\n')).toContain('could not be set: registry locked');
    });

    describe('A-R3-4 (review round 3 of PR #68): another window is connected to the environment', () => {
      const WINDOW_B = 'window-b';
      const PID_B = 4242;
      const live = (): WindowStatus[] => [{ windowId: WINDOW_B, pid: PID_B, environmentId: ENV_ID, state: 'active', updatedAt: new Date(T0).toISOString() }];

      it('a started container is left running, and nothing is stopped or removed', async () => {
        h = recreate({ windowStatuses: async () => live() });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped' });
        const container = h.docker.containersOf(ENV_ID)[0];
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(error.detail).toBe(`The container was started, but its lifecycle commands could not run. It was left running: another window is connected to it. No such image: sha256:${'4'.repeat(64)}`);
        expect(h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
        expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id, state: 'running' })]);
        expect(h.logger.infos.join('\n')).toContain(`The window ${WINDOW_B} is connected to it.`);
        // It runs without the lifecycle commands of this open: the registry marks it (A-R3-5).
        expect((await entry())?.lifecycleIncomplete).toBe(container.id);
      });

      it('a container of another window that ran before `up` is left running, and not marked', async () => {
        h = recreate({ windowStatuses: async () => live() });
        h.alivePids.add(PID_B);
        // A running container of the mark (A-R3-5): Step 9 runs `up` for it, which finds it running.
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(h.helper.userCommandRuns.at(-1)?.containerId).toBe(container.id);
        expect(error.detail).toContain('It was left running: another window is connected to it.');
        expect(h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
        expect(h.logger.infos.join('\n')).toContain(`The container ${NAME} ran before this open; its lifecycle commands could not run now. The window ${WINDOW_B} is connected to it.`);
        // The mark of the earlier open stays.
        expect((await entry())?.lifecycleIncomplete).toBe(container.id);
      });

      it('B-R4-3 (review round 4 of PR #68): the restore finds the previous container running while another window is connected: it is not marked', async () => {
        h = recreate({ windowStatuses: async () => live() });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
        h.helper.upFailsBeforeRemoval = true;
        h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs') : undefined);
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        // PR #68 review round 5, A-R5-2: added expectation: the previous container ran before this open, so the detail does
        // not say that it "was started again".
        expect(error.detail).toBe(
          `The update failed. The previous container runs; its lifecycle commands could not run. It was left running: another window is connected to it. No such image: sha256:${'4'.repeat(64)}`,
        );
        expect(h.docker.log.filter((line) => line.startsWith('stop ') || line.startsWith('rm '))).toEqual([]);
        expect((await entry())?.lifecycleIncomplete).toBeUndefined();
      });

      it('a window status file of another window whose process is gone, or that is stale, does not count', async () => {
        h = recreate({
          // window-b: a process that is gone (not PID, the process of the tests); window-c: alive, but 61 s old.
          windowStatuses: async () => [{ ...live()[0], pid: 5151 }, { ...live()[0], windowId: 'window-c', pid: 4343, updatedAt: new Date(T0 - 61_000).toISOString() }],
        });
        h.alivePids.add(4343);
        await seedEnvironment(h, { container: 'stopped' });
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(error.detail).toContain('It was stopped; the next open starts it again and runs its lifecycle commands.');
      });

      it('a fresh pending connection file of another window counts too', async () => {
        await seedEnvironment(h, { container: 'stopped' });
        h.sessionFiles.readPendings = async () => [{ environmentId: ENV_ID, windowId: WINDOW_B, createdAt: new Date(T0).toISOString() }];
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        // PR #68 review round 4, A-R4-3: changed expectation (before: "It was left running: another window is connected
        // to it."): a pending connection file means that the other window is opening the environment.
        expect(error.detail).toContain('It was left running: another window is opening the environment.');
        expect(h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
      });

      it('the pending connection file of this window, and a window of another environment, do not count', async () => {
        h = recreate({ windowStatuses: async () => [{ ...live()[0], environmentId: 'other-environment' }] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped' });
        h.sessionFiles.readPendings = async () => [{ environmentId: ENV_ID, windowId: WINDOW_ID, createdAt: new Date(T0).toISOString() }];
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(error.detail).toContain('It was stopped; the next open starts it again and runs its lifecycle commands.');
      });

      // A-R3-4 (review round 3 of PR #68, user focus "when in doubt, keep"): a file that cannot be read makes it unknown
      // whether another window uses the container, so nothing is stopped or removed; the mark makes the next open run the
      // lifecycle commands.
      it('a window status file that cannot be read: the container is left running and marked (logged)', async () => {
        h = recreate({
          windowStatuses: async () => {
            throw new Error('unreadable');
          },
        });
        await seedEnvironment(h, { container: 'stopped' });
        const container = h.docker.containersOf(ENV_ID)[0];
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(error.detail).toBe(
          `The container was started, but its lifecycle commands could not run. It was left running: it could not be checked whether another window is connected to it; the next open runs its lifecycle commands. No such image: sha256:${'4'.repeat(64)}`,
        );
        expect(h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
        expect(h.logger.warnings.join('\n')).toContain('The window status files could not be read: unreadable');
        expect((await entry())?.lifecycleIncomplete).toBe(container.id);
      });

      it('pending connection files that cannot be read: a container that `up` created is not removed (logged)', async () => {
        await seedEnvironment(h, { container: null });
        h.sessionFiles.readPendings = async () => {
          throw new Error('unreadable pendings');
        };
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(error.detail).toContain('It was left running: it could not be checked whether another window is connected to it;');
        expect(h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'))).toEqual([]);
        expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ state: 'running' })]);
        expect(h.logger.warnings.join('\n')).toContain('The pending connection files could not be read: unreadable pendings');
      });
    });

    describe('review round 4 of PR #68', () => {
      const WINDOW_B = 'window-b';
      const PID_B = 5252;
      const live = (): WindowStatus[] => [{ windowId: WINDOW_B, pid: PID_B, environmentId: ENV_ID, state: 'active', updatedAt: new Date(T0).toISOString() }];
      const markOfB = () => ({ operation: 'rebuild' as const, since: new Date(T0).toISOString(), pid: PID_B, windowId: WINDOW_B });
      const touched = (): string[] => h.docker.log.filter((line) => line.startsWith('stop') || line.startsWith('rm'));

      it('A-R4-1: finish keeps a mark that another window set, while this open ran, for the container that this open opens as it is', async () => {
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        h.settings.updateImagesOnConnect = false;
        // Window B: its `up` started the container, and its run-user-commands failed with helperFailed while this open
        // (which found it running and without the mark) prepared Git; B left it running and marked it.
        const prepareGit = h.helper.prepareGit.bind(h.helper);
        h.helper.prepareGit = async (p) => {
          await h.registry.updateEnvironment(ENV_ID, (environment) => {
            environment.lifecycleIncomplete = container.id;
          });
          return prepareGit(p);
        };
        const result = await h.service.open(TARGET, options());
        expect(result.containerName).toBe(NAME);
        expect(h.helper.ups).toEqual([]);
        // Before (round 3): finish deleted every mark, so the container ran without its lifecycle commands and opened as it
        // is at every later open.
        expect((await entry())?.lifecycleIncomplete).toBe(container.id);
        // The next open does not open it as it is: `up` and the lifecycle commands run, and then the mark goes.
        h.helper.prepareGit = prepareGit;
        await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
        expect((await entry())?.lifecycleIncomplete).toBeUndefined();
      });

      it('A-R4-1: which marks finish clears', () => {
        const x = 'a'.repeat(64);
        const y = 'b'.repeat(64);
        expect(lifecycleMarkClears(undefined, x, x)).toBe(false);
        // The value that this run decided with.
        expect(lifecycleMarkClears(x, x, undefined)).toBe(true);
        expect(lifecycleMarkClears(x, x.slice(0, 12), undefined)).toBe(true);
        // The container whose lifecycle commands this run ran.
        expect(lifecycleMarkClears(x, undefined, x)).toBe(true);
        expect(lifecycleMarkClears(x, y, x.slice(0, 12))).toBe(true);
        // A mark that appeared after this run read the entry, for another container than the one of its lifecycle commands.
        expect(lifecycleMarkClears(x, undefined, undefined)).toBe(false);
        expect(lifecycleMarkClears(x, y, undefined)).toBe(false);
        expect(lifecycleMarkClears(x, undefined, y)).toBe(false);
      });

      it('A-R4-4: Step 9 runs the lifecycle commands of a marked running container, and they fail again: the detail does not say that it was started', async () => {
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.settings.updateImagesOnConnect = false;
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(h.helper.userCommandRuns.at(-1)?.containerId).toBe(container.id);
        // Before: "The container was started, but its lifecycle commands could not run. It runs as before this open."
        expect(error.detail).toBe(`The container runs; its lifecycle commands could not run and run at the next open. No such image: sha256:${'4'.repeat(64)}`);
        expect(touched()).toEqual([]);
        expect((await entry())?.lifecycleIncomplete).toBe(container.id);
        await nextOpenRunsLifecycle(`up ${IMAGE_1}`);
        expect((await entry())?.lifecycleIncomplete).toBeUndefined();
      });

      it('A-R4-4: the sentences for a container that ran before `up`, and "created or started" in a switch', () => {
        const name = NAME;
        const id = 'c1';
        expect(withdrawnOutcome({ outcome: 'unchanged', id, created: false, name, marked: true, ranBefore: true })).toBe('It runs; its lifecycle commands run at the next open.');
        // Without the mark, nothing is promised about the next open.
        expect(withdrawnOutcome({ outcome: 'unchanged', id, created: false, name, ranBefore: true })).toBe('It runs as before this open.');
        expect(withdrawnOutcome({ outcome: 'unchanged', id, created: false, name, marked: true, ranBefore: true }, true)).toBe('It runs as before this open.');
        for (const toCompose of [true, false]) {
          const detail = kindSwitchFailure(toCompose, [], 'cause', [], [], 'It was stopped.', true, 'created or started');
          expect(detail).toContain(`${toCompose ? 'Its dev container' : 'Its container'} was created or started, but its lifecycle commands could not run. It was stopped.`);
          expect(kindSwitchFailure(toCompose, [], 'cause', [], [], 'It was removed.')).toContain('was created, but its lifecycle commands could not run.');
        }
      });

      it('A-R4-3: the sentences for another window that opens the environment, and for its busy mark', () => {
        const name = NAME;
        const id = 'c1';
        expect(withdrawnOutcome({ outcome: 'inUse', id, created: false, name, use: 'connected' })).toBe('It was left running: another window is connected to it.');
        expect(withdrawnOutcome({ outcome: 'inUse', id, created: false, name, use: 'opening' })).toBe('It was left running: another window is opening the environment.');
        expect(withdrawnOutcome({ outcome: 'inUse', id, created: false, name, use: 'busy' })).toBe('It was left running: another window is working on the environment.');
      });

      it('A-R4-3: a window status file of another window: the detail says that it is connected, and the log names it', async () => {
        h = recreate({ windowStatuses: async () => live() });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped' });
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.detail).toContain('It was left running: another window is connected to it.');
      });

      it('A-R4-6: the withdrawal sets its busy mark before it reads the files of the windows, and clears it afterwards', async () => {
        await seedEnvironment(h, { container: 'stopped' });
        h.helper.userCommandsError = gone();
        const seen: unknown[] = [];
        h.sessionFiles.readPendings = async () => {
          seen.push((await entry())?.busy);
          return [];
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(error.detail).toContain('It was stopped; the next open starts it again and runs its lifecycle commands.');
        expect(seen).toEqual([expect.objectContaining({ operation: 'update', pid: PID, windowId: WINDOW_ID })]);
        expect((await entry())?.busy).toBeUndefined();
      });

      it('A-R4-6: a busy mark of another window that appeared during `up`: nothing is stopped or removed, the container is marked, and that mark stays', async () => {
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: null });
        h.helper.userCommandsError = gone();
        // Window B begins an operation (for example a rebuild) while `up` of this open runs.
        const up = h.helper.up.bind(h.helper);
        h.helper.up = async (p) => {
          const result = await up(p);
          await h.registry.updateEnvironment(ENV_ID, (environment) => {
            environment.busy = markOfB();
          });
          return result;
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(error.detail).toBe(
          `The container was created, but its lifecycle commands could not run. It was left running: another window is working on the environment. No such image: sha256:${'4'.repeat(64)}`,
        );
        expect(touched()).toEqual([]);
        const container = h.docker.containersOf(ENV_ID)[0];
        expect(container.state).toBe('running');
        expect((await entry())?.lifecycleIncomplete).toBe(container.id);
        expect((await entry())?.busy).toEqual(markOfB());
      });

      it('A-R4-6: an outer mark of this window is never overwritten nor cleared by the withdrawal', async () => {
        await seedEnvironment(h, { container: 'stopped' });
        // 2026-10-01: the Switch branch command was dropped (user decision). The outer mark is of a rebuild.
        const outer = { operation: 'rebuild' as const, since: new Date(T0).toISOString(), pid: PID, windowId: WINDOW_ID };
        const up = h.helper.up.bind(h.helper);
        h.helper.up = async (p) => {
          const result = await up(p);
          await h.registry.updateEnvironment(ENV_ID, (environment) => {
            environment.busy = outer;
          });
          return result;
        };
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        expect(touched()).toEqual([]);
        expect((await entry())?.busy).toEqual(outer);
      });

      it('A-R4-5: Step 9 does not remove the stray containers of other services next to a marked running container that another window uses', async () => {
        h = recreate({ windowStatuses: async () => live() });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        const db = h.docker.addContainer({
          environmentId: ENV_ID,
          name: `${NAME}-db-1`,
          state: 'running',
          image: 'postgres:16',
          labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.service': 'db' },
        });
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.settings.updateImagesOnConnect = false;
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toBe(
          `To start the environment, the containers ${db.name} of other Docker Compose services must be removed, but another window is connected to the environment. Nothing was stopped, removed, or renamed. Open or rebuild the environment again when that window is closed.`,
        );
        expect(touched()).toEqual([]);
        expect(h.helper.ups).toEqual([]);
        expect(h.docker.containersOf(ENV_ID).map((c) => [c.id, c.state])).toEqual([
          [container.id, 'running'],
          [db.id, 'running'],
        ]);
        expect((await entry())?.lifecycleIncomplete).toBe(container.id);
        expect((await entry())?.busy).toBeUndefined();
      });

      it('A-R4-5: without another window, Step 9 sets the busy mark before it removes the strays, and the open clears it', async () => {
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        const db = h.docker.addContainer({
          environmentId: ENV_ID,
          name: `${NAME}-db-1`,
          state: 'running',
          image: 'postgres:16',
          labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.service': 'db' },
        });
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.settings.updateImagesOnConnect = false;
        let busyAtRemoval: unknown;
        const remove = h.docker.removeContainer.bind(h.docker);
        h.docker.removeContainer = async (ref) => {
          busyAtRemoval = (await entry())?.busy;
          return remove(ref);
        };
        await h.service.open(TARGET, options());
        expect(h.docker.log).toContain(`rm ${db.id}`);
        expect(busyAtRemoval).toMatchObject({ operation: 'update', pid: PID, windowId: WINDOW_ID });
        expect(h.helper.userCommandRuns.at(-1)?.containerId).toBe(container.id);
        expect((await entry())?.lifecycleIncomplete).toBeUndefined();
        expect((await entry())?.busy).toBeUndefined();
      });

      it('A-R4-5: Step 9 does not create an outdated running container again while another window is opening the environment', async () => {
        await seedEnvironment(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
        const container = h.docker.containersOf(ENV_ID)[0];
        h.sessionFiles.readPendings = async () => [{ environmentId: ENV_ID, windowId: WINDOW_B, createdAt: new Date(T0).toISOString() }];
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toContain(`the container ${NAME} must be created again, but another window is opening the environment. Nothing was stopped, removed, or renamed.`);
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
        expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id, state: 'running' })]);
        expect((await entry())?.busy).toBeUndefined();
      });

      it('A-R4-5: when the files of the windows cannot be read, Step 9 changes nothing', async () => {
        await seedEnvironment(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
        h.sessionFiles.readPendings = async () => {
          throw new Error('unreadable pendings');
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toContain('but it could not be checked whether another window uses the environment. Nothing was stopped, removed, or renamed.');
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
      });

      it('A-R4-5: a live busy mark of another window that appeared during the open: Step 9 changes nothing, and that mark stays', async () => {
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'running', containerLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
        // After the wait for other operations at the start of the open: while the configuration is read.
        const read = h.helper.readConfiguration.bind(h.helper);
        h.helper.readConfiguration = async (p) => {
          await h.registry.updateEnvironment(ENV_ID, (environment) => {
            environment.busy = markOfB();
          });
          return read(p);
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toContain('but another window is working on the environment. Nothing was stopped, removed, or renamed.');
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
        expect((await entry())?.busy).toEqual(markOfB());
      });

      it('B-R5-7: the busy mark of the withdrawal goes also when the withdrawal throws', async () => {
        // PR #68 review round 5, B-R5-7.
        await seedEnvironment(h, { container: 'stopped' });
        h.helper.userCommandsError = gone();
        h.docker.stopContainer = async () => {
          throw new CommandError('docker stop', 1, '', 'Cannot connect to the Docker daemon');
        };
        markWritesFail();
        h.ui.warn = () => {
          throw new Error('ui gone');
        };
        await rejection(h.service.open(TARGET, options()));
        expect((await entry())?.busy).toBeUndefined();
      });
    });

    describe('review round 5 of PR #68', () => {
      const WINDOW_B = 'window-b';
      const PID_B = 5353;
      const statusOfB = (ageMs = 0): WindowStatus => ({ windowId: WINDOW_B, pid: PID_B, environmentId: ENV_ID, state: 'active', updatedAt: new Date(T0 - ageMs).toISOString() });
      const touched = (): string[] => h.docker.log.filter((line) => line.startsWith('stop ') || line.startsWith('rm '));
      const outdated = { [LABEL_CONTAINER_VERSION]: '0' };
      /** `devcontainer up` of CLI 0.89.0 when /etc/passwd of the container lacks the user (a damaged container). */
      const damagedUp = (): DevcontainerCommandError => {
        const message = 'An error occurred setting up the container.';
        const result = { outcome: 'error' as const, message, description: message, containerId: 'container-1' };
        return new DevcontainerCommandError(
          'devcontainer up',
          1,
          `${JSON.stringify(result)}\n`,
          `Shell server terminated (code: 1, signal: null)\n\nError response from daemon: unable to find user vscode: no matching entries in passwd file\n\nError: ${message}`,
          result,
        );
      };
      const REFUSED_CONNECTED = `To start the environment, the container ${NAME} must be created again, but another window is connected to the environment. Nothing was stopped, removed, or renamed. Open or rebuild the environment again when that window is closed.`;
      /** Runs `onMark` right after this window set its busy mark `update` (takeStepMark of requireNoOtherWindow). */
      const afterStepMark = (onMark: () => void): void => {
        const update = h.registry.updateEnvironment.bind(h.registry);
        h.registry.updateEnvironment = (async (id: string, mutator: (entry: Environment) => void) => {
          const before = (await h.registry.get(id))?.busy;
          const updated = await update(id, mutator);
          if (before === undefined && updated?.busy?.operation === 'update' && updated.busy.pid === PID) onMark();
          return updated;
        }) as typeof h.registry.updateEnvironment;
      };

      it('A-R5-1: a stopped outdated container, and window B `active` and alive: `up` creates it again (B cannot be attached to a stopped container)', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB()] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        const old = h.docker.containersOf(ENV_ID)[0];
        const result = await h.service.open(TARGET, options());
        expect(result.containerName).toBe(NAME);
        // Before (round 4): startFailed "…must be created again, but another window is connected to the environment."
        expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
        expect(h.docker.containers.has(old.id)).toBe(false);
        expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ name: NAME, state: 'running' })]);
        expect(h.logger.infos.join('\n')).toContain(`No container of ${REPO} runs.`);
        expect((await entry())?.busy).toBeUndefined();
      });

      it('A-R5-1: Step 9 saw the container stopped, but it runs when checked with the mark held: window B counts, nothing is changed', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB()] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        const container = h.docker.containersOf(ENV_ID)[0];
        // Window B (its Dev Containers extension) starts it after the listing of Step 9.
        afterStepMark(() => {
          container.state = 'running';
          container.rawState = 'running';
        });
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toBe(REFUSED_CONNECTED);
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
        expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id, state: 'running' })]);
        expect((await entry())?.busy).toBeUndefined();
      });

      it('A-R5-1: the container is stopped, but window B has a fresh pending connection file: nothing is changed', async () => {
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        h.sessionFiles.readPendings = async () => [{ environmentId: ENV_ID, windowId: WINDOW_B, createdAt: new Date(T0).toISOString() }];
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toContain('but another window is opening the environment. Nothing was stopped, removed, or renamed.');
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
      });

      it('A-R5-1: the container is stopped, but the window status files cannot be read: nothing is changed', async () => {
        h = recreate({
          windowStatuses: async () => {
            throw new Error('unreadable');
          },
        });
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toContain('but it could not be checked whether another window uses the environment.');
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
      });

      it('B-R6-1: the container is stopped, but the pending connection files cannot be read: nothing is changed', async () => {
        // PR #68 review round 6, B-R6-1.
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        h.sessionFiles.readPendings = async () => {
          throw new Error('unreadable pendings');
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toContain('but it could not be checked whether another window uses the environment.');
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
      });

      it.each([
        ['runs', 'running'],
        ['is paused', 'paused'],
        ['restarts', 'restarting'],
      ])('A-R5-1: the dev container is stopped, but a container of another service %s: window B counts, nothing is changed', async (_name, rawState) => {
        h = recreate({ windowStatuses: async () => [statusOfB()] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        const db = h.docker.addContainer({
          environmentId: ENV_ID,
          name: `${NAME}-db-1`,
          state: 'running',
          image: 'postgres:16',
          labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.service': 'db' },
        });
        db.rawState = rawState;
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toBe(REFUSED_CONNECTED);
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
        expect(h.logger.infos.join('\n')).toContain(`${db.name} (${rawState})`);
      });

      it('A-R5-1: a container of another service that was created, but never started, does not run: `up` creates the dev container again', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB()] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        const db = h.docker.addContainer({
          environmentId: ENV_ID,
          name: `${NAME}-db-1`,
          state: 'stopped',
          image: 'postgres:16',
          labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.service': 'db' },
        });
        db.rawState = 'created';
        await h.service.open(TARGET, options());
        expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
      });

      it('A-R5-1 (verifier 2): the dev container runs and a stray service is stopped: window B counts, nothing is changed', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB()] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        const db = h.docker.addContainer({
          environmentId: ENV_ID,
          name: `${NAME}-db-1`,
          state: 'stopped',
          image: 'postgres:16',
          labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.service': 'db' },
        });
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.settings.updateImagesOnConnect = false;
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toContain('but another window is connected to the environment. Nothing was stopped, removed, or renamed.');
        expect(touched()).toEqual([]);
        expect(h.helper.ups).toEqual([]);
        expect(h.docker.containersOf(ENV_ID).map((c) => [c.id, c.state])).toEqual([
          [container.id, 'running'],
          [db.id, 'stopped'],
        ]);
      });

      it('A-R5-1: the containers cannot be listed with the mark held: they count as running, and window B counts', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB()] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        let marked = false;
        afterStepMark(() => {
          marked = true;
        });
        const list = h.docker.listEnvironmentContainers.bind(h.docker);
        h.docker.listEnvironmentContainers = async () => {
          if (marked) throw new CommandError('docker inspect', 1, '', 'Error response from daemon: inspect failed');
          return list();
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toBe(REFUSED_CONNECTED);
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
        expect(h.logger.warnings.join('\n')).toContain('Error response from daemon: inspect failed. They count as running.');
      });

      it('risk 2: the container runs, and the status file of the live window B is 75 s old (not fresh, not stale): not known, nothing is changed', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB(75_000)] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'running', containerLabels: outdated });
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        // Before: B's file was older than 60 s, so it did not count, and the container was removed.
        expect(error.detail).toContain('but it could not be checked whether another window uses the environment. Nothing was stopped, removed, or renamed.');
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
        expect(h.logger.warnings.join('\n')).toContain(`The window ${WINDOW_B} (process ${PID_B}) last wrote its status at`);
      });

      it('risk 2: a file older than the Session Monitor\'s limit (60 s plus the waiting time), or of a process that is gone, does not count', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB(91_000), { ...statusOfB(75_000), windowId: 'window-c', pid: 6161 }] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'running', containerLabels: outdated });
        await h.service.open(TARGET, options());
        expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
      });

      it('risk 2: the limit follows the waiting time of the settings', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB(150_000)] });
        h.alivePids.add(PID_B);
        h.settings.waitingTimeSeconds = 120;
        await seedEnvironment(h, { container: 'running', containerLabels: outdated });
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.detail).toContain('but it could not be checked whether another window uses the environment.');
        expect(h.helper.ups).toEqual([]);
      });

      it('risk 2: the sleep grace (the status file of this window is old too): a live window counts whatever the age of its file', async () => {
        h = recreate({
          windowStatuses: async () => [statusOfB(10 * 60_000), { windowId: WINDOW_ID, pid: PID, environmentId: ENV_ID, state: 'active', updatedAt: new Date(T0 - 40_000).toISOString() }],
        });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'running', containerLabels: outdated });
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.detail).toContain('but it could not be checked whether another window uses the environment.');
        expect(h.helper.ups).toEqual([]);
        expect(touched()).toEqual([]);
      });

      it('risk 2: only while a container runs: a stopped container is created again despite a 75 s old file of the live window B', async () => {
        h = recreate({ windowStatuses: async () => [statusOfB(75_000)] });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'stopped', containerLabels: outdated });
        await h.service.open(TARGET, options());
        expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
      });

      it('risk 3: the busy mark of Step 9 is not held while the recreate question is open, and the recreation takes its own', async () => {
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        h.docker.addContainer({
          environmentId: ENV_ID,
          name: `${NAME}-db-1`,
          state: 'running',
          image: 'postgres:16',
          labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.service': 'db' },
        });
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.settings.updateImagesOnConnect = false;
        // The stray is removed with the mark of Step 9 (requireNoOtherWindow); then `up` of the damaged container fails.
        h.helper.upError = (_image, removeExisting) => (removeExisting ? undefined : damagedUp());
        const atQuestion: unknown[] = [];
        h.ui.recreateContainer = async () => {
          atQuestion.push((await entry())?.busy);
          return true;
        };
        const busyAtUp: unknown[] = [];
        const up = h.helper.up.bind(h.helper);
        h.helper.up = async (p) => {
          busyAtUp.push((await entry())?.busy?.operation);
          return up(p);
        };
        const result = await h.service.open(TARGET, options());
        expect(result.containerName).toBe(NAME);
        // Before: the mark `update` of Step 9 was held during the question.
        expect(atQuestion).toEqual([undefined]);
        expect(busyAtUp).toEqual(['update', 'rebuild']);
        expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`, `up ${IMAGE_1} --remove-existing-container`]);
        expect((await entry())?.busy).toBeUndefined();
      });

      it('B-R6-2: the mark of Step 9 cannot be cleared before the recreate question, and the user declines: the mark does not stay', async () => {
        // PR #68 review round 6, B-R6-2.
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        h.docker.addContainer({
          environmentId: ENV_ID,
          name: `${NAME}-db-1`,
          state: 'running',
          image: 'postgres:16',
          labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.service': 'db' },
        });
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.settings.updateImagesOnConnect = false;
        h.helper.upError = (_image, removeExisting) => (removeExisting ? undefined : damagedUp());
        // The first write that would clear this window's mark `update` fails (the release before the question).
        let failed = false;
        const update = h.registry.updateEnvironment.bind(h.registry);
        h.registry.updateEnvironment = (async (id: string, mutator: (entry: Environment) => void) => {
          const current = await h.registry.get(id);
          if (!failed && current?.busy?.operation === 'update' && current.busy.pid === PID) {
            const probe = structuredClone(current);
            mutator(probe);
            if (probe.busy === undefined) {
              failed = true;
              throw new Error('registry locked');
            }
          }
          return update(id, mutator);
        }) as typeof h.registry.updateEnvironment;
        const atQuestion: unknown[] = [];
        h.ui.recreateContainer = async () => {
          atQuestion.push((await entry())?.busy?.operation);
          return false;
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(failed).toBe(true);
        expect(atQuestion).toEqual(['update']);
        expect(h.helper.calls).not.toContain(`up ${IMAGE_1} --remove-existing-container`);
        expect((await entry())?.busy).toBeUndefined();
      });

      it('risk 3: another window connects while the recreate question is open: nothing is removed', async () => {
        const statuses: WindowStatus[] = [];
        h = recreate({ windowStatuses: async () => statuses });
        h.alivePids.add(PID_B);
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.settings.updateImagesOnConnect = false;
        h.helper.upError = (_image, removeExisting) => (removeExisting ? undefined : damagedUp());
        h.ui.recreateContainer = async () => {
          statuses.push(statusOfB());
          return true;
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toBe(
          `To create the damaged container ${NAME} again, it must be removed, but another window is connected to the environment. Nothing was stopped, removed, or renamed. Open or rebuild the environment again when that window is closed.`,
        );
        expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
        expect(touched()).toEqual([]);
        expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id, state: 'running' })]);
        expect((await entry())?.busy).toBeUndefined();
      });

      it('risk 3: another window begins to open the environment while the recreate question is open: nothing is removed', async () => {
        await seedEnvironment(h, { container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.settings.updateImagesOnConnect = false;
        h.helper.upError = (_image, removeExisting) => (removeExisting ? undefined : damagedUp());
        h.ui.recreateContainer = async () => {
          h.sessionFiles.readPendings = async () => [{ environmentId: ENV_ID, windowId: WINDOW_B, createdAt: new Date(T0).toISOString() }];
          return true;
        };
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('startFailed');
        expect(error.detail).toContain('but another window is opening the environment. Nothing was stopped, removed, or renamed.');
        expect(touched()).toEqual([]);
        expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id })]);
      });

      it('A-R5-2: the restore finds the previous container running and marked: the detail keeps the promise of the mark, and does not say "started"', async () => {
        await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
        const container = h.docker.containersOf(ENV_ID)[0];
        await h.registry.updateEnvironment(ENV_ID, (environment) => {
          environment.lifecycleIncomplete = container.id;
        });
        h.helper.upFailsBeforeRemoval = true;
        h.helper.upError = (image) => (image === IMAGE_2 ? new DevcontainerCommandError('devcontainer up', 1, '', 'invalid runArgs') : undefined);
        h.helper.userCommandsError = gone();
        const error = await rejection(h.service.open(TARGET, options()));
        expect(error.code).toBe('helperFailed');
        // Before: "The update failed. The previous container runs as before this open." although the mark names it.
        expect(error.detail).toBe(`The update failed. The previous container runs; its lifecycle commands could not run and run at the next open. No such image: sha256:${'4'.repeat(64)}`);
        expect(touched()).toEqual([]);
        expect((await entry())?.lifecycleIncomplete).toBe(container.id);
      });

      it('A-R5-2: a (dev) container that ran before `up` of a switch "runs already"; it was neither created nor started', () => {
        for (const toCompose of [true, false]) {
          const detail = kindSwitchFailure(toCompose, [], 'cause', [], [], 'It was left running: another window is connected to it.', true, 'started', true);
          expect(detail).toContain(`${toCompose ? 'Its dev container' : 'Its container'} runs already, but its lifecycle commands could not run. It was left running: another window is connected to it.`);
          expect(detail).not.toContain('started,');
        }
        const withdrawn = { outcome: 'inUse' as const, id: 'c1', created: false, name: NAME, ranBefore: true };
        expect(afterUpClause('The dev container of the service web', withdrawn)).toBe('The dev container of the service web runs already, but its lifecycle commands could not run.');
        expect(afterUpClause('The dev container of the service web', { ...withdrawn, ranBefore: undefined })).toBe('The dev container of the service web was started, but its lifecycle commands could not run.');
        expect(afterUpClause('X', { ...withdrawn, created: undefined, ranBefore: undefined })).toBe('X was created or started, but its lifecycle commands could not run.');
      });
    });

    it('a container that was stopped during the failing build does not open as it is (review round 4 of PR #64, R4-7 M2)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const container = h.docker.containersOf(ENV_ID)[0];
      // For example stopped by the user, or by the Session Monitor, while the build ran: the same ID, not running.
      h.helper.onBuild = () => {
        container.state = 'stopped';
        container.rawState = 'exited';
      };
      h.helper.buildError = gone;
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: container.id, state: 'stopped' })]);
      expect(h.ui.warnings).toEqual([]);
    });

    it('ends with helperFailed after the failing build without looking the container up again (review round 4 of PR #64, R4-7 M3; user decision 2026-09-29)', async () => {
      // Review round 1 of PR #68 (A-R1-4): the lookup after the build is gone (before: a failing lookup was set up here and
      // its warning checked); the test now counts that no lookup happens.
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const find = h.docker.findContainer.bind(h.docker);
      let afterBuild = false;
      let lookupsAfterBuild = 0;
      h.docker.findContainer = async (id, name) => {
        if (afterBuild) lookupsAfterBuild++;
        return find(id, name);
      };
      h.helper.onBuild = () => {
        afterBuild = true;
      };
      h.helper.buildError = gone;
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(lookupsAfterBuild).toBe(0);
      expect(h.docker.containersOf(ENV_ID)[0].state).toBe('running');
      expect(h.ui.warnings).toEqual([]);
    });

    it('ends as cancelled, not opened as it is, when Cancel is pressed during the build that fails with helperFailed (review round 4 of PR #64, R4-7 M3)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const controller = new AbortController();
      // The build fails with helperFailed while Cancel is pressed.
      h.helper.buildError = () => {
        controller.abort();
        return gone();
      };
      const error = await rejection(h.service.open(TARGET, options({ signal: controller.signal })));
      expect(error.code).toBe('cancelled');
      expect(h.logger.errors.join('\n')).not.toContain('The running environment is opened as it is');
      expect(h.ui.warnings).toEqual([]);
    });

    // Changed expectation, review round 14 of PR #64 (R14-4): a helperFailed of `up` itself means that its helper container
    // never started, so `up` removed nothing (R13-2); the fake no longer removes the container before such an error.
    // User decision 2026-09-29 (a helperFailed during an update fails the open): the open ends with helperFailed although the
    // container still runs (before: the running container opened as it is with helperFailedOpenedAsItIs('update')).
    it('a running container that `up` could not reach is kept, and the open ends with helperFailed: helperFailed of `up` removed nothing', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'running' });
      const before = h.docker.containersOf(ENV_ID)[0].id;
      h.helper.upError = (image) => (image === IMAGE_2 ? gone() : undefined);
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('helperFailed');
      expect(h.helper.calls.filter((c) => c.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([before]);
      expect(h.ui.warnings).toEqual([]);
    });
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

    it('leaves the recorded service folders out of the fix before up of a resumed clone of a single container (review round 12, D12-1)', async () => {
      const pg = `/workspaces/${REPO.split('/')[1]}/pgdata`;
      await seedEnvironment(h, { record: null, container: null, extra: { busy: staleCreate, serviceFolders: [pg] } });
      await h.service.open(TARGET, options());
      const before = h.docker.runs.find((run) => run.args[0] === '-c');
      expect(before).toBeDefined();
      expect(before!.args).toContain(pg);
      expect(before!.args).toContain(`${pg}/*`);
    });

    it('fixes only the files of root before up of a resumed clone of a single container when the recorded paths overflowed (review round 1 of PR #81, B-R1-1)', async () => {
      // Review round 1 of PR #81 (B-R1-1): the overflow branch had no test of its own; the deleted Switch branch test only
      // covered its copy in switchServiceFolders.
      const repo = `/workspaces/${REPO.split('/')[1]}`;
      const pg = `${repo}/pgdata`;
      await seedEnvironment(h, { record: null, container: null, extra: { busy: staleCreate, serviceFolders: [pg], serviceFoldersOverflow: true } });
      await h.service.open(TARGET, options());
      const before = h.docker.runs.find((run) => run.args[0] === '-c');
      expect(before).toBeDefined();
      expect(before!.args.slice(-5)).toEqual(['-path', repo, '-o', '-path', `${repo}/*`]);
      expect(before!.args).not.toContain(pg);
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

  it('creates an environment of the account next to a restored volume of another account (concept D-3)', async () => {
    h.docker.volumes.set(OLD_NAME, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).not.toBe(OTHER_ID);
    expect(result.environment.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toEqual([expect.objectContaining({ volumeName: result.environment.volumeName, token: TOKEN })]);
    // The environment of the other account is restored, stays as it is, and is not named.
    expect(await h.registry.get(OTHER_ID)).toMatchObject({ volumeName: OLD_NAME, owner: { id: OTHER_ACCOUNT.id } });
    expect(h.docker.volumes.get(OLD_NAME)).toEqual({ [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    expect(h.docker.containersOf(OTHER_ID)).toEqual([]);
    expect([...h.ui.infos, ...h.ui.warnings]).toEqual([]);
  });

  it('restores no volume without a valid label nimblescape.devenv.owner-id, and creates an environment of the account', async () => {
    h.docker.volumes.set(OLD_NAME, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO });
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).not.toBe(OTHER_ID);
    expect((await h.registry.list()).map((e) => e.id)).toEqual([result.environment.id]);
    expect(h.docker.volumes.has(OLD_NAME)).toBe(true);
  });

  it('creates the environment when only volumes of other repositories exist, and restores those', async () => {
    h.docker.volumes.delete(OLD_NAME);
    h.docker.volumes.set(resourceName('acme/web', OTHER_ID), { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/web', [LABEL_OWNER_ID]: ACCOUNT.id });
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
    // Lifecycle token (user decision 2026-09-27): the token write (also as root) now comes before the ownership fix after up.
    expect(h.docker.execs.find(isOwnershipFix)?.command.slice(-2)).toEqual(['/workspaces/api', 'node']);
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
    // Monitor cleanup, user decision 2026-09-29 (R7): a disconnect request of the environment goes with it; one of another stays.
    fs.mkdirSync(h.paths.disconnectDir, { recursive: true });
    fs.writeFileSync(h.paths.disconnectFile(ENV_ID), '{}');
    fs.writeFileSync(h.paths.disconnectFile(OTHER_ID), '{}');

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
    expect(fs.existsSync(h.paths.disconnectFile(ENV_ID))).toBe(false);
    expect(fs.existsSync(h.paths.disconnectFile(OTHER_ID))).toBe(true);
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
    // Without the labels of the environment (for example made by hand): the user removes it.
    h.docker.volumes.set('legacy', {});
    h.docker.volumes.set('other-env', additionalVolumeLabels(OTHER_ID));
    h.docker.volumes.set('other-owner', additionalVolumeLabels(ENV_ID, OTHER_ACCOUNT));
    // A volume without an owner label (made by hand) is not its own: the owner label must match too.
    h.docker.volumes.set('no-owner', additionalVolumeLabels(ENV_ID, null));
    await h.service.delete(ENV_ID, options({ additionalVolumesToRemove: ['own', 'legacy', 'other-env', 'other-owner', 'no-owner'] }));
    expect(h.docker.volumes.has('own')).toBe(false);
    expect(h.docker.volumes.has('no-owner')).toBe(true);
    expect(h.docker.volumes.has('legacy')).toBe(true);
    expect(h.docker.volumes.has('other-env')).toBe(true);
    expect(h.docker.volumes.has('other-owner')).toBe(true);
    const unlabeled = 'its labels do not show that this environment created it';
    expect(h.logger.infos).toEqual(
      expect.arrayContaining([
        `The volume legacy is kept, because ${unlabeled}.`,
        'The volume other-env is kept, because another environment created it.',
        'The volume other-owner is kept, because another environment created it.',
        'The volume no-owner is kept, because another environment created it.',
      ]),
    );
    expect(h.docker.log.filter((line) => line.startsWith('volume rm ') && !line.endsWith(NAME))).toEqual(['volume rm own']);
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

describe('configuration queries', () => {
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

describe('refreshStates (plan step 5, PR C)', () => {
  const direct = {
    runtime: new Map([
      [ENV_ID, { container: 'running', volume: true }],
      [OTHER_ID, { container: 'missing', volume: false }],
    ]),
    branches: new Map([[ENV_ID, 'feature-q']]),
  };

  async function seedTwo(harness: Harness): Promise<void> {
    await seedEnvironment(harness, { container: 'running' });
    await seedEnvironment(harness, { id: OTHER_ID, repository: 'acme/web', container: null, volume: false });
    harness.docker.execHandler = () => ({ stdout: 'feature-q\n' });
  }

  it('reads directly without a worker: the states, and the branches of the running environments that were asked for', async () => {
    await seedTwo(h);
    expect(await h.service.refreshStates(new Set([ENV_ID, OTHER_ID]))).toEqual(direct);
    expect(h.docker.execs).toHaveLength(1);
    expect(h.docker.execs[0]).toMatchObject({ container: NAME, user: 'vscode' });
    // No branch read for an environment whose branch was not asked for.
    expect(await h.service.refreshStates(new Set())).toEqual({ ...direct, branches: new Map() });
    expect(h.docker.execs).toHaveLength(1);
  });

  it('takes the states of the worker, with the environments of the current host', async () => {
    const fromWorker = { runtime: new Map([[ENV_ID, { container: 'stopped' as const, volume: true }]]), branches: new Map<string, string>() };
    const workerRefresh = vi.fn(async () => fromWorker);
    h = recreate({ workerRefresh });
    await seedTwo(h);
    expect(await h.service.refreshStates(new Set([ENV_ID]))).toBe(fromWorker);
    expect(workerRefresh).toHaveBeenCalledTimes(1);
    expect(workerRefresh.mock.calls[0]).toEqual([
      [
        { id: ENV_ID, containerName: NAME, volumeName: NAME, user: 'vscode', folder: '/workspaces/api', branch: true },
        { id: OTHER_ID, containerName: resourceName('acme/web', OTHER_ID), volumeName: resourceName('acme/web', OTHER_ID), user: 'vscode', folder: '/workspaces/web', branch: false },
      ],
    ]);
    expect(h.docker.execs).toHaveLength(0);
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): changed expectation. Before, a failed worker refresh was read once more
  // directly. Now only undefined (outside of an operation) reads directly; a failure fails the refresh, with its cause.
  it('reads directly only when the worker gives undefined (outside of an operation); a failure fails the refresh (logged), never read directly', async () => {
    const workerRefresh = vi.fn(async (): Promise<undefined> => undefined);
    h = recreate({ workerRefresh });
    await seedTwo(h);
    expect(await h.service.refreshStates(new Set([ENV_ID]))).toEqual(direct);
    workerRefresh.mockRejectedValueOnce(new Error('The Dev Environments worker on the Docker host could not be prepared (no helper image)'));
    expect(await h.service.refreshStates(new Set([ENV_ID]))).toEqual({ runtime: undefined, branches: new Map() });
    expect(workerRefresh).toHaveBeenCalledTimes(2);
    expect(h.logger.warnings.join('\n')).toContain(
      'The state of the environments could not be read: The Dev Environments worker on the Docker host could not be prepared (no helper image)',
    );
    expect(h.logger.warnings.join('\n')).not.toContain('read directly');
  });

  it('does not ask the worker when Docker does not run', async () => {
    const workerRefresh = vi.fn(async (): Promise<undefined> => undefined);
    h = recreate({ workerRefresh });
    await seedTwo(h);
    h.docker.running = false;
    expect(await h.service.refreshStates(new Set([ENV_ID]))).toEqual({ runtime: undefined, branches: new Map() });
    expect(workerRefresh).not.toHaveBeenCalled();
  });
});

describe('reconcileFromVolumes', () => {
  it('adds an entry for each labeled volume that the registry lacks', async () => {
    await seedEnvironment(h);
    const name = resourceName('acme/web', OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/web', [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.volumes.set('bad', { [LABEL_ENVIRONMENT_ID]: '../x', [LABEL_REPOSITORY]: 'acme/bad', [LABEL_OWNER_ID]: ACCOUNT.id });
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

  // Review round 1 of unit 5 (VOL-2): a named volume without labels that the container mounts ('api-history', for
  // example one that Docker created at `up`) is restored again, as origin/main did, so that another
  // account cannot mount it; this test expected it to be left out before. Delete still keeps it (not the environment's own).
  it('restores its own labelled volumes and the unlabelled named volumes of its container: not anonymous ones, not those of other programs or environments', async () => {
    const name = resourceName('acme/api', OTHER_ID);
    const anonymous = 'ab'.repeat(32);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/api', [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.volumes.set('api-node_modules', additionalVolumeLabels(OTHER_ID, ACCOUNT));
    h.docker.volumes.set(anonymous, { 'com.docker.volume.anonymous': '' });
    h.docker.volumes.set('shop_db', { 'com.docker.compose.project': 'shop' });
    // Mounted by the container, but without the labels (`${devcontainerId}`, or made by hand).
    h.docker.volumes.set('api-history', {});
    h.docker.volumes.set('x-cache', additionalVolumeLabels('f0000001-0000-4000-8000-000000000001', OTHER_ACCOUNT));
    // Mounted by another container only: never the environment's.
    h.docker.volumes.set('x-only', {});
    for (const volumes of [[name, 'api-node_modules', anonymous, 'api-history'], [name, 'api-node_modules', 'shop_db', 'x-cache', 'api-history']]) {
      const container = h.docker.addContainer({ environmentId: OTHER_ID, name, state: 'stopped', image: environmentImageName(OTHER_ID, 1) });
      h.docker.containers.set(container.id, { ...container, volumes });
    }
    const other = h.docker.addContainer({ environmentId: 'f0000001-0000-4000-8000-000000000001', name: 'x', state: 'stopped', image: 'x' });
    h.docker.containers.set(other.id, { ...other, volumes: ['x-cache', 'x-only'] });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toEqual(['api-node_modules', 'api-history']);
  });

  it('restores an additional volume of another environment of the same owner that its container mounts, so that the Delete of that environment keeps it', async () => {
    // A (the fork) created web-node_modules; B (the upstream repository, same owner) mounts it too; C of another account
    // has a container that mounts it (for example from before the separation by account): C does not record it.
    const A = 'a0000001-0000-4000-8000-000000000001';
    const B = 'a0000002-0000-4000-8000-000000000002';
    const C = 'a0000003-0000-4000-8000-000000000003';
    const restored = (id: string, repository: string, owner: GitHubAccount): string => {
      const name = resourceName(repository, id);
      h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [LABEL_OWNER_ID]: owner.id });
      const container = h.docker.addContainer({ environmentId: id, name, state: 'stopped', image: environmentImageName(id, 1) });
      h.docker.containers.set(container.id, { ...container, volumes: [name, 'web-node_modules'] });
      return name;
    };
    restored(A, 'alice/web', ACCOUNT);
    restored(B, 'acme/web', ACCOUNT);
    restored(C, 'someone/web', OTHER_ACCOUNT);
    h.docker.volumes.set('web-node_modules', additionalVolumeLabels(A, ACCOUNT, 'alice/web'));
    expect(await h.service.reconcileFromVolumes()).toBe(3);
    expect((await h.registry.get(A))?.additionalVolumes).toEqual(['web-node_modules']);
    expect((await h.registry.get(B))?.additionalVolumes).toEqual(['web-node_modules']);
    expect((await h.registry.get(C))?.additionalVolumes).toBeUndefined();
    // The Delete of A keeps it while B records it, and the question does not offer it.
    expect(await h.service.removableAdditionalVolumes(A)).toEqual([]);
    await h.service.delete(A, options({ additionalVolumesToRemove: ['web-node_modules'] }));
    expect(h.docker.volumes.has('web-node_modules')).toBe(true);
    expect(h.logger.infos).toContain('The volume web-node_modules is kept, because another environment uses it too.');
  });

  it('records no anonymous volume of a restored entry', async () => {
    const name = resourceName(REPO, OTHER_ID);
    const anonymous = 'cd'.repeat(32);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    const container = h.docker.addContainer({ environmentId: OTHER_ID, name, state: 'stopped', image: environmentImageName(OTHER_ID, 1) });
    h.docker.containers.set(container.id, { ...container, volumes: [name, anonymous] });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toBeUndefined();
  });

  it('restores no volume that the policy gives to something else by its name', async () => {
    const name = resourceName(REPO, OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.volumes.set('api-node_modules', additionalVolumeLabels(OTHER_ID, ACCOUNT));
    const foreign = ['vscode', 'vsc-remote-containers', `api-${'0f'.repeat(16)}`, 'devenv-helper-cache', 'devenv-session-monitor', 'devenv-acme-web-12345678'];
    const container = h.docker.addContainer({ environmentId: OTHER_ID, name, state: 'stopped', image: environmentImageName(OTHER_ID, 1) });
    h.docker.containers.set(container.id, { ...container, volumes: [name, ...foreign, 'api-node_modules'] });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toEqual(['api-node_modules']);
  });

  it('restores one environment per repository and owner: two accounts, and no volume without an owner label (concept D-3)', async () => {
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
    expect(await h.service.reconcileFromVolumes()).toBe(2);
    const entries = await h.registry.list();
    expect(entries.map((e) => [e.id, e.owner.id])).toEqual([
      [ids[0], ACCOUNT.id],
      [ids[1], OTHER_ACCOUNT.id],
    ]);
    expect(h.logger.warnings.filter((warning) => warning.includes('another environment of the same owner'))).toEqual([
      `The volume ${resourceName(REPO, skippedIds[0])} belongs to a repository that has another environment of the same owner. It is not added.`,
    ]);
    // A volume without the owner label is skipped like one with invalid labels.
    expect(h.logger.warnings).toEqual(
      expect.arrayContaining([ids[2], skippedIds[1]].map((id) => `The volume ${resourceName(REPO, id)} has invalid labels and is skipped.`)),
    );
    // Each account finds its own environment of the repository.
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id))?.id).toBe(ids[0]);
    expect((await h.registry.findForAccount(REPO, OTHER_ACCOUNT.id))?.id).toBe(ids[1]);
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

  it('asks for a sign-in: without an account, no environment is available', async () => {
    await seedEnvironment(h);
    h.token = undefined;
    expect((await rejection(h.service.openEnvironment(ENV_ID, options()))).code).toBe('signInRequired');
    expect((await rejection(h.service.stop(ENV_ID))).code).toBe('signInRequired');
  });

  // 2026-10-01: the Switch branch command was dropped (user decision).
  it('refuses stop, delete, the safety check, and the configuration questions for another account', async () => {
    await seedEnvironment(h, { owner: OTHER_ACCOUNT, container: 'running' });
    const operations: Array<[string, () => Promise<unknown>]> = [
      ['stop', () => h.service.stop(ENV_ID)],
      ['delete', () => h.service.delete(ENV_ID, options({ additionalVolumesToRemove: [] }))],
      ['safetyCheck', () => h.service.safetyCheck(ENV_ID, options())],
      ['listConfigurations', () => h.service.listConfigurations(ENV_ID, options())],
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
    // unit 15: changed expectation, the token goes into the memory of the running container at each open.
    expect(h.helper.gitPreparations).toHaveLength(2);
    expect(h.docker.tokenWrites().map((write) => write.token)).toEqual([TOKEN, 'gho_new_session']);
    expect(h.helper.ups).toEqual([]);
  });

  it('unit 15: writes the token into the tmpfs of the container after `up`, as root, with the token on stdin only', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    let callsAtWrite: string[] = [];
    h.docker.execHandler = (_container, command) => {
      if (command[2] === TOKEN_WRITE_SCRIPT) callsAtWrite = [...h.helper.calls];
      return {};
    };
    await h.service.openEnvironment(ENV_ID, options());
    // After `up` started the container (the tmpfs exists only while it runs), and after the Git configuration.
    expect(callsAtWrite).toContain(`up ${IMAGE_1}`);
    expect(callsAtWrite).toContain('prepareGit');
    const [write] = h.docker.tokenWrites();
    expect(write).toEqual({ container: h.docker.containersOf(ENV_ID)[0].id, user: 'root', remoteUser: 'vscode', login: 'octo', token: TOKEN });
    const exec = h.docker.execs.find((e) => e.command[2] === TOKEN_WRITE_SCRIPT)!;
    expect(exec.command).toEqual(tokenWriteCommand('vscode', 'octo'));
    expect(exec.command.some((arg) => arg.includes(TOKEN))).toBe(false);
    // Never in the override configuration, the helper runs, or the log.
    expect(JSON.stringify(h.helper.ups)).not.toContain(TOKEN);
    expect([...h.logger.infos, ...h.logger.warnings, ...h.logger.errors].join('\n')).not.toContain(TOKEN);
  });

  it('unit 15: a failed write of the token is a warning; the environment opens, and the log has no token', async () => {
    await seedEnvironment(h, { container: 'running' });
    h.docker.execHandler = (_container, command) =>
      command[2] === TOKEN_WRITE_SCRIPT ? { exitCode: 5, stderr: `Root in the container may not give the files of /run/devenv to vscode. ${TOKEN}` } : {};
    const result = await h.service.openEnvironment(ENV_ID, options());
    expect(result.containerName).toBe(NAME);
    expect(h.ui.warnings).toEqual([Messages.gitSetupFailed]);
    const logged = [...h.logger.infos, ...h.logger.warnings, ...h.logger.errors].join('\n');
    expect(logged).toContain('The GitHub token could not be written into the container of acme/api: Root in the container may not give');
    expect(logged).not.toContain(TOKEN);
  });

  it('unit 15: passes no invalid GitHub login to the container (gh is signed in nowhere), and still writes the token', async () => {
    const h2 = recreate({ auth: { getToken: async () => TOKEN, getAccount: async () => ({ id: ACCOUNT.id, login: 'octo"' }) } });
    h = h2;
    await seedEnvironment(h, { container: 'running', owner: { id: ACCOUNT.id, login: 'octo"' } });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.tokenWrites()).toEqual([expect.objectContaining({ login: '', token: TOKEN })]);
    expect(h.logger.warnings.some((line) => line.includes('is no valid GitHub login'))).toBe(true);
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

  it('R12-4 warns and opens a running current container when the Git setup fails with helperFailed (no update, no up)', async () => {
    await seedEnvironment(h, { container: 'running' });
    const before = h.docker.containersOf(ENV_ID)[0].id;
    h.helper.prepareGitError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);
    const result = await h.service.openEnvironment(ENV_ID, options());
    expect(result.containerName).toBe(NAME);
    expect(h.helper.calls).toContain('prepareGit');
    expect(h.ui.warnings).toEqual([Messages.gitSetupFailed]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ id: before, state: 'running' })]);
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

  // Versions reset to 1 (user decision 2026-09-27): the older setups are labels other than 1 below it.
  it.each<[string, 'stopped' | 'running', Record<string, string>]>([
    ['a stopped container without the label', 'stopped', {}],
    ['a running container without the label', 'running', {}],
    ['a container of an older version', 'stopped', { 'nimblescape.devenv.container-version': '0' }],
    ['a running container with an invalid label', 'running', { 'nimblescape.devenv.container-version': 'x' }],
  ])('creates %s again from the environment image, without a build; the volume stays', async (_name, state, labels) => {
    await seedEnvironment(h, { container: state, containerLabels: labels });
    const before = h.docker.containersOf(ENV_ID)[0].id;
    const result = await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    const containers = h.docker.containersOf(ENV_ID);
    expect(containers).toHaveLength(1);
    expect(containers[0].id).not.toBe(before);
    expect(containers[0].labels['nimblescape.devenv.container-version']).toBe('1');
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
    // Review round 2 (D2-1): changed expectation, with the labels of Docker Compose set empty. Review round 4, D4-2:
    // changed expectation, with the label nimblescape.devenv.config-path. unit 15: changed expectation, the tmpfs of
    // the token at the end.
    expect((override.runArgs as string[]).slice(-14)).toEqual(['--label', 'nimblescape.devenv.container-version=1', ...CONFIG_PATH_LABEL, ...CLEARED_COMPOSE_LABELS, '--name', NAME, '--hostname', 'api', ...TOKEN_TMPFS_ARGS]);
  });

  it('starts a current container as it is', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    // review, PL-1/PL-2: ~/.gitconfig once, before the lifecycle commands (the script writes only a missing or empty
    // file), and no check of the Git version (only a new container gets it, as before).
    expect(h.docker.execs.filter((e) => e.command[2] === HOME_GIT_CONFIG_SCRIPT)).toHaveLength(1);
    expect(h.docker.execs.some((e) => e.command[0] === 'git' && e.command[1] === '--version')).toBe(false);
    expect(h.progress.details).not.toContain(Messages.containerRecreated);
  });

  it('does not take a single container with the label of the project from its image for a container of Compose (review round 2, D2-4)', async () => {
    // An image that Compose built for the project of the environment gave the container its labels (no number of a
    // container, which only Compose sets on the containers that it creates).
    await seedEnvironment(h, {
      container: 'stopped',
      containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'com.docker.compose.project': 'devenv-3f2a9c1e', 'com.docker.compose.service': 'app' },
    });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(h.logger.infos.some((line) => line.includes('was created for a Docker Compose configuration'))).toBe(false);
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

      // The old container is replaced (it is of an older setup), but the new one is provisional.
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
      const provisional = h.docker.containersOf(ENV_ID)[0];
      expect(provisional.id).not.toBe(original);
      expect(provisional.labels).toMatchObject({ 'nimblescape.devenv.container-version': '1', 'nimblescape.devenv.container-config': 'unknown' });
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
      expect(last.override.runArgs).not.toContain('nimblescape.devenv.container-config=unknown');
      expect(last.override.appPort).toEqual(['127.0.0.1:3000:3000']);
      const final = h.docker.containersOf(ENV_ID);
      expect(final).toHaveLength(1);
      expect(final[0].id).not.toBe(provisional.id);
      expect(final[0].labels['nimblescape.devenv.container-config']).toBeUndefined();
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
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;
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

describe('review round 1 of unit 6: single containers (S1, S3, S4, D2, D3)', () => {
  // Review round 2 (S2-01): the Dockerfile that a configuration names must be readable (else it is refused as not
  // supported); these configurations name `Dockerfile` next to the configuration.
  beforeEach(() => {
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': 'FROM alpine:3.22\n' };
  });

  it.each<[string, 'on' | 'off']>([
    ['on', 'on'],
    ['off', 'off'],
  ])('refuses the cache volume of the workspace helper as build context with the checks %s (S1)', async (_name, checks) => {
    if (checks === 'off') h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.config = { build: { dockerfile: 'Dockerfile', context: '/devenv-cache' } };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('build context /devenv-cache (a folder of the workspace helper)'));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses the folder with the token as build context, resolved against the folder of the configuration (S1)', async () => {
    h.helper.config = { build: { dockerfile: 'Dockerfile', context: '../../.devenv+' } };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('build context ../../.devenv+ (a folder of the workspace helper)'));
  });

  it('allows the parent folder of the configuration as build context (S1)', async () => {
    h.helper.config = { build: { dockerfile: 'Dockerfile', context: '..' } };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('refuses the image of an environment of another account, also with the registry of Docker Hub, and allows FROM it (S4)', async () => {
    // User decision 2026-09-28: changed setup and item (it was refused by the name devenv-…, as `image
    // docker.io/library/devenv-7c1d2e3f:2 of another environment`): the image of an environment of another account, by
    // its ID.
    const theirs = environmentImageName(OTHER_ID, 2);
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', owner: OTHER_ACCOUNT, container: null, volume: false, record: { environmentImage: theirs, buildNumber: 2 } });
    h.docker.images.add('docker.io/library/devenv-7c1d2e3f:2');
    h.docker.imageIds.set(theirs, `sha256:${'e'.repeat(64)}`);
    h.docker.imageIds.set('docker.io/library/devenv-7c1d2e3f:2', `sha256:${'e'.repeat(64)}`);
    h.docker.imageRepoNames.set('docker.io/library/devenv-7c1d2e3f:2', { repoTags: [theirs], repoDigests: [] });
    h.helper.config = { image: 'docker.io/library/devenv-7c1d2e3f:2' };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(
      Messages.hostAccess('image docker.io/library/devenv-7c1d2e3f:2 (an image of an environment of another GitHub account)'),
    );
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    h.helper.files[DEFAULT_CONFIG_PATH] = {
      configText: '{ "build": { "dockerfile": "Dockerfile" } }',
      dockerfilePath: '.devcontainer/Dockerfile',
      dockerfileText: 'FROM devenv-7c1d2e3f:2\n',
    };
    // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM image devenv-7c1d2e3f:2 of another environment`.
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('reads the Dockerfile that the resolved configuration names with the helper image of the open (review round 3 of PR #64, P7)', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "build": { "dockerfile": "${localEnv:DOCKERFILE:Dockerfile}" } }' };
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': 'FROM devenv-7c1d2e3f:2\n' };
    await h.service.open(TARGET, options());
    expect(h.helper.dockerfileReads).toEqual(['Dockerfile']);
    // user decision 2026-09-29: no previous helper image. Changed expectation: the helper image of the open is the
    // current tag with its image ID (before, a previous helper).
    const previous = { tag: 'devenv-helper:test', id: h.helper.currentHelperImageId };
    const reads = h.helper.helperImages.filter((entry) => entry.call === 'readConfigFiles');
    // The read of the configuration and the read of the Dockerfile.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.filter((entry) => JSON.stringify(entry.image) !== JSON.stringify(previous))).toEqual([]);
  });

  it('reads the Dockerfile at the path that the resolved configuration names for the update check (review round 2, S2-01)', async () => {
    // The text names the Dockerfile with a variable of the computer; the CLI resolves it (here to its default).
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "build": { "dockerfile": "${localEnv:DOCKERFILE:Dockerfile}" } }' };
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': 'FROM devenv-7c1d2e3f:2\n' };
    // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM image devenv-7c1d2e3f:2 of another environment`.
    await h.service.open(TARGET, options());
    expect(h.helper.dockerfileReads).toEqual(['Dockerfile']);
    expect(h.helper.builds).toHaveLength(1);
    // Its FROM images are the references of the image check.
    expect(h.checker.calls.at(-1)?.images).toEqual(['devenv-7c1d2e3f:2']);
  });

  it('refuses a configured Dockerfile that cannot be read as protected, whatever the switch says (review round 2, S2-01; U2)', async () => {
    h.helper.config = { build: { dockerfile: 'missing.Dockerfile' } };
    // Review round 3, P3-1: changed setup, a Dockerfile that exists but cannot be read (for example a link out of the
    // repository); a missing one is an error of the configuration (the tests of review round 3).
    h.helper.unreadableDockerfiles = ['.devcontainer/missing.Dockerfile'];
    // review, U1/U2: refused again (protected), not for its images: the CLI and BuildKit in the workspace helper would
    // read the file that the link points to (for example the token) as the Dockerfile.
    const item = 'Dockerfile missing.Dockerfile (the Dockerfile is a link out of the repository or could not be read)';
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess(item));
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess(item));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a Dockerfile longer than MAX_DOCKERFILE_LENGTH as not supported, and allows a normal one (U1)', async () => {
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    // What READ_FILES_SCRIPT returns of a longer Dockerfile: MAX_DOCKERFILE_LENGTH + 1 characters.
    const long = `FROM alpine\n#${'x'.repeat(MAX_DOCKERFILE_LENGTH - 12)}`;
    expect(long.length).toBe(MAX_DOCKERFILE_LENGTH + 1);
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': long };
    const item = `the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the Dockerfile is too large)`;
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.unsupportedOptions(item));
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.unsupportedOptions(item));
    expect(h.helper.builds).toEqual([]);
    // Exactly MAX_DOCKERFILE_LENGTH characters, and a normal Dockerfile: built.
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': long.slice(0, -1) };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('allows a normal Dockerfile (U1, U2)', async () => {
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': 'FROM alpine:3.22\nRUN echo hi\n' };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('refuses an image that Docker would find by the prefix of its ID, and allows an image named with hexadecimal characters (review round 2, S2-05)', async () => {
    // `a1b2c3d4` is no name of a local image: Docker takes it for the prefix of the ID of devenv-7c1d2e3f:2.
    h.docker.images.add('a1b2c3d4');
    h.docker.imageRepoNames.set('a1b2c3d4', { repoTags: ['devenv-7c1d2e3f:2'], repoDigests: [] });
    h.helper.config = { image: 'a1b2c3d4' };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.unsupportedOptions('image a1b2c3d4 (an image ID; name the image)'));
    // Not in the Dockerfile. Dockerfile refusals removed (user decision 2026-09-27): before, `COPY --from image a1b2c3d4
    // (an image ID; name the image)`.
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': 'FROM alpine\nCOPY --from=a1b2c3d4 /a /a\n' };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    // An image whose name is `a1b2c3d4`: Docker names it by that name.
    h.docker.imageRepoNames.set('a1b2c3d4', { repoTags: ['a1b2c3d4:latest'], repoDigests: [] });
    h.helper.config = { image: 'a1b2c3d4' };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('refuses the Compose network of another environment in runArgs, by its name and by its labels (S3)', async () => {
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--network', 'devenv-7c1d2e3f_default'] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess('network devenv-7c1d2e3f_default of another environment'));
    h.docker.networks.set('backend', { 'com.docker.compose.project': 'devenv-7c1d2e3f' });
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--network=backend'] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess('network backend of another environment'));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a network of another environment that runArgs name by its ID or a prefix of it (review round 2, S2-04)', async () => {
    h.docker.networks.set('devenv-7c1d2e3f_default', {});
    h.docker.networkIds.set('devenv-7c1d2e3f_default', `f00dbabe${'0'.repeat(56)}`);
    h.docker.networks.set('mine', {});
    h.docker.networkIds.set('mine', `f00dcafe${'1'.repeat(56)}`);
    for (const reference of ['f00dbabe', `f00dbabe${'0'.repeat(56)}`]) {
      h.helper.config = { image: BASE_IMAGE, runArgs: ['--network', reference] };
      expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess(`network ${reference} of another environment`));
    }
    // By its containers: a network of the computer with a container of an environment of another account.
    const other = h.docker.addContainer({ environmentId: OTHER_ID, name: 'devenv-acme-other-7c1d2e3f', state: 'running', image: 'x' });
    h.docker.networkContainers.set('mine', [other.id]);
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--network=f00dcafe'] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess('network f00dcafe of another environment'));
    expect(h.helper.builds).toEqual([]);
    // A prefix that two networks share names none (Docker refuses it too).
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--network=f00d'] };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('allows a network of the user with a container of another environment of the same owner (review round 2, P2-2)', async () => {
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: 'running' });
    h.docker.networks.set('devnet', {});
    h.docker.networkContainers.set('devnet', [h.docker.containersOf(OTHER_ID)[0].id]);
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--network', 'devnet'] };
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it.each<[string, SeedOptions | undefined]>([
    ['another owner', { id: OTHER_ID, repository: 'acme/web', container: 'running', owner: OTHER_ACCOUNT }],
    ['no entry', undefined],
  ])('refuses a network of the user with a container of an environment of %s (review round 2, P2-2)', async (_name, seed) => {
    if (seed) await seedEnvironment(h, seed);
    else h.docker.addContainer({ environmentId: OTHER_ID, name: 'devenv-acme-web-7c1d2e3f', state: 'running', image: 'x' });
    h.docker.networks.set('devnet', {});
    h.docker.networkContainers.set('devnet', [h.docker.containersOf(OTHER_ID)[0].id]);
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--network', 'devnet'] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess('network devnet of another environment'));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses the Compose network of another environment of the same owner by its name and labels (review round 2, P2-2)', async () => {
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: 'running' });
    h.docker.networks.set('backend', { 'com.docker.compose.project': 'devenv-7c1d2e3f' });
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--network', 'backend'] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess('network backend of another environment'));
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--network', 'devenv-7c1d2e3f_default'] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.hostAccess('network devenv-7c1d2e3f_default of another environment'));
  });

  it('refuses a label of Docker Compose in runArgs (D3)', async () => {
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--label', `com.docker.compose.project=devenv-7c1d2e3f`] };
    expect((await rejection(h.service.open(TARGET, options()))).message).toBe(Messages.unsupportedOptions('label com.docker.compose.project'));
  });

  it('refuses an environment image with a label of the extension before the container is created (D2)', async () => {
    await seedEnvironment(h, { container: null });
    h.docker.imageConfigs.set(IMAGE_1, { User: '', Labels: { 'nimblescape.devenv.compose-service': 'x', 'devcontainer.metadata': '[]' } });
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.message).toBe(Messages.hostAccess(`label nimblescape.devenv.compose-service of the image ${IMAGE_1}`));
    expect(h.helper.ups).toEqual([]);
  });

  it('uses an update whose new image carries labels of another tool with the prefix devenv. (user report 2026-09-27)', async () => {
    // The images of the user are built by another tool that also uses the prefix devenv.: before, the update was
    // refused ("label devenv.fingerprint of the image devenv-af605cdd:2, label devenv.inputs of the image
    // devenv-af605cdd:2").
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
    h.helper.buildLabels = { 'devenv.fingerprint': 'f', 'devenv.inputs': 'i' };
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds.map((b) => b.imageName)).toEqual([IMAGE_2]);
    expect(h.helper.ups.map((u) => u.image)).toEqual([IMAGE_2]);
    expect(h.ui.warnings).toEqual([]);
    expect((await entry())?.refusedUpdate).toBeUndefined();
    expect((await entry())?.buildRecord?.environmentImage).toBe(IMAGE_2);
  });

  it('refuses an update whose new image carries a label of the extension, and starts the old container', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
    h.helper.buildLabels = { 'devenv.fingerprint': 'f', 'nimblescape.devenv.environment-id': 'x' };
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((u) => u.image)).toEqual([IMAGE_1]);
    expect(h.ui.warnings).toEqual([Messages.updateRefused(`label nimblescape.devenv.environment-id of the image ${IMAGE_2}`)]);
  });

  it('opens an environment image with the labels of another Compose project, and sets them empty on the container (review round 2, D2-1)', async () => {
    await seedEnvironment(h, { container: null });
    // An image that Docker Compose built for the project `app` of the user, inherited through FROM.
    h.docker.imageConfigs.set(IMAGE_1, {
      User: '',
      Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web', 'devcontainer.metadata': '[]' },
    });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups).toHaveLength(1);
    const runArgs = h.helper.ups[0].override.runArgs as string[];
    expect(runArgs).toEqual(expect.arrayContaining([...CLEARED_COMPOSE_LABELS]));
    // Docker gives the container the labels of runArgs after those of the image: `docker compose -p app down` does not
    // find it.
    const [container] = h.docker.containersOf(ENV_ID);
    expect(container.labels['com.docker.compose.project']).toBe('');
    expect(container.labels['com.docker.compose.service']).toBe('');
  });

  it('finds a container whose image gave it the label of a Compose service, and creates it again once the checks are on (D2)', async () => {
    await seedEnvironment(h, {
      container: 'running',
      containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED, 'nimblescape.devenv.compose-service': 'x' },
    });
    const old = h.docker.containersOf(ENV_ID)[0].id;
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    expect(h.docker.containerByRef(old)?.labels[LABEL_HOST_ACCESS]).toBeUndefined();
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
    // Review round 2 (D2-1): changed check, as the override configuration (its labels of Docker Compose set empty).
    expect(hostAccessProblems({ config: { runArgs: given }, ownVolume: NAME, overrideConfiguration: true })).toEqual([]);
    // unit 15: changed expectation, the tmpfs of the token at the end.
    expect(given.slice(-6)).toEqual(['--name', NAME, '--hostname', 'api', ...TOKEN_TMPFS_ARGS]);
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
    // Review round 2 (D2-1): changed expectation, with the labels of Docker Compose set empty. Review round 4, D4-2:
    // changed expectation, with the label nimblescape.devenv.config-path. unit 15: changed expectation, the tmpfs of
    // the token at the end.
    expect(h.helper.ups[0].override.runArgs).toEqual([...passed, '--label', 'nimblescape.devenv.container-version=1', ...CONFIG_PATH_LABEL, ...CLEARED_COMPOSE_LABELS, '--name', NAME, '--hostname', 'api', ...TOKEN_TMPFS_ARGS]);
  });

  it('removes --rm, -i, -t, -d, and --name before up, and names them in the log', async () => {
    await seedEnvironment(h, { container: null });
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--rm', '-it', '--cap-drop', 'ALL', '-d', '--name', 'mine', '--label', '--rm'] };
    await h.service.openEnvironment(ENV_ID, options());
    // Review round 2 (D2-1): changed expectation, with the labels of Docker Compose set empty. Review round 4, D4-2:
    // changed expectation, with the label nimblescape.devenv.config-path. unit 15: changed expectation, the tmpfs of
    // the token at the end.
    expect(h.helper.ups[0].override.runArgs).toEqual(['--cap-drop', 'ALL', '--label', '--rm', '--label', 'nimblescape.devenv.container-version=1', ...CONFIG_PATH_LABEL, ...CLEARED_COMPOSE_LABELS, '--name', NAME, '--hostname', 'api', ...TOKEN_TMPFS_ARGS]);
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

      // The same update: no pull, no build; the old container starts. User report 2026-09-27: changed expectation, the
      // user saw the warning at the refusal, and the later opens only log it (before: the warning at every open).
      h.ui.warnings.length = 0;
      h.logger.infos.length = 0;
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
      expect(h.ui.warnings).toEqual([]);
      expect(h.logger.infos).toContain(`The update of ${REPO} was refused by the host access policy (bind mount /var/run/docker.sock). The existing environment is used.`);
      expect(h.progress.steps).not.toContain('preparing');

      // A newer Feature: the update is tried again (and refused again), a new refusal with its warning.
      h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: NEWER_FEATURE });
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.builds).toHaveLength(2);
      expect(h.ui.warnings).toEqual([REFUSED]);
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

    it('keeps a bounded text of what it needed, also for many long items (hotfix review 3, C3-2)', async () => {
      // 40 long bind mounts (access to the computer) and 40 long mounts with a leftover variable (unsupported): 21 items
      // of each list, each at most 200 characters, are still more than MAX_REFUSED_ITEMS_LENGTH together.
      const binds = Array.from({ length: 40 }, (_, i) => ({ source: `/${i}${'a'.repeat(5000)}`, target: `/t${i}`, type: 'bind' }));
      const leftovers = Array.from({ length: 40 }, (_, i) => `type=volume,src=\${localEnv:TERM:v${i}${'b'.repeat(5000)}},dst=/v${i}`);
      h.helper.buildMetadata = [{ id: 'many-mounts', mounts: [...binds, ...leftovers] }];
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
      await h.service.openEnvironment(ENV_ID, options());
      const items = ((await refusedUpdate()) as { items: string }).items;
      expect(items.length).toBe(MAX_REFUSED_ITEMS_LENGTH + 1);
      expect(items.startsWith(`bind mount /0${'a'.repeat(80)}`)).toBe(true);
      // The start and the end stay: the first item that needs the computer, and the count of the unknown items.
      expect(items.endsWith(', and 20 more')).toBe(true);
      expect(items).toContain('…');
      expect(h.ui.warnings).toEqual([Messages.updateRefused(items)]);
    });

    it('bounds a stored refusal with long items when it is read and logged (hotfix review 4, Q3)', async () => {
      await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
      await h.service.openEnvironment(ENV_ID, options());
      // 100 KB of items, as a registry changed by hand could hold them.
      const long = `bind mount /${'a'.repeat(100 * 1024)}, and 20 more`;
      await h.registry.updateEnvironment(ENV_ID, (e) => {
        if (e.refusedUpdate) e.refusedUpdate.items = long;
      });
      h.docker.containersOf(ENV_ID)[0].state = 'stopped';
      h.ui.warnings.length = 0;
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.builds).toHaveLength(1);
      // User report 2026-09-27: changed expectation, the same refused update is logged, not shown again (the warning at
      // the refusal bounds its items with truncated, rememberRefusedUpdate).
      expect(h.ui.warnings).toEqual([]);
      const logged = h.logger.infos.filter((line) => line.includes('was refused by the host access policy'));
      expect(logged).toHaveLength(1);
      expect(logged[0].length).toBeLessThan(MAX_REFUSED_ITEMS_LENGTH + 500);
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
      runArgs: ['--label', 'nimblescape.devenv.environment-id=someone-else', '-e', 'GIT_CONFIG_GLOBAL=/tmp/gitconfig'],
      remoteEnv: { GIT_CONFIG_PARAMETERS: "'credential.helper=store'" },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(
      Messages.hostAccessAndUnsupported('variable GIT_CONFIG_GLOBAL in runArgs, variable GIT_CONFIG_PARAMETERS in remoteEnv', 'label nimblescape.devenv.environment-id'),
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

    /** An environment of another repository that uses the volume SHARED. */
    async function otherEnvironment(owner: GitHubAccount): Promise<void> {
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

    // hotfix review 2, P5 (a known limit): an existing volume without labels (created by hand, or
    // by Docker at `up`) is shared by every environment that mounts it; the pipeline names it in the log.
    it('logs an existing volume without labels that the container mounts', async () => {
      await seedEnvironment(h, { container: null });
      h.helper.config = { image: BASE_IMAGE, mounts: ['source=api-node_modules,target=/n,type=volume', 'source=api-labelled,target=/l,type=volume'] };
      h.docker.volumes.set('api-node_modules', {});
      h.docker.volumes.set('api-labelled', { 'com.example': 'x' });
      await h.service.openEnvironment(ENV_ID, options());
      expect(h.helper.ups).toHaveLength(1);
      expect(h.logger.infos.filter((line) => line.includes('without labels'))).toEqual([
        expect.stringContaining('The volume api-node_modules exists without labels'),
      ]);
      expect((await h.registry.get(ENV_ID))?.additionalVolumes).toBeUndefined();
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
      // An entry without it (for example changed by hand) gets it at the next open of the container.
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

    it.each<[string, GitHubAccount]>([['an environment of the same account', ACCOUNT]])('are allowed when %s uses them', async (_name, owner) => {
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

describe('review round 3 of unit 6: single containers (P3-1, P3-2, S3-2)', () => {
  const MISSING_TEXT = '{ "build": { "dockerfile": "Dockerfile" } }';

  function missingDockerfile(): void {
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: MISSING_TEXT, dockerfilePath: '.devcontainer/Dockerfile', dockerfileMissing: true };
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    h.helper.dockerfiles = {};
  }

  it.each(['running', 'stopped'] as const)('starts an existing %s container whose Dockerfile is missing in the repository (P3-1)', async (state) => {
    await seedEnvironment(h, { container: state, record: { configHash: configHash(MISSING_TEXT) } });
    missingDockerfile();
    const result = await h.service.open(TARGET, options());
    expect(result.containerName).toBe(NAME);
    expect(h.ui.warnings).toContain(Messages.buildFileMissing('the Dockerfile Dockerfile'));
    expect(h.helper.builds).toEqual([]);
  });

  it('ends the first open with a plain error of the configuration, not a refusal, and builds nothing (P3-1)', async () => {
    missingDockerfile();
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(error.message).toBe(Messages.buildFileMissing('the Dockerfile Dockerfile'));
    expect(h.helper.builds).toEqual([]);
  });

  it('also for a Dockerfile that the resolved configuration names (P3-1)', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "build": { "dockerfile": "${localEnv:DF:Dockerfile}" } }' };
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    h.helper.dockerfiles = {};
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(h.helper.dockerfileReads).toEqual(['Dockerfile']);
  });

  it('refuses a Dockerfile outside of the repository or one that cannot be read, also for an existing container (P3-1, U2)', async () => {
    await seedEnvironment(h, { container: 'stopped', record: { configHash: configHash(MISSING_TEXT) } });
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: MISSING_TEXT };
    for (const [dockerfile, unreadable] of [
      ['/opt/Dockerfile', []],
      ['Dockerfile', ['.devcontainer/Dockerfile']],
    ] as const) {
      h.helper.config = { build: { dockerfile } };
      h.helper.dockerfiles = {};
      h.helper.unreadableDockerfiles = [...unreadable];
      // review, U1/U2: refused again (protected), as before the Dockerfile refusals were removed (then as not supported,
      // for its images): the CLI would read the file that it points to as the Dockerfile.
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('hostAccess');
      expect(error.message).toBe(Messages.hostAccess(`Dockerfile ${dockerfile} (the Dockerfile is a link out of the repository or could not be read)`));
    }
    expect(h.helper.ups).toEqual([]);
    expect(h.helper.builds).toEqual([]);
  });

  it('detects a change of the Dockerfile that the configuration names with a variable (P3-2)', async () => {
    const text = '{ "build": { "dockerfile": "${localEnv:DF:Dockerfile}" } }';
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: text };
    h.helper.config = { build: { dockerfile: 'Dockerfile' } };
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': 'FROM alpine:3.22\n' };
    await h.service.open(TARGET, options());
    const [env] = await h.registry.list();
    expect(env.buildRecord?.configHash).toBe(configHash(text, 'FROM alpine:3.22\n'));
    // 2026-10-01: the Switch branch command was dropped (user decision). Its configurationChanged query is gone; the open
    // finds the change.
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': 'FROM alpine:3.23\n' };
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(env.id, options());
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
  });

  it('allows the images of a Dockerfile with the build arguments and target of build.options (S3-2)', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "build": { "dockerfile": "Dockerfile" } }', dockerfilePath: '.devcontainer/Dockerfile' };
    h.helper.dockerfiles = { '.devcontainer/Dockerfile': 'ARG BASE=alpine:3.22\nFROM ${BASE} AS a\nFROM devenv-7c1d2e3f:2 AS b\n' };
    h.helper.config = { build: { dockerfile: 'Dockerfile', args: { BASE: 'alpine:3.22' }, options: ['--build-arg', 'BASE=devenv-7c1d2e3f:1'] } };
    // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM image devenv-7c1d2e3f:1 of another environment,
    // FROM image devenv-7c1d2e3f:2 of another environment`.
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });
});

describe('review round 9 (P9-1, P9-2): a failed analysis of the host access policy', () => {
  /** An analyzer that fails the jobs that `fails` picks, with `failure`, and runs the others in this thread. */
  function failingAnalyzer(fails: (job: AnalysisJob) => boolean, failure: AnalysisFailure): { analyzer: ConfigurationAnalyzer; enabled: { on: boolean } } {
    const enabled = { on: true };
    return {
      enabled,
      analyzer: {
        analyze: <J extends AnalysisJob>(job: J) => (enabled.on && fails(job) ? Promise.resolve(analysisFailure(job, failure)) : inProcessAnalyzer.analyze(job)),
      },
    };
  }
  const isMetadataJob = (job: AnalysisJob): boolean => job.kind === 'hostAccess' && job.input.metadata !== undefined;

  it('does not remember an update whose new image could not be checked, and tries it again at the next open (P9-1)', async () => {
    h.cleanup();
    const failing = failingAnalyzer(isMetadataJob, { kind: 'limit', reason: 'it took longer than 10000 ms' });
    h = createHarness({ analyzer: failing.analyzer });
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    // Before: remembered as a refused update (Messages.updateRefused), so the next opens did not build it again.
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toBeUndefined();
    expect(h.ui.warnings).toEqual([Messages.updateCheckFailed(ANALYSIS_FAILED_ITEM)]);
    expect(Messages.updateCheckFailed('x')).toBe('The configuration could not be checked. Try again. (x.) The environment is started without the update.');
    // The old container started.
    expect(h.helper.builds).toHaveLength(1);
    expect(h.docker.containersOf(ENV_ID)[0].image).toBe(IMAGE_1);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    // The next open (the worker works again) builds the update again, and uses it.
    failing.enabled.on = false;
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    h.ui.warnings.length = 0;
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(h.helper.builds).toHaveLength(2);
    expect(h.ui.warnings).toEqual([]);
  });

  it('remembers an update whose new image is beyond a size limit of the check, and does not build it at every open (review round 10, P10-3)', async () => {
    h.cleanup();
    // A deterministic size limit (for example an oversized devcontainer.metadata label of the new image).
    const failing = failingAnalyzer(isMetadataJob, { kind: 'size', reason: 'the configuration is larger than 32 million characters' });
    h = createHarness({ analyzer: failing.analyzer });
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    // Before: not remembered ("Try again"), so every open built the same update again and failed the same way.
    const refused = (await h.registry.get(ENV_ID))?.refusedUpdate;
    expect(refused).toMatchObject({ items: ANALYSIS_FAILED_ITEM, reason: 'size' });
    expect(h.ui.warnings).toEqual([Messages.updateTooLarge(ANALYSIS_FAILED_ITEM)]);
    expect(Messages.updateTooLarge('x')).toBe('The newer image of the environment is too large or too complex to check (x). The environment is started without the update.');
    expect(h.helper.builds).toHaveLength(1);
    expect(h.docker.containersOf(ENV_ID)[0].image).toBe(IMAGE_1);
    // The next open does not build the same update again, and logs why. User report 2026-09-27: changed expectation,
    // the warning is not shown again (before: at every open).
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    h.ui.warnings.length = 0;
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(h.helper.builds).toHaveLength(1);
    expect(h.ui.warnings).toEqual([]);
    expect(h.logger.infos.some((line) => line.includes(`is too large or too complex to check (${ANALYSIS_FAILED_ITEM})`))).toBe(true);
    // A rebuild tries again.
    failing.enabled.on = false;
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    await h.service.openEnvironment(ENV_ID, { progress: h.progress, forceRebuild: true });
    expect(h.helper.builds).toHaveLength(2);
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toBeUndefined();
  });

  it('starts an existing environment when the analysis cannot run, with an internal-error text, and builds nothing (P9-2)', async () => {
    h.cleanup();
    const failing = failingAnalyzer(() => true, { kind: 'internal', reason: 'the worker did not start: Cannot find module' });
    h = createHarness({ analyzer: failing.analyzer });
    await seedEnvironment(h, { container: 'stopped' });
    // A changed configuration: it is not applied (fail closed), the existing container starts as it is.
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: DEFAULT_CONFIG_TEXT.replace('{', '{ "name": "changed",') };
    // Before: refused with "too large or too complex … Change the configuration of the repository"; nothing started.
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    const text = Messages.configurationCheckInternal(analysisInternalItem('the worker did not start: Cannot find module'));
    expect(text).toBe('The configuration check failed to start (internal error): the worker did not start: Cannot find module. Try again; if it fails again, reinstall Dev Environments.');
    expect(h.ui.warnings).toEqual([text]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toHaveLength(1);
    expect(h.helper.ups[0].removeExistingContainer).toBe(false);
  });

  it('keeps refusing when the analysis cannot run and a container would be created (P9-2)', async () => {
    h.cleanup();
    const failing = failingAnalyzer(() => true, { kind: 'internal', reason: 'the worker ended with exit code 1' });
    h = createHarness({ analyzer: failing.analyzer });
    // A first open: nothing to start.
    const first = await h.service.open(TARGET, { progress: h.progress }).then(
      () => undefined,
      (error: unknown) => error as UserFacingError,
    );
    expect(first?.code).toBe('hostAccess');
    expect(first?.message).toBe(Messages.configurationCheckInternal(analysisInternalItem('the worker ended with exit code 1')));
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    h.cleanup();
    // The image exists, the container not: `up` would create one.
    h = createHarness({ analyzer: failingAnalyzer(() => true, { kind: 'internal', reason: 'crash' }).analyzer });
    await seedEnvironment(h, { container: null });
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'hostAccess' });
    expect(h.helper.ups).toEqual([]);
  });

  it('keeps refusing an existing environment whose configuration is beyond a limit of the analysis', async () => {
    h.cleanup();
    h = createHarness({ analyzer: failingAnalyzer(() => true, { kind: 'limit', reason: 'it used too much memory' }).analyzer });
    await seedEnvironment(h, { container: 'stopped' });
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress })).rejects.toMatchObject({
      code: 'hostAccess',
      message: Messages.configurationTooComplex(ANALYSIS_FAILED_ITEM),
    });
    expect(h.helper.ups).toEqual([]);
  });
});

describe('review round 9 (S9-1, S9-3): the bounds of the extension host', () => {
  it('refuses a devcontainer.json longer than MAX_CONFIG_TEXT_LENGTH before it parses it (S9-1)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: `{ "image": "${BASE_IMAGE}", "x": "${'a'.repeat(MAX_CONFIG_TEXT_LENGTH)}" }` };
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress })).rejects.toMatchObject({
      code: 'hostAccess',
      message: Messages.configurationTooComplex(ANALYSIS_FAILED_ITEM),
    });
    expect(h.helper.ups).toEqual([]);
  });

  it('opens a configuration with 30000 variables of the computer in less than 1 s, and names 20 of them (S9-1, P9-3)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    const containerEnv = Array.from({ length: 30_000 }, (_, i) => `"A${i}": "\${localEnv:V${i}}"`).join(', ');
    const configText = `{ "image": "${BASE_IMAGE}", "containerEnv": { ${containerEnv} } }`;
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText };
    const start = performance.now();
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    // Before: seconds in the extension host (names.includes for each name).
    expect(performance.now() - start).toBeLessThan(1000);
    const names = Array.from({ length: 20 }, (_, i) => `V${i}`).join(', ');
    expect(h.ui.warnings).toContain(Messages.localEnvNotPassed(`${names}, and 29980 more`));
  });

  it('asks Docker about the image IDs of all references with one call, and not at all when the configuration is refused (S9-3)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    // Dockerfile refusals removed (user decision 2026-09-27): changed setup, the FROM image of a Dockerfile is no image
    // reference for this question any more; the `image` and a `--build-context` image of the configuration are.
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: `{ "image": "${BASE_IMAGE}" }` };
    h.helper.config = { image: BASE_IMAGE, build: { options: ['--build-context', 'tools=docker-image://alpine:3.22'] } };
    await h.service.openEnvironment(ENV_ID, { progress: h.progress });
    expect(h.docker.imageInspections).toHaveLength(1);
    h.docker.imageInspections.length = 0;
    h.helper.config = { image: BASE_IMAGE, privileged: true };
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: `{ "image": "${BASE_IMAGE}", "privileged": true }` };
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    await expect(h.service.openEnvironment(ENV_ID, { progress: h.progress })).rejects.toMatchObject({ code: 'hostAccess' });
    // Before: one `docker image inspect` per reference, also for a refused configuration.
    expect(h.docker.imageInspections).toEqual([]);
  });
});

describe('review round 12 (D12-2): the ownership fix of a single container leaves its other mounts below the repository alone', () => {
  it('protects the target of a volume of the mounts of devcontainer.json, not the workspace volume', async () => {
    // For example "mounts": ["source=pgdata,target=${containerWorkspaceFolder}/.pgdata,type=volume"], a volume that
    // another container uses too.
    h.helper.containerMounts = [
      { type: 'volume', volume: NAME, target: '/workspaces' },
      { type: 'volume', volume: 'pgdata', target: '/workspaces/api/.pgdata' },
      { type: 'volume', target: '/workspaces/api/../elsewhere' },
      { type: 'bind', target: '/workspaces/api' },
    ];
    await h.service.open(TARGET, options());
    const fix = h.docker.execs.filter((e) => e.command[2] === OWNERSHIP_FIX_SCRIPT && e.command[4] === '/workspaces/api');
    // Before: ['/workspaces/api', 'vscode'] alone: the files of the volume were given to vscode.
    // review round 16, L2: the target of the mount is marked with `(` and `)` (DevMountPaths).
    expect(fix.map((e) => e.command.slice(4))).toEqual([
      ['/workspaces/api', 'vscode', '(', '-path', '/workspaces/api/.pgdata', '-o', '-path', '/workspaces/api/.pgdata/*', ')'],
    ]);
    expect((await entry())?.serviceFolders).toBeUndefined();
  });
});

describe('review round 19 (S19-4, P19-2): the checks of a single container before the read of the merged configuration', () => {
  const BASE = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS x\n';

  function useDockerfile(text: string, build: Record<string, unknown> = {}): void {
    h.helper.config = { build: { dockerfile: 'Dockerfile', ...build } };
    h.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "build": { "dockerfile": "Dockerfile" } }', dockerfilePath: '.devcontainer/Dockerfile', dockerfileText: text };
  }

  it('S19-4: an image of another environment in the Dockerfile is allowed, and the merged configuration is read after the checks', async () => {
    useDockerfile(`${BASE}FROM devenv-0badc0de:3 AS y\n`);
    h.helper.merged = { privileged: false };
    // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM image devenv-0badc0de:3 of another environment`,
    // and no read of the merged configuration.
    await h.service.open(TARGET, options());
    expect(h.helper.readConfigurations.slice(0, 2)).toEqual([{ configPath: DEFAULT_CONFIG_PATH, merged: false }, { configPath: DEFAULT_CONFIG_PATH }]);
    expect(h.helper.builds).toHaveLength(1);
  });

  it('S19-4: a refused configuration leads to no read of the merged configuration, and the merged one is still checked', async () => {
    h.helper.config = { image: BASE_IMAGE, privileged: true };
    h.helper.merged = {};
    let error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(h.helper.readConfigurations).toEqual([{ configPath: DEFAULT_CONFIG_PATH, merged: false }]);
    // Only the merged configuration asks for privileged mode (the metadata of the image).
    h.helper.readConfigurations.length = 0;
    h.helper.config = { image: BASE_IMAGE };
    h.helper.merged = { privileged: true };
    error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(h.helper.readConfigurations).toEqual([{ configPath: DEFAULT_CONFIG_PATH, merged: false }, { configPath: DEFAULT_CONFIG_PATH }]);
    expect(h.helper.builds).toEqual([]);
  });

  it('P19-2: builds a single container whose base image comes only from `--build-arg` of build.options', async () => {
    useDockerfile('ARG BASE\nFROM ${BASE}\n', { options: ['--build-arg', `BASE=${BASE_IMAGE}`] });
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });
});

describe('lifecycle token (user decision 2026-09-27): up --skip-post-create, the token, then run-user-commands', () => {
  const POST_CREATE_FAILED = 'postCreateCommand from devcontainer.json failed.';

  describe('review PL-2: ~/.gitconfig before run-user-commands (Git older than 2.31 reads the credential helper only there)', () => {
    const isHome = (exec: { command: readonly string[] }) => exec.command[2] === HOME_GIT_CONFIG_SCRIPT;
    const isVersion = (exec: { command: readonly string[] }) => exec.command[0] === 'git' && exec.command[1] === '--version';

    /** Indexes in FakeDocker.execs: the token writes, the ~/.gitconfig runs, the Git version checks, and each run-user-commands. */
    function timeline() {
      const indexes = (match: (exec: (typeof h.docker.execs)[number]) => boolean) =>
        h.docker.execs.flatMap((exec, index) => (match(exec) ? [index] : []));
      return {
        token: indexes((exec) => exec.command[2] === TOKEN_WRITE_SCRIPT),
        home: indexes(isHome),
        version: indexes(isVersion),
        userCommands: h.helper.userCommandContext.map((run) => run.execsBefore),
      };
    }

    it('first open: prepareGit, up, the token, ~/.gitconfig, then run-user-commands; finish does not run the script again', async () => {
      const result = await h.service.open(TARGET, options());
      const container = h.docker.containersOf(result.environment.id)[0];
      const calls = h.helper.calls;
      expect(calls.indexOf('prepareGit')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('prepareGit')).toBeLessThan(calls.findIndex((call) => call.startsWith('up')));
      const t = timeline();
      expect(t.token).toHaveLength(1);
      expect(t.home).toHaveLength(1);
      expect(t.userCommands).toHaveLength(1);
      expect(t.token[0]).toBeLessThan(t.home[0]);
      expect(t.home[0]).toBeLessThan(t.userCommands[0]);
      // As root, for the remote user of the token write, in the container of `up`.
      expect(h.docker.execs[t.home[0]]).toMatchObject({ container: container.id, user: 'root', command: homeGitConfigCommand('vscode') });
      // The Git version of the new container is still checked once, after run-user-commands (in finish).
      expect(t.version).toHaveLength(1);
      expect(t.version[0]).toBeGreaterThan(t.userCommands[0]);
    });

    it('a stopped container: ~/.gitconfig again before run-user-commands (the script keeps an existing file), no Git version check', async () => {
      await seedEnvironment(h);
      const container = h.docker.containersOf(ENV_ID)[0];
      await h.service.open(TARGET, options());
      const t = timeline();
      expect(t.home).toHaveLength(1);
      expect(h.docker.execs[t.home[0]]).toMatchObject({ container: container.id, user: 'root', command: homeGitConfigCommand('vscode') });
      expect(t.token[0]).toBeLessThan(t.home[0]);
      expect(t.home[0]).toBeLessThan(t.userCommands[0]);
      expect(t.version).toEqual([]);
    });

    it('warns about old Git once per new container, as before, and not when the container is only started again', async () => {
      h.docker.execHandler = (_container, command) => (command[0] === 'git' && command[1] === '--version' ? { stdout: 'git version 2.8.6\n' } : {});
      await h.service.open(TARGET, options());
      expect(h.ui.warnings).toEqual([Messages.oldGit('2.8.6')]);
      expect(timeline().version).toHaveLength(1);
      // Stopped and opened again: the script runs again (it keeps the file), the version is not checked again.
      for (const container of h.docker.containers.values()) {
        container.state = 'stopped';
        container.rawState = 'exited';
      }
      h.ui.warnings.length = 0;
      await h.service.open(TARGET, options());
      expect(h.ui.warnings).toEqual([]);
      expect(timeline().version).toHaveLength(1);
      expect(timeline().home).toHaveLength(2);
    });

    it('a failed ~/.gitconfig does not keep the lifecycle commands from running (a logged warning, as before)', async () => {
      h.docker.execHandler = (_container, command) => (command[2] === HOME_GIT_CONFIG_SCRIPT ? { exitCode: 2, stderr: 'denied' } : {});
      await h.service.open(TARGET, options());
      expect(h.helper.userCommandRuns).toHaveLength(1);
      // Root, then the remote user; not again in finish.
      expect(timeline().home).toHaveLength(2);
      expect(h.logger.warnings).toContain('The Git configuration of vscode in the container could not be prepared: denied');
      expect(h.ui.warnings).toEqual([]);
    });
  });

  it('review PL-1: up and run-user-commands get the token of the session for the redaction of their output', async () => {
    await h.service.open(TARGET, options());
    expect(h.helper.upTokens).toEqual([TOKEN]);
    expect(h.helper.userCommandContext.map((run) => run.token)).toEqual([TOKEN]);
  });

  it('first open: writes the token after up and before run-user-commands, which gets the inputs of up', async () => {
    const result = await h.service.open(TARGET, options());
    const env = result.environment;
    const container = h.docker.containersOf(env.id)[0];
    expect(h.helper.ups).toHaveLength(1);
    expect(h.helper.userCommandRuns).toEqual([
      { containerId: container.id, environmentId: env.id, override: h.helper.ups[0].override, upsBefore: 1, tokenWritesBefore: 1 },
    ]);
    // The token is written once, into the container of `up`, as the remote user that `up` reports.
    expect(h.docker.tokenWrites()).toEqual([{ container: container.id, user: 'root', remoteUser: 'vscode', login: 'octo', token: TOKEN }]);
    expect(JSON.stringify(h.helper.userCommandRuns)).not.toContain(TOKEN);
    expect(h.ui.warnings).toEqual([]);
  });

  it('a stopped container: up starts it, then run-user-commands (its markers decide: postStartCommand runs again)', async () => {
    await seedEnvironment(h);
    const container = h.docker.containersOf(ENV_ID)[0];
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(h.helper.userCommandRuns).toEqual([expect.objectContaining({ containerId: container.id, upsBefore: 1, tokenWritesBefore: 1 })]);
    expect(h.docker.tokenWrites()).toHaveLength(1);
  });

  it('a running container: neither up nor run-user-commands (no create command runs again); the token is written', async () => {
    await seedEnvironment(h, { container: 'running' });
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.helper.userCommandRuns).toEqual([]);
    expect(h.docker.tokenWrites()).toHaveLength(1);
  });

  it('an update: run-user-commands in the new container, after the token', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    await h.service.open(TARGET, options());
    const container = h.docker.containersOf(ENV_ID)[0];
    expect(container.image).toBe(IMAGE_2);
    expect(h.helper.userCommandRuns).toEqual([expect.objectContaining({ containerId: container.id, upsBefore: 1, tokenWritesBefore: 1 })]);
  });

  it('a failed token write: the lifecycle commands run all the same, with the existing warning', async () => {
    h.docker.execHandler = (_container, command) => (command[2] === TOKEN_WRITE_SCRIPT ? { exitCode: 1, stderr: 'no tmpfs' } : {});
    const result = await h.service.open(TARGET, options());
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(h.ui.warnings).toEqual([Messages.gitSetupFailed]);
    expect(await pendingIds()).toEqual([result.environment.id]);
  });

  it('a lifecycle command that fails in run-user-commands: the existing warning, the environment opens', async () => {
    await seedEnvironment(h);
    h.helper.lifecycleFailure = () => POST_CREATE_FAILED;
    const result = await h.service.open(TARGET, options());
    expect(result.containerName).toBe(NAME);
    expect(h.helper.userCommandRuns).toHaveLength(1);
    expect(h.ui.warnings).toEqual([PipelineTexts.lifecycleCommandFailed('postCreateCommand')]);
    expect(await pendingIds()).toEqual([ENV_ID]);
  });

  it('a failed lifecycle command whose container does not run: startFailed (with Try again), as for up', async () => {
    await seedEnvironment(h);
    h.helper.userCommandsError = new DevcontainerCommandError('devcontainer run-user-commands', 1, '', '', {
      outcome: 'error',
      description: POST_CREATE_FAILED,
      containerId: 'container-gone',
    });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.ui.warnings).toEqual([]);
    expect(await pendingIds()).toEqual([]);
  });

  it('another failure of run-user-commands fails the open as a failure of up', async () => {
    await seedEnvironment(h);
    h.helper.userCommandsError = new DevcontainerCommandError('devcontainer run-user-commands', 1, '', '', {
      outcome: 'error',
      description: 'An error occurred running user commands in the container.',
    });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(h.ui.warnings).toEqual([]);
  });
});
