// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR G (reviewer B): probes for the mutants of GIT_FILES_SCRIPT and CREATE_FOLDERS_SCRIPT (follow-up of
// plan step 11I, the links of the owner) that the suites of scripts.test.ts let survive. Each test names the mutants that it
// kills (the mutant table of the review); each passes on the scripts as they are.
// Adopted into the suite with the fixes of review round 1 of PR G (B-TG1), adapted to them: no `separator` (B-L1), Git's
// lock for gitconfig (A-F4, the test of G40), and the check of `enter` by lstat (A-F3, the test of C04).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { GIT_FILES_SCRIPT, createFoldersCommand, gitFilesCommand } from './scripts';

const folders: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-11igr1-')));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

/**
 * What the owner of the repository does once while GIT_FILES_SCRIPT runs (the preload below plays it): right after (for
 * `beforeRename`: right before) the script's call `when` on an entry named `name`, the owner moves the entry `entry` (a
 * real path) away to `<entry>.moved` and puts in its place a link to `target`, a file with `content`, or a folder that is
 * not empty; or (`kill`) the step is killed.
 */
interface Hook {
  when: 'open' | 'lstat' | 'unlink' | 'mkdir' | 'beforeRename' | 'afterRename';
  name: string;
  /** For `open`: the open of a folder (O_DIRECTORY), else of a file that the script does not create. */
  folder?: boolean;
  action: 'link' | 'file' | 'folder' | 'kill';
  entry?: string;
  target?: string;
  content?: string;
}

// Loaded by Node before the script (`--require`): owner changes are recorded by the inode they reach instead of made (the
// test runs as a user), the repository entry belongs to PROBE_OWNER (its lstat, as the owner of a link would be), and the
// hook acts once.
const PRELOAD = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { O_CREAT, O_DIRECTORY } = fs.constants;
const { PROBE_LOG: log, PROBE_REPO: repo, PROBE_OWNER: owner, PROBE_HOOK: hookText } = process.env;
const real = { lstatSync: fs.lstatSync, openSync: fs.openSync, unlinkSync: fs.unlinkSync, mkdirSync: fs.mkdirSync, renameSync: fs.renameSync };
const record = (stat, uid, gid) => fs.appendFileSync(log, stat.ino + ' ' + uid + ':' + gid + '\n');
fs.fchownSync = (fd, uid, gid) => record(fs.fstatSync(fd), uid, gid);
fs.lchownSync = (file, uid, gid) => record(real.lstatSync.call(fs, file), uid, gid);
fs.chownSync = (file, uid, gid) => record(fs.statSync(file), uid, gid);
const [uid, gid] = owner.split(':').map(Number);
const hook = hookText ? JSON.parse(hookText) : undefined;
let fired = false;
const act = () => {
  fired = true;
  if (hook.action === 'kill') process.kill(process.pid, 'SIGKILL');
  try {
    real.renameSync.call(fs, hook.entry, hook.entry + '.moved');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (hook.action === 'link') fs.symlinkSync(hook.target, hook.entry);
  if (hook.action === 'file') fs.writeFileSync(hook.entry, hook.content);
  if (hook.action === 'folder') {
    real.mkdirSync.call(fs, hook.entry);
    fs.writeFileSync(path.join(hook.entry, 'x'), 'x');
  }
};
const due = (when, file) => hook !== undefined && !fired && hook.when === when && path.basename(String(file)) === hook.name;
fs.lstatSync = (file, ...rest) => {
  try {
    const stat = real.lstatSync.call(fs, file, ...rest);
    return file === repo && stat ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid, gid }) : stat;
  } finally {
    if (due('lstat', file)) act();
  }
};
fs.openSync = (file, flags, ...rest) => {
  const descriptor = real.openSync.call(fs, file, flags, ...rest);
  const folder = typeof flags === 'number' && (flags & O_DIRECTORY) !== 0;
  const created = typeof flags !== 'number' || (flags & O_CREAT) !== 0;
  if (due('open', file) && !created && folder === Boolean(hook.folder)) act();
  return descriptor;
};
fs.unlinkSync = (file, ...rest) => {
  const result = real.unlinkSync.call(fs, file, ...rest);
  if (due('unlink', file)) act();
  return result;
};
fs.mkdirSync = (file, ...rest) => {
  const result = real.mkdirSync.call(fs, file, ...rest);
  if (due('mkdir', file)) act();
  return result;
};
fs.renameSync = (from, to, ...rest) => {
  if (due('beforeRename', to)) act();
  const result = real.renameSync.call(fs, from, to, ...rest);
  if (due('afterRename', to)) act();
  return result;
};
`;

// A `git` on PATH that records the file it edits (the copy in the work folder of the script) and runs the real Git.
const FAKE_GIT = String.raw`#!/bin/sh
file=''
previous=''
for arg do
  if [ "$previous" = --file ]; then file=$arg; fi
  previous=$arg
done
printf '%s\n' "$file" >> "$PROBE_GIT_FILES"
exec "$PROBE_REAL_GIT" "$@"
`;

const OWNER = '4321:4322';
const KEY = 'credential.https://github.com.helper';
/** A gitconfig whose credential section is as the script wants it (nothing to repair). */
const CORRECT = `[credential "https://github.com"]\n\thelper = \n\thelper = ${JSON.stringify(CONTAINER_CREDENTIAL_HELPER)}\n`;

interface GitFilesEnv {
  dir: string;
  ws: string;
  bin: string;
  log: string;
  gitFiles: string;
  preload: string;
}

describe.skipIf(!hasGit || process.platform !== 'linux')('GIT_FILES_SCRIPT, review round 1 of PR G (reviewer B)', () => {
  const realGit = hasGit ? spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() : '';
  const used: GitFilesEnv[] = [];

  afterEach(() => {
    // The work folders of the script are in the real /tmp; a run that was killed leaves its own.
    for (const env of used.splice(0)) {
      if (!fs.existsSync(env.gitFiles)) continue;
      for (const file of fs.readFileSync(env.gitFiles, 'utf8').split('\n').filter((line) => line !== '')) {
        const work = path.dirname(file);
        if (work.startsWith('/tmp/devenv-git-files-')) fs.rmSync(work, { recursive: true, force: true });
      }
    }
  });

  function setup(): GitFilesEnv {
    const dir = tempDir();
    const ws = path.join(dir, 'workspaces');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(ws, 'api'), { recursive: true });
    fs.mkdirSync(bin);
    const env = { dir, ws, bin, log: path.join(dir, 'owners'), gitFiles: path.join(dir, 'git-files'), preload: path.join(dir, 'preload.js') };
    fs.writeFileSync(env.log, '');
    fs.writeFileSync(env.gitFiles, '');
    fs.writeFileSync(env.preload, PRELOAD);
    fs.writeFileSync(path.join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
    used.push(env);
    return env;
  }

  /** Runs the script as gitFilesCommand builds it, with /workspaces in the test folder. */
  function run(env: GitFilesEnv, options: { folder?: string; hook?: Hook } = {}) {
    const folder = options.folder ?? 'api';
    const command = gitFilesCommand(folder, { name: 'Probe', email: 'probe@example.com' }, CONTAINER_CREDENTIAL_HELPER);
    expect(command.slice(0, 3)).toEqual(['node', '-e', GIT_FILES_SCRIPT]);
    const script = GIT_FILES_SCRIPT.split('/workspaces').join(env.ws);
    return spawnSync(process.execPath, ['--require', env.preload, '-e', script, ...command.slice(3)], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${env.bin}${path.delimiter}${process.env.PATH ?? ''}`,
        GIT_CONFIG_NOSYSTEM: '1',
        PROBE_LOG: env.log,
        PROBE_REPO: path.join(env.ws, folder),
        PROBE_OWNER: OWNER,
        PROBE_GIT_FILES: env.gitFiles,
        PROBE_REAL_GIT: realGit,
        ...(options.hook !== undefined ? { PROBE_HOOK: JSON.stringify(options.hook) } : {}),
      },
    });
  }

  function gitConfig(file: string, ...args: string[]): string {
    return spawnSync('git', ['config', '--file', file, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  }

  /** The owners that the script gave, by inode. */
  function owners(env: GitFilesEnv): Map<number, string[]> {
    const result = new Map<number, string[]>();
    for (const line of fs.readFileSync(env.log, 'utf8').split('\n').filter((entry) => entry !== '')) {
      const [inode, owner] = line.split(' ');
      result.set(Number(inode), [...(result.get(Number(inode)) ?? []), owner]);
    }
    return result;
  }

  const ino = (file: string): number => fs.lstatSync(file).ino;

  /** A folder outside the volume (the socket folder, the cache volume, the helper's files), named like CONFIG_FOLDER's entries. */
  function outside(env: GitFilesEnv): { folder: string; state: () => string[]; inodes: () => number[] } {
    const folder = path.join(env.dir, 'outside');
    fs.mkdirSync(path.join(folder, 'docker'), { recursive: true });
    for (const name of ['gitconfig', 'credentials.gitconfig']) {
      fs.writeFileSync(path.join(folder, name), `[outside]\n\tname = ${name}\n`);
      fs.chmodSync(path.join(folder, name), 0o640);
    }
    fs.chmodSync(path.join(folder, 'docker'), 0o751);
    fs.chmodSync(folder, 0o751);
    const entries = (): Array<[string, fs.Stats]> => [['.', fs.lstatSync(folder)], ...fs.readdirSync(folder).sort().map((name): [string, fs.Stats] => [name, fs.lstatSync(path.join(folder, name))])];
    return {
      folder,
      state: () => entries().map(([name, stat]) => `${name} ${(stat.mode & 0o7777).toString(8)} ${stat.ino} ${stat.isFile() ? JSON.stringify(fs.readFileSync(path.join(folder, name), 'utf8')) : stat.isDirectory() ? 'folder' : 'other'}`),
      inodes: () => entries().map(([, stat]) => stat.ino),
    };
  }

  /** CONFIG_FOLDER `dir` as the script leaves it: the four entries, their modes, the owner of each. */
  function expectConfigFolder(env: GitFilesEnv, dir: string): void {
    expect(fs.readdirSync(dir).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    expect(fs.lstatSync(dir).mode & 0o777).toBe(0o755);
    for (const name of ['docker', 'gh']) {
      expect(fs.lstatSync(path.join(dir, name)).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(dir, name)).mode & 0o777, name).toBe(0o700);
    }
    for (const name of ['gitconfig', 'credentials.gitconfig']) expect(fs.lstatSync(path.join(dir, name)).isFile()).toBe(true);
    expect(gitConfig(path.join(dir, 'gitconfig'), '--get-all', KEY)).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    const given = owners(env);
    for (const name of ['.', 'docker', 'gh', 'gitconfig', 'credentials.gitconfig']) expect(given.get(ino(path.join(dir, name))), name).toEqual([OWNER]);
  }

  it('gives folders that exist their modes again (kills G10: openFolder without fchmod)', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(path.join(dir, 'docker'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'gh'));
    // What a killed step leaves (0700), and folders that the owner opened.
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(path.join(dir, 'docker'), 0o755);
    fs.chmodSync(path.join(dir, 'gh'), 0o777);
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expectConfigFolder(env, dir);
  });

  it('changes, reads and removes only through the folder that it opened, also when a link takes the place of .devenv+ right after its open (kills G11, G11m, G11o, G42, G52b, G52c, G52d, G52f, G52g, G52h)', () => {
    const env = setup();
    const out = outside(env);
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    // Links of the owner in the folder, each to an entry of the same name outside: the script removes them.
    for (const name of ['docker', 'gitconfig', 'credentials.gitconfig']) fs.symlinkSync(path.join(out.folder, name), path.join(dir, name));
    const before = out.state();
    const result = run(env, { hook: { when: 'open', name: '.devenv+', folder: true, action: 'link', entry: dir, target: out.folder } });
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // Everything went into the folder that the script opened, which the owner moved; nothing was read from outside.
    expectConfigFolder(env, `${dir}.moved`);
    expect(fs.readFileSync(path.join(`${dir}.moved`, 'gitconfig'), 'utf8')).not.toContain('[outside]');
  });

  it('decides about the owner of gitconfig by the file that it opened, not by the entry that takes its place after the open (kills G18: fstat replaced by an lstat of the entry)', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    // gitconfig is a hard link of another file (a second link): it gets no owner, it is written again as a new file.
    const shared = path.join(env.ws, 'api', 'config');
    fs.writeFileSync(shared, CORRECT);
    fs.linkSync(shared, path.join(dir, 'gitconfig'));
    // Right after the open, the owner puts a file with one link in its place.
    const result = run(env, { hook: { when: 'open', name: 'gitconfig', action: 'file', entry: path.join(dir, 'gitconfig'), content: CORRECT } });
    expect(fs.lstatSync(path.join(dir, 'gitconfig.moved')).ino).toBe(ino(shared));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(owners(env).has(ino(shared))).toBe(false);
    expect(fs.readFileSync(shared, 'utf8')).toBe(CORRECT);
    expect(owners(env).get(ino(path.join(dir, 'gitconfig')))).toEqual([OWNER]);
  });

  it('reads no file through a link that the owner puts at gitconfig again right after the script removed one (kills G14 for gitconfig, G19)', () => {
    const env = setup();
    const out = outside(env);
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(out.folder, 'gitconfig'), path.join(dir, 'gitconfig'));
    const before = out.state();
    const result = run(env, { hook: { when: 'unlink', name: 'gitconfig', action: 'link', entry: path.join(dir, 'gitconfig'), target: path.join(out.folder, 'gitconfig') } });
    // The script finds a link where it removed one: the step fails (a warning of the open), nothing is followed.
    expect(result.status).toBe(1);
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isFile()) expect(fs.readFileSync(file, 'utf8'), name).not.toContain('[outside]');
    }
  });

  it('gives no owner to a file outside through a link that the owner puts at credentials.gitconfig right after the script looked at it (kills G14 for credentials.gitconfig)', () => {
    const env = setup();
    const out = outside(env);
    const dir = path.join(env.ws, '.devenv+');
    const before = out.state();
    const result = run(env, { hook: { when: 'lstat', name: 'credentials.gitconfig', action: 'link', entry: path.join(dir, 'credentials.gitconfig'), target: path.join(out.folder, 'credentials.gitconfig') } });
    expect(fs.lstatSync(path.join(dir, 'credentials.gitconfig')).isSymbolicLink()).toBe(true);
    expect(result.status).toBe(1);
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
  });

  it('keeps the mode of an existing gitconfig that it repairs (kills G31)', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    const cfg = path.join(dir, 'gitconfig');
    fs.writeFileSync(cfg, '[credential "https://github.com"]\n\thelper = store\n[alias]\n\tst = status\n');
    fs.chmodSync(cfg, 0o600);
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(gitConfig(cfg, '--get-all', KEY)).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(fs.lstatSync(cfg).mode & 0o777).toBe(0o600);
  });

  it('gives the owner to an existing credentials.gitconfig and to an unchanged gitconfig, and keeps both files (kills G44, G45)', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    const credentials = path.join(dir, 'credentials.gitconfig');
    const cfg = path.join(dir, 'gitconfig');
    fs.writeFileSync(credentials, '[credential "https://gitlab.example.com"]\n\thelper = store\n');
    fs.writeFileSync(cfg, CORRECT);
    const inodes = [ino(credentials), ino(cfg)];
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect([ino(credentials), ino(cfg)]).toEqual(inodes);
    expect(fs.readFileSync(credentials, 'utf8')).toBe('[credential "https://gitlab.example.com"]\n\thelper = store\n');
    expect(fs.readFileSync(cfg, 'utf8')).toBe(CORRECT);
    expect(owners(env).get(ino(credentials))).toEqual([OWNER]);
    expect(owners(env).get(ino(cfg))).toEqual([OWNER]);
  });

  it.each([
    ['', 'G46a'],
    ['.', 'G46b'],
    ['..', 'G46c'],
  ])('refuses the folder name %j with exit code 2 and writes nothing (kills %s)', (folder) => {
    const env = setup();
    const result = run(env, { folder });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid folder name');
    expect(fs.existsSync(path.join(env.ws, '.devenv+'))).toBe(false);
  });

  it('refuses a folder name that starts with a dash with exit code 2 when the script gets it (kills G46d)', () => {
    // Adopted (B-L1): gitFilesCommand puts `--` before the arguments now, so the script gets such a name (Node took it for
    // one of its options before, the finding of the review; this test added the `--` itself then).
    const env = setup();
    fs.mkdirSync(path.join(env.ws, '-x'));
    const result = run(env, { folder: '-x' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid folder name');
    expect(fs.existsSync(path.join(env.ws, '.devenv+'))).toBe(false);
  });

  it('takes the repository folder through a link, with the owner of the entry itself, as the shell script did (kills G48, G49)', () => {
    const env = setup();
    fs.renameSync(path.join(env.ws, 'api'), path.join(env.ws, 'api-real'));
    fs.symlinkSync('api-real', path.join(env.ws, 'api'));
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expectConfigFolder(env, path.join(env.ws, '.devenv+'));
  });

  it('names the path, not the descriptor, when it finds a link where it made a folder (kills G50)', () => {
    const env = setup();
    const out = outside(env);
    const dir = path.join(env.ws, '.devenv+');
    const result = run(env, { hook: { when: 'mkdir', name: 'docker', action: 'link', entry: path.join(dir, 'docker'), target: out.folder } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${dir}/docker`);
    expect(result.stderr).not.toContain('/proc/self/fd');
  });

  it('removes its new file when the rename into place fails (kills G36)', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    // Right before the rename, the owner puts a folder (not empty) at gitconfig: the rename fails.
    const result = run(env, { hook: { when: 'beforeRename', name: 'gitconfig', action: 'folder', entry: path.join(dir, 'gitconfig') } });
    expect(result.status).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['docker', 'gh', 'gitconfig']);
  });

  it('sets the owner and the mode of a new file before its rename, never through the entry afterwards (kills G39)', () => {
    const env = setup();
    const out = outside(env);
    const dir = path.join(env.ws, '.devenv+');
    const before = out.state();
    // Right after the rename, the owner puts a link to a file outside in place of gitconfig.
    const result = run(env, { hook: { when: 'afterRename', name: 'gitconfig', action: 'link', entry: path.join(dir, 'gitconfig'), target: path.join(out.folder, 'gitconfig') } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    expect(owners(env).get(ino(path.join(dir, 'gitconfig.moved')))).toEqual([OWNER]);
    expect(fs.lstatSync(path.join(dir, 'gitconfig.moved')).mode & 0o777).toBe(0o644);
  });

  // Adopted (A-F4): the new gitconfig is Git's lock gitconfig.lock now, which a killed run leaves, and which stops the next
  // run (and Git in the dev container) as a lock that a killed Git leaves does, until it is removed; credentials.gitconfig
  // keeps its random name, which a killed run does not block.
  it('leaves Git\'s lock when a run is killed before its rename of gitconfig, which stops the next run until it is removed (was G40)', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    const killed = run(env, { hook: { when: 'beforeRename', name: 'gitconfig', action: 'kill' } });
    expect(killed.signal).toBe('SIGKILL');
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.gitconfig.'))).toEqual([]);
    expect(fs.lstatSync(path.join(dir, 'gitconfig.lock')).isFile()).toBe(true);
    const blocked = run(env);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain(`${dir}/gitconfig.lock exists`);
    expect(fs.existsSync(path.join(dir, 'gitconfig'))).toBe(false);
    fs.rmSync(path.join(dir, 'gitconfig.lock'));
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(gitConfig(path.join(dir, 'gitconfig'), '--get-all', KEY)).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  it('is not blocked by the new credentials.gitconfig that a run killed before its rename left (kills G40: a fixed name of the new file)', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    const killed = run(env, { hook: { when: 'beforeRename', name: 'credentials.gitconfig', action: 'kill' } });
    expect(killed.signal).toBe('SIGKILL');
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.credentials.gitconfig.'))).toHaveLength(1);
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.lstatSync(path.join(dir, 'credentials.gitconfig')).isFile()).toBe(true);
    expect(gitConfig(path.join(dir, 'gitconfig'), '--get-all', KEY)).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });
});

// CREATE_FOLDERS_SCRIPT: a module that Node loads before the script plays the owner once (as in scripts.test.ts): right after
// the script's stat of PROBE_STAT (its last check of the nearest folder), or right before it changes into a folder named
// PROBE_CHDIR, the folder PROBE_SWAP is moved away and a link to PROBE_TARGET (or, with PROBE_FIFO, a FIFO) takes its
// place. With PROBE_OTHER_DEVICE, every lstat reports a device other than the real one (a folder with the same inode on
// another file system). Adopted (A-F3): `enter` checks a folder by its lstat now (was: the fstat of the folder that it
// opened), so the fake device is in lstatSync (was fstatSync).
const CREATE_PRELOAD = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROBE_STAT: checked, PROBE_CHDIR: entered, PROBE_SWAP: swap, PROBE_TARGET: target, PROBE_FIFO: fifo, PROBE_OTHER_DEVICE: otherDevice } = process.env;
let done = false;
const act = () => {
  if (done) return;
  done = true;
  fs.renameSync(swap, swap + '.moved');
  if (fifo) execFileSync('mkfifo', [swap]);
  else fs.symlinkSync(target, swap);
};
const statSync = fs.statSync;
fs.statSync = (file, ...rest) => {
  const result = statSync.call(fs, file, ...rest);
  if (checked !== undefined && file === checked) act();
  return result;
};
const chdir = process.chdir;
process.chdir = (folder) => {
  if (entered !== undefined && path.basename(String(folder)) === entered) act();
  return chdir.call(process, folder);
};
if (otherDevice) {
  const lstatSync = fs.lstatSync;
  fs.lstatSync = (...args) => {
    const stat = lstatSync.apply(fs, args);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 });
  };
}
`;

describe('CREATE_FOLDERS_SCRIPT, review round 1 of PR G (reviewer B)', () => {
  function setup(): { repo: string; outside: string; preload: string } {
    const dir = tempDir();
    const repo = path.join(dir, 'repo');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
    fs.mkdirSync(outside);
    const preload = path.join(dir, 'race.js');
    fs.writeFileSync(preload, CREATE_PRELOAD);
    return { repo, outside, preload };
  }

  function run(preload: string, repo: string, folders: string[], env: Record<string, string>) {
    const command = createFoldersCommand(repo, folders);
    expect(command[0]).toBe('node');
    return spawnSync(process.execPath, ['--require', preload, ...command.slice(1)], { encoding: 'utf8', timeout: 8_000, env: { ...process.env, ...env } });
  }

  it('never waits on a FIFO that takes the place of the nearest folder after the checks (kills C02: enter without O_DIRECTORY)', { timeout: 30_000 }, () => {
    const { repo, outside, preload } = setup();
    const result = run(preload, repo, [`${repo}/data/new`], { PROBE_STAT: `${repo}/data`, PROBE_SWAP: `${repo}/data`, PROBE_FIFO: '1', PROBE_TARGET: outside });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${repo}/data is no folder of the repository.`);
    expect(fs.lstatSync(`${repo}/data.moved`).isDirectory()).toBe(true);
    expect(fs.readdirSync(`${repo}/data.moved`)).toEqual([]);
  });

  it('stops when a folder that it created is replaced by a link between its creation and the change into it (kills C13: a plain chdir after mkdir)', () => {
    const { repo, outside, preload } = setup();
    const result = run(preload, repo, [`${repo}/data/new/sub`], { PROBE_CHDIR: 'new', PROBE_SWAP: `${repo}/data/new`, PROBE_TARGET: outside });
    expect(result.error).toBeUndefined();
    expect(fs.lstatSync(`${repo}/data/new`).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${repo}/data/new is no folder of the repository.`);
  });

  it('refuses a missing repository folder with its message, and a link in its place also with no folder to create (kills C07, C15)', () => {
    const { repo } = setup();
    const missing = path.join(path.dirname(repo), 'missing');
    const plain = (command: string[]) => spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', timeout: 8_000 });
    const gone = plain(createFoldersCommand(missing, [`${missing}/x`]));
    expect(gone.status).toBe(2);
    expect(gone.stderr).toContain(`The repository folder ${missing} does not exist.`);
    const link = path.join(path.dirname(repo), 'linked');
    fs.symlinkSync(repo, link);
    const none = plain(createFoldersCommand(link, []));
    expect(none.status).toBe(2);
    expect(none.stderr).toContain(`The repository folder ${link} is no folder of its own`);
  });

  it('refuses a folder with the inode of the folder that it checked on another device (kills C04: the inode alone)', () => {
    const { repo, preload } = setup();
    const result = run(preload, repo, [`${repo}/data/new`], { PROBE_OTHER_DEVICE: '1' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`The repository folder ${repo} is no folder of its own (EXDEV).`);
    expect(fs.existsSync(`${repo}/data/new`)).toBe(false);
  });
});
