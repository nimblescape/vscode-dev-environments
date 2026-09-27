// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Git state of a repository folder (implementation notes 10). The scripts run with `sh -c <script> sh <args…>`,
// either in the workspace helper or with `docker exec` in a dev container. Values arrive as positional parameters.
import type { GitSummary } from '../types';

/**
 * Prints 4 lines: the branch (empty for a detached HEAD), the number of `git status --porcelain` lines, the number of
 * commits on HEAD or on any local branch that no remote-tracking branch contains, and the number of stashes. `$1` is the
 * repository folder. The unpushed commits include the branches that Switch branch… left (concept 7.5, 7.14 step 1):
 * the volume keeps them, and Delete removes them.
 *
 * Git runs without hooks, without an fsmonitor, and without optional locks, so that it runs no hook and never writes to
 * `.git` as another user. It still runs other programs that the repository configuration names (for example the clean
 * filter of a filter driver in `git status`). So the workspace helper runs this script without the Docker socket, without
 * the cache volume, and without network (WorkspaceHelper.gitSummary): it is no trust boundary against the repository.
 */
export const GIT_SUMMARY_SCRIPT = `set -eu
cd "$1"
if ! command -v git >/dev/null 2>&1; then
  echo 'Git is not installed.' >&2
  exit 127
fi
GIT_OPTIONAL_LOCKS=0
export GIT_OPTIONAL_LOCKS
g() {
  git -c safe.directory='*' -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"
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
printf '%s\\n%s\\n%s\\n%s\\n' "$branch" "$(count_lines "$status")" "$unpushed" "$(count_lines "$stashes")"
`;

/**
 * Review round 9 (D9-1): shell text that turns the positional parameters (the patterns of servicePrunePatterns) into
 * arguments of `find`, each pattern one argument (never shell text). Review round 10 (D10-3): the test "in a path of a
 * service", `-path <pattern> -o -path <pattern>/* -o …` (without parentheses; empty without patterns), in place of
 * `-path <pattern> -prune -o`: the ownership fixes still go into these paths, for the files of root (SERVICE_OWNER_FIX).
 * After it, `"$@"` holds these arguments only. The `for` list is expanded once, before `set --` changes the parameters.
 */
export const SERVICE_PATH_ARGUMENTS = `count=$#
for pattern do
  if [ "$#" -gt "$count" ]; then set -- "$@" -o; fi
  set -- "$@" -path "$pattern" -o -path "$pattern/*"
done
shift "$count"
`;

/**
 * Review round 10 (D10-3): the shell function `service_owner_fix <folder> <uid> <gid> <owner>` of the ownership fixes,
 * after SERVICE_PATH_ARGUMENTS: `find <folder> -xdev` gives `<owner>` (`chown -h`, never the target of a link) to each
 * file that does not have the user `<uid>` and the group `<gid>`, except in the paths that other services mount
 * (`"$@"`); in those, only to the files and folders of root (uid 0): the workspace helper writes as root (a clone, the
 * `git switch` of Switch branch…), while the data of a service (for example of Postgres, uid 999) keeps its owner. A
 * service that runs as root keeps its access to files of another owner (unless its capabilities are dropped).
 */
export const SERVICE_OWNER_FIX = `service_owner_fix() {
  folder="$1"
  fix_uid="$2"
  fix_gid="$3"
  fix_owner="$4"
  shift 4
  if [ "$#" -gt 0 ]; then
    find "$folder" -xdev \\( \\( "$@" \\) -user 0 -o ! \\( "$@" \\) \\( ! -user "$fix_uid" -o ! -group "$fix_gid" \\) \\) -exec chown -h "$fix_owner" {} +
  else
    find "$folder" -xdev \\( ! -user "$fix_uid" -o ! -group "$fix_gid" \\) -exec chown -h "$fix_owner" {} +
  fi
}
`;

/**
 * Review round 9 (D9-1): the `find -path` patterns of the paths of the repository that the other services of Docker
 * Compose mount (ComposeBuildRecord.serviceFolders), which the ownership fixes leave out with their content: a service
 * such as a database gives its data files its own owner, and would not start with others. Only absolute paths below
 * `repoFolder` (never the folder itself, which would leave out everything); the characters that `-path` reads as a
 * pattern (`*`, `?`, `[`, `\\`) are escaped, so each pattern matches only its path. Review round 10 (D10-3): never
 * `.git` or a path in it (also of a record written before), where Git writes as root.
 */
export function servicePrunePatterns(repoFolder: string, folders: readonly string[] | undefined): string[] {
  const patterns = new Set<string>();
  for (const folder of folders ?? []) {
    if (typeof folder !== 'string' || folder.includes('\0') || !folder.startsWith(`${repoFolder}/`)) continue;
    const segments = folder.slice(repoFolder.length + 1).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git')) continue;
    patterns.add(folder.replace(/[\\*?[]/g, '\\$&'));
  }
  return [...patterns];
}

/**
 * Changes the owner of every file in `$1` that does not belong to the user `$2` (and its primary group) to that user.
 * `chown -h` changes a symbolic link itself, never its target, and `-xdev` stays out of other mounts, so that no file
 * outside of the workspace volume changes. Review round 9 (D9-1): the paths of the patterns `$3`… (servicePrunePatterns)
 * and their content are left out; review round 10 (D10-3): except their files and folders of root (SERVICE_OWNER_FIX).
 * Works with GNU and BusyBox tools.
 */
export const OWNERSHIP_FIX_SCRIPT = `set -eu
dir="$1"
uid=$(id -u "$2")
gid=$(id -g "$2")
shift 2
${SERVICE_OWNER_FIX}${SERVICE_PATH_ARGUMENTS}service_owner_fix "$dir" "$uid" "$gid" "$uid:$gid" "$@"
`;

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
 * the helper clones as root, so the files get the user and the primary group of `remoteUser`.
 */
export function ownershipFixCommand(repoFolder: string, user: string, serviceFolders?: readonly string[]): string[] {
  return ['sh', '-c', OWNERSHIP_FIX_SCRIPT, 'sh', repoFolder, user, ...servicePrunePatterns(repoFolder, serviceFolders)];
}
