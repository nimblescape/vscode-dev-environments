// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of PR G (reviewer B): probes for the mutants of the fixes of review round 2 (A-L1) in GIT_FILES_SCRIPT
// that the suites let survive: the rule of takeLock for a lock that a killed run left (its limit of 10 minutes by the
// time of the last change: S06 S08 S08b; the owner root by its uid: S05; a link never followed: S18; the lstat and the
// removal through the folder that the script opened: S16 S17; a lock that is gone meanwhile: S19 S21; the error of the
// open: S22; the whole minutes of its line in the log: S13), and the signals that it ignores for its whole run, also
// during its check without the lock and after its work on gitconfig (T06 T08 T09). Each test names the mutants that it
// kills (the mutant table of the review, scratchpad/pGr3B-report.md); each passes on the script as it is.
// Adopted into the suite with the fixes of review round 3 of PR G, adapted to them: SIGKILL at the time limit of a run
// (A-L4), and the lock of the S05 case is of 4323:0 (was 4321:0, the owner of the repository here, whose lock A-L1 takes).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { GIT_FILES_SCRIPT, gitFilesCommand } from './scripts';

const folders: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-11igr3-')));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const hasGit = spawnSync('git', ['--version']).status === 0;
const realGit = hasGit ? (spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout ?? '').trim() : '';

// Loaded by Node before GIT_FILES_SCRIPT (`--require`): owner changes are recorded by the inode that they reach instead of
// made (the test may run as a user); the repository folder belongs to 4321:4322 (its lstat); with PROBE_LOCK_OWNER
// (uid:gid), an entry named gitconfig.lock belongs to that owner as the script sees it (lstat and stat: a user cannot give
// a file to root). A process of the dev container acts once: right after the script's lstat of gitconfig.lock
// (PROBE_AFTER_LSTAT), or right after the script's open of gitconfig.lock failed with EEXIST (PROBE_AT_EEXIST), it moves
// the entry `entry` away and puts a link to `target` in its place (`swap`), or removes `entry` (`remove`).
const PRELOAD = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { PROBE_LOG: log, PROBE_REPO: repo, PROBE_LOCK_OWNER: lockOwner, PROBE_AFTER_LSTAT: lstatText, PROBE_AT_EEXIST: eexistText } = process.env;
const { lstatSync, statSync, openSync, renameSync, unlinkSync } = fs;
const record = (stat, uid, gid) => fs.appendFileSync(log, stat.ino + ' ' + uid + ':' + gid + '\n');
fs.fchownSync = (descriptor, uid, gid) => record(fs.fstatSync(descriptor), uid, gid);
fs.lchownSync = (file, uid, gid) => record(lstatSync.call(fs, file), uid, gid);
fs.chownSync = (file, uid, gid) => record(statSync.call(fs, file), uid, gid);
const [lockUid, lockGid] = lockOwner ? lockOwner.split(':').map(Number) : [];
const owned = (file, stat) => {
  if (!stat) return stat;
  if (lockOwner && path.basename(String(file)) === 'gitconfig.lock') return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: lockUid, gid: lockGid });
  if (file === repo) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 4321, gid: 4322 });
  return stat;
};
const act = (hook) => {
  if (hook.action === 'remove') {
    unlinkSync.call(fs, hook.entry);
    return;
  }
  renameSync.call(fs, hook.entry, hook.entry + '.moved');
  fs.symlinkSync(hook.target, hook.entry);
};
const afterLstat = lstatText ? JSON.parse(lstatText) : undefined;
let lstatFired = false;
fs.lstatSync = (file, ...rest) => {
  const stat = lstatSync.call(fs, file, ...rest);
  if (afterLstat !== undefined && !lstatFired && path.basename(String(file)) === 'gitconfig.lock') {
    lstatFired = true;
    act(afterLstat);
  }
  return owned(file, stat);
};
fs.statSync = (file, ...rest) => owned(file, statSync.call(fs, file, ...rest));
const atEexist = eexistText ? JSON.parse(eexistText) : undefined;
let eexistFired = false;
fs.openSync = (file, ...rest) => {
  try {
    return openSync.call(fs, file, ...rest);
  } catch (error) {
    if (atEexist !== undefined && !eexistFired && error.code === 'EEXIST' && path.basename(String(file)) === 'gitconfig.lock') {
      eexistFired = true;
      act(atEexist);
    }
    throw error;
  }
};
`;

// A git on PATH that notes the file that it edits (--file) in PROBE_DIR/git-files; at its first call on the copy `check`
// (the check of gitconfig without the lock, A-L1) it runs the shell command PROBE_AT_CHECK once, or sends the signal
// PROBE_SIGNAL_AT_CHECK once to the script and to itself (a Cancel: the batch helper signals the whole process group of
// the step); then the real Git.
const FAKE_GIT = String.raw`#!/bin/sh
file=
previous=
for arg do
  [ "$previous" = --file ] && file=$arg
  previous=$arg
done
printf '%s\n' "$file" >> "$PROBE_DIR/git-files"
case "$file" in
  */check)
    if [ -n "$PROBE_AT_CHECK" ] && [ ! -e "$PROBE_DIR/at-check-done" ]; then
      : > "$PROBE_DIR/at-check-done"
      sh -c "$PROBE_AT_CHECK"
    fi
    if [ -n "$PROBE_SIGNAL_AT_CHECK" ] && [ ! -e "$PROBE_DIR/signal-done" ]; then
      : > "$PROBE_DIR/signal-done"
      kill -s "$PROBE_SIGNAL_AT_CHECK" "$PPID"
      kill -s "$PROBE_SIGNAL_AT_CHECK" "$$"
    fi
    ;;
esac
exec "$PROBE_REAL_GIT" "$@"
`;

// An rm on PATH (GNU rm removes an entry for the script, through the folder that it opened, as its descriptor 3) that
// sends the signal PROBE_SIGNAL_AT_RM once to the script, then runs the real rm.
const FAKE_RM = String.raw`#!/bin/sh
if [ -n "$PROBE_SIGNAL_AT_RM" ] && [ ! -e "$PROBE_DIR/rm-signal-done" ]; then
  : > "$PROBE_DIR/rm-signal-done"
  kill -s "$PROBE_SIGNAL_AT_RM" "$PPID"
fi
exec "$PROBE_REAL_RM" "$@"
`;
const realRm = (spawnSync('sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).stdout ?? '').trim();

const OWNER = '4321:4322';
const KEY = 'credential.https://github.com.helper';
/** A gitconfig that the script repairs (under Git's lock). */
const TO_REPAIR = '[user]\n\tname = Owner Name\n[credential "https://github.com"]\n\thelper = store\n';

interface RunOptions {
  /** The owner (uid:gid) of an entry named gitconfig.lock, as the script sees it. */
  lockOwner?: string;
  /** Once, right after the script's lstat of gitconfig.lock. */
  afterLstat?: { action: 'swap'; entry: string; target: string };
  /** Once, right after the script's open of gitconfig.lock failed with EEXIST. */
  atEexist?: { action: 'swap'; entry: string; target: string } | { action: 'remove'; entry: string };
  /** Once, at the first call of Git on the copy of the check without the lock. */
  atCheck?: string;
  /** Once, at the first call of Git on the copy of the check without the lock: the signal to the script and to that Git. */
  signalAtCheck?: 'TERM' | 'INT' | 'HUP';
  /** Once, when the script runs rm (it removes an entry): the signal to the script. */
  signalAtRm?: 'TERM' | 'INT' | 'HUP';
}

/** /workspaces of the test, with the repository folder `api` and CONFIG_FOLDER, whose gitconfig holds TO_REPAIR. */
function setup() {
  const dir = tempDir();
  const ws = path.join(dir, 'workspaces');
  const bin = path.join(dir, 'bin');
  const config = path.join(ws, '.devenv+');
  fs.mkdirSync(path.join(ws, 'api'), { recursive: true });
  fs.mkdirSync(config);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'preload.js'), PRELOAD);
  fs.writeFileSync(path.join(dir, 'owners'), '');
  fs.writeFileSync(path.join(dir, 'git-files'), '');
  fs.writeFileSync(path.join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'rm'), FAKE_RM, { mode: 0o755 });
  const cfg = path.join(config, 'gitconfig');
  fs.writeFileSync(cfg, TO_REPAIR);
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
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      PATH: `${env.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      GIT_CONFIG_NOSYSTEM: '1',
      PROBE_DIR: env.dir,
      PROBE_LOG: path.join(env.dir, 'owners'),
      PROBE_REPO: path.join(env.ws, 'api'),
      PROBE_REAL_GIT: realGit,
      PROBE_AT_CHECK: options.atCheck ?? '',
      PROBE_SIGNAL_AT_CHECK: options.signalAtCheck ?? '',
      PROBE_REAL_RM: realRm,
      PROBE_SIGNAL_AT_RM: options.signalAtRm ?? '',
      ...(options.lockOwner !== undefined ? { PROBE_LOCK_OWNER: options.lockOwner } : {}),
      ...(options.afterLstat !== undefined ? { PROBE_AFTER_LSTAT: JSON.stringify(options.afterLstat) } : {}),
      ...(options.atEexist !== undefined ? { PROBE_AT_EEXIST: JSON.stringify(options.atEexist) } : {}),
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

/** The files that the script's Git edited (in its work folder). */
const edited = (env: ReturnType<typeof setup>): string[] => fs.readFileSync(path.join(env.dir, 'git-files'), 'utf8').split('\n').filter((line) => line !== '');

const gitConfig = (file: string, ...args: string[]): string => spawnSync(realGit, ['config', '--file', file, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).stdout;

/** Sets the time of the last change (mtime) of `file` to `seconds` ago, and its last access (atime) to `accessed` seconds ago. */
function age(file: string, seconds: number, accessed = seconds): void {
  const now = Date.now() / 1000;
  fs.utimesSync(file, now - accessed, now - seconds);
}

/** The gitconfig that the script repaired: the owner's name kept, the credential section as it must be, with its owner. */
function expectRepaired(env: ReturnType<typeof setup>, cfg = env.cfg): void {
  expect(fs.lstatSync(cfg).isFile()).toBe(true);
  expect(gitConfig(cfg, 'user.name')).toBe('Owner Name\n');
  expect(gitConfig(cfg, '--get-all', KEY)).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  expect(owners(env).get(fs.lstatSync(cfg).ino)).toEqual([OWNER]);
}

describe.skipIf(!hasGit || process.platform !== 'linux')('GIT_FILES_SCRIPT and a lock that a killed run left (A-L1), review round 3 of PR G (reviewer B)', () => {
  // A-L1: a lock of root, a plain file of one link, unchanged for more than 10 minutes (by its mtime) is removed and named
  // in the log, with the whole minutes since its last change. The suite tests 9 and 11 minutes, which a limit anywhere
  // in between passes, and sets both times of the lock alike.
  it.each([
    ['10 minutes and 2 seconds ago', 'S08: the limit 11 minutes', 602, 602, 10],
    ['10 minutes and 35 seconds ago', 'S08, S13: the minutes rounded', 635, 635, 10],
    ['11 minutes ago, and read just now', 'S06: the age by the access time', 660, 0, 11],
  ] as const)('removes a lock of root last changed %s, and names it with the whole minutes (kills %s)', (_when, _kills, seconds, accessed, minutes) => {
    const env = setup();
    fs.writeFileSync(env.lock, '');
    age(env.lock, seconds, accessed);
    const result = run(env, { lockOwner: '0:0' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removed ${env.lock}, the lock of a run that was killed (unchanged for ${minutes} minutes).\n`);
    expect(fs.existsSync(env.lock)).toBe(false);
    expectRepaired(env);
  });

  // A-L1: any other lock stays, and the step fails as for a Git that runs. The suite's lock of another owner is of
  // another group too, and its link leads nowhere (so lstat and stat agree that it is no file).
  it.each([
    ['last changed 9 minutes and 40 seconds ago', 'S08b: the limit 9.5 minutes', 580, '0:0', 'file'],
    ['of another user whose group is root (4323:0)', 'S05: root by the group', 660, '4323:0', 'file'],
    ['that is a link to a plain file of root outside the volume, unchanged for 11 minutes', 'S18: the stat follows the link', 660, '0:0', 'link'],
  ] as const)('keeps a lock %s, and fails as for a Git that runs (kills %s)', (_what, _kills, seconds, lockOwner, kind) => {
    const env = setup();
    const outside = path.join(env.dir, 'outside');
    fs.writeFileSync(outside, 'a file outside the volume\n');
    age(outside, seconds);
    if (kind === 'link') fs.symlinkSync(outside, env.lock);
    else {
      fs.writeFileSync(env.lock, 'the lock of another Git\n');
      age(env.lock, seconds);
    }
    const before = fs.lstatSync(env.lock).ino;
    const result = run(env, { lockOwner });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${env.lock} exists`);
    expect(result.stdout).not.toContain('Removed');
    expect(fs.lstatSync(env.lock).ino).toBe(before);
    expect(fs.lstatSync(env.lock).isSymbolicLink()).toBe(kind === 'link');
    expect(fs.readFileSync(outside, 'utf8')).toBe('a file outside the volume\n');
    expect(fs.readFileSync(env.cfg, 'utf8')).toBe(TO_REPAIR);
  });

  // A-L1 and the rule of the PR: the stale lock is removed through the folder that the script opened. Right after its
  // lstat of the lock, the owner moves .devenv+ away and puts a link to a folder outside the volume in its place (in the
  // helper: the shared cache volume), with a file gitconfig.lock there; a removal by the path would follow it.
  it('removes the lock of a killed run through the folder that it opened, never through a link that takes the place of .devenv+ after its lstat (kills S16: the removal by path)', () => {
    const env = setup();
    fs.writeFileSync(env.lock, '');
    age(env.lock, 660);
    const outside = path.join(env.dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'gitconfig.lock'), 'a file outside the volume\n');
    age(path.join(outside, 'gitconfig.lock'), 660);
    const result = run(env, { lockOwner: '0:0', afterLstat: { action: 'swap', entry: env.config, target: outside } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.lstatSync(env.config).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'gitconfig.lock'), 'utf8')).toBe('a file outside the volume\n');
    // The folder that the script opened (moved by the owner): the stale lock is gone, gitconfig is repaired there.
    const moved = `${env.config}.moved`;
    expect(fs.readdirSync(moved).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    expectRepaired(env, path.join(moved, 'gitconfig'));
  });

  // A-L1 and the rule of the PR: the lock that the script judges is the entry of the folder that it opened. Right after
  // its open of the lock failed (EEXIST), the owner moves .devenv+ away and puts a link to a folder outside the volume in
  // its place, with a gitconfig.lock that is not stale; an lstat by the path would judge that one.
  it('judges the lock in the folder that it opened, never one that a link in place of .devenv+ leads to (kills S17: the lstat by path)', () => {
    const env = setup();
    fs.writeFileSync(env.lock, '');
    age(env.lock, 660);
    const outside = path.join(env.dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'gitconfig.lock'), 'a lock outside the volume\n');
    const result = run(env, { lockOwner: '0:0', atEexist: { action: 'swap', entry: env.config, target: outside } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removed ${env.lock}, the lock of a run that was killed (unchanged for 11 minutes).\n`);
    expect(fs.readFileSync(path.join(outside, 'gitconfig.lock'), 'utf8')).toBe('a lock outside the volume\n');
    const moved = `${env.config}.moved`;
    expect(fs.readdirSync(moved).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    expectRepaired(env, path.join(moved, 'gitconfig'));
  });

  // A-L1: "Gone meanwhile (a Git of the dev container ended): once more." The lock of another Git is gone between the
  // script's open of its own lock (EEXIST) and its lstat.
  it('takes its lock when the lock of another Git is gone right after its own open failed (kills S19: no new try, S21: the missing lock an error)', () => {
    const env = setup();
    fs.writeFileSync(env.lock, 'the lock of another Git\n');
    const result = run(env, { lockOwner: '0:0', atEexist: { action: 'remove', entry: env.lock } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Removed');
    expect(fs.existsSync(env.lock)).toBe(false);
    expectRepaired(env);
  });

  // A-L1: only EEXIST is a lock that exists; any other failure of the open is the step's error as it is. During the check
  // without the lock, a process of the dev container empties .devenv+ and removes it: the script's open of the lock in the
  // removed folder fails with ENOENT.
  it('fails with the error of its open, never as for a lock of another Git, when it cannot make its lock (kills S22: every error taken for EEXIST)', () => {
    const env = setup();
    const kept = path.join(env.dir, 'kept');
    const result = run(env, { atCheck: `mkdir '${kept}' && mv '${env.config}'/* '${kept}'/ && rmdir '${env.config}'` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`ENOENT: no such file or directory, open '${env.lock}'`);
    expect(result.stderr).not.toContain('exists');
    expect(fs.existsSync(env.config)).toBe(false);
    expect(fs.readFileSync(path.join(kept, 'gitconfig'), 'utf8')).toBe(TO_REPAIR);
  });
});

describe.skipIf(!hasGit || process.platform !== 'linux')('GIT_FILES_SCRIPT and the signals of a Cancel (A-L1), review round 3 of PR G (reviewer B)', () => {
  // A-L1: "it ignores SIGTERM, SIGINT and SIGHUP and ends with its cleanup (Git's lock, the work folder)". The suite sends
  // the signal at calls of Git under the lock; this one at the first call, the check without the lock: its Git dies, the
  // check takes the section for changed, and the script repairs gitconfig under the lock and removes its work folder.
  it.each(['TERM', 'INT', 'HUP'] as const)('ignores SIG%s already during its check without the lock, and ends with its cleanup (kills T06: the signals ignored only from the lock on, T09: only while the lock is held)', (signal) => {
    const env = setup();
    const started = Date.now();
    const result = run(env, { signalAtCheck: signal });
    const work = path.dirname(edited(env)[0]);
    expect(path.basename(work)).toMatch(/^devenv-git-files-/);
    try {
      // Before the SIGKILL of the batch helper (CHANNEL_KILL_GRACE_MS, 5 seconds).
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(path.basename(edited(env)[0])).toBe('check');
      expect(fs.existsSync(work)).toBe(false);
      expect(fs.existsSync(env.lock)).toBe(false);
      expectRepaired(env);
    } finally {
      // A script that the signal ended leaves its work folder (root's, in the helper's /tmp).
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  // The same, after its work on gitconfig: a Cancel while its rm removes a folder that the owner put at
  // credentials.gitconfig. The rm ends as it would, and the script goes on: it makes credentials.gitconfig and removes its
  // work folder.
  it('ignores SIGTERM also after its work on gitconfig, while its rm removes a folder at credentials.gitconfig, and ends with its cleanup (kills T08: the signals ignored only while it works on gitconfig)', () => {
    const env = setup();
    const credentials = path.join(env.config, 'credentials.gitconfig');
    fs.mkdirSync(path.join(credentials, 'sub'), { recursive: true });
    const started = Date.now();
    const result = run(env, { signalAtRm: 'TERM' });
    const work = path.dirname(edited(env)[0]);
    expect(path.basename(work)).toMatch(/^devenv-git-files-/);
    try {
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fs.existsSync(path.join(env.dir, 'rm-signal-done'))).toBe(true);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(fs.lstatSync(credentials).isFile()).toBe(true);
      expect(fs.existsSync(work)).toBe(false);
      expectRepaired(env);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
