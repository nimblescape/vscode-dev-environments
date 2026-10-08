// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of the follow-up of PR #121 (reviewer B, mutation testing): probes of WRITE_AND_RUN_SCRIPT (the
// lockfile rule of every build), MISSING_IN_REPOSITORY (the `..` rule) and CREATE_FOLDERS_SCRIPT (realpath(3)) for the
// mutants that the other tests leave alive. Each probe names the mutants it kills.

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WRITE_AND_RUN_SCRIPT, createFoldersCommand, readFilesCommand } from './scripts';

const tempDirs: string[] = [];
function tempDir(): string {
  // The real path: the scripts compare real paths (a temporary folder may be a link, as /tmp on macOS).
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A fake `devcontainer` (prints its arguments, one per line) on the PATH of the returned environment. */
function setup(): { dir: string; repo: string; folder: string; env: NodeJS.ProcessEnv } {
  const dir = tempDir();
  write(path.join(dir, 'bin', 'devcontainer'), `#!/bin/sh\nprintf '%s\\n' "$@"\n`);
  fs.chmodSync(path.join(dir, 'bin', 'devcontainer'), 0o755);
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` };
  return { dir, repo: path.join(dir, 'repo'), folder: path.join(dir, 'override'), env };
}

/** WRITE_AND_RUN_SCRIPT with `files`, the two configuration paths, and the arguments of `devcontainer`. */
function writeAndRun(
  folder: string,
  env: NodeJS.ProcessEnv,
  files: Record<string, string>,
  args: string[],
  configs: { repository?: string; own?: string },
  options: { preload?: string; cwd?: string } = {},
): Run {
  const result = spawnSync(
    process.execPath,
    [...(options.preload !== undefined ? ['-r', options.preload] : []), '-e', WRITE_AND_RUN_SCRIPT, folder, configs.repository ?? '', configs.own ?? '', ...args],
    { encoding: 'utf8', input: JSON.stringify({ files }), env, timeout: 10_000, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) },
  );
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runNode(command: string[]): Run {
  expect(command[0]).toBe('node');
  const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A process that waits in its open of the FIFO `fifo` for writing until a reader opens it (wchan wait_for_partner, which
 * any open for reading ends, also one with O_NONBLOCK). `opened`: whether its open returned (within 500 ms). As in
 * scripts.readFilesR2.test.ts.
 */
async function waitingWriter(fifo: string): Promise<{ opened: () => Promise<boolean>; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1], 'w')", fifo], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
    let wchan = '';
    try {
      wchan = fs.readFileSync(`/proc/${child.pid}/wchan`, 'utf8');
    } catch {
      // Not yet started.
    }
    if (wchan === 'wait_for_partner') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    opened: () => Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]),
    stop: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

/**
 * A preload of node (-r): a deterministic stand-in for a writer of the repository that changes it while the script runs.
 * Once the script has opened HOOK_FILE (a plain file of the repository) and closed that descriptor again (after the
 * checks and the read of readInRepository), HOOK_FILE becomes a link to HOOK_TO (a file out of the repository).
 */
const RELINK_AFTER_READ = String.raw`'use strict';
const fs = require('fs');
const { HOOK_FILE, HOOK_TO } = process.env;
let hooked;
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  const fd = openSync.call(this, file, ...rest);
  if (file === HOOK_FILE && hooked === undefined) hooked = fd;
  return fd;
};
const closeSync = fs.closeSync;
fs.closeSync = function (fd, ...rest) {
  const result = closeSync.call(this, fd, ...rest);
  if (fd === hooked) {
    hooked = null;
    fs.renameSync(HOOK_FILE, HOOK_FILE + '.before');
    fs.symlinkSync(HOOK_TO, HOOK_FILE);
  }
  return result;
};
`;

describe('WRITE_AND_RUN_SCRIPT, review round 1 of the follow-up of PR #121 (reviewer B)', () => {
  // Mutant R3: realpathSync of JavaScript in REAL_PATH of WRITE_AND_RUN_SCRIPT only (READ_FILES_SCRIPT keeps the native
  // one). For it, the link `out/../fifo` names the missing `fifo` of the repository (no real path, so no check before
  // the open), while the kernel reaches the FIFO out of the repository; the check of the opened descriptor still refuses
  // it, so the loss shows only in the open itself: a writer that waits on the FIFO gets a reader.
  it.skipIf(process.platform !== 'linux')('never opens a lockfile out of the repository: a FIFO out of it with a waiting writer, through a `..` after a folder link', async () => {
    const { dir, repo, folder, env } = setup();
    const fifo = path.join(dir, 'outside', 'fifo');
    fs.mkdirSync(path.join(dir, 'outside', 'inner'), { recursive: true });
    expect(spawnSync('mkfifo', [fifo], { timeout: 10_000 }).status).toBe(0);
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    const lockfile = path.join(repo, '.devcontainer', 'devcontainer-lock.json');
    fs.symlinkSync(path.join(dir, 'outside', 'inner'), path.join(repo, '.devcontainer', 'out'), 'dir');
    fs.symlinkSync('out/../fifo', lockfile);
    // The setup holds: the writer waits, and an open of the link for reading ends its wait.
    const probe = await waitingWriter(fifo);
    fs.closeSync(fs.openSync(lockfile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK));
    expect(await probe.opened()).toBe(true);
    await probe.stop();
    const own = `${folder}/devcontainer.json`;
    for (const withCopy of [false, true]) {
      const writer = await waitingWriter(fifo);
      try {
        const result = writeAndRun(folder, env, withCopy ? { [own]: '{}' } : {}, ['build', '--workspace-folder', repo], {
          repository: repositoryConfig,
          ...(withCopy ? { own } : {}),
        });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('The lockfile .devcontainer/devcontainer-lock.json is not a file of the repository.');
        expect(await writer.opened(), `our copy: ${withCopy}`).toBe(false);
      } finally {
        await writer.stop();
      }
    }
    // Each waiting writer may take up to 3 s where /proc/<pid>/wchan does not name its wait.
  }, 30_000);

  // Mutant W15: fs.copyFileSync(lockfile, copy) in place of fs.writeFileSync(copy, text): the copy is taken by path a
  // second time, after the checks, so a lockfile that a writer of the repository changes into a link out of it (here to
  // the file of the token) right after the checked read is copied through that link. The text that was checked is the
  // text that is written.
  it('writes the text of the lockfile that it checked, not the file that the path names afterwards', () => {
    const { dir, repo, folder, env } = setup();
    const token = path.join(dir, '.devenv+', 'gh', 'hosts.yml');
    write(token, 'github.com:\n  oauth_token: gho_COPY_SECRET\n');
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    const lockfile = path.join(repo, '.devcontainer', 'devcontainer-lock.json');
    write(lockfile, '{"features":{}}');
    const preload = path.join(dir, 'relink.js');
    write(preload, RELINK_AFTER_READ);
    const own = `${folder}/devcontainer.json`;
    const result = writeAndRun(
      folder,
      { ...env, HOOK_FILE: lockfile, HOOK_TO: token },
      { [own]: '{}' },
      ['build', '--workspace-folder', repo],
      { repository: repositoryConfig, own },
      { preload },
    );
    // The hook ran: the lockfile is now the link out of the repository.
    expect(fs.lstatSync(lockfile).isSymbolicLink()).toBe(true);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(`${folder}/devcontainer-lock.json`, 'utf8')).toBe('{"features":{}}');
    expect(fs.readFileSync(token, 'utf8')).toBe('github.com:\n  oauth_token: gho_COPY_SECRET\n');
  });

  // Mutant W17: the chmodSync of the copy dropped (the mode of writeFileSync applies only to a file it creates): a copy
  // that is there already keeps its mode.
  it('gives a copy of the lockfile that is there already mode 0600', () => {
    const { repo, folder, env } = setup();
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    write(path.join(repo, '.devcontainer', 'devcontainer-lock.json'), '{"features":{}}');
    const copy = `${folder}/devcontainer-lock.json`;
    write(copy, 'old');
    fs.chmodSync(copy, 0o644);
    const own = `${folder}/devcontainer.json`;
    const result = writeAndRun(folder, env, { [own]: '{}' }, ['build', '--workspace-folder', repo], { repository: repositoryConfig, own });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"features":{}}');
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
  });

  // Mutant W19: `else` in place of `else if (ownConfig)`: without our copy of the configuration (every build that is not
  // one of Docker Compose), lockfileOf('') names `devcontainer-lock.json` of the working folder, and the lockfile was
  // written there.
  it('writes no copy of the lockfile without our copy of the configuration (not into the working folder either)', () => {
    const { dir, repo, folder, env } = setup();
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(cwd);
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    write(path.join(repo, '.devcontainer', 'devcontainer-lock.json'), '{"features":{}}');
    const result = writeAndRun(folder, env, {}, ['build', '--workspace-folder', repo], { repository: repositoryConfig }, { cwd });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`build\n--workspace-folder\n${repo}\n`);
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(fs.readdirSync(folder)).toEqual(['context']);
  });

  // Mutant W11: `!text` in place of `text === undefined`: an empty lockfile of the repository is a lockfile (the CLI
  // reads it), not a missing one (no --no-lockfile), and its copy is written.
  it('takes an empty lockfile of the repository as a lockfile', () => {
    const { repo, folder, env } = setup();
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    write(path.join(repo, '.devcontainer', 'devcontainer-lock.json'), '');
    const own = `${folder}/devcontainer.json`;
    const result = writeAndRun(folder, env, { [own]: '{}' }, ['build', '--workspace-folder', repo], { repository: repositoryConfig, own });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`build\n--workspace-folder\n${repo}\n`);
    expect(fs.readFileSync(`${folder}/devcontainer-lock.json`, 'utf8')).toBe('');
  });

  // Mutants W3 (the check that the repository folder is absolute and normalized dropped) and W7 (startsWith(root) without
  // the `/`): an empty workspace folder (root + '/' is '/', below which every absolute path is), and a configuration of
  // a sibling folder whose name starts with the name of the repository folder.
  it.each<[string, (repo: string) => { args: string[]; config: string }]>([
    ['with an empty workspace folder', (repo) => ({ args: ['build', '--workspace-folder', ''], config: `${repo}/devcontainer.json` })],
    ['of a sibling folder with the same start', (repo) => ({ args: ['build', '--workspace-folder', repo], config: `${repo}2/devcontainer.json` })],
  ])('refuses a configuration of the repository %s, and does not run the CLI', (_name, input) => {
    const { repo, folder, env } = setup();
    write(path.join(repo, 'devcontainer.json'), '{}');
    write(path.join(`${repo}2`, 'devcontainer.json'), '{}');
    const { args, config } = input(repo);
    const result = writeAndRun(folder, env, {}, args, { repository: config });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid configuration path');
  });
});

describe('CREATE_FOLDERS_SCRIPT, review round 1 of the follow-up of PR #121 (reviewer B)', () => {
  // Mutant R7: realpathSync of JavaScript for the check of a created part. Through the link `a` -> `out/..` (`out` ->
  // `d1/d2`, both in the repository), the system creates `a/new` as `d1/new`; for JavaScript, `a/new` is the missing
  // `new` of the repository folder, and its realpathSync throws (the script fails without a reason).
  it('creates a folder through a link whose `..` follows a folder link of the repository, where the system creates it', () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, 'd1', 'd2'), { recursive: true });
    fs.symlinkSync('d1/d2', path.join(repo, 'out'), 'dir');
    fs.symlinkSync('out/..', path.join(repo, 'a'), 'dir');
    const result = runNode(createFoldersCommand(repo, [`${repo}/a/new`]));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.statSync(path.join(repo, 'd1', 'new')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(repo, 'new'))).toBe(false);
  });
});

describe('MISSING_IN_REPOSITORY, review round 1 of the follow-up of PR #121 (reviewer B)', () => {
  // Mutants D3 (a `.` of the target taken for a name before a `..`) and D6 (the empty name before the `/` of an absolute
  // target taken for a name): a `..` that follows no name resolves as text for the system too (`./..` is `..`, and `/..`
  // is `/`), so such a target in the repository that leads nowhere is a missing Dockerfile of the repository.
  it('takes a link whose `..` follows no name (`./../gone`, `/../<repository>/gone`) for a missing Dockerfile of the repository', () => {
    const repo = tempDir();
    const config = '{ "build": { "dockerfile": "Dockerfile" } }';
    const dev = path.join(repo, '.devcontainer');
    write(path.join(dev, 'devcontainer.json'), config);
    for (const target of ['./../gone', `/..${repo}/gone`]) {
      fs.rmSync(path.join(dev, 'Dockerfile'), { force: true });
      fs.symlinkSync(target, path.join(dev, 'Dockerfile'));
      const result = runNode(readFilesCommand(repo, '.devcontainer/devcontainer.json'));
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout), target).toEqual({ configText: config, dockerfilePath: '.devcontainer/Dockerfile', dockerfileMissing: true });
    }
  });
});
