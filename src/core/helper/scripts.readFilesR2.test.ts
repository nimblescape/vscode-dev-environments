// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #121 (reviewer B, mutation testing): probes of readInRepository (READ_FILES_SCRIPT) for the
// mutants that scripts.test.ts and scripts.readFilesR1.test.ts leave alive, and the race of B-R2-1.

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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const hasSetpriv = !spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).error;
const isRoot = process.getuid?.() === 0;

/**
 * Runs the command of readFilesCommand. `preload`: a module that node loads first (-r); `prefix`: a command that runs
 * node (setpriv).
 */
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

/** The configuration `configPath` is refused, and the script prints nothing of it. */
function expectRefused(repo: string, configPath: string, options: Parameters<typeof runScript>[1] = {}): void {
  const result = runScript(readFilesCommand(repo, configPath), options);
  expect(result.status, configPath).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(REFUSED);
}

/** The Dockerfile of the configuration `configPath` (BUILD_CONFIG) is not read, and the script ends well. */
function expectNotRead(repo: string, configPath: string, options: Parameters<typeof runScript>[1] = {}, dockerfile?: string): void {
  const result = runScript(readFilesCommand(repo, configPath, dockerfile), options);
  expect(result.status, result.stderr).toBe(0);
  const folder = path.posix.dirname(configPath);
  expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: `${folder}/${dockerfile ?? 'Dockerfile'}` });
}

/**
 * A process that waits in its open of the FIFO `fifo` for writing until a reader opens it (wchan wait_for_partner, which
 * any open for reading ends, also one with O_NONBLOCK). `opened`: whether its open returned (within 500 ms).
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
 * HOOK_FILE (a plain file of the repository) becomes a link to HOOK_TO (a file out of the repository) at one point: right
 * before the script opens it (HOOK_AT=open: after the check of its real path before the open), or, once the script opened
 * it, right before its next open or read (HOOK_AT=read: after the checks of the opened file).
 */
const HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_AT, HOOK_FILE, HOOK_TO } = process.env;
let opened = false;
let done = false;
const relink = () => {
  done = true;
  fs.renameSync(HOOK_FILE, HOOK_FILE + '.before');
  fs.symlinkSync(HOOK_TO, HOOK_FILE);
};
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  if (!done && (HOOK_AT === 'open' ? file === HOOK_FILE : opened)) relink();
  const fd = openSync.call(this, file, ...rest);
  if (file === HOOK_FILE) opened = true;
  return fd;
};
const readSync = fs.readSync;
fs.readSync = function (...args) {
  if (!done && HOOK_AT === 'read' && opened) relink();
  return readSync.apply(this, args);
};
`;

describe('READ_FILES_SCRIPT, review round 2 of PR #121 (reviewer B)', () => {
  // Mutants: the check before the open removed, moved after the open, or with realpathSync of JavaScript (round 1, A: a
  // `..` after a folder link is text for it). The check before the open is the only one that keeps a file out of the
  // repository from being opened at all (the check of the opened file still refuses it), so its loss shows only in the
  // open itself: a writer that waits on a FIFO out of the repository gets a reader.
  it.skipIf(process.platform !== 'linux')('never opens a file out of the repository: a FIFO out of it with a waiting writer, through a link or a `..` after a folder link', async () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    const fifo = path.join(root, 'out', 'fifo');
    fs.mkdirSync(path.join(root, 'out', 'inner'), { recursive: true });
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    fs.mkdirSync(path.join(repo, 'a'), { recursive: true });
    fs.symlinkSync(path.join(root, 'out', 'inner'), path.join(repo, 'sub'), 'dir');
    write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
    // `../sub/../fifo`: for realpathSync of JavaScript, the missing `fifo` of the repository (no real path, no check).
    for (const target of [fifo, '../sub/../fifo']) {
      for (const file of ['a/devcontainer.json', 'b/Dockerfile']) {
        fs.rmSync(path.join(repo, file), { force: true });
        fs.symlinkSync(target, path.join(repo, file));
      }
      // The setup holds: the writer waits, and an open of the link for reading ends its wait.
      // Review round 3 of PR #121 (A-R3-5): the probe's writer ends also when the setup fails.
      const probe = await waitingWriter(fifo);
      try {
        fs.closeSync(fs.openSync(path.join(repo, 'a', 'devcontainer.json'), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK));
        expect(await probe.opened(), target).toBe(true);
      } finally {
        await probe.stop();
      }
      const writer = await waitingWriter(fifo);
      try {
        expectRefused(repo, 'a/devcontainer.json');
        expectNotRead(repo, 'b/devcontainer.json');
        expect(await writer.opened(), target).toBe(false);
      } finally {
        await writer.stop();
      }
    }
    // Each waiting writer may take up to 3 s where /proc/<pid>/wchan does not name its wait.
  }, 30_000);

  // Mutants: realpathSync of JavaScript in the check of the opened file (or in both checks). The file of the repository
  // that the kernel reaches through `sub/..` (a folder link of the repository) is read, as Docker reads it.
  it('reads a file of the repository through a `..` after a folder link of the repository, as the kernel resolves it', () => {
    const repo = tempDir();
    write(path.join(repo, 'deep', 'config.json'), BUILD_CONFIG);
    write(path.join(repo, 'deep', 'Dockerfile'), 'FROM alpine\n');
    fs.mkdirSync(path.join(repo, 'deep', 'inner'));
    fs.symlinkSync('deep/inner', path.join(repo, 'sub'), 'dir');
    fs.mkdirSync(path.join(repo, '.devcontainer'));
    fs.symlinkSync('../sub/../config.json', path.join(repo, '.devcontainer', 'devcontainer.json'));
    fs.symlinkSync('../sub/../Dockerfile', path.join(repo, '.devcontainer', 'Dockerfile'));
    const result = runScript(readFilesCommand(repo, '.devcontainer/devcontainer.json'));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: '.devcontainer/Dockerfile', dockerfileText: 'FROM alpine\n' });
  });

  // Mutants: the folder check before the check of the real path (a link out of the repository to a folder taken for a
  // configuration that does not exist). It is a link out of the repository: refused, as a link out to a file.
  it('refuses a configuration path that links to a folder out of the repository', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(root, 'out', 'folder'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.devcontainer'), { recursive: true });
    fs.symlinkSync(path.join(root, 'out', 'folder'), path.join(repo, '.devcontainer', 'devcontainer.json'), 'dir');
    expectRefused(repo, '.devcontainer/devcontainer.json');
  });

  // Mutants: in the check of the opened file, only `real === null` (not below the repository folder), or the real path of
  // the check before the open (real = before); and the read by path (readLimited(file) or readLimited(real)) in place of
  // the read of the opened file. A plain file of the repository that becomes a link out of it between the check and the
  // open is opened out of the repository and refused; one that becomes a link out after the check of the opened file is
  // read from the file that was opened.
  describe.each(['open', 'read'] as const)('a file of the repository that becomes a link out of it at the %s', (at) => {
    function setup(file: string): { repo: string; env: NodeJS.ProcessEnv; preload: string } {
      const root = tempDir();
      const repo = path.join(root, 'repo');
      const secret = path.join(root, '.devenv+', 'gh', 'hosts.yml');
      write(secret, 'github.com:\n  oauth_token: gho_RACE_SECRET\n');
      write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
      write(path.join(repo, 'b', 'Dockerfile'), 'FROM alpine\n');
      const preload = path.join(root, 'hook.js');
      fs.writeFileSync(preload, HOOK);
      return { repo, preload, env: { HOOK_AT: at, HOOK_FILE: path.join(repo, file), HOOK_TO: secret } };
    }

    it('as the configuration', () => {
      const { repo, env, preload } = setup('b/devcontainer.json');
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload });
      expect(`${result.stdout}${result.stderr}`).not.toContain('gho_RACE_SECRET');
      // The hook ran.
      expect(fs.lstatSync(path.join(repo, 'b', 'devcontainer.json')).isSymbolicLink()).toBe(true);
      if (at === 'open') {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(REFUSED);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile', dockerfileText: 'FROM alpine\n' });
      }
    });

    it('as the Dockerfile', () => {
      const { repo, env, preload } = setup('b/Dockerfile');
      const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { env, preload });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('gho_RACE_SECRET');
      expect(fs.lstatSync(path.join(repo, 'b', 'Dockerfile')).isSymbolicLink()).toBe(true);
      const expected = at === 'open' ? {} : { dockerfileText: 'FROM alpine\n' };
      expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile', ...expected });
    });
  });

  // Mutants: ENAMETOOLONG dropped (the script fails) or taken for a missing file. Round 1 (A-1): a file that cannot be
  // opened is refused (the configuration) or not read (the Dockerfile), never a failure of the script.
  it('refuses a file whose name is too long (ENAMETOOLONG) and reads none as the Dockerfile', () => {
    const repo = tempDir();
    const long = 'x'.repeat(300);
    fs.mkdirSync(path.join(repo, 'a'), { recursive: true });
    fs.symlinkSync(long, path.join(repo, 'a', 'devcontainer.json'));
    write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
    fs.symlinkSync(long, path.join(repo, 'b', 'Dockerfile'));
    expectRefused(repo, 'a/devcontainer.json');
    expectNotRead(repo, 'b/devcontainer.json');
    // The Dockerfile as the resolved configuration names it.
    expectNotRead(repo, 'b/devcontainer.json', {}, long);
  });

  // Mutants: EACCES dropped (the script fails) or taken for a missing file. The batch helper runs the step as the owner of
  // the repository (privilegeArgs of batchHelper.ts), who may not read each file of it (one of root, mode 0600). Root has
  // the capabilities that bypass the file permissions: as root, the script runs without them, as the batch helper runs it.
  const permissions = !isRoot ? [] : hasSetpriv ? ['setpriv', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--'] : undefined;
  it.skipIf(permissions === undefined || process.platform === 'win32')('refuses a file that the owner may not read (EACCES) and reads none as the Dockerfile', () => {
    const repo = tempDir();
    write(path.join(repo, 'a', 'devcontainer.json'), '{ "image": "alpine" }');
    write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
    write(path.join(repo, 'b', 'Dockerfile'), 'FROM alpine\n');
    fs.chmodSync(path.join(repo, 'a', 'devcontainer.json'), 0);
    fs.chmodSync(path.join(repo, 'b', 'Dockerfile'), 0);
    // The setup holds: the open fails with EACCES.
    const probe = runScript(['node', '-e', "try { require('fs').openSync(process.argv[1], 'r'); } catch (error) { process.stdout.write(error.code); }", path.join(repo, 'b', 'Dockerfile')], { prefix: permissions });
    expect(probe.stdout).toBe('EACCES');
    expectRefused(repo, 'a/devcontainer.json', { prefix: permissions });
    expectNotRead(repo, 'b/devcontainer.json', { prefix: permissions });
  });

  // Mutants: EPERM or ENODEV dropped (the script fails) or taken for a missing file. A device file in the repository (a
  // root process of a dev container may create one: Docker gives it CAP_MKNOD) that the step may not open (EPERM: the
  // device cgroup of the helper; here /dev/kmsg without CAP_SYSLOG and with dmesg_restrict) or whose device does not
  // exist (ENODEV: a misc device of no driver). Root only (mknod); never read either way (no plain file).
  const kmsgRestricted = (() => {
    try {
      return fs.readFileSync('/proc/sys/kernel/dmesg_restrict', 'utf8').trim() === '1';
    } catch {
      return false;
    }
  })();
  const devices = isRoot && hasSetpriv && process.platform === 'linux';
  for (const [code, device, available] of [
    ['EPERM', ['1', '11'], devices && kmsgRestricted],
    ['ENODEV', ['10', '251'], devices],
  ] as const) {
    it.skipIf(!available)(`refuses a device file that cannot be opened (${code}) and reads none as the Dockerfile`, (context) => {
      const prefix = ['setpriv', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--'];
      const repo = tempDir();
      fs.mkdirSync(path.join(repo, 'a'), { recursive: true });
      write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
      // Review round 3 of PR #121 (A-R3-4): where the setup does not hold (mknod refused, or the device rules of a
      // container give another error), the test is skipped, not failed.
      for (const file of ['a/devcontainer.json', 'b/Dockerfile']) {
        if (spawnSync('mknod', [path.join(repo, file), 'c', ...device]).status !== 0) context.skip();
      }
      const probe = runScript(['node', '-e', "const fs = require('fs'); try { fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY); } catch (error) { process.stdout.write(error.code); }", path.join(repo, 'b', 'Dockerfile')], { prefix });
      if (probe.stdout !== code) context.skip();
      expectRefused(repo, 'a/devcontainer.json', { prefix });
      expectNotRead(repo, 'b/devcontainer.json', { prefix });
    });
  }

  // B-R2-1: the check of the opened file took the real path of `file` (realpath) and then the stat of that path: two more
  // walks of the path. A writer of the repository that changed links between them (before the open: the link leads out;
  // after the open: back to a decoy of the repository; after the realpath: the decoy leads out) made the stat name the
  // opened file out of the repository, and the secret was read. The check now takes the real path of the descriptor.
  const RACE_HOOK = String.raw`'use strict';
const fs = require('fs');
const { HOOK_LINK, HOOK_SECRET, HOOK_DECOY } = process.env;
const relink = (file, target) => { fs.unlinkSync(file); fs.symlinkSync(target, file); };
let stage = 0;
const openSync = fs.openSync;
fs.openSync = function (file, ...rest) {
  if (file !== HOOK_LINK || stage !== 0) return openSync.call(this, file, ...rest);
  stage = 1;
  relink(HOOK_LINK, HOOK_SECRET);
  const fd = openSync.call(this, file, ...rest);
  relink(HOOK_LINK, HOOK_DECOY);
  return fd;
};
const native = fs.realpathSync.native;
fs.realpathSync.native = function (file, ...rest) {
  const result = native.call(this, file, ...rest);
  if (stage === 1 && (file === HOOK_LINK || String(file).startsWith('/proc/self/fd/'))) {
    stage = 2;
    relink(HOOK_DECOY, HOOK_SECRET);
  }
  return result;
};
`;
  it.skipIf(process.platform !== 'linux')('never reads a file out of the repository when links change between the open and the checks of the opened file (B-R2-1)', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    const secret = path.join(root, '.devenv+', 'gh', 'hosts.yml');
    write(secret, 'github.com:\n  oauth_token: gho_TOCTOU_SECRET\n');
    write(path.join(repo, 'decoy.json'), '{ "image": "decoy" }');
    fs.mkdirSync(path.join(repo, '.devcontainer'), { recursive: true });
    fs.symlinkSync('../decoy.json', path.join(repo, '.devcontainer', 'devcontainer.json'));
    const preload = path.join(root, 'race.js');
    fs.writeFileSync(preload, RACE_HOOK);
    const env = { HOOK_LINK: path.join(repo, '.devcontainer', 'devcontainer.json'), HOOK_SECRET: secret, HOOK_DECOY: path.join(repo, 'decoy.json') };
    const result = runScript(readFilesCommand(repo, '.devcontainer/devcontainer.json'), { env, preload });
    expect(`${result.stdout}${result.stderr}`).not.toContain('gho_TOCTOU_SECRET');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(REFUSED);
    // The hook ran all three changes.
    expect(fs.readlinkSync(path.join(repo, 'decoy.json'))).toBe(secret);
  });

  // Review round 3 of PR #121 (A-R3-1): a writer of the repository that makes a file a link to a FIFO out of the
  // repository right after any check and right before the open (the hook, HOOK_AT=open) does not get it opened: the path
  // is resolved with O_PATH, which opens nothing, and the file is opened only once it is a plain file of the repository.
  it.skipIf(process.platform !== 'linux')('opens no FIFO out of the repository that a link becomes right before the open (A-R3-1)', async () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    const fifo = path.join(root, 'out', 'fifo');
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
    write(path.join(repo, 'b', 'Dockerfile'), 'FROM alpine\n');
    const preload = path.join(root, 'hook.js');
    fs.writeFileSync(preload, HOOK);
    for (const file of ['b/devcontainer.json', 'b/Dockerfile']) {
      for (const [plain, text] of [['b/devcontainer.json', BUILD_CONFIG], ['b/Dockerfile', 'FROM alpine\n']]) {
        fs.rmSync(path.join(repo, plain), { force: true });
        fs.rmSync(path.join(repo, `${plain}.before`), { force: true });
        write(path.join(repo, plain), text);
      }
      const writer = await waitingWriter(fifo);
      try {
        const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'), { preload, env: { HOOK_AT: 'open', HOOK_FILE: path.join(repo, file), HOOK_TO: fifo } });
        // The hook ran.
        expect(fs.lstatSync(path.join(repo, file)).isSymbolicLink(), file).toBe(true);
        if (file === 'b/devcontainer.json') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(REFUSED);
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' });
        }
        expect(await writer.opened(), file).toBe(false);
      } finally {
        await writer.stop();
      }
    }
  }, 30_000);

  // Mutant M73: the Dockerfile text taken when truthy (not when a string): an empty Dockerfile of the repository is its
  // text '', not a Dockerfile that was not read.
  it('takes an empty Dockerfile of the repository for its text', () => {
    const repo = tempDir();
    write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
    write(path.join(repo, 'b', 'Dockerfile'), '');
    const result = runScript(readFilesCommand(repo, 'b/devcontainer.json'));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile', dockerfileText: '' });
  });
});
