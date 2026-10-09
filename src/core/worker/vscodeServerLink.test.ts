// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): the script of the container setup that links
// the server of the store into the home folder of the remote user (VSCODE_SERVER_LINK_SCRIPT), run here with the shell
// of this computer in a temporary folder: its fixed paths (the store, /etc/passwd, /etc/alpine-release) are replaced by
// paths of the folder, and `uname`, `ldd` and `id -u` are small fakes on the PATH. The dev container is untrusted: links
// that it planted are never followed or written through. The fake passwd maps every user of the tests to a folder of
// the sandbox (no entry for /root or another real home), and HOME points into the sandbox too: a run never writes into a
// real home folder (an earlier version of this test wrote /root/.vscode-server when the tests ran as root).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET } from '../names';
import { scriptCommand } from './containerScripts';
import { VSCODE_SERVER_LINK_SCRIPT, vscodeServerLinkOutcome } from './vscodeServerLink';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const shell = !spawnSync('dash', ['-c', 'true'], { stdio: 'ignore' }).error ? 'dash' : 'sh';
const UID = String(process.getuid?.() ?? 0);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  store: string;
  home: string;
  passwd: string;
  alpine: string;
  /** Runs the script with these arguments (default: the commit, stable, linux-x64). */
  run(args?: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-link-'));
  temps.push(root);
  const store = path.join(root, 'store');
  const home = path.join(root, 'home', 'vscode');
  fs.mkdirSync(home, { recursive: true });
  const passwd = path.join(root, 'passwd');
  // Only users whose home is in the sandbox (the user of the tests, and 4242 with the same home).
  fs.writeFileSync(passwd, `vscode:x:${UID}:${UID}::${home}:/bin/sh\nother:x:4242:4242::${home}:/bin/sh\n`);
  const alpine = path.join(root, 'alpine-release');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  fake('uname', 'echo "${FAKE_MACHINE:-x86_64}"');
  fake('ldd', 'if [ -n "${FAKE_LDD_MUSL:-}" ]; then echo "musl libc (x86_64)" >&2; exit 1; fi\necho "ldd (GNU libc) 2.36"');
  fake('id', `if [ "$1" = -u ]; then echo "\${FAKE_UID:-${UID}}"; else exec /usr/bin/id "$@"; fi`);
  const script = VSCODE_SERVER_LINK_SCRIPT.split(VSCODE_STORE_TARGET).join(store).split('/etc/passwd').join(passwd).split('/etc/alpine-release').join(alpine);
  // Every fixed path of the script is replaced by one of the sandbox.
  expect(script).not.toMatch(/\/etc\/|\/opt\/devenv/);
  expect(fs.readFileSync(passwd, 'utf8').split('\n').filter(Boolean).every((line) => line.split(':')[5] === home)).toBe(true);
  return {
    root,
    store,
    home,
    passwd,
    alpine,
    run: (args = [COMMIT, 'stable', 'linux-x64'], env = {}) => {
      const result = spawnSync(shell, ['-c', script, 'sh', ...args], {
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: path.join(root, 'no-home'), ...env },
        cwd: root,
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

/** The server of the commit in the store of `s`. */
function serverInStore(s: Sandbox, quality = 'stable', platform = 'linux-x64'): string {
  const folder = path.join(s.store, 'server', quality, platform, COMMIT);
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '');
  fs.writeFileSync(path.join(folder, 'node'), '');
  return folder;
}

describe('the link of the shared VS Code server (plan step 11H1)', () => {
  it('is a script of the registry with three positional arguments', () => {
    expect(scriptCommand('vscodeServerLink', [COMMIT, 'stable', 'linux-x64'])).toEqual(['sh', '-c', VSCODE_SERVER_LINK_SCRIPT, 'sh', COMMIT, 'stable', 'linux-x64']);
    expect(VSCODE_SERVER_LINK_SCRIPT).toContain(`server="${VSCODE_STORE_TARGET}/server/$quality/$platform/$commit"`);
  });

  it('links ~/.vscode-server/bin/<commit> to the server in the store, then finds it present', () => {
    const s = sandbox();
    const server = serverInStore(s);
    expect(s.run()).toMatchObject({ status: 0, stdout: 'linked\n' });
    const link = path.join(s.home, '.vscode-server', 'bin', COMMIT);
    expect(fs.readlinkSync(link)).toBe(server);
    expect(fs.lstatSync(path.join(s.home, '.vscode-server')).isDirectory()).toBe(true);
    expect(s.run()).toMatchObject({ status: 0, stdout: 'present\n' });
    expect(fs.readlinkSync(link)).toBe(server);
  });

  it('uses ~/.vscode-server-insiders for the quality insider', () => {
    const s = sandbox();
    const server = serverInStore(s, 'insider');
    expect(s.run([COMMIT, 'insider', 'linux-x64'])).toMatchObject({ status: 0, stdout: 'linked\n' });
    expect(fs.readlinkSync(path.join(s.home, '.vscode-server-insiders', 'bin', COMMIT))).toBe(server);
    expect(fs.existsSync(path.join(s.home, '.vscode-server'))).toBe(false);
  });

  it('never replaces a server of the container: a folder, a file or a link of the commit is present', () => {
    for (const make of [
      (file: string) => fs.mkdirSync(file),
      (file: string) => fs.writeFileSync(file, ''),
      (file: string) => fs.symlinkSync('/nowhere', file),
    ]) {
      const s = sandbox();
      serverInStore(s);
      const bin = path.join(s.home, '.vscode-server', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      make(path.join(bin, COMMIT));
      const before = fs.lstatSync(path.join(bin, COMMIT));
      expect(s.run()).toMatchObject({ status: 0, stdout: 'present\n' });
      const after = fs.lstatSync(path.join(bin, COMMIT));
      expect([after.isDirectory(), after.isFile(), after.isSymbolicLink(), after.ino]).toEqual([before.isDirectory(), before.isFile(), before.isSymbolicLink(), before.ino]);
    }
  });

  it.each([
    ['the container of another platform', { FAKE_MACHINE: 'aarch64' }, 'skipped: the container is linux-arm64, the server in the store is for linux-x64'],
    ['a machine without a server', { FAKE_MACHINE: 'armv7l' }, 'skipped: the machine armv7l of the container has no server in the store'],
    ['musl, by ldd', { FAKE_LDD_MUSL: '1' }, 'skipped: the container uses musl, which has no server in the store'],
  ])('skips %s', (_name, env, line) => {
    const s = sandbox();
    serverInStore(s);
    expect(s.run(undefined, env)).toMatchObject({ status: 0, stdout: `${line}\n` });
    expect(fs.existsSync(path.join(s.home, '.vscode-server'))).toBe(false);
  });

  it('skips musl by /etc/alpine-release, the arm64 platform on arm64, and a store without the server', () => {
    const alpine = sandbox();
    serverInStore(alpine);
    fs.writeFileSync(alpine.alpine, '3.22.0\n');
    expect(alpine.run().stdout).toBe('skipped: the container uses musl, which has no server in the store\n');
    const arm = sandbox();
    serverInStore(arm, 'stable', 'linux-arm64');
    expect(arm.run([COMMIT, 'stable', 'linux-arm64'], { FAKE_MACHINE: 'aarch64' }).stdout).toBe('linked\n');
    const empty = sandbox();
    expect(empty.run().stdout).toBe('skipped: the store does not have the server\n');
    // Only bin/code-server, no node.
    const half = sandbox();
    fs.mkdirSync(path.join(half.store, 'server', 'stable', 'linux-x64', COMMIT, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(half.store, 'server', 'stable', 'linux-x64', COMMIT, 'bin', 'code-server'), '');
    expect(half.run().stdout).toBe('skipped: the store does not have the server\n');
  });

  it('skips a user without a home folder', () => {
    const s = sandbox();
    serverInStore(s);
    expect(s.run(undefined, { FAKE_UID: '5000' }).stdout).toBe('skipped: the user has no home folder\n');
  });

  it.each([
    ['a short commit', [COMMIT.slice(1), 'stable', 'linux-x64'], 'skipped: the commit is invalid'],
    ['a commit with a path', [`../${COMMIT.slice(3)}`, 'stable', 'linux-x64'], 'skipped: the commit is invalid'],
    ['another quality', [COMMIT, 'exploration', 'linux-x64'], 'skipped: the quality is invalid'],
    ['another platform', [COMMIT, 'stable', 'alpine-x64'], 'skipped: the platform is invalid'],
  ])('skips %s', (_name, args, line) => {
    const s = sandbox();
    serverInStore(s);
    expect(s.run(args).stdout).toBe(`${line}\n`);
  });

  describe('refuses what the container planted, and writes nothing through it', () => {
    it('~/.vscode-server as a link', () => {
      const s = sandbox();
      serverInStore(s);
      const elsewhere = path.join(s.root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, path.join(s.home, '.vscode-server'));
      expect(s.run().stdout).toBe(`refused: ${s.home}/.vscode-server is a link\n`);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });

    it('~/.vscode-server/bin as a link', () => {
      const s = sandbox();
      serverInStore(s);
      const elsewhere = path.join(s.root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.mkdirSync(path.join(s.home, '.vscode-server'));
      fs.symlinkSync(elsewhere, path.join(s.home, '.vscode-server', 'bin'));
      expect(s.run().stdout).toBe(`refused: ${s.home}/.vscode-server/bin is a link\n`);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });

    it('a file in place of a folder', () => {
      const s = sandbox();
      serverInStore(s);
      fs.writeFileSync(path.join(s.home, '.vscode-server'), '');
      expect(s.run().stdout).toBe(`refused: ${s.home}/.vscode-server is not a folder\n`);
    });

    it('a folder of another user', () => {
      const s = sandbox();
      serverInStore(s);
      fs.mkdirSync(path.join(s.home, '.vscode-server', 'bin'), { recursive: true });
      // The user 4242 (same home in the fake /etc/passwd) does not own the folders of this test.
      expect(s.run(undefined, { FAKE_UID: '4242' }).stdout).toBe(`refused: ${s.home}/.vscode-server is not the user's\n`);
      expect(fs.readdirSync(path.join(s.home, '.vscode-server', 'bin'))).toEqual([]);
    });
  });
});

describe('the outcome of the link (plan step 11H1)', () => {
  const ok = (stdout: string) => vscodeServerLinkOutcome({ exitCode: 0, stdout, stderr: '' });
  it('reads the one line of the script', () => {
    expect(ok('linked\n')).toEqual({ kind: 'linked' });
    expect(ok('present\n')).toEqual({ kind: 'present' });
    expect(ok('skipped: the store does not have the server\n')).toEqual({ kind: 'skipped', reason: 'the store does not have the server' });
    expect(ok('refused: /home/v/.vscode-server is a link\n')).toEqual({ kind: 'refused', reason: '/home/v/.vscode-server is a link' });
  });

  it('a failed command, the time limit, or an unknown line is a failure', () => {
    expect(vscodeServerLinkOutcome({ exitCode: 1, stdout: '', stderr: "mkdir: cannot create directory '/home/v/.vscode-server': Permission denied\n" })).toEqual({
      kind: 'failed',
      reason: "exit code 1: mkdir: cannot create directory '/home/v/.vscode-server': Permission denied",
    });
    expect(vscodeServerLinkOutcome({ exitCode: null, stdout: '', stderr: '', timedOut: true })).toEqual({ kind: 'failed', reason: 'the script took too long' });
    expect(vscodeServerLinkOutcome({ exitCode: 126, stdout: '', stderr: '' })).toEqual({ kind: 'failed', reason: 'exit code 126' });
    expect(ok('linkd\n')).toEqual({ kind: 'failed', reason: 'the script answered "linkd"' });
    expect(ok('').kind).toBe('failed');
    expect(ok(`skipped: ${'x'.repeat(400)}`)).toMatchObject({ kind: 'skipped' });
    expect((ok(`skipped: ${'x'.repeat(400)}`) as { reason: string }).reason).toHaveLength(300);
  });
});
