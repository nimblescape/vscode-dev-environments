// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 15: the token of the owner account only in the memory of the dev container (concept section 9 "Git inside the
// container"). The token file and the sign-in of the GitHub CLI are in the tmpfs TOKEN_FOLDER of the dev container, which
// the override configuration adds (TOKEN_TMPFS). The extension writes them with `docker exec -i -u root` after each start
// of an open (the container runs then), with the token on standard input only: never on a command line, in a variable
// of the container, or in a log. They are gone when the container stops; a start without a window of the extension (the
// Session Monitor, `docker start`) leaves the folder empty until the next open. Plan step 6, PR C (Q4 of 2026-10-01): the
// token is the secret input of the call (`secretInput`), never a direct `docker exec` of the extension. Plan step 11I1,
// PR B2: the worker writes it (EngineDocker.exec, the token as the secret of the operation); ContainerAdapter.exec
// refuses a secret input. No vscode import.
import type { RunResult } from '../ports';
import { GH_CONFIG_FOLDER, GH_HOSTS_FILE, GH_VOLUME_CONFIG_FILE, GITHUB_TOKEN_FILE, TOKEN_FOLDER } from '../names';
import { isGitHubLogin } from './containerGit';

/** The path of `file` (in TOKEN_FOLDER) relative to TOKEN_FOLDER, where the scripts work (`cd`). */
function inFolder(file: string): string {
  if (!file.startsWith(`${TOKEN_FOLDER}/`)) throw new Error(`${file} is not in ${TOKEN_FOLDER}`);
  return file.slice(TOKEN_FOLDER.length + 1);
}

/**
 * The super options that the kernel shows in /proc/self/mountinfo for TOKEN_TMPFS (`size=1m`, `mode=0700`): each of
 * them exactly once, in any order. The kernel adds options of its own that change nothing of what the check below looks
 * for (TOKEN_TMPFS_KERNEL_SUPER_OPTIONS); any other option, or one of these twice (for example another size,
 * `nr_inodes=`, `uid=1000`), is not our tmpfs.
 */
export const TOKEN_TMPFS_SUPER_OPTIONS = 'rw,size=1024k,mode=700';

/**
 * The super options that a kernel may show besides TOKEN_TMPFS_SUPER_OPTIONS for our tmpfs (`*` = any value): the
 * 64-bit or 32-bit inode numbers of tmpfs (`inode64` on kernels with CONFIG_TMPFS_INODE64, such as the ones of Ubuntu),
 * SELinux (`seclabel`, or the `context=…` that Docker sets, in quotes when it has a comma), the owner root, no swap, and
 * no huge pages.
 */
export const TOKEN_TMPFS_KERNEL_SUPER_OPTIONS = ['inode64', 'inode32', 'seclabel', 'context=*', 'uid=0', 'gid=0', 'noswap', 'huge=never'];

/**
 * Review of unit 15 (T1, T2, and the mount propagation): shell code (POSIX sh, no awk; dash and BusyBox) with the
 * functions `own_tmpfs <folder>` and `enter_folder`, and `dir` = TOKEN_FOLDER. The scripts do everything in the folder
 * that they entered (`cd`, then paths relative to `.`), and only when it is the tmpfs that the override configuration
 * gives the dev container (TOKEN_TMPFS), not a mount that looks like it by its name in /proc/mounts: a volume on a
 * parent through a link of the image (`/var/run` → `/run`) hides the tmpfs, a folder or a tmpfs of the computer at
 * `/var/run/devenv` lies over it, and a file of the computer at `/var/run/devenv/github-token` inside it. `own_tmpfs`
 * ends with 0 when the folder is that tmpfs, 1 when it is no tmpfs at all (or cannot be looked at), and 2 when it is
 * another tmpfs, or ours with something over it, in it, or shared with the computer. It is ours when all of this holds:
 * - `stat -f` says tmpfs;
 * - the device of the folder (`stat -c %d`, as major:minor) is on exactly one line of /proc/self/mountinfo, and that
 *   line has the mount point TOKEN_FOLDER, the root `/`, no optional fields (no `shared:`, `master:`: no peer on the
 *   computer), the type tmpfs, the options nosuid, nodev, and noexec, and the super options TOKEN_TMPFS_SUPER_OPTIONS
 *   (each once) with no others than TOKEN_TMPFS_KERNEL_SUPER_OPTIONS;
 * - no mount on its parents, up to the root of the container, has the mount point TOKEN_FOLDER (a mount stacked on
 *   another one there) or is `shared:` (a mount propagation that would bring our tmpfs to the computer);
 * - no mount point lies below TOKEN_FOLDER (for example a file of the computer at the place of the token file).
 * When it refuses, `own_tmpfs` writes the rule that failed and the lines of /proc/self/mountinfo of the folder (its
 * mount point, the mounts below it, and its device) to stderr, for the log: the reason of a refusal on a kernel that
 * shows the mount otherwise. Only builtins of the shell (no program runs, so none sees the table or the folder).
 * `enter_folder` goes into the folder and ends with the status of `own_tmpfs .`; when the folder cannot be entered (the
 * remote user, its owner after a write, took the rights away), it gives it back to root (as root) and mode 0700 first,
 * only when it is our tmpfs, and ends with 4 when it still cannot be entered.
 */
const [REQUIRED_RW, REQUIRED_SIZE, REQUIRED_MODE] = TOKEN_TMPFS_SUPER_OPTIONS.split(',');
const OWN_TMPFS = `dir='${TOKEN_FOLDER}'
own_tmpfs_refuse() {
  printf 'Check of %s: %s.\\n' "$dir" "$2" >&2
  while read -r m_id m_parent m_dev m_root m_point m_options m_rest; do
    case "$m_point" in
      "$dir" | "$dir"/*) ;;
      *) [ -n "$m_want" ] && [ "$m_dev" = "$m_want" ] || continue ;;
    esac
    printf 'mountinfo: %s %s %s %s %s %s %s\\n' "$m_id" "$m_parent" "$m_dev" "$m_root" "$m_point" "$m_options" "$m_rest" >&2
  done < /proc/self/mountinfo
  return "$1"
}
own_tmpfs_super() {
  m_list="$1,"
  m_rw=0
  m_size=0
  m_mode=0
  while [ -n "$m_list" ]; do
    m_opt="\${m_list%%,*}"
    m_list="\${m_list#*,}"
    case "$m_opt" in
      'context="'*)
        while case "$m_opt" in 'context="'*'"') false ;; *) true ;; esac; do
          if [ -z "$m_list" ]; then m_why="the super option $m_opt has no end"; return 1; fi
          m_opt="$m_opt,\${m_list%%,*}"
          m_list="\${m_list#*,}"
        done
        ;;
    esac
    case "$m_opt" in
      '${REQUIRED_RW}') m_rw=$((m_rw + 1)) ;;
      '${REQUIRED_SIZE}') m_size=$((m_size + 1)) ;;
      '${REQUIRED_MODE}') m_mode=$((m_mode + 1)) ;;
      ${TOKEN_TMPFS_KERNEL_SUPER_OPTIONS.map((o) => (o.endsWith('*') ? `'${o.slice(0, -1)}'*` : `'${o}'`)).join(' | ')}) ;;
      *) m_why="the super option $m_opt is not one of ours or of the kernel"; return 1 ;;
    esac
  done
  if [ "$m_rw:$m_size:$m_mode" != 1:1:1 ]; then
    m_why='the super options do not have ${REQUIRED_RW}, ${REQUIRED_SIZE}, and ${REQUIRED_MODE} once each'
    return 1
  fi
}
own_tmpfs() {
  m_want=''
  m_type=$(stat -f -c %T "$1" 2>/dev/null) || m_type=''
  [ "$m_type" = tmpfs ] || { own_tmpfs_refuse 1 "stat -f shows the type '$m_type', not tmpfs"; return; }
  m_device=$(stat -c %d "$1" 2>/dev/null) || { own_tmpfs_refuse 2 'stat -c %d fails'; return; }
  case "$m_device" in '' | *[!0-9]*) own_tmpfs_refuse 2 "stat -c %d shows '$m_device'"; return ;; esac
  m_want="$(( ((m_device >> 8) & 0xfff) | ((m_device >> 32) & ~0xfff) )):$(( (m_device & 0xff) | ((m_device >> 12) & ~0xff) ))"
  m_count=0
  m_parent_id=''
  m_why=''
  while read -r m_id m_parent m_dev m_root m_point m_options m_rest; do
    case "$m_point" in "$dir"/*) m_why="a mount lies below it ($m_point)"; break ;; esac
    [ "$m_dev" = "$m_want" ] || continue
    m_count=$((m_count + 1))
    if [ "$m_point" != "$dir" ]; then m_why="its device $m_want is mounted at $m_point"; break; fi
    if [ "$m_root" != / ]; then m_why="the root of its mount is $m_root, not /"; break; fi
    case "$m_rest" in
      '- tmpfs '*) ;;
      '- '*) m_why='the type of its mount is not tmpfs'; break ;;
      *) m_why='its mount has optional fields (a peer or a master)'; break ;;
    esac
    own_tmpfs_super "\${m_rest#- tmpfs * }" || break
    case ",$m_options," in *,nosuid,*) ;; *) m_why='its mount has no nosuid'; break ;; esac
    case ",$m_options," in *,nodev,*) ;; *) m_why='its mount has no nodev'; break ;; esac
    case ",$m_options," in *,noexec,*) ;; *) m_why='its mount has no noexec'; break ;; esac
    m_parent_id="$m_parent"
  done < /proc/self/mountinfo
  if [ -n "$m_why" ]; then own_tmpfs_refuse 2 "$m_why"; return; fi
  if [ "$m_count" != 1 ]; then own_tmpfs_refuse 2 "its device $m_want is on $m_count lines of /proc/self/mountinfo, not 1"; return; fi
  m_hops=0
  while [ -n "$m_parent_id" ]; do
    m_hops=$((m_hops + 1))
    if [ "$m_hops" -gt 100 ]; then own_tmpfs_refuse 2 'the chain of its parents has more than 100 mounts'; return; fi
    m_next=''
    while read -r m_id m_parent m_dev m_root m_point m_options m_rest; do
      [ "$m_id" = "$m_parent_id" ] || continue
      if [ "$m_point" = "$dir" ]; then m_why="it lies on another mount at $dir (mount $m_id)"; break; fi
      case " \${m_rest%%- *}" in *' shared:'*) m_why="the parent mount $m_id at $m_point is shared: $m_rest"; break ;; esac
      m_next="$m_parent"
    done < /proc/self/mountinfo
    if [ -n "$m_why" ]; then own_tmpfs_refuse 2 "$m_why"; return; fi
    [ "$m_next" != "$m_parent_id" ] || break
    m_parent_id="$m_next"
  done
  return 0
}
enter_folder() {
  if cd "$dir" 2>/dev/null; then
    own_tmpfs .
    return
  fi
  own_tmpfs "$dir" || return
  if [ "$(id -u)" = 0 ]; then chown 0:0 "$dir" 2>/dev/null || true; fi
  chmod 0700 "$dir" 2>/dev/null || true
  cd "$dir" 2>/dev/null || return 4
  own_tmpfs .
}
`;

/**
 * Review of unit 15 (P1): shell code that gives everything in the folder (the current folder) back to root, top down,
 * without following links: each entry gets root (`chown -h 0:0`), and each folder mode 0700 before `find` reads it. So
 * root clears the folder also without CAP_DAC_OVERRIDE (for example `--cap-drop DAC_OVERRIDE`): after a write the
 * folder belongs to the remote user, who may put folders of mode 0700 or 000, and links, into it. It needs CAP_CHOWN,
 * which needs no rights on the entry, and no search right in a folder of the user that `find` did not open yet. Errors
 * are ignored: what is left is found afterwards.
 */
const TAKE_BACK = `find . -mindepth 1 -exec chown -h 0:0 {} \\; -type d -exec chmod 0700 {} \\; 2>/dev/null || true
`;

/**
 * `$1` = the remote user (a name, or a numeric user ID), `$2` = the GitHub login of the account that owns the environment
 * (isGitHubLogin; empty when it is not known or the token cannot go into hosts.yml). Token on stdin. Runs as root in the
 * dev container (`docker exec -i -u root`). Only in the tmpfs of the container at TOKEN_FOLDER (OWN_TMPFS; otherwise exit
 * code 3 and nothing written), with paths relative to it:
 * - the folder gets root and mode 0700, everything in it is given back to root (TAKE_BACK) and removed, so no process of
 *   the user can change it while it is written (an old token, a link or a folder that the user put there, everything
 *   goes); exit code 5 when something is left;
 * - github-token (GITHUB_TOKEN_FILE): the token from stdin, mode 0600;
 * - gh/ (GH_CONFIG_FOLDER, GH_CONFIG_DIR of the container), mode 0700, with hosts.yml (GH_HOSTS_FILE, mode 0600): the
 *   sign-in of the GitHub CLI as `$2`, in both forms that gh reads (the keys `oauth_token`, `user`, and `git_protocol` of
 *   the host for gh before 2.40 and the active account of gh 2.40 and newer, and `users.<login>.oauth_token`). The token
 *   goes into it with `cat` of the token file, never as an argument of a program. Without a login, or with a token that
 *   has characters that YAML would need to escape, gh is signed in nowhere (no hosts.yml); Git still works;
 * - gh/config.yml: a link to GH_VOLUME_CONFIG_FILE, the settings of gh in the volume (no secret);
 * - all of it gets the user and group of `$1` (`id -u`, `id -g`; a numeric user as it is): the files first, then gh/,
 *   and last the folder itself, so root never needs a right in a folder of the user (CAP_DAC_OVERRIDE).
 * On a failure after the check of the tmpfs, the folder is emptied again. Exit codes: 2 invalid user, 3 not the tmpfs of
 * the container or no token, 4 unknown user, 5 root may not empty the folder or give the files to the user (the
 * configuration took CAP_CHOWN away, for example `--cap-drop ALL`).
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
${OWN_TMPFS}folder=0
enter_folder || folder=$?
if [ "$folder" = 1 ] || [ "$folder" = 4 ]; then
  printf '%s is not a tmpfs mount of the container.\\n' "$dir" >&2
  exit 3
elif [ "$folder" != 0 ]; then
  printf '%s is not the tmpfs of the container: another mount lies over it or in it, or shares it with the computer. The token is not written.\\n' "$dir" >&2
  exit 3
fi
clear_folder() {
  rm -rf ./* ./.[!.]* ./..?* 2>/dev/null || true
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
chown 0:0 .
chmod 0700 .
${TAKE_BACK}clear_folder
if ! left=$(ls -A .) || [ -n "$left" ]; then
  printf 'Root in the container cannot empty %s (the configuration takes rights of root away, for example with --cap-drop).\\n' "$dir" >&2
  exit 5
fi
token='${inFolder(GITHUB_TOKEN_FILE)}'
cat > "$token"
if [ ! -s "$token" ]; then
  echo 'No token on standard input.' >&2
  exit 3
fi
chmod 0600 "$token"
gh='${inFolder(GH_CONFIG_FOLDER)}'
mkdir -m 0700 "$gh"
ln -s '${GH_VOLUME_CONFIG_FILE}' "$gh/config.yml"
hosts='${inFolder(GH_HOSTS_FILE)}'
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
  if ! chown -h "$uid:$gid" "$token" "$gh/config.yml" 2>/dev/null ||
    { [ -e "$hosts" ] && ! chown "$uid:$gid" "$hosts" 2>/dev/null; } ||
    ! chown "$uid:$gid" "$gh" 2>/dev/null ||
    ! chown "$uid:$gid" . 2>/dev/null; then
    printf 'Root in the container may not give the files of %s to %s (the configuration takes this right away, for example with --cap-drop).\\n' "$dir" "$user" >&2
    exit 5
  fi
fi
echo "The GitHub token of the environment is in $dir, in the memory of the container."
`;

/**
 * No arguments. Runs in the dev container (as root, or as the remote user when root may not empty the folder): empties
 * TOKEN_FOLDER when it is the tmpfs of the container (OWN_TMPFS), as root after giving everything in it back to root
 * (TAKE_BACK), as the user after giving its own folders mode 0700. Exit code 3 where the folder is no tmpfs, another
 * tmpfs, or ours with a mount over it or in it (nothing is removed there: the scripts never wrote there). Exit code 1
 * when the folder cannot be entered or read, or is not empty afterwards (so that the removal as the remote user runs).
 */
export const TOKEN_REMOVE_SCRIPT = `set -u
${OWN_TMPFS}folder=0
enter_folder || folder=$?
if [ "$folder" = 4 ]; then
  printf '%s cannot be read.\\n' "$dir" >&2
  exit 1
elif [ "$folder" != 0 ]; then
  printf '%s is not the tmpfs of the container: no tmpfs, or another mount lies over it or in it, or shares it with the computer. Nothing is removed there.\\n' "$dir" >&2
  exit 3
fi
if [ "$(id -u)" = 0 ]; then
  chown 0:0 . 2>/dev/null
  chmod 0700 . 2>/dev/null
  ${TAKE_BACK}else
  find . -mindepth 1 -type d -exec chmod 0700 {} \\; 2>/dev/null
fi
rm -rf ./* ./.[!.]* ./..?* 2>/dev/null
status=0
for path in '${inFolder(GITHUB_TOKEN_FILE)}' '${inFolder(GH_HOSTS_FILE)}'; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    printf '%s/%s could not be removed.\\n' "$dir" "$path" >&2
    status=1
  fi
done
if ! left=$(ls -A . 2>/dev/null); then
  printf '%s cannot be read.\\n' "$dir" >&2
  status=1
elif [ -n "$left" ]; then
  printf '%s could not be emptied.\\n' "$dir" >&2
  status=1
fi
if [ "$status" -eq 0 ]; then echo 'The GitHub token was removed from the container.'; fi
exit "$status"
`;

/** `sh -c` command of TOKEN_WRITE_SCRIPT for `docker exec -i -u root`. The token goes on stdin. */
export function tokenWriteCommand(user: string, login: string): string[] {
  return ['sh', '-c', TOKEN_WRITE_SCRIPT, 'sh', user, login];
}

/** The login that TOKEN_WRITE_SCRIPT gets: `''` for a login that is no GitHub login (gh is then signed in nowhere). */
export function tokenLogin(login: string): string {
  return isGitHubLogin(login) ? login : '';
}

/** `docker exec` as the pipeline and the controller use it (ContainerAdapter.exec). */
export type ContainerExec = (
  container: string,
  command: readonly string[],
  options: { user?: string; input?: string; secretInput?: string; signal?: AbortSignal; timeoutMs?: number },
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
    // Plan step 6, PR C (Q4): the secret input of the call (in the worker: the secret of the operation).
    secretInput: p.token,
    signal: p.signal,
    timeoutMs: p.timeoutMs,
  });
  if (result.exitCode !== 0) throw new Error(tokenRunMessage(result, p.token));
  return tokenRunMessage({ ...result, stderr: '' }, p.token);
}
