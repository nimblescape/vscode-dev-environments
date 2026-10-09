// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Names and labels (implementation notes 5).
import * as crypto from 'crypto';
import { namePair, trailingPair } from './namePairs';
import { LABEL_MONITOR_CREATE, LABEL_SESSION_MONITOR } from './remoteMonitor/protocol';

/**
 * Labels of the helper channel (src/core/helperChannel/protocol.ts re-exports them). Here, not there, so that the script
 * of the remote Session Monitor, which imports names.ts, does not bundle the protocol of the channel (PR #57: its script
 * has to fit on the command line of `docker run`).
 */
/** Label of the container of a channel (its value: channelLabelValue). */
export const LABEL_HELPER_CHANNEL = 'nimblescape.devenv.helper-channel';
/** Label of a container that a `docker` operation of a channel starts (its value: the cleanup label). */
export const LABEL_CHANNEL_STEP = 'nimblescape.devenv.channel-step';

/**
 * The prefix of every label key of the extension (EXTENSION_LABEL_KEYS), with the name of its publisher: other tools
 * use `devenv.…` too (for example `devenv.fingerprint` of an image tool named devenv), so that prefix alone could
 * collide with their labels.
 */
export const LABEL_PREFIX = 'nimblescape.devenv.';

export const LABEL_ENVIRONMENT_ID = 'nimblescape.devenv.environment-id';

/**
 * The `--id-label` of every run of the Dev Container CLI for the environment `environmentId` (read-configuration and
 * `up`): the CLI computes `${devcontainerId}` from it (environmentDevcontainerId in ./helper/cliVariables.ts).
 */
export function environmentIdLabel(environmentId: string): string {
  return `${LABEL_ENVIRONMENT_ID}=${environmentId}`;
}
export const LABEL_REPOSITORY = 'nimblescape.devenv.repository';
/** Volume label: the GitHub user ID of the account that created the environment (concept 7.5). */
export const LABEL_OWNER_ID = 'nimblescape.devenv.owner-id';
/**
 * Volume label of the additional volumes that the extension creates before `up` (the named volumes that a configuration
 * mounts), with the value VOLUME_KIND_ADDITIONAL. Such a volume also carries nimblescape.devenv.environment-id,
 * nimblescape.devenv.owner-id, and nimblescape.devenv.repository of its environment: only these labels make a volume
 * the environment's own (isOwnVolume).
 */
export const LABEL_VOLUME = 'nimblescape.devenv.volume';
export const VOLUME_KIND_ADDITIONAL = 'additional';
/**
 * nimblescape.devenv.volume of a named volume of the Compose project of an environment (`<project>_<key>`, composeProjectName, the
 * data of its services, for example of a database): created by the extension before `up` with the labels of the
 * environment, never shared with another environment, and removed by Delete only when the user asks for it.
 */
export const VOLUME_KIND_COMPOSE = 'compose';
/**
 * Volume label (review round 2, D2-3), with the value SERVICE_DATA: a volume that the extension created before `up` for
 * a service of Docker Compose other than the dev service (it holds the data of that service, for example of a
 * database), whatever its nimblescape.devenv.volume. Delete lists such a volume in the question about the data of the
 * services, none ticked, also after a lost registry (reconcileFromVolumes restores Environment.serviceVolumes from it).
 */
export const LABEL_SERVICE_DATA = 'nimblescape.devenv.service-data';
export const SERVICE_DATA = 'true';
/**
 * Container label of the containers of a Compose environment other than the dev container: the name of their service.
 * They carry nimblescape.devenv.environment-id too, so Stop, the Session Monitor, and Delete find them; the lookup of
 * the dev container skips them.
 */
export const LABEL_COMPOSE_SERVICE = 'nimblescape.devenv.compose-service';
/** Container label: the version of the container setup (CONTAINER_VERSION). */
export const LABEL_CONTAINER_VERSION = 'nimblescape.devenv.container-version';
/**
 * Version of the container setup. A container without the label, or with an older value, is not current
 * (containerIsCurrent): it is created again from its environment image, and the volume stays. Raise it when a change of
 * the setup needs existing containers to be created again.
 */
export const CONTAINER_VERSION = 1;
/**
 * Container label: `unknown` when the container was created without the configuration of the repository (it could not
 * be read), so without its runArgs and appPort. Such a container is created again once the configuration can be read.
 */
export const LABEL_CONTAINER_CONFIG = 'nimblescape.devenv.container-config';
export const CONTAINER_CONFIG_UNKNOWN = 'unknown';
/**
 * Container label (review round 4, D4-2): the path of the configuration of the repository that the container was
 * created for (Environment.configPath, for example `.devcontainer/python/devcontainer.json`), on the dev container that
 * `up` creates (a single container, or the dev service of Docker Compose; review round 5, D5-1: not the other services),
 * when isConfigPathLabelValue takes the path (D5-2). reconcileFromVolumes restores the configuration path of an entry
 * from it after a lost registry; without it, the entry gets the default configuration.
 */
export const LABEL_CONFIG_PATH = 'nimblescape.devenv.config-path';
/** `--label` value of the override configuration of a single container: LABEL_CONFIG_PATH with its value. */
export function configPathLabel(configPath: string): string {
  return `${LABEL_CONFIG_PATH}=${configPath}`;
}
/**
 * Whether a value of LABEL_CONFIG_PATH is a configuration path of a repository as the discovery finds them: relative,
 * `.devcontainer/devcontainer.json`, `.devcontainer/<folder>/devcontainer.json`, or `.devcontainer.json`. Review round 5
 * (D5-2): the folder as the discovery takes it (isValidFolderName of detect.ts): not empty, not `.` or `..`, without
 * `/`; a backslash and white space are allowed.
 */
export function isConfigPathLabelValue(value: string): boolean {
  if (value === '.devcontainer.json' || value === '.devcontainer/devcontainer.json') return true;
  const match = /^\.devcontainer\/([^/]+)\/devcontainer\.json$/.exec(value);
  return match !== null && match[1] !== '.' && match[1] !== '..';
}
/** `--label` value of the override configuration: the version of the container setup. */
export const CONTAINER_VERSION_LABEL = `${LABEL_CONTAINER_VERSION}=${CONTAINER_VERSION}`;
/** `--label` value of the override configuration of a container created without the configuration of the repository. */
export const CONTAINER_CONFIG_UNKNOWN_LABEL = `${LABEL_CONTAINER_CONFIG}=${CONTAINER_CONFIG_UNKNOWN}`;
/**
 * Container label of a container that was created while the host access checks were off for its repository (setting
 * devEnvLauncher.hostAccessChecksOff, concept section 9 "Host access"), with the value HOST_ACCESS_UNRESTRICTED. Once the
 * checks are on again, such a container is not current (containerIsCurrent): it is created again after the checks pass.
 */
export const LABEL_HOST_ACCESS = 'nimblescape.devenv.host-access';
export const HOST_ACCESS_UNRESTRICTED = 'unrestricted';
/** `--label` value of the override configuration of a container created while the host access checks were off. */
export const HOST_ACCESS_UNRESTRICTED_LABEL = `${LABEL_HOST_ACCESS}=${HOST_ACCESS_UNRESTRICTED}`;
/**
 * nimblescape.devenv.host-access of a container of Docker Compose that was created while the host access checks were on
 * (review round 2, D2-2): the model sets the label on every service explicitly, so that a label of the image (for
 * example of a side service that Compose builds during `up`) cannot decide it.
 */
export const HOST_ACCESS_CHECKED = 'checked';
/**
 * Label that Docker Compose gives each container, network, and volume of a project. Plan step 11I (PR D, audit D5): the
 * one definition (the pipeline, the worker's Docker and the host access policy read it).
 */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
/**
 * `--label` values of the override configuration of a single container (review round 2, D2-1): the labels by which Docker
 * Compose finds the containers of a project, with empty values, so that labels that the image inherited (for example of
 * an image that Compose built for another project) cannot make `docker compose -p <project> down` of the user remove the
 * dev container.
 */
export const COMPOSE_CLEARED_LABELS: readonly string[] = ['com.docker.compose.project=', 'com.docker.compose.service='];
export const LABEL_HELPER = 'nimblescape.devenv.helper';
export const LABEL_HELPER_RUN = 'nimblescape.devenv.helper-run';
/**
 * Review round 4 of PR #64 (R4-2/R4-3): a label with a random nonce per build of BootstrapDocker.buildImage, by which it
 * finds the ID of the image that the build made (`docker image ls --filter label=…`).
 */
export const LABEL_BUILD_ID = 'nimblescape.devenv.build-id';
/**
 * User decisions 2026-10-03: a label of the environment image (EngineDocker.labelImage, after each build), with the
 * build record of that image as JSON, next to nimblescape.devenv.environment-id, nimblescape.devenv.repository, and
 * nimblescape.devenv.owner-id. The open of an environment that another computer created, or of one restored after a lost
 * registry, takes the record from its newest image (imageBuildRecord), so its image check works as on the first computer.
 */
export const LABEL_BUILD_RECORD = 'nimblescape.devenv.build-record';
/**
 * Every label key that the extension reads or writes (on containers, images, and volumes), each with LABEL_PREFIX, in
 * lower case. The host access policy refuses every key with LABEL_PREFIX in a configuration and on images
 * (isReservedLabel in ./policy/rules.ts), these and any later one: such a label would hide a container or volume from
 * the lookups of the extension, or make it look like one of another environment. A test (names.test.ts) fails for a
 * label with LABEL_PREFIX in the code of src that is not in this set, and for a `devenv.…` label there.
 */
export const EXTENSION_LABEL_KEYS: ReadonlySet<string> = new Set([
  LABEL_ENVIRONMENT_ID,
  LABEL_REPOSITORY,
  LABEL_OWNER_ID,
  LABEL_VOLUME,
  LABEL_SERVICE_DATA,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_CONTAINER_CONFIG,
  LABEL_CONFIG_PATH,
  LABEL_HOST_ACCESS,
  LABEL_HELPER,
  LABEL_HELPER_RUN,
  LABEL_BUILD_ID,
  LABEL_BUILD_RECORD,
  LABEL_SESSION_MONITOR,
  LABEL_MONITOR_CREATE,
  LABEL_HELPER_CHANNEL,
  LABEL_CHANNEL_STEP,
]);
export const HELPER_CACHE_VOLUME = 'devenv-helper-cache';
/** Mount point of the cache volume HELPER_CACHE_VOLUME in the workspace helper (`--user-data-folder` of the CLI). */
export const HELPER_CACHE_FOLDER = '/devenv-cache';
/** Path of the Docker socket inside the workspace helper. */
export const HELPER_DOCKER_SOCKET = '/var/run/docker.sock';
/** Mount point of the workspace volume, in the helper and in the dev container. */
export const WORKSPACES_ROOT = '/workspaces';
/**
 * Folder of the container's own Git and Docker configuration in the workspace volume (concept section 9). A repository
 * name only has `[A-Za-z0-9._-]`, so no repository folder `/workspaces/<name>` can have this name.
 */
export const CONFIG_FOLDER = `${WORKSPACES_ROOT}/.devenv+`;
/** The global Git configuration of the container (GIT_CONFIG_GLOBAL). */
export const GIT_CONFIG_FILE = `${CONFIG_FOLDER}/gitconfig`;
/**
 * Unit 15: the folder of the token of the owner account in the dev container, a tmpfs (TOKEN_TMPFS) that the override
 * configuration adds (single container: runArgs; Docker Compose: `tmpfs` of the dev service in the up model). It is in
 * memory only: its files are gone when the container stops, and they are never in the workspace volume
 * (the kernel may swap the tmpfs to the swap space of the computer or the Docker VM). The extension
 * writes it after each start of an open (TOKEN_WRITE_SCRIPT), owned by the remote user, mode 0700. No configuration of a
 * repository may mount anything at or below it (configFolderTarget).
 */
export const TOKEN_FOLDER = '/run/devenv';
/**
 * The `--tmpfs` value (and the entry of `tmpfs` of the dev service of Docker Compose) of TOKEN_FOLDER: 1 MiB, no programs,
 * no devices, no set-user-ID, only root may enter until the extension gives the folder to the remote user.
 */
export const TOKEN_TMPFS = `${TOKEN_FOLDER}:rw,nosuid,nodev,noexec,size=1m,mode=0700`;
/** The token of the owner account, mode 0600, owned by the remote user (unit 15: in TOKEN_FOLDER, not in the volume). */
export const GITHUB_TOKEN_FILE = `${TOKEN_FOLDER}/github-token`;
/** DOCKER_CONFIG of the container. */
export const DOCKER_CONFIG_FOLDER = `${CONFIG_FOLDER}/docker`;
/**
 * GH_CONFIG_DIR of the container: the configuration folder of the GitHub CLI (gh), in TOKEN_FOLDER (unit 15), because gh
 * reads its sign-in (hosts.yml) from this folder. Its other file, config.yml (no secret: gh writes the accounts and their
 * tokens only to hosts.yml), is a link to GH_VOLUME_CONFIG_FILE, so the settings of the user survive a stop.
 */
export const GH_CONFIG_FOLDER = `${TOKEN_FOLDER}/gh`;
/**
 * The sign-in of the GitHub CLI: the account that owns the environment, with the token of GITHUB_TOKEN_FILE, mode 0600.
 * Written again at each open (TOKEN_WRITE_SCRIPT).
 */
export const GH_HOSTS_FILE = `${GH_CONFIG_FOLDER}/hosts.yml`;
/** The folder of the GitHub CLI in the volume (unit 15: only for config.yml, the settings of gh without a secret). */
export const GH_VOLUME_FOLDER = `${CONFIG_FOLDER}/gh`;
/** gh's config.yml in the volume; GH_CONFIG_FOLDER/config.yml is a link to it. */
export const GH_VOLUME_CONFIG_FILE = `${GH_VOLUME_FOLDER}/config.yml`;

export function newEnvironmentId(): string {
  return crypto.randomUUID();
}

export function splitRepository(repository: string): { owner: string; name: string } {
  const index = repository.indexOf('/');
  if (index <= 0 || index === repository.length - 1) {
    throw new Error(`Invalid repository name: ${repository}`);
  }
  return { owner: repository.slice(0, index), name: repository.slice(index + 1) };
}

const MAX_NAME_LENGTH = 63;

/**
 * Name of everything of an environment (user decisions 2026-10-03): the workspace volume, the dev container, the
 * repository of the environment image, and the Docker Compose project (so also the names that Compose derives from it):
 * `devenv-<owner>-<repository>-<adjective>-<scientist>`, with the pair of the environment ID (namePair). Lower case,
 * every run of other characters than `[a-z0-9]` as one `-` (an image repository and a Compose project allow no `.` or
 * `_` next to each other), at most 63 characters: a long `<owner>-<repository>` is shortened, the pair is always kept.
 * The full environment ID is only in the labels.
 */
export function resourceName(repository: string, environmentId: string): string {
  const { owner, name } = splitRepository(repository);
  const prefix = 'devenv-';
  const suffix = `-${namePair(environmentId)}`;
  let middle = `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');
  const room = MAX_NAME_LENGTH - prefix.length - suffix.length;
  if (middle.length > room) middle = middle.slice(0, room);
  middle = middle.replace(/-+$/, '');
  return `${prefix}${middle === '' ? 'x' : middle}${suffix}`;
}

/**
 * Whether `name` has the shape of a name of an environment (resourceName): `devenv-<…>-<adjective>-<scientist>`, in any
 * case. Other names that start with `devenv-` (for example `devenv-tools-node_modules` of a repository `devenv-tools`)
 * are names of the repository.
 */
export function isEnvironmentResourceName(name: string): boolean {
  const lower = name.toLowerCase();
  return /^devenv-[a-z0-9-]+$/.test(lower) && trailingPair(lower) !== undefined;
}

/** Repository part of the environment image name: resourceName. */
export function environmentImageRepository(repository: string, environmentId: string): string {
  return resourceName(repository, environmentId);
}

/**
 * Compose project of an environment: resourceName. Stable for the life of the environment (the Dev Container CLI finds
 * the dev container again only by the project and the service) and unique among the environments on a Docker engine
 * (unusedEnvironmentId).
 */
export function composeProjectName(repository: string, environmentId: string): string {
  return resourceName(repository, environmentId);
}

/** Environment image: `<resourceName>:<build number>`. */
export function environmentImageName(repository: string, environmentId: string, buildNumber: number): string {
  return `${environmentImageRepository(repository, environmentId)}:${buildNumber}`;
}

/** Folder of the repository in the workspace volume, for example `/workspaces/api`. */
export function repositoryFolder(repository: string): string {
  return `${WORKSPACES_ROOT}/${splitRepository(repository).name}`;
}

/**
 * Name of a configuration (concept 6.2): the sub-folder, for example `python` for
 * `.devcontainer/python/devcontainer.json`, or `default` for `.devcontainer/devcontainer.json` and `.devcontainer.json`.
 */
export function configurationName(configPath: string): string {
  const match = /^\.devcontainer\/([^/]+)\/devcontainer\.json$/.exec(configPath);
  return match ? match[1] : 'default';
}

/** Folder of the configuration file, relative to the repository root. `.` for `.devcontainer.json`. */
export function configurationFolder(configPath: string): string {
  const index = configPath.lastIndexOf('/');
  return index < 0 ? '.' : configPath.slice(0, index);
}

/**
 * The host name of the container of a repository (`--hostname`, the name that the shell prompt shows instead of the
 * container ID): the repository name in lowercase, each run of characters other than letters, digits, and `-` as one
 * `-`, without `-` at the ends, at most 63 characters (one DNS label). `devenv` when nothing is left.
 */
export function containerHostname(repositoryName: string): string {
  const label = repositoryName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return label === '' ? 'devenv' : label;
}

/** tmpfs mount of the helper for the token (only for runs with `secrets: true`). Plan step 11F2: from helper/scripts.ts. */
export const SECRETS_FOLDER = '/run/devenv-secrets';
/**
 * Q2 of 2026-10-01: the folder of the batch helper in which the Docker socket is mounted, which only root can enter (the
 * image creates it 0700; the helper checks it), so the Git user of the helper cannot reach it. The helper links
 * /var/run/docker.sock to it for its root steps (the default of the Docker CLI and the Dev Container CLI; DOCKER_HOST is
 * never set). Follow-up of plan step 11I (the links of the owner): moved from helperChannel/batch.ts, so that the host
 * access policy names it too (isHelperPath).
 */
export const BATCH_SOCKET_FOLDER = '/run/devenv-docker';
