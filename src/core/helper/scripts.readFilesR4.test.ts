// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 4 of PR #121 (reviewer B, mutation testing): probes of readInRepository (READ_FILES_SCRIPT) for the
// mutants that scripts.test.ts and scripts.readFilesR1.test.ts to scripts.readFilesR3.test.ts leave alive on 3ea973e
// (the path resolved once with O_PATH, the file reopened through /proc/self/fd of that handle).

import { spawn, spawnSync } from 'child_process';
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

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const has = (command: string, args: string[]): boolean => !spawnSync(command, args, { stdio: 'ignore', timeout: 10_000 }).error;
const isLinux = process.platform === 'linux';

/** Runs the command of readFilesCommand. `preload`: a module that node loads first (-r). */
function runScript(command: string[], options: { preload?: string; env?: NodeJS.ProcessEnv } = {}): { status: number | null; stdout: string; stderr: string; error?: Error } {
  expect(command[0]).toBe('node');
  const args = [...(options.preload !== undefined ? ['-r', options.preload] : []), ...command.slice(1)];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...options.env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error };
}

const BUILD_CONFIG = '{ "build": { "dockerfile": "Dockerfile" } }';
const REFUSED = 'The configuration file is not a file of the repository.';
const READ = { configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile', dockerfileText: 'FROM alpine\n' };
const NOT_READ = { configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' };

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

/** The result of the script for `file` of the repository when it is refused (configuration) or not read (Dockerfile). */
function expectRefusedOrNotRead(file: string, result: ReturnType<typeof runScript>): void {
  expect(result.error).toBeUndefined();
  if (file === 'b/devcontainer.json') {
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(REFUSED);
  } else {
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(NOT_READ);
  }
}

/**
 * A process that waits in its open of the FIFO `fifo` for writing until a reader opens it (wchan wait_for_partner, which
 * any open for reading ends, also one with O_NONBLOCK). `opened`: whether its open returned (within 500 ms).
 */
async function waitingWriter(fifo: string): Promise<{ opened: () => Promise<boolean> }> {
  const child = spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1], 'w')", fifo], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  stops.push(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  let waiting = false;
  for (const deadline = Date.now() + 5000; Date.now() < deadline && !waiting; ) {
    try {
      waiting = fs.readFileSync(`/proc/${child.pid}/wchan`, 'utf8') === 'wait_for_partner';
    } catch {
      // Not yet started.
    }
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(waiting).toBe(true);
  return { opened: () => Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]) };
}

describe('READ_FILES_SCRIPT, review round 4 of PR #121 (reviewer B)', () => {
  // Mutants N1 (`!found.isFile()` dropped from the check of the O_PATH handle) and N3 (isFile -> !isDirectory). A FIFO
  // (or a device) of the repository then passes the checks of its real path and dev/ino, and is opened (reopened through /proc/self/fd) before the fstat of the
  // second descriptor refuses it: an open of a file that is not a plain file, which the decision of the user of
  // 2026-10-07 rules out (a device open can act, a FIFO open ends the wait of its writer). The output is the same either
  // way; the writer that waits in its open of the FIFO shows the open.
  describe.each(['b/devcontainer.json', 'b/Dockerfile'])('a FIFO of the repository with a waiting writer: %s', (file) => {
    it.skipIf(!isLinux || !has('mkfifo', ['--version']))('is refused without an open of it (N1, N3)', async () => {
      const { repo } = repository();
      fs.rmSync(path.join(repo, file));
      expect(spawnSync('mkfifo', [path.join(repo, file)], { timeout: 10_000 }).status).toBe(0);
      const writer = await waitingWriter(path.join(repo, file));
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'));
      expectRefusedOrNotRead(file, result);
      expect(await writer.opened()).toBe(false);
    }, 20_000);
  });

  // Mutants P1 (the file reopened by its path, not through /proc/self/fd of the handle) and P2 (reopened by its real
  // path): a second walk of the path after the checks. A writer of the repository that makes the file a link to a FIFO
  // out of the repository right after the checks of the handle, before the second open (the hook), gets that FIFO opened
  // (its waiting writer goes on), and the file of the handle is not read. Through the handle, the file that was checked
  // is the file that is opened and read.
  const REOPEN_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_FILE, HOOK_TO } = process.env;
let state = 'wait';
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  if (state === 'opened') {
    state = 'done';
    fs.renameSync(HOOK_FILE, HOOK_FILE + '.before');
    fs.symlinkSync(HOOK_TO, HOOK_FILE);
  }
  const fd = openSync.call(this, file, ...rest);
  if (state === 'wait' && file === HOOK_FILE) state = 'opened';
  return fd;
};
`;
  describe.each(['b/devcontainer.json', 'b/Dockerfile'])('a file of the repository that becomes a link to a FIFO out of it before its second open: %s', (file) => {
    it.skipIf(!isLinux || !has('mkfifo', ['--version']))('is read as checked, and the FIFO is never opened (P1, P2)', async () => {
      const { root, repo } = repository();
      const fifo = path.join(root, 'out', 'fifo');
      fs.mkdirSync(path.dirname(fifo));
      expect(spawnSync('mkfifo', [fifo], { timeout: 10_000 }).status).toBe(0);
      const writer = await waitingWriter(fifo);
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { preload: preloadFile(root, REOPEN_HOOK), env: { HOOK_FILE: path.join(repo, file), HOOK_TO: fifo } });
      // The hook ran.
      expect(fs.readlinkSync(path.join(repo, file))).toBe(fifo);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(READ);
      expect(await writer.opened()).toBe(false);
    }, 20_000);
  });

  // Mutants P3 (the second open without O_NONBLOCK), G1 (READ_FLAGS without O_NONBLOCK), and L7 (EAGAIN not refused;
  // review round 3, A-R3-2). A process of the repository owner holds a write lease (F_SETLEASE, F_WRLCK) on a file of the
  // repository: an open of it that may wait waits until the holder gives the lease up or the kernel breaks it
  // (/proc/sys/fs/lease-break-time, 45 s by default), which holds the step; with O_NONBLOCK it fails with EAGAIN at once,
  // and the file is refused (configuration) or not read (Dockerfile), never a failure of the script. The open with O_PATH
  // breaks no lease. Python sets the lease (node cannot), and ignores the SIGIO of the lease break.
  const LEASE = String.raw`import fcntl, os, signal, sys, time
signal.signal(signal.SIGIO, signal.SIG_IGN)
fd = os.open(sys.argv[1], os.O_RDONLY)
fcntl.fcntl(fd, 1024, fcntl.F_WRLCK)  # F_SETLEASE
print('held', flush=True)
time.sleep(60)
`;
  const leases = (() => {
    try {
      return isLinux && has('python3', ['--version']) && fs.readFileSync('/proc/sys/fs/leases-enable', 'utf8').trim() === '1';
    } catch {
      return false;
    }
  })();
  async function lease(file: string): Promise<boolean> {
    const child = spawn('python3', ['-c', LEASE, file], { stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    stops.push(async () => {
      child.kill('SIGKILL');
      await exited;
    });
    return Promise.race([
      new Promise<boolean>((resolve) => child.stdout.once('data', () => resolve(true))),
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
  }
  describe.each(['b/devcontainer.json', 'b/Dockerfile'])('a file of the repository under a write lease: %s', (file) => {
    it.skipIf(!leases)('is refused at once, without a wait or a failure of the script (P3, G1, L7)', async (context) => {
      const { repo } = repository();
      // Where a lease cannot be set (a file system without leases), the test is skipped, not failed.
      if (!(await lease(path.join(repo, file)))) context.skip();
      const started = Date.now();
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'));
      expectRefusedOrNotRead(file, result);
      expect(Date.now() - started).toBeLessThan(9000);
    }, 30_000);
  });
  // Mutant F6: the folder rule compares the real path of the handle with the repository folder as given (root), not with
  // its real path. In a repository whose folder is reached through a link, a configuration path that links to the
  // repository folder itself was refused, not taken for a configuration that does not exist (review round 2, A-2).
  it('takes a configuration path that links to the repository folder for a missing configuration, also when the repository folder is reached through a link (F6)', () => {
    const root = fs.realpathSync.native(tempDir());
    const real = path.join(root, 'real');
    fs.mkdirSync(path.join(real, 'x'), { recursive: true });
    fs.symlinkSync('..', path.join(real, 'x', 'root.json'));
    const repo = path.join(root, 'repo');
    fs.symlinkSync(real, repo, 'dir');
    const result = runScript(readFilesCommand(repo, 'x/root.json'));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBeNull();
  });

  // Mutant P6: an error of no known kind of the second open (through /proc/self/fd; here EMFILE: the process has no free
  // descriptor) taken for a file that is not a file of the repository (null), as M58 of the first open (review round 3).
  // It is no property of the file: the script fails with the error, and a Dockerfile of the repository is never taken for
  // one that may not be read.
  const EMFILE_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_FILE } = process.env;
let opened = false;
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  if (file === HOOK_FILE) opened = true;
  if (!opened || !String(file).startsWith('/proc/self/fd/')) return openSync.call(this, file, ...rest);
  opened = false;
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
  it.skipIf(!isLinux).each(['b/devcontainer.json', 'b/Dockerfile'])('fails with an error of no known kind (EMFILE) of the second open of %s (P6)', (file) => {
    const { root, repo } = repository();
    const preload = preloadFile(root, EMFILE_HOOK);
    const args = ['-c', 'ulimit -n 256 && exec "$0" "$@"', process.execPath, '-r', preload, ...readFilesCommand(repo, 'b/devcontainer.json').slice(1)];
    const result = spawnSync('sh', args, { encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOOK_FILE: path.join(repo, file) } });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EMFILE');
    expect(result.stderr).not.toContain(REFUSED);
    expect(result.stdout).toBe('');
  });
});
