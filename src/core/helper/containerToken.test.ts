// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 15: the token of the owner account only in the memory of the dev container (TOKEN_WRITE_SCRIPT,
// TOKEN_REMOVE_SCRIPT, writeContainerToken). Plan step 11B1 runs TOKEN_REMOVE_SCRIPT as a flow of the worker
// (src/core/worker/tokenRemoveFlow.ts), so the removal through `docker exec` and its tests are gone with it. Plan step 11I
// (PR B): writeContainerToken is gone too; the pipeline runs the script `tokenWrite` of the registry itself
// (EnvironmentService.writeGitToken, tested in environmentService.test.ts), and this file keeps the tests of the scripts.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../ports';
import { GH_CONFIG_FOLDER, GH_HOSTS_FILE, GH_VOLUME_CONFIG_FILE, GITHUB_TOKEN_FILE, TOKEN_FOLDER, TOKEN_TMPFS } from '../names';
import { SECRET_TOKEN } from '../helperChannel/protocol';
import { CONTAINER_SCRIPTS, scriptCommand } from '../worker/containerScripts';
import {
  TOKEN_REMOVE_SCRIPT,
  TOKEN_TMPFS_SUPER_OPTIONS,
  TOKEN_WRITE_SCRIPT,
  tokenLogin,
  tokenRunMessage,
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
    // Plan step 11I (PR B): changed expectation, the command of the script `tokenWrite` of the registry (the builder
    // tokenWriteCommand, which built the same command, is removed); the token is the secret that the entry names.
    expect(scriptCommand('tokenWrite', ['dev', 'octo'])).toEqual(['sh', '-c', TOKEN_WRITE_SCRIPT, 'sh', 'dev', 'octo']);
    expect(CONTAINER_SCRIPTS.tokenWrite.secretInputName).toBe(SECRET_TOKEN);
  });
});

/** The device of the tmpfs in the default mount table of setup: 8:300 (a minor above 255 tests the arithmetic). */
const DEVICE = '8:300';
const DEVICE_NUMBER = String((300 & 0xff) | (8 << 8) | ((300 & ~0xff) << 12));

/**
 * The mount table of a dev container with the tmpfs of the token at `dir` (/proc/self/mountinfo). `tmpfs` replaces the
 * line of the tmpfs; `extra` comes after it.
 */
function mountinfo(dir: string, options: { tmpfs?: string; extra?: string[]; root?: string } = {}): string {
  return [
    options.root ?? '88 58 0:41 / / rw,relatime - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w',
    '90 88 0:49 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
    '91 88 0:50 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755',
    options.tmpfs ?? `106 88 ${DEVICE} / ${dir} rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=1024k,mode=700`,
    ...(options.extra ?? []),
    '',
  ].join('\n');
}

/**
 * /proc/mounts of a mount table (source, mount point, type, options): what the scripts before the review of unit 15
 * read, so that a test of a refusal fails on them for the right reason.
 */
function procMounts(table: string): string {
  return table
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [left, right] = line.split(' - ');
      const fields = left.split(' ');
      const [type, source] = right.split(' ');
      return `${source} ${fields[4]} ${type} ${fields[5]} 0 0\n`;
    })
    .join('');
}

/**
 * The scripts with the folder and /proc/self/mountinfo (and /proc/mounts, procMounts) of a test folder, a `stat` that
 * answers `fsType` (`stat -f -c %T`) and `device` (`stat -c %d`), and tools on PATH that log their arguments (so a test
 * sees whether the token is ever an argument of a program). `id` knows root (0), dev (1000:1001); chown only logs.
 */
function setup(options: { mountinfo?: (dir: string) => string; fsType?: string; device?: string; chownFails?: boolean } = {}) {
  const base = tempDir();
  const dir = path.join(base, 'run-devenv');
  const mountsFile = path.join(base, 'mountinfo');
  const procMountsFile = path.join(base, 'mounts');
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'log');
  fs.mkdirSync(dir);
  const table = options.mountinfo ? options.mountinfo(dir) : mountinfo(dir);
  write(mountsFile, table);
  write(procMountsFile, procMounts(table));
  const tool = (name: string, body: string) => {
    write(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  for (const name of ['cat', 'tr', 'wc', 'chmod', 'mkdir', 'ln', 'rm', 'ls']) tool(name, `PATH=/usr/bin:/bin exec ${name} "$@"`);
  // find with the PATH of the test, so that the programs of its -exec log too.
  tool('find', 'exec "$(PATH=/usr/bin:/bin command -v find)" "$@"');
  tool(
    'id',
    [
      'case "$1:$2" in',
      '  -u:root) echo 0 ;; -g:root) echo 0 ;;',
      '  -u:dev) echo 1000 ;; -g:dev) echo 1001 ;;',
      '  -u:) echo 0 ;;',
      '  *) echo "id: $2: no such user" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  tool('stat', `case "$1" in -f) echo '${options.fsType ?? 'tmpfs'}' ;; *) echo '${options.device ?? DEVICE_NUMBER}' ;; esac`);
  tool('chown', options.chownFails ? 'case "$*" in *0:0*) exit 0 ;; esac\necho "chown: Operation not permitted" >&2\nexit 1' : 'exit 0');
  const adapt = (script: string) =>
    script.split(TOKEN_FOLDER).join(dir).split('/proc/self/mountinfo').join(mountsFile).split('/proc/mounts').join(procMountsFile);
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
    bin,
    tool,
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
    // The folder is root's while it is written, and the remote user's at the end: its files first, then gh/, the folder
    // last (review, T1/T2/P1: paths relative to the folder, and gh/ after its files, so root needs no DAC_OVERRIDE).
    const chowns = env.logText().split('\n').filter((line) => line.startsWith('chown '));
    expect(chowns).toEqual([
      'chown 0:0 .',
      'chown -h 1000:1001 github-token gh/config.yml',
      'chown 1000:1001 gh/hosts.yml',
      'chown 1000:1001 gh',
      'chown 1000:1001 .',
    ]);
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

  // review, T1/T2/P1: the mount table is /proc/self/mountinfo, and `stat -f` tells what the folder is on.
  it.each([
    ['no mount at the folder', (dir: string) => mountinfo(dir, { tmpfs: '' }), 'overlay'],
    ['a mount of another folder', (dir: string) => mountinfo(dir, { tmpfs: '106 88 0:55 / /elsewhere rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1024k,mode=700' }), 'overlay'],
    ['a volume at the folder', (dir: string) => mountinfo(dir, { tmpfs: `106 88 254:1 /volumes/x/_data ${dir} rw,relatime - ext4 /dev/sda1 rw` }), 'ext4'],
    ['a volume over the tmpfs', (dir: string) => mountinfo(dir, { extra: [`107 106 254:1 /volumes/x/_data ${dir} rw,relatime - ext4 /dev/sda1 rw`] }), 'ext4'],
  ])('writes nothing and removes nothing without the tmpfs at the folder (%s)', (_name, table, fsType) => {
    const env = setup({ mountinfo: table, fsType });
    write(path.join(env.dir, 'kept'), 'x');
    const result = env.write();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('is not a tmpfs mount of the container');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(fs.readdirSync(env.dir)).toEqual(['kept']);
    expect(env.logText()).not.toContain('chown');
  });

  it('accepts the tmpfs when a mount of a parent folder lies below it (for example --tmpfs /run)', () => {
    // review, T1/T2/P1: as /proc/self/mountinfo.
    const env = setup({
      mountinfo: (dir) =>
        mountinfo(dir, {
          tmpfs: [
            `100 88 0:60 / ${path.dirname(dir)} rw,nosuid,nodev,relatime - tmpfs tmpfs rw,mode=755`,
            `106 100 ${DEVICE} / ${dir} rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=1024k,mode=700`,
          ].join('\n'),
        }),
    });
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
    // review, T1/T2/P1: the folder by its relative path.
    expect(env.logText().split('\n').filter((line) => line.startsWith('chown '))).toEqual(['chown 0:0 .']);
  });

  it('takes a numeric user as it is, and refuses an unknown name or an invalid user without writing', () => {
    const numeric = setup();
    expect(numeric.write('1234').status).toBe(0);
    // review, T1/T2/P1: the folder by its relative path.
    expect(numeric.logText()).toContain('chown 1234:1234 .');

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

  // Greenfield (user decision 2026-09-27): changed expectation, a folder that is no tmpfs is not ours, like any other
  // mount there (exit code 3), no longer a container of an earlier version (exit code 0).
  it('removes nothing where the folder is no tmpfs (exit code 3)', () => {
    // review, T1/T2/P1: as /proc/self/mountinfo, and `stat -f` of the folder.
    const env = setup({ mountinfo: (dir) => mountinfo(dir, { tmpfs: '' }), fsType: 'overlay' });
    write(path.join(env.dir, 'kept'), 'x');
    const result = env.remove();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('is not the tmpfs of the container');
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

describe('review of unit 15 (T1, T2): only into the tmpfs that the override configuration gives the container', () => {
  it('knows the super options that the kernel shows for TOKEN_TMPFS', () => {
    // size=1m is shown as 1024k, mode=0700 as 700.
    expect(TOKEN_TMPFS).toContain(',size=1m,mode=0700');
    expect(TOKEN_TMPFS_SUPER_OPTIONS).toBe('rw,size=1024k,mode=700');
  });

  const tmpfsLine = (dir: string, fields: { id?: string; parent?: string; device?: string; root?: string; point?: string; options?: string; optional?: string; superOptions?: string } = {}) =>
    [
      fields.id ?? '106',
      fields.parent ?? '88',
      fields.device ?? DEVICE,
      fields.root ?? '/',
      fields.point ?? dir,
      fields.options ?? 'rw,nosuid,nodev,noexec,relatime',
      ...(fields.optional ? [fields.optional] : []),
      '-',
      'tmpfs',
      'tmpfs',
      fields.superOptions ?? 'rw,size=1024k,mode=700',
    ].join(' ');

  it.each([
    ['SELinux: seclabel', 'rw,seclabel,size=1024k,mode=700'],
    ['SELinux: the context of Docker', 'rw,context="system_u:object_r:container_file_t:s0:c1,c2",size=1024k,mode=700'],
    ['CONFIG_TMPFS_INODE64 (Ubuntu): inode64', 'rw,size=1024k,mode=700,inode64'],
    ['inode32', 'rw,size=1024k,mode=700,inode32'],
    ['SELinux and inode64', 'rw,seclabel,size=1024k,mode=700,inode64'],
    ['the context of Docker and inode64', 'rw,context="system_u:object_r:container_file_t:s0:c1,c2",size=1024k,mode=700,inode64'],
    ['the owner root, no swap, no huge pages', 'rw,size=1024k,mode=700,uid=0,gid=0,inode64,huge=never,noswap'],
    ['another order', 'rw,mode=700,inode64,size=1024k'],
  ])('accepts our tmpfs with the options of the kernel (%s)', (_name, superOptions) => {
    const env = setup({ mountinfo: (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions }) }) });
    expect(env.write().status).toBe(0);
    expect(fs.readFileSync(path.join(env.dir, 'github-token'), 'utf8')).toBe(TOKEN);
  });

  const refusals: Array<[string, (dir: string) => string, { fsType?: string; device?: string; message: string }]> = [
    [
      'T1: a volume on /run through a link of the image (/var/run → /run) hides the tmpfs',
      (dir) => mountinfo(dir, { extra: [`107 88 254:1 /volumes/v/_data ${path.dirname(dir)} rw,relatime - ext4 /dev/sda1 rw`] }),
      { fsType: 'ext4', device: String((254 << 8) | 1), message: 'is not a tmpfs mount of the container' },
    ],
    [
      'T1: a tmpfs volume on /run hides the tmpfs',
      (dir) => mountinfo(dir, { extra: [`107 88 0:70 / ${path.dirname(dir)} rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=1024k,mode=700`] }),
      { device: '70', message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs of the computer stacked on ours (/var/run/devenv)',
      (dir) => mountinfo(dir, { extra: [tmpfsLine(dir, { id: '107', parent: '106', device: '0:70' })] }),
      { device: '70', message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a folder of a tmpfs of the computer (its root is not /)',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { root: '/devenv-host' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs of another size',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=2048k,mode=700' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs with other options of the kernel (nr_inodes)',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=1024k,nr_inodes=5,mode=700' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs of another size, with inode64',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=2048k,mode=700,inode64' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs with nr_inodes and inode64',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=1024k,nr_inodes=5,mode=700,inode64' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs with the size twice',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=1024k,size=1024k,mode=700' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs without its mode',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=1024k,inode64' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs of another owner',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=1024k,mode=700,uid=1000,inode64' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs read-only',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'ro,size=1024k,mode=700' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs with huge pages',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=1024k,mode=700,huge=always' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: an SELinux context without its end quote',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { superOptions: 'rw,size=1024k,mode=700,context="a,b' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a tmpfs without noexec',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { options: 'rw,nosuid,nodev,relatime' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: a file of the computer at the place of the token file',
      (dir) => mountinfo(dir, { extra: [`107 106 254:1 /home/u/file ${dir}/github-token rw,relatime - ext4 /dev/sda1 rw`] }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'T2: our tmpfs with an optional field (a slave of a mount of the computer)',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { optional: 'master:3' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'the mount propagation: our tmpfs is shared',
      (dir) => mountinfo(dir, { tmpfs: tmpfsLine(dir, { optional: 'shared:5' }) }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'the mount propagation: /run is shared with the computer (-v <folder>:/run:rshared)',
      (dir) =>
        mountinfo(dir, {
          tmpfs: [`100 88 254:1 /host/run ${path.dirname(dir)} rw,relatime shared:2 - ext4 /dev/sda1 rw`, tmpfsLine(dir, { parent: '100' })].join('\n'),
        }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'the mount propagation: the root of the container is shared',
      (dir) => mountinfo(dir, { root: '88 58 0:41 / / rw,relatime shared:1 - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w' }),
      { message: 'is not the tmpfs of the container' },
    ],
    [
      'our tmpfs twice in the mount table',
      (dir) => mountinfo(dir, { extra: [tmpfsLine(dir, { id: '120', point: '/mnt/copy' })] }),
      { message: 'is not the tmpfs of the container' },
    ],
  ];

  it.each(refusals)('writes nothing (%s)', (_name, table, expected) => {
    const env = setup({ mountinfo: table, fsType: expected.fsType, device: expected.device });
    write(path.join(env.dir, 'kept'), 'x');
    const result = env.write();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(expected.message);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(fs.readdirSync(env.dir)).toEqual(['kept']);
    expect(env.logText()).not.toContain('chown');
    expect(env.logText()).not.toContain('cat');
  });

  it.each(refusals.filter(([, , expected]) => expected.fsType === undefined))('removes nothing from another tmpfs, exit code 3 (%s)', (_name, table, expected) => {
    const env = setup({ mountinfo: table, device: expected.device });
    write(path.join(env.dir, 'kept'), 'x');
    const result = env.remove();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('is not the tmpfs of the container');
    expect(fs.readdirSync(env.dir)).toEqual(['kept']);
  });
});

describe('the diagnostic of a refused tmpfs (stderr, for the log)', () => {
  const tmpfs = (dir: string, superOptions: string, options = 'rw,nosuid,nodev,noexec,relatime') =>
    `106 88 ${DEVICE} / ${dir} ${options} - tmpfs tmpfs ${superOptions}`;

  it.each([
    ['another size', (dir: string) => mountinfo(dir, { tmpfs: tmpfs(dir, 'rw,size=2048k,mode=700,inode64') }), 'the super option size=2048k is not one of ours or of the kernel'],
    ['nr_inodes', (dir: string) => mountinfo(dir, { tmpfs: tmpfs(dir, 'rw,size=1024k,nr_inodes=5,mode=700') }), 'the super option nr_inodes=5 is not one of ours or of the kernel'],
    ['the size twice', (dir: string) => mountinfo(dir, { tmpfs: tmpfs(dir, 'rw,size=1024k,size=1024k,mode=700') }), 'the super options do not have rw, size=1024k, and mode=700 once each'],
    ['no noexec', (dir: string) => mountinfo(dir, { tmpfs: tmpfs(dir, 'rw,size=1024k,mode=700', 'rw,nosuid,nodev,relatime') }), 'its mount has no noexec'],
    ['an optional field', (dir: string) => mountinfo(dir, { tmpfs: `106 88 ${DEVICE} / ${dir} rw,nosuid,nodev,noexec,relatime master:3 - tmpfs tmpfs rw,size=1024k,mode=700` }), 'its mount has optional fields'],
    ['a mount below it', (dir: string) => mountinfo(dir, { extra: [`107 106 254:1 /home/u/file ${dir}/github-token rw,relatime - ext4 /dev/sda1 rw`] }), 'a mount lies below it'],
    ['a shared parent', (dir: string) => mountinfo(dir, { root: '88 58 0:41 / / rw,relatime shared:1 - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w' }), 'the parent mount 88 at / is shared'],
    ['its device twice', (dir: string) => mountinfo(dir, { extra: [`120 88 ${DEVICE} / /mnt/copy rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=1024k,mode=700`] }), `its device ${DEVICE} is mounted at /mnt/copy`],
  ])('names the rule that failed and shows the lines of the folder (%s)', (_name, table, rule) => {
    const env = setup({ mountinfo: table });
    const written = env.write();
    expect(written.status).toBe(3);
    expect(written.stderr).toContain(`Check of ${env.dir}: ${rule}`);
    expect(written.stderr).toMatch(new RegExp(`^mountinfo: 106 88 ${DEVICE} / ${env.dir} `, 'm'));
    expect(written.stderr).toContain('is not the tmpfs of the container: another mount lies over it or in it');
    expect(written.stdout + written.stderr).not.toContain(TOKEN);
    const removed = env.remove();
    expect(removed.status).toBe(3);
    expect(removed.stderr).toContain(`Check of ${env.dir}: ${rule}`);
    // Only builtins of the shell read the table: no program runs but stat.
    expect(env.logText().split('\n').filter((line) => line !== '' && !line.startsWith('stat '))).toEqual([]);
  });

  it('names the type when the folder is no tmpfs', () => {
    const env = setup({ fsType: 'ext4' });
    const result = env.write();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`Check of ${env.dir}: stat -f shows the type 'ext4', not tmpfs.`);
    expect(result.stderr).toContain('is not a tmpfs mount of the container');
  });

  it('says nothing when the folder is our tmpfs (also with inode64)', () => {
    const env = setup({ mountinfo: (dir) => mountinfo(dir, { tmpfs: tmpfs(dir, 'rw,size=1024k,mode=700,inode64') }) });
    expect(env.write()).toMatchObject({ status: 0, stderr: '' });
    expect(env.remove()).toMatchObject({ status: 0, stderr: '' });
  });
});

describe('review of unit 15 (P1): without CAP_DAC_OVERRIDE of root', () => {
  /** A folder of the remote user as it can leave it after a write: nested folders of mode 000, a link out of the folder. */
  function userLeftovers(dir: string): string {
    const elsewhere = path.join(tempDir(), 'elsewhere');
    write(path.join(elsewhere, 'file'), 'x');
    fs.chmodSync(elsewhere, 0o750);
    write(path.join(dir, 'gh', 'hosts.yml'), TOKEN);
    write(path.join(dir, 'x', 'y', 'file'), 'x');
    fs.symlinkSync(elsewhere, path.join(dir, 'l'));
    fs.chmodSync(path.join(dir, 'x', 'y'), 0o000);
    fs.chmodSync(path.join(dir, 'x'), 0o000);
    fs.chmodSync(path.join(dir, 'gh'), 0o000);
    return elsewhere;
  }

  function takeBack(logText: string): string[] {
    return logText.split('\n').filter((line) => /^(chown -h 0:0|chmod 0700) \.\//.test(line));
  }

  it('the write gives everything in the folder back to root, top down, each folder 0700 before it is read, never through a link', () => {
    const env = setup();
    const elsewhere = userLeftovers(env.dir);
    const result = env.write();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(env.logText()).toContain('find . -mindepth 1 -exec chown -h 0:0 {} ; -type d -exec chmod 0700 {} ;');
    const steps = takeBack(env.logText());
    for (const entry of ['./gh', './x', './x/y']) {
      expect(steps).toContain(`chown -h 0:0 ${entry}`);
      expect(steps).toContain(`chmod 0700 ${entry}`);
    }
    expect(steps.indexOf('chmod 0700 ./x')).toBeLessThan(steps.indexOf('chown -h 0:0 ./x/y'));
    expect(steps).toContain('chown -h 0:0 ./l');
    expect(steps).not.toContain('chmod 0700 ./l');
    expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o750);
    expect(fs.readFileSync(path.join(elsewhere, 'file'), 'utf8')).toBe('x');
    expect(fs.readdirSync(env.dir).sort()).toEqual(['gh', 'github-token']);
  });

  it('the write stops with exit code 5 and writes no token when root cannot empty the folder', () => {
    const env = setup();
    userLeftovers(env.dir);
    // An rm that removes nothing (root without the rights in the folders of the user).
    env.tool('rm', 'exit 1');
    const result = env.write();
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('Root in the container cannot empty');
    expect(fs.existsSync(path.join(env.dir, 'github-token'))).toBe(false);
    expect(fs.readFileSync(path.join(env.dir, 'gh', 'hosts.yml'), 'utf8')).toBe(TOKEN);
  });

  it('the removal as root gives everything back to root first, and empties the folder', () => {
    const env = setup();
    const elsewhere = userLeftovers(env.dir);
    const result = env.remove();
    expect(result).toMatchObject({ status: 0, stderr: '' });
    const steps = takeBack(env.logText());
    expect(steps).toContain('chmod 0700 ./x/y');
    expect(steps).not.toContain('chmod 0700 ./l');
    expect(fs.readdirSync(env.dir)).toEqual([]);
    expect(fs.readFileSync(path.join(elsewhere, 'file'), 'utf8')).toBe('x');
  });

  it('the removal as the remote user gives only its folders mode 0700 (no chown)', () => {
    const env = setup();
    userLeftovers(env.dir);
    env.tool('id', 'echo 1000');
    const result = env.remove();
    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(env.logText()).not.toContain('chown');
    expect(env.logText()).toContain('chmod 0700 ./x/y');
    expect(fs.readdirSync(env.dir)).toEqual([]);
  });

  it('the removal fails when the folder cannot be listed afterwards (so the removal as the remote user runs)', () => {
    const env = setup();
    expect(env.write().status).toBe(0);
    env.tool('ls', 'echo "ls: cannot open directory .: Permission denied" >&2\nexit 2');
    const result = env.remove();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot be read');
    expect(result.stdout).not.toContain('The GitHub token was removed');
  });

  it('the removal fails when something is left in the folder', () => {
    const env = setup();
    userLeftovers(env.dir);
    env.tool('rm', 'exit 1');
    const result = env.remove();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gh/hosts.yml could not be removed');
    expect(result.stderr).toContain('could not be emptied');
  });
});

function execResult(partial: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...partial };
}

// Plan step 11I (PR B): the tests of writeContainerToken (removed: the pipeline runs the script `tokenWrite` of the registry
// itself) moved to environmentService.test.ts (the call, the masked output and failure, the refused token); what it gave
// the script of the login and how it masked a text stay here, as the pipeline uses them.
describe('the login and the masked text of the token write', () => {
  it.each(['', '-octo', '_x', 'octo cat', 'octo"', 'a: b'])('passes no invalid GitHub login (%j): gh is signed in nowhere', (login) => {
    // Plan step 11I (PR B): changed expectation (before: through writeContainerToken), the login that the pipeline gives
    // the script `tokenWrite` (tokenLogin), and its command.
    expect(tokenLogin(login)).toBe('');
    expect(scriptCommand('tokenWrite', ['dev', tokenLogin(login)])).toEqual(['sh', '-c', TOKEN_WRITE_SCRIPT, 'sh', 'dev', '']);
  });

  it('keeps a GitHub login, and masks the token in the text of a run', () => {
    expect(tokenLogin('scalarion')).toBe('scalarion');
    expect(tokenRunMessage(execResult({ exitCode: 3, stderr: `/run/devenv is not a tmpfs mount of the container. ${TOKEN}\n` }), TOKEN)).toBe(
      '/run/devenv is not a tmpfs mount of the container. ***',
    );
    expect(tokenRunMessage(execResult({ exitCode: 5 }), TOKEN)).toBe('exit code 5');
  });
});
