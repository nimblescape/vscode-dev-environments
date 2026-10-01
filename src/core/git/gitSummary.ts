// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Git state of a repository folder (implementation notes 10). The scripts run with `sh -c <script> sh <args…>`,
// either in the workspace helper or with `docker exec` in a dev container. Values arrive as positional parameters.
import type { GitSummary, UnknownGitState } from '../types';

/**
 * Review round 1 of PR #84, A-R1-2: the exit code of GIT_SUMMARY_SCRIPT when the repository folder is missing (or no
 * folder): Delete's check then names the recorded state, as before. Every other failure leaves the Git state unknown.
 */
export const GIT_SUMMARY_NO_FOLDER_EXIT = 3;

/**
 * Review round 2 of PR #84, A-R2-2: the exit code of the gitSummary step when GIT_SUMMARY_SCRIPT exited with
 * GIT_SUMMARY_NO_FOLDER_EXIT but root sees a folder there (the batch helper checks it, asRepositoryOwner): the folder
 * is not reachable for the step's user (`[ -d ]` is false on EACCES too), so the Git state is unknown, not missing.
 */
export const GIT_SUMMARY_UNREACHABLE_EXIT = 4;

/**
 * Review round 2 of PR #84, A-R2-1: the second argument of GIT_SUMMARY_SCRIPT for Delete's check: the script then
 * checks that its user can read every file and folder of the repository (`.git` too).
 */
export const GIT_SUMMARY_COMPLETE = 'complete';

/**
 * Review round 1 of PR #84, A-R1-2: the start of the line that GIT_SUMMARY_SCRIPT prints before its 4 lines when a
 * count could not be made (the rest of the line says which); parseGitSummaryOutput ignores it (it reads the last 4).
 */
export const GIT_SUMMARY_INCOMPLETE_MARKER = 'devenv-git-summary-incomplete:';

/**
 * Review round 3 of PR #84, A-R3-5: the most folders that Git ignores which the readability walk of Delete's check
 * leaves out (GIT_SUMMARY_SCRIPT); the folders beyond it are walked (a folder that cannot be read then still makes the
 * state unknown: never less safe, only less quiet).
 */
export const GIT_SUMMARY_MAX_PRUNED_FOLDERS = 256;

/**
 * Review round 5 of PR #84, A-R5-2: the text of GIT_SUMMARY_INCOMPLETE_MARKER for tracked files that `git status` does
 * not compare with the working tree (GIT_SUMMARY_SCRIPT).
 */
export const GIT_SUMMARY_FLAGGED_FILES = 'files marked assume-unchanged or skip-worktree are not checked';

/**
 * Prints 4 lines: the branch (empty for a detached HEAD), the number of `git status --porcelain` lines, the number of
 * commits on HEAD or on any local branch that no remote-tracking branch contains, and the number of stashes. `$1` is the
 * repository folder. The unpushed commits include those of every local branch (concept 7.5, 7.14 step 1): the volume
 * keeps them, and Delete removes them.
 *
 * Git runs without hooks, without an fsmonitor, and without optional locks, so that it runs no hook and never writes to
 * `.git` as another user. It still runs other programs that the repository configuration names (for example the clean
 * filter of a filter driver in `git status`). So the workspace helper runs this script without the Docker socket, without
 * the cache volume, and without network (WorkspaceHelper.gitSummary): it is no trust boundary against the repository.
 *
 * Review round 1 of PR #84, A-R1-2: a missing repository folder exits with GIT_SUMMARY_NO_FOLDER_EXIT. The warnings of
 * `git status` and `git stash list` reach stderr (a folder that Git cannot open: `could not open directory … Permission
 * denied`, with exit code 0); a count of unpushed commits that fails prints GIT_SUMMARY_INCOMPLETE_MARKER (it counted
 * 0 before, silently). Delete's check reads both as an unknown state (gitSummaryProblem).
 *
 * Review round 2 of PR #84, A-R2-1: Git skips without a word what it cannot read in `.git` (a root 0600 `refs/stash`
 * counts as no stash; a `refs/heads` that cannot be listed hides its branches). With `$2` GIT_SUMMARY_COMPLETE (Delete's
 * check; not the monitor's polls, for the cost of the walk) the script ends with one walk of the repository folder, its
 * working tree and `.git`, as its user: a file or folder that it cannot read (a folder it cannot list or enter: the
 * folder, or the entries below it), or a walk that fails, prints GIT_SUMMARY_INCOMPLETE_MARKER. Links are not tested
 * (`access` follows them; Git does not). One file system (`-xdev`), as Git's own walk of the working tree.
 *
 * Hardening (LC_ALL), review round 2 of PR #84: the script runs Git (and find, tr, wc) in the C locale (`LC_ALL=C`,
 * `LANG=C`, set in the script itself, never with `docker exec -e`), so that Git's messages on stderr are never
 * translated and the patterns of gitSummaryProblem always match. Nothing else in the script depends on the locale: the
 * counts are line counts, and paths pass through as bytes.
 *
 * Review round 3 of PR #84 (decision D1: what the check cannot vouch for is never reported clean): the unpushed
 * commits are those of HEAD and of every local branch that no remote-tracking branch contains; commits that only the
 * reflog or a tag still reaches (for example of a deleted branch) are not counted, by decision (review round 4 of PR
 * #84, A-R4-1: a clone fetches every tag of the upstream, and a tag on a commit that no remote branch contains made an
 * untouched clone show unpushed commits for good). With `$2`
 * GIT_SUMMARY_COMPLETE, after the walk, GIT_SUMMARY_INCOMPLETE_MARKER is printed for submodules (a `.gitmodules`, or a
 * non-empty `modules` folder in the Git folder: their commits, stashes and changes are not counted; A-R3-1), for other
 * worktrees (a non-empty `worktrees` folder: their changes and detached commits are not counted; A-R3-2), and for a
 * stash that exists (`refs/stash`, or a non-empty reflog of it) but that Git cannot resolve (A-R3-3). A-R3-5: the walk
 * leaves out the working-tree folders that Git ignores (`git ls-files -o -i --exclude-standard --directory`, for
 * example the data folder of a database), at most GIT_SUMMARY_MAX_PRUNED_FOLDERS; `.git` is always walked in full. A
 * name that Git quotes (a control character, `"` or `\`) or with a character that `-path` reads as a pattern is not
 * left out (it is walked). The names pass to find as positional parameters (`-path ./<name>`), never as shell text.
 *
 * Review round 4 of PR #84, A-R4-2: a stash that `refs/stash` still names while its reflog is empty (`git reflog expire
 * --expire=now --all`, a packed `refs/stash` without a reflog, or a reftable repository) is listed by no `git stash
 * list`; in every mode it counts as 1 stash then (whatever the ref backend).
 *
 * Review round 5 of PR #84, A-R5-2: `git status` does not compare files marked assume-unchanged (`git update-index
 * --assume-unchanged`, or every file with `core.ignoreStat`) or skip-worktree with the working tree, so their edits
 * counted as clean. With `$2` GIT_SUMMARY_COMPLETE, after the checks above, GIT_SUMMARY_INCOMPLETE_MARKER
 * (GIT_SUMMARY_FLAGGED_FILES) is printed when `git ls-files -v` lists a file with a lowercase tag (assume-unchanged),
 * or a file tagged `S` (skip-worktree) that exists in the working tree (a name that Git quotes counts as existing); a
 * skip-worktree file that is absent (sparse checkout) is not. A failing `git ls-files` (or grep) prints the marker
 * too. Git runs with `log.showSignature=false` too (review round 5 of PR #84): with it set in the repository
 * configuration, `git stash list` ran the program of `gpg.program`.
 */
export const GIT_SUMMARY_SCRIPT = `set -eu
export LC_ALL=C LANG=C
if [ ! -d "$1" ]; then
  echo "The repository folder $1 is missing." >&2
  exit ${GIT_SUMMARY_NO_FOLDER_EXIT}
fi
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
incomplete=''
if g rev-parse -q --verify HEAD >/dev/null 2>&1; then
  unpushed=$(g rev-list --count HEAD --branches --not --remotes) || { unpushed=0; incomplete='the unpushed commits could not be counted'; }
else
  unpushed=$(g rev-list --count --branches --not --remotes) || { unpushed=0; incomplete='the unpushed commits could not be counted'; }
fi
stashes=$(g stash list)
if [ -z "$stashes" ] && g rev-parse -q --verify refs/stash >/dev/null 2>&1; then
  stashes='(stash without reflog)'
fi
if [ "\${2:-}" = '${GIT_SUMMARY_COMPLETE}' ] && [ -z "$incomplete" ]; then
  set --
  ignored=$(g -c core.quotePath=false ls-files -o -i --exclude-standard --directory 2>/dev/null) || ignored=''
  pruned=0
  set -f
  IFS='
'
  for entry in $ignored; do
    case $entry in
      '"'* | *[[\\\\*?]*) ;;
      ?*/)
        if [ "$pruned" -lt ${GIT_SUMMARY_MAX_PRUNED_FOLDERS} ]; then
          if [ "$pruned" -gt 0 ]; then set -- "$@" -o; fi
          set -- "$@" -path "./\${entry%/}"
          pruned=$((pruned + 1))
        fi
        ;;
    esac
  done
  unset IFS
  set +f
  if [ "$#" -gt 0 ]; then set -- '(' "$@" ')' -prune -o; fi
  if ! unreadable=$(find . -xdev "$@" ! -type l ! -readable -print -quit); then
    incomplete='not every file and folder of the repository could be read'
  elif [ -n "$unreadable" ]; then
    incomplete="$(printf '%s' "\${unreadable#./}" | tr '\\n' ' ') cannot be read"
  fi
  if [ -z "$incomplete" ]; then
    gitdir=$(g rev-parse --git-common-dir)
    if [ -z "$gitdir" ]; then
      incomplete='the Git folder could not be found'
    elif [ -e .gitmodules ] || [ -L .gitmodules ] || [ -n "$(ls -A -- "$gitdir/modules" 2>/dev/null)" ]; then
      incomplete='submodules are not checked'
    elif [ -n "$(ls -A -- "$gitdir/worktrees" 2>/dev/null)" ]; then
      incomplete='other worktrees are not checked'
    elif { [ -e "$gitdir/refs/stash" ] || [ -s "$gitdir/logs/refs/stash" ]; } && ! g rev-parse -q --verify refs/stash >/dev/null 2>&1; then
      incomplete='the stash could not be read'
    fi
  fi
  if [ -z "$incomplete" ]; then
    if ! tracked=$(g -c core.quotePath=false ls-files -v); then
      incomplete='${GIT_SUMMARY_FLAGGED_FILES}'
    else
      flagged=$(printf '%s\\n' "$tracked" | grep '^[a-zS] ') || [ "$?" -eq 1 ] || flagged='?'
      set -f
      IFS='
'
      for line in $flagged; do
        case $line in
          'S "'*)
            incomplete='${GIT_SUMMARY_FLAGGED_FILES}'
            break
            ;;
          'S '*)
            if [ -e "\${line#S }" ] || [ -L "\${line#S }" ]; then
              incomplete='${GIT_SUMMARY_FLAGGED_FILES}'
              break
            fi
            ;;
          *)
            incomplete='${GIT_SUMMARY_FLAGGED_FILES}'
            break
            ;;
        esac
      done
      unset IFS
      set +f
    fi
  fi
fi
if [ -n "$incomplete" ]; then
  printf '%s %s\\n' '${GIT_SUMMARY_INCOMPLETE_MARKER}' "$incomplete"
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

/**
 * Review round 1 of PR #84, A-R1-2: the problems on stderr of GIT_SUMMARY_SCRIPT that mean Git could not read everything
 * (with exit code 0 Git counts what it could read: an untracked folder that it cannot open counts as no change).
 */
const GIT_PERMISSION_PROBLEM = /Permission denied|could not open directory|unable to access|cannot open/i;

/** The longest problem text that gitSummaryProblem returns. */
const MAX_PROBLEM_LENGTH = 300;

/**
 * Review round 1 of PR #84, A-R1-2: why the output of GIT_SUMMARY_SCRIPT does not show the whole Git state: the first
 * line of `stderr` with a permission problem, or the incomplete count that `stdout` names. Undefined when there is none.
 */
export function gitSummaryProblem(stdout: string, stderr: string): string | undefined {
  const lines = (text: string) => text.replace(/\r\n/g, '\n').split('\n');
  const permission = lines(stderr).find((line) => GIT_PERMISSION_PROBLEM.test(line));
  if (permission !== undefined) return permission.trim().slice(0, MAX_PROBLEM_LENGTH);
  const marker = lines(stdout).find((line) => line.startsWith(GIT_SUMMARY_INCOMPLETE_MARKER));
  return marker?.slice(GIT_SUMMARY_INCOMPLETE_MARKER.length).trim().slice(0, MAX_PROBLEM_LENGTH);
}

/**
 * Review round 1 of PR #84, A-R1-2: watches the stderr of GIT_SUMMARY_SCRIPT as it streams, line by line (the captured
 * stderr keeps only its end), for the first permission problem (gitSummaryProblem).
 */
export class GitProblemWatcher {
  private rest = '';
  private found: string | undefined;

  push(text: string): void {
    if (this.found !== undefined) return;
    const lines = (this.rest + text).split('\n');
    this.rest = (lines.pop() ?? '').slice(-4096);
    this.found = gitSummaryProblem('', lines.join('\n'));
  }

  /** The first problem seen, also in a last line without its newline. */
  problem(): string | undefined {
    return this.found ?? gitSummaryProblem('', this.rest);
  }
}

/** Review round 1 of PR #84, A-R1-2: whether Delete's check could not read the Git state. */
export function isUnknownGitState(value: GitSummary | UnknownGitState | undefined): value is UnknownGitState {
  return value !== undefined && 'unknown' in value && value.unknown === true;
}

/**
 * Command for `docker exec` in a running dev container: `['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', folder]`. Review round 2
 * of PR #84, A-R2-1: `complete` (Delete's check) adds GIT_SUMMARY_COMPLETE, the check that every file can be read.
 */
export function gitSummaryCommand(repoFolder: string, complete = false): string[] {
  return complete ? ['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', repoFolder, GIT_SUMMARY_COMPLETE] : ['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', repoFolder];
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
