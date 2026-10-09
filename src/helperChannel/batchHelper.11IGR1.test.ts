// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR G (reviewer B): probes for the mutants of openConfigFolder, asGitUser and asRepositoryOwner
// (follow-up of plan step 11I, the links of the owner) that batchHelper.test.ts and batch.test.ts let survive: the
// descriptor of CONFIG_FOLDER is closed exactly once and never used after its close (also when the close of the folder
// fails), and the restore gives the folder its whole mode back. Each test names the mutants that it kills.
import { describe, expect, it } from 'vitest';
import { CONFIG_FOLDER, WORKSPACES_ROOT } from '../core/names';
import { batchHelperOperations, type BatchHelperDeps } from './batchHelper';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const TOKEN = 'ghp_secret_token_of_the_probe';

function context(secret?: string): OperationContext {
  return {
    signal: new AbortController().signal,
    ...contextSecrets(secret === undefined ? {} : { token: secret }),
    progress: () => {},
    log: () => {},
    output: () => {},
  };
}

/**
 * A file system by paths for the helper, with descriptors: CONFIG_FOLDER is a folder (device 7, inode 42) with `mode`
 * and the owner `owner`; the repository folders below /workspaces belong to 1000:1000. Every descriptor call is
 * recorded; a call on a descriptor after its close, and a second close, are violations. `otherInode`: the descriptor is a
 * folder other than the one that lstat saw. `failClose`: the first fchmod to 0700 (the close of the folder) fails.
 */
function descriptorFiles(options: { mode?: number; owner?: number; otherInode?: boolean; failClose?: boolean } = {}) {
  const events: string[] = [];
  const violations: string[] = [];
  const open = new Set<number>();
  let next = 100;
  let failed = false;
  const owner = options.owner ?? 1000;
  const config = (ino: number) => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40000 | (options.mode ?? 0o755), uid: owner, gid: owner, dev: 7, ino });
  const use = (descriptor: number, call: string) => {
    if (!open.has(descriptor)) violations.push(`${call} of ${descriptor} after its close`);
  };
  const files = {
    lstatSync: ((file: string) => {
      if (file === CONFIG_FOLDER) return config(42);
      const repository = file.startsWith(`${WORKSPACES_ROOT}/`) ? 1000 : 0;
      return { isDirectory: () => true, isSymbolicLink: () => false, mode: file === WORKSPACES_ROOT ? 0o40755 : 0o40750, uid: repository, gid: repository, dev: 7, ino: 1 };
    }) as never,
    chmodSync: ((file: string, mode: number) => events.push(`chmod ${file} ${mode.toString(8)}`)) as never,
    chownSync: ((file: string, uid: number, gid: number) => events.push(`chown ${file} ${uid}:${gid}`)) as never,
    readdirSync: (() => []) as never,
    rmSync: (() => {}) as never,
    mkdirSync: (() => {}) as never,
    openSync: ((file: string) => {
      const descriptor = ++next;
      open.add(descriptor);
      events.push(`open ${file}`);
      return descriptor;
    }) as never,
    fstatSync: ((descriptor: number) => {
      use(descriptor, 'fstat');
      return config(options.otherInode === true ? 43 : 42);
    }) as never,
    fchmodSync: ((descriptor: number, mode: number) => {
      use(descriptor, 'fchmod');
      if (options.failClose === true && !failed && mode === 0o700) {
        failed = true;
        throw Object.assign(new Error('EIO: the close failed'), { code: 'EIO' });
      }
      events.push(`fchmod ${mode.toString(8)}`);
    }) as never,
    fchownSync: ((descriptor: number, uid: number, gid: number) => {
      use(descriptor, 'fchown');
      events.push(`fchown ${uid}:${gid}`);
    }) as never,
    closeSync: ((descriptor: number) => {
      if (!open.delete(descriptor)) violations.push(`second close of ${descriptor}`);
      events.push('close');
    }) as never,
  } satisfies BatchHelperDeps['fs'];
  return { files, events, violations, open };
}

const exited: BatchHelperDeps['spawnStep'] = () => ({ exited: Promise.resolve({ exitCode: 0 }), killGroup: () => {} });

const RUNS = {
  clone: (operations: ReturnType<typeof batchHelperOperations>) => operations.clone({ repository: 'octo/hello' }, context(TOKEN)),
  composeModel: (operations: ReturnType<typeof batchHelperOperations>) => operations.composeModel({ repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' }, context()),
  readFiles: (operations: ReturnType<typeof batchHelperOperations>) => operations.readFiles({ repository: 'octo/hello', configPath: '.devcontainer/devcontainer.json' }, context()),
};

describe('the descriptor of CONFIG_FOLDER in the batch helper, review round 1 of PR G (reviewer B)', () => {
  it.each([
    ['clone', {}, 'B11'],
    ['composeModel', {}, 'B18, B20'],
    ['readFiles', {}, 'B19'],
    ['readFiles', { mode: 0o700, owner: 0 }, 'B19 (the repair of a cut-off folder)'],
    ['composeModel', { otherInode: true }, 'B08 (another folder between the lstat and the open)'],
  ] as const)('%s %j: closes the descriptor exactly once and never uses it after its close (kills %s)', async (kind, options, _mutants) => {
    const fake = descriptorFiles(options);
    const operations = batchHelperOperations({ spawnStep: exited, runQuiet: async () => {}, fs: fake.files, env: {} });
    expect(await RUNS[kind](operations)).toEqual({ exitCode: 0 });
    expect(fake.events.filter((event) => event.startsWith('open '))).toEqual([`open ${CONFIG_FOLDER}`]);
    expect(fake.violations).toEqual([]);
    expect([...fake.open]).toEqual([]);
  });

  it.each([
    ['clone', 'B14'],
    ['composeModel', 'B23'],
  ] as const)('%s: when the close of CONFIG_FOLDER fails, the step fails, and the descriptor is still closed exactly once and never used after (kills %s)', async (kind, _mutant) => {
    const fake = descriptorFiles({ failClose: true });
    const operations = batchHelperOperations({ spawnStep: exited, runQuiet: async () => {}, fs: fake.files, env: {} });
    await expect(RUNS[kind](operations)).rejects.toThrow('EIO: the close failed');
    expect(fake.violations).toEqual([]);
    expect([...fake.open]).toEqual([]);
  });

  it.each([
    ['clone', 'B12'],
    ['composeModel', 'B25'],
  ] as const)('%s: the restore gives CONFIG_FOLDER its whole mode back, with the sticky bit (kills %s)', async (kind, _mutant) => {
    const fake = descriptorFiles({ mode: 0o1750 });
    const operations = batchHelperOperations({ spawnStep: exited, runQuiet: async () => {}, fs: fake.files, env: {} });
    expect(await RUNS[kind](operations)).toEqual({ exitCode: 0 });
    const modes = fake.events.filter((event) => event.startsWith('fchmod '));
    expect(modes).toEqual(['fchmod 700', 'fchmod 1750']);
  });
});
