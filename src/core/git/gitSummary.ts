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
 * Changes the owner of every file in `$1` that does not belong to the user `$2` (and its primary group) to that user.
 * `chown -h` changes a symbolic link itself, never its target, and `-xdev` stays out of other mounts, so that no file
 * outside of the workspace volume changes. Works with GNU and BusyBox tools.
 */
export const OWNERSHIP_FIX_SCRIPT = `set -eu
uid=$(id -u "$2")
gid=$(id -g "$2")
find "$1" -xdev \\( ! -user "$uid" -o ! -group "$gid" \\) -exec chown -h "$uid:$gid" {} +
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
export function ownershipFixCommand(repoFolder: string, user: string): string[] {
  return ['sh', '-c', OWNERSHIP_FIX_SCRIPT, 'sh', repoFolder, user];
}
