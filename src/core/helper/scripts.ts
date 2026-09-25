// Scripts that run in the workspace helper (implementation notes 7). The helper image is Debian, so /bin/sh is dash:
// the shell scripts are POSIX sh. A shell script runs as `sh -c <script> sh <args…>`, a Node.js script as
// `node -e <script> <args…>`. Values always arrive as positional parameters and are never part of the script text,
// so no value needs quoting.
//
// GitHub token (implementation notes 7, concept section 9): the token never appears on a command line, in an environment
// variable of the container, in the volume, or in .git/config. It arrives on standard input and is written to a file
// in a tmpfs mount (SECRETS_FOLDER). A Git credential helper that exists only for one command
// (`git -c credential.helper=…`) reads it from there. The file is removed right after use, and by a trap on every exit.
import { GIT_SUMMARY_SCRIPT } from '../git/gitSummary';
import { WORKSPACES_ROOT } from '../names';

export { GIT_SUMMARY_SCRIPT };

/** tmpfs mount of the helper for the token (only for runs with `secrets: true`). */
export const SECRETS_FOLDER = '/run/devenv-secrets';
/** File of the token in SECRETS_FOLDER. */
export const TOKEN_FILE = `${SECRETS_FOLDER}/github-token`;
/** Path of the override configuration of `devcontainer up` inside the helper (each helper run is a new container). */
export const OVERRIDE_CONFIG_PATH = '/tmp/devenv-override/devcontainer.json';

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
 * `node -e` script. `argv[1]` = repository folder (absolute), `argv[2]` = configuration path relative to it.
 * Prints one JSON line: `null` if the configuration file does not exist, otherwise
 * `{ configText, dockerfilePath?, dockerfileText? }`. `build.dockerfile` (or the old `dockerFile`) is resolved
 * relative to the folder of the configuration; `dockerfilePath` is relative to the repository folder.
 * Paths outside of the repository folder are not read.
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
  const dockerfile = typeof build.dockerfile === 'string' ? build.dockerfile : config.dockerFile;
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

/** `sh -c` command that clones the repository into the volume. Token on stdin, secrets mount required. */
export function cloneCommand(repository: string, folderName: string, branch?: string): string[] {
  return ['sh', '-c', CLONE_SCRIPT, 'sh', repository, folderName, branch ?? ''];
}

/** `sh -c` command that switches the branch. Token on stdin, secrets mount required. */
export function switchBranchCommand(repoFolder: string, branch: string, repository: string): string[] {
  return ['sh', '-c', SWITCH_BRANCH_SCRIPT, 'sh', repoFolder, branch, repository];
}

export function listConfigsCommand(repoFolder: string): string[] {
  return ['node', '-e', LIST_CONFIGS_SCRIPT, repoFolder];
}

export function readFilesCommand(repoFolder: string, configPath: string): string[] {
  return ['node', '-e', READ_FILES_SCRIPT, repoFolder, configPath];
}

/** `sh -c` command for `devcontainer up`: the override configuration is expected on stdin. */
export function upCommand(overrideConfigPath: string, args: readonly string[]): string[] {
  return ['sh', '-c', UP_SCRIPT, 'sh', overrideConfigPath, ...args];
}

/** `sh -c` command for `devcontainer build`. `configFile` is the absolute path of devcontainer.json in the helper. */
export function buildCommand(configFile: string, args: readonly string[]): string[] {
  return ['sh', '-c', BUILD_SCRIPT, 'sh', configFile, ...args];
}
