// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rules table of the container policy (concept section 9 "Host access"): what the policy refuses and in which class.
// Under the adopted trust model the policy is a guard rail on the final configuration of a container: a dev container
// may use the network, and nothing else of the computer.
//
// Classes (HostAccessClass, ./report.ts; the per-repository switch, ./hostAccessChecks.ts, lifts only `computer`):
// - computer:    access to the computer: bind mounts, the Docker socket, privileges and capabilities beyond
//                ALLOWED_CAPABILITIES, security options beyond seccomp=unconfined and no-new-privileges, devices, GPUs,
//                namespaces of the computer, ports on other addresses than localhost, volumes of other programs.
// - protected:   refused whatever the switch says: account separation (volumes, networks, and images of other
//                environments, the cache volume of the workspace helper), the protected paths below (the internal
//                folder, the token folder /run/devenv and /var/run/devenv, the Docker socket and the folders of the batch
//                helper with the socket and the token, the kernel folders), the identity of the owner account (the
//                variables of container-only Git and of the GitHub CLI), `initializeCommand`, and items whose class is
//                not clear.
// - unsupported: options that the policy does not know or does not support (unknown flags and keys, texts that cannot
//                be checked, a Dockerfile longer than MAX_DOCKERFILE_LENGTH); refused whatever the switch says.
// Where the rules are applied: ./flags.ts (the flags of `docker run` and `docker build`), ./single.ts (a single
// container), ./compose.ts (a Docker Compose model), ./volumes.ts (volumes and networks of other environments),
// ./images.ts (image references), ./rewrites.ts (what the policy changes in the final configuration). Pure, no I/O.
import * as path from 'path';
import {
  BATCH_SOCKET_FOLDER,
  CONFIG_FOLDER,
  CONTAINER_CONFIG_UNKNOWN_LABEL,
  CONTAINER_VERSION_LABEL,
  HELPER_CACHE_FOLDER,
  HELPER_DOCKER_SOCKET,
  HOST_ACCESS_UNRESTRICTED_LABEL,
  LABEL_PREFIX,
  SECRETS_FOLDER,
  TOKEN_FOLDER,
  WORKSPACES_ROOT,
} from '../names';
import { containerEnvironment } from '../helper/containerGit';
import { guarded, unsupported, type Problem } from './report';

// ---------------------------------------------------------------------------------------------------------------------
// Protected paths: the workspace helper, the internal folder, and the token folder

/** Whether `file` is `folder`, a path in it, or a folder that contains it. */
function overlaps(file: string, folder: string): boolean {
  return file === folder || file.startsWith(`${folder}/`) || folder.startsWith(`${file}/`);
}

/**
 * The folders of the kernel in the workspace helper (review round 3, S3-1): their links lead anywhere, for example
 * `/proc/self/root/devenv-cache` to the cache volume, and the check does not resolve links of a single container.
 */
export const KERNEL_FOLDERS: readonly string[] = ['/proc', '/sys', '/dev'];

/**
 * Follow-up of plan step 11I (the links of the owner): the folders of the batch helper that only root can enter, the
 * folder of the Docker socket (BATCH_SOCKET_FOLDER) and the tmpfs of the token of a step (SECRETS_FOLDER), also by the
 * link `/var/run` → `/run` of the helper image (as TOKEN_FOLDER_ALIAS in the dev container): a path there is checked as
 * written, without its links.
 */
export const BATCH_HELPER_FOLDERS: readonly string[] = [BATCH_SOCKET_FOLDER, SECRETS_FOLDER, `/var${BATCH_SOCKET_FOLDER}`, `/var${SECRETS_FOLDER}`];

/**
 * A path of the workspace helper that no build context, Dockerfile, or bind mount may name, whatever the switch of the
 * host access checks says (HostAccessClass `protected`): the root `/`; the cache volume that all environments share
 * (HELPER_CACHE_FOLDER); the internal folder (CONFIG_FOLDER: the Git and Docker configuration of the dev container);
 * the Docker socket, and the folders of the batch helper with the socket and the token (BATCH_HELPER_FOLDERS); the
 * folders of the kernel (KERNEL_FOLDERS, review round 3, S3-1); and every path below WORKSPACES_ROOT that is not in the
 * repository folder (the internal folder, other folders of the volume). A folder that contains one of them counts too
 * (for example `/var` with the socket, `/run` with the folders of the batch helper). `file` is absolute.
 *
 * Review round 1 of the follow-up of plan step 11I (A-F5): a path with a `..` segment counts too. The check reads the path
 * as text, but the helper resolves `..` after the links of its image: `/var/run/../devenv-cache` is /devenv-cache there
 * (/var/run → /run), `/var/lock/../devenv-secrets` is /run/devenv-secrets (/var/lock → /run/lock), while the text says
 * /var/devenv-cache and /var/devenv-secrets; any link of the image to a folder elsewhere does the same (Debian's
 * /usr/lib/ssl/certs → /etc/ssl/certs). Chosen over a map of the links of the image, which would have to list every such
 * link of every version of the image; without `..`, the text and the helper differ only at a link into a protected
 * folder, which the list names (BATCH_HELPER_FOLDERS by /var/run). The callers resolve relative paths before (no `..`
 * left); only a path that a configuration writes absolute with `..` (an option of `build.options`, a Compose path) is
 * refused, which it can write without.
 */
export function isHelperPath(file: string, repositoryFolder: string): boolean {
  if (file.split('/').includes('..')) return true;
  const normal = path.posix.normalize(file).replace(/(.)\/+$/, '$1');
  if (normal === '/') return true;
  if ([HELPER_CACHE_FOLDER, CONFIG_FOLDER, HELPER_DOCKER_SOCKET, ...BATCH_HELPER_FOLDERS, ...KERNEL_FOLDERS].some((helperPath) => overlaps(normal, helperPath))) return true;
  const inRepository = normal === repositoryFolder || normal.startsWith(`${repositoryFolder}/`);
  return !inRepository && overlaps(normal, WORKSPACES_ROOT);
}

/**
 * Review of unit 15 (T2): TOKEN_FOLDER by the link `/var/run` → `/run` that most images have. A mount there lands on the
 * tmpfs of the token (over it, or in it), so it is the same internal folder.
 */
export const TOKEN_FOLDER_ALIAS = `/var${TOKEN_FOLDER}`;

/** The folders of configFolderTarget. */
const INTERNAL_FOLDERS: readonly string[] = [CONFIG_FOLDER, TOKEN_FOLDER, TOKEN_FOLDER_ALIAS];

/** Review round 14 (S14-1): the reason of configFolderMountItem. */
export const CONFIG_FOLDER_MOUNT_REASON = "mounts into the extension's internal folder are not supported";

/**
 * Review round 14 (S14-1): the target of a mount of the dev container, normalized (`.`, `..`, double and trailing
 * slashes), when it is CONFIG_FOLDER or a path below it (on segment boundaries: `/workspaces/.devenv+x` is not), or
 * (unit 15) TOKEN_FOLDER or a path below it (`/run/devenv`, the tmpfs with the token, which only the override
 * configuration adds: a mount there would shadow the token or move it out of the memory of the container, for example
 * into a volume; `/run/devenvx` and the parent `/run` are not), also by its other name TOKEN_FOLDER_ALIAS
 * (`/var/run/devenv`, review of unit 15, T2; a clearer message only: the write of the token checks the mount that it
 * finds in the container, whatever path led there); `undefined` otherwise. The extension writes the token and the Git configuration there, and its ownership fix gives
 * every file there the remote user (`find -xdev`, no paths left out): a mount there would shadow them, and would give
 * the files of the mounted folder (for example the data of another service, or the whole repository through an alias)
 * to the remote user. Other paths of WORKSPACES_ROOT outside the repository (for example a cache volume at
 * `/workspaces/.cache`) are not concerned. Only absolute targets (Docker refuses others).
 */
export function configFolderTarget(target: string): string | undefined {
  if (!target.startsWith('/')) return undefined;
  const normal = path.posix.normalize(target).replace(/(.)\/+$/, '$1');
  return INTERNAL_FOLDERS.some((folder) => normal === folder || normal.startsWith(`${folder}/`)) ? normal : undefined;
}

/** Review of unit 15: a mount propagation (`-v …:rshared`, `bind-propagation=shared`) that shares a mount with the computer. */
export function isSharedPropagation(value: string): boolean {
  return /^r?shared$/i.test(value.trim());
}

/**
 * Review of unit 15: the target of a mount of the dev container, normalized, where a shared propagation (a peer of a
 * mount of the computer, isSharedPropagation) would bring the tmpfs of the token, which Docker mounts later below it,
 * to the computer: the root `/`, or a folder that contains TOKEN_FOLDER or TOKEN_FOLDER_ALIAS (`/run`, `/var`,
 * `/var/run`); `undefined` otherwise (TOKEN_FOLDER itself and the paths below it are configFolderTarget). Refused whatever
 * the switch says (class `protected`). The write of the token refuses such a mount in the container too.
 */
export function tokenPropagationTarget(target: string): string | undefined {
  if (!target.startsWith('/')) return undefined;
  const normal = path.posix.normalize(target).replace(/(.)\/+$/, '$1');
  if (normal === '/') return normal;
  return [TOKEN_FOLDER, TOKEN_FOLDER_ALIAS].some((folder) => folder.startsWith(`${normal}/`)) ? normal : undefined;
}

/** Review of unit 15: the item of a shared mount propagation at tokenPropagationTarget `target` (class `protected`). */
export function sharedPropagationItem(target: string): string {
  return `shared mount propagation at ${target} (it would bring the GitHub token in the memory of the container to the computer)`;
}

/** Review round 14 (S14-1): the item of a mount at configFolderTarget `target` (class `unsupported`). */
export function configFolderMountItem(target: string, what = 'mount at'): string {
  return `${what} ${target} (${CONFIG_FOLDER_MOUNT_REASON})`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Capabilities and security options

/**
 * Review round 22 (H22-3): the capabilities that Docker gives every container (its default set), which a hardened
 * configuration adds again after `cap_drop: [ALL]`, and SYS_PTRACE (for debuggers).
 */
const ALLOWED_CAPABILITIES: ReadonlySet<string> = new Set([
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'SETGID',
  'SETUID',
  'SETPCAP',
  'NET_BIND_SERVICE',
  'NET_RAW',
  'SYS_CHROOT',
  'MKNOD',
  'AUDIT_WRITE',
  'SETFCAP',
  'SYS_PTRACE',
]);

/**
 * `capAdd`, `--cap-add`, and `cap_add`: every capability except ALLOWED_CAPABILITIES (with or without `CAP_`, in any
 * case); `ALL` too.
 */
export function capabilityProblems(values: readonly unknown[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    const name = String(value).trim();
    if (ALLOWED_CAPABILITIES.has(name.toUpperCase().replace(/^CAP_/, ''))) continue;
    items.push(`capability ${name}`);
  }
  return items;
}

/** `securityOpt`, `--security-opt`, and `security_opt`: every option except seccomp=unconfined and no-new-privileges. */
export function securityOptionProblems(values: readonly unknown[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    const option = String(value).trim();
    // Without the seccomp filter (for debuggers); no-new-privileges only takes rights away, whatever its value.
    if (/^seccomp[=:]unconfined$/i.test(option)) continue;
    if (/^no-new-privileges([=:](true|false|1|0|t|f))?$/i.test(option)) continue;
    items.push(`security option ${option}`);
  }
  return items;
}

// ---------------------------------------------------------------------------------------------------------------------
// Labels

/** Label keys of the Dev Container CLI and the Dev Containers extension. */
const DEVCONTAINER_LABEL = /^devcontainer\./i;

/**
 * True for a label key by which Dev Environments, the Dev Container CLI, or the Dev Containers extension find and set
 * up containers, images, and volumes (compared without case and surrounding spaces): every key with LABEL_PREFIX (the
 * keys of EXTENSION_LABEL_KEYS and any later one), and every `devcontainer.…` key. Other keys are not theirs, also
 * `devenv.…` keys of other tools (for example `devenv.fingerprint`), so they cannot confuse the lookups and are
 * allowed.
 */
export function isReservedLabel(key: string): boolean {
  const trimmed = key.trim();
  return DEVCONTAINER_LABEL.test(trimmed) || trimmed.toLowerCase().startsWith(LABEL_PREFIX);
}

/** Label keys of Docker Compose, which finds the containers, networks, and volumes of a project by them. */
export const RESERVED_COMPOSE_LABEL = /^com\.docker\.compose\./i;

/**
 * The labels that the override configuration adds to runArgs itself, with their values. The merged configuration of an
 * existing container holds them too, also `nimblescape.devenv.host-access=unrestricted` of a container created while
 * the host access checks were off, which must not block the open that creates it again once they are on.
 */
export const OWN_LABELS: readonly string[] = [CONTAINER_VERSION_LABEL, CONTAINER_CONFIG_UNKNOWN_LABEL, HOST_ACCESS_UNRESTRICTED_LABEL];

// ---------------------------------------------------------------------------------------------------------------------
// Variables: container-only Git and the account of the GitHub CLI

/**
 * True for the name of an environment variable that a configuration may not set (host access policy, concept section 9
 * "Host access"): each variable of containerEnvironment (among them GH_CONFIG_DIR, so that no configuration moves the
 * GitHub CLI away from the sign-in of the owner account), and every other variable of the configuration of Git
 * (`GIT_CONFIG` and `GIT_CONFIG_*`, for example GIT_CONFIG_PARAMETERS, which Git applies after GIT_CONFIG_COUNT). In
 * `docker run`, a `-e` of runArgs comes after the containerEnv of the override configuration and replaces its value (a
 * `-e NAME` without a value removes it) for the main process of the container and `docker exec`. Compared without case
 * and surrounding spaces.
 */
export function isContainerGitVariable(name: string): boolean {
  const upper = name.trim().toUpperCase();
  return /^GIT_CONFIG(_|$)/.test(upper) || Object.keys(containerEnvironment()).includes(upper);
}

/**
 * The variables of the GitHub CLI that choose its account or host (gh help environment): gh uses a token in GH_TOKEN,
 * GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, or GITHUB_ENTERPRISE_TOKEN instead of the sign-in in GH_CONFIG_DIR, and GH_HOST
 * makes it use another host than github.com.
 */
export const GITHUB_CLI_ACCOUNT_VARIABLES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
];

/** Plain-language reason of the refusal of a variable of GITHUB_CLI_ACCOUNT_VARIABLES. */
export const GITHUB_CLI_ACCOUNT_REASON = 'the GitHub CLI would use it instead of the sign-in of the account that owns the environment';

/**
 * True for the name of a variable of GITHUB_CLI_ACCOUNT_VARIABLES, which a configuration may not set either (host access
 * policy, concept section 9 "Host access"; like isContainerGitVariable in containerEnv, remoteEnv, and `-e`/`--env` of
 * runArgs): the GitHub CLI in the container is signed in only as the account that owns the environment (GH_CONFIG_DIR),
 * and nothing else decides who is signed in (user decision 2026-09-26). Compared without case and surrounding spaces. A
 * variable that the Dockerfile of the image sets with ENV is not part of any configuration and is not refused.
 */
export function isGitHubCliAccountVariable(name: string): boolean {
  return GITHUB_CLI_ACCOUNT_VARIABLES.includes(name.trim().toUpperCase());
}

/** A space, a line break, or another control character in the name of a variable. */
const INVALID_VARIABLE_NAME = /[\s\p{Cc}]/u;

/**
 * The problem of a variable that a configuration may not set, or `undefined` when it may: a variable of container-only
 * Git (isContainerGitVariable), named alone, or a variable that chooses the account of the GitHub CLI
 * (isGitHubCliAccountVariable), with the reason (both `protected`); or a name with a space or a control character
 * (`unsupported`: Docker and the environment of a process would not read it as one name). The rules apply to the part of
 * `name` before the first `=`, without surrounding spaces: Docker passes a `containerEnv` key `GH_TOKEN=x` as
 * `GH_TOKEN=x=<value>`, which sets GH_TOKEN. `where` is `containerEnv`, `remoteEnv`, or `runArgs`.
 */
export function refusedVariable(name: string, where: string): Problem | undefined {
  const index = name.indexOf('=');
  const variable = (index < 0 ? name : name.slice(0, index)).trim();
  if (isContainerGitVariable(variable)) return guarded(`variable ${variable} in ${where}`);
  if (isGitHubCliAccountVariable(variable)) return guarded(`variable ${variable} in ${where} (${GITHUB_CLI_ACCOUNT_REASON})`);
  if (INVALID_VARIABLE_NAME.test(index < 0 ? name : name.slice(0, index))) {
    return unsupported(`variable ${JSON.stringify(name)} in ${where} (a name with a space or a control character)`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Values of flags and keys

/**
 * The longest `--stop-timeout`, in seconds. The Session Monitor ends each of its Docker calls after 30 seconds
 * (MONITOR_DOCKER_TIMEOUT_MS), also `docker stop`, which waits up to the stop timeout of the container before it kills
 * the processes of the container.
 */
export const MAX_STOP_TIMEOUT_SECONDS = 20;

/** The restart policies that may be used (restartProblems): `no` and `on-failure[:<count>]`. */
export const RESTART_POLICY = /^(no|on-failure(:\d+)?)$/;

/**
 * Log drivers that keep the log in files of the container, or keep none. Other drivers write to a socket or the journal
 * of the computer (syslog, journald, fluentd), or use credentials of Docker (awslogs, gcplogs).
 */
export const LOG_DRIVERS: readonly string[] = ['json-file', 'local', 'none'];

/**
 * Keys of `--log-opt`: the size and the rotation of the log files, the mode, and what an entry contains. The options of
 * other drivers name sockets, files, or servers, and apply when Docker uses such a driver by default.
 */
export const LOG_OPTIONS: readonly string[] = [
  'max-size',
  'max-file',
  'compress',
  'mode',
  'max-buffer-size',
  'labels',
  'labels-regex',
  'env',
  'env-regex',
  'tag',
];
