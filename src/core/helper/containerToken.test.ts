// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 15: the token of the owner account only in the memory of the dev container (TOKEN_WRITE_SCRIPT,
// TOKEN_REMOVE_SCRIPT, writeContainerToken, removeContainerToken).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../ports';
import { GH_CONFIG_FOLDER, GH_HOSTS_FILE, GH_VOLUME_CONFIG_FILE, GITHUB_TOKEN_FILE, TOKEN_FOLDER, TOKEN_TMPFS } from '../names';
import {
  TOKEN_REMOVE_SCRIPT,
  TOKEN_WRITE_SCRIPT,
  removeContainerToken,
  tokenRemoveCommand,
  tokenWriteCommand,
  writeContainerToken,
  type ContainerExec,
} from './containerToken';

const TOKEN = 'gho_secret_value';
const shell = !spawnSync('dash', ['-c', 'true'], { stdio: 'ignore' }).error ? 'dash' : 'sh';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-token-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('the names of unit 15', () => {
  it('keep the token and the sign-in of the GitHub CLI in the tmpfs /run/devenv, and config.yml in the volume', () => {
    expect(TOKEN_FOLDER).toBe('/run/devenv');
    expect(TOKEN_TMPFS).toBe('/run/devenv:rw,nosuid,nodev,noexec,size=1m,mode=0700');
    expect(GITHUB_TOKEN_FILE).toBe('/run/devenv/github-token');
    expect(GH_CONFIG_FOLDER).toBe('/run/devenv/gh');
    expect(GH_HOSTS_FILE).toBe('/run/devenv/gh/hosts.yml');
    expect(GH_VOLUME_CONFIG_FILE).toBe('/workspaces/.devenv+/gh/config.yml');
  });

  it('commands: the scripts with their arguments, never the token', () => {
    expect(tokenWriteCommand('dev', 'octo')).toEqual(['sh', '-c', TOKEN_WRITE_SCRIPT, 'sh', 'dev', 'octo']);
    expect(tokenRemoveCommand()).toEqual(['sh', '-c', TOKEN_REMOVE_SCRIPT, 'sh']);
  });
});

/**
 * The scripts with the folder and /proc/mounts of a test folder, and tools on PATH that log their arguments (so a test
 * sees whether the token is ever an argument of a program). `id` knows root (0), dev (1000:1001); chown only logs.
 */
function setup(options: { mounts?: (dir: string) => string; chownFails?: boolean } = {}) {
  const base = tempDir();
  const dir = path.join(base, 'run-devenv');
  const mounts = path.join(base, 'mounts');
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'log');
  fs.mkdirSync(dir);
  write(mounts, options.mounts ? options.mounts(dir) : `proc /proc proc rw 0 0\ntmpfs ${dir} tmpfs rw,nosuid,nodev,noexec,size=1024k,mode=700 0 0\n`);
  const tool = (name: string, body: string) => {
    write(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  for (const name of ['cat', 'tr', 'wc', 'chmod', 'mkdir', 'ln', 'rm']) tool(name, `PATH=/usr/bin:/bin exec ${name} "$@"`);
  tool(
    'id',
    [
      'case "$1:$2" in',
      '  -u:root) echo 0 ;; -g:root) echo 0 ;;',
      '  -u:dev) echo 1000 ;; -g:dev) echo 1001 ;;',
      '  *) echo "id: $2: no such user" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  tool('chown', options.chownFails ? 'case "$*" in *0:0*) exit 0 ;; esac\necho "chown: Operation not permitted" >&2\nexit 1' : 'exit 0');
  const adapt = (script: string) => script.split(TOKEN_FOLDER).join(dir).split('/proc/mounts').join(mounts);
  const runScript = (script: string, args: string[], input?: string) => {
    const result = spawnSync(shell, ['-c', adapt(script), 'sh', ...args], {
      encoding: 'utf8',
      input: input ?? '',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return {
    dir,
    log,
    logText: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
    write: (user = 'dev', login = 'scalarion', token = TOKEN) => runScript(TOKEN_WRITE_SCRIPT, [user, login], token),
    remove: () => runScript(TOKEN_REMOVE_SCRIPT, []),
  };
}

describe('TOKEN_WRITE_SCRIPT (in the dev container, as root)', () => {
  it('writes the token (0600), the sign-in of the GitHub CLI (0600 in a 0700 folder), and the link of config.yml', () => {
    const env = setup();
    const result = env.write();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('The GitHub token of the environment is in');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    const token = path.join(env.dir, 'github-token');
    expect(fs.readFileSync(token, 'utf8')).toBe(TOKEN);
    expect(fs.statSync(token).mode & 0o777).toBe(0o600);
    const gh = path.join(env.dir, 'gh');
    expect(fs.statSync(gh).mode & 0o777).toBe(0o700);
    const hosts = path.join(gh, 'hosts.yml');
    // Both forms that gh reads: the keys of the host (gh before 2.40, and the active account of gh 2.40 and newer), and
    // the accounts under `users` (gh 2.40 and newer).
    expect(fs.readFileSync(hosts, 'utf8')).toBe(
      [
        'github.com:',
        '    users:',
        '        "scalarion":',
        `            oauth_token: "${TOKEN}"`,
        '    git_protocol: https',
        `    oauth_token: "${TOKEN}"`,
        '    user: "scalarion"',
        '',
      ].join('\n'),
    );
    expect(fs.statSync(hosts).mode & 0o777).toBe(0o600);
    // gh's settings (no secret) stay in the volume.
    expect(fs.readlinkSync(path.join(gh, 'config.yml'))).toBe(GH_VOLUME_CONFIG_FILE);
    expect(fs.readdirSync(env.dir).sort()).toEqual(['gh', 'github-token']);
    expect(fs.readdirSync(gh).sort()).toEqual(['config.yml', 'hosts.yml']);
    // The folder is root's while it is written, and the remote user's at the end: its files first, the folder last.
    const chowns = env.logText().split('\n').filter((line) => line.startsWith('chown '));
    expect(chowns[0]).toBe(`chown 0:0 ${env.dir}`);
    expect(chowns).toContain(`chown -h 1000:1001 ${token} ${gh} ${gh}/config.yml`);
    expect(chowns).toContain(`chown 1000:1001 ${hosts}`);
    expect(chowns.at(-1)).toBe(`chown 1000:1001 ${env.dir}`);
    // The token is never an argument of a program.
    expect(env.logText()).not.toContain(TOKEN);
  });

  it('writes a new token at each run, and removes what else is in the folder (an old token, a link of the user)', () => {
    const env = setup();
    expect(env.write().status).toBe(0);
    const elsewhere = path.join(tempDir(), 'elsewhere');
    write(elsewhere, 'x');
    fs.rmSync(path.join(env.dir, 'gh', 'hosts.yml'));
    fs.symlinkSync(elsewhere, path.join(env.dir, 'gh', 'hosts.yml'));
    write(path.join(env.dir, '.copy-of-the-token'), TOKEN);
    const result = env.write('dev', 'octo-cat', 'gho_new_token');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(env.dir, 'github-token'), 'utf8')).toBe('gho_new_token');
    const text = fs.readFileSync(path.join(env.dir, 'gh', 'hosts.yml'), 'utf8');
    expect(text).toContain('    oauth_token: "gho_new_token"\n    user: "octo-cat"\n');
    expect(text).toContain('        "octo-cat":\n            oauth_token: "gho_new_token"\n');
    expect(text).not.toContain(TOKEN);
    expect(fs.lstatSync(path.join(env.dir, 'gh', 'hosts.yml')).isFile()).toBe(true);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('x');
    expect(fs.readdirSync(env.dir).sort()).toEqual(['gh', 'github-token']);
  });

  it('signs the GitHub CLI in with the login of an Enterprise Managed User (with an underscore)', () => {
    const env = setup();
    expect(env.write('dev', 'dev_acme').status).toBe(0);
    const text = fs.readFileSync(path.join(env.dir, 'gh', 'hosts.yml'), 'utf8');
    expect(text).toContain(`    users:\n        "dev_acme":\n            oauth_token: "${TOKEN}"\n`);
    expect(text).toContain('    user: "dev_acme"\n');
  });

  it.each([
    ['empty', ''],
    ['starting with a hyphen', '-octo'],
    ['starting with an underscore', '_x'],
    ['with a quote', 'octo"'],
    ['with a colon and a space', 'a: b'],
    ['with a new line', 'octo\nuser: x'],
    ['too long', 'x'.repeat(40)],
  ])('signs the GitHub CLI in nowhere for a GitHub login %s, and still writes the token', (_name, login) => {
    const env = setup();
    // A sign-in of an earlier run is removed, so gh never works with an old token or as another account.
    expect(env.write().status).toBe(0);
    const result = env.write('dev', login);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('The GitHub CLI in the container is not signed in: the GitHub login of the account is not known.');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(fs.existsSync(path.join(env.dir, 'gh', 'hosts.yml'))).toBe(false);
    expect(fs.readFileSync(path.join(env.dir, 'github-token'), 'utf8')).toBe(TOKEN);
  });

  it('signs the GitHub CLI in nowhere for a token that YAML would need to escape, and still writes the token file', () => {
    const env = setup();
    const result = env.write('dev', 'scalarion', 'gho_"x":\\y');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('The GitHub CLI in the container is not signed in: the token has characters');
    expect(fs.existsSync(path.join(env.dir, 'gh', 'hosts.yml'))).toBe(false);
    expect(fs.readFileSync(path.join(env.dir, 'github-token'), 'utf8')).toBe('gho_"x":\\y');
  });

  it.each([
    ['no mount at the folder', () => 'proc /proc proc rw 0 0\n'],
    ['a mount of another folder', () => 'tmpfs /elsewhere tmpfs rw 0 0\n'],
    ['a volume at the folder', (dir: string) => `proc /proc proc rw 0 0\n/dev/sda1 ${dir} ext4 rw 0 0\n`],
    ['a volume over the tmpfs', (dir: string) => `tmpfs ${dir} tmpfs rw 0 0\n/dev/sda1 ${dir} ext4 rw 0 0\n`],
  ])('writes nothing and removes nothing without the tmpfs at the folder (%s)', (_name, mounts) => {
    const env = setup({ mounts });
    write(path.join(env.dir, 'kept'), 'x');
    const result = env.write();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('is not a tmpfs mount of the container');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(fs.readdirSync(env.dir)).toEqual(['kept']);
    expect(env.logText()).not.toContain('chown');
  });

  it('accepts the tmpfs when a mount of a parent folder lies below it (for example --tmpfs /run)', () => {
    const env = setup({ mounts: (dir) => `tmpfs ${path.dirname(dir)} tmpfs rw 0 0\ntmpfs ${dir} tmpfs rw,mode=700 0 0\n` });
    expect(env.write().status).toBe(0);
    expect(fs.readFileSync(path.join(env.dir, 'github-token'), 'utf8')).toBe(TOKEN);
  });

  it('empties the folder again when no token arrives on standard input', () => {
    const env = setup();
    expect(env.write().status).toBe(0);
    const result = env.write('dev', 'scalarion', '');
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('No token on standard input.');
    expect(fs.readdirSync(env.dir)).toEqual([]);
  });

  it('empties the folder when root may not give the files to the user (for example --cap-drop ALL)', () => {
    const env = setup({ chownFails: true });
    const result = env.write();
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('Root in the container may not give the files of');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(fs.readdirSync(env.dir)).toEqual([]);
  });

  it('gives nothing away for the remote user root', () => {
    const env = setup({ chownFails: true });
    const result = env.write('root');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(env.dir, 'github-token'), 'utf8')).toBe(TOKEN);
    expect(env.logText().split('\n').filter((line) => line.startsWith('chown '))).toEqual([`chown 0:0 ${env.dir}`]);
  });

  it('takes a numeric user as it is, and refuses an unknown name or an invalid user without writing', () => {
    const numeric = setup();
    expect(numeric.write('1234').status).toBe(0);
    expect(numeric.logText()).toContain(`chown 1234:1234 ${numeric.dir}`);

    const unknown = setup();
    const result = unknown.write('nobody-here');
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('The user nobody-here is not known in the container.');
    expect(fs.readdirSync(unknown.dir)).toEqual([]);

    for (const user of ['', '-u', 'a b', 'x;y']) {
      const invalid = setup();
      const refused = invalid.write(user);
      expect(refused.status).toBe(2);
      expect(fs.readdirSync(invalid.dir)).toEqual([]);
    }
  });
});

describe('TOKEN_REMOVE_SCRIPT (in the dev container)', () => {
  it('empties the tmpfs, also of hidden files and links (never their targets)', () => {
    const env = setup();
    expect(env.write().status).toBe(0);
    const elsewhere = path.join(tempDir(), 'elsewhere');
    write(elsewhere, 'x');
    fs.symlinkSync(elsewhere, path.join(env.dir, 'link'));
    write(path.join(env.dir, '.hidden'), TOKEN);
    const result = env.remove();
    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('The GitHub token was removed from the container.');
    expect(fs.readdirSync(env.dir)).toEqual([]);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('x');
  });

  it('removes nothing where the folder is no tmpfs (a container of an earlier version)', () => {
    const env = setup({ mounts: () => 'proc /proc proc rw 0 0\n' });
    write(path.join(env.dir, 'kept'), 'x');
    const result = env.remove();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('holds no GitHub token there');
    expect(fs.readdirSync(env.dir)).toEqual(['kept']);
  });

  it('fails with exit code 1 when the token is still there', () => {
    const env = setup();
    expect(env.write().status).toBe(0);
    // An rm that removes nothing (for example without the rights to enter the folder).
    write(path.join(path.dirname(env.log), 'bin', 'rm'), '#!/bin/sh\nexit 1\n');
    const result = env.remove();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('github-token could not be removed');
    expect(result.stdout).not.toContain('The GitHub token was removed');
  });
});

function execResult(partial: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...partial };
}

describe('writeContainerToken', () => {
  it('runs the script as root with the token on stdin only, and returns its output', async () => {
    const exec = vi.fn<ContainerExec>(async () => execResult({ stdout: 'The GitHub token of the environment is in /run/devenv.\n' }));
    const output = await writeContainerToken(exec, { container: 'c1', user: 'dev', token: TOKEN, login: 'scalarion', timeoutMs: 1000 });
    expect(output).toBe('The GitHub token of the environment is in /run/devenv.');
    expect(exec).toHaveBeenCalledTimes(1);
    const [container, command, options] = exec.mock.calls[0];
    expect(container).toBe('c1');
    expect(command).toEqual(tokenWriteCommand('dev', 'scalarion'));
    expect(options).toMatchObject({ user: 'root', input: TOKEN, timeoutMs: 1000 });
    expect(command.some((arg) => arg.includes(TOKEN))).toBe(false);
  });

  it.each(['', '-octo', '_x', 'octo cat', 'octo"', 'a: b'])('passes no invalid GitHub login (%j): gh is signed in nowhere', async (login) => {
    const exec = vi.fn<ContainerExec>(async () => execResult());
    await writeContainerToken(exec, { container: 'c1', user: 'dev', token: TOKEN, login });
    expect(exec.mock.calls[0][1]).toEqual(tokenWriteCommand('dev', ''));
  });

  it('throws the reason without the token when the script fails', async () => {
    const exec = vi.fn<ContainerExec>(async () => execResult({ exitCode: 3, stderr: `/run/devenv is not a tmpfs mount of the container. ${TOKEN}\n` }));
    const error = await writeContainerToken(exec, { container: 'c1', user: 'dev', token: TOKEN, login: 'octo' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('is not a tmpfs mount');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('refuses an empty token before any Docker call', async () => {
    const exec = vi.fn<ContainerExec>(async () => execResult());
    await expect(writeContainerToken(exec, { container: 'c1', user: 'dev', token: '', login: 'octo' })).rejects.toThrow('No valid GitHub token.');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('removeContainerToken', () => {
  it('runs the removal as root', async () => {
    const exec = vi.fn<ContainerExec>(async () => execResult());
    await removeContainerToken(exec, { container: 'c1', user: 'dev', timeoutMs: 30_000 });
    expect(exec.mock.calls).toEqual([['c1', tokenRemoveCommand(), { user: 'root', timeoutMs: 30_000, signal: undefined }]]);
  });

  it('runs it again as the remote user when root may not (for example --cap-drop ALL), and fails when both fail', async () => {
    const exec = vi.fn<ContainerExec>(async (_c, _command, options) => execResult(options.user === 'root' ? { exitCode: 1, stderr: 'github-token could not be removed.' } : {}));
    await removeContainerToken(exec, { container: 'c1', user: 'dev' });
    expect(exec.mock.calls.map((call) => call[2].user)).toEqual(['root', 'dev']);

    const failing = vi.fn<ContainerExec>(async () => execResult({ exitCode: 1, stderr: 'github-token could not be removed.' }));
    await expect(removeContainerToken(failing, { container: 'c1', user: 'dev' })).rejects.toThrow(/As dev: github-token could not be removed/);
    for (const user of [undefined, 'root']) {
      const once = vi.fn<ContainerExec>(async () => execResult({ exitCode: 1, stderr: 'x' }));
      await expect(removeContainerToken(once, { container: 'c1', user })).rejects.toThrow('x');
      expect(once).toHaveBeenCalledTimes(1);
    }
  });
});
