// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the parts of the batch helper around its steps: the checks before the first step, the variables and
// the log line of a step, the refusal of an unsafe helper, and a step process that ends with its whole group.
import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { BATCH_DOCKER_SOCKET, BATCH_GIT_UID, BATCH_SOCKET_FOLDER } from '../core/helperChannel/batch';
import { batchStepCommand } from '../core/helper/batchSteps';
import { SECRETS_FOLDER } from '../core/helper/scripts';
import { HELPER_DOCKER_SOCKET } from '../core/names';
import { BATCH_GIT_HOME, batchHelperOperations, describeStep, gitPrivilegeArgs, prepareBatchHelper, spawnStepProcess, stepEnvironment } from './batchHelper';
import { OperationError, type OperationContext } from './server';

function fakeFiles(options: { link?: string; mode?: number; folder?: boolean } = {}) {
  const calls: string[] = [];
  let link = options.link;
  return {
    calls,
    files: {
      lstatSync: ((path: string) => ({ isDirectory: () => options.folder !== false, mode: 0o40000 | (options.mode ?? 0o700), path })) as never,
      chmodSync: ((path: string, mode: number) => calls.push(`chmod ${path} ${mode.toString(8)}`)) as never,
      chownSync: ((path: string, uid: number, gid: number) => calls.push(`chown ${path} ${uid}:${gid}`)) as never,
      symlinkSync: ((target: string, path: string) => {
        calls.push(`link ${path} -> ${target}`);
        link = target;
      }) as never,
      readlinkSync: (() => {
        if (link === undefined) throw new Error('ENOENT');
        return link;
      }) as never,
    },
  };
}

function context(secret?: string): OperationContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    signal: new AbortController().signal,
    secret,
    progress: () => {},
    log: (text) => logs.push(text),
    output: () => {},
    docker: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };
}

describe('prepareBatchHelper (plan step 6, PR B)', () => {
  it('closes the folders of the socket and the secrets to root and links the default socket to it', () => {
    const { calls, files } = fakeFiles();
    expect(prepareBatchHelper(files, 0)).toBeUndefined();
    expect(calls).toEqual([
      `chown ${BATCH_SOCKET_FOLDER} 0:0`,
      `chmod ${BATCH_SOCKET_FOLDER} 700`,
      `chown ${SECRETS_FOLDER} 0:0`,
      `chmod ${SECRETS_FOLDER} 700`,
      `link ${HELPER_DOCKER_SOCKET} -> ${BATCH_DOCKER_SOCKET}`,
    ]);
  });

  it('is unsafe when not root, when a folder stays open, is no folder, or the default socket leads elsewhere', () => {
    expect(prepareBatchHelper(fakeFiles().files, 1000)).toMatch(/root/);
    expect(prepareBatchHelper(fakeFiles({ mode: 0o755 }).files, 0)).toMatch(/cannot be closed/);
    expect(prepareBatchHelper(fakeFiles({ folder: false }).files, 0)).toMatch(/not a folder/);
    expect(prepareBatchHelper(fakeFiles({ link: '/elsewhere.sock' }).files, 0)).toMatch(/leads elsewhere/);
    expect(prepareBatchHelper(fakeFiles({ link: BATCH_DOCKER_SOCKET }).files, 0)).toBeUndefined();
  });

  it('refuses every step of an unsafe helper (after the checks of its parameters)', async () => {
    const operations = batchHelperOperations({
      spawnStep: () => {
        throw new Error('never');
      },
      runQuiet: async () => {},
      fs: {} as never,
      env: {},
      unsafe: 'it does not run as root',
    });
    await expect(operations.listConfigs({ repository: 'octo/hello' }, context())).rejects.toMatchObject({ code: 'unsafe' });
    await expect(operations.listConfigs({ repository: '../x' }, context())).rejects.toMatchObject({ code: 'invalid' });
    expect(Object.keys(operations).sort()).toEqual(['build', 'clone', 'composeHash', 'composeModel', 'createFolders', 'gitFiles', 'listConfigs', 'ownershipFix', 'readConfiguration', 'readFiles', 'runUserCommands', 'up']);
    expect(new OperationError('x', 'y').code).toBe('x');
  });
});

describe('the variables and the log line of a step (plan step 6, PR B)', () => {
  it('sets the variables on the step after those of the helper; never DOCKER_HOST; Compose remote includes off; Git gets its HOME', () => {
    const base = { PATH: '/usr/bin', HOME: '/root', DOCKER_HOST: 'tcp://x:2375', XDG_CONFIG_HOME: '/root/.config' };
    const up = batchStepCommand('up', { repository: 'o/r', override: {}, environmentId: 'e', removeExistingContainer: false, env: { COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'true', A: 'b' } });
    const env = stepEnvironment(base, up);
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/root', XDG_CONFIG_HOME: '/root/.config', A: 'b', COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false', COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false' });
    const clone = stepEnvironment(base, batchStepCommand('clone', { repository: 'o/r' }));
    expect(clone.HOME).toBe(BATCH_GIT_HOME);
    expect(clone.XDG_CONFIG_HOME).toBeUndefined();
    expect(clone.DOCKER_HOST).toBeUndefined();
    expect(base.DOCKER_HOST).toBe('tcp://x:2375');
  });

  it('logs the command without its script, and the Git user', () => {
    expect(describeStep(batchStepCommand('listConfigs', { repository: 'o/r' }))).toBe('node <script> /workspaces/r');
    expect(describeStep(batchStepCommand('clone', { repository: 'o/r', branch: 'b' }))).toBe(`(as ${BATCH_GIT_UID}) sh <script> o/r r b`);
  });

  it('drops privileges fully for Git', () => {
    expect(gitPrivilegeArgs()).toEqual(['--reuid', String(BATCH_GIT_UID), '--regid', String(BATCH_GIT_UID), '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--']);
  });
});

const describeUnix = process.platform === 'linux' ? describe : describe.skip;

describeUnix('spawnStepProcess (plan step 6, PR B)', () => {
  it('passes the input, the variables and the output, and the exit code', async () => {
    let out = '';
    const step = spawnStepProcess(['sh', '-c', 'cat; printf " %s" "$STEP_VALUE"; exit 4'], { PATH: process.env.PATH, STEP_VALUE: 'v' }, 'in', (text) => (out += text), () => {});
    expect(await step.exited).toEqual({ exitCode: 4 });
    expect(out).toBe('in v');
  });

  it('ends the whole group of the step, also a process that it started in the background', async () => {
    let out = '';
    const step = spawnStepProcess(['sh', '-c', 'sleep 30 & echo $!; wait'], { PATH: process.env.PATH }, undefined, (text) => (out += text), () => {});
    const deadline = Date.now() + 5_000;
    while (!/\d+\n/.test(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const background = Number(out.trim());
    step.killGroup('SIGTERM');
    expect((await step.exited).exitCode).toBeNull();
    // Gone, or a zombie that nobody reaped yet (its parent ended): no longer running.
    const running = () => {
      try {
        return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${background}/stat`, 'utf8'));
      } catch {
        return false;
      }
    };
    const until = Date.now() + 5_000;
    while (running() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(running()).toBe(false);
  });
});
