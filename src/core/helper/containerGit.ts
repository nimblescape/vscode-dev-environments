// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Container-only Git (concept section 9 "Git inside the container"): Git and Docker in a dev container use only the
// configuration in the workspace volume (CONFIG_FOLDER) and the token of the owner account, never the configuration or
// the credentials that the Dev Containers extension forwards from the computer. The global Dev Containers settings stay
// unchanged, so other dev containers of the user keep working. The forwarding is switched off per environment, only
// through settings of the Dev Containers extension (devContainersSettings in ../devContainers.ts: the settings are
// documented, but that the extension reads them per container from the label devcontainer.metadata is not) and the
// documented variables of Git, Docker, and the GitHub CLI (containerEnvironment). The variables of the Dev Containers
// extension and of the VS Code server (REMOTE_CONTAINERS_*, SSH_AUTH_SOCK, BROWSER, VSCODE_*) are never set or changed:
// they expect their own values (user decision 2026-09-25). Pure values and scripts, no I/O.
import { forwardingHelperReachesGit } from '../devContainers';
import { CONFIG_FOLDER, DOCKER_CONFIG_FOLDER, GH_CONFIG_FOLDER, GIT_CONFIG_FILE, GITHUB_TOKEN_FILE } from '../names';

/**
 * Git credential helper of the dev container (a shell snippet that Git runs with `sh`, see gitcredentials(7)). It
 * answers only `get` requests for https://github.com, with the token file of the owner account. It contains no `${`,
 * because the Dev Container CLI and the Dev Containers extension substitute `${…}` in the override configuration.
 */
export const CONTAINER_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; p=; h=; ' +
  'while IFS= read -r l; do case "$l" in protocol=https) p=1 ;; host=github.com) h=1 ;; esac; done; ' +
  `test -n "$p" && test -n "$h" && test -s ${GITHUB_TOKEN_FILE} || exit 0; ` +
  `printf 'username=x-access-token\\npassword=%s\\n' "$(cat ${GITHUB_TOKEN_FILE})"; }; f`;

/**
 * Credential helpers of the user for Git servers other than github.com (for example `store` for a server in the network
 * of the company), in the workspace volume. Git in the container includes this file after it removed every other
 * credential helper (containerEnvironment); the Dev Containers extension never writes it. A missing file is ignored.
 */
export const GIT_CREDENTIALS_CONFIG_FILE = `${CONFIG_FOLDER}/credentials.gitconfig`;

/** Content of a new GIT_CREDENTIALS_CONFIG_FILE (GIT_FILES_SCRIPT): only comments. */
export const GIT_CREDENTIALS_CONFIG_CONTENT = [
  '# Dev Environments: credential helpers for Git servers other than github.com, for example:',
  '#',
  '# [credential "https://gitlab.example.com"]',
  `# \thelper = store --file ${CONFIG_FOLDER}/git-credentials`,
  '#',
  '# Git in the container uses only the credential helpers of this file. Helpers in gitconfig, in .git/config, and of',
  '# git config --global are not used. github.com always uses the token of the account that owns the environment.',
  '',
].join('\n');

/**
 * The Git settings of the command line level of the container (GIT_CONFIG_COUNT), in this order: remove every credential
 * helper of the configuration files (among them a forwarding helper that the Dev Containers extension writes with
 * `git config --system` and `--global` when devContainersSettings do not apply, ../devContainers.ts), add the helpers of the user
 * (GIT_CREDENTIALS_CONFIG_FILE, an absolute path: Git refuses a relative include on the command line), and for
 * https://github.com remove them again and add the helper of the container. An empty helper removes the helpers before it
 * since Git 2.9.
 */
function commandLineGitConfig(): Array<[key: string, value: string]> {
  return [
    ['credential.helper', ''],
    ['include.path', GIT_CREDENTIALS_CONFIG_FILE],
    ['credential.https://github.com.helper', ''],
    ['credential.https://github.com.helper', CONTAINER_CREDENTIAL_HELPER],
  ];
}

/**
 * Environment variables of every process in the dev container (`containerEnv` of the override configuration: lifecycle
 * commands, `docker exec`, and the processes of the Dev Containers extension). Only documented variables of Git and
 * Docker, which change only where these tools read their configuration:
 * - GIT_CONFIG_GLOBAL: Git reads the global configuration from the volume, not ~/.gitconfig (Git 2.32 and newer; older
 *   Git reads ~/.gitconfig, which includes the configuration of the volume, see HOME_GIT_CONFIG_CONTENT).
 * - GIT_CONFIG_COUNT/KEY/VALUE (Git 2.31 and newer): the settings of commandLineGitConfig. Git applies the command line
 *   level after all files, so no credential request of any host reaches a forwarding helper of the computer, and no
 *   `store` or `erase` of the token either.
 * - DOCKER_CONFIG: the Docker CLI reads its configuration from the volume, not a credential store that the Dev
 *   Containers extension may write into ~/.docker/config.json.
 * - GIT_SSH_COMMAND: Git over SSH does not use the SSH agent (`IdentityAgent=none`, ssh_config(5)).
 * - GH_CONFIG_DIR: the GitHub CLI (gh) reads its configuration from the volume (GH_CONFIG_FOLDER), where GIT_FILES_SCRIPT
 *   signs it in with the account that owns the environment (its hosts.yml), not from ~/.config/gh of the image.
 * The token is never an environment variable (no GH_TOKEN, no GITHUB_TOKEN).
 * Assumption (V-8): Git of the Source Control view and of the integrated terminal runs with these variables (the VS Code
 * server gets containerEnv and remoteEnv), so `git push` uses the credential helper of the container.
 */
export function containerEnvironment(): Record<string, string> {
  const settings = commandLineGitConfig();
  const env: Record<string, string> = { GIT_CONFIG_GLOBAL: GIT_CONFIG_FILE, GIT_CONFIG_COUNT: String(settings.length) };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.DOCKER_CONFIG = DOCKER_CONFIG_FOLDER;
  env.GIT_SSH_COMMAND = 'ssh -o IdentityAgent=none';
  env.GH_CONFIG_DIR = GH_CONFIG_FOLDER;
  return env;
}

/**
 * Environment variables of the VS Code server and its terminals (`remoteEnv`): those of containerEnvironment, so that
 * they win over values that a shell profile of the image sets. Nothing else: the variables of the Dev Containers
 * extension and of the VS Code server (SSH_AUTH_SOCK, REMOTE_CONTAINERS_IPC, BROWSER, VSCODE_IPC_HOOK_CLI, …) keep the
 * values of their owners, so URLs of the container still open in the browser of the computer.
 * Assumption (V-8): the Dev Containers extension applies remoteEnv from the label devcontainer.metadata of the container
 * after the environment of the shell (remote-containers 0.470.0: `{...C,...f,…,...vW(…,r.remoteEnv||{})}`).
 */
export function remoteEnvironment(): Record<string, string> {
  return { ...containerEnvironment() };
}

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

/** user.name and user.email of the Git configuration of the container. */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * True for a GitHub login, the user of the sign-in of the GitHub CLI (GIT_FILES_SCRIPT checks the same): 1 to 39
 * letters, digits, and hyphens, starting with a letter or a digit (this also accepts old logins with two hyphens in a row
 * or one at the end). Such a value is safe in the double quotes of hosts.yml.
 */
export function isGitHubLogin(login: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login);
}

/** The account as the GitHub API names it: `viewer { databaseId login name }`. */
export interface GitHubViewer {
  databaseId: number | string;
  login: string;
  name?: string | null;
}

/**
 * The identity of the owner account, as GitHub uses it for commits in the browser: the profile name (or the login when
 * the profile has none), and the noreply address `<databaseId>+<login>@users.noreply.github.com`.
 */
export function gitIdentity(viewer: GitHubViewer): GitIdentity {
  const name = typeof viewer.name === 'string' && viewer.name.trim() !== '' ? viewer.name.trim() : viewer.login;
  return { name, email: `${viewer.databaseId}+${viewer.login}@users.noreply.github.com` };
}

/**
 * ~/.gitconfig of the remote user in a new container (HOME_GIT_CONFIG_SCRIPT). Git 2.32 and newer does not read it while
 * GIT_CONFIG_GLOBAL is set. Git older than 2.32, and a process without the variables of the container (for example after
 * `sudo` or `su -`), read it as the global configuration: the include gives them the configuration of the volume (the
 * identity, and the credential helper of the container for github.com), and the empty helper before it removes the
 * helpers of /etc/gitconfig for them. Git older than 2.31 reads no GIT_CONFIG_COUNT either, so it gets the credential
 * settings of the container only from this file.
 */
export const HOME_GIT_CONFIG_CONTENT = [
  '# Dev Environments: the Git configuration of this container is in ' + CONFIG_FOLDER + '.',
  '# Git reads it through this file when it is older than version 2.32 or runs without the variables of the container.',
  '[credential]',
  '\thelper =',
  '[include]',
  `\tpath = ${GIT_CREDENTIALS_CONFIG_FILE}`,
  `\tpath = ${GIT_CONFIG_FILE}`,
  '',
].join('\n');

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Runs as root in a new dev container, before the first attach (`$1` = the remote user): writes HOME_GIT_CONFIG_CONTENT
 * into ~/.gitconfig when the file does not exist (owned by the user) or is empty (it keeps its owner). A file of the
 * image with content, and a link, stay as they are. Works with GNU and BusyBox tools.
 */
export const HOME_GIT_CONFIG_SCRIPT = `set -eu
user="$1"
home=$(awk -F: -v u="$user" '$1 == u { print $6; exit }' /etc/passwd)
if [ -z "$home" ]; then
  uid=$(id -u "$user" 2>/dev/null) || uid=''
  if [ -n "$uid" ]; then home=$(awk -F: -v u="$uid" '$3 == u { print $6; exit }' /etc/passwd); fi
fi
if [ -z "$home" ] || [ ! -d "$home" ]; then
  echo "The user $user has no home folder."
  exit 0
fi
owner="$(id -u "$user"):$(id -g "$user")"
content=${shellQuote(HOME_GIT_CONFIG_CONTENT)}
gitconfig="$home/.gitconfig"
if [ ! -e "$gitconfig" ] && [ ! -L "$gitconfig" ]; then
  printf '%s' "$content" > "$gitconfig"
  chown "$owner" "$gitconfig"
elif [ -f "$gitconfig" ] && [ ! -L "$gitconfig" ] && [ ! -s "$gitconfig" ]; then
  printf '%s' "$content" > "$gitconfig"
fi
`;

/** Command for `docker exec -u root` in a new dev container: HOME_GIT_CONFIG_SCRIPT for `user`. */
export function homeGitConfigCommand(user: string): string[] {
  return ['sh', '-c', HOME_GIT_CONFIG_SCRIPT, 'sh', user];
}

/** Version of Git from the output of `git --version`, for example `git version 2.39.3 (Apple Git-146)`. */
export function parseGitVersion(output: string): [major: number, minor: number, patch: number] | undefined {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/m.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

/**
 * What Git of the container supports of container-only Git, from the output of `git --version` in the container
 * (`undefined` when there is no Git, or the output is not known):
 * - 'full': Git 2.32 and newer.
 * - 'noGlobalVariable': Git 2.9 to 2.31 ignores GIT_CONFIG_GLOBAL, and Git before 2.31 also GIT_CONFIG_COUNT: the
 *   configuration of the volume (the identity, and before Git 2.31 also the credential helper of the container) reaches
 *   Git only through the include in ~/.gitconfig (HOME_GIT_CONFIG_CONTENT), which is missing when the image has its own
 *   ~/.gitconfig with content.
 * - 'unsafe': before Git 2.9, an empty credential.helper does not remove the helpers before it, so a forwarding helper
 *   of the Dev Containers extension (when its settings of the container do not apply) answers requests of Git: with the
 *   credentials of the computer (forwardingHelperReachesGit, ../devContainers.ts).
 */
export function containerGitSupport(versionOutput: string): 'full' | 'noGlobalVariable' | 'unsafe' | undefined {
  const version = parseGitVersion(versionOutput);
  if (!version) return undefined;
  const [major, minor] = version;
  const atLeast = (m: number, n: number): boolean => major > m || (major === m && minor >= n);
  if (forwardingHelperReachesGit(major, minor)) return 'unsafe';
  if (!atLeast(2, 32)) return 'noGlobalVariable';
  return 'full';
}
