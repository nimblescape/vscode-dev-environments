// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Fix after the live check of 2026-10-10: the script that tells the open whether the remote user's home folder has the
// server of the window already (VSCODE_SERVER_PRESENT_SCRIPT), run here with the shell of this computer in a temporary
// folder: /etc/passwd is replaced by a file of the sandbox that maps the user of the tests to a home folder of the
// sandbox, so a run never looks at (or touches) a real home folder. It only tests: the sandbox is unchanged afterwards.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTAINER_SCRIPTS, scriptCommand } from './containerScripts';
import { VSCODE_SERVER_PRESENT_SCRIPT, vscodeServerPresent } from './vscodeServerLink';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const shell = !spawnSync('dash', ['-c', 'true'], { stdio: 'ignore' }).error ? 'dash' : 'sh';
const UID = String(process.getuid?.() ?? 0);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-present-'));
  temps.push(root);
  const home = path.join(root, 'home', 'vscode');
  fs.mkdirSync(home, { recursive: true });
  const passwd = path.join(root, 'passwd');
  fs.writeFileSync(passwd, `vscode:x:${UID}:${UID}::${home}:/bin/sh\n`);
  const script = VSCODE_SERVER_PRESENT_SCRIPT.split('/etc/passwd').join(passwd);
  expect(script).not.toMatch(/\/etc\//);
  const listing = (): string[] => {
    const all: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        all.push(`${full}:${entry.isSymbolicLink() ? 'l' : entry.isDirectory() ? 'd' : 'f'}`);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(root);
    return all.sort();
  };
  return {
    root,
    home,
    listing,
    run: (args: string[] = [COMMIT, 'stable']) => {
      const result = spawnSync(shell, ['-c', script, 'sh', ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(root, 'no-home') }, cwd: root, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

describe('the check whether the container has the server of the window (live check of 2026-10-10)', () => {
  it('is a script of the registry with two positional arguments and no secret', () => {
    expect(scriptCommand('vscodeServerPresent', [COMMIT, 'stable'])).toEqual(['sh', '-c', VSCODE_SERVER_PRESENT_SCRIPT, 'sh', COMMIT, 'stable']);
    expect('secretInputName' in CONTAINER_SCRIPTS.vscodeServerPresent).toBe(false);
  });

  it('answers missing without ~/.vscode-server/bin/<commit>, and changes nothing', () => {
    const s = sandbox();
    const before = s.listing();
    expect(s.run()).toEqual({ status: 0, stdout: 'missing\n', stderr: '' });
    expect(s.listing()).toEqual(before);
  });

  it.each([
    ['a folder (the Dev Containers extension installed it)', (target: string) => fs.mkdirSync(target)],
    ['a link into the store (an earlier open linked it)', (target: string) => fs.symlinkSync('/opt/devenv/vscode/server/stable/linux-x64/x', target)],
    ['a file', (target: string) => fs.writeFileSync(target, '')],
  ])('answers present for %s at bin/<commit>, and changes nothing', (_name, make) => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.vscode-server', 'bin'), { recursive: true });
    make(path.join(s.home, '.vscode-server', 'bin', COMMIT));
    const before = s.listing();
    expect(s.run()).toEqual({ status: 0, stdout: 'present\n', stderr: '' });
    expect(s.listing()).toEqual(before);
  });

  it('looks in ~/.vscode-server-insiders for the quality insider, not in ~/.vscode-server', () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.vscode-server', 'bin', COMMIT), { recursive: true });
    expect(s.run([COMMIT, 'insider']).stdout).toBe('missing\n');
    fs.mkdirSync(path.join(s.home, '.vscode-server-insiders', 'bin', COMMIT), { recursive: true });
    expect(s.run([COMMIT, 'insider']).stdout).toBe('present\n');
  });

  it.each([
    ['an invalid commit', ['0123', 'stable']],
    ['a commit with a path', ['../../etc/passwd/0123456789abcdef0123456789', 'stable']],
    ['an unknown quality', [COMMIT, 'exploration']],
  ])('answers missing for %s', (_name, args) => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.vscode-server', 'bin', COMMIT), { recursive: true });
    expect(s.run(args).stdout).toBe('missing\n');
  });

  it('reads only present with exit code 0 as present', () => {
    expect(vscodeServerPresent({ exitCode: 0, stdout: 'present\n' })).toBe(true);
    expect(vscodeServerPresent({ exitCode: 0, stdout: 'missing\n' })).toBe(false);
    expect(vscodeServerPresent({ exitCode: 1, stdout: 'present\n' })).toBe(false);
    expect(vscodeServerPresent({ exitCode: null, stdout: 'present\n' })).toBe(false);
    expect(vscodeServerPresent({ exitCode: 0, stdout: 'present\n', timedOut: true })).toBe(false);
    expect(vscodeServerPresent({ exitCode: 0, stdout: '' })).toBe(false);
  });
});
