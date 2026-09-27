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
// Unit 15: no copy is in the volume. The token file of the dev container and the sign-in of the GitHub CLI are only in the
// memory of the dev container (TOKEN_FOLDER, ./containerToken.ts).
import { GIT_SUMMARY_SCRIPT, SERVICE_OWNER_FIX, SERVICE_REAL_PATHS, servicePathArguments, type ServiceFolders } from '../git/gitSummary';
import { CONFIG_FOLDER, GH_VOLUME_FOLDER, WORKSPACES_ROOT } from '../names';
import { MAX_DOCKERFILE_LENGTH } from '../imageCheck/dockerfile';
import { MAX_CONFIG_TEXT_LENGTH } from './analysisLimits';
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
 * `$1` = repository folder (absolute), `$2` = branch, `$3` = owner/repository, `$4`… (review round 9, D9-1) the `find`
 * test of the paths that the other services of Docker Compose mount (servicePathArguments, review round 11), which the
 * restore of the owner leaves out with their content, except (review round 10, D10-3) their files and folders of root,
 * which `git switch` wrote (SERVICE_OWNER_FIX). Token on stdin. Review round 13 (D13-2): the real paths of the paths of
 * the services behind links are resolved before `git fetch` and `git switch` too (SERVICE_REAL_PATHS, the same code as
 * in service_owner_fix, which unites them with the real paths after the switch, against one bound): a link of the branch
 * before the switch (for example `data -> storage/pg`, which db mounts) that the other branch replaces with a folder
 * still protects the data behind it.
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
shift 3
${SERVICE_OWNER_FIX}check_repository "$repo"
check_branch "$branch"
if [ -z "$branch" ]; then
  fail 2 'No branch name.'
fi
cd "$dir"
read_token
owner=$(stat -c '%u:%g' "$dir")
folder=$dir
${SERVICE_REAL_PATHS}status=0
out=$(git_net fetch -- "https://github.com/$repo.git" '+refs/heads/*:refs/remotes/origin/*' 2>&1) || status=$?
rm -f "$token_file"
if [ "$status" -eq 0 ]; then
  if [ -n "$out" ]; then printf '%s\\n' "$out"; fi
  out=$(git_local switch "$branch" 2>&1) || status=$?
fi
if ! service_owner_fix "$dir" "\${owner%%:*}" "\${owner#*:}" "$owner" "$@"; then
  echo 'The owner of some files could not be restored.'
fi
if [ "$status" -ne 0 ]; then
  fail 1 "$out"
fi
if [ -n "$out" ]; then printf '%s\\n' "$out"; fi
`;

/**
 * `$1` = folder name of the repository in /workspaces, `$2` = user.name, `$3` = user.email, `$4` = the credential helper
 * of the dev container (CONTAINER_CREDENTIAL_HELPER). No token (unit 15: the token and the sign-in of the GitHub CLI are
 * written into the memory of the dev container after its start, TOKEN_WRITE_SCRIPT). Prepares the configuration folder of
 * the dev container in the volume (CONFIG_FOLDER, concept section 9 "Git inside the container"), which all files and
 * folders get with the owner (numeric uid:gid) of the repository folder, that is the remote user after the ownership fix:
 * - gh/ (GH_VOLUME_FOLDER), mode 0700: the folder of gh's config.yml (the settings of the GitHub CLI, no secret), to which
 *   the link config.yml in GH_CONFIG_DIR leads; config.yml itself belongs to gh and stays as it is;
 * - gitconfig: created when missing, with user.name and user.email; of an existing file, only the section
 *   `[credential "https://github.com"]` is ensured (an empty helper, which removes the helpers before it, then ours);
 * - credentials.gitconfig (GIT_CREDENTIALS_CONFIG_FILE, the credential helpers of the user for other Git servers):
 *   created when missing, with an example in comments; an existing file stays as it is;
 * - docker/ (DOCKER_CONFIG), mode 0700.
 * A link or a file in place of one of the folders is removed first.
 */
export const GIT_FILES_SCRIPT = `set -eu
folder="$1"
name="$2"
email="$3"
credential_helper="$4"
work=''
cleanup() {
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
case "$folder" in
  '' | . | .. | -* | */*) fail 2 "Invalid folder name: $folder" ;;
esac
repo='${WORKSPACES_ROOT}'/"$folder"
dir='${CONFIG_FOLDER}'
gh='${GH_VOLUME_FOLDER}'
if [ ! -d "$repo" ]; then
  fail 4 "The folder $repo does not exist."
fi
owner=$(stat -c '%u:%g' "$repo")
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
 * Review round 9 (S9-2): the function `readLimited(file, limit)` of READ_FILES_SCRIPT and COMPOSE_MODEL_SCRIPT (they
 * define `fs`): the text of a file, at most `limit + 1` characters of it, so that the length check of the extension
 * still sees a longer file (MAX_CONFIG_TEXT_LENGTH refuses it, and MAX_DOCKERFILE_LENGTH refuses a Dockerfile of a
 * single container or of any service of a Docker Compose configuration, U1: the configuration hash sees only the text
 * that was read), while a file of any size costs at most
 * 4 · (`limit` + 1) bytes (4 bytes per character of UTF-8 at most), never the whole file. Throws what `fs` throws.
 */
const READ_LIMITED = String.raw`const readLimited = (file, limit) => {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4 * (limit + 1));
    let length = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length === buffer.length) break;
    }
    const text = buffer.toString('utf8', 0, length);
    return text.length > limit ? text.slice(0, limit + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
};
`;

/**
 * The function `missingInRepository(file)` of READ_FILES_SCRIPT and COMPOSE_MODEL_SCRIPT (they define `fs`, `path`,
 * `root`, `inside`, and `realPath`): whether a path of the repository does not exist, as a plain error of the
 * configuration (review round 3, P3-1). Review round 4 (P4-1): a link that leads nowhere counts too when its chain stays
 * in the repository: each link is read with readlink and its target resolved against the real folder of the link, at
 * most 32 links; every step must stay in the repository (so never a folder of the workspace helper), and the last path
 * must not exist while the nearest folder above it that exists is in the repository after links. A link out of the
 * repository, a chain in a circle or longer than the limit, and a path that exists for the system (stat) are no missing
 * path: the check refuses them.
 */
const MISSING_IN_REPOSITORY = String.raw`const missingInRepository = (file) => {
  if (!inside(file)) return false;
  const rootReal = realPath(root);
  if (rootReal === null) return false;
  const inRepository = (candidate) => inside(candidate) || candidate === rootReal || candidate.startsWith(rootReal + '/');
  const absent = (candidate) => {
    try {
      fs.lstatSync(candidate);
      return false;
    } catch (error) {
      return Boolean(error) && ['ENOENT', 'ENOTDIR'].includes(error.code);
    }
  };
  // The system follows the links physically: a path that exists for it is not missing, whatever its chain says.
  try {
    fs.statSync(file);
    return false;
  } catch (error) {
    if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
  }
  let current = file;
  const seen = new Set();
  for (let hop = 0; hop <= 32; hop++) {
    if (!inRepository(current) || seen.has(current)) return false;
    seen.add(current);
    if (absent(current)) {
      for (let folder = path.posix.dirname(current); inRepository(folder); folder = path.posix.dirname(folder)) {
        if (absent(folder)) continue;
        const real = realPath(folder);
        return real !== null && (real === rootReal || real.startsWith(rootReal + '/'));
      }
      return false;
    }
    let stat;
    let target;
    try {
      stat = fs.lstatSync(current);
      if (!stat.isSymbolicLink()) return false;
      target = fs.readlinkSync(current);
    } catch {
      return false;
    }
    const folder = realPath(path.posix.dirname(current));
    if (folder === null || !(folder === rootReal || folder.startsWith(rootReal + '/'))) return false;
    current = path.posix.resolve(folder, target);
  }
  return false;
};
`;

/**
 * `node -e` script. `argv[1]` = repository folder (absolute), `argv[2]` = configuration path relative to it, `argv[3]`
 * (optional) = the Dockerfile as the configuration names it after the Dev Container CLI resolved its variables (review
 * round 2, S2-01), in place of `build.dockerfile` of the text.
 * Prints one JSON line: `null` if the configuration file does not exist, otherwise
 * `{ configText, dockerfilePath?, dockerfileText?, dockerfileMissing? }`. `build.dockerfile` (or the old `dockerFile`) is
 * resolved relative to the folder of the configuration; `dockerfilePath` is relative to the repository folder.
 * Paths outside of the repository folder are not read, nor a path with a variable that is not resolved, nor a file whose
 * link leads out of the repository (review round 3, P3-1). `dockerfileMissing: true`: the Dockerfile does not exist in
 * the repository, and no link leads to or through its path (a missing file, not a link out).
 */
export const READ_FILES_SCRIPT = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const root = path.posix.resolve(process.argv[1]);
const inside = (file) => file === root || file.startsWith(root + '/');
${READ_LIMITED}// Review round 9 (S9-1, S9-2): at most one character more than the extension takes.
const read = (file, limit) => {
  try {
    return readLimited(file, limit);
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return undefined;
    throw error;
  }
};
const realPath = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
${MISSING_IN_REPOSITORY}const stripJsonc = (text) => {
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
  const configText = read(configFile, ${MAX_CONFIG_TEXT_LENGTH});
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
  if (missingInRepository(dockerfileFile)) {
    result.dockerfileMissing = true;
    return result;
  }
  // Review round 3 (P3-1), U2: a link out of the repository (a real path outside of it, for example the folder with the
  // token or the cache volume) is not read: without a text or dockerfileMissing, the extension refuses the Dockerfile
  // whatever the switch says (hostAccess.ts, dockerfileUnreadable).
  const real = realPath(dockerfileFile);
  const rootReal = realPath(root);
  if (real === null || rootReal === null || !real.startsWith(rootReal + '/')) return result;
  const dockerfileText = read(dockerfileFile, ${MAX_DOCKERFILE_LENGTH});
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
 * - `model`: `docker compose -f … --profile '*' config --format json` (all services of all profiles), each text value
 *   unescaped (`$$` → `$`) when `dollarEscaped` (review round 19, S19-1; review round 20, D20-1: the keys too): the texts that Compose and BuildKit use, from
 *   which everything below is computed;
 * - `dockerfiles`: the `build.dockerfile_inline` of each service that has one;
 * - `dockerfileFiles` and `dockerfileTexts` (review round 9, S9-2): of each other service with a local build, the real
 *   path of its Dockerfile (when it is in the repository folder, also after links, or when it is outside of it and no
 *   path of the workspace helper (isHelperPath of hostAccess.ts, the same paths here), also after links), and the text
 *   of each such file once, by its real path, at most one character longer than MAX_DOCKERFILE_LENGTH (readLimited);
 *   parseComposeModelOutput gives each service its text in `dockerfiles`;
 * - `realPaths`: the real path of each bind mount source, `env_file`, local build context, and Dockerfile of a local
 *   build of the model, and (review round 2, S2-03) of each local additional context (also of `oci-layout://`), SSH key
 *   of `build.ssh`, and file of a top-level secret that `build.secrets` names (`null` when it does not exist);
 * - `missing` (review round 3, P3-1): of the local build contexts and Dockerfiles, those in the repository folder that
 *   do not exist, without a link that leads to or through them (a missing file of the repository, not a link out);
 * - `mountAncestors` (review round 8, P8-2): of each bind mount source in the repository folder that does not exist, the
 *   real path of the nearest path above it (or itself, for a link that leads nowhere) that exists, when that is a folder,
 *   else `null`;
 * - `mountCreateTargets` (review round 10, D10-2): of each of them whose nearest path is a folder, that real path plus
 *   the rest of the (normalized) source: where CREATE_FOLDERS_SCRIPT creates it, through the links;
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
// The paths of isHelperPath (hostAccess.ts): the root, the cache volume, the folder with the token, the folders of the
// kernel (review round 3, S3-1), and every path below /workspaces outside the repository, or a folder that contains one
// of them. (The Docker socket of isHelperPath is not mounted in this run; the check refuses a Dockerfile there anyway.)
const overlaps = (file, folder) => file === folder || file.startsWith(folder + '/') || folder.startsWith(file + '/');
const isHelperPath = (file) => {
  const normal = path.posix.normalize(file).replace(/(.)\/+$/, '$1');
  if (normal === '/') return true;
  if (['/devenv-cache', '/workspaces/.devenv+', '/proc', '/sys', '/dev'].some((helperPath) => overlaps(normal, helperPath))) return true;
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
${MISSING_IN_REPOSITORY}// Review round 8 (P8-2): the real path of the nearest path at or above a file that does not exist, when it is a folder.
// Review round 10 (D10-2): with that nearest path (at).
const nearestFolderAt = (file) => {
  for (let current = file; ; current = path.posix.dirname(current)) {
    try {
      fs.lstatSync(current);
    } catch (error) {
      if (error && ['ENOENT', 'ENOTDIR'].includes(error.code) && current !== '/') continue;
      return { at: current, real: null };
    }
    try {
      return { at: current, real: fs.statSync(current).isDirectory() ? realPath(current) : null };
    } catch {
      return { at: current, real: null };
    }
  }
};
const nearestFolder = (file) => nearestFolderAt(file).real;
${READ_LIMITED}// Review round 9 (S9-2): each file once (dockerfileTexts, by its real path), at most one character more than
// MAX_DOCKERFILE_LENGTH. Returns the real path of the text, or undefined.
const dockerfileTexts = {};
const readDockerfile = (file) => {
  const real = realPath(file);
  if (real === null) return undefined;
  const allowed = inside(file) ? inside(real) : !isHelperPath(file) && !isHelperPath(real);
  if (!allowed) return undefined;
  if (Object.prototype.hasOwnProperty.call(dockerfileTexts, real)) return real;
  try {
    dockerfileTexts[real] = readLimited(real, ${MAX_DOCKERFILE_LENGTH});
    return real;
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
  // Review round 19 (S19-1): the texts that Compose and BuildKit use. A Compose that prints a literal $ as $$ gets each
  // text value unescaped first, so that the Dockerfiles, the real paths, and the files read below are those of the
  // unescaped texts (and the maps are keyed by them); the model leaves the run unescaped too. Review round 20 (D20-1):
  // the keys too (Compose escapes the whole output and never interpolates a key; the names of services, volumes,
  // networks, secrets, and configs cannot hold a $).
  const unescapeText = (text) => text.replace(/\$\$/g, '$');
  const unescape = (value) => {
    if (typeof value === 'string') return unescapeText(value);
    if (Array.isArray(value)) return value.map(unescape);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [unescapeText(key), unescape(entry)]));
    return value;
  };
  const printed = JSON.parse(result.stdout);
  const model = value === 'a$$b' ? unescape(printed) : printed;
  const dockerfiles = {};
  const dockerfileFiles = {};
  const realPaths = {};
  const missing = [];
  // Review round 9 (S9-1): a Set, so that many services cost linear time.
  const missingSeen = new Set();
  const addMissing = (file) => {
    if (missingSeen.has(file)) return;
    missingSeen.add(file);
    missing.push(file);
  };
  const mountAncestors = {};
  const mountCreateTargets = {};
  for (const [name, service] of Object.entries(isObject(model.services) ? model.services : {})) {
    if (!isObject(service)) continue;
    const build = service.build;
    if (isObject(build)) {
      const local = typeof build.context === 'string' && build.context.startsWith('/');
      if (local) realPaths[build.context] = realPath(build.context);
      if (local && !missingSeen.has(build.context) && missingInRepository(build.context)) addMissing(build.context);
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
        if (!missingSeen.has(file) && missingInRepository(file)) addMissing(file);
        const real = readDockerfile(file);
        if (real !== undefined) dockerfileFiles[name] = real;
      }
    }
    for (const volume of Array.isArray(service.volumes) ? service.volumes : []) {
      if (isObject(volume) && volume.type === 'bind' && typeof volume.source === 'string') {
        realPaths[volume.source] = realPath(volume.source);
        if (realPaths[volume.source] === null && volume.source.startsWith('/') && inside(path.posix.normalize(volume.source))) {
          mountAncestors[volume.source] = nearestFolder(volume.source);
          // Review round 10 (D10-2): where the created folder lands after the links of the nearest folder.
          const normal = path.posix.normalize(volume.source).replace(/(.)\/+$/, '$1');
          const nearest = nearestFolderAt(normal);
          if (nearest.real !== null && inside(normal)) mountCreateTargets[volume.source] = nearest.real + normal.slice(nearest.at === '/' ? 0 : nearest.at.length);
        }
      }
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
  return {
    version: version.stdout.trim(),
    dollarEscaped: value === 'a$$b',
    model,
    dockerfiles,
    dockerfileFiles,
    dockerfileTexts,
    realPaths,
    missing,
    mountAncestors,
    mountCreateTargets,
    inputsHash,
  };
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
 * `sh -c` command that writes the Git configuration of the dev container into the volume (GIT_FILES_SCRIPT). No token.
 */
export function gitFilesCommand(folderName: string, identity: { name: string; email: string }, credentialHelper: string): string[] {
  return ['sh', '-c', GIT_FILES_SCRIPT, 'sh', folderName, identity.name, identity.email, credentialHelper];
}


/** `sh -c` command that switches the branch. Token on stdin, secrets mount required. */
export function switchBranchCommand(repoFolder: string, branch: string, repository: string, serviceFolders?: ServiceFolders): string[] {
  return ['sh', '-c', SWITCH_BRANCH_SCRIPT, 'sh', repoFolder, branch, repository, ...servicePathArguments(repoFolder, serviceFolders)];
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

/**
 * `node -e` script (review round 8, P8-2): creates the folders of the repository that bind mounts of a Docker Compose
 * configuration name and that do not exist yet (composeUpModel's `createFolders`), as Docker would create them on the
 * computer (`create_host_path`). `argv[1]` = repository folder (absolute), then the folders (absolute, below it). Each
 * missing part is created one at a time, without following a link: the nearest path that exists must be a folder whose
 * real path is in the repository, and each created part must be a folder of its own. Exits 0 when all exist afterwards;
 * otherwise 2 with the reason on stderr, and stops at the first problem.
 */
export const CREATE_FOLDERS_SCRIPT = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const root = path.posix.resolve(process.argv[1]);
const fail = (message) => {
  process.stderr.write(message + '\n');
  process.exit(2);
};
let rootReal;
try {
  rootReal = fs.realpathSync(root);
} catch {
  fail('The repository folder ' + root + ' does not exist.');
}
const inRepository = (real) => real === rootReal || real.startsWith(rootReal + '/');
for (const folder of process.argv.slice(2)) {
  if (!folder.startsWith(root + '/') || path.posix.normalize(folder) !== folder || folder.split('/').includes('..')) fail('Not a folder of the repository: ' + folder);
  const missing = [];
  let current = folder;
  for (;;) {
    try {
      fs.lstatSync(current);
    } catch (error) {
      if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code) || current === root) fail('Cannot read ' + current + ': ' + String(error && error.code));
      missing.unshift(current);
      current = path.posix.dirname(current);
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(current);
    } catch {
      fail(current + ' is a link that leads nowhere.');
    }
    if (!fs.statSync(current).isDirectory()) fail(current + ' is no folder.');
    if (!inRepository(real)) fail(current + ' leads out of the repository, to ' + real + '.');
    break;
  }
  for (const part of missing) {
    try {
      fs.mkdirSync(part);
    } catch (error) {
      fail('Cannot create ' + part + ': ' + String(error && error.code));
    }
    const stat = fs.lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inRepository(fs.realpathSync(part))) fail(part + ' is no folder of the repository.');
  }
}
`;

/** `node -e` command of CREATE_FOLDERS_SCRIPT. */
export function createFoldersCommand(repoFolder: string, folders: readonly string[]): string[] {
  return ['node', '-e', CREATE_FOLDERS_SCRIPT, repoFolder, ...folders];
}

/** `sh -c` command for `devcontainer build`. `configFile` is the absolute path of devcontainer.json in the helper. */
export function buildCommand(configFile: string, args: readonly string[]): string[] {
  return ['sh', '-c', BUILD_SCRIPT, 'sh', configFile, ...args];
}
