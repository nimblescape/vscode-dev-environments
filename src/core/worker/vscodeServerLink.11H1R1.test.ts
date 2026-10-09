// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1 (reviewer B): the link script never writes through a link that the container plants
// after a check. It works in each folder that it checked (entered after the check, its real path and owner checked
// there) and creates the link with `ln -sn`. Run as vscodeServerLink.test.ts runs it: the fixed paths of the script are
// replaced by paths of a temporary folder, the fake /etc/passwd maps the user to a folder of the sandbox, HOME points into
// the sandbox, and `uname`, `ldd`, `id` and `ls` are fakes on the PATH (the fake `ls` plants a link between a check and
// the next step); nothing is written outside the sandbox.
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

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-link-r1-'));
  temps.push(root);
  const store = path.join(root, 'store');
  const server = path.join(store, 'server', 'stable', 'linux-x64', COMMIT);
  fs.mkdirSync(path.join(server, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(server, 'bin', 'code-server'), '');
  fs.writeFileSync(path.join(server, 'node'), '');
  const home = path.join(root, 'home', 'vscode');
  fs.mkdirSync(home, { recursive: true });
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const passwd = path.join(root, 'passwd');
  fs.writeFileSync(passwd, `vscode:x:${UID}:${UID}::${home}:/bin/sh\n`);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  fake('uname', 'echo x86_64');
  fake('ldd', 'echo "ldd (GNU libc) 2.36"');
  fake('id', `if [ "$1" = -u ]; then echo ${UID}; else exec /usr/bin/id "$@"; fi`);
  // `ls -ldn <folder>` (the owner check): when its folder ends in $FAKE_SWAP_NAME, the container "plants" a link to
  // $FAKE_SWAP_TARGET there, after the script checked that it is no link.
  fake(
    'ls',
    [
      'last=""; for a in "$@"; do last="$a"; done',
      'case "$last" in',
      '  *"/${FAKE_SWAP_NAME:-none}"|"${FAKE_SWAP_NAME:-none}")',
      '    if [ ! -L "$last" ]; then mv "$last" "$last.checked" && ln -s "$FAKE_SWAP_TARGET" "$last"; fi ;;',
      'esac',
      `exec ${realLs} "$@"`,
    ].join('\n'),
  );
  const script = VSCODE_SERVER_LINK_SCRIPT.split(VSCODE_STORE_TARGET).join(store).split('/etc/passwd').join(passwd).split('/etc/alpine-release').join(path.join(root, 'alpine-release'));
  expect(script).not.toMatch(/\/etc\/|\/opt\/devenv/);
  return {
    root,
    home,
    elsewhere,
    run: (env: Record<string, string> = {}) => {
      const result = spawnSync(shell, ['-c', script, 'sh', COMMIT, 'stable', 'linux-x64'], {
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: path.join(root, 'no-home'), ...env },
        cwd: root,
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

describe('the link script writes through no link planted after a check (review round 1 of 11H1, reviewer B)', () => {
  const rootServer = fs.existsSync('/root/.vscode-server');

  it('~/.vscode-server replaced by a link after its check: refused, nothing written there', () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.vscode-server'));
    expect(s.run({ FAKE_SWAP_NAME: '.vscode-server', FAKE_SWAP_TARGET: s.elsewhere })).toMatchObject({
      status: 0,
      stdout: `refused: ${s.home}/.vscode-server was replaced while it was checked\n`,
    });
    // The link was planted (the fake ran), and nothing went through it.
    expect(fs.lstatSync(path.join(s.home, '.vscode-server')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(s.elsewhere)).toEqual([]);
  });

  it('~/.vscode-server/bin replaced by a link after its check: refused, nothing written there', () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.vscode-server', 'bin'), { recursive: true });
    expect(s.run({ FAKE_SWAP_NAME: 'bin', FAKE_SWAP_TARGET: s.elsewhere })).toMatchObject({
      status: 0,
      stdout: `refused: ${s.home}/.vscode-server/bin was replaced while it was checked\n`,
    });
    expect(fs.lstatSync(path.join(s.home, '.vscode-server', 'bin')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(s.elsewhere)).toEqual([]);
  });

  it('without a planted link, the folders that exist are taken and linked as before', () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.vscode-server', 'bin'), { recursive: true });
    expect(s.run()).toMatchObject({ status: 0, stdout: 'linked\n' });
    expect(fs.readlinkSync(path.join(s.home, '.vscode-server', 'bin', COMMIT))).toContain(`/server/stable/linux-x64/${COMMIT}`);
  });

  it('creates the link with `ln -sn`: a link to a folder at the name makes it fail, it never writes into that folder', () => {
    // The check of bin/<commit> comes right before `ln` (no command between them that a test could use to plant a
    // link); this pins the option the script relies on, with the tools of this computer.
    expect(VSCODE_SERVER_LINK_SCRIPT).toContain('ln -sn "$server" "$commit" || exit 1');
    const s = sandbox();
    const name = path.join(s.root, 'link');
    fs.symlinkSync(s.elsewhere, name);
    const result = spawnSync('ln', ['-sn', '/opt/target', name], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(s.elsewhere)).toEqual([]);
  });

  it('wrote nothing into the real home of root', () => {
    expect(fs.existsSync('/root/.vscode-server')).toBe(rootServer);
  });
});
