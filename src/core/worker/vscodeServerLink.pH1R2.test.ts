// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11H1 (reviewer B, mutation testing): probes of the folder checks of the link script
// (VSCODE_SERVER_LINK_SCRIPT, review round 1) that no test held: a home folder that the user cannot enter ends the script
// (it never goes on in its working folder), and the owner check inside a folder after `cd -P` refuses a folder of another
// user that was swapped in after the first check (same path, so the `pwd -P` check passes). Run as
// vscodeServerLink.test.ts runs it: the fixed paths of the script are replaced by paths of a temporary folder, the fake
// /etc/passwd maps the user to a folder of the sandbox, HOME points into the sandbox, and `uname`, `ldd`, `id` and `ls`
// are fakes on the PATH; nothing is written outside the sandbox.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET } from '../names';
import { VSCODE_SERVER_LINK_SCRIPT } from './vscodeServerLink';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const shell = !spawnSync('dash', ['-c', 'true'], { stdio: 'ignore' }).error ? 'dash' : 'sh';
const UID = String(process.getuid?.() ?? 0);
const realLs = ['/usr/bin/ls', '/bin/ls'].find((file) => fs.existsSync(file)) ?? 'ls';
const realMv = ['/usr/bin/mv', '/bin/mv'].find((file) => fs.existsSync(file)) ?? 'mv';
// `setpriv` (util-linux) runs the shell without capabilities, so that a root user of the tests gets the permission checks
// of a plain user (a home folder it cannot enter).
const setpriv = ['/usr/bin/setpriv', '/bin/setpriv'].find((file) => fs.existsSync(file));

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    // A folder of the sandbox may have been made unreadable by a test.
    spawnSync('chmod', ['-R', 'u+rwx', dir], { stdio: 'ignore' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-link-r2probe-'));
  temps.push(root);
  const store = path.join(root, 'store');
  const server = path.join(store, 'server', 'stable', 'linux-x64', COMMIT);
  fs.mkdirSync(path.join(server, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(server, 'bin', 'code-server'), '');
  fs.writeFileSync(path.join(server, 'node'), '');
  const home = path.join(root, 'home', 'vscode');
  fs.mkdirSync(home, { recursive: true });
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const passwd = path.join(root, 'passwd');
  fs.writeFileSync(passwd, `vscode:x:${UID}:${UID}::${home}:/bin/sh\n`);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  fake('uname', 'echo x86_64');
  fake('ldd', 'echo "ldd (GNU libc) 2.36"');
  fake('id', `if [ "$1" = -u ]; then echo ${UID}; else exec /usr/bin/id "$@"; fi`);
  // `ls -ldn <folder>` (the first owner check): when its folder is $FAKE_SWAP_NAME, the container swaps in the folder
  // $FAKE_SWAP_FOLDER (another user's) at the same path, right after `ls` read the owner of the first one.
  fake(
    'ls',
    [
      'last=""; for a in "$@"; do last="$a"; done',
      `out=$(${realLs} "$@"); rc=$?`,
      'if [ -n "${FAKE_SWAP_NAME:-}" ] && [ "$last" = "$FAKE_SWAP_NAME" ] && [ ! -e "$last.checked" ]; then',
      `  ${realMv} "$last" "$last.checked" && ${realMv} "$FAKE_SWAP_FOLDER" "$last"`,
      'fi',
      'printf "%s\\n" "$out"',
      'exit $rc',
    ].join('\n'),
  );
  const script = VSCODE_SERVER_LINK_SCRIPT.split(VSCODE_STORE_TARGET).join(store).split('/etc/passwd').join(passwd).split('/etc/alpine-release').join(path.join(root, 'alpine-release'));
  expect(script).not.toMatch(/\/etc\/|\/opt\/devenv/);
  return {
    root,
    home,
    work,
    run: (env: Record<string, string> = {}, prefix: string[] = []) => {
      const command = [...prefix, shell, '-c', script, 'sh', COMMIT, 'stable', 'linux-x64'];
      const result = spawnSync(command[0], command.slice(1), {
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: path.join(root, 'no-home'), ...env },
        // The working folder of `docker exec` (the workspace folder of the repository in a real container).
        cwd: work,
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout };
    },
  };
}

describe('the folder checks of the link script, probes (review round 2 of 11H1, reviewer B)', () => {
  const rootServer = fs.existsSync('/root/.vscode-server');

  it.skipIf(setpriv === undefined)('a home folder that the user cannot enter: the script fails and writes nothing into its working folder', () => {
    const s = sandbox();
    fs.chmodSync(s.home, 0o000);
    // Without capabilities the root user of the tests cannot enter a folder of mode 000 either; `[ -d ]` still holds.
    expect(spawnSync(setpriv as string, ['--bounding-set', '-all', '--inh-caps', '-all', '--', shell, '-c', `[ -d '${s.home}' ] && ! cd '${s.home}' 2>/dev/null`], { stdio: 'ignore' }).status).toBe(0);
    const result = s.run({}, [setpriv as string, '--bounding-set', '-all', '--inh-caps', '-all', '--']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('linked');
    expect(fs.readdirSync(s.work)).toEqual([]);
  });

  it("~/.vscode-server swapped for another user's folder after its first check: refused, nothing created in it", () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.vscode-server'));
    // The folder of another user, swapped in at the same path (the `pwd -P` check sees the expected path).
    const other = path.join(s.root, 'other');
    fs.mkdirSync(other);
    const otherUid = Number(UID) + 1000;
    fs.chownSync(other, otherUid, otherUid);
    if (fs.statSync(other).uid !== otherUid) return; // Only a root user of the tests can give a folder another owner.
    expect(s.run({ FAKE_SWAP_NAME: '.vscode-server', FAKE_SWAP_FOLDER: other })).toEqual({
      status: 0,
      stdout: `refused: ${s.home}/.vscode-server is not the user's\n`,
    });
    // The swap happened (the fake ran), and nothing was created in the other user's folder.
    expect(fs.existsSync(path.join(s.home, '.vscode-server.checked'))).toBe(true);
    expect(fs.statSync(path.join(s.home, '.vscode-server')).uid).toBe(otherUid);
    expect(fs.readdirSync(path.join(s.home, '.vscode-server'))).toEqual([]);
  });

  it('wrote nothing into the real home of root', () => {
    expect(fs.existsSync('/root/.vscode-server')).toBe(rootServer);
  });
});
