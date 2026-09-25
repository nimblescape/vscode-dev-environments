// Container-only Git (concept section 9 "Git inside the container"): Git, Docker, and GPG in a dev container use only
// the configuration in the workspace volume (CONFIG_FOLDER) and the token of the owner account, never the configuration,
// the credential helpers, or the agents that the Dev Containers extension forwards from the computer. The global Dev
// Containers settings stay unchanged, so other dev containers of the user keep working: the forwarding is switched off per
// environment, with environment variables of the container. Pure values and scripts, no I/O.
import { CONFIG_FOLDER, DOCKER_CONFIG_FOLDER, GIT_CONFIG_FILE, GITHUB_TOKEN_FILE, GNUPG_FOLDER } from '../names';

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
 * The Git settings of the command line level of the container, in this order: remove every credential helper of the
 * configuration files (among them the forwarding helper that the Dev Containers extension writes with
 * `git config --system` and `--global`, also into GIT_CONFIG_GLOBAL), add the helpers of the user
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

/** One entry of GIT_CONFIG_PARAMETERS: in single quotes, with `'` and `!` outside of them, as Git's sq_quote writes it. */
function gitConfigParameter(key: string, value: string): string {
  return `'${`${key}=${value}`.replace(/'/g, "'\\''").replace(/!/g, "'\\!'")}'`;
}

/**
 * Environment variables of every process in the dev container (`containerEnv` of the override configuration: lifecycle
 * commands, `docker exec`, and the processes of the Dev Containers extension):
 * - GIT_CONFIG_GLOBAL: Git reads the global configuration from the volume, not ~/.gitconfig (Git 2.32 and newer; older
 *   Git reads ~/.gitconfig, which includes the configuration of the volume, see HOME_GIT_CONFIG_CONTENT).
 * - GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT/KEY/VALUE: the settings of commandLineGitConfig, twice with the same
 *   entries. Git applies the command line level after all files, so no credential request of any host reaches the
 *   forwarding helper of the computer, and no `store` or `erase` of the token either. GIT_CONFIG_PARAMETERS is what
 *   `git -c` passes on to other Git processes; every Git version reads it (Git 1.7.10 and newer, with the include).
 *   GIT_CONFIG_COUNT (Git 2.31 and newer) keeps the settings for programs that remove GIT_CONFIG_PARAMETERS from the
 *   environment of their Git processes. Git 2.31 and newer applies both lists, each of which sets the helpers anew.
 * - DOCKER_CONFIG, GNUPGHOME: the forwarded Docker credential helper (in ~/.docker/config.json) and the forwarded GPG
 *   agent socket (in ~/.gnupg) are not used.
 * - GIT_SSH_COMMAND: Git over SSH does not use the forwarded SSH agent.
 * The token is never an environment variable (no GH_TOKEN).
 * Assumption (V-8): Git of the Source Control view and of the integrated terminal runs with these variables (the VS Code
 * server gets containerEnv and remoteEnv), so `git push` uses the credential helper of the container.
 */
export function containerEnvironment(): Record<string, string> {
  const settings = commandLineGitConfig();
  const env: Record<string, string> = { GIT_CONFIG_GLOBAL: GIT_CONFIG_FILE };
  env.GIT_CONFIG_PARAMETERS = settings.map(([key, value]) => gitConfigParameter(key, value)).join(' ');
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.DOCKER_CONFIG = DOCKER_CONFIG_FOLDER;
  env.GNUPGHOME = GNUPG_FOLDER;
  env.GIT_SSH_COMMAND = 'ssh -o IdentityAgent=none';
  return env;
}

/**
 * Environment variables of the VS Code server and its terminals (`remoteEnv`): those of containerEnvironment, because
 * the Dev Containers extension may set some of them itself, and an empty SSH_AUTH_SOCK, so that no process finds the
 * forwarded SSH agent through it. BROWSER stays: URLs open in the browser of the computer (concept section 9).
 * Assumption (V-8): the Dev Containers extension applies remoteEnv from the label devcontainer.metadata of the container
 * after its own values, and does not set these variables again afterwards.
 */
export function remoteEnvironment(): Record<string, string> {
  return { ...containerEnvironment(), SSH_AUTH_SOCK: '' };
}

/** user.name and user.email of the Git configuration of the container. */
export interface GitIdentity {
  name: string;
  email: string;
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
 * The check of the Dev Containers extension before it copies the Git configuration of the computer into ~/.gitconfig of
 * a container (remote-containers 0.470.0, extension.js, functions YE and vl): it copies (appends) unless the file exists
 * and has a section other than `[filter]` or `[safe]`. An empty file does not stop the copy. Exit code 1 and "exists":
 * no copy. Kept literally, so that it can be checked again when the extension changes.
 */
export const DEV_CONTAINERS_GITCONFIG_CHECK =
  "[ -e \"$HOME/.gitconfig\" ] && grep -e '^\\[' ~/.gitconfig | grep -v -E '^\\[(filter|safe)([[:blank:]]+|\\])' && echo exists && exit 1";

/**
 * ~/.gitconfig of the remote user in a new container (HOME_GIT_CONFIG_SCRIPT). Git 2.32 and newer does not read it while
 * GIT_CONFIG_GLOBAL is set. It has three tasks:
 * - Its first line after the comment is a section other than `[filter]` or `[safe]`, so the Dev Containers extension
 *   does not copy the Git configuration of the computer into the container (DEV_CONTAINERS_GITCONFIG_CHECK). Without the
 *   copy, the extension also does not change the Git configuration of the volume (it removes some keys of the copy with
 *   `git config --global --unset` and copies the file of `gpg.ssh.allowedSignersFile`).
 * - Git older than 2.32, and a process without the variables of the container (for example after `sudo` or `su -`),
 *   read it as the global configuration: the include gives them the configuration of the volume.
 * - The empty helper removes the forwarding helper of /etc/gitconfig for them, before the helpers of the volume.
 */
export const HOME_GIT_CONFIG_CONTENT = [
  '# Dev Environments: the Git configuration of this container is in ' + CONFIG_FOLDER + '.',
  '# This file keeps the Dev Containers extension from copying the Git configuration of the computer into the container.',
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
 * Runs as root in a new dev container, before the first attach (`$1` = the remote user):
 * - ~/.gitconfig: when it does not exist, HOME_GIT_CONFIG_CONTENT, owned by the user. A file of the image that would not
 *   stop the copy of the Dev Containers extension (empty, or only `[safe]` and `[filter]` sections, see
 *   DEV_CONTAINERS_GITCONFIG_CHECK) gets HOME_GIT_CONFIG_CONTENT at its end. A file with another section stays as it is.
 * - ~/.config/git/config: an empty file when it does not exist. The extension copies that file only when none exists.
 * Links stay as they are. Works with GNU and BusyBox tools.
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
empty_file() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then
    : > "$1"
    chown "$owner" "$1"
  fi
}
new_folder() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then
    mkdir "$1"
    chown "$owner" "$1"
  fi
}
# The check of the Dev Containers extension: a section other than [filter] and [safe] stops its copy.
stops_copy() {
  grep -e '^\\[' "$1" | grep -v -E '^\\[(filter|safe)([[:blank:]]+|\\])' >/dev/null
}
gitconfig="$home/.gitconfig"
if [ ! -e "$gitconfig" ] && [ ! -L "$gitconfig" ]; then
  printf '%s' "$content" > "$gitconfig"
  chown "$owner" "$gitconfig"
elif [ -f "$gitconfig" ] && [ ! -L "$gitconfig" ] && ! stops_copy "$gitconfig"; then
  if [ -s "$gitconfig" ] && [ -n "$(tail -c 1 "$gitconfig")" ]; then printf '\\n' >> "$gitconfig"; fi
  printf '%s' "$content" >> "$gitconfig"
fi
new_folder "$home/.config"
if [ -d "$home/.config" ] && [ ! -L "$home/.config" ]; then
  new_folder "$home/.config/git"
  if [ -d "$home/.config/git" ] && [ ! -L "$home/.config/git" ]; then empty_file "$home/.config/git/config"; fi
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
 * - 'noGlobalVariable': Git 2.9 to 2.31 ignores GIT_CONFIG_GLOBAL. The credential settings of the command line level
 *   work, but the identity and the other settings of the volume reach Git only through the include in ~/.gitconfig
 *   (HOME_GIT_CONFIG_CONTENT), which is missing when the image has its own ~/.gitconfig.
 * - 'unsafe': before Git 2.9, an empty credential.helper does not remove the helpers before it, so the forwarding helper
 *   of the Dev Containers extension answers requests of Git: with the credentials of the computer.
 */
export function containerGitSupport(versionOutput: string): 'full' | 'noGlobalVariable' | 'unsafe' | undefined {
  const version = parseGitVersion(versionOutput);
  if (!version) return undefined;
  const [major, minor] = version;
  const atLeast = (m: number, n: number): boolean => major > m || (major === m && minor >= n);
  if (!atLeast(2, 9)) return 'unsafe';
  if (!atLeast(2, 32)) return 'noGlobalVariable';
  return 'full';
}
