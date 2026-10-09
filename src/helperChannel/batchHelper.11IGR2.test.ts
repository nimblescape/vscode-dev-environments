// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR G (reviewer B): probes for the mutants of the fixes of review round 1 in the batch helper (the two
// passes that give the files of the Git user to root, A-F1; the restore loop of asGitUser, A-F6) that the suites let
// survive. Each test names the mutants that it kills (the mutant table of the review); each passes on the code as it is.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRETS_FOLDER } from '../core/helper/scripts';
import { CONFIG_FOLDER, WORKSPACES_ROOT } from '../core/names';
import { batchHelperOperations, gitUserFilesToRootCommands, type BatchHelperDeps } from './batchHelper';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  folders.push(dir);
  return dir;
}

/** The time of the last change of the inode itself (chown sets it also when the owner stays the same), in nanoseconds. */
const changed = (file: string): bigint => fs.lstatSync(file, { bigint: true }).ctimeNs;
/** Lets the clock of the file system move on, so that a change after this has another ctime. */
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);

const gnuTools = process.platform === 'linux' && /GNU findutils/.test(spawnSync('find', ['--version'], { encoding: 'utf8' }).stdout ?? '') && /GNU coreutils/.test(spawnSync('chown', ['--version'], { encoding: 'utf8' }).stdout ?? '');

describe.runIf(gnuTools)('the two passes that give the files of the Git user to root, with the real find and chown (review round 2 of PR G, reviewer B)', () => {
  // A link of the Git user that the second pass reaches. A process of the dev container can put one anywhere in the
  // volume (root of the dev container: `ln -s` and `chown -h <Git user>`), also in a folder that is no top entry of the
  // Git user, so that the first pass (`chown -R` of its top entries) does not take it; here it points to a file outside
  // the volume (in the helper: the shared cache volume, the folder of the socket). A user may give a file only to
  // itself: the commands get the test user (as root: root), the `chown` on PATH runs the real chown with that user in
  // place of 0:0, so every entry still belongs to that user after the first pass and the second pass reaches the link
  // too; what chown reached shows in the change time of the inodes, which chown sets also when the owner stays the same.
  it('changes the link itself in the second pass, never the file outside that it points to (kills P11: the second pass without -h)', () => {
    const base = tempDir('devenv-11igr2-links-');
    const ws = path.join(base, 'workspaces');
    const outside = path.join(base, 'outside');
    const bin = path.join(base, 'bin');
    for (const folder of [path.join(ws, 'repo', 'deep'), outside, bin]) fs.mkdirSync(folder, { recursive: true });
    const target = path.join(outside, 'cache-file');
    fs.writeFileSync(target, 'a file of the cache volume\n');
    const link = path.join(ws, 'repo', 'deep', 'link');
    fs.symlinkSync(target, link);
    const realChown = spawnSync('sh', ['-c', 'command -v chown'], { encoding: 'utf8' }).stdout.trim();
    const self = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    fs.writeFileSync(
      path.join(bin, 'chown'),
      ['#!/bin/sh', 'for arg do', '  shift', '  [ "$arg" = 0:0 ] && arg=$PROBE_SELF', '  set -- "$@" "$arg"', 'done', 'exec "$PROBE_REAL_CHOWN" "$@"', ''].join('\n'),
      { mode: 0o755 },
    );
    const before = { target: changed(target), link: changed(link) };
    tick();
    const commands = gitUserFilesToRootCommands(ws, String(process.getuid?.() ?? 0));
    expect(commands).toHaveLength(2);
    for (const [file, ...args] of commands) {
      const result = spawnSync(file, args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PROBE_SELF: self, PROBE_REAL_CHOWN: realChown } });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
    // The walk reached the link (its own inode changed), and nothing reached the file outside.
    expect(changed(link)).toBeGreaterThan(before.link);
    expect(changed(target)).toBe(before.target);
    expect(fs.readFileSync(target, 'utf8')).toBe('a file of the cache volume\n');
  });

  // As root (as in the helper): the second pass changes each entry of the Git user by itself, so a folder of the Git
  // user below a folder of another user keeps the files of others in it (the first pass changes only what belongs to the
  // Git user, `--from`).
  it.runIf(process.getuid?.() === 0)('as root: the second pass gives a folder of the Git user below another folder to root, not the files of other users in it (kills P17: the second pass with chown -R)', () => {
    const base = tempDir('devenv-11igr2-root-');
    const ws = path.join(base, 'workspaces');
    const sub = path.join(ws, 'repo', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const theirs = path.join(sub, 'theirs');
    const mine = path.join(sub, 'mine');
    fs.writeFileSync(theirs, 'x');
    fs.writeFileSync(mine, 'x');
    fs.chownSync(sub, 4321, 4321);
    fs.chownSync(mine, 4321, 4321);
    fs.chownSync(theirs, 999, 998);
    for (const [file, ...args] of gitUserFilesToRootCommands(ws, '4321')) {
      const result = spawnSync(file, args, { encoding: 'utf8', timeout: 30_000 });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
    const owner = (file: string) => `${fs.lstatSync(file).uid}:${fs.lstatSync(file).gid}`;
    expect([owner(sub), owner(mine)]).toEqual(['0:0', '0:0']);
    expect(owner(theirs)).toBe('999:998');
  });
});

const TOKEN = 'ghp_secret_token_of_the_probe';

function context(): OperationContext {
  return { signal: new AbortController().signal, ...contextSecrets({ token: TOKEN }), progress: () => {}, log: () => {}, output: () => {} };
}

describe('the restores after a step of the Git user, review round 2 of PR G (reviewer B)', () => {
  // A file system by paths with descriptors: CONFIG_FOLDER is a folder (device 7, inode 42, 0750). The restores of the
  // clone run in this order (the reverse of their registration): the secrets tmpfs (chown 0:0, chmod 0700), /workspaces
  // (its mode), CONFIG_FOLDER (its mode through the descriptor, then the close). Here the first two throw.
  function failingRestores() {
    const events: string[] = [];
    const open = new Set<number>();
    let next = 100;
    const folder = (ino: number, mode: number, owner: number) => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40000 | mode, uid: owner, gid: owner, dev: 7, ino });
    const files = {
      lstatSync: ((file: string) => (file === CONFIG_FOLDER ? folder(42, 0o750, 1000) : folder(1, file === WORKSPACES_ROOT ? 0o755 : 0o750, file.startsWith(`${WORKSPACES_ROOT}/`) ? 1000 : 0))) as never,
      chmodSync: ((file: string, mode: number) => {
        events.push(`chmod ${file} ${mode.toString(8)}`);
        if (file === WORKSPACES_ROOT && mode !== 0o1777) throw Object.assign(new Error('EIO: the restore of /workspaces failed'), { code: 'EIO' });
      }) as never,
      chownSync: ((file: string, uid: number, gid: number) => {
        events.push(`chown ${file} ${uid}:${gid}`);
        if (file === SECRETS_FOLDER && uid === 0) throw Object.assign(new Error('EIO: the restore of the secrets failed'), { code: 'EIO' });
      }) as never,
      readdirSync: (() => []) as never,
      rmSync: (() => {}) as never,
      mkdirSync: (() => {}) as never,
      openSync: (() => {
        open.add(++next);
        return next;
      }) as never,
      fstatSync: (() => folder(42, 0o750, 1000)) as never,
      fchmodSync: ((_descriptor: number, mode: number) => events.push(`fchmod ${mode.toString(8)}`)) as never,
      fchownSync: (() => {}) as never,
      closeSync: ((descriptor: number) => {
        open.delete(descriptor);
        events.push('close');
      }) as never,
    } satisfies BatchHelperDeps['fs'];
    return { files, events, open };
  }

  it('rethrows the error of the first restore that failed, after it ran the others and the walks (kills R02: the last error; R05: the restores in the order of their registration)', async () => {
    const fake = failingRestores();
    const quiet: string[] = [];
    const operations = batchHelperOperations({
      spawnStep: () => ({ exited: Promise.resolve({ exitCode: 0 }), killGroup: () => {} }),
      runQuiet: async (command) => {
        quiet.push(command.join(' '));
      },
      fs: fake.files,
      env: {},
    });
    await expect(operations.clone({ repository: 'octo/hello' }, context())).rejects.toThrow('EIO: the restore of the secrets failed');
    // Each restore ran: the secrets, /workspaces (its mode without the sticky and the write bits for others), and
    // CONFIG_FOLDER through its descriptor, which was closed.
    const restores = fake.events.slice(fake.events.indexOf(`chown ${SECRETS_FOLDER} 0:0`));
    expect(restores).toEqual([`chown ${SECRETS_FOLDER} 0:0`, `chmod ${WORKSPACES_ROOT} 755`, 'fchmod 750', 'close']);
    expect([...fake.open]).toEqual([]);
    expect(quiet.some((call) => call.includes('-prune -exec rm -rf'))).toBe(true);
  });
});
