// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Names and labels (implementation notes 5).
import * as crypto from 'crypto';

export const LABEL_ENVIRONMENT_ID = 'devenv.environment-id';
export const LABEL_REPOSITORY = 'devenv.repository';
/** Volume label: the GitHub user ID of the account that created the environment (concept 7.5). */
export const LABEL_OWNER_ID = 'devenv.owner-id';
/**
 * Volume label of the additional volumes that the extension creates before `up` (the named volumes that a configuration
 * mounts), with the value VOLUME_KIND_ADDITIONAL. Such a volume also carries devenv.environment-id, devenv.owner-id,
 * and devenv.repository of its environment: only these labels make a volume the environment's own (isOwnVolume).
 */
export const LABEL_VOLUME = 'devenv.volume';
export const VOLUME_KIND_ADDITIONAL = 'additional';
/**
 * devenv.volume of a named volume of the Compose project of an environment (`devenv-<short id>_<key>`, the data of its
 * services, for example of a database): created by the extension before `up` with the labels of the environment, never
 * shared with another environment, and removed by Delete only when the user asks for it.
 */
export const VOLUME_KIND_COMPOSE = 'compose';
/**
 * Volume label (review round 2, D2-3), with the value SERVICE_DATA: a volume that the extension created before `up` for
 * a service of Docker Compose other than the dev service (it holds the data of that service, for example of a
 * database), whatever its devenv.volume. Delete lists such a volume in the question about the data of the services,
 * none ticked, also after a lost registry (reconcileFromVolumes restores Environment.serviceVolumes from it).
 */
export const LABEL_SERVICE_DATA = 'devenv.service-data';
export const SERVICE_DATA = 'true';
/**
 * Container label of the containers of a Compose environment other than the dev container: the name of their service.
 * They carry devenv.environment-id too, so Stop, the Session Monitor, and Delete find them; the lookup of the dev
 * container skips them.
 */
export const LABEL_COMPOSE_SERVICE = 'devenv.compose-service';
/** Container label: the version of the container setup (CONTAINER_VERSION). */
export const LABEL_CONTAINER_VERSION = 'devenv.container-version';
/**
 * Version of the container setup. 2: container-only Git (concept section 9). 3: the documented settings of the Dev
 * Containers extension for the container (no copy of the Git configuration of the computer, no forwarding credential
 * helpers, no sign-in of the GitHub CLI; devContainersSettings in devContainers.ts), which it reads from the label
 * devcontainer.metadata only at the first attach of a new container, and only the documented variables of Git and
 * Docker (no more GIT_CONFIG_PARAMETERS, GNUPGHOME, and SSH_AUTH_SOCK). 4: the GitHub CLI reads its configuration from the volume (GH_CONFIG_DIR, GH_CONFIG_FOLDER), where
 * it is signed in with the account that owns the environment. A container with an older version (or without the label) is
 * created again from its environment image.
 */
export const CONTAINER_VERSION = 4;
/**
 * Container label: `unknown` when the container was created without the configuration of the repository (it could not
 * be read), so without its runArgs and appPort. Such a container is created again once the configuration can be read.
 */
export const LABEL_CONTAINER_CONFIG = 'devenv.container-config';
export const CONTAINER_CONFIG_UNKNOWN = 'unknown';
/** `--label` value of the override configuration: the version of the container setup. */
export const CONTAINER_VERSION_LABEL = `${LABEL_CONTAINER_VERSION}=${CONTAINER_VERSION}`;
/** `--label` value of the override configuration of a container created without the configuration of the repository. */
export const CONTAINER_CONFIG_UNKNOWN_LABEL = `${LABEL_CONTAINER_CONFIG}=${CONTAINER_CONFIG_UNKNOWN}`;
/**
 * Container label of a container that was created while the host access checks were off for its repository (setting
 * devEnvLauncher.hostAccessChecksOff, concept section 9 "Host access"), with the value HOST_ACCESS_UNRESTRICTED. Once the
 * checks are on again, such a container is not current (containerIsCurrent): it is created again after the checks pass.
 */
export const LABEL_HOST_ACCESS = 'devenv.host-access';
export const HOST_ACCESS_UNRESTRICTED = 'unrestricted';
/** `--label` value of the override configuration of a container created while the host access checks were off. */
export const HOST_ACCESS_UNRESTRICTED_LABEL = `${LABEL_HOST_ACCESS}=${HOST_ACCESS_UNRESTRICTED}`;
/**
 * devenv.host-access of a container of Docker Compose that was created while the host access checks were on (review
 * round 2, D2-2): the model sets the label on every service explicitly, so that a label of the image (for example of a
 * side service that Compose builds during `up`) cannot decide it.
 */
export const HOST_ACCESS_CHECKED = 'checked';
/**
 * `--label` values of the override configuration of a single container (review round 2, D2-1): the labels by which Docker
 * Compose finds the containers of a project, with empty values, so that labels that the image inherited (for example of
 * an image that Compose built for another project) cannot make `docker compose -p <project> down` of the user remove the
 * dev container.
 */
export const COMPOSE_CLEARED_LABELS: readonly string[] = ['com.docker.compose.project=', 'com.docker.compose.service='];
export const LABEL_HELPER = 'devenv.helper';
export const LABEL_HELPER_RUN = 'devenv.helper-run';
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
/** The token of the owner account, mode 0600, owned by the owner of the repository folder. */
export const GITHUB_TOKEN_FILE = `${CONFIG_FOLDER}/github-token`;
/** DOCKER_CONFIG of the container. */
export const DOCKER_CONFIG_FOLDER = `${CONFIG_FOLDER}/docker`;
/** GH_CONFIG_DIR of the container: the configuration folder of the GitHub CLI (gh). */
export const GH_CONFIG_FOLDER = `${CONFIG_FOLDER}/gh`;
/**
 * The sign-in of the GitHub CLI: the account that owns the environment, with the token of GITHUB_TOKEN_FILE, mode 0600.
 * Written again at each open (GIT_FILES_SCRIPT); the other files of GH_CONFIG_FOLDER belong to the user.
 */
export const GH_HOSTS_FILE = `${GH_CONFIG_FOLDER}/hosts.yml`;

export function newEnvironmentId(): string {
  return crypto.randomUUID();
}

export function shortId(environmentId: string): string {
  return environmentId.slice(0, 8);
}

export function splitRepository(repository: string): { owner: string; name: string } {
  const index = repository.indexOf('/');
  if (index <= 0 || index === repository.length - 1) {
    throw new Error(`Invalid repository name: ${repository}`);
  }
  return { owner: repository.slice(0, index), name: repository.slice(index + 1) };
}

const MAX_NAME_LENGTH = 63;

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
}

/**
 * Name of the workspace volume and of the container: `devenv-<owner>-<repository>-<short id>`, lower case,
 * only `[a-z0-9_.-]`, at most 63 characters.
 */
export function resourceName(repository: string, environmentId: string): string {
  const { owner, name } = splitRepository(repository);
  const prefix = 'devenv-';
  const suffix = `-${sanitize(shortId(environmentId))}`;
  let middle = sanitize(`${owner}-${name}`);
  const room = MAX_NAME_LENGTH - prefix.length - suffix.length;
  if (middle.length > room) middle = middle.slice(0, room);
  middle = middle.replace(/[-_.]+$/, '');
  return `${prefix}${middle}${suffix}`;
}

/**
 * Name of the workspace volume of an environment, as resourceName builds it: `devenv-<owner>-<repository>-<short id>`, with
 * the first 8 hexadecimal characters of the environment ID at the end. Other volumes whose name starts with `devenv-` (for
 * example `devenv-tools-node_modules` of a repository `devenv-tools`) are volumes of the repository.
 */
export const ENVIRONMENT_VOLUME_PATTERN = /^devenv-[a-z0-9_.-]*-[0-9a-f]{8}$/i;

/** Repository part of the environment image name: `devenv-<short id>`. */
export function environmentImageRepository(environmentId: string): string {
  return `devenv-${sanitize(shortId(environmentId))}`;
}

/**
 * Compose project of an environment: `devenv-<short id>`, the same as environmentImageRepository. Stable for the life of
 * the environment (the Dev Container CLI finds the dev container again only by the project and the service) and unique
 * among the environments (short IDs are unique among the entries and the volumes).
 */
export function composeProjectName(environmentId: string): string {
  return environmentImageRepository(environmentId);
}

/** Environment image: `devenv-<short id>:<build number>`. */
export function environmentImageName(environmentId: string, buildNumber: number): string {
  return `${environmentImageRepository(environmentId)}:${buildNumber}`;
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
