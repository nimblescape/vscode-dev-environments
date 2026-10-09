// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR G (reviewer B): probes for the mutants of the fixes of review round 1 in GIT_FILES_SCRIPT (Git's
// lock on gitconfig, A-F4) and CREATE_FOLDERS_SCRIPT (`enter` by lstat, A-F3) that the suites let survive; for two
// mutants of round 1 that its adopted probes no longer kill (since A-F4, gitconfig is written through Git's lock, so their
// probes on the new gitconfig test the lock now, while `place` makes only credentials.gitconfig); and for two points of
// the rule that the probes of round 1 lacked (the owner of an existing file that the script keeps). Each test names the
// mutants that it kills (the mutant table of the review); each passes on the scripts as they are.
// Adapted to the fixes of reviewer A's round 2 (A-L1): GIT_FILES_SCRIPT first checks a copy of gitconfig without the lock
// (the first call of Git), and takes Git's lock only for a change, on the copy that it edits; so the acts on the lock come
// at the first call of Git on that copy, or right after the script made it, and the probes of an unlock with nothing
// written let a Git of the dev container repair gitconfig during the check.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { GIT_FILES_SCRIPT, createFoldersCommand, gitFilesCommand } from './scripts';

const folders: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-11igr2-')));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const hasGit = spawnSync('git', ['--version']).status === 0;
const realGit = hasGit ? spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() : '';

// Loaded by Node before GIT_FILES_SCRIPT (`--require`): owner changes are recorded by the inode that they reach instead of
// made (the test may run as a user), and the repository folder belongs to 4321:4322 (its lstat). A process of the dev
// container acts once: right after the script opened the file PROBE_OPENED (for reading, not one that it creates; its
// PROBE_OPENED_NTH-th such open, the first when not given), it runs the shell command PROBE_AT_OPEN; right after the
// script made the copy that it edits for a change (gitconfig in its work folder devenv-git-files-*: it has opened
// gitconfig under the lock and not read a byte of it yet), it runs the shell command PROBE_AT_COPY; right after the
// script's lstat of an entry named PROBE_AFTER_LSTAT.name, it moves
// PROBE_AFTER_LSTAT.entry away and puts a link to PROBE_AFTER_LSTAT.target in its place; right before (`before`) or right
// after (`after`) the script renames an entry over the entry named PROBE_RENAME.name, it moves PROBE_RENAME.entry away
// and puts a folder that is not empty (`folder`) or a link to PROBE_RENAME.target (`link`) in its place.
const PRELOAD = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { O_CREAT, O_DIRECTORY } = fs.constants;
const { PROBE_LOG: log, PROBE_REPO: repo, PROBE_OPENED: opened, PROBE_OPENED_NTH: openedNth, PROBE_AT_OPEN: atOpen, PROBE_AT_COPY: atCopy, PROBE_RENAME: renameText, PROBE_AFTER_LSTAT: lstatText } = process.env;
const { lstatSync, openSync, renameSync, mkdirSync } = fs;
const record = (stat, uid, gid) => fs.appendFileSync(log, stat.ino + ' ' + uid + ':' + gid + '\n');
fs.fchownSync = (descriptor, uid, gid) => record(fs.fstatSync(descriptor), uid, gid);
fs.lchownSync = (file, uid, gid) => record(lstatSync.call(fs, file), uid, gid);
fs.chownSync = (file, uid, gid) => record(fs.statSync(file), uid, gid);
const afterLstat = lstatText ? JSON.parse(lstatText) : undefined;
let lstatFired = false;
fs.lstatSync = (file, ...rest) => {
  const stat = lstatSync.call(fs, file, ...rest);
  if (afterLstat !== undefined && !lstatFired && path.basename(String(file)) === afterLstat.name) {
    lstatFired = true;
    renameSync.call(fs, afterLstat.entry, afterLstat.entry + '.moved');
    fs.symlinkSync(afterLstat.target, afterLstat.entry);
  }
  return file === repo && stat ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 4321, gid: 4322 }) : stat;
};
let openFired = false;
let openCount = 0;
let copyFired = false;
fs.openSync = (file, flags, ...rest) => {
  const descriptor = openSync.call(fs, file, flags, ...rest);
  const plain = typeof flags === 'number' && (flags & (O_CREAT | O_DIRECTORY)) === 0;
  if (!openFired && atOpen && plain && path.basename(String(file)) === opened && ++openCount === Number(openedNth || 1)) {
    openFired = true;
    execFileSync('sh', ['-c', atOpen], { stdio: 'ignore' });
  }
  const made = typeof flags === 'number' && (flags & O_CREAT) !== 0;
  if (!copyFired && atCopy && made && path.basename(String(file)) === 'gitconfig' && path.basename(path.dirname(String(file))).startsWith('devenv-git-files-')) {
    copyFired = true;
    execFileSync('sh', ['-c', atCopy], { stdio: 'ignore' });
  }
  return descriptor;
};
const hook = renameText ? JSON.parse(renameText) : undefined;
let renameFired = false;
const act = () => {
  renameFired = true;
  try {
    renameSync.call(fs, hook.entry, hook.entry + '.moved');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (hook.action === 'link') fs.symlinkSync(hook.target, hook.entry);
  else {
    mkdirSync.call(fs, hook.entry);
    fs.writeFileSync(path.join(hook.entry, 'x'), 'x');
  }
};
fs.renameSync = (from, to, ...rest) => {
  const due = hook !== undefined && !renameFired && path.basename(String(to)) === hook.name;
  if (due && hook.when === 'before') act();
  const result = renameSync.call(fs, from, to, ...rest);
  if (due && hook.when === 'after') act();
  return result;
};
`;

// A git on PATH that runs the shell command PROBE_AT_CHECK once, at its first call on the copy `check` (the check of
// gitconfig without the lock, A-L1), and PROBE_AT_GIT once, at its first call on the copy that the script edits for a
// change (while the script holds Git's lock); then the real Git.
const FAKE_GIT = String.raw`#!/bin/sh
file=
previous=
for arg do
  [ "$previous" = --file ] && file=$arg
  previous=$arg
done
case "$file" in
  */check) act=$PROBE_AT_CHECK; mark="$PROBE_DIR/at-check-done" ;;
  *) act=$PROBE_AT_GIT; mark="$PROBE_DIR/at-git-done" ;;
esac
if [ -n "$act" ] && [ ! -e "$mark" ]; then
  : > "$mark"
  sh -c "$act"
fi
exec "$PROBE_REAL_GIT" "$@"
`;

const OWNER = '4321:4322';
const KEY = 'credential.https://github.com.helper';
/** A gitconfig whose credential section is as the script wants it (nothing to write). */
const CORRECT = `[user]\n\tname = Owner Name\n[credential "https://github.com"]\n\thelper = \n\thelper = ${JSON.stringify(CONTAINER_CREDENTIAL_HELPER)}\n`;
/** A gitconfig that the script repairs. */
const TO_REPAIR = '[user]\n\tname = Owner Name\n[credential "https://github.com"]\n\thelper = store\n';

interface RunOptions {
  /** Once, at the first call of Git on the copy that the script edits for a change (it holds Git's lock then). */
  atGit?: string;
  /** Once, at the first call of Git on the copy of the check without the lock (A-L1). */
  atCheck?: string;
  /** Once, right after the script made the copy that it edits for a change (gitconfig opened under the lock, not read). */
  atCopy?: string;
  /** Once, right after the script opened the file `name` for reading (its `nth` such open, the first when not given), a process of the dev container runs `command`. */
  atOpen?: { name: string; command: string; nth?: number };
  rename?: { when: 'before' | 'after'; name: string; action: 'folder' | 'link'; entry: string; target?: string };
  afterLstat?: { name: string; entry: string; target: string };
}

/** /workspaces of the test, with the repository folder `api` and CONFIG_FOLDER, whose gitconfig holds `content`. */
function setup(content: string) {
  const dir = tempDir();
  const ws = path.join(dir, 'workspaces');
  const bin = path.join(dir, 'bin');
  const config = path.join(ws, '.devenv+');
  fs.mkdirSync(path.join(ws, 'api'), { recursive: true });
  fs.mkdirSync(config);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'preload.js'), PRELOAD);
  fs.writeFileSync(path.join(dir, 'owners'), '');
  fs.writeFileSync(path.join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
  const cfg = path.join(config, 'gitconfig');
  fs.writeFileSync(cfg, content);
  return { dir, ws, bin, config, cfg, lock: `${cfg}.lock` };
}

/** Runs the script as gitFilesCommand builds it, with /workspaces in the test folder. */
function run(env: ReturnType<typeof setup>, options: RunOptions = {}) {
  const command = gitFilesCommand('api', { name: 'Probe', email: 'probe@example.com' }, CONTAINER_CREDENTIAL_HELPER);
  expect(command.slice(0, 3)).toEqual(['node', '-e', GIT_FILES_SCRIPT]);
  const script = GIT_FILES_SCRIPT.split('/workspaces').join(env.ws);
  // With the umask of the helper (022), so that the modes that the script asks for are the modes that it gets.
  return spawnSync('sh', ['-c', 'umask 022 && exec "$@"', 'sh', process.execPath, '--require', path.join(env.dir, 'preload.js'), '-e', script, ...command.slice(3)], {
    encoding: 'utf8',
    timeout: 20_000,
    // Review round 3 of PR G (A-L4): SIGKILL at the time limit (the script ignores SIGTERM since review round 2, A-L1).
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      PATH: `${env.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      GIT_CONFIG_NOSYSTEM: '1',
      PROBE_DIR: env.dir,
      PROBE_LOG: path.join(env.dir, 'owners'),
      PROBE_REPO: path.join(env.ws, 'api'),
      PROBE_REAL_GIT: realGit,
      ...(options.atGit !== undefined ? { PROBE_AT_GIT: options.atGit } : {}),
      ...(options.atCheck !== undefined ? { PROBE_AT_CHECK: options.atCheck } : {}),
      ...(options.atCopy !== undefined ? { PROBE_AT_COPY: options.atCopy } : {}),
      ...(options.atOpen !== undefined ? { PROBE_OPENED: options.atOpen.name, PROBE_OPENED_NTH: String(options.atOpen.nth ?? 1), PROBE_AT_OPEN: options.atOpen.command } : {}),
      ...(options.rename !== undefined ? { PROBE_RENAME: JSON.stringify(options.rename) } : {}),
      ...(options.afterLstat !== undefined ? { PROBE_AFTER_LSTAT: JSON.stringify(options.afterLstat) } : {}),
    },
  });
}

/** The owners that the script gave, by inode. */
function owners(env: ReturnType<typeof setup>): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (const line of fs.readFileSync(path.join(env.dir, 'owners'), 'utf8').split('\n').filter((entry) => entry !== '')) {
    const [inode, owner] = line.split(' ');
    result.set(Number(inode), [...(result.get(Number(inode)) ?? []), owner]);
  }
  return result;
}

const gitConfig = (file: string, ...args: string[]): string => spawnSync(realGit, ['config', '--file', file, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).stdout;

/**
 * A Git of the dev container that repairs gitconfig as Git writes it (its lock gitconfig.lock, renamed over gitconfig),
 * with the section that the script wants, and notes the inode of the new file. Since A-L1 the script writes nothing under
 * its lock only for a gitconfig that it found to change in its check without the lock and that is right under the lock,
 * that is one that a Git of the dev container repaired in between (its branch "as it must be meanwhile").
 */
function repairAsGit(env: ReturnType<typeof setup>): { command: string; ino: () => number } {
  const repaired = path.join(env.dir, 'repaired');
  const inode = path.join(env.dir, 'repaired-ino');
  fs.writeFileSync(repaired, CORRECT);
  return {
    command: `cp -- '${repaired}' '${env.lock}' && mv -- '${env.lock}' '${env.cfg}' && stat -c %i -- '${env.cfg}' > '${inode}'`,
    ino: () => Number(fs.readFileSync(inode, 'utf8').trim()),
  };
}

describe.skipIf(!hasGit || process.platform !== 'linux')("GIT_FILES_SCRIPT and Git's lock on gitconfig, review round 2 of PR G (reviewer B)", () => {
  // A-F4: the script holds the lock "from before its read of gitconfig to the rename". Since A-L1 it first checks a copy
  // without the lock (a change of Git then is kept: it reads gitconfig again under the lock, a test of scripts.test.ts),
  // and the test of scripts.test.ts lets Git of the dev container change gitconfig at the first call of the script's Git
  // under the lock (after the read); this one right after the script opened gitconfig under its lock and made the copy
  // that it edits, before it read a byte of gitconfig: a lock taken only after the read (still before the edits) passes
  // the other test and loses this change, which Git reported as made.
  it('holds the lock already when it opens gitconfig to change it: a change of Git in the dev container right then fails, and is never lost (kills L21: the lock taken after the read)', () => {
    const env = setup(TO_REPAIR);
    const status = path.join(env.dir, 'concurrent-status');
    const stderr = path.join(env.dir, 'concurrent-stderr');
    const result = run(env, { atCopy: `"${realGit}" config --file '${env.cfg}' user.name 'Concurrent Name' 2> '${stderr}'; echo $? > '${status}'` });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const concurrent = { status: fs.readFileSync(status, 'utf8').trim(), name: gitConfig(env.cfg, 'user.name') };
    // Git found the lock and failed (the user sees it), so the name stays the owner's; never a success whose change is gone.
    expect(concurrent).toEqual({ status: expect.not.stringMatching(/^0$/), name: 'Owner Name\n' });
    expect(fs.readFileSync(stderr, 'utf8')).toContain('could not lock config file');
    expect(gitConfig(env.cfg, '--get-all', KEY)).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(fs.readdirSync(env.config).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
  });

  // A-F4: the lock is made with mode 0600 (`O_CREAT|O_EXCL`, root's), and gets the mode of gitconfig only right before its
  // rename. A lock that others may read while it is held can be opened by a process of another user of the dev container,
  // which then reads the text of gitconfig when the script writes it into the lock (a gitconfig of mode 0600 too). The
  // mode is read at the first call of Git under the lock (since A-L1 the first call of Git is the check without it).
  it('keeps its lock unreadable for others while it holds it (kills L03: the lock made with mode 0644)', () => {
    const env = setup(TO_REPAIR);
    fs.chmodSync(env.cfg, 0o600);
    const mode = path.join(env.dir, 'lock-mode');
    const result = run(env, { atGit: `stat -c %a '${env.lock}' > '${mode}'` });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(mode, 'utf8').trim()).toBe('600');
    expect(fs.lstatSync(env.cfg).mode & 0o777).toBe(0o600);
    expect(gitConfig(env.cfg, '--get-all', KEY)).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  // A-F4: with nothing to write under the lock, the script removes its lock (`unlock`), and a lock that is gone already
  // (the user removed it, as the warning of the script tells for a lock that a killed run left) is no error. Since A-L1
  // that is a gitconfig that a Git of the dev container repaired during the check without the lock (repairAsGit); the
  // user removes the lock at the first call of Git under it.
  it('succeeds with nothing to write under its lock when the lock is gone already, and leaves gitconfig as it is (kills L14: a missing lock is an error)', () => {
    const env = setup(TO_REPAIR);
    const repair = repairAsGit(env);
    const removed = path.join(env.dir, 'lock-removed');
    const result = run(env, { atCheck: repair.command, atGit: `rm -- '${env.lock}' && : > '${removed}'` });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The user removed the lock while the script held it.
    expect(fs.existsSync(removed)).toBe(true);
    // gitconfig as the Git of the dev container left it (its text and its inode: not written again), with its owner.
    expect({ text: fs.readFileSync(env.cfg, 'utf8'), ino: fs.lstatSync(env.cfg).ino }).toEqual({ text: CORRECT, ino: repair.ino() });
    expect(owners(env).get(repair.ino())).toEqual([OWNER]);
    expect(fs.existsSync(env.lock)).toBe(false);
  });

  // A-F4 and the rule of the PR: the new text goes into the lock, and the lock gets the owner and the mode, all through the
  // descriptor of the lock that the script made. While the script holds it (at the first call of Git under the lock), the
  // owner (who owns CONFIG_FOLDER) moves gitconfig.lock away and puts a link to a file outside the volume in its place (in
  // the helper: the Docker socket, a file of the shared cache volume); a write, chown or chmod by the path would follow it.
  // The rename then moves the owner's link to gitconfig (a rename never follows a link): the owner's doing, inside the
  // volume.
  it('writes the new gitconfig and gives it its owner and mode through the descriptor of its lock, never through a link that the owner puts at gitconfig.lock meanwhile (kills L28, L29, L30: owner, mode, text by path)', () => {
    const env = setup(TO_REPAIR);
    const outside = path.join(env.dir, 'outside');
    fs.mkdirSync(outside);
    const target = path.join(outside, 'file');
    fs.writeFileSync(target, '[outside]\n');
    fs.chmodSync(target, 0o640);
    const result = run(env, { atGit: `mv -- '${env.lock}' '${env.lock}.moved' && ln -s -- '${target}' '${env.lock}'` });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('[outside]\n');
    expect(fs.lstatSync(target).mode & 0o7777).toBe(0o640);
    expect(owners(env).has(fs.lstatSync(target).ino)).toBe(false);
    // The lock that the script made (moved by the owner) holds the new text, with the owner and the mode of gitconfig.
    const moved = `${env.lock}.moved`;
    expect(gitConfig(moved, '--get-all', KEY)).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(owners(env).get(fs.lstatSync(moved).ino)).toEqual([OWNER]);
    expect(fs.lstatSync(moved).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(env.cfg).isSymbolicLink()).toBe(true);
  });

  // A-F4 and the rule of the PR: `unlock` looks at gitconfig.lock and removes it through the folder that the script opened.
  // Since A-L1 it does so with nothing written for a gitconfig that a Git of the dev container repaired during the check
  // without the lock (repairAsGit). Right after its lstat of the lock, the owner moves .devenv+ away and puts a link to a
  // folder outside the volume in its place (in the helper: the shared cache volume), with a file gitconfig.lock there.
  it('removes its lock through the folder that it opened, never through a link that takes the place of .devenv+ before the removal (kills L27: lstat and unlink of the lock by path)', () => {
    const env = setup(TO_REPAIR);
    const repair = repairAsGit(env);
    const outside = path.join(env.dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'gitconfig.lock'), 'a file outside the volume\n');
    const result = run(env, { atCheck: repair.command, afterLstat: { name: 'gitconfig.lock', entry: env.config, target: outside } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.lstatSync(env.config).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'gitconfig.lock'), 'utf8')).toBe('a file outside the volume\n');
    // Its own lock is gone from the folder that it opened (moved by the owner), gitconfig stayed as the Git of the dev
    // container left it.
    expect(fs.readdirSync(`${env.config}.moved`).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    expect(fs.readFileSync(path.join(`${env.config}.moved`, 'gitconfig'), 'utf8')).toBe(CORRECT);
  });
});

// `place` (a new file under a random name, its owner and mode through its descriptor, then the rename) makes only
// credentials.gitconfig since A-F4. The adopted probes of round 1 for G36 and G39 put the owner's entry at gitconfig, so
// they test the lock now; these put it at credentials.gitconfig (missing, so the script makes it).
describe.skipIf(!hasGit || process.platform !== 'linux')('GIT_FILES_SCRIPT, the new credentials.gitconfig, review round 2 of PR G (reviewer B)', () => {
  it('sets the owner and the mode of the new credentials.gitconfig before its rename, never through the entry afterwards (kills G39 again: owner and mode by path after the rename)', () => {
    const env = setup(CORRECT);
    const outside = path.join(env.dir, 'outside');
    fs.mkdirSync(outside);
    const target = path.join(outside, 'file');
    fs.writeFileSync(target, '[outside]\n');
    fs.chmodSync(target, 0o640);
    const entry = path.join(env.config, 'credentials.gitconfig');
    // Right after the rename, the owner moves the new file away and puts a link to a file outside in its place.
    const result = run(env, { rename: { when: 'after', name: 'credentials.gitconfig', action: 'link', entry, target } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(target).mode & 0o7777).toBe(0o640);
    expect(fs.readFileSync(target, 'utf8')).toBe('[outside]\n');
    expect(owners(env).has(fs.lstatSync(target).ino)).toBe(false);
    // The file that the script made has its owner and mode.
    expect(owners(env).get(fs.lstatSync(`${entry}.moved`).ino)).toEqual([OWNER]);
    expect(fs.lstatSync(`${entry}.moved`).mode & 0o777).toBe(0o644);
  });

  // The rule of the PR (not changed in review round 1, a point that the probes of round 1 lacked): an existing file that
  // the script keeps (gitconfig with nothing to write, credentials.gitconfig) gets the owner through the descriptor that the
  // script read it from. Right after that open, the owner moves the file away and puts a link to a file outside the volume
  // in its place; a chown by the path would follow it.
  it.each([
    ['gitconfig', 'X01'],
    ['credentials.gitconfig', 'X02'],
  ])('gives the existing %s its owner through the descriptor that it opened, never through a link put in its place after the open (kills %s: the owner by path)', (name) => {
    const env = setup(CORRECT);
    const credentials = path.join(env.config, 'credentials.gitconfig');
    fs.writeFileSync(credentials, '[credential "https://gitlab.example.com"]\n\thelper = store\n');
    const outside = path.join(env.dir, 'outside');
    fs.mkdirSync(outside);
    const target = path.join(outside, 'file');
    fs.writeFileSync(target, '[outside]\n');
    fs.chmodSync(target, 0o640);
    const entry = path.join(env.config, name);
    const result = run(env, { atOpen: { name, command: `mv -- '${entry}' '${entry}.moved' && ln -s -- '${target}' '${entry}'` } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
    expect(owners(env).has(fs.lstatSync(target).ino)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('[outside]\n');
    expect(fs.lstatSync(target).mode & 0o7777).toBe(0o640);
    // The file that the script opened (moved by the owner) got the owner.
    expect(owners(env).get(fs.lstatSync(`${entry}.moved`).ino)).toEqual([OWNER]);
  });

  // The same point of the rule in the branch of A-L1 for a gitconfig that is right under the lock (a Git of the dev
  // container repaired it during the check without the lock, repairAsGit): the script keeps it, with nothing written, and
  // gives it the owner through the descriptor that it opened under the lock. Right after that open (the second of
  // gitconfig, the first is the check), the owner moves it away and puts a link to a file outside the volume in its place.
  it('gives the gitconfig that is right under its lock the owner through the descriptor that it opened, never through a link put in its place after the open (kills X01b: the owner by path)', () => {
    const env = setup(TO_REPAIR);
    const repair = repairAsGit(env);
    const outside = path.join(env.dir, 'outside');
    fs.mkdirSync(outside);
    const target = path.join(outside, 'file');
    fs.writeFileSync(target, '[outside]\n');
    fs.chmodSync(target, 0o640);
    const result = run(env, { atCheck: repair.command, atOpen: { name: 'gitconfig', nth: 2, command: `mv -- '${env.cfg}' '${env.cfg}.moved' && ln -s -- '${target}' '${env.cfg}'` } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.lstatSync(env.cfg).isSymbolicLink()).toBe(true);
    expect(owners(env).has(fs.lstatSync(target).ino)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('[outside]\n');
    expect(fs.lstatSync(target).mode & 0o7777).toBe(0o640);
    // The file that the script opened under the lock (the one the Git of the dev container wrote, moved by the owner) got
    // the owner, with nothing written; the lock is gone.
    expect(fs.lstatSync(`${env.cfg}.moved`).ino).toBe(repair.ino());
    expect(fs.readFileSync(`${env.cfg}.moved`, 'utf8')).toBe(CORRECT);
    expect(owners(env).get(repair.ino())).toEqual([OWNER]);
    expect(fs.existsSync(env.lock)).toBe(false);
  });

  it('removes its new credentials.gitconfig when the rename into place fails (kills G36 again: the temporary file left)', () => {
    const env = setup(CORRECT);
    const entry = path.join(env.config, 'credentials.gitconfig');
    // Right before the rename, the owner puts a folder (not empty) at credentials.gitconfig: the rename fails.
    const result = run(env, { rename: { when: 'before', name: 'credentials.gitconfig', action: 'folder', entry } });
    expect(result.status).toBe(1);
    expect(fs.readdirSync(env.config).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    expect(fs.lstatSync(entry).isDirectory()).toBe(true);
  });
});

// CREATE_FOLDERS_SCRIPT (A-F3): `enter` checks the entry by its lstat, then changes into it; a FIFO (or a file) that takes
// the place of the folder after the lstat makes the chdir fail (ENOTDIR). Loaded by Node before the script: right before
// the script changes into a folder named PROBE_CHDIR, the folder PROBE_SWAP is moved away and a FIFO takes its place.
const CHDIR_PRELOAD = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROBE_CHDIR: entered, PROBE_SWAP: swap } = process.env;
let done = false;
const chdir = process.chdir;
process.chdir = (folder) => {
  if (!done && path.basename(String(folder)) === entered) {
    done = true;
    fs.renameSync(swap, swap + '.moved');
    execFileSync('mkfifo', [swap]);
  }
  return chdir.call(process, folder);
};
`;

describe.skipIf(process.platform === 'win32')('CREATE_FOLDERS_SCRIPT, review round 2 of PR G (reviewer B)', () => {
  it('stops with exit code 2 and its message when a FIFO takes the place of a folder between its lstat and the change into it (kills E08: the chdir outside the try)', () => {
    const dir = tempDir();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
    const preload = path.join(dir, 'chdir.js');
    fs.writeFileSync(preload, CHDIR_PRELOAD);
    const command = createFoldersCommand(repo, [`${repo}/data/new`]);
    expect(command[0]).toBe('node');
    const result = spawnSync(process.execPath, ['--require', preload, ...command.slice(1)], { encoding: 'utf8', timeout: 8_000, env: { ...process.env, PROBE_CHDIR: 'data', PROBE_SWAP: `${repo}/data` } });
    expect(result.error).toBeUndefined();
    expect(fs.lstatSync(`${repo}/data`).isFIFO()).toBe(true);
    expect(result.stderr).toBe(`${repo}/data is no folder of the repository.\n`);
    expect(result.status).toBe(2);
    expect(fs.readdirSync(`${repo}/data.moved`)).toEqual([]);
  });
});
