// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the parts of the batch helper around its steps: the checks before the first step, the variables and
// the log line of a step, the refusal of an unsafe helper, and a step process that ends with its whole group.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { BATCH_DOCKER_SOCKET, BATCH_GIT_UID, BATCH_SOCKET_FOLDER } from '../core/helperChannel/batch';
import { batchStepCommand } from '../core/helper/batchSteps';
import { OVERRIDE_FOLDER, SECRETS_FOLDER } from '../core/helper/scripts';
import { HELPER_DOCKER_SOCKET, WORKSPACES_ROOT } from '../core/names';
import {
  BATCH_GIT_HOME,
  batchHelperOperations,
  describeStep,
  gitPrivilegeArgs,
  prepareBatchHelper,
  privilegeArgs,
  runQuietProcess,
  spawnStepProcess,
  stepEnvironment,
  type BatchHelperDeps,
  type StepProcess,
} from './batchHelper';
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

function context(secret?: string, signal: AbortSignal = new AbortController().signal): OperationContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    signal,
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
    // user decision 2026-10-02: Delete runs no Git: changed expectation, no operation gitSummary (was in plan step 7).
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
    // User decision of 2026-10-01 (agreed extension): listConfigs runs as the repository owner, and its log line says so.
    expect(describeStep(batchStepCommand('listConfigs', { repository: 'o/r' }))).toBe('(as the owner of /workspaces/r) node <script> /workspaces/r');
    expect(describeStep(batchStepCommand('gitFiles', { repository: 'o/r', identity: { name: 'n', email: 'e' } }))).toMatch(/^sh <script> r n e /);
    expect(describeStep(batchStepCommand('clone', { repository: 'o/r', branch: 'b' }))).toBe(`(as ${BATCH_GIT_UID}) sh <script> o/r r b`);
  });

  // User decision of 2026-10-01: Compose reads as the repository owner, with HOME=/nonexistent as Git (no configuration
  // of root's HOME), and the log line names that user.
  it('gives the Compose read steps the HOME of Git and logs them as the repository owner (user decision of 2026-10-01)', () => {
    const base = { PATH: '/usr/bin', HOME: '/root', DOCKER_HOST: 'tcp://x:2375', XDG_CONFIG_HOME: '/root/.config' };
    const hash = batchStepCommand('composeHash', { repository: 'o/r', model: '{}', project: 'p' });
    const env = stepEnvironment(base, hash);
    expect(env.HOME).toBe(BATCH_GIT_HOME);
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.COMPOSE_PROJECT_NAME).toBe('p');
    expect(describeStep(hash)).toBe('(as the owner of /workspaces/r) node <script> /tmp/devenv-override/compose.json p');
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

/**
 * User decision of 2026-10-01 (Compose reads as the repository owner; agreed extension: readFiles, listConfigs and
 * createFolders too): `lstat` with owners. The repository folders below
 * /workspaces belong to 1000:1000, everything else to root.
 */
function ownedLstat(name: string) {
  const owner = name.startsWith(`${WORKSPACES_ROOT}/`) ? 1000 : 0;
  return { isDirectory: () => true, isSymbolicLink: () => false, mode: name === WORKSPACES_ROOT ? 0o40755 : 0o40750, uid: owner, gid: owner };
}

/**
 * User decision of 2026-10-01: the file system of a step as the repository owner (listConfigs, readFiles, createFolders
 * and the Compose reads need the owner of the repository folder): `lstat` with owners, every change a no-op (never a
 * path of the machine that runs the tests).
 */
function ownerStepFiles(): BatchHelperDeps['fs'] {
  return {
    lstatSync: ownedLstat as never,
    chmodSync: (() => {}) as never,
    chownSync: (() => {}) as never,
    readdirSync: (() => []) as never,
    rmSync: (() => {}) as never,
    mkdirSync: (() => {}) as never,
  };
}

/** Settles with `promise`, or with 'pending' after `ms` (a step that never ends must fail the test, not hang it). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
}

/** A fake step that records its signals; `endOn` names the signal that ends it (null: none), `exitCode` ends it at once. */
function recordingSpawn(options: { endOn: 'SIGTERM' | 'SIGKILL' | null; exitCode?: number }) {
  const signals: string[] = [];
  const spawnStep: BatchHelperDeps['spawnStep'] = () => {
    let done!: (value: { exitCode: number | null }) => void;
    const exited = new Promise<{ exitCode: number | null }>((resolve) => (done = resolve));
    if (options.exitCode !== undefined) setTimeout(() => done({ exitCode: options.exitCode! }), 1);
    const step: StepProcess = {
      exited,
      killGroup: (signal) => {
        signals.push(signal);
        if (signal === options.endOn) done({ exitCode: null });
      },
    };
    return step;
  };
  return { signals, spawnStep };
}

describe('the end of a step process group (review round 1 of PR #80, B-R1-2)', () => {
  it('review round 1 of PR #80, B-R1-2: a step that ignores SIGTERM gets SIGKILL after the grace time (H28)', async () => {
    const { signals, spawnStep } = recordingSpawn({ endOn: 'SIGKILL' });
    // User decision of 2026-10-01: listConfigs runs as the repository owner, so the helper reads its owner (ownerStepFiles).
    const operations = batchHelperOperations({ spawnStep, runQuiet: async () => {}, fs: ownerStepFiles(), env: {}, killGraceMs: 30 });
    const controller = new AbortController();
    const running = operations.listConfigs({ repository: 'octo/hello' }, context(undefined, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await within(running, 5_000)).toEqual({ exitCode: null });
    expect(signals.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('review round 1 of PR #80, B-R1-2: a signal that was aborted before the spawn ends the step at once (H29)', async () => {
    const { signals, spawnStep } = recordingSpawn({ endOn: 'SIGTERM' });
    // User decision of 2026-10-01: listConfigs runs as the repository owner, so the helper reads its owner (ownerStepFiles).
    const operations = batchHelperOperations({ spawnStep, runQuiet: async () => {}, fs: ownerStepFiles(), env: {}, killGraceMs: 60_000 });
    const controller = new AbortController();
    controller.abort();
    expect(await within(operations.listConfigs({ repository: 'octo/hello' }, context(undefined, controller.signal)), 5_000)).toEqual({ exitCode: null });
    expect(signals[0]).toBe('SIGTERM');
  });

  it('review round 1 of PR #80, B-R1-2: after a normal exit, what is left in the group gets SIGKILL (H27)', async () => {
    const { signals, spawnStep } = recordingSpawn({ endOn: null, exitCode: 0 });
    // User decision of 2026-10-01: listConfigs runs as the repository owner, so the helper reads its owner (ownerStepFiles).
    const operations = batchHelperOperations({ spawnStep, runQuiet: async () => {}, fs: ownerStepFiles(), env: {} });
    expect(await operations.listConfigs({ repository: 'octo/hello' }, context())).toEqual({ exitCode: 0 });
    expect(signals).toEqual(['SIGKILL']);
  });
});

describe('the secrets tmpfs after a step with a secret (review round 1 of PR #80, B-R1-4)', () => {
  const TOKEN = 'ghp_secret_token_of_the_test';

  /** The file system calls of a Git step; the secrets tmpfs is `secrets` (a real folder) or the fake `readdirSync`. */
  function gitFiles(options: { secrets?: string; readdir?: () => string[] }): BatchHelperDeps['fs'] {
    const real = (name: string) => (options.secrets === undefined ? name : name.replace(SECRETS_FOLDER, options.secrets));
    return {
      // User decision of 2026-10-01: listConfigs runs as the repository owner, so `lstat` names owners (ownedLstat).
      lstatSync: ownedLstat as never,
      chmodSync: (() => {}) as never,
      chownSync: (() => {}) as never,
      readdirSync: ((name: string) => (options.readdir ? options.readdir() : fs.readdirSync(real(name)))) as never,
      // Only the stand-in of the secrets tmpfs is removed for real (a step as the owner removes OVERRIDE_FOLDER, which
      // must never be a path of the machine that runs the tests).
      rmSync: ((name: string, rmOptions: fs.RmOptions) => (name === SECRETS_FOLDER || name.startsWith(`${SECRETS_FOLDER}/`) ? fs.rmSync(real(name), rmOptions) : undefined)) as never,
      mkdirSync: (() => {}) as never,
    };
  }

  it('review round 1 of PR #80, B-R1-4: the next step still runs after the secrets could not be listed', async () => {
    let fail = true;
    const operations = batchHelperOperations({
      spawnStep: recordingSpawn({ endOn: 'SIGTERM', exitCode: 0 }).spawnStep,
      runQuiet: async () => {},
      fs: gitFiles({
        readdir: () => {
          if (fail) {
            fail = false;
            throw new Error('EIO: the tmpfs cannot be read');
          }
          return [];
        },
      }),
      env: {},
    });
    await expect(operations.clone({ repository: 'octo/hello' }, context(TOKEN))).rejects.toThrow(/EIO/);
    // Not `busy`: the slot was freed although the secrets could not be cleared.
    expect(await operations.listConfigs({ repository: 'octo/hello' }, context())).toEqual({ exitCode: 0 });
    expect(await operations.clone({ repository: 'octo/hello' }, context(TOKEN))).toEqual({ exitCode: 0 });
  });

  it('review round 1 of PR #80, B-R1-4: a folder in the secrets tmpfs is removed with what it holds (H52)', async () => {
    const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-secrets-'));
    try {
      fs.writeFileSync(path.join(secrets, 'github-token'), TOKEN);
      fs.mkdirSync(path.join(secrets, 'copy', 'deeper'), { recursive: true });
      fs.writeFileSync(path.join(secrets, 'copy', 'deeper', 'token'), TOKEN);
      const operations = batchHelperOperations({ spawnStep: recordingSpawn({ endOn: 'SIGTERM', exitCode: 0 }).spawnStep, runQuiet: async () => {}, fs: gitFiles({ secrets }), env: {} });
      expect(await operations.clone({ repository: 'octo/hello' }, context(TOKEN))).toEqual({ exitCode: 0 });
      expect(fs.readdirSync(secrets)).toEqual([]);
      expect(await operations.listConfigs({ repository: 'octo/hello' }, context())).toEqual({ exitCode: 0 });
    } finally {
      fs.rmSync(secrets, { recursive: true, force: true });
    }
  });
});

describeUnix('the real processes of the helper (review round 1 of PR #80, B-R1-1, B-R1-3)', () => {
  it('review round 1 of PR #80, B-R1-1: runQuietProcess passes each argument as it is, with no shell (H59)', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-quiet-'));
    try {
      const file = path.join(folder, 'out');
      const argument = 'a b; echo injected > "$0" | x';
      await runQuietProcess([process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', file, argument]);
      expect(fs.readFileSync(file, 'utf8')).toBe(argument);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('review round 3 of PR #80, B-R3-2: a step that exits without reading a large input (EPIPE) resolves with its exit code, and the helper does not crash', async () => {
    // Far more than a pipe buffer: the write is still pending when the step exits, so its standard input gets EPIPE.
    const step = spawnStepProcess(['sh', '-c', 'exit 3'], { PATH: process.env.PATH }, 'x'.repeat(4 * 1024 * 1024), () => {}, () => {});
    expect(await within(step.exited, 10_000)).toEqual({ exitCode: 3 });
    // An unhandled 'error' event of the input would surface as an uncaught exception (vitest fails the run) by now.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('review round 1 of PR #80, B-R1-1: runQuietProcess resolves for a command that does not exist', async () => {
    expect(await within(runQuietProcess(['/nonexistent/devenv-no-such-command', '-x']), 10_000)).toBeUndefined();
  });

  it(
    'review round 1 of PR #80, B-R1-3: a process outside the group that holds the pipes does not hold the step (H56)',
    async () => {
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-escape-'));
      const pidFile = path.join(folder, 'pid');
      let escaped: number | undefined;
      try {
        // The background `sleep` leaves the group of the step (setsid) and keeps its stdout and stderr open.
        const step = spawnStepProcess(['sh', '-c', 'setsid sleep 30 & echo $! > "$0"; exit 0', pidFile], { PATH: process.env.PATH }, undefined, () => {}, () => {});
        const started = Date.now();
        const result = await within(step.exited, 10_000);
        try {
          escaped = Number(fs.readFileSync(pidFile, 'utf8').trim()) || undefined;
        } catch {
          // No PID written.
        }
        expect(result).toEqual({ exitCode: 0 });
        expect(Date.now() - started).toBeLessThan(10_000);
      } finally {
        if (escaped !== undefined) {
          for (const target of [-escaped, escaped]) {
            try {
              process.kill(target, 'SIGKILL');
            } catch {
              // Gone already.
            }
          }
        }
        fs.rmSync(folder, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe('the walks of the Git user (review round 1 of PR #82, A-R1-2)', () => {
  const TOKEN = 'ghp_secret_token_of_the_test';
  const uid = String(BATCH_GIT_UID);
  const repair = ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-exec', 'chown', '-h', '0:0', '{}', '+'].join(' ');
  const volumeWalk = repair;
  const rootWalk = ['find', '/', '/dev/shm', '-xdev', '-user', uid, '-prune', '-exec', 'rm', '-rf', '{}', '+'].join(' ');
  const kill = ['setpriv', ...gitPrivilegeArgs(), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'].join(' ');

  function helper(): { quiet: string[]; operations: ReturnType<typeof batchHelperOperations> } {
    const quiet: string[] = [];
    const operations = batchHelperOperations({
      spawnStep: recordingSpawn({ endOn: 'SIGTERM', exitCode: 0 }).spawnStep,
      runQuiet: async (command) => {
        quiet.push(command.join(' '));
      },
      fs: {
        lstatSync: ownedLstat as never,
        chmodSync: (() => {}) as never,
        chownSync: (() => {}) as never,
        readdirSync: (() => []) as never,
        rmSync: (() => {}) as never,
        mkdirSync: (() => {}) as never,
      },
      env: {},
    });
    return { quiet, operations };
  }

  it('review round 1 of PR #82, A-R1-2: the repair of a cut-off Git step runs once per helper process', async () => {
    const first = helper();
    expect(await first.operations.composeModel({ repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' }, context())).toEqual({ exitCode: 0 });
    // User decision of 2026-10-01: Compose reads as the repository owner, so composeModel is no Git step and repairs
    // nothing (under option A the repair ran before it).
    expect(first.quiet).toEqual([['setpriv', ...privilegeArgs(1000, 1000), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'].join(' ')]);
    expect(await first.operations.clone({ repository: 'octo/hello' }, context(TOKEN))).toEqual({ exitCode: 0 });
    expect(await first.operations.composeHash({ repository: 'octo/hello', model: '{}', project: 'p' }, context())).toEqual({ exitCode: 0 });
    // User decision of 2026-10-01: the first walk of the volume is the repair before the clone (was: before
    // composeModel); the second is the chown walk after the clone.
    expect(first.quiet.filter((call) => call === repair)).toHaveLength(2);
    expect(first.quiet.indexOf(repair)).toBeLessThan(first.quiet.indexOf(kill));
    // A new helper process repairs again, once.
    const second = helper();
    expect(await second.operations.clone({ repository: 'octo/hello' }, context(TOKEN))).toEqual({ exitCode: 0 });
    expect(await second.operations.clone({ repository: 'octo/hello' }, context(TOKEN))).toEqual({ exitCode: 0 });
    // Per clone: one chown walk after it; plus the one repair before the first.
    expect(second.quiet.filter((call) => call === repair)).toHaveLength(3);
  });

  it('review round 1 of PR #82, A-R1-2: after a Compose read step, no walk of the volume', async () => {
    const { quiet, operations } = helper();
    await operations.composeModel({ repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' }, context());
    quiet.length = 0;
    expect(await operations.composeHash({ repository: 'octo/hello', model: '{}', project: 'p' }, context())).toEqual({ exitCode: 0 });
    // User decision of 2026-10-01: Compose reads as the repository owner. Changed expectation (option A: the kill of the
    // Git user and the removal of its files outside the volume): only the kill of the owner's processes; the owner's
    // files are legitimate, so no walk at all.
    expect(quiet).toEqual([['setpriv', ...privilegeArgs(1000, 1000), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'].join(' ')]);
    expect(quiet).not.toContain(kill);
    expect(quiet).not.toContain(rootWalk);
    expect(quiet).not.toContain(volumeWalk);
  });
});

describe('the override folder before a read step (review round 1 of PR #82, B-R1-5)', () => {
  it('review round 1 of PR #82, B-R1-5: a read step starts without the files that earlier root steps left below OVERRIDE_FOLDER (a folder with files)', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-override-'));
    const override = path.join(temp, 'override');
    try {
      // What `up` or `build` of a Compose configuration leaves there: our configuration and a folder of files.
      fs.mkdirSync(path.join(override, 'compose'), { recursive: true });
      fs.writeFileSync(path.join(override, 'devcontainer.json'), '{}');
      fs.writeFileSync(path.join(override, 'compose', 'model.json'), '{}');
      const real = (name: string) => (name === OVERRIDE_FOLDER ? override : name);
      const operations = batchHelperOperations({
        spawnStep: recordingSpawn({ endOn: 'SIGTERM', exitCode: 0 }).spawnStep,
        runQuiet: async () => {},
        fs: {
          lstatSync: ownedLstat as never,
          chmodSync: (() => {}) as never,
          chownSync: (() => {}) as never,
          readdirSync: (() => []) as never,
          // The real rmSync on the real folder: without `recursive`, a folder is refused (EISDIR or ERR_FS_EISDIR).
          rmSync: ((name: string, rmOptions: fs.RmOptions) => fs.rmSync(real(name), rmOptions)) as never,
          // User decision of 2026-10-01 (Compose reads as the repository owner): the folder is made new for the step.
          mkdirSync: ((name: string, mkdirOptions: fs.MakeDirectoryOptions) => fs.mkdirSync(real(name), mkdirOptions)) as never,
        },
        env: {},
      });
      expect(await operations.composeModel({ repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' }, context())).toEqual({ exitCode: 0 });
      expect(fs.existsSync(override)).toBe(false);
      // Also when there is nothing to remove.
      expect(await operations.composeHash({ repository: 'octo/hello', model: '{}', project: 'p' }, context())).toEqual({ exitCode: 0 });
      expect(fs.existsSync(override)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('the override folder is cleared before a read step runs (review round 3 of PR #82, B-R3-2)', () => {
  it('review round 3 of PR #82, B-R3-2: the files that a root step left below OVERRIDE_FOLDER are gone when the read step starts, not only after it', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-override-'));
    const override = path.join(temp, 'override');
    try {
      // What readConfiguration with Compose files leaves there as root: the model that composeHash writes to as well.
      fs.mkdirSync(path.join(override, 'compose'), { recursive: true });
      fs.writeFileSync(path.join(override, 'compose', 'model.json'), '{"root":true}');
      const real = (name: string) => (name === OVERRIDE_FOLDER ? override : name);
      const events: string[] = [];
      const started: { resolve: () => void; promise: Promise<void> } = (() => {
        let resolve!: () => void;
        return { promise: new Promise<void>((r) => (resolve = r)), resolve };
      })();
      let exit!: (value: { exitCode: number | null }) => void;
      const operations = batchHelperOperations({
        spawnStep: () => {
          const content = fs.existsSync(override) ? `present, ${fs.readdirSync(override).length === 0 ? 'empty' : 'with files'}` : 'gone';
          events.push(`spawn (override folder ${content})`);
          started.resolve();
          return { exited: new Promise((resolve) => (exit = resolve)), killGroup: () => {} };
        },
        runQuiet: async () => {},
        fs: {
          lstatSync: ownedLstat as never,
          chmodSync: (() => {}) as never,
          chownSync: (() => {}) as never,
          readdirSync: (() => []) as never,
          // User decision of 2026-10-01 (Compose reads as the repository owner): the folder is made new for the step.
          mkdirSync: ((name: string, mkdirOptions: fs.MakeDirectoryOptions) => {
            events.push(name === OVERRIDE_FOLDER ? 'mkdir override folder' : `mkdir ${name}`);
            if (name === OVERRIDE_FOLDER) fs.mkdirSync(real(name), mkdirOptions);
          }) as never,
          rmSync: ((name: string, rmOptions: fs.RmOptions) => {
            // Review round 4 of PR #82 (A-R4-1): only the stand-in of OVERRIDE_FOLDER is ever removed for real; any other
            // path is recorded, never a path of the machine that runs the tests.
            if (name !== OVERRIDE_FOLDER) {
              events.push(`rm ${name}`);
              return;
            }
            events.push('rm override folder');
            fs.rmSync(real(name), rmOptions);
          }) as never,
        },
        env: {},
      });
      const running = operations.composeHash({ repository: 'octo/hello', model: '{}', project: 'p' }, context());
      await started.promise;
      // User decision of 2026-10-01: Compose reads as the repository owner. Changed expectation (option A: the folder
      // was gone at the spawn): the files of root are gone, and the folder is new and empty for the owner.
      expect(events).toEqual(['rm override folder', 'mkdir override folder', 'spawn (override folder present, empty)']);
      expect(fs.existsSync(path.join(override, 'compose', 'model.json'))).toBe(false);
      exit({ exitCode: 0 });
      expect(await running).toEqual({ exitCode: 0 });
      // User decision of 2026-10-01: after the step, root removes the folder of the owner again.
      expect(events).toEqual(['rm override folder', 'mkdir override folder', 'spawn (override folder present, empty)', 'rm override folder']);
      expect(fs.existsSync(override)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
