// Names and labels (implementation notes 5).
import * as crypto from 'crypto';

export const LABEL_ENVIRONMENT_ID = 'devenv.environment-id';
export const LABEL_REPOSITORY = 'devenv.repository';
export const LABEL_HELPER = 'devenv.helper';
export const LABEL_HELPER_RUN = 'devenv.helper-run';
export const HELPER_CACHE_VOLUME = 'devenv-helper-cache';
/** Mount point of the workspace volume, in the helper and in the dev container. */
export const WORKSPACES_ROOT = '/workspaces';

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
