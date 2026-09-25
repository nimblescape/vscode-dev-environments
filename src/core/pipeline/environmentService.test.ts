import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import { CommandError, UserFacingError } from '../errors';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import { ensureHelperImage, helperImageTag, type HelperImageDocker } from '../helper/helperImage';
import type { EnsureImageOptions } from '../helper/workspaceHelper';
import { Messages } from '../messages';
import {
  LABEL_ENVIRONMENT_ID,
  LABEL_REPOSITORY,
  environmentImageName,
  environmentImageRepository,
  resourceName,
} from '../names';
import { abortError } from '../ports';
import type { Environment, WindowStatus } from '../types';
import { PipelineTexts, type EnvironmentServiceDeps, type RepositoryTarget } from './environmentService';
import {
  BASE_IMAGE,
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
  checked,
  createHarness,
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

/** A git summary script run through docker exec: 4 lines. */
function gitExecOutput(branch: string, counts = [0, 0, 0]): string {
  return `${branch}\n${counts.join('\n')}\n`;
}

describe('open: first open', () => {
  it('creates the environment: entry, volume with labels, clone, pull, build, up, ownership, record', async () => {
    h.docker.execHandler = (_container, command) =>
      command[0] === 'sh' && command[2]?.includes('rev-list') ? { stdout: gitExecOutput('main') } : {};
    const result = await h.service.open(TARGET, options());

    const env = await h.registry.findByRepository(REPO);
    expect(env).toBeDefined();
    const id = env!.id;
    const name = resourceName(REPO, id);
    expect(result.containerName).toBe(name);
    expect(result.remoteWorkspaceFolder).toBe('/workspaces/api');
    expect(env!.volumeName).toBe(name);
    expect(h.docker.volumes.get(name)).toEqual({ [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: REPO });
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
    expect(h.helper.ups[0].override.runArgs).toEqual(['--name', name]);

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
    expect(await h.registry.findByRepository(REPO)).toBeDefined();
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
      busy = (await h.registry.findByRepository(REPO))?.busy;
    };
    await h.service.open(TARGET, options());
    expect(busy).toMatchObject({ operation: 'create', pid: PID, windowId: WINDOW_ID });
    expect((await h.registry.findByRepository(REPO))?.busy).toBeUndefined();
  });

  it('writes the pending connection file before up, so the new container is in use from its start', async () => {
    const pendingAtUp: string[][] = [];
    const original = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      pendingAtUp.push(await pendingIds());
      return original(p);
    };
    await h.service.open(TARGET, options());
    const id = (await h.registry.findByRepository(REPO))!.id;
    expect(pendingAtUp).toEqual([[id]]);
    expect(await pendingIds()).toEqual([id]);
  });

  it('skips the ownership fix for root', async () => {
    h.helper.remoteUser = 'root';
    await h.service.open(TARGET, options());
    expect(h.docker.execs.some((e) => e.command.join(' ').includes('chown'))).toBe(false);
    expect(h.docker.runs).toEqual([]);
    expect((await h.registry.findByRepository(REPO))?.remoteUser).toBe('root');
  });

  it('gives the cloned files to the remote user before up runs the lifecycle commands', async () => {
    let runsAtUp = -1;
    const original = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      runsAtUp = h.docker.runs.length;
      return original(p);
    };
    await h.service.open(TARGET, options());
    const env = (await h.registry.findByRepository(REPO))!;
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

  it('continues when the files cannot be given to the remote user before up', async () => {
    h.docker.runError = new CommandError('docker run', 1, '', 'sh: find: not found');
    await h.service.open(TARGET, options());
    expect(h.docker.runs).toHaveLength(1);
    expect(h.helper.ups).toHaveLength(1);
    expect(h.logger.warnings.some((w) => w.includes('could not be changed before the container was created'))).toBe(true);
  });

  it('uses the environment that another window created in the meantime (one per repository)', async () => {
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
    const env = await h.registry.findByRepository(REPO);
    expect(env?.configPath).toBe('.devcontainer/python/devcontainer.json');
    expect(env?.buildRecord?.configPath).toBe('.devcontainer/python/devcontainer.json');
  });

  it('uses the first configuration silently for an unknown repository without configuration paths', async () => {
    h.helper.files = { '.devcontainer.json': { configText: DEFAULT_CONFIG_TEXT } };
    await h.service.open({ ...TARGET, configPaths: [] }, options());
    expect(h.ui.infos).toEqual([]);
    expect((await h.registry.findByRepository(REPO))?.configPath).toBe('.devcontainer.json');
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
      configText: '{ "image": "ubuntu", "mounts": ["source=${localWorkspaceFolder}/data,target=/data,type=bind"] }',
    };
    await h.service.open(TARGET, options());
    expect(h.ui.warnings).toEqual([Messages.computerDependent('${localWorkspaceFolder}')]);
    expect(h.helper.ups).toHaveLength(1);
  });

  it('passes local values of ${localEnv:…} to the helper', async () => {
    h.helper.files[DEFAULT_CONFIG_PATH] = {
      configText: '{ "image": "ubuntu", "containerEnv": { "A": "${localEnv:FOO}", "B": "${localEnv:MISSING:x}" } }',
    };
    await h.service.open(TARGET, options());
    expect(h.helper.readConfigurationEnv[0]).toEqual({ FOO: 'local-foo' });
    expect(h.helper.builds[0].localEnv).toEqual({ FOO: 'local-foo' });
    expect(h.helper.ups[0].localEnv).toEqual({ FOO: 'local-foo' });
  });

  it('stores shutdownAction none and the additional named volumes', async () => {
    h.helper.config = {
      image: BASE_IMAGE,
      shutdownAction: 'none',
      mounts: ['source=api-data,target=/data,type=volume', { source: '/host', target: '/x', type: 'bind' }],
    };
    await h.service.open(TARGET, options());
    const env = await h.registry.findByRepository(REPO);
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
      expect(h.docker.volumes.get(NAME)).toEqual({ [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO });
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
    h.docker.volumes.set(OLD_NAME, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO });
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

  it('creates the environment when only volumes of other repositories exist, and restores those', async () => {
    h.docker.volumes.set(OLD_NAME, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/web' });
    const result = await h.service.open(TARGET, options());
    expect(result.environment.id).not.toBe(OTHER_ID);
    expect(h.helper.clones).toHaveLength(1);
    expect((await h.registry.list()).map((e) => e.repository).sort()).toEqual(['acme/api', 'acme/web']);
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
    const env = (await h.registry.findByRepository(REPO))!;
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
    h.docker.volumes.set('api-data', {});
    h.docker.volumes.set('shared-cache', {});
    await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
    await h.sessionFiles.writeOperation({ environmentId: ENV_ID, operation: 'delete', requestedAt: new Date(0).toISOString(), requestedBy: WINDOW_ID, reason: 'manual' });
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: new Date(0).toISOString() });

    await h.service.delete(ENV_ID, options({ removeAdditionalVolumes: true }));

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
    await h.service.delete(ENV_ID, options({ removeAdditionalVolumes: false }));
    expect(h.docker.log.filter((line) => line.startsWith('rmi mcr.'))).toEqual([`rmi ${oldBase}`, `rmi ${BASE_IMAGE}`]);
    expect(h.docker.images.has(BASE_IMAGE)).toBe(false);
    expect(h.docker.images.has('mcr.microsoft.com/devcontainers/base:other')).toBe(true);
  });

  it('keeps additional volumes unless asked, and a reopen record of another environment', async () => {
    await seedEnvironment(h, { extra: { additionalVolumes: ['api-data'] } });
    h.docker.volumes.set('api-data', {});
    h.sessionFiles.writeReopenSync({ environmentId: OTHER_ID, closedAt: new Date(0).toISOString() });
    await h.service.delete(ENV_ID, options({ removeAdditionalVolumes: false }));
    expect(h.docker.volumes.has('api-data')).toBe(true);
    expect((await h.sessionFiles.readReopen())?.environmentId).toBe(OTHER_ID);
  });

  it('keeps a base image that another environment uses', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', record: { images: { [BASE_IMAGE]: DIGEST_OLD }, environmentImage: environmentImageName(OTHER_ID, 1) } });
    await h.service.delete(ENV_ID, options({ removeAdditionalVolumes: false }));
    expect(h.docker.log.filter((l) => l.includes(DIGEST_OLD))).toEqual([]);
  });

  it('keeps the entry and clears the busy mark when the volume cannot be removed', async () => {
    await seedEnvironment(h);
    h.docker.volumesInUse.add(NAME);
    await expect(h.service.delete(ENV_ID, options({ removeAdditionalVolumes: false }))).rejects.toBeInstanceOf(CommandError);
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
    await h.service.delete(ENV_ID, options({ removeAdditionalVolumes: false }));
    expect(busy?.operation).toBe('delete');
  });

  it('removes only the files of an environment that is not in the registry', async () => {
    await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
    await h.service.delete(ENV_ID, options({ removeAdditionalVolumes: false }));
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
    h.docker.volumes.set('duplicate', { [LABEL_ENVIRONMENT_ID]: '11111111-2222-3333-4444-555555555555', [LABEL_REPOSITORY]: 'ACME/api' });
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
