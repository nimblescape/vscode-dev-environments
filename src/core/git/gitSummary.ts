// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Git state of a repository folder (implementation notes 10). The scripts run with `sh -c <script> sh <args…>` and
// `docker exec` in a running dev container. Values arrive as positional parameters.
import type { GitSummary } from '../types';

/**
 * Prints 4 lines: the branch (empty for a detached HEAD), the number of `git status --porcelain` lines, the number of
 * commits on HEAD or on any local branch that no remote-tracking branch contains, and the number of stashes. `$1` is the
 * repository folder. The unpushed commits include those of every local branch (concept 7.5, 7.14 step 1): the volume
 * keeps them, and Delete removes them. Commits that only the reflog or a tag still reaches are not counted (review round
 * 4 of PR #84, A-R4-1: a clone fetches every tag of the upstream).
 *
 * The script runs in the running dev container as its user (`remoteUser`): the polls of the Session Monitor, and after
 * an open or a stop (and, user decision 2026-10-02, before Delete's confirmation when the container runs). Delete runs no
 * Git anywhere else (user decision 2026-10-02: "No git needs delete."): no workspace helper runs this script.
 *
 * Git runs without hooks, without an fsmonitor, and without optional locks, so that it runs no hook and never writes to
 * `.git` as another user. It still runs other programs that the repository configuration names (for example the clean
 * filter of a filter driver in `git status`): it is no trust boundary against the repository. Review round 5 of PR #84:
 * with `log.showSignature=false` too (with it set in the repository configuration, `git stash list` ran the program of
 * `gpg.program`). Review round 2 of PR #84: in the C locale (`LC_ALL=C`, `LANG=C`, set in the script itself), so that
 * Git's messages are never translated; the counts are line counts, and paths pass through as bytes.
 *
 * Review round 4 of PR #84, A-R4-2: a stash that `refs/stash` still names while its reflog is empty (`git reflog expire
 * --expire=now --all`, a packed `refs/stash` without a reflog, or a reftable repository) is listed by no `git stash
 * list`; it counts as 1 stash then.
 */
export const GIT_SUMMARY_SCRIPT = `set -eu
export LC_ALL=C LANG=C
cd "$1"
if ! command -v git >/dev/null 2>&1; then
  echo 'Git is not installed.' >&2
  exit 127
fi
GIT_OPTIONAL_LOCKS=0
export GIT_OPTIONAL_LOCKS
g() {
  git -c safe.directory='*' -c core.hooksPath=/dev/null -c core.fsmonitor=false -c log.showSignature=false "$@"
}
count_lines() {
  if [ -z "$1" ]; then
    echo 0
  else
    printf '%s\\n' "$1" | wc -l | tr -d ' '
  fi
}
branch=$(g branch --show-current 2>/dev/null) || branch=$(g symbolic-ref --short -q HEAD) || branch=''
status=$(g status --porcelain --untracked-files=normal)
if g rev-parse -q --verify HEAD >/dev/null 2>&1; then
  unpushed=$(g rev-list --count HEAD --branches --not --remotes 2>/dev/null) || unpushed=0
else
  unpushed=$(g rev-list --count --branches --not --remotes 2>/dev/null) || unpushed=0
fi
stashes=$(g stash list)
if [ -z "$stashes" ] && g rev-parse -q --verify refs/stash >/dev/null 2>&1; then
  stashes='(stash without reflog)'
fi
printf '%s\\n%s\\n%s\\n%s\\n' "$branch" "$(count_lines "$status")" "$unpushed" "$(count_lines "$stashes")"
`;

/**
 * Review round 12 (P12-2): the most real paths that service_owner_fix adds for paths of the services behind a link;
 * beyond it, the whole repository counts as a path of the services.
 */
export const MAX_SERVICE_REAL_PATHS = 64;

/**
 * Review round 13 (D13-2): the state of SERVICE_REAL_PATHS, set once per script (never taken from the environment of
 * the process): `whole` (non-empty: the whole folder counts as a path of the services), `added` (the real paths added so
 * far, against MAX_SERVICE_REAL_PATHS), and `seen` (the real paths added so far, each between newlines).
 */
const SERVICE_REAL_PATHS_INIT = `whole=''
added=0
nl='
'
seen=$nl
`;

/**
 * Review round 12 (P12-2), review round 13 (D13-2): the resolution of the paths of the services behind links, in the
 * folder `$folder`, as shell code that works on the positional parameters (the arguments of find, servicePathArguments):
 * each path after `-path` that is not a `<path>/*` pattern is resolved in the volume (`cd -P`, a builtin, for a folder;
 * `readlink -f` otherwise), and a real path that differs, lies in the folder (not the folder itself, not in `.git`), and
 * was not added before (`seen`) is appended as `-o -path <real> -o -path <real>/*`. A path with a character that `-path`
 * reads as a pattern (then written with `\`), a real path with one or with a newline, or more than
 * MAX_SERVICE_REAL_PATHS real paths in all: `whole`. Review round 16 (L2 = D16-2): a real path in `.git` is added for
 * a path of a mount of the dev container, which servicePathArguments marks one by one with `(` before it and `)` after
 * its patterns (`mount`): the target of the mount may be a link into `.git` (`data -> .git/pg`), where Docker mounts it.
 * The marker is read only where no path can be (never right after `-path`); the text of the test starts with `1` then,
 * so that the case of `.git` does not match. It runs in service_owner_fix (at the time of the fix). The paths stay
 * arguments: no shell text is built from them.
 */
export const SERVICE_REAL_PATHS = `  here=$PWD
  previous=''
  mount=''
  for arg do
    if [ "$previous" != '-path' ] && [ "$arg" = '(' ]; then
      mount=1
    elif [ "$previous" != '-path' ] && [ "$arg" = ')' ]; then
      mount=''
    elif [ "$previous" = '-path' ]; then
      case $arg in
        */\\*) ;;
        *\\\\*) whole=1 ;;
        *)
          real=''
          if [ -d "$arg" ]; then
            if cd -P "$arg" 2>/dev/null; then real=$PWD; fi
          elif [ -e "$arg" ] || [ -L "$arg" ]; then
            real=$(readlink -f "$arg" 2>/dev/null) || real=''
          fi
          if [ -n "$real" ] && [ "$real" != "$arg" ]; then
            case $real in
              "$folder"/*)
                case "$mount/\${real#"$folder"/}/" in
                  /.git/* | /*/.git/*) ;;
                  *[[\\\\*?]* | *"$nl"*) whole=1 ;;
                  *)
                    case $seen in
                      *"$nl$real$nl"*) ;;
                      *)
                        if [ "$added" -ge ${MAX_SERVICE_REAL_PATHS} ]; then
                          whole=1
                        else
                          set -- "$@" -o -path "$real" -o -path "$real/*"
                          added=$((added + 1))
                          seen=$seen$real$nl
                        fi
                        ;;
                    esac
                    ;;
                esac
                ;;
            esac
          fi
          ;;
      esac
    fi
    previous=$arg
  done
  cd "$here" 2>/dev/null || :
`;

/**
 * Review round 10 (D10-3): the shell function `service_owner_fix <folder> <uid> <gid> <owner> <find arguments…>` of the
 * ownership fixes: `find <folder> -xdev` gives `<owner>` (`chown -h`, never the target of a link) to each file that does
 * not have the user `<uid>` and the group `<gid>`, except in the paths that other services mount (the test "in a path of
 * a service" of servicePathArguments, `"$@"`); in those, only to the files and folders of root (uid 0): the workspace
 * helper writes as root (a clone), while the data of a service (for example of
 * Postgres, uid 999) keeps its owner. A service that runs as root keeps its access to files of another owner (unless its
 * capabilities are dropped). Review round 11 (G5): the arguments come ready from servicePathArguments (built in linear
 * time), in place of the shell loop of round 9 that rebuilt `"$@"` for each pattern (quadratic: 5000 paths took 51 s).
 *
 * Review round 12 (P12-2): `find` does not follow links, so a path of a service behind a link of the repository (a mount
 * of `./data`, where `data -> storage/pg`) would not protect its data under the real path. So each path of the test (the
 * argument after `-path` that is not a `<path>/*` pattern) is resolved in the volume (`cd -P`, a builtin, for a folder;
 * `readlink -f` otherwise), and a real path that differs, lies in the folder (not the folder itself, not in `.git`), is
 * added to the test too: both paths are protected. The paths stay arguments (no shell text is built from them). A path
 * with a character that `-path` reads as a pattern (then written with `\`), a real path with one, or more than
 * MAX_SERVICE_REAL_PATHS real paths: the whole folder counts as a path of the services (only the files of root change).
 */
export const SERVICE_OWNER_FIX = `${SERVICE_REAL_PATHS_INIT}service_owner_fix() {
  folder="$1"
  fix_uid="$2"
  fix_gid="$3"
  fix_owner="$4"
  shift 4
${SERVICE_REAL_PATHS}  if [ -n "$whole" ]; then
    find "$folder" -xdev -user 0 -exec chown -h "$fix_owner" {} +
  elif [ "$#" -gt 0 ]; then
    find "$folder" -xdev \\( \\( "$@" \\) -user 0 -o ! \\( "$@" \\) \\( ! -user "$fix_uid" -o ! -group "$fix_gid" \\) \\) -exec chown -h "$fix_owner" {} +
  else
    find "$folder" -xdev \\( ! -user "$fix_uid" -o ! -group "$fix_gid" \\) -exec chown -h "$fix_owner" {} +
  fi
}
`;

/**
 * Review round 11 (G5): the most paths of the repository that the ownership fixes leave to the services (a list of
 * serviceFolderPaths). Over it, the whole repository counts as a path of the services (servicePathArguments): only the
 * files of root get their owner, so no data of a service loses its owner.
 */
export const MAX_SERVICE_FOLDERS = 1000;

/**
 * Review round 11 (G5): the most characters of the arguments of servicePathArguments. The command line of `docker exec`
 * and `docker run` on this computer holds them, together with the script (a few KiB), and so does the `execve` in the
 * container: on Windows a command line has at most 32767 characters, so 24 KiB there (about 300 paths of 30
 * characters); on Linux and macOS ARG_MAX (2 MiB on Linux, one argument at most 128 KiB; 1 MiB on macOS; both with the
 * environment) is far above 256 KiB (1000 paths of up to about 120 characters). Over it, as over MAX_SERVICE_FOLDERS,
 * the whole repository counts as a path of the services.
 */
export const MAX_SERVICE_ARGUMENT_CHARACTERS = process.platform === 'win32' ? 24 * 1024 : 256 * 1024;

/**
 * Review round 11 (G3, G5): the paths of the repository that the ownership fixes leave to the services: a list
 * (serviceFolderPaths filters it), or `'repository'`: more than MAX_SERVICE_FOLDERS, so that only the files of root in the
 * whole repository get their owner.
 */
export type ServiceFolders = readonly string[] | 'repository';

/**
 * Review round 12 (S12-1): the longest path of the services (in characters) and the most segments below the repository
 * folder of one path that the ownership fixes name one by one. A longer or deeper path counts as overflow (like more than
 * MAX_SERVICE_FOLDERS paths): the whole repository counts as a path of the services, so its data never loses its owner.
 */
export const MAX_SERVICE_PATH_LENGTH = 4096;
export const MAX_SERVICE_PATH_DEPTH = 256;

/** Review round 12 (S12-1): a path of serviceFolderPaths over MAX_SERVICE_PATH_LENGTH or MAX_SERVICE_PATH_DEPTH. */
export function isOverlongServicePath(repoFolder: string, folder: string): boolean {
  if (folder.length > MAX_SERVICE_PATH_LENGTH) return true;
  let depth = 1;
  for (let i = folder.indexOf('/', repoFolder.length + 1); i !== -1; i = folder.indexOf('/', i + 1)) {
    if (++depth > MAX_SERVICE_PATH_DEPTH) return true;
  }
  return false;
}

/**
 * Review round 16 (L2 = D16-2): which paths of a list are targets of the mounts of the dev container (devMountFolders):
 * all (`true`), none (`false`), or those of the set. They keep a place in `.git` (serviceFolderPaths), and
 * servicePathArguments marks each of them for the resolution of links in SERVICE_REAL_PATHS, which then keeps a real
 * path in `.git` for them (and only for them).
 */
export type DevMountPaths = boolean | ReadonlySet<string>;

function isDevMountPath(paths: DevMountPaths, folder: string): boolean {
  return typeof paths === 'boolean' ? paths : paths.has(folder);
}

interface PathNode {
  children?: Map<string, PathNode>;
  terminal?: boolean;
}

/**
 * Review round 9 (D9-1): of `folders`, the paths of the repository that the other services of Docker Compose mount
 * (Environment.serviceFolders), which the ownership fixes leave out with their content: a service such as a database
 * gives its data files its own owner, and would not start with others. Only absolute paths below `repoFolder` (never the
 * folder itself, which would leave out everything); review round 10 (D10-3): never `.git` or a path in it, where Git
 * writes as root. Review round 11 (G5): without duplicates, and without a path below
 * another path of the list (its test `-path <path>/*` covers it). In the order of `folders`. Review round 12 (S12-1):
 * linear in the total length of the paths (a tree of their segments, in place of a lookup of each ancestor); a path over
 * MAX_SERVICE_PATH_LENGTH or MAX_SERVICE_PATH_DEPTH (isOverlongServicePath) stays in the list unless a path of the list
 * covers it, and makes the callers treat the list as overflow (boundServiceFolders, servicePathArguments).
 * Review round 15 (K4 = D15-2): `gitPaths` keeps paths in `.git` for the targets of the mounts of the dev container
 * (devMountFolders, for example a volume that db shares at `.git/pg`, or a bind of the computer at `.git/hooks`): they
 * are mounts, not records of the services, and the fix would otherwise give their files to the remote user. Only the
 * callers of those targets set it; the records of the services keep the filter. Review round 16 (L2 = D16-2): `gitPaths`
 * may name the targets one by one (DevMountPaths), so that the records of the services in the same list keep the filter.
 */
export function serviceFolderPaths(repoFolder: string, folders: readonly string[] | undefined, gitPaths: DevMountPaths = false): string[] {
  // Segments without a place in the list: empty, `.`, `..`, `.git` (review round 15, K4: except for `gitPaths`).
  const withGit = /(?:^|\/)(?:|\.|\.\.)(?:\/|$)/;
  const withoutGit = /(?:^|\/)(?:|\.|\.\.|\.git)(?:\/|$)/;
  const valid: Array<{ folder: string; segments: string[] | undefined }> = [];
  const seen = new Set<string>();
  for (const folder of folders ?? []) {
    if (typeof folder !== 'string' || folder.includes('\0') || !folder.startsWith(`${repoFolder}/`) || seen.has(folder)) continue;
    const relative = folder.slice(repoFolder.length + 1);
    if ((isDevMountPath(gitPaths, folder) ? withGit : withoutGit).test(relative)) continue;
    seen.add(folder);
    // A path over the bounds is not split: it never covers another one (it is never an ancestor of one within the
    // bounds, and the callers treat the list as overflow anyway), so only the paths within the bounds go into the tree.
    valid.push({ folder, segments: isOverlongServicePath(repoFolder, folder) ? undefined : relative.split('/') });
  }
  const root: PathNode = {};
  for (const { segments } of valid) {
    if (segments === undefined) continue;
    let node = root;
    for (const segment of segments) {
      node.children ??= new Map();
      let child = node.children.get(segment);
      if (child === undefined) node.children.set(segment, (child = {}));
      node = child;
    }
    node.terminal = true;
  }
  // Whether a path of the list is an ancestor of `folder`: a walk down the tree along its segments (for a path over the
  // bounds, one segment at a time from the string, at most MAX_SERVICE_PATH_DEPTH of them).
  const covered = ({ folder, segments }: { folder: string; segments: string[] | undefined }): boolean => {
    let node: PathNode | undefined = root;
    if (segments !== undefined) {
      for (let i = 0; i < segments.length - 1; i++) {
        node = node.children?.get(segments[i]);
        if (node === undefined) return false;
        if (node.terminal) return true;
      }
      return false;
    }
    let start = repoFolder.length + 1;
    for (let depth = 0; depth < MAX_SERVICE_PATH_DEPTH; depth++) {
      const end = folder.indexOf('/', start);
      if (end === -1) return false;
      node = node.children?.get(folder.slice(start, end));
      if (node === undefined) return false;
      if (node.terminal) return true;
      start = end + 1;
    }
    return false;
  };
  return valid.filter((entry) => !covered(entry)).map((entry) => entry.folder);
}

/**
 * Review round 9 (D9-1): the `find -path` patterns of serviceFolderPaths: the characters that `-path` reads as a pattern
 * (`*`, `?`, `[`, `\\`) are escaped, so each pattern matches only its path.
 */
export function servicePrunePatterns(repoFolder: string, folders: readonly string[] | undefined): string[] {
  return serviceFolderPaths(repoFolder, folders).map(findPathPattern);
}

/**
 * Review round 11 (G3, G5): the paths of `groups` (in their order: the paths of the model and those that containers
 * mount first, then the recorded ones), as serviceFolderPaths filters them, at most MAX_SERVICE_FOLDERS. `overflow`: there
 * were more (or `overflow` was set before, since the paths beyond the bound are not recorded): the ownership fixes then
 * leave the whole repository to the services (`'repository'`, ServiceFolders). `gitPaths`: as in serviceFolderPaths
 * (review round 15, K4).
 */
export function boundServiceFolders(
  repoFolder: string,
  groups: ReadonlyArray<readonly string[] | undefined>,
  overflow = false,
  gitPaths: DevMountPaths = false,
): { folders: string[]; overflow: boolean } {
  const paths = serviceFolderPaths(repoFolder, groups.flatMap((group) => group ?? []), gitPaths);
  // Review round 12 (S12-1): a path over the bounds is overflow; it is not recorded (the recorded overflow covers it).
  const within = paths.filter((path) => !isOverlongServicePath(repoFolder, path));
  return {
    folders: within.slice(0, MAX_SERVICE_FOLDERS),
    overflow: overflow || within.length > MAX_SERVICE_FOLDERS || within.length < paths.length,
  };
}

/** Escapes the characters that `find -path` reads as a pattern (`*`, `?`, `[`, `\`), so a pattern matches only its path. */
function findPathPattern(path: string): string {
  return path.replace(/[\\*?[]/g, '\\$&');
}

/**
 * Review round 9 (D9-1), round 11 (G5): the arguments of `find` of the test "in a path of a service" for
 * service_owner_fix, `-path <pattern> -o -path <pattern>/* -o …` (without parentheses; none without paths), each pattern
 * one argument (never shell text), built in linear time. With `'repository'`, more than MAX_SERVICE_FOLDERS paths, a
 * path over the bounds of isOverlongServicePath (review round 12, S12-1), or more than MAX_SERVICE_ARGUMENT_CHARACTERS
 * characters: the test of the whole repository folder, so that only the files
 * of root get their owner. Review round 16 (L2 = D16-2): the patterns of each path of `gitPaths` (a target of a mount of
 * the dev container) stand between the arguments `(` and `)`, which change nothing for `find` and tell SERVICE_REAL_PATHS
 * that a real path of it in `.git` is kept.
 */
export function servicePathArguments(repoFolder: string, folders: ServiceFolders | undefined, gitPaths: DevMountPaths = false): string[] {
  const whole = () => ['-path', findPathPattern(repoFolder), '-o', '-path', `${findPathPattern(repoFolder)}/*`];
  if (folders === 'repository') return whole();
  const paths = serviceFolderPaths(repoFolder, folders, gitPaths);
  if (paths.length > MAX_SERVICE_FOLDERS || paths.some((path) => isOverlongServicePath(repoFolder, path))) return whole();
  const args: string[] = [];
  let characters = 0;
  for (const path of paths) {
    const pattern = findPathPattern(path);
    if (args.length > 0) args.push('-o');
    if (isDevMountPath(gitPaths, path)) args.push('(', '-path', pattern, '-o', '-path', `${pattern}/*`, ')');
    else args.push('-path', pattern, '-o', '-path', `${pattern}/*`);
    characters += 2 * pattern.length + 24;
    if (characters > MAX_SERVICE_ARGUMENT_CHARACTERS) return whole();
  }
  return args;
}

/**
 * Review round 11 (G3): prints each of the paths `$1`… that exists (also a link that leads nowhere), each followed by a
 * NUL character. Runs as root, so that a folder of a service that others may not read does not hide a path.
 */
export const EXISTING_PATHS_SCRIPT = `for p do
  if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\\0' "$p"; fi
done
`;

/** Review round 11 (G3): the command of EXISTING_PATHS_SCRIPT for `docker exec -u root`. */
export function existingPathsCommand(paths: readonly string[]): string[] {
  return ['sh', '-c', EXISTING_PATHS_SCRIPT, 'sh', ...paths];
}

/** Review round 11 (G3): the paths of the output of EXISTING_PATHS_SCRIPT. */
export function parseExistingPaths(stdout: string): string[] {
  return stdout.split('\0').filter((path) => path !== '');
}

/**
 * Changes the owner of every file in `$1` that does not belong to the user `$2` (and its primary group) to that user.
 * `chown -h` changes a symbolic link itself, never its target, and `-xdev` stays out of other file systems (a bind mount
 * of the computer, a tmpfs). Review round 12 (D12-2): not out of a local named volume that the dev container mounts
 * below `$1`, which lies on the file system of the workspace volume: the fix after `up` passes such mounts as paths of
 * the test (EnvironmentService.withDevMountFolders, devMountFolders). Review round 9 (D9-1): the paths of the test
 * `$3`… (servicePathArguments) and their content are left out; review round 10 (D10-3): except their files and folders
 * of root (SERVICE_OWNER_FIX); review round 12 (P12-2): also their real paths behind links. Works with GNU and BusyBox
 * tools.
 */
export const OWNERSHIP_FIX_SCRIPT = `set -eu
dir="$1"
uid=$(id -u "$2")
gid=$(id -g "$2")
shift 2
${SERVICE_OWNER_FIX}service_owner_fix "$dir" "$uid" "$gid" "$uid:$gid" "$@"
`;

/**
 * Review round 15 (K3 = P15-1, D15-1, S15-3): gives every file in the folder `$1` that does not have the user `$2` and
 * the group `$3` (numbers) that owner (service_owner_fix without paths of services: `find -xdev`, `chown -h`). For the
 * extension's internal folder (CONFIG_FOLDER), run in a container of the workspace helper that mounts only the workspace
 * volume (WorkspaceHelper.fixConfigOwnership), not in the dev container: there, a mount of the dev container (through a
 * link of the repository, `volumes_from`, or a tmpfs) can lie in the folder, and the fix would give its files (for
 * example the data of a database) to the remote user. The helper sees the folder of the volume itself. A link or a
 * missing folder in place of `$1` is not walked (exit code 1).
 */
export const CONFIG_OWNERSHIP_FIX_SCRIPT = `set -eu
if [ -L "$1" ] || [ ! -d "$1" ]; then
  echo "$1 is not a folder." >&2
  exit 1
fi
${SERVICE_OWNER_FIX}service_owner_fix "$1" "$2" "$3" "$2:$3"
`;

/** Review round 15 (K3): a user or group ID as `id -u` and `id -g` print it: a decimal number below 2^32 - 1. */
export function isNumericId(text: string): boolean {
  return /^(0|[1-9][0-9]{0,9})$/.test(text) && Number(text) < 4294967295;
}

/**
 * Review round 15 (K3): the command of CONFIG_OWNERSHIP_FIX_SCRIPT for the folder `folder` and the numeric IDs `uid` and
 * `gid` (isNumericId; throws for anything else).
 */
export function configOwnershipFixCommand(folder: string, uid: string, gid: string): string[] {
  if (!isNumericId(uid) || !isNumericId(gid)) throw new Error(`Invalid user or group ID: ${JSON.stringify(uid)}:${JSON.stringify(gid)}`);
  return ['sh', '-c', CONFIG_OWNERSHIP_FIX_SCRIPT, 'sh', folder, uid, gid];
}

/**
 * Parses the output of GIT_SUMMARY_SCRIPT. Uses the last 4 lines, so that a banner before them does no harm.
 * Throws when the output does not have this form.
 */
export function parseGitSummaryOutput(stdout: string, recordedAt: string): GitSummary {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 4) {
    throw new Error(`Unexpected output of the Git summary: ${JSON.stringify(stdout.slice(0, 200))}`);
  }
  const [branchLine, uncommittedLine, unpushedLine, stashesLine] = lines.slice(-4);
  const numbers = [uncommittedLine, unpushedLine, stashesLine].map((line) => {
    const text = line.trim();
    if (!/^\d+$/.test(text)) {
      throw new Error(`Unexpected output of the Git summary: ${JSON.stringify(stdout.slice(0, 200))}`);
    }
    return Number(text);
  });
  const branch = branchLine.trim();
  return {
    branch: branch === '' ? null : branch,
    uncommittedFiles: numbers[0],
    unpushedCommits: numbers[1],
    stashes: numbers[2],
    recordedAt,
  };
}

/** Command for `docker exec` in a running dev container: `['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', folder]`. */
export function gitSummaryCommand(repoFolder: string): string[] {
  return ['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', repoFolder];
}

/**
 * Command for `docker exec -u root` in the dev container after its first creation (implementation notes 7 "Ownership"):
 * the helper clones as root, so the files get the user and the primary group of `remoteUser`. `gitPaths`: as in
 * serviceFolderPaths (review round 15, K4), for a list that holds the targets of the mounts of the dev container; review
 * round 16 (L2): the set of those targets, when the list holds the paths of the services too.
 */
export function ownershipFixCommand(repoFolder: string, user: string, serviceFolders?: ServiceFolders, gitPaths: DevMountPaths = false): string[] {
  return ['sh', '-c', OWNERSHIP_FIX_SCRIPT, 'sh', repoFolder, user, ...servicePathArguments(repoFolder, serviceFolders, gitPaths)];
}
