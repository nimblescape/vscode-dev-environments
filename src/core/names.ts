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
/** Container label: the version of the container setup (CONTAINER_VERSION). */
export const LABEL_CONTAINER_VERSION = 'devenv.container-version';
/**
 * Version of the container setup. 2: container-only Git (concept section 9). 3: the documented settings of the Dev
 * Containers extension for the container (no copy of the Git configuration of the computer, no forwarding credential
 * helpers, no sign-in of the GitHub CLI), which it reads from the label devcontainer.metadata only at the first attach of
 * a new container, and only the documented variables of Git and Docker (no more GIT_CONFIG_PARAMETERS, GNUPGHOME, and
 * SSH_AUTH_SOCK). 4: the GitHub CLI reads its configuration from the volume (GH_CONFIG_DIR, GH_CONFIG_FOLDER), where
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
export const LABEL_HELPER = 'devenv.helper';
export const LABEL_HELPER_RUN = 'devenv.helper-run';
export const HELPER_CACHE_VOLUME = 'devenv-helper-cache';
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
