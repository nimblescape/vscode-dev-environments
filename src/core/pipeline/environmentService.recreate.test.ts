// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Recreate offer (user request 2026-09-26): an existing container that cannot be started or used because it is damaged
// (for example its /etc/passwd lacks the user) is offered to be created again from its environment image, after a modal
// question that names what is kept and what is lost. Each failure class that offers it and each that does not; Recreate
// and Cancel; the volume is never removed. Docker Compose: environmentService.compose.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import { Messages } from '../messages';
import { CONTAINER_VERSION, LABEL_CONTAINER_VERSION, environmentImageName, resourceName } from '../names';
import { abortError } from '../ports';
import type { DevcontainerResult } from '../types';
import { PipelineTexts, type RepositoryTarget } from './operationBase';
import { ENV_ID, REPO, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { isContainerFault } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const NAME = resourceName(REPO, ENV_ID);
const IMAGE_1 = environmentImageName(REPO, ENV_ID, 1);

/** What Docker 29.3.1 prints in the output of `devcontainer up` when /etc/passwd of the container lacks the user. */
const PASSWD_DAMAGED =
  'Shell server terminated (code: 1, signal: null)\n\nError response from daemon: unable to find user vscode: no matching entries in passwd file\n\nError: An error occurred setting up the container.';
/** `docker start` of a container whose shell was removed (Docker 29.3.1, runc 1.3). */
const SHELL_MISSING =
  'Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "/bin/sh": stat /bin/sh: no such file or directory';
/** `docker start` of a container in the state `dead`. */
const MARKED_FOR_REMOVAL = 'Error response from daemon: container is marked for removal and cannot be started';
/** `docker exec` when the shell of the container is no longer executable. */
const SHELL_NOT_EXECUTABLE = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/sh": permission denied';

/** The error of `devcontainer up` of CLI 0.89.0 after its setup of the started container failed. */
function upFailure(stderr: string, containerId = 'container-1'): DevcontainerCommandError {
  const result: DevcontainerResult = {
    outcome: 'error',
    message: 'An error occurred setting up the container.',
    description: 'An error occurred setting up the container.',
    containerId,
  };
  return new DevcontainerCommandError('devcontainer up', 1, `${JSON.stringify(result)}\n`, stderr, result);
}

let h: Harness;

afterEach(() => {
  h?.cleanup();
});

function options() {
  return { progress: h.progress };
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

function ups(): string[] {
  return h.helper.calls.filter((call) => call.startsWith('up '));
}

/** Nothing ever removes a volume, and the workspace volume is still there. */
function expectVolumesKept(): void {
  expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
  expect(h.docker.volumes.has(NAME)).toBe(true);
}

/** `up` of the existing container fails with `stderr` once; the `up` that replaces it works. */
function failFirstUp(stderr: string): void {
  h.helper.upError = (_image, removeExisting) => (removeExisting ? undefined : upFailure(stderr));
}

describe('recreate offer: a stopped container that cannot be started or used', () => {
  it.each([
    ['its /etc/passwd lacks the user (the CLI cannot exec into it)', PASSWD_DAMAGED],
    ['its shell is missing (docker start fails)', SHELL_MISSING],
    ['it is marked for removal (docker start fails)', MARKED_FOR_REMOVAL],
  ])('%s: Recreate removes it and creates it again from the environment image, without a build', async (_name, stderr) => {
    h = createHarness();
    await seedEnvironment(h);
    const old = h.docker.containersOf(ENV_ID)[0];
    failFirstUp(stderr);
    h.ui.recreateAnswer = true;

    const result = await h.service.open(TARGET, options());

    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
    expect(h.ui.recreateQuestions).toEqual([{ message: Messages.containerRecreateQuestion(REPO, false), detail: Messages.containerRecreateDetail(false) }]);
    // The existing environment image, no build, no download; `up` replaces the container (the CLI's `docker rm -f`).
    expect(ups()).toEqual([`up ${IMAGE_1}`, `up ${IMAGE_1} --remove-existing-container`]);
    expect(h.helper.calls.some((call) => call.startsWith('build'))).toBe(false);
    expect(h.docker.pulls).toEqual([]);
    const containers = h.docker.containersOf(ENV_ID);
    expect(containers).toHaveLength(1);
    expect(containers[0].id).not.toBe(old.id);
    expect(containers[0]).toMatchObject({ name: NAME, image: IMAGE_1, state: 'running' });
    expect(result.containerName).toBe(NAME);
    // The lifecycle commands run in the new container (onCreateCommand and postCreateCommand again), with the token.
    expect(h.helper.userCommandRuns.at(-1)?.containerId).toBe(containers[0].id);
    // The progress says what is lost, as for the other recreations (concept 6.5).
    expect(h.progress.details).toContain(Messages.containerRecreatedDamaged());
    expectVolumesKept();
    // The busy mark of the recreation is gone.
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('Cancel changes nothing: startFailed with the cause, the container stays, nothing is removed', async () => {
    h = createHarness();
    await seedEnvironment(h);
    const old = h.docker.containersOf(ENV_ID)[0];
    failFirstUp(PASSWD_DAMAGED);
    h.ui.recreateAnswer = false;

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(error.message).toBe(PipelineTexts.startFailed);
    expect(error.detail).toContain('unable to find user vscode');
    expect(error.detail).toContain('nothing was changed');
    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
    expect(ups()).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([old.id]);
    expect(h.docker.log.filter((line) => line.startsWith('rm ') || line.startsWith('rmi '))).toEqual([]);
    expectVolumesKept();
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('run-user-commands fails because the started container lacks the user: offered as well', async () => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.userCommandsError = new DevcontainerCommandError('devcontainer run-user-commands', 1, '', PASSWD_DAMAGED);
    h.ui.recreateContainer = async (repository, question) => {
      h.ui.prompts.push(`recreateContainer ${repository}`);
      h.ui.recreateQuestions.push(question);
      // The new container has a working /etc/passwd.
      h.helper.userCommandsError = undefined;
      return true;
    };

    await h.service.open(TARGET, options());

    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
    expect(ups()).toEqual([`up ${IMAGE_1}`, `up ${IMAGE_1} --remove-existing-container`]);
    expectVolumesKept();
  });

  it('the recreation itself fails: startFailed; the volume is kept, and the next open creates the container', async () => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.upError = (_image, removeExisting) => (removeExisting ? upFailure('Error: No space left on device') : upFailure(PASSWD_DAMAGED));
    h.ui.recreateAnswer = true;

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('No space left on device');
    // Asked once: a failed recreation is not offered again in the same open.
    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
    expectVolumesKept();
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('review round 13 of PR #64 (R13-1): the helper image of the open is gone at the recreation: helperFailed, the volume is kept', async () => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.upFailsBeforeRemoval = true;
    h.helper.upError = (_image, removeExisting) =>
      removeExisting ? new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`) : upFailure(PASSWD_DAMAGED);
    h.ui.recreateAnswer = true;

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('helperFailed');
    expect(ups()).toEqual([`up ${IMAGE_1}`, `up ${IMAGE_1} --remove-existing-container`]);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    expectVolumesKept();
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('review round 2 of PR #68: run-user-commands of the recreated container fails with helperFailed: it is removed, and the next open creates it with its lifecycle commands', async () => {
    h = createHarness();
    await seedEnvironment(h);
    failFirstUp(PASSWD_DAMAGED);
    h.ui.recreateAnswer = true;
    h.helper.userCommandsError = new UserFacingError('helperFailed', Messages.helperFailed, `No such image: sha256:${'4'.repeat(64)}`);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('helperFailed');
    expect(error.message).toBe(Messages.helperFailed);
    expect(error.detail).toBe(
      `The damaged container was created again, but its lifecycle commands could not run. It was removed; the next open creates it again. No such image: sha256:${'4'.repeat(64)}`,
    );
    expect(ups()).toEqual([`up ${IMAGE_1}`, `up ${IMAGE_1} --remove-existing-container`]);
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expectVolumesKept();
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();

    h.helper.userCommandsError = undefined;
    h.helper.upError = () => undefined;
    h.settings.updateImagesOnConnect = false;
    const runs = h.helper.userCommandRuns.length;
    h.helper.calls.length = 0;
    await h.service.open(TARGET, options());
    expect(ups()).toEqual([`up ${IMAGE_1}`]);
    expect(h.helper.userCommandRuns.length).toBe(runs + 1);
    expect(h.docker.containersOf(ENV_ID)).toEqual([expect.objectContaining({ state: 'running' })]);
  });

  it('a Cancel of the operation during the question: cancelled, nothing is removed', async () => {
    h = createHarness();
    await seedEnvironment(h);
    failFirstUp(PASSWD_DAMAGED);
    const controller = new AbortController();
    h.ui.recreateContainer = async () => {
      controller.abort();
      return true;
    };

    const error = await rejection(h.service.open(TARGET, { progress: h.progress, signal: controller.signal }));

    expect(error.code).toBe('cancelled');
    expect(ups()).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    expectVolumesKept();
  });
});

describe('recreate offer, review round 3: a single container while the configuration cannot be read', () => {
  it('the question says that the runArgs, their mounts, and the published ports stay off until it can be read', async () => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.readConfigurationError = new DevcontainerCommandError('devcontainer read-configuration', 1, '', 'SyntaxError');
    failFirstUp(PASSWD_DAMAGED);
    h.ui.recreateAnswer = true;

    await h.service.open(TARGET, options());

    expect(h.ui.recreateQuestions[0].detail).toBe(Messages.containerRecreateDetail(false, [], true));
    expect(h.ui.recreateQuestions[0].detail).toContain('without the runArgs of the configuration (also their mounts) and without its published ports');
    expect(h.logger.warnings.some((line) => line.startsWith(`The container of ${REPO} is created without the configuration`))).toBe(true);
    expect(ups()).toEqual([`up ${IMAGE_1}`, `up ${IMAGE_1} --remove-existing-container`]);
  });

  it('with a readable configuration, the question does not say so', async () => {
    h = createHarness();
    await seedEnvironment(h);
    failFirstUp(PASSWD_DAMAGED);

    await rejection(h.service.open(TARGET, options()));

    expect(h.ui.recreateQuestions[0].detail).not.toContain('cannot be read');
  });
});

describe('recreate offer, review round 2 (V1): volumes without a name of a single container', () => {
  const NODE_MODULES = '/workspaces/api/node_modules';
  const ANONYMOUS = 'a'.repeat(64);

  it('the question and the progress name their folders; nothing removes them (the CLI removes the container without -v)', async () => {
    h = createHarness();
    await seedEnvironment(h);
    const old = h.docker.containersOf(ENV_ID)[0];
    h.docker.containers.set(old.id, {
      ...old,
      mountTargets: [
        { type: 'volume', volume: NAME, target: '/workspaces' },
        { type: 'volume', volume: ANONYMOUS, target: NODE_MODULES },
        { type: 'volume', volume: 'cache', target: '/cache' },
        { type: 'tmpfs', target: '/run/devenv' },
      ],
    });
    h.docker.volumes.set(ANONYMOUS, {});
    failFirstUp(PASSWD_DAMAGED);
    h.ui.recreateAnswer = true;

    await h.service.open(TARGET, options());

    const detail = h.ui.recreateQuestions[0].detail;
    expect(detail).toBe(Messages.containerRecreateDetail(false, [NODE_MODULES]));
    expect(detail).toContain(`old content stays in a Docker volume without a name: ${NODE_MODULES}.`);
    expect(detail).toContain('all files in the named volumes');
    expect(detail).not.toContain('/cache');
    expect(h.progress.details).toContain(Messages.containerRecreatedDamaged([NODE_MODULES]));
    expectVolumesKept();
    expect(h.docker.volumes.has(ANONYMOUS)).toBe(true);
  });

  it('without such volumes the question names none', async () => {
    h = createHarness();
    await seedEnvironment(h);
    failFirstUp(PASSWD_DAMAGED);

    await rejection(h.service.open(TARGET, options()));

    expect(h.ui.recreateQuestions[0].detail).not.toContain('without a name');
  });
});

describe('recreate offer, review round 1 (D1): the environment changed while the question was open', () => {
  it('another window created a new, healthy container meanwhile: it is not removed, nothing is created', async () => {
    h = createHarness();
    await seedEnvironment(h);
    failFirstUp(PASSWD_DAMAGED);
    let healthy = '';
    h.ui.recreateContainer = async (repository) => {
      h.ui.prompts.push(`recreateContainer ${repository}`);
      const old = h.docker.containersOf(ENV_ID)[0];
      h.docker.containers.delete(old.id);
      healthy = h.docker.addContainer({ environmentId: ENV_ID, name: NAME, state: 'running', image: IMAGE_1 }).id;
      return true;
    };

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(error.detail).toBe(Messages.containerChangedMeanwhile);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([healthy]);
    expect(ups()).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.log.filter((line) => line.startsWith('rm '))).toEqual([]);
    expectVolumesKept();
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('another window built a new environment image meanwhile: the container is not created from the old one', async () => {
    h = createHarness();
    await seedEnvironment(h);
    const old = h.docker.containersOf(ENV_ID)[0];
    failFirstUp(PASSWD_DAMAGED);
    const image2 = environmentImageName(REPO, ENV_ID, 2);
    h.ui.recreateContainer = async (repository) => {
      h.ui.prompts.push(`recreateContainer ${repository}`);
      h.docker.images.add(image2);
      await h.registry.updateEnvironment(ENV_ID, (entry) => {
        // Review round 1 of PR #88 (A-R1-1): a build pins the ID of its image, as buildAndReplace does.
        if (entry.buildRecord) entry.buildRecord = { ...entry.buildRecord, environmentImage: image2, imageId: `sha256:image-of-${image2}`, buildNumber: 2 };
      });
      return true;
    };

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(error.detail).toBe(Messages.containerChangedMeanwhile);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([old.id]);
    expect(ups()).toEqual([`up ${IMAGE_1}`]);
    expectVolumesKept();
  });
});

// Review round 2 of PR #88 (B-R2-8): the image of the recreation is compared by the pinned ID of the record, and else
// by the container's own image (containerImage), never by the name alone.
describe('review round 2 of PR #88 (B-R2-8): the environment image was swapped under its name while the question was open', () => {
  it('the container is not created again from the image that now has the name', async () => {
    h = createHarness();
    await seedEnvironment(h);
    const old = h.docker.containersOf(ENV_ID)[0];
    failFirstUp(PASSWD_DAMAGED);
    h.ui.recreateContainer = async (repository) => {
      h.ui.prompts.push(`recreateContainer ${repository}`);
      // Another image takes the name of the record (and of the container); the pinned image is gone by its ID.
      h.docker.imageIds.set(IMAGE_1, `sha256:${'7'.repeat(64)}`);
      return true;
    };

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(error.detail).toBe(Messages.containerChangedMeanwhile);
    expect(ups()).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([old.id]);
    expectVolumesKept();
  });
});

describe('recreate offer: a running container that the remote user cannot use', () => {
  /** Review round 3 (F1): the current setup, and the user of the container in its label devcontainer.metadata. */
  const RUNNING_LABELS = { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'devcontainer.metadata': JSON.stringify([{ remoteUser: 'vscode' }]) };

  /** The check of the running container (`docker exec -u <remote user> <id> /bin/sh -c 'exit 0'`) fails for `id`. */
  function failCheck(id: string, stderr: string, exitCode = 1): void {
    h.docker.execHandler = (container, command) => (container === id && command[2] === 'exit 0' ? { exitCode, stderr } : {});
  }

  it.each([
    ['its /etc/passwd lacks the user', PASSWD_DAMAGED],
    ['its shell is not executable', SHELL_NOT_EXECUTABLE],
  ])('%s: Recreate creates it again (the window could not attach to it)', async (_name, stderr) => {
    h = createHarness();
    await seedEnvironment(h, { container: 'running', containerLabels: RUNNING_LABELS });
    const old = h.docker.containersOf(ENV_ID)[0];
    failCheck(old.id, stderr, 126);
    h.ui.recreateAnswer = true;

    await h.service.open(TARGET, options());

    // The check runs as the remote user of the environment.
    expect(h.docker.execs.find((exec) => exec.command[2] === 'exit 0')).toMatchObject({ container: old.id, user: 'vscode', command: ['/bin/sh', '-c', 'exit 0'] });
    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
    expect(ups()).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).not.toContain(old.id);
    expectVolumesKept();
  });

  it('Cancel: startFailed, the running container stays as it is', async () => {
    h = createHarness();
    await seedEnvironment(h, { container: 'running', containerLabels: RUNNING_LABELS });
    const old = h.docker.containersOf(ENV_ID)[0];
    failCheck(old.id, PASSWD_DAMAGED);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(ups()).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)).toMatchObject([{ id: old.id, state: 'running' }]);
    expect(h.docker.log).toEqual([]);
    expectVolumesKept();
  });

  it.each([
    ['a failure that names no damage (a command that is missing in the image)', 'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH'],
    ['Docker that does not answer', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'],
    ['a remote host whose SSH connection broke', 'error during connect: Get "http://docker.example.com/v1.48/containers/json": command [ssh -- build-box docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=ssh: connect to host build-box port 22: Connection refused'],
  ])('%s: not offered, the open goes on as before', async (_name, stderr) => {
    h = createHarness();
    await seedEnvironment(h, { container: 'running', containerLabels: RUNNING_LABELS });
    const old = h.docker.containersOf(ENV_ID)[0];
    failCheck(old.id, stderr);

    const result = await h.service.open(TARGET, options());

    expect(h.ui.prompts).toEqual([]);
    expect(result.containerName).toBe(NAME);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([old.id]);
  });

  it('a check that throws (for example a timeout of the process): not offered', async () => {
    h = createHarness();
    await seedEnvironment(h, { container: 'running', containerLabels: RUNNING_LABELS });
    const exec = h.docker.exec.bind(h.docker);
    h.docker.exec = async (container, command, execOptions) => {
      if (command[2] === 'exit 0') throw new Error('spawn docker ETIMEDOUT');
      return exec(container, command, execOptions);
    };

    await h.service.open(TARGET, options());

    expect(h.ui.prompts).toEqual([]);
  });

  it('Docker stops answering after the check failed: not offered', async () => {
    h = createHarness();
    await seedEnvironment(h, { container: 'running', containerLabels: RUNNING_LABELS });
    const old = h.docker.containersOf(ENV_ID)[0];
    h.docker.execHandler = (container, command) => {
      if (container !== old.id || command[2] !== 'exit 0') return {};
      h.docker.running = false;
      return { exitCode: 1, stderr: PASSWD_DAMAGED };
    };

    await h.service.open(TARGET, options()).catch(() => undefined);

    expect(h.ui.prompts).toEqual([]);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([old.id]);
  });

  it('without the workspace helper (it cannot create a container): not checked, not offered', async () => {
    h = createHarness();
    await seedEnvironment(h, { container: 'running', containerLabels: RUNNING_LABELS });
    const old = h.docker.containersOf(ENV_ID)[0];
    failCheck(old.id, PASSWD_DAMAGED);
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed, 'offline');
    // Plan step 6, PR A: changed input, the tag of the helper image exists (the open takes the lock, whose D1 step
    // builds only a missing tag); the maintaining ensure of the open fails as before. A missing tag refuses the open
    // before anything is changed (environmentService.lock.test.ts).
    h.helper.tagPresent = true;

    await h.service.open(TARGET, options()).catch(() => undefined);

    expect(h.ui.prompts).toEqual([]);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([old.id]);
  });

  it('review round 3 (F1): a stale user in the registry and a healthy container: checked as the user of the container, no offer', async () => {
    h = createHarness();
    // A rebuild changed the user to `node`; an open cancelled before its end left `vscode` recorded.
    await seedEnvironment(h, {
      container: 'running',
      containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'devcontainer.metadata': JSON.stringify([{ remoteUser: 'vscode' }, { remoteUser: 'node' }]) },
    });
    const old = h.docker.containersOf(ENV_ID)[0];
    h.docker.execHandler = (container, command, user) =>
      container === old.id && command[2] === 'exit 0' && user !== 'node' ? { exitCode: 1, stderr: PASSWD_DAMAGED } : {};

    const result = await h.service.open(TARGET, options());

    expect(h.docker.execs.find((exec) => exec.command[2] === 'exit 0')?.user).toBe('node');
    expect(h.ui.prompts).toEqual([]);
    expect(result.containerName).toBe(NAME);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([old.id]);
  });

  it('review round 3 (F1): the user of the label is really missing in /etc/passwd: offered', async () => {
    h = createHarness();
    await seedEnvironment(h, {
      container: 'running',
      containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'devcontainer.metadata': JSON.stringify([{ containerUser: 'node' }]) },
      extra: { remoteUser: 'vscode' },
    });
    const old = h.docker.containersOf(ENV_ID)[0];
    h.docker.execHandler = (container, command, user) =>
      container === old.id && command[2] === 'exit 0' && user === 'node' ? { exitCode: 1, stderr: 'Error response from daemon: unable to find user node: no matching entries in passwd file' } : {};

    await rejection(h.service.open(TARGET, options()));

    expect(h.ui.prompts).toEqual([`recreateContainer ${REPO}`]);
  });

  it('review round 3 (F1): a container whose label names no user is not checked', async () => {
    h = createHarness();
    await seedEnvironment(h, { container: 'running' });
    const old = h.docker.containersOf(ENV_ID)[0];
    h.docker.execHandler = (container, command) => (container === old.id && command[2] === 'exit 0' ? { exitCode: 1, stderr: PASSWD_DAMAGED } : {});

    await h.service.open(TARGET, options());

    expect(h.docker.execs.filter((exec) => exec.command[2] === 'exit 0')).toEqual([]);
    expect(h.ui.prompts).toEqual([]);
  });
});

describe('recreate offer: failures that are not the fault of the container keep their messages', () => {
  it.each([
    ['a published port in use', 'Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:3000 failed: port is already allocated'],
    ['a bind mount source that is missing', 'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /home/me/data'],
    ['Docker that stopped answering', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'],
    ['the remote Docker host that cannot be reached', 'error during connect: ssh: connect to host build-box port 22: Connection timed out'],
    ['the network', 'dial tcp: lookup ghcr.io: no such host'],
    ['a damaged container whose text also names a lost connection', `${PASSWD_DAMAGED}\nerror during connect: unexpected EOF`],
  ])('%s: startFailed as before, no question', async (_name, stderr) => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.upError = () => upFailure(stderr);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(h.ui.prompts).toEqual([]);
    expect(ups()).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.log.filter((line) => line.startsWith('rm '))).toEqual([]);
    expectVolumesKept();
  });

  it('Docker does not answer after the failure: no question', async () => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.upError = () => {
      h.docker.running = false;
      return upFailure(PASSWD_DAMAGED);
    };

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(h.ui.prompts).toEqual([]);
  });

  it('a failed lifecycle command (the configuration, not the container): no question', async () => {
    h = createHarness();
    await seedEnvironment(h);
    const result: DevcontainerResult = { outcome: 'error', description: 'postStartCommand from devcontainer.json failed.', containerId: 'container-gone' };
    h.helper.userCommandsError = new DevcontainerCommandError('devcontainer run-user-commands', 1, `${JSON.stringify(result)}\n`, PASSWD_DAMAGED, result);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(h.ui.prompts).toEqual([]);
  });

  it('a refusal of the host access policy: hostAccess, no question', async () => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.upError = () => new UserFacingError('hostAccess', Messages.hostAccess('--privileged'), `Refused: ${PASSWD_DAMAGED}`);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('hostAccess');
    expect(h.ui.prompts).toEqual([]);
  });

  it('a cancelled open: cancelled, no question', async () => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.upError = () => abortError();

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('cancelled');
    expect(h.ui.prompts).toEqual([]);
  });

  it('an error that is not one of the Dev Container CLI (the helper or Docker failed around it): no question', async () => {
    h = createHarness();
    await seedEnvironment(h);
    h.helper.upError = () => new Error(PASSWD_DAMAGED);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(h.ui.prompts).toEqual([]);
  });

  it('without the environment image (a recreation would need a build): no question', async () => {
    h = createHarness();
    await seedEnvironment(h, { image: false });
    // Without the image, the update builds it; its failure falls back to the existing container, whose `up` fails.
    h.helper.buildError = () => new DevcontainerCommandError('devcontainer build', 1, '', 'failed to solve: dial tcp: lookup registry-1.docker.io: no such host');
    h.helper.upError = () => upFailure(PASSWD_DAMAGED);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(h.ui.prompts).toEqual([]);
    expect(h.logger.infos.some((line) => line.includes('cannot be created again without a build'))).toBe(true);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
  });

  it('a busy environment: no question, nothing started', async () => {
    h = createHarness();
    await seedEnvironment(h, { extra: { busy: { operation: 'update', since: new Date().toISOString(), pid: 999, windowId: 'window-2' } } });
    h.alivePids.add(999);
    failFirstUp(PASSWD_DAMAGED);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('startFailed');
    expect(error.message).toBe(PipelineTexts.environmentBusy(REPO));
    expect(h.ui.prompts).toEqual([]);
    expect(ups()).toEqual([]);
  });

  it('no sign-in (authentication): signInRequired, no question', async () => {
    h = createHarness();
    await seedEnvironment(h);
    failFirstUp(PASSWD_DAMAGED);
    h.token = undefined;

    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));

    expect(error.code).toBe('signInRequired');
    expect(h.ui.prompts).toEqual([]);
  });

  it('an environment of another Docker host: otherDockerHost, no question', async () => {
    h = createHarness({ dockerTarget: async () => ({ kind: 'remote', host: 'other-box', endpoint: 'ssh://other-box' }) });
    await seedEnvironment(h, { extra: { dockerHost: 'build-box' } });
    failFirstUp(PASSWD_DAMAGED);

    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));

    expect(error.code).toBe('otherDockerHost');
    expect(h.ui.prompts).toEqual([]);
  });

  it('Docker that cannot be started: its message, no question', async () => {
    h = createHarness();
    await seedEnvironment(h);
    failFirstUp(PASSWD_DAMAGED);
    h.dockerStartError = new UserFacingError('dockerStartFailed', Messages.dockerStartFailed);

    const error = await rejection(h.service.open(TARGET, options()));

    expect(error.code).toBe('dockerStartFailed');
    expect(h.ui.prompts).toEqual([]);
  });
});

describe('isContainerFault', () => {
  it.each([PASSWD_DAMAGED, SHELL_MISSING, MARKED_FOR_REMOVAL, SHELL_NOT_EXECUTABLE, 'unable to find group staff: no matching entries in group file'])(
    'names a damaged container: %s',
    (text) => {
      expect(isContainerFault(text)).toBe(true);
    },
  );

  it.each([
    '',
    'port is already allocated',
    'Error response from daemon: network 3f2a not found',
    'exec format error',
    'OCI runtime exec failed: exec failed: unable to start container process: exec: "git": executable file not found in $PATH',
    'Error response from daemon: error while creating mount source path \'/home/me/data\': mkdir /home/me: permission denied',
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    `${SHELL_MISSING}\nssh: connect to host build-box port 22: Connection refused`,
    `${PASSWD_DAMAGED}\nread tcp 10.0.0.2:52000->10.0.0.1:22: i/o timeout`,
  ])('names no damaged container: %s', (text) => {
    expect(isContainerFault(text)).toBe(false);
  });
});
