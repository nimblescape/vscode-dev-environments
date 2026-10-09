// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"; the live checks of the user of 2026-10-09: the
// Dev Containers extension takes a link `~/.vscode-server/bin/<commit>` into a read-only volume, installs nothing, and
// runs the server from there as the remote user): the script of the container setup that links the server of the store
// into the home folder of the remote user, and the reading of its one line of output. It runs as the remote user (never
// root) through the registry of the container scripts (`vscodeServerLink`, runScript), at every open (first open, Start,
// Rebuild, recreate, a running container: the commit changes with each update of VS Code), after the open made sure that
// the store has the server for the engine's platform (decision of 2026-10-09); a container of another platform is skipped.
// The dev container is untrusted: the script follows and writes through no link that it did not create. No I/O here, no `vscode`.
import { VSCODE_STORE_TARGET } from '../names';

/**
 * Plan step 11H1: runs as the remote user in the dev container, with the commit (`$1`), the quality (`$2`), and the
 * platform whose server the open made present in the store (`$3`, the platform of the engine). It links only when
 * everything fits:
 * - the container has that platform (`uname -m`: x86_64/amd64 linux-x64, aarch64/arm64 linux-arm64; musl,
 *   `/etc/alpine-release` or `ldd --version` naming musl, has no server in the store);
 * - the store has the server (`bin/code-server` and `node` under VSCODE_STORE_TARGET/server/<quality>/<platform>/<commit>);
 * - the user has a home folder (/etc/passwd, by the user ID);
 * - `~/.vscode-server` (`~/.vscode-server-insiders` for the quality `insider`) and its `bin` are each missing (then
 *   created) or a plain folder of the user; a link, another kind of file, or a folder of another user is refused;
 * - `bin/<commit>` does not exist yet (a file, a folder or a link there is never replaced).
 * Then it creates the link `bin/<commit>` → the server in the store (review round 1 of 11H1: working in each checked
 * folder, entered after its check, with `ln -sn`, so nothing is written through a link planted after a check). Its output is one line: `linked`, `present`,
 * `skipped: <why>` or `refused: <why>`; it exits 0 for each of them, and non-zero only when a command failed. Works with
 * GNU and BusyBox tools. Review round 2 of 11H1 (reviewers A and B): it unsets CDPATH first (the environment of the image
 * may set it), so `cd` enters the folder relative to the working folder, never one of CDPATH, and prints nothing.
 */
export const VSCODE_SERVER_LINK_SCRIPT = `set -u
unset CDPATH
commit="$1"
quality="$2"
stored="$3"
case "$commit" in
  *[!0-9a-f]*|'') echo 'skipped: the commit is invalid'; exit 0 ;;
esac
if [ \${#commit} -ne 40 ]; then echo 'skipped: the commit is invalid'; exit 0; fi
case "$quality" in
  stable) data=.vscode-server ;;
  insider) data=.vscode-server-insiders ;;
  *) echo 'skipped: the quality is invalid'; exit 0 ;;
esac
case "$stored" in
  linux-x64|linux-arm64) ;;
  *) echo 'skipped: the platform is invalid'; exit 0 ;;
esac
machine=$(uname -m 2>/dev/null) || machine=''
case "$machine" in
  x86_64|amd64) platform=linux-x64 ;;
  aarch64|arm64) platform=linux-arm64 ;;
  *) echo "skipped: the machine $machine of the container has no server in the store"; exit 0 ;;
esac
if [ -e /etc/alpine-release ] || { ldd --version 2>&1 | grep -qi musl; }; then
  echo 'skipped: the container uses musl, which has no server in the store'
  exit 0
fi
if [ "$platform" != "$stored" ]; then echo "skipped: the container is $platform, the server in the store is for $stored"; exit 0; fi
server="${VSCODE_STORE_TARGET}/server/$quality/$platform/$commit"
if [ ! -f "$server/bin/code-server" ] || [ ! -f "$server/node" ]; then echo 'skipped: the store does not have the server'; exit 0; fi
uid=$(id -u) || exit 1
home=$(awk -F: -v u="$uid" '$3 == u { print $6; exit }' /etc/passwd)
if [ -z "$home" ] || [ ! -d "$home" ]; then echo 'skipped: the user has no home folder'; exit 0; fi
# Review round 1 of 11H1 (reviewer B): each step after a check works in the folder that it checked. The script enters
# each folder after its check, makes sure there that it is the folder it checked (its real path, and the user's), and
# creates the link relative to it with \`ln -n\`, so a link planted after a check is never followed by a later step. What
# remains: the remote user (or root) of the container can still move a checked folder while the script runs; the link
# then lands in that same folder at its new place, in the container's own file system, which they can write anyway.
cd -P -- "$home" || exit 1
enter() {
  if [ -L "$1" ]; then echo "refused: $2 is a link"; exit 0; fi
  if [ -e "$1" ]; then
    if [ ! -d "$1" ]; then echo "refused: $2 is not a folder"; exit 0; fi
    owner=$(ls -ldn "$1" | awk '{ print $3 }')
    if [ "$owner" != "$uid" ]; then echo "refused: $2 is not the user's"; exit 0; fi
  else
    mkdir "$1" || exit 1
  fi
  here=$(pwd -P) || exit 1
  cd -P "$1" || exit 1
  if [ "$(pwd -P)" != "\${here%/}/$1" ]; then echo "refused: $2 was replaced while it was checked"; exit 0; fi
  owner=$(ls -ldn . | awk '{ print $3 }')
  if [ "$owner" != "$uid" ]; then echo "refused: $2 is not the user's"; exit 0; fi
}
enter "$data" "$home/$data"
enter bin "$home/$data/bin"
if [ -e "$commit" ] || [ -L "$commit" ]; then echo 'present'; exit 0; fi
ln -sn "$server" "$commit" || exit 1
echo 'linked'
`;

/** Plan step 11H1: the outcome of VSCODE_SERVER_LINK_SCRIPT. */
export type VscodeServerLinkOutcome = { kind: 'linked' } | { kind: 'present' } | { kind: 'skipped' | 'refused' | 'failed'; reason: string };

/** The longest reason of an outcome in the log. */
const MAX_LINK_REASON_LENGTH = 300;

/**
 * Plan step 11H1: the outcome of a run of VSCODE_SERVER_LINK_SCRIPT: its first line of output for exit code 0 (an
 * unknown line is `failed`), else `failed` with the end of its error output.
 */
export function vscodeServerLinkOutcome(result: { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }): VscodeServerLinkOutcome {
  const clip = (text: string) => (text.length > MAX_LINK_REASON_LENGTH ? `${text.slice(0, MAX_LINK_REASON_LENGTH - 1)}…` : text);
  if (result.timedOut === true) return { kind: 'failed', reason: 'the script took too long' };
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n').pop() ?? '';
    return { kind: 'failed', reason: clip(`exit code ${result.exitCode === null ? 'none' : result.exitCode}${detail ? `: ${detail}` : ''}`) };
  }
  const line = result.stdout.trim().split('\n')[0]?.trim() ?? '';
  if (line === 'linked') return { kind: 'linked' };
  if (line === 'present') return { kind: 'present' };
  const match = /^(skipped|refused): (.+)$/.exec(line);
  if (match) return { kind: match[1] as 'skipped' | 'refused', reason: clip(match[2]) };
  return { kind: 'failed', reason: clip(`the script answered ${JSON.stringify(line)}`) };
}
