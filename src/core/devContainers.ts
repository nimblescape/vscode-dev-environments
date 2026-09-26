// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Internal details of the Dev Containers extension (ms-vscode-remote.remote-containers) that Dev Environments relies on
// (NFR-06; checked in remote-containers 0.470.0 where noted, otherwise assumptions to verify in V-1, V-2, V-4, V-8).
// This module is the only place that knows them: every other module imports them from here. The one exception is the
// encoding of the authority (hex of JSON), which stays in the Connection Adapter (src/vscode/connection/authority.ts)
// and takes the literal ATTACHED_CONTAINER from here. When the Dev Containers extension changes, this module (and
// authority.ts) is what needs a look. Pure values and functions, no I/O, no `vscode` import.
//
// Also relied on, as a documented order rather than a value: the Dev Containers extension applies `remoteEnv` of the
// label devcontainer.metadata after the environment of the shell (V-8; containerGit.ts remoteEnvironment). Its own
// variables (REMOTE_CONTAINERS_IPC, REMOTE_CONTAINERS*, SSH_AUTH_SOCK, BROWSER) are never set or changed (user decision
// 2026-09-25).

// ---------------------------------------------------------------------------------------------------------------------
// Authority of attached containers

/**
 * Remote name of attached containers: `vscode.env.remoteName`, and the part of the authority before `+`.
 * Assumption (V-2): Dev Containers 0.470.0 names the authority of an attached container `attached-container+…`.
 */
export const ATTACHED_CONTAINER = 'attached-container';

/**
 * Activation event (package.json `activationEvents`) for the authority of attached containers.
 * Assumption (V-2): VS Code activates this extension for this authority of another extension's resolver, and waits for
 * activate() before it resolves the authority, so the open pipeline runs before a restored window connects.
 */
export const ATTACHED_CONTAINER_ACTIVATION_EVENT = `onResolveRemoteAuthority:${ATTACHED_CONTAINER}`;

// ---------------------------------------------------------------------------------------------------------------------
// Settings of the Dev Containers extension for one container

/**
 * Settings of the Dev Containers extension for this container (`customizations.vscode.settings` of the override
 * configuration), its settings `copyGitConfig`, `gitCredentialHelperConfigLocation`, `dockerCredentialHelper`, and
 * `githubCLILoginWithToken` (documented as settings of the user): it copies no Git configuration of the computer,
 * configures no forwarding credential helper for Git (`git config --system` and `--global`) or Docker (`credsStore` and
 * `/usr/local/bin/docker-credential-dev-containers-*`), and signs in no GitHub CLI with the token of the computer. This is
 * the only way the extension switches features of the Dev Containers extension off. The global settings of the user stay
 * unchanged. Flat keys, as the extension reads them (remote-containers 0.470.0, extension.js, class kv, kept literally):
 * `getConfiguration(t){return this.settings[ms(t)]||this.settings[wl(t)]}getNewConfiguration(t){return this.settings[ms(t)]}`
 * with `ms(e)` = `dev.containers.${e}` and `wl(e)` = `remote.containers.${e}`. So `copyGitConfig` needs both keys: a
 * false under the new key alone falls through to the old key (for example a `true` of the repository);
 * `dockerCredentialHelper` and `githubCLILoginWithToken` are read only under the new key. The values of the override
 * configuration win over those of the repository, the Features, and the image, because its entry of the label
 * devcontainer.metadata is the last one.
 * Assumption (V-8): at the first attach of a new container, the Dev Containers extension writes these settings into
 * ~/.vscode-server/data/Machine/settings.json of the container and reads them from there at each attach (verified in its
 * code, not documented; so CONTAINER_VERSION changes when they change). A process in the container can change that file;
 * the variables of containerEnvironment keep Git and Docker on the configuration of the volume also then.
 */
export function devContainersSettings(): Record<string, boolean | string> {
  return {
    'dev.containers.copyGitConfig': false,
    'remote.containers.copyGitConfig': false,
    'dev.containers.gitCredentialHelperConfigLocation': 'none',
    'dev.containers.dockerCredentialHelper': false,
    'dev.containers.githubCLILoginWithToken': false,
  };
}

/**
 * `shutdownAction` of the override configuration.
 * Assumption (V-4): this value replaces shutdownAction of the image metadata (the override configuration is the last
 * entry of the label), so the Dev Containers extension never stops an attached container; the Session Monitor alone
 * stops containers on close.
 */
export const ATTACHED_SHUTDOWN_ACTION = 'none';

/**
 * Argument of `devcontainer up`: `up` does not run `postAttachCommand`.
 * Assumption (V-1): the Dev Containers extension runs `postAttachCommand` of the label when it attaches, so the command
 * runs once per attach.
 */
export const SKIP_POST_ATTACH_ARG = '--skip-post-attach';

// ---------------------------------------------------------------------------------------------------------------------
// Machine settings of the container reach the window

/** The VS Code setting that decides on which addresses of the computer forwarded ports listen. */
export const LOCAL_PORT_HOST_SETTING = 'remote.localPortHost';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The values of `remote.localPortHost` other than `localhost` in the VS Code settings of a configuration
 * (`customizations.vscode.settings`: one object per entry, a list of them in the merged configuration; flat or nested
 * keys), in order. The Dev Containers extension writes these settings into the machine settings of the container, and
 * the window applies them: with any value other than `localhost`, VS Code forwards the ports of the container on all
 * addresses of the computer (VS Code 1.139, tunnel service: `!e||e==="localhost"?"127.0.0.1":"0.0.0.0"`), not only on
 * localhost. The setting of the user stays the user's choice.
 */
export function exposingLocalPortHostValues(customizations: unknown): unknown[] {
  const vscode = isRecord(customizations) ? customizations.vscode : undefined;
  const values: unknown[] = [];
  for (const entry of Array.isArray(vscode) ? vscode : [vscode]) {
    const settings = isRecord(entry) && isRecord(entry.settings) ? entry.settings : undefined;
    if (!settings) continue;
    const nested = isRecord(settings.remote) ? settings.remote.localPortHost : undefined;
    for (const value of [settings[LOCAL_PORT_HOST_SETTING], nested]) {
      if (value && value !== 'localhost') values.push(value);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------------------------------------------------
// Volumes of the Dev Containers extension

/**
 * The volumes of the Dev Containers extension (remote-containers 0.470.0, extension.js) by their names alone: `vscode`,
 * its cache of VS Code Server for the dev containers that it creates, and `vsc-remote-containers`, its proposal for a
 * named volume of "Clone Repository in Container Volume". A container with such a volume could change the VS Code
 * Server or the repositories of the other dev containers of the user.
 */
export const DEV_CONTAINERS_VOLUMES: readonly string[] = ['vscode', 'vsc-remote-containers'];

/**
 * The other names of the clone volumes of the Dev Containers extension end in a hexadecimal MD5 or SHA-256 hash
 * (`vsc-<repository>-<md5>`, `<repository>-<md5>`, `<repository>-<sha256>`). A repository may use such a name too, so
 * the name alone does not decide (the host access policy refuses such a volume only when it exists and is not the
 * environment's own).
 */
export function isDevContainersCloneVolumeName(name: string): boolean {
  return /-([0-9a-f]{32}|[0-9a-f]{64})$/.test(name);
}

/**
 * True when the label keys of a volume mark it as a volume of the Dev Containers extension: `vsch.*` (its clones of
 * repositories) or `dev.container.volume`.
 */
export function hasDevContainersVolumeLabel(labels: Readonly<Record<string, string>>): boolean {
  return Object.keys(labels).some((key) => key.startsWith('vsch.') || key === 'dev.container.volume');
}

// ---------------------------------------------------------------------------------------------------------------------
// Forwarding Git credential helper

/**
 * True when Git of this version would still use a forwarding credential helper of the Dev Containers extension. The
 * extension writes one with `git config --system` and `--global` when its settings of the container
 * (devContainersSettings) do not apply (remote-containers 0.470.0). The command line level of the container removes it
 * with an empty `credential.helper`, which removes the helpers before it only since Git 2.9: older Git sends its
 * credential requests on to the computer.
 */
export function forwardingHelperReachesGit(major: number, minor: number): boolean {
  return major < 2 || (major === 2 && minor < 9);
}
