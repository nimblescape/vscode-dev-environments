// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; live check 3 of the user: the VS Code server installs an extension from a
// `.vsix` in `~/.vscode-server/extensionsCache/<cache name>` and downloads nothing then; Dev Containers then uploads
// nothing either): the script of the container setup that copies the cached `.vsix` files of the store into the
// extension cache of the remote user's VS Code server, and the reading of its one line of output. It runs as the remote
// user (never root by our choice) through the registry of the container scripts (`vscodeExtensionSeed`, runScript), once
// per open right after the link of the server (vscodeServerLink.ts, whose folder checks it shares), with no network and no
// wait. The dev container is untrusted: nothing is followed or written through a link, and nothing is overwritten.
// No I/O here, no `vscode`.
import { VSCODE_STORE_TARGET } from '../names';
import { SCRIPT_ENTER_FOLDER, SCRIPT_HOME_OF_USER } from './vscodeServerLink';

/**
 * Plan step 11H3: runs as the remote user in the dev container with the quality (`$1`: `stable` uses
 * `~/.vscode-server`, `insider` `~/.vscode-server-insiders`), the platform of the engine (`$2`, `linux-x64`,
 * `linux-arm64`, or `none`), and the files of the store to copy (`$3`…, each `<folder>/<cache name>` of
 * VSCODE_STORE_TARGET/extensions; seedSelection). A file of `universal` is copied into any container; a file of a
 * platform only into a container of that platform with glibc (`uname -m`; musl, `/etc/alpine-release` or `ldd --version`
 * naming musl, takes only `universal`). The data folder and its `extensionsCache` must each be missing (then created) or
 * a plain folder of the user (the checks of the link, SCRIPT_ENTER_FOLDER); a file that is in the cache already (a
 * file, a folder or a link of that name) is never replaced. Each file is copied with `cp -n` into a new temporary file of
 * the checked folder and then given its name with `ln -n` (a hard link, which never replaces a name; review round 1 of
 * 11H3, A-L1: `-n` treats a link to a folder that a process of the container planted at the name after the check as a
 * name that exists, instead of creating the hard link inside that folder), and the temporary name goes. Its output is one line: `seeded: <copied> copied, <present> present, <other>
 * skipped, <failed> failed`, or `skipped: <why>` / `refused: <why>`; it exits 0 for each, non-zero only when a command
 * of its setup failed. Works with GNU and BusyBox tools.
 */
export const VSCODE_EXTENSION_SEED_SCRIPT = `set -u
unset CDPATH
quality="$1"
stored="$2"
shift 2
case "$quality" in
  stable) data=.vscode-server ;;
  insider) data=.vscode-server-insiders ;;
  *) echo 'skipped: the quality is invalid'; exit 0 ;;
esac
case "$stored" in
  linux-x64|linux-arm64|none) ;;
  *) echo 'skipped: the platform is invalid'; exit 0 ;;
esac
if [ $# -eq 0 ]; then echo 'skipped: no cached extensions'; exit 0; fi
machine=$(uname -m 2>/dev/null) || machine=''
case "$machine" in
  x86_64|amd64) platform=linux-x64 ;;
  aarch64|arm64) platform=linux-arm64 ;;
  *) platform=none ;;
esac
if [ -e /etc/alpine-release ] || { ldd --version 2>&1 | grep -qi musl; }; then platform=none; fi
if [ "$platform" != "$stored" ]; then platform=none; fi
${SCRIPT_HOME_OF_USER}${SCRIPT_ENTER_FOLDER}enter "$data" "$home/$data"
enter extensionsCache "$home/$data/extensionsCache"
copied=0
present=0
other=0
failed=0
for entry in "$@"; do
  folder=\${entry%%/*}
  name=\${entry#*/}
  if [ "$folder" != universal ] && { [ "$platform" = none ] || [ "$folder" != "$platform" ]; }; then other=$((other + 1)); continue; fi
  case "$name" in
    ''|.*|*[!a-z0-9.-]*) other=$((other + 1)); continue ;;
  esac
  source="${VSCODE_STORE_TARGET}/extensions/$folder/$name"
  if [ -L "$source" ] || [ ! -f "$source" ]; then other=$((other + 1)); continue; fi
  if [ -e "$name" ] || [ -L "$name" ]; then present=$((present + 1)); continue; fi
  temp=".devenv-seed-$$-$name"
  if [ -e "$temp" ] || [ -L "$temp" ]; then failed=$((failed + 1)); continue; fi
  if cp -n "$source" "$temp" 2>/dev/null && [ -f "$temp" ] && [ ! -L "$temp" ]; then
    if ln -n "$temp" "$name" 2>/dev/null; then copied=$((copied + 1)); else present=$((present + 1)); fi
  else
    failed=$((failed + 1))
  fi
  rm -f "$temp"
done
echo "seeded: $copied copied, $present present, $other skipped, $failed failed"
`;

/** Plan step 11H3: the outcome of VSCODE_EXTENSION_SEED_SCRIPT. */
export type VscodeExtensionSeedOutcome =
  | { kind: 'seeded'; copied: number; present: number; skipped: number; failed: number }
  | { kind: 'skipped' | 'refused' | 'failed'; reason: string };

/** The longest reason of an outcome in the log. */
const MAX_SEED_REASON_LENGTH = 300;

/**
 * Plan step 11H3: the outcome of a run of VSCODE_EXTENSION_SEED_SCRIPT: its first line of output for exit code 0 (an
 * unknown line is `failed`), else `failed` with the end of its error output.
 */
export function vscodeExtensionSeedOutcome(result: { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }): VscodeExtensionSeedOutcome {
  const clip = (text: string) => (text.length > MAX_SEED_REASON_LENGTH ? `${text.slice(0, MAX_SEED_REASON_LENGTH - 1)}…` : text);
  if (result.timedOut === true) return { kind: 'failed', reason: 'the script took too long' };
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n').pop() ?? '';
    return { kind: 'failed', reason: clip(`exit code ${result.exitCode === null ? 'none' : result.exitCode}${detail ? `: ${detail}` : ''}`) };
  }
  const line = result.stdout.trim().split('\n')[0]?.trim() ?? '';
  const seeded = /^seeded: (\d{1,6}) copied, (\d{1,6}) present, (\d{1,6}) skipped, (\d{1,6}) failed$/.exec(line);
  if (seeded) return { kind: 'seeded', copied: Number(seeded[1]), present: Number(seeded[2]), skipped: Number(seeded[3]), failed: Number(seeded[4]) };
  const match = /^(skipped|refused): (.+)$/.exec(line);
  if (match) return { kind: match[1] as 'skipped' | 'refused', reason: clip(match[2]) };
  return { kind: 'failed', reason: clip(`the script answered ${JSON.stringify(line)}`) };
}
