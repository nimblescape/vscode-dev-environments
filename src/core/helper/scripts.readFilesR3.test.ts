// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of PR #121 (reviewer B, mutation testing): probes of readInRepository (READ_FILES_SCRIPT) for the
// mutants that scripts.test.ts, scripts.readFilesR1.test.ts, and scripts.readFilesR2.test.ts leave alive on ad23021 (the
// real path of the opened descriptor, B-R2-1).

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFilesCommand } from './scripts';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
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

const has = (command: string, args: string[]): boolean => !spawnSync(command, args, { stdio: 'ignore', timeout: 10_000 }).error;
const isRoot = process.getuid?.() === 0;
const isLinux = process.platform === 'linux';

/** Runs the command of readFilesCommand. `preload`: a module that node loads first (-r); `prefix`: a command that runs node. */
function runScript(command: string[], options: { preload?: string; env?: NodeJS.ProcessEnv; prefix?: string[] } = {}): { status: number | null; stdout: string; stderr: string } {
  expect(command[0]).toBe('node');
  const args = [...(options.preload !== undefined ? ['-r', options.preload] : []), ...command.slice(1)];
  const [file, ...rest] = [...(options.prefix ?? []), process.execPath, ...args];
  const result = spawnSync(file, rest, { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...options.env } });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const BUILD_CONFIG = '{ "build": { "dockerfile": "Dockerfile" } }';
const REFUSED = 'The configuration file is not a file of the repository.';

/** A repository with `b/devcontainer.json` (BUILD_CONFIG) and `b/Dockerfile`, below a fresh folder `root`. */
function repository(): { root: string; repo: string } {
  const root = fs.realpathSync.native(tempDir());
  const repo = path.join(root, 'repo');
  write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
  write(path.join(repo, 'b', 'Dockerfile'), 'FROM alpine\n');
  return { root, repo };
}

function preloadFile(root: string, text: string): string {
  const file = path.join(root, 'hook.js');
  fs.writeFileSync(file, text);
  return file;
}

const READ = { configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile', dockerfileText: 'FROM alpine\n' };

describe('READ_FILES_SCRIPT, review round 3 of PR #121 (reviewer B)', () => {
  // Mutant M23: realInRepository compares with the repository folder as given (rootReal = root), not with its real path.
  // The real path of a file of the repository is below the real folder, so every file of a repository folder that is
  // reached through a link was refused.
  it('reads the files of a repository whose folder is reached through a link, and still refuses a link out of it', () => {
    const root = fs.realpathSync.native(tempDir());
    const real = path.join(root, 'real');
    write(path.join(real, 'b', 'devcontainer.json'), BUILD_CONFIG);
    write(path.join(real, 'b', 'Dockerfile'), 'FROM alpine\n');
    write(path.join(root, 'secret'), '{ "image": "LINKED_ROOT_SECRET" }');
    fs.mkdirSync(path.join(real, 'a'));
    fs.symlinkSync(path.join(root, 'secret'), path.join(real, 'a', 'devcontainer.json'));
    const repo = path.join(root, 'repo');
    fs.symlinkSync(real, repo, 'dir');
    const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(READ);
    const out = runScript(readFilesCommand(repo, 'a/devcontainer.json'));
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(REFUSED);
    expect(`${out.stdout}${out.stderr}`).not.toContain('LINKED_ROOT_SECRET');
  });

  // Mutants M18 (statSync(real) -> lstatSync(real)) and S1 (a failed stat of the real path throws, not null). A writer of
  // the repository changes the file between the real path of the descriptor and its stat: HOOK_MODE=link moves it to
  // `<name>.moved` and puts a link of the repository to it in its place (stat names the opened file: read; lstat names
  // the link: refused), HOOK_MODE=gone moves it away (review round 2 of PR #121, A-1: refused, never a failure of the
  // script).
  const STAT_HOOK = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { HOOK_FILE, HOOK_MODE } = process.env;
let done = false;
const native = fs.realpathSync.native;
fs.realpathSync.native = function (file, ...rest) {
  const result = native.call(this, file, ...rest);
  if (!done && String(file).startsWith('/proc/self/fd/') && result === HOOK_FILE) {
    done = true;
    fs.renameSync(HOOK_FILE, HOOK_FILE + '.moved');
    if (HOOK_MODE === 'link') fs.symlinkSync(path.basename(HOOK_FILE) + '.moved', HOOK_FILE);
  }
  return result;
};
`;
  describe.each(['b/devcontainer.json', 'b/Dockerfile'])('a file of the repository changed between the real path of its descriptor and the stat: %s', (file) => {
    it.skipIf(!isLinux)('reads it when a link of the repository to the opened file takes its place (M18)', () => {
      const { root, repo } = repository();
      const env = { HOOK_FILE: path.join(repo, file), HOOK_MODE: 'link' };
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload: preloadFile(root, STAT_HOOK) });
      // The hook ran.
      expect(fs.lstatSync(path.join(repo, file)).isSymbolicLink()).toBe(true);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(READ);
    });

    it.skipIf(!isLinux)('refuses it, without a failure of the script, when it is gone (S1)', () => {
      const { root, repo } = repository();
      const env = { HOOK_FILE: path.join(repo, file), HOOK_MODE: 'gone' };
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload: preloadFile(root, STAT_HOOK) });
      expect(fs.existsSync(path.join(repo, `${file}.moved`))).toBe(true);
      expect(fs.existsSync(path.join(repo, file))).toBe(false);
      if (file === 'b/devcontainer.json') {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(REFUSED);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' });
      }
    });
  });

  // Mutants D6 (the existsSync guard dropped: always /proc/self/fd/<fd>) and D7 (the fallback without /proc/self/fd
  // refuses every file). Review round 3 of PR #121 (A-R3-3) changed the expectation: on Linux without /proc/self/fd
  // (here: a preload that hides it) the real path of the file is unknown, and the file is refused (was: read after a
  // check of the real path of the file, which a writer of the repository can race, B-R2-1); a link out stays refused.
  const NO_PROC_HOOK = String.raw`'use strict';
const fs = require('fs');
const existsSync = fs.existsSync;
fs.existsSync = function (file, ...rest) {
  return String(file) === '/proc/self/fd' ? false : existsSync.call(this, file, ...rest);
};
const native = fs.realpathSync.native;
fs.realpathSync.native = function (file, ...rest) {
  if (String(file).startsWith('/proc/self/fd')) {
    const error = new Error('ENOENT: no such file or directory, realpath ' + file);
    error.code = 'ENOENT';
    throw error;
  }
  return native.call(this, file, ...rest);
};
`;
  it.skipIf(process.platform !== 'linux')('without /proc/self/fd, refuses a file of the repository and a link out (D6, D7; A-R3-3)', () => {
    const { root, repo } = repository();
    const preload = preloadFile(root, NO_PROC_HOOK);
    const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { preload });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(REFUSED);
    write(path.join(root, 'secret'), '{ "image": "NO_PROC_SECRET" }');
    fs.mkdirSync(path.join(repo, 'a'));
    fs.symlinkSync(path.join(root, 'secret'), path.join(repo, 'a', 'devcontainer.json'));
    const out = runScript(readFilesCommand(repo, 'a/devcontainer.json'), { preload });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(REFUSED);
    expect(`${out.stdout}${out.stderr}`).not.toContain('NO_PROC_SECRET');
  });

  // Mutant M58: an open error of no known kind (here EMFILE: the process has no free descriptor) taken for a file that is
  // not a file of the repository (null). It is no property of the file: the script fails with the error, so the step
  // reports it, and a Dockerfile of the repository is never taken for one that may not be read.
  const EMFILE_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_FILE } = process.env;
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  if (file !== HOOK_FILE) return openSync.call(this, file, ...rest);
  const fillers = [];
  try {
    for (;;) fillers.push(openSync.call(fs, '/dev/null', 'r'));
  } catch (error) {
    if (error.code !== 'EMFILE') throw error;
  }
  try {
    return openSync.call(this, file, ...rest);
  } finally {
    for (const fd of fillers) fs.closeSync(fd);
  }
};
`;
  it.each(['b/devcontainer.json', 'b/Dockerfile'])('fails with an open error of no known kind (EMFILE) of %s (M58)', (file) => {
    const { root, repo } = repository();
    const env = { HOOK_FILE: path.join(repo, file) };
    const prefix = ['sh', '-c', 'ulimit -n 256 && exec "$0" "$@"'];
    const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload: preloadFile(root, EMFILE_HOOK), prefix });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EMFILE');
    expect(result.stderr).not.toContain(REFUSED);
    expect(result.stdout).toBe('');
  });

  // Mutant M65: the descriptor of readInRepository not closed. At the exit of the script, no descriptor of a file of the
  // repository is open: neither one that was read nor one that was refused after the open (a FIFO of the repository).
  const OPEN_FDS_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_REPO, HOOK_OUT } = process.env;
process.on('exit', () => {
  const open = [];
  for (const name of fs.readdirSync('/proc/self/fd')) {
    try {
      const target = fs.readlinkSync('/proc/self/fd/' + name);
      if (target.startsWith(HOOK_REPO + '/')) open.push(target);
    } catch {
      // The descriptor of readdirSync.
    }
  }
  fs.writeFileSync(HOOK_OUT, JSON.stringify(open));
});
`;
  it.skipIf(!isLinux || !has('mkfifo', ['--version']))('closes the descriptor of each file that it opened (M65)', () => {
    const { root, repo } = repository();
    write(path.join(repo, 'c', 'devcontainer.json'), BUILD_CONFIG);
    expect(spawnSync('mkfifo', [path.join(repo, 'c', 'Dockerfile')], { timeout: 10_000 }).status).toBe(0);
    const preload = preloadFile(root, OPEN_FDS_HOOK);
    const out = path.join(root, 'open.json');
    const env = { HOOK_REPO: repo, HOOK_OUT: out };
    const read = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload });
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual(READ);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual([]);
    fs.rmSync(out);
    const fifo = runScript(readFilesCommand(repo, 'c/devcontainer.json'), { env, preload });
    expect(fifo.status, fifo.stderr).toBe(0);
    expect(JSON.parse(fifo.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'c/Dockerfile' });
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual([]);
  });

  // Mutant M31: the open of readInRepository without O_NOCTTY. A terminal device of the repository (a root process of a
  // dev container may create one: Docker gives it CAP_MKNOD) that a script without a controlling terminal opens becomes
  // its controlling terminal (a hangup of that terminal then ends the step). Refused either way (no plain file); the
  // probe reads the controlling terminal of the script right after the open (field tty_nr of /proc/self/stat). A pseudo
  // terminal slave of mknod out of devpts cannot be opened (EIO), and the device cgroup of a default Docker container
  // denies a virtual console: the probe takes tty1 (4, 1) and runs only where its open makes it the controlling
  // terminal (root, no device cgroup, a kernel with virtual consoles). The script runs as the leader of a new session
  // (setsid -w).
  const CTTY_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_FILE, HOOK_OUT } = process.env;
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  const fd = openSync.call(this, file, ...rest);
  if (file === HOOK_FILE) {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    fs.appendFileSync(HOOK_OUT, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[4] + '\n');
  }
  return fd;
};
`;
  it.skipIf(!isRoot || !isLinux || !has('setsid', ['--version']))('never takes a terminal device of the repository for its controlling terminal (M31)', (context) => {
    const { root, repo } = repository();
    fs.mkdirSync(path.join(repo, 'a'));
    fs.rmSync(path.join(repo, 'b', 'Dockerfile'));
    // Review round 4 of PR #121 (A, L1): skipped, not failed, where mknod is refused (root without CAP_MKNOD).
    for (const file of ['a/devcontainer.json', 'b/Dockerfile']) {
      if (spawnSync('mknod', [path.join(repo, file), 'c', '4', '1'], { timeout: 10_000 }).status !== 0) context.skip();
    }
    const prefix = ['setsid', '-w'];
    // Whether the setup holds here: an open without O_NOCTTY makes the terminal the controlling terminal of the script.
    const probe = runScript(['node', '-e', "const fs = require('fs'); try { fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); } catch { process.exit(); } const stat = fs.readFileSync('/proc/self/stat', 'utf8'); process.stdout.write(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[4]);", path.join(repo, 'b', 'Dockerfile')], { prefix });
    if (probe.stdout === '' || probe.stdout === '0') context.skip();
    const out = path.join(root, 'tty.txt');
    for (const [file, config] of [['a/devcontainer.json', 'a/devcontainer.json'], ['b/Dockerfile', 'b/devcontainer.json']]) {
      fs.rmSync(out, { force: true });
      const result = runScript(readFilesCommand(repo, config), { env: { HOOK_FILE: path.join(repo, file), HOOK_OUT: out }, preload: preloadFile(root, CTTY_HOOK), prefix });
      if (config === 'a/devcontainer.json') {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(REFUSED);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' });
      }
      expect(fs.readFileSync(out, 'utf8'), file).toBe('0\n');
    }
  });
});
