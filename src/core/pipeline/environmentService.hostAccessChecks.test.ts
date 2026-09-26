// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Concept section 9 "Host access", user request 2026-09-26: the host access checks can be turned off per repository
// (setting devEnvLauncher.hostAccessChecksOff), and are on by default. The open pipeline with the switch off, and with
// the switch on again for a container that was created while it was off.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError, UserFacingError } from '../errors';
import { GITHUB_CLI_ACCOUNT_REASON } from '../helper/containerGit';
import { runArgsProblems } from '../helper/hostAccess';
import { Messages } from '../messages';
import {
  CONTAINER_CONFIG_UNKNOWN,
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_CONTAINER_CONFIG,
  LABEL_CONTAINER_VERSION,
  LABEL_HOST_ACCESS,
  environmentImageName,
  resourceName,
} from '../names';
import type { RefusedUpdate } from '../types';
import type { RepositoryTarget } from './environmentService';
import {
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  REPO,
  checked,
  createHarness,
  imageConfigWithUser,
  seedEnvironment,
  type Harness,
} from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH, configHash } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const NAME = resourceName(REPO, ENV_ID);
const IMAGE_1 = environmentImageName(ENV_ID, 1);
const IMAGE_2 = environmentImageName(ENV_ID, 2);
const UNRESTRICTED_LABELS = { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED };
const PRIVILEGED_WITH_SOCKET = {
  image: BASE_IMAGE,
  privileged: true,
  mounts: ['source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind'],
};

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

function options(extra: { forceRebuild?: boolean } = {}): { progress: typeof h.progress; forceRebuild?: boolean } {
  return { progress: h.progress, ...extra };
}

/** The switch of the repository in the settings, which the pipeline reads at each open. */
function checksOff(...repositories: string[]): void {
  h.settings = { ...h.settings, hostAccessChecksOff: repositories };
}

function checksOn(): void {
  h.settings = { ...h.settings, hostAccessChecksOff: [] };
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

function offLines(): string[] {
  return h.logger.warnings.filter((line) => line.startsWith(`The host access checks are off for ${REPO}`));
}

describe('host access checks off for the repository', () => {
  it('opens a configuration with privileged mode and a bind mount of the Docker socket, and labels the container', async () => {
    checksOff(REPO);
    h.helper.config = PRIVILEGED_WITH_SOCKET;
    const { environment } = await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.helper.ups).toHaveLength(1);
    const runArgs = h.helper.ups[0].override.runArgs as string[];
    const name = environment.containerName;
    expect(runArgs).toEqual(['--label', 'devenv.container-version=4', '--label', 'devenv.host-access=unrestricted', '--name', name]);
    // The labels of the override configuration pass the policy also with the checks on.
    expect(runArgsProblems(runArgs, environment.volumeName)).toEqual([]);
    expect(h.docker.containersOf(environment.id)[0].labels[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);
    // The log states it at every open.
    expect(offLines()).toHaveLength(1);
    await h.service.openEnvironment(environment.id, options());
    expect(offLines()).toHaveLength(2);
  });

  it('compares the repository without case', async () => {
    checksOff('ACME/Api');
    await seedEnvironment(h, { container: null });
    h.helper.config = { image: BASE_IMAGE, runArgs: ['--privileged', '--device', '/dev/fuse'] };
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups[0].override.runArgs).toEqual([
      '--privileged',
      '--device',
      '/dev/fuse',
      '--label',
      'devenv.container-version=4',
      '--label',
      'devenv.host-access=unrestricted',
      '--name',
      NAME,
    ]);
  });

  it('turns off only the checks of the listed repositories', async () => {
    checksOff('acme/other');
    await seedEnvironment(h, { container: null });
    h.helper.config = { image: BASE_IMAGE, privileged: true };
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.message).toBe(Messages.hostAccess('privileged mode'));
    expect(offLines()).toEqual([]);
  });

  it('keeps the published ports as the configuration writes them (no 127.0.0.1)', async () => {
    checksOff(REPO);
    await seedEnvironment(h, { container: null });
    h.helper.config = { image: BASE_IMAGE, runArgs: ['-p', '8080:80', '-p0.0.0.0:9000:9000', '-P'], appPort: [3000, '5000:5000', '0.0.0.0:6000:6000'] };
    await h.service.openEnvironment(ENV_ID, options());
    const override = h.helper.ups[0].override;
    expect(override.runArgs).toEqual(['-p', '8080:80', '-p0.0.0.0:9000:9000', '-P', '--label', 'devenv.container-version=4', '--label', 'devenv.host-access=unrestricted', '--name', NAME]);
    expect(override.appPort).toEqual([3000, '5000:5000', '0.0.0.0:6000:6000']);
  });

  it('allows a Feature that needs the computer (image metadata before up)', async () => {
    checksOff(REPO);
    await seedEnvironment(h, { container: null });
    h.docker.imageConfigs.set(IMAGE_1, imageConfigWithUser('vscode', [{ id: 'docker-in-docker', privileged: true }]));
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'offline');
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a token variable of the GitHub CLI', { containerEnv: { GH_TOKEN: 'x' } }, Messages.hostAccess(`variable GH_TOKEN in containerEnv (${GITHUB_CLI_ACCOUNT_REASON})`)],
    ['a variable of container-only Git', { runArgs: ['-e', 'GIT_CONFIG_GLOBAL=/x'] }, Messages.hostAccess('variable GIT_CONFIG_GLOBAL in runArgs')],
    ['initializeCommand', { initializeCommand: 'docker ps' }, Messages.hostAccess('initializeCommand')],
    ['the cache volume of the workspace helper', { mounts: ['source=devenv-helper-cache,target=/c,type=volume'] }, Messages.hostAccess('volume devenv-helper-cache of the workspace helper')],
    ['the workspace volume of another environment', { mounts: ['source=devenv-acme-web-11111111,target=/w,type=volume'] }, Messages.hostAccess('volume devenv-acme-web-11111111 of another environment')],
    ['a label of Dev Environments', { runArgs: ['--label', 'devenv.environment-id=x'] }, Messages.unsupportedOptions('label devenv.environment-id')],
    ['an unknown flag', { runArgs: ['--pull=always', '--privileged'] }, Messages.unsupportedOptions('--pull')],
    ['--restart always', { runArgs: ['--restart=always'] }, Messages.unsupportedOptions('--restart=always')],
    ['a log driver that writes to the computer', { runArgs: ['--log-driver', 'syslog'] }, Messages.hostAccess('--log-driver=syslog')],
  ])('still refuses %s', async (_name, config, message) => {
    checksOff(REPO);
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.config = { image: BASE_IMAGE, ...config };
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(message);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('starts a container that was created with the checks on as it is (it has less access)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    checksOff(REPO);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
    expect(h.progress.details).toEqual([]);
  });

  it('starts a container that was created with the checks off as it is while they stay off', async () => {
    await seedEnvironment(h, { container: 'stopped', containerLabels: UNRESTRICTED_LABELS });
    checksOff(REPO);
    h.helper.config = PRIVILEGED_WITH_SOCKET;
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
    expect(h.docker.containersOf(ENV_ID)[0].labels[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);
  });

  it('names the configuration as the reason when a container of the checks-off time was created without it (B2)', async () => {
    // Created while the checks were off and the configuration could not be read; the checks stay off and the
    // configuration can be read now: the reason is the configuration, not an older version of Dev Environments.
    await seedEnvironment(h, {
      container: 'stopped',
      containerLabels: { ...UNRESTRICTED_LABELS, [LABEL_CONTAINER_CONFIG]: CONTAINER_CONFIG_UNKNOWN },
    });
    checksOff(REPO);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, true]]);
    expect(h.progress.details).toEqual([Messages.containerConfigApplied]);
    expect(h.logger.infos.some((line) => line.includes('was created without the configuration, which can be read now'))).toBe(true);
    expect(h.logger.infos.some((line) => line.includes('older version of Dev Environments'))).toBe(false);
  });
});

describe('host access checks on again (containerIsCurrent)', () => {
  it('creates a container of the checks-off time again from the environment image when the configuration passes', async () => {
    await seedEnvironment(h, { container: 'running', containerLabels: UNRESTRICTED_LABELS });
    const before = h.docker.containersOf(ENV_ID)[0].id;
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, true]]);
    const [container] = h.docker.containersOf(ENV_ID);
    expect(container.id).not.toBe(before);
    expect(container.labels[LABEL_HOST_ACCESS]).toBeUndefined();
    expect(h.helper.ups[0].override.runArgs).toEqual(['--label', 'devenv.container-version=4', '--name', NAME]);
    expect(h.progress.details).toEqual([Messages.containerHostAccessChecksOn]);
    expect(h.logger.infos.some((line) => line.includes('was created while the host access checks were off. They are on now'))).toBe(true);
    // The next open starts it as it is.
    h.progress.details.length = 0;
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([
      [IMAGE_1, true],
      [IMAGE_1, false],
    ]);
    expect(h.progress.details).toEqual([]);
  });

  it('stops the open with the normal refusal when the configuration still needs the computer, and starts nothing', async () => {
    await seedEnvironment(h, { container: 'stopped', containerLabels: UNRESTRICTED_LABELS });
    h.helper.config = PRIVILEGED_WITH_SOCKET;
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('bind mount /var/run/docker.sock, privileged mode'));
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)[0].state).toBe('stopped');
  });

  it('refuses before up when the environment image needs the computer (image metadata), and keeps the container stopped', async () => {
    await seedEnvironment(h, { container: 'stopped', containerLabels: UNRESTRICTED_LABELS });
    h.docker.imageConfigs.set(IMAGE_1, imageConfigWithUser('vscode', [{ id: 'docker-in-docker', privileged: true }]));
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('privileged mode'));
    expect(h.helper.ups).toEqual([]);
    const [container] = h.docker.containersOf(ENV_ID);
    expect(container.state).toBe('stopped');
    expect(container.labels[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);
  });

  it('does not let the merged configuration of such a container block the open that creates it again', async () => {
    // The CLI merges the metadata of the existing container, which holds what the checks allowed while they were off.
    await seedEnvironment(h, { container: 'stopped', containerLabels: UNRESTRICTED_LABELS });
    h.helper.merged = { privileged: true, runArgs: ['--label', 'devenv.container-version=4', '--label', 'devenv.host-access=unrestricted'] };
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, true]]);
    expect(h.docker.containersOf(ENV_ID)[0].labels[LABEL_HOST_ACCESS]).toBeUndefined();
  });

  it('still checks the merged configuration of a container that was created with the checks on', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.helper.merged = { privileged: true };
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.message).toBe(Messages.hostAccess('privileged mode'));
  });

  it('creates it again also when the configuration cannot be read, after the image metadata passes', async () => {
    await seedEnvironment(h, { container: 'running', containerLabels: UNRESTRICTED_LABELS });
    h.helper.readConfigurationError = new CommandError('devcontainer read-configuration', 1, '', 'broken');
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, true]]);
    expect(h.docker.containersOf(ENV_ID)[0].labels[LABEL_HOST_ACCESS]).toBeUndefined();
  });

  it('reads the switch at each open: off, then on again', async () => {
    await seedEnvironment(h, { container: null });
    h.helper.config = { image: BASE_IMAGE, capAdd: ['NET_ADMIN'] };
    checksOff(REPO);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.containersOf(ENV_ID)[0].labels[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);

    checksOn();
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.message).toBe(Messages.hostAccess('capability NET_ADMIN'));
    expect(h.helper.ups).toHaveLength(1);

    // The configuration no longer needs the capability: the container is created again, with the checks.
    h.helper.config = { image: BASE_IMAGE };
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => up.removeExistingContainer)).toEqual([false, true]);
    expect(h.docker.containersOf(ENV_ID)[0].labels[LABEL_HOST_ACCESS]).toBeUndefined();
  });
});

describe('a refused update and the switch (concept 7.7)', () => {
  const SOCKET_MOUNT = { id: 'docker-outside-of-docker', mounts: [{ source: '/var/run/docker.sock', target: '/x', type: 'bind' }] };
  const GH_TOKEN_ENV = { id: 'gh-token', containerEnv: { GH_TOKEN: 'x' } };

  async function refusedUpdate(): Promise<RefusedUpdate | undefined> {
    return (await h.registry.get(ENV_ID))?.refusedUpdate;
  }

  it('does not block the update after the checks were turned off, when it was refused with the checks on', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
    h.helper.buildMetadata = [SOCKET_MOUNT];
    await h.service.openEnvironment(ENV_ID, options());
    expect(await refusedUpdate()).toEqual({
      configPath: DEFAULT_CONFIG_PATH,
      configHash: configHash(DEFAULT_CONFIG_TEXT),
      images: { [BASE_IMAGE]: DIGEST_NEW },
      features: { [FEATURE]: FEATURE_DIGEST },
      items: 'bind mount /var/run/docker.sock',
    });
    expect(h.helper.builds).toHaveLength(1);

    // With the checks on, the same update is not built again.
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toHaveLength(1);

    // With the checks off, it is built and used.
    checksOff(REPO);
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toHaveLength(2);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.environmentImage).toBe(environmentImageName(ENV_ID, 3));
    expect(await refusedUpdate()).toBeUndefined();
    expect(h.docker.containersOf(ENV_ID)[0].labels[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);
  });

  it('does not block the update after the checks were turned on, when it was refused with the checks off', async () => {
    checksOff(REPO);
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } }, container: 'stopped' });
    // A variable of the GitHub CLI stays refused with the checks off.
    h.helper.buildMetadata = [GH_TOKEN_ENV];
    await h.service.openEnvironment(ENV_ID, options());
    expect((await refusedUpdate())?.hostAccessChecks).toBe('off');
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);

    // Checks off again: the same update is not built again.
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toHaveLength(1);

    // Checks on: the update is tried again (and refused again, now as a refusal with the checks on).
    checksOn();
    h.docker.containersOf(ENV_ID)[0].state = 'stopped';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toHaveLength(2);
    expect((await refusedUpdate())?.hostAccessChecks).toBeUndefined();
  });
});
