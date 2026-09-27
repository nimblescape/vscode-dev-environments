// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 15: the token of the owner account only in the memory of the dev container (concept section 9 "Git inside the
// container"). The token file and the sign-in of the GitHub CLI are in the tmpfs TOKEN_FOLDER of the dev container, which
// the override configuration adds (TOKEN_TMPFS). The extension writes them with `docker exec -i -u root` after each start
// of an open (the container runs then), with the token on standard input only: never on a command line, in a variable
// of the container, or in a log. They are gone when the container stops; a start without a window of the extension (the
// Session Monitor, `docker start`) leaves the folder empty until the next open. No vscode import.
import type { RunResult } from '../ports';
import { GH_CONFIG_FOLDER, GH_HOSTS_FILE, GH_VOLUME_CONFIG_FILE, GITHUB_TOKEN_FILE, TOKEN_FOLDER } from '../names';
import { isGitHubLogin } from './containerGit';

/**
 * Shell code (POSIX sh, no awk) that ends with exit code 3 unless the top-most mount at TOKEN_FOLDER is a tmpfs (the last
 * line of /proc/mounts with that mount point): a link or a mount of the image or of the repository that moved the
 * folder (for example into the workspace volume) or lies over it is never written to. Sets nothing else.
 */
const REQUIRE_TMPFS = `dir='${TOKEN_FOLDER}'
fstype=''
while read -r _source mountpoint type _rest; do
  if [ "$mountpoint" = "$dir" ]; then fstype="$type"; fi
done < /proc/mounts
if [ "$fstype" != tmpfs ]; then
  printf '%s is not a tmpfs mount of the container.\\n' "$dir" >&2
  exit 3
fi
`;

/**
 * `$1` = the remote user (a name, or a numeric user ID), `$2` = the GitHub login of the account that owns the environment
 * (isGitHubLogin; empty when it is not known or the token cannot go into hosts.yml). Token on stdin. Runs as root in the
 * dev container (`docker exec -i -u root`). Only when TOKEN_FOLDER is a tmpfs (REQUIRE_TMPFS):
 * - the folder gets root and mode 0700 and is emptied, so no process of the user can change it while it is written (an
 *   old token, a link that the user put there, everything goes);
 * - github-token (GITHUB_TOKEN_FILE): the token from stdin, mode 0600;
 * - gh/ (GH_CONFIG_FOLDER, GH_CONFIG_DIR of the container), mode 0700, with hosts.yml (GH_HOSTS_FILE, mode 0600): the
 *   sign-in of the GitHub CLI as `$2`, in both forms that gh reads (the keys `oauth_token`, `user`, and `git_protocol` of
 *   the host for gh before 2.40 and the active account of gh 2.40 and newer, and `users.<login>.oauth_token`). The token
 *   goes into it with `cat` of the token file, never as an argument of a program. Without a login, or with a token that
 *   has characters that YAML would need to escape, gh is signed in nowhere (no hosts.yml); Git still works;
 * - gh/config.yml: a link to GH_VOLUME_CONFIG_FILE, the settings of gh in the volume (no secret);
 * - all of it, and last the folder itself, get the user and group of `$1` (`id -u`, `id -g`; a numeric user as it is).
 * On a failure after the check of the tmpfs, the folder is emptied again. Exit codes: 2 invalid user, 3 no tmpfs or no
 * token, 4 unknown user, 5 root may not give the files to the user (the configuration took CAP_CHOWN away, for example
 * `--cap-drop ALL`).
 */
export const TOKEN_WRITE_SCRIPT = `set -eu
umask 077
user="$1"
login="$2"
case "$user" in
  '' | -* | *[!A-Za-z0-9._-]*) printf 'Invalid user: %s\\n' "$user" >&2; exit 2 ;;
esac
case "$login" in
  '' | [!A-Za-z0-9]* | *[!A-Za-z0-9_-]*) login='' ;;
esac
if [ "\${#login}" -gt 39 ]; then login=''; fi
${REQUIRE_TMPFS}clear_folder() {
  rm -rf "$dir"/* "$dir"/.[!.]* "$dir"/..?* 2>/dev/null || true
}
if uid=$(id -u "$user" 2>/dev/null) && gid=$(id -g "$user" 2>/dev/null); then
  :
else
  case "$user" in
    *[!0-9]*) printf 'The user %s is not known in the container.\\n' "$user" >&2; exit 4 ;;
  esac
  uid="$user"
  gid="$user"
fi
trap 'status=$?; if [ "$status" -ne 0 ]; then clear_folder; fi' EXIT
chown 0:0 "$dir"
chmod 0700 "$dir"
clear_folder
token='${GITHUB_TOKEN_FILE}'
cat > "$token"
if [ ! -s "$token" ]; then
  echo 'No token on standard input.' >&2
  exit 3
fi
chmod 0600 "$token"
gh='${GH_CONFIG_FOLDER}'
mkdir -m 0700 "$gh"
ln -s '${GH_VOLUME_CONFIG_FILE}' "$gh/config.yml"
hosts='${GH_HOSTS_FILE}'
others=$(tr -d 'A-Za-z0-9_.-' < "$token" | wc -c | tr -d ' ')
if [ -z "$login" ]; then
  echo 'The GitHub CLI in the container is not signed in: the GitHub login of the account is not known. Git works.'
elif [ "$others" != 0 ]; then
  echo 'The GitHub CLI in the container is not signed in: the token has characters that its configuration cannot hold.'
else
  {
    printf 'github.com:\\n    users:\\n        "%s":\\n            oauth_token: "' "$login"
    cat "$token"
    printf '"\\n    git_protocol: https\\n    oauth_token: "'
    cat "$token"
    printf '"\\n    user: "%s"\\n' "$login"
  } > "$hosts"
  chmod 0600 "$hosts"
fi
if [ "$uid:$gid" != 0:0 ]; then
  if ! chown -h "$uid:$gid" "$token" "$gh" "$gh/config.yml" 2>/dev/null ||
    { [ -e "$hosts" ] && ! chown "$uid:$gid" "$hosts" 2>/dev/null; } ||
    ! chown "$uid:$gid" "$dir" 2>/dev/null; then
    printf 'Root in the container may not give the files of %s to %s (the configuration takes this right away, for example with --cap-drop).\\n' "$dir" "$user" >&2
    exit 5
  fi
fi
echo "The GitHub token of the environment is in $dir, in the memory of the container."
`;

/**
 * No arguments. Runs in the dev container (as root, or as the remote user when root may not enter the folder): empties
 * TOKEN_FOLDER when it is a tmpfs (REQUIRE_TMPFS; otherwise, for example in a container of a version before unit 15,
 * there is nothing to remove there, exit code 0). Exit code 1 when the token file or the sign-in of the GitHub CLI is
 * still there.
 */
export const TOKEN_REMOVE_SCRIPT = `set -u
dir='${TOKEN_FOLDER}'
fstype=''
while read -r _source mountpoint type _rest; do
  if [ "$mountpoint" = "$dir" ]; then fstype="$type"; fi
done < /proc/mounts
if [ "$fstype" != tmpfs ]; then
  echo "The container has no tmpfs at $dir: it holds no GitHub token there."
  exit 0
fi
rm -rf "$dir"/* "$dir"/.[!.]* "$dir"/..?* 2>/dev/null || true
status=0
for path in '${GITHUB_TOKEN_FILE}' '${GH_HOSTS_FILE}'; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    printf '%s could not be removed.\\n' "$path" >&2
    status=1
  fi
done
if [ "$status" -eq 0 ]; then echo 'The GitHub token was removed from the container.'; fi
exit "$status"
`;

/** `sh -c` command of TOKEN_WRITE_SCRIPT for `docker exec -i -u root`. The token goes on stdin. */
export function tokenWriteCommand(user: string, login: string): string[] {
  return ['sh', '-c', TOKEN_WRITE_SCRIPT, 'sh', user, login];
}

/** `sh -c` command of TOKEN_REMOVE_SCRIPT. */
export function tokenRemoveCommand(): string[] {
  return ['sh', '-c', TOKEN_REMOVE_SCRIPT, 'sh'];
}

/** The login that TOKEN_WRITE_SCRIPT gets: `''` for a login that is no GitHub login (gh is then signed in nowhere). */
export function tokenLogin(login: string): string {
  return isGitHubLogin(login) ? login : '';
}

/** `docker exec` as the pipeline and the controller use it (ContainerAdapter.exec). */
export type ContainerExec = (
  container: string,
  command: readonly string[],
  options: { user?: string; input?: string; signal?: AbortSignal; timeoutMs?: number },
) => Promise<RunResult>;

/** The text of a failed run of the scripts, without the token. */
export function tokenRunMessage(result: RunResult, token?: string): string {
  const text = (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`;
  return token !== undefined && token.length >= 4 ? text.split(token).join('***') : text;
}

/**
 * Writes the token of the owner account and the sign-in of the GitHub CLI as `login` into TOKEN_FOLDER of the running dev
 * container `container`, for `user` (TOKEN_WRITE_SCRIPT, as root, token on stdin). Returns the output (without the
 * token); throws an Error with the reason (without the token) when the script fails.
 */
export async function writeContainerToken(
  exec: ContainerExec,
  p: { container: string; user: string; token: string; login: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  if (!p.token || /\s/.test(p.token)) throw new Error('No valid GitHub token.');
  const result = await exec(p.container, tokenWriteCommand(p.user, tokenLogin(p.login)), {
    user: 'root',
    input: p.token,
    signal: p.signal,
    timeoutMs: p.timeoutMs,
  });
  if (result.exitCode !== 0) throw new Error(tokenRunMessage(result, p.token));
  return tokenRunMessage({ ...result, stderr: '' }, p.token);
}

/**
 * Empties TOKEN_FOLDER of the running dev container `container` (TOKEN_REMOVE_SCRIPT): as root, and when that fails
 * (for example when the configuration takes the rights of root away) as `user`. Throws an Error with the reason when the
 * token is still there.
 */
export async function removeContainerToken(
  exec: ContainerExec,
  p: { container: string; user?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const options = { signal: p.signal, timeoutMs: p.timeoutMs };
  const asRoot = await exec(p.container, tokenRemoveCommand(), { ...options, user: 'root' });
  if (asRoot.exitCode === 0) return;
  if (p.user === undefined || p.user === '' || p.user === 'root' || p.user === '0') throw new Error(tokenRunMessage(asRoot));
  const asUser = await exec(p.container, tokenRemoveCommand(), { ...options, user: p.user });
  if (asUser.exitCode !== 0) throw new Error(`${tokenRunMessage(asRoot)} As ${p.user}: ${tokenRunMessage(asUser)}`);
}
