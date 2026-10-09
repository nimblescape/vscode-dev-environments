// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11H1 (reviewers A and B): the link script unsets CDPATH, so an image whose environment sets
// it (for example CDPATH=/usr, which has a `bin`) never makes `cd -P bin` enter a folder of CDPATH and a valid home be
// refused. Run as vscodeServerLink.test.ts runs it: the fixed paths of the script are replaced by paths of a temporary
// folder, the fake /etc/passwd maps the user to a folder of the sandbox, HOME points into the sandbox, and `uname`, `ldd`
// and `id` are fakes on the PATH; CDPATH points into the sandbox too. Nothing is written outside the sandbox.
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

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-link-r2-'));
  temps.push(root);
  const store = path.join(root, 'store');
  const server = path.join(store, 'server', 'stable', 'linux-x64', COMMIT);
  fs.mkdirSync(path.join(server, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(server, 'bin', 'code-server'), '');
  fs.writeFileSync(path.join(server, 'node'), '');
  const home = path.join(root, 'home', 'vscode');
  fs.mkdirSync(home, { recursive: true });
  // The folder of CDPATH: it has a `.vscode-server` and a `bin`, as /usr has a `bin`.
  const cdpath = path.join(root, 'cdpath');
  fs.mkdirSync(path.join(cdpath, '.vscode-server'), { recursive: true });
  fs.mkdirSync(path.join(cdpath, 'bin'));
  const passwd = path.join(root, 'passwd');
  fs.writeFileSync(passwd, `vscode:x:${UID}:${UID}::${home}:/bin/sh\n`);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  fake('uname', 'echo x86_64');
  fake('ldd', 'echo "ldd (GNU libc) 2.36"');
  fake('id', `if [ "$1" = -u ]; then echo ${UID}; else exec /usr/bin/id "$@"; fi`);
  const script = VSCODE_SERVER_LINK_SCRIPT.split(VSCODE_STORE_TARGET).join(store).split('/etc/passwd').join(passwd).split('/etc/alpine-release').join(path.join(root, 'alpine-release'));
  expect(script).not.toMatch(/\/etc\/|\/opt\/devenv/);
  return {
    root,
    home,
    cdpath,
    run: (env: Record<string, string> = {}) => {
      const result = spawnSync(shell, ['-c', script, 'sh', COMMIT, 'stable', 'linux-x64'], {
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: path.join(root, 'no-home'), ...env },
        cwd: root,
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout };
    },
  };
}

describe('the link script ignores CDPATH (review round 2 of 11H1, reviewers A and B)', () => {
  const rootServer = fs.existsSync('/root/.vscode-server');

  it('CDPATH with a .vscode-server and a bin: linked in the home folder, nothing in the folder of CDPATH', () => {
    const s = sandbox();
    expect(s.run({ CDPATH: s.cdpath })).toEqual({ status: 0, stdout: 'linked\n' });
    expect(fs.readlinkSync(path.join(s.home, '.vscode-server', 'bin', COMMIT))).toContain(`/server/stable/linux-x64/${COMMIT}`);
    expect(fs.readdirSync(path.join(s.cdpath, '.vscode-server'))).toEqual([]);
    expect(fs.readdirSync(path.join(s.cdpath, 'bin'))).toEqual([]);
  });

  it('CDPATH with only a bin (as CDPATH=/usr): the existing folders are taken and linked', () => {
    const s = sandbox();
    fs.rmdirSync(path.join(s.cdpath, '.vscode-server'));
    fs.mkdirSync(path.join(s.home, '.vscode-server', 'bin'), { recursive: true });
    expect(s.run({ CDPATH: s.cdpath })).toEqual({ status: 0, stdout: 'linked\n' });
    expect(fs.readlinkSync(path.join(s.home, '.vscode-server', 'bin', COMMIT))).toContain(`/server/stable/linux-x64/${COMMIT}`);
    expect(fs.readdirSync(path.join(s.cdpath, 'bin'))).toEqual([]);
  });

  it('wrote nothing into the real home of root', () => {
    expect(fs.existsSync('/root/.vscode-server')).toBe(rootServer);
  });
});
