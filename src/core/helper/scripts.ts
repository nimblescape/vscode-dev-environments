// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Scripts that run in the workspace helper (implementation notes 7). The helper image is Debian, so /bin/sh is dash:
// the shell scripts are POSIX sh. A shell script runs as `sh -c <script> sh <args…>`, a Node.js script as
// `node -e <script> <args…>`. Values always arrive as positional parameters and are never part of the script text,
// so no value needs quoting.
//
// GitHub token (implementation notes 7, concept section 9): the token never appears on a command line, in an environment
// variable of a container, or in .git/config. It arrives on standard input and is written to a file in a tmpfs mount
// (SECRETS_FOLDER). For the clone and the branch switch, a Git credential helper that exists only for one command
// (`git -c credential.helper=…`) reads it from there. The file is removed right after use, and by a trap on every exit.
// The only copies in the volume are the token file of the dev container and the sign-in of the GitHub CLI there
// (GIT_FILES_SCRIPT, both mode 0600); REMOVE_GIT_TOKEN_SCRIPT removes both.
import { GIT_SUMMARY_SCRIPT } from '../git/gitSummary';
import { CONFIG_FOLDER, GH_CONFIG_FOLDER, GH_HOSTS_FILE, GITHUB_TOKEN_FILE, WORKSPACES_ROOT } from '../names';
import { GIT_CREDENTIALS_CONFIG_CONTENT } from './containerGit';

export { GIT_SUMMARY_SCRIPT };

/** tmpfs mount of the helper for the token (only for runs with `secrets: true`). */
export const SECRETS_FOLDER = '/run/devenv-secrets';
/** File of the token in SECRETS_FOLDER. */
export const TOKEN_FILE = `${SECRETS_FOLDER}/github-token`;
/**
 * Folder of the files that the extension writes into a helper run for the Dev Container CLI (the override configuration,
 * and for Docker Compose our model): only in the helper, never in the repository (each helper run is a new container).
 */
export const OVERRIDE_FOLDER = '/tmp/devenv-override';
/**
 * Age after which WRITE_AND_RUN_SCRIPT removes a compose file that the Dev Container CLI generated in the cache volume
 * (30 days, limit L-5 of the implementation notes, section "Docker Compose").
 */
export const COMPOSE_FILES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Path of the override configuration of `devcontainer up` inside the helper. */
export const OVERRIDE_CONFIG_PATH = `${OVERRIDE_FOLDER}/devcontainer.json`;

/**
 * Git credential helper (a shell function, run by Git with `sh -c`). It answers only `get` requests for
 * https://github.com, so that a changed remote or an `insteadOf` rule never receives the token.
 */
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || return 0; protocol=; host=; ' +
  'while IFS= read -r line; do case "$line" in protocol=*) protocol=${line#protocol=} ;; host=*) host=${line#host=} ;; esac; done; ' +
  'test "$protocol" = https && test "$host" = github.com || return 0; ' +
  `printf "username=x-access-token\\npassword=%s\\n" "$(cat ${TOKEN_FILE})"; }; f`;

// Shared part of the scripts that use the token. It defines:
// - validation of the arguments (the repository name becomes part of a URL),
// - the trap that removes the token file on every exit, also after a stop signal,
// - read_token: stdin → token file, only if SECRETS_FOLDER is a tmpfs mount,
// - git_net: Git with the credential helper, without hooks, only over https, never with a prompt,
// - git_local: Git without hooks and without fsmonitor. Git still runs other programs that the repository configuration
//   names (for example the smudge filter of a filter driver in `git switch`), so these runs get no Docker socket and no
//   cache volume (WorkspaceHelper): the helper is no trust boundary against the repository.
const TOKEN_PRELUDE = `set -eu
secrets='${SECRETS_FOLDER}'
token_file='${TOKEN_FILE}'
helper='${CREDENTIAL_HELPER.replace(/'/g, `'"'"'`)}'
work=''
cleanup() {
  rm -f "$token_file"
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
fail() {
  code="$1"
  shift
  printf '%s\\n' "$*" >&2
  exit "$code"
}
check_repository() {
  case "$1" in
    */*/* | -* | /* | */ | ./* | ../* | */. | */.. | *[!A-Za-z0-9._/-]*) fail 2 "Invalid repository name: $1" ;;
    ?*/?*) ;;
    *) fail 2 "Invalid repository name: $1" ;;
  esac
}
check_branch() {
  case "$1" in
    -*) fail 2 "Invalid branch name: $1" ;;
  esac
}
read_token() {
  if ! awk -v dir="$secrets" '$2 == dir && $3 == "tmpfs" { found = 1 } END { exit found ? 0 : 1 }' /proc/mounts; then
    fail 3 "$secrets is not a tmpfs mount."
  fi
  (umask 077 && cat > "$token_file")
  if [ ! -s "$token_file" ]; then
    fail 3 'No token on standard input.'
  fi
}
git_net() {
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS='' SSH_ASKPASS='' git \\
    -c credential.helper= -c "credential.helper=$helper" \\
    -c core.hooksPath=/dev/null -c core.fsmonitor=false \\
    -c protocol.allow=never -c protocol.https.allow=always \\
    "$@"
}
git_local() {
  git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"
}
`;

/**
 * `$1` = owner/repository, `$2` = folder name in /workspaces, `$3` = branch or '' (default branch). Token on stdin.
 * Idempotent: if /workspaces/<folder>/.git exists, it ends with exit code 0 at once. The clone goes to a temporary
 * folder in /workspaces first and is renamed at the end, so a failed clone leaves nothing behind.
 */
export const CLONE_SCRIPT = `${TOKEN_PRELUDE}
repo="$1"
folder="$2"
branch="\${3-}"
check_repository "$repo"
check_branch "$branch"
case "$folder" in
  '' | . | .. | -* | */*) fail 2 "Invalid folder name: $folder" ;;
esac
target='${WORKSPACES_ROOT}'/"$folder"
if [ -e "$target/.git" ]; then
  echo "The repository is already in the volume."
  exit 0
fi
if [ -e "$target" ] && ! rmdir "$target" 2>/dev/null; then
  fail 4 "The folder $target exists and is not a Git repository."
fi
# Temporary folders of runs that were killed.
find '${WORKSPACES_ROOT}' -mindepth 1 -maxdepth 1 -name '.devenv-clone.*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
read_token
work=$(mktemp -d '${WORKSPACES_ROOT}/.devenv-clone.XXXXXX')
if [ -n "$branch" ]; then
  git_net clone --branch "$branch" -- "https://github.com/$repo.git" "$work/repo"
else
  git_net clone -- "https://github.com/$repo.git" "$work/repo"
fi
rm -f "$token_file"
mv "$work/repo" "$target"
echo "The repository is in $target."
`;

/**
 * `$1` = repository folder (absolute), `$2` = branch, `$3` = owner/repository. Token on stdin.
 * Fetches the branches of https://github.com/<owner>/<repository>.git into refs/remotes/origin (the same result as
 * `git fetch origin`, but independent of the remote in .git/config), removes the token, runs `git switch <branch>`
 * (a remote branch gets a local tracking branch), and gives files that the helper created as root the owner of the
 * repository folder again. The owner is restored also when Git fails: a fetch writes .git/FETCH_HEAD, refs, and
 * objects before a refused switch, and Git in the dev container could not write them anymore.
 * On a Git error, Git's message goes to stderr and the exit code is 1.
 */
export const SWITCH_BRANCH_SCRIPT = `${TOKEN_PRELUDE}
dir="$1"
branch="$2"
repo="$3"
check_repository "$repo"
check_branch "$branch"
if [ -z "$branch" ]; then
  fail 2 'No branch name.'
fi
cd "$dir"
read_token
owner=$(stat -c '%u:%g' "$dir")
status=0
out=$(git_net fetch -- "https://github.com/$repo.git" '+refs/heads/*:refs/remotes/origin/*' 2>&1) || status=$?
rm -f "$token_file"
if [ "$status" -eq 0 ]; then
  if [ -n "$out" ]; then printf '%s\\n' "$out"; fi
  out=$(git_local switch "$branch" 2>&1) || status=$?
fi
if ! find "$dir" -xdev \\( ! -uid "\${owner%%:*}" -o ! -gid "\${owner#*:}" \\) -exec chown -h "$owner" {} +; then
  echo 'The owner of some files could not be restored.'
fi
if [ "$status" -ne 0 ]; then
  fail 1 "$out"
fi
if [ -n "$out" ]; then printf '%s\\n' "$out"; fi
`;

/**
 * `$1` = folder name of the repository in /workspaces, `$2` = user.name, `$3` = user.email, `$4` = the credential helper
 * of the dev container (CONTAINER_CREDENTIAL_HELPER), `$5` = the GitHub login of the account that owns the environment
 * (isGitHubLogin; empty when it is not known). Token on stdin. Prepares the configuration folder of the dev container
 * (CONFIG_FOLDER, concept section 9 "Git inside the container"), which all files and folders get with the owner
 * (numeric uid:gid) of the repository folder, that is the remote user after the ownership fix:
 * - github-token: the token, mode 0600, written again at each run (a new sign-in gives a new token);
 * - gh/hosts.yml (GH_HOSTS_FILE, the sign-in of the GitHub CLI, GH_CONFIG_DIR): written again at each run, mode 0600 in
 *   the folder gh/ (0700), with the same token as github-token and the login `$5` for github.com, so gh in the container
 *   works as the account that owns the environment, and nobody signs in there. Both forms of the file that gh reads: the
 *   keys `oauth_token`, `user`, and `git_protocol` of the host (gh before 2.40, and the active account of gh 2.40 and
 *   newer), and `users.<login>.oauth_token` (the accounts of gh 2.40 and newer). The other files of gh/ (for example
 *   config.yml, which gh writes itself) stay as they are. A token with characters that YAML would need to escape (no
 *   token of GitHub has them) signs gh in nowhere: the file is removed; so does a `$5` that is empty or no GitHub login
 *   (the same rule as isGitHubLogin), which never goes into the file, while the token and the Git configuration are
 *   still written (Git in the container works, gh is not signed in);
 * - gitconfig: created when missing, with user.name and user.email; of an existing file, only the section
 *   `[credential "https://github.com"]` is ensured (an empty helper, which removes the helpers before it, then ours);
 * - credentials.gitconfig (GIT_CREDENTIALS_CONFIG_FILE, the credential helpers of the user for other Git servers):
 *   created when missing, with an example in comments; an existing file stays as it is;
 * - docker/ (DOCKER_CONFIG), mode 0700.
 * A link or a file in place of one of the folders is removed first, and the token file is replaced with a rename, so
 * that the token never goes to another place. The folder gnupg/ of an earlier version stays as it is; nothing uses it.
 */
export const GIT_FILES_SCRIPT = `${TOKEN_PRELUDE}
folder="$1"
name="$2"
email="$3"
credential_helper="$4"
login="$5"
case "$folder" in
  '' | . | .. | -* | */*) fail 2 "Invalid folder name: $folder" ;;
esac
case "$login" in
  '' | [!A-Za-z0-9]* | *[!A-Za-z0-9_-]*) login='' ;;
esac
if [ "\${#login}" -gt 39 ]; then
  login=''
fi
repo='${WORKSPACES_ROOT}'/"$folder"
dir='${CONFIG_FOLDER}'
gh='${GH_CONFIG_FOLDER}'
if [ ! -d "$repo" ]; then
  fail 4 "The folder $repo does not exist."
fi
owner=$(stat -c '%u:%g' "$repo")
read_token
for path in "$dir" "$dir/docker" "$gh"; do
  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
    rm -f "$path"
  fi
  if [ ! -d "$path" ]; then
    mkdir "$path"
  fi
done
chmod 0755 "$dir"
chmod 0700 "$dir/docker" "$gh"
work=$(mktemp -d "$dir/.work.XXXXXX")
cp "$token_file" "$work/github-token"
rm -f "$token_file"
chmod 0600 "$work/github-token"
chown "$owner" "$work/github-token"
token=$(cat "$work/github-token")
mv -fT "$work/github-token" "$dir/github-token"
hosts='${GH_HOSTS_FILE}'
if [ -L "$hosts" ] || { [ -e "$hosts" ] && [ ! -f "$hosts" ]; }; then
  rm -rf "$hosts"
fi
if [ -z "$login" ]; then
  rm -f "$hosts"
  echo 'The GitHub CLI in the container is not signed in: the GitHub login of the account is not known. Git works.'
else
  case "$token" in
    *[!A-Za-z0-9_.-]*)
      rm -f "$hosts"
      echo 'The GitHub CLI in the container is not signed in: the token has characters that its configuration cannot hold.'
      ;;
    *)
      (umask 077 && printf 'github.com:\n    users:\n        "%s":\n            oauth_token: "%s"\n    git_protocol: https\n    oauth_token: "%s"\n    user: "%s"\n' "$login" "$token" "$token" "$login" > "$work/hosts.yml")
      chmod 0600 "$work/hosts.yml"
      chown "$owner" "$work/hosts.yml"
      mv -fT "$work/hosts.yml" "$hosts"
      ;;
  esac
fi
token=''
cfg="$dir/gitconfig"
if [ -L "$cfg" ]; then
  rm -f "$cfg"
fi
if [ ! -e "$cfg" ]; then
  : > "$work/gitconfig"
  if [ -n "$name" ]; then git config --file "$work/gitconfig" user.name "$name"; fi
  if [ -n "$email" ]; then git config --file "$work/gitconfig" user.email "$email"; fi
  chmod 0644 "$work/gitconfig"
  mv -fT "$work/gitconfig" "$cfg"
fi
key='credential.https://github.com.helper'
current=$(git config --file "$cfg" --get-all "$key") || current=''
wanted=$(printf '\n%s' "$credential_helper")
if [ "$current" != "$wanted" ]; then
  git config --file "$cfg" --unset-all "$key" || true
  git config --file "$cfg" --add "$key" ''
  git config --file "$cfg" --add "$key" "$credential_helper"
fi
credentials="$dir/credentials.gitconfig"
if [ -L "$credentials" ] || { [ -e "$credentials" ] && [ ! -f "$credentials" ]; }; then
  rm -rf "$credentials"
fi
if [ ! -e "$credentials" ]; then
  printf '%s' '${GIT_CREDENTIALS_CONFIG_CONTENT.replace(/'/g, `'"'"'`)}' > "$work/credentials.gitconfig"
  chmod 0644 "$work/credentials.gitconfig"
  mv -fT "$work/credentials.gitconfig" "$credentials"
fi
chown -h "$owner" "$dir" "$dir/docker" "$cfg" "$credentials" "$gh"
echo "The Git configuration of the environment is in $dir."
`;

/**
 * No arguments. Removes the token of the owner account from the configuration folder of the dev container: the token
 * file (GITHUB_TOKEN_FILE) and the sign-in of the GitHub CLI (GH_HOSTS_FILE), concept 7.5. It runs in the workspace
 * helper (our image, as root with the rights of a normal container), which mounts the workspace volume, so it needs no
 * tool of the image of the dev container, and works whether the dev container runs or not. The other files stay.
 * Exit code 1 when a file is still there.
 */
export const REMOVE_GIT_TOKEN_SCRIPT = `set -u
status=0
for path in '${GITHUB_TOKEN_FILE}' '${GH_HOSTS_FILE}'; do
  rm -rf -- "$path" || true
  if [ -e "$path" ] || [ -L "$path" ]; then
    printf '%s could not be removed.\n' "$path" >&2
    status=1
  fi
done
if [ "$status" -eq 0 ]; then echo 'The GitHub token was removed from the volume.'; fi
exit "$status"
`;

/**
 * `$1` = path of the override configuration, then the arguments of `devcontainer up`. The override configuration
 * arrives on stdin and is written to `$1` inside the helper.
 */
export const UP_SCRIPT = `set -eu
override="$1"
shift
mkdir -p "$(dirname "$override")"
cat > "$override"
exec devcontainer "$@"
`;

/**
 * `$1` = path of devcontainer.json (absolute), then the arguments of `devcontainer build`. The Dev Container CLI writes
 * a lockfile next to the configuration by default. It is used (and kept up to date) only if the repository has one,
 * so that a build never adds a file to the repository.
 */
export const BUILD_SCRIPT = `set -eu
config="$1"
shift
dir=$(dirname "$config")
case "$(basename "$config")" in
  .*) lockfile="$dir/.devcontainer-lock.json" ;;
  *) lockfile="$dir/devcontainer-lock.json" ;;
esac
if [ -e "$lockfile" ]; then
  exec devcontainer "$@"
fi
exec devcontainer "$@" --no-lockfile
`;

// Node.js scripts. JSON with arbitrary file names and texts is simpler and safer in JavaScript than in sh.
// They avoid process.exit(), so that the output to a pipe is always complete.

/**
 * `node -e` script. `argv[1]` = repository folder. Prints a JSON array of the configuration paths in the order of
 * precedence (concept 7.4): `.devcontainer/devcontainer.json`, `.devcontainer.json`,
 * `.devcontainer/<sub-folder>/devcontainer.json`. Sub-folders are sorted by UTF-16 code units, the order of the
 * discovery (src/core/discovery/detect.ts), so both name the same default configuration.
 */
export const LIST_CONFIGS_SCRIPT = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const root = process.argv[1];
const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
const found = [];
if (isFile(path.join(root, '.devcontainer', 'devcontainer.json'))) found.push('.devcontainer/devcontainer.json');
if (isFile(path.join(root, '.devcontainer.json'))) found.push('.devcontainer.json');
let entries = [];
try {
  entries = fs.readdirSync(path.join(root, '.devcontainer'), { withFileTypes: true });
} catch {
  entries = [];
}
const folders = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
for (const name of folders) {
  if (isFile(path.join(root, '.devcontainer', name, 'devcontainer.json'))) {
    found.push('.devcontainer/' + name + '/devcontainer.json');
  }
}
process.stdout.write(JSON.stringify(found) + '\n');
`;

/**
 * `node -e` script. `argv[1]` = repository folder (absolute), `argv[2]` = configuration path relative to it, `argv[3]`
 * (optional) = the Dockerfile as the configuration names it after the Dev Container CLI resolved its variables (review
 * round 2, S2-01), in place of `build.dockerfile` of the text.
 * Prints one JSON line: `null` if the configuration file does not exist, otherwise
 * `{ configText, dockerfilePath?, dockerfileText? }`. `build.dockerfile` (or the old `dockerFile`) is resolved
 * relative to the folder of the configuration; `dockerfilePath` is relative to the repository folder.
 * Paths outside of the repository folder are not read, nor a path with a variable that is not resolved.
 */
export const READ_FILES_SCRIPT = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const root = path.posix.resolve(process.argv[1]);
const inside = (file) => file === root || file.startsWith(root + '/');
const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return undefined;
    throw error;
  }
};
const stripJsonc = (text) => {
  let result = '';
  let i = 0;
  const skipComment = (j) => {
    if (text[j] === '/' && text[j + 1] === '/') {
      while (j < text.length && text[j] !== '\n') j++;
      return j;
    }
    if (text[j] === '/' && text[j + 1] === '*') {
      j += 2;
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
      return j + 2;
    }
    return -1;
  };
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      result += text.slice(start, i);
      continue;
    }
    const after = skipComment(i);
    if (after >= 0) {
      i = after;
      continue;
    }
    if (char === ',') {
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = skipComment(j);
        if (next < 0) break;
        j = next;
      }
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    result += char;
    i++;
  }
  return result;
};
const main = () => {
  const configFile = path.posix.resolve(root, process.argv[2] || '');
  if (!inside(configFile) || configFile === root) throw new Error('The configuration path is outside of the repository.');
  const configText = read(configFile);
  if (configText === undefined) return null;
  const result = { configText };
  let config;
  try {
    config = JSON.parse(stripJsonc(configText.replace(/^﻿/, '')));
  } catch {
    return result;
  }
  if (!config || typeof config !== 'object') return result;
  const build = config.build && typeof config.build === 'object' ? config.build : {};
  const dockerfile = process.argv[3] ? process.argv[3] : typeof build.dockerfile === 'string' ? build.dockerfile : config.dockerFile;
  if (typeof dockerfile !== 'string' || dockerfile === '' || dockerfile.includes('$' + '{')) return result;
  const dockerfileFile = path.posix.resolve(path.posix.dirname(configFile), dockerfile);
  if (!inside(dockerfileFile) || dockerfileFile === root) return result;
  result.dockerfilePath = path.posix.relative(root, dockerfileFile);
  const dockerfileText = read(dockerfileFile);
  if (dockerfileText !== undefined) result.dockerfileText = dockerfileText;
  return result;
};
process.stdout.write(JSON.stringify(main()) + '\n');
`;

/**
 * `node -e` script for the runs of the Dev Container CLI with files of the extension (Docker Compose: the override
 * configuration and our model, and the Dockerfile of a synthesized build). `argv[1]` = the folder for the files
 * (OVERRIDE_FOLDER), `argv[2]` = path of the repository's devcontainer.json for the lockfile rule of BUILD_SCRIPT (`''`:
 * none), `argv[3]` = path of our copy of the configuration that `--config` names (`''`: none), then the arguments of
 * `devcontainer`. Standard input: JSON `{ "files": { "<absolute path>": "<text>" } }`. Each path must be below the
 * folder, absolute and without `.`/`..` segments; the files get mode 0600, and the folder `context/` (the empty build
 * context of a synthesized build) is created. Lockfile: when the repository has one next to its configuration, it is
 * copied next to our copy (so the CLI uses it; a change that the CLI writes stays in the helper); without one,
 * `--no-lockfile` is added, so that a build never adds a file to the repository. Before `devcontainer up`, the compose
 * files that the Dev Container CLI generated in `<--user-data-folder>/docker-compose` (the shared cache volume) and that
 * are older than COMPOSE_FILES_MAX_AGE_MS are removed (limit L-5: nothing else removes them; the CLI writes a missing one
 * again without a build). Then `devcontainer` runs with the output of this process; its exit code is the exit code
 * (128 + the signal number after a signal), and a stop signal is passed on to it.
 */
export const WRITE_AND_RUN_SCRIPT = String.raw`'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const folder = process.argv[1];
const repositoryConfig = process.argv[2];
const ownConfig = process.argv[3];
const args = process.argv.slice(4);
const lockfileOf = (config) =>
  path.posix.join(path.posix.dirname(config), path.posix.basename(config).startsWith('.') ? '.devcontainer-lock.json' : 'devcontainer-lock.json');
const prepare = () => {
  if (!folder || path.posix.resolve(folder) !== folder || folder === '/') throw new Error('Invalid folder: ' + folder);
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const files = input && typeof input.files === 'object' && input.files !== null ? input.files : {};
  fs.mkdirSync(path.posix.join(folder, 'context'), { recursive: true, mode: 0o700 });
  for (const [file, text] of Object.entries(files)) {
    if (typeof file !== 'string' || path.posix.resolve(file) !== file || !file.startsWith(folder + '/') || typeof text !== 'string') {
      throw new Error('Invalid file: ' + file);
    }
    fs.mkdirSync(path.posix.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  if (ownConfig && (path.posix.resolve(ownConfig) !== ownConfig || !ownConfig.startsWith(folder + '/'))) {
    throw new Error('Invalid configuration path: ' + ownConfig);
  }
  if (repositoryConfig) {
    const lockfile = lockfileOf(repositoryConfig);
    if (!fs.existsSync(lockfile)) {
      args.push('--no-lockfile');
    } else if (ownConfig) {
      const copy = lockfileOf(ownConfig);
      fs.mkdirSync(path.posix.dirname(copy), { recursive: true, mode: 0o700 });
      fs.copyFileSync(lockfile, copy);
      fs.chmodSync(copy, 0o600);
    }
  }
};
const composeFile = /^docker-compose\.devcontainer\.(build|containerFeatures)-\d+(-[0-9A-Fa-f-]+)?\.yml$/;
const removeOldComposeFiles = () => {
  if (args[0] !== 'up') return;
  const index = args.indexOf('--user-data-folder');
  const data = index >= 0 ? args[index + 1] : undefined;
  if (!data || path.posix.resolve(data) !== data || data === '/') return;
  const dir = path.posix.join(data, 'docker-compose');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const limit = Date.now() - ${COMPOSE_FILES_MAX_AGE_MS};
  for (const name of names) {
    if (!composeFile.test(name)) continue;
    const file = path.posix.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.mtimeMs < limit) fs.unlinkSync(file);
    } catch {
      // Removed by another run, or not ours to remove.
    }
  }
};
try {
  prepare();
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error) + '\n');
  process.exitCode = 2;
}
if (process.exitCode === undefined) {
  removeOldComposeFiles();
  const child = spawn('devcontainer', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    process.stderr.write('devcontainer could not be started: ' + error.message + '\n');
    process.exitCode = 127;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code !== null ? code : 128 + (os.constants.signals[signal] || 1);
  });
}
`;

/**
 * `node -e` script of the model run of a Docker Compose configuration. `argv[1]` = repository folder (absolute), then
 * the compose files (absolute, resolveComposeFiles). The project name comes from COMPOSE_PROJECT_NAME. The run has no
 * Docker socket and no network (the Compose plugin needs no engine for `config`), and the configuration folder of the
 * volume is hidden (WorkspaceHelper.composeModel). Prints one JSON line (ComposeModelOutput of compose.ts):
 * - `version`: `docker compose version --short`;
 * - `dollarEscaped`: whether `config` prints a literal `$` as `$$` (a probe with a model of its own);
 * - `model`: `docker compose -f … --profile '*' config --format json` (all services of all profiles);
 * - `dockerfiles`: the Dockerfile of each service with a local build (`build.dockerfile_inline`, or the file: when it
 *   is in the repository folder, also after links, or when it is outside of it and no path of the workspace helper
 *   (isHelperPath of hostAccess.ts, the same paths here), also after links);
 * - `realPaths`: the real path of each bind mount source, `env_file`, local build context, and Dockerfile of a local
 *   build of the model, and (review round 2, S2-03) of each local additional context (also of `oci-layout://`), SSH key
 *   of `build.ssh`, and file of a top-level secret that `build.secrets` names (`null` when it does not exist);
 * - `inputsHash`: sha256 (hex) of the texts of the files that Compose read for the model, by path (`null` for a missing
 *   one): the compose files, the `.env` of the project folder (the folder of the first compose file), and each
 *   `env_file` (review round 1, P-4: a change of the Compose version alone changes the printed model, not these files).
 *   Only the hash leaves the run, not the texts.
 * On an error of Docker Compose: `{ "error": "<its message>" }`, exit code 0.
 */
export const COMPOSE_MODEL_SCRIPT = String.raw`'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const root = path.posix.resolve(process.argv[1]);
const files = process.argv.slice(2);
const inside = (file) => file === root || file.startsWith(root + '/');
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const compose = (args, options) =>
  spawnSync('docker', ['compose', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
const failure = (result, what) => {
  const text = ((result.stderr || '') + (result.error ? ' ' + result.error.message : '')).trim();
  return { error: text || what + ' failed with exit code ' + result.status + '.' };
};
const realPath = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
// The paths of isHelperPath (hostAccess.ts): the root, the cache volume, the folder with the token, and every path below
// /workspaces outside the repository, or a folder that contains one of them. (The Docker socket of isHelperPath is not
// mounted in this run; the check refuses a Dockerfile there anyway.)
const overlaps = (file, folder) => file === folder || file.startsWith(folder + '/') || folder.startsWith(file + '/');
const isHelperPath = (file) => {
  const normal = path.posix.normalize(file).replace(/(.)\/+$/, '$1');
  if (normal === '/') return true;
  if (['/devenv-cache', '/workspaces/.devenv+'].some((helperPath) => overlaps(normal, helperPath))) return true;
  return !inside(normal) && overlaps(normal, '/workspaces');
};
// The folder of a local additional context (localContextPath of hostAccess.ts): the path, or the path of an OCI layout.
const localFolder = (source) => {
  const text = String(source).trim();
  const oci = /^oci-layout:\/\/(.*)$/i.exec(text);
  if (oci) {
    let folder = oci[1].replace(/@[a-z0-9]+:[0-9a-f]+$/i, '');
    const colon = folder.indexOf(':', folder.lastIndexOf('/') + 1);
    return colon >= 0 ? folder.slice(0, colon) : folder;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(text) ? undefined : text;
};
// The key files of build.ssh: 'id=path[,path]', { id, path }, or a map.
const sshFiles = (ssh) => {
  const values = isObject(ssh) ? Object.values(ssh) : (Array.isArray(ssh) ? ssh : []).map((entry) => {
    if (isObject(entry)) return entry.path;
    const text = String(entry);
    return text.includes('=') ? text.slice(text.indexOf('=') + 1) : undefined;
  });
  return values.flatMap((value) => String(value === undefined || value === null ? '' : value).split(',')).map((file) => file.trim()).filter((file) => file !== '');
};
const readDockerfile = (file) => {
  const real = realPath(file);
  if (real === null) return undefined;
  const allowed = inside(file) ? inside(real) : !isHelperPath(file) && !isHelperPath(real);
  if (!allowed) return undefined;
  try {
    return fs.readFileSync(real, 'utf8');
  } catch {
    return undefined;
  }
};
const main = () => {
  const version = compose(['version', '--short']);
  if (version.status !== 0) return failure(version, 'docker compose version');
  const probeFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-compose-probe-'));
  const probe = compose(['--project-directory', probeFolder, '-p', 'devenv-probe', '-f', '-', 'config', '--format', 'json'], {
    cwd: probeFolder,
    input: 'services:\n  probe:\n    image: probe\n    environment:\n      V: "a$$b"\n',
  });
  fs.rmSync(probeFolder, { recursive: true, force: true });
  if (probe.status !== 0) return failure(probe, 'docker compose config');
  const value = JSON.parse(probe.stdout).services.probe.environment.V;
  if (value !== 'a$$b' && value !== 'a$b') return { error: 'docker compose config printed an unknown form of $: ' + JSON.stringify(value) };
  const args = [];
  for (const file of files) args.push('-f', file);
  const result = compose([...args, '--profile', '*', 'config', '--format', 'json'], { cwd: root });
  if (result.status !== 0) return failure(result, 'docker compose config');
  const model = JSON.parse(result.stdout);
  const dockerfiles = {};
  const realPaths = {};
  for (const [name, service] of Object.entries(isObject(model.services) ? model.services : {})) {
    if (!isObject(service)) continue;
    const build = service.build;
    if (isObject(build)) {
      const local = typeof build.context === 'string' && build.context.startsWith('/');
      if (local) realPaths[build.context] = realPath(build.context);
      // Review round 2 (S2-03): the other files and folders that the build client reads in the helper.
      for (const source of Object.values(isObject(build.additional_contexts) ? build.additional_contexts : {})) {
        const folder = localFolder(source);
        if (folder !== undefined && folder.startsWith('/')) realPaths[folder] = realPath(folder);
      }
      for (const file of sshFiles(build.ssh)) if (file.startsWith('/')) realPaths[file] = realPath(file);
      for (const entry of Array.isArray(build.secrets) ? build.secrets : []) {
        const secretName = typeof entry === 'string' ? entry : isObject(entry) ? entry.source : undefined;
        const secret = isObject(model.secrets) && typeof secretName === 'string' ? model.secrets[secretName] : undefined;
        if (isObject(secret) && typeof secret.file === 'string' && secret.file.startsWith('/')) realPaths[secret.file] = realPath(secret.file);
      }
      if (typeof build.dockerfile_inline === 'string') {
        dockerfiles[name] = build.dockerfile_inline;
      } else if (local) {
        const file = path.posix.resolve(build.context, typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile');
        realPaths[file] = realPath(file);
        const text = readDockerfile(file);
        if (text !== undefined) dockerfiles[name] = text;
      }
    }
    for (const volume of Array.isArray(service.volumes) ? service.volumes : []) {
      if (isObject(volume) && volume.type === 'bind' && typeof volume.source === 'string') realPaths[volume.source] = realPath(volume.source);
    }
    for (const entry of Array.isArray(service.env_file) ? service.env_file : []) {
      const file = typeof entry === 'string' ? entry : isObject(entry) ? entry.path : undefined;
      if (typeof file === 'string') realPaths[file] = realPath(file);
    }
  }
  const inputs = new Map();
  const readInput = (file) => {
    if (inputs.has(file)) return;
    try {
      inputs.set(file, fs.readFileSync(file, 'utf8'));
    } catch {
      inputs.set(file, null);
    }
  };
  for (const file of files) readInput(file);
  if (files.length > 0) readInput(path.posix.join(path.posix.dirname(files[0]), '.env'));
  for (const service of Object.values(isObject(model.services) ? model.services : {})) {
    for (const entry of isObject(service) && Array.isArray(service.env_file) ? service.env_file : []) {
      const file = typeof entry === 'string' ? entry : isObject(entry) ? entry.path : undefined;
      if (typeof file === 'string') readInput(file);
    }
  }
  const inputsHash = crypto.createHash('sha256').update(JSON.stringify([...inputs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))).digest('hex');
  return { version: version.stdout.trim(), dollarEscaped: value === 'a$$b', model, dockerfiles, realPaths, inputsHash };
};
let output;
try {
  output = main();
} catch (error) {
  output = { error: String(error && error.message ? error.message : error) };
}
process.stdout.write(JSON.stringify(output) + '\n');
`;

/** `sh -c` command that clones the repository into the volume. Token on stdin, secrets mount required. */
export function cloneCommand(repository: string, folderName: string, branch?: string): string[] {
  return ['sh', '-c', CLONE_SCRIPT, 'sh', repository, folderName, branch ?? ''];
}

/**
 * `sh -c` command that writes the token, the sign-in of the GitHub CLI as `login`, and the Git configuration of the dev
 * container. Token on stdin, secrets mount required.
 */
export function gitFilesCommand(
  folderName: string,
  identity: { name: string; email: string },
  credentialHelper: string,
  login: string,
): string[] {
  return ['sh', '-c', GIT_FILES_SCRIPT, 'sh', folderName, identity.name, identity.email, credentialHelper, login];
}

/** `sh -c` command that removes the token of the owner account from the volume (REMOVE_GIT_TOKEN_SCRIPT). */
export function removeGitTokenCommand(): string[] {
  return ['sh', '-c', REMOVE_GIT_TOKEN_SCRIPT, 'sh'];
}

/** `sh -c` command that switches the branch. Token on stdin, secrets mount required. */
export function switchBranchCommand(repoFolder: string, branch: string, repository: string): string[] {
  return ['sh', '-c', SWITCH_BRANCH_SCRIPT, 'sh', repoFolder, branch, repository];
}

export function listConfigsCommand(repoFolder: string): string[] {
  return ['node', '-e', LIST_CONFIGS_SCRIPT, repoFolder];
}

/** `dockerfile`: the Dockerfile that the resolved configuration names (READ_FILES_SCRIPT, `argv[3]`). */
export function readFilesCommand(repoFolder: string, configPath: string, dockerfile?: string): string[] {
  return ['node', '-e', READ_FILES_SCRIPT, repoFolder, configPath, ...(dockerfile !== undefined && dockerfile !== '' ? [dockerfile] : [])];
}

/** `sh -c` command for `devcontainer up`: the override configuration is expected on stdin. */
export function upCommand(overrideConfigPath: string, args: readonly string[]): string[] {
  return ['sh', '-c', UP_SCRIPT, 'sh', overrideConfigPath, ...args];
}

/**
 * `node -e` command of WRITE_AND_RUN_SCRIPT: writes the files of its standard input below OVERRIDE_FOLDER, then runs
 * `devcontainer <args…>`. For `build`: `repositoryConfig` (absolute path of the repository's devcontainer.json in the
 * helper) with the lockfile rule of BUILD_SCRIPT, and `config`, our copy of the configuration below OVERRIDE_FOLDER that
 * `--config` names, which gets the repository's lockfile.
 */
export function writeAndRunCommand(p: { repositoryConfig?: string; config?: string }, args: readonly string[]): string[] {
  return ['node', '-e', WRITE_AND_RUN_SCRIPT, OVERRIDE_FOLDER, p.repositoryConfig ?? '', p.config ?? '', ...args];
}

/** `node -e` command of COMPOSE_MODEL_SCRIPT for the compose files (absolute paths) of a configuration. */
export function composeModelCommand(repoFolder: string, files: readonly string[]): string[] {
  return ['node', '-e', COMPOSE_MODEL_SCRIPT, repoFolder, ...files];
}

/** `sh -c` command for `devcontainer build`. `configFile` is the absolute path of devcontainer.json in the helper. */
export function buildCommand(configFile: string, args: readonly string[]): string[] {
  return ['sh', '-c', BUILD_SCRIPT, 'sh', configFile, ...args];
}
