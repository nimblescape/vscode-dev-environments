// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the batch helper in one process: the extension's HelperChannel, the worker's ChannelServer with
// `batch`, `batchStep` and `batchChunk`, and, as the `docker run` of the helper, a second ChannelServer with the step
// table of the helper (fake step processes and file system). Checked: one helper per session after the volume check
// (a missing volume is refused and nothing is started); the relay of a step (its command from the builders, its
// variables on the process only, its output masked); the token only as the `secret` and the standard input of the clone,
// which runs as the Git user with the cleanup after it; unknown kinds refused; chunked input; the time limit and the
// cancel of a step end that step alone; one step at a time; close and the end of the helper.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_GIT_UID,
  BATCH_HOLD_LIMIT_MS,
  BATCH_READY_STEP,
  MAX_BATCH_INPUT_CHARACTERS,
  MAX_CONCURRENT_BATCHES,
  OP_BATCH,
  OP_BATCH_CHUNK,
  OP_BATCH_STEP,
  batchRunArgs,
  batchVolumeArgs,
} from '../core/helperChannel/batch';
import { batchStepCommand } from '../core/helper/batchSteps';
import { OVERRIDE_FOLDER, SECRETS_FOLDER } from '../core/helper/scripts';
import { HelperChannel, HelperChannelError, HelperOperationError, type HelperBatchSession, type HelperChannelOptions } from '../core/helperChannel/helperChannel';
import { CHANNEL_PROTOCOL_VERSION, channelStepLabel, encodeMessage, parseClientMessage } from '../core/helperChannel/protocol';
import { bundleHash } from '../core/loader/pipeLoader';
import { CONFIG_FOLDER, WORKSPACES_ROOT } from '../core/names';
import { isAbortError, type Logger, type StartedProcess } from '../core/ports';
import { BATCH_MISSING_VOLUME_CODE, batchChunkOperation, batchOperation, batchStepOperation, type BatchDeps } from './batch';
import { batchHelperOperations, gitPrivilegeArgs, privilegeArgs, type BatchHelperDeps, type StepProcess } from './batchHelper';
import { ChannelServer, type ContextDockerOptions, type ServerChild, type SpawnDocker } from './server';

const TOKEN = 'ghp_secret_token_of_the_test';
const VOLUME = 'devenv-vol-1';
const IMAGE = `sha256:${'a'.repeat(64)}`;
const SOCKET = '/var/run/docker.sock';
const HELPER_SCRIPT = 'the script of the worker and its helper';
const UP = { repository: 'octo/hello', override: { name: 'x' }, environmentId: 'env-1', removeExistingContainer: false, env: { COMPOSE_PROJECT_NAME: 'p' } };

interface FakeStep {
  command: string[];
  env: NodeJS.ProcessEnv;
  input: string | undefined;
  signals: string[];
  out(text: string): void;
  err(text: string): void;
  exit(code: number | null): void;
}

/** Writes everything after the first line (the bundle, which the pipe loader reads) to `next`; records the bundle. */
function afterLoader(next: (text: string) => void, onBundle: (line: string) => void): (text: string) => void {
  let buffer: string | undefined = '';
  return (text) => {
    if (buffer === undefined) return next(text);
    buffer += text;
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    onBundle(buffer.slice(0, end));
    const rest = buffer.slice(end + 1);
    buffer = undefined;
    if (rest !== '') next(rest);
  };
}

interface SetupOptions {
  autoExit?: boolean;
  workspacesMode?: number;
  /** Review round 1 of PR #80 (B-R1-12): the deps of the worker's batch operation (holdLimitMs, openTimeoutMs). */
  deps?: Partial<BatchDeps>;
  /**
   * Review round 1 of PR #80 (B-R1-12): the `docker run` of the helper: a ChannelServer (default); one that never
   * answers and ends only by a kill (`silent`); one that answers `hello` with another protocol version.
   */
  helper?: 'channel' | 'silent' | 'wrongProtocol';
  /** Review round 1 of PR #80 (B-R1-14): the output of `docker ps`. */
  psOutput?: string;
  /**
   * Review round 2 of PR #80, B-R2-2: what `lstat` of CONFIG_FOLDER finds: a folder (default), a symbolic link (planted by
   * the Git user while /workspaces was 1777), or nothing (it throws ENOENT).
   */
  configFolder?: 'folder' | 'symlink' | 'missing' | 'cutOff';
  /**
   * Review round 3 of PR #80, B-R3-1: the helper (a ChannelServer) reads its input only once this settles, so its hello
   * comes late; and it ignores SIGTERM (as Node.js as PID 1 of its container) and ends only by SIGKILL or its input.
   */
  lateHello?: Promise<void>;
  /** Review round 3 of PR #80, B-R3-1: the kill grace time of the worker's ChannelServer (default 50 ms). */
  workerKillGraceMs?: number;
  /**
   * User decision of 2026-10-01: Compose reads as the repository owner. What `lstat` of the repository folder
   * (/workspaces/hello) finds: a folder of 1000:1000 (default), of root, a symbolic link, or nothing.
   */
  repository?: 'user' | 'root' | 'symlink' | 'missing';
}

function setup(options: SetupOptions = {}) {
  const calls: string[][] = [];
  const steps: FakeStep[] = [];
  const quiet: string[][] = [];
  const fsCalls: string[] = [];
  // The quiet commands and the file system calls in one order (review round 1 of PR #80, A-R1-1).
  const order: string[] = [];
  const logLines: string[] = [];
  const clientLines: string[] = [];
  const bundles: string[] = [];
  const servers: ChannelServer[] = [];
  // Review round 1 of PR #80 (B-R1-11, B-R1-12): what the helper child saw, and the options of the worker's Docker calls.
  const helperEvents: Array<{ event: string; at: number }> = [];
  const dockerOptions: Array<{ args: readonly string[]; options: ContextDockerOptions | undefined }> = [];
  let helperExit: ((code: number | null) => void) | undefined;
  const helperDeps: BatchHelperDeps = {
    spawnStep: (command, env, input, onStdout, onStderr) => {
      let resolve!: (value: { exitCode: number | null }) => void;
      const exited = new Promise<{ exitCode: number | null }>((r) => (resolve = r));
      const step: FakeStep = { command: [...command], env, input, signals: [], out: onStdout, err: onStderr, exit: (exitCode) => resolve({ exitCode }) };
      steps.push(step);
      if (options.autoExit !== false && input !== 'hang') setTimeout(() => step.exit(0), 5);
      const process: StepProcess = {
        exited,
        killGroup: (signal) => {
          step.signals.push(signal);
          if (signal === 'SIGTERM') step.exit(null);
        },
      };
      return process;
    },
    runQuiet: async (command) => {
      quiet.push([...command]);
      order.push(command.join(' '));
    },
    fs: {
      lstatSync: ((path: string) => {
        // Review round 2 of PR #80, B-R2-2: CONFIG_FOLDER may be a symbolic link or missing.
        if (path === CONFIG_FOLDER && options.configFolder === 'missing') throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        if (path === CONFIG_FOLDER && options.configFolder === 'cutOff') return { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700, uid: 0, gid: 0 };
        if (path === CONFIG_FOLDER && options.configFolder === 'symlink') return { isDirectory: () => false, isSymbolicLink: () => true, mode: 0o120777, uid: 1000, gid: 1000 };
        // User decision of 2026-10-01: Compose reads as the repository owner (the owner of /workspaces/hello).
        if (path === `${WORKSPACES_ROOT}/hello`) {
          if (options.repository === 'missing') throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
          if (options.repository === 'symlink') return { isDirectory: () => false, isSymbolicLink: () => true, mode: 0o120777, uid: 1000, gid: 1000 };
          const id = options.repository === 'root' ? 0 : 1000;
          return { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40755, uid: id, gid: id };
        }
        // CONFIG_FOLDER belongs to the owner of the repository, as GIT_FILES_SCRIPT leaves it.
        const owner = path === CONFIG_FOLDER ? 1000 : 0;
        return { isDirectory: () => true, isSymbolicLink: () => false, mode: path === WORKSPACES_ROOT ? (options.workspacesMode ?? 0o40755) : 0o40750, uid: owner, gid: owner };
      }) as never,
      chmodSync: ((path: string, mode: number) => {
        fsCalls.push(`chmod ${path} ${mode.toString(8)}`);
        order.push(`chmod ${path} ${mode.toString(8)}`);
      }) as never,
      chownSync: ((path: string, uid: number, gid: number) => fsCalls.push(`chown ${path} ${uid}:${gid}`)) as never,
      readdirSync: (() => ['github-token']) as never,
      rmSync: ((path: string) => fsCalls.push(`rm ${path}`)) as never,
      mkdirSync: ((path: string, mkdirOptions: { mode: number }) => fsCalls.push(`mkdir ${path} ${mkdirOptions.mode.toString(8)}`)) as never,
    },
    env: { PATH: '/usr/bin', HOME: '/root', DOCKER_HOST: 'tcp://elsewhere:2375', COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'true' },
  };
  const helperChild = (onStdout: (text: string) => void): ServerChild => {
    let resolveExit!: (value: { exitCode: number | null }) => void;
    const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
    const helper = new ChannelServer({
      write: (text) => {
        onStdout(text);
        return true;
      },
      spawnDocker: () => {
        throw new Error('The helper runs no Docker call of its own.');
      },
      operations: batchHelperOperations(helperDeps),
      exit: (code) => resolveExit({ exitCode: code }),
      killGraceMs: 50,
    });
    servers.push(helper);
    helper.start();
    helperExit = (code) => {
      helper.shutdown();
      resolveExit({ exitCode: code });
    };
    const feed = afterLoader((text) => helper.input(text), (line) => bundles.push(line));
    // Review round 3 of PR #80, B-R3-1: what arrives before options.lateHello settles waits for it, in its order.
    let late = options.lateHello !== undefined;
    const waiting: Array<() => void> = [];
    void options.lateHello?.then(() => {
      late = false;
      for (const next of waiting.splice(0)) next();
    });
    const inOrder = (next: () => void) => (late ? waiting.push(next) : next());
    return {
      write: (text) => {
        inOrder(() => feed(text));
        return true;
      },
      end: (input) =>
        inOrder(() => {
          if (input !== undefined) feed(input);
          helperEvents.push({ event: 'inputEnded', at: Date.now() });
          helper.inputEnded();
        }),
      kill: (signal) => {
        if (options.lateHello !== undefined) {
          helperEvents.push({ event: `kill ${signal}`, at: Date.now() });
          if (signal !== 'SIGKILL') return;
        } else helperEvents.push({ event: 'kill', at: Date.now() });
        helper.shutdown();
      },
      exited,
    };
  };
  // Review round 1 of PR #80 (B-R1-12): a helper that ignores the end of its input and ends only by a kill.
  const stubbornChild = (onStdout: (text: string) => void): ServerChild => {
    let resolveExit!: (value: { exitCode: number | null }) => void;
    const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
    const feed = afterLoader(
      (text) => {
        if (options.helper !== 'wrongProtocol' || !text.includes('"hello"')) return;
        helperEvents.push({ event: 'hello', at: Date.now() });
        onStdout(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION + 1, node: 'v24', ops: [] }));
      },
      (line) => bundles.push(line),
    );
    return {
      write: (text) => {
        feed(text);
        return true;
      },
      end: () => helperEvents.push({ event: 'inputEnded', at: Date.now() }),
      kill: (signal) => {
        helperEvents.push({ event: `kill ${signal}`, at: Date.now() });
        resolveExit({ exitCode: null });
      },
      exited,
    };
  };
  const spawnDocker: SpawnDocker = (args, onStdout) => {
    calls.push([...args]);
    if (args[0] === 'run') return options.helper === 'silent' || options.helper === 'wrongProtocol' ? stubbornChild(onStdout) : helperChild(onStdout);
    let stdout = '';
    let exitCode = 0;
    if (args[0] === 'volume') {
      if (args[args.length - 1] === VOLUME) stdout = `${VOLUME}\n`;
      // An answer without the name of the volume counts as missing too.
      else if (args[args.length - 1] !== 'devenv-unnamed') exitCode = 1;
    }
    if (args[0] === 'ps') stdout = options.psOutput ?? '0123456789abcdef0123456789abcdef\n';
    return {
      end: () => {},
      kill: () => {},
      exited: new Promise((resolve) =>
        setTimeout(() => {
          if (stdout !== '') onStdout(stdout);
          resolve({ exitCode });
        }, 1),
      ),
    };
  };
  const deps: BatchDeps = { sessions: new Map(), readScript: () => HELPER_SCRIPT, ...options.deps };
  // Review round 1 of PR #80 (B-R1-11): the options of each Docker call of the batch operation.
  const batch = batchOperation(deps);
  const recordedBatch: typeof batch = (params, context) =>
    batch(params, {
      ...context,
      docker: (args, dockerOptionsOfCall) => {
        dockerOptions.push({ args, options: dockerOptionsOfCall });
        return context.docker(args, dockerOptionsOfCall);
      },
    });
  let toClient: (text: string) => void = () => {};
  const worker = new ChannelServer({
    write: (text) => {
      toClient(text);
      return true;
    },
    spawnDocker,
    operations: { [OP_BATCH]: recordedBatch, [OP_BATCH_STEP]: batchStepOperation(deps), [OP_BATCH_CHUNK]: batchChunkOperation(deps) },
    exit: () => {},
    killGraceMs: options.workerKillGraceMs ?? 50,
  });
  servers.push(worker);
  worker.start();
  const toWorker = afterLoader((text) => worker.input(text), () => {});
  const process: StartedProcess = {
    write: (text) => {
      clientLines.push(...text.split('\n').filter((line) => line !== ''));
      // As through a pipe: later, never within the write.
      setImmediate(() => toWorker(text));
      return true;
    },
    end: () => worker.inputEnded(),
    kill: () => worker.shutdown(),
    onStdout: (listener) => (toClient = listener),
    onStderr: () => {},
    exited: new Promise(() => {}),
  };
  const logger: Logger = { info: (line) => logLines.push(line), warn: (line) => logLines.push(line), error: (line) => logLines.push(line), output: (text) => logLines.push(text) };
  const open = () => HelperChannel.open(process, 'WORKER', { logger, name: 'host' });
  return { calls, steps, quiet, order, fsCalls, logLines, clientLines, bundles, servers, deps, helperEvents, dockerOptions, open, helperDeps, helperExit: (code: number | null) => helperExit?.(code) };
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('the batch helper of the worker (plan step 6, PR B)', () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  async function started(options: SetupOptions = {}): Promise<{ t: ReturnType<typeof setup>; channel: HelperChannel; session: HelperBatchSession }> {
    const t = setup(options);
    const channel = await t.open();
    cleanup.push(() => {
      channel.close();
      for (const server of t.servers) server.shutdown();
    });
    const session = await channel.batch({ volume: VOLUME, image: IMAGE, socket: SOCKET });
    return { t, channel, session };
  }

  it('checks the volume, then starts exactly one helper with the pinned image, the session label and no variable', async () => {
    const { t, session } = await started();
    expect(t.calls[0]).toEqual(batchVolumeArgs(VOLUME));
    const runs = t.calls.filter((call) => call[0] === 'run');
    expect(runs).toEqual([batchRunArgs({ session: session.session, volume: VOLUME, image: IMAGE, socket: SOCKET, scriptHash: bundleHash(HELPER_SCRIPT) })]);
    expect(runs[0]).toContain(channelStepLabel(session.session));
    const options = runs[0].slice(0, runs[0].indexOf(IMAGE));
    expect(options).not.toContain('-e');
    expect(options).not.toContain('--env');
    expect(options.some((arg) => arg.startsWith('--env'))).toBe(false);
    // The helper got the script of the worker as its first line (the pipe loader).
    expect(t.bundles).toEqual([JSON.stringify(HELPER_SCRIPT)]);
    await session.step('listConfigs', { repository: 'octo/hello' });
    await session.step('listConfigs', { repository: 'octo/hello' });
    expect(t.calls.filter((call) => call[0] === 'run')).toHaveLength(1);
  });

  it('refuses a missing volume and starts nothing (the volume is never created)', async () => {
    const t = setup();
    const channel = await t.open();
    cleanup.push(() => {
      channel.close();
      for (const server of t.servers) server.shutdown();
    });
    const failure = await channel.batch({ volume: 'devenv-missing', image: IMAGE, socket: SOCKET }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HelperOperationError);
    expect((failure as HelperOperationError).code).toBe(BATCH_MISSING_VOLUME_CODE);
    expect(t.calls).toEqual([batchVolumeArgs('devenv-missing')]);
    expect(t.deps.sessions.size).toBe(0);
    await expect(channel.batch({ volume: 'devenv-unnamed', image: IMAGE, socket: SOCKET })).rejects.toMatchObject({ code: BATCH_MISSING_VOLUME_CODE });
    expect(t.calls.filter((call) => call[0] === 'run')).toEqual([]);
  });

  it('relays a step: its command from the builders, its variables on the process only, its output masked everywhere', async () => {
    const { t, session } = await started({ autoExit: false });
    const seen: string[] = [];
    const running = session.step('up', UP, { secret: TOKEN, onOutput: (_stream, text) => seen.push(text) });
    await waitUntil(() => t.steps.length === 1, 'the step');
    const step = t.steps[0];
    const built = batchStepCommand('up', UP);
    expect(step.command).toEqual(built.command);
    expect(step.input).toBe(built.input);
    expect(step.env).toMatchObject({ PATH: '/usr/bin', COMPOSE_PROJECT_NAME: 'p', COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false', COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false' });
    expect(step.env.DOCKER_HOST).toBeUndefined();
    // The token split over two pieces of output.
    step.out(`log in with ${TOKEN.slice(0, 10)}`);
    step.out(`${TOKEN.slice(10)} done\n`);
    step.err(`warning ${TOKEN}\n`);
    step.exit(0);
    const result = await running;
    expect(result).toEqual({ exitCode: 0, stdout: 'log in with *** done\n', stderr: 'warning ***\n', timedOut: false });
    expect(seen.join('')).not.toContain(TOKEN);
    expect(t.logLines.join('\n')).not.toContain(TOKEN);
    // The token travels only in the `secret` field of the request.
    const request = t.clientLines.map((line) => parseClientMessage(line)).find((message) => message?.t === 'op' && message.op === OP_BATCH_STEP);
    expect(request).toMatchObject({ secret: TOKEN });
    expect(JSON.stringify((request as { params: unknown }).params)).not.toContain(TOKEN);
  });

  it('runs the clone as the Git user with the token only on its standard input, and cleans up after it', async () => {
    const { t, session } = await started();
    const result = await session.step('clone', { repository: 'octo/hello' }, { secret: TOKEN });
    expect(result.exitCode).toBe(0);
    const step = t.steps[0];
    expect(step.command).toEqual(['setpriv', ...gitPrivilegeArgs(), ...batchStepCommand('clone', { repository: 'octo/hello' }).command]);
    expect(step.input).toBe(TOKEN);
    expect(step.command.join(' ')).not.toContain(TOKEN);
    expect(Object.values(step.env).join(' ')).not.toContain(TOKEN);
    expect(step.env.HOME).toBe('/nonexistent');
    const uid = String(BATCH_GIT_UID);
    expect(t.fsCalls).toEqual([
      `chmod ${CONFIG_FOLDER} 700`,
      `chmod ${WORKSPACES_ROOT} 1777`,
      `chown ${SECRETS_FOLDER} ${uid}:${uid}`,
      `chown ${SECRETS_FOLDER} 0:0`,
      // Review round 2 of PR #80 (A-R2-3): the secrets tmpfs gets its mode back as well.
      `chmod ${SECRETS_FOLDER} 700`,
      `chmod ${WORKSPACES_ROOT} 755`,
      `chmod ${CONFIG_FOLDER} 750`,
      `rm ${SECRETS_FOLDER}/github-token`,
    ]);
    // Review round 1 of PR #80 (A-R1-1, A-R1-2): before the step, as root, the repair of a Git step whose cleanup was
    // cut off (its files get root; temporary clone folders older than 60 minutes go); after it, the temporary clone
    // folders of the Git user go too.
    expect(t.quiet).toEqual([
      ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-exec', 'chown', '-h', '0:0', '{}', '+'],
      ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', '.devenv-clone.*', '-mmin', '+60', '-exec', 'rm', '-rf', '{}', '+'],
      ['setpriv', ...gitPrivilegeArgs(), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'],
      ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', '.devenv-clone.*', '-user', uid, '-exec', 'rm', '-rf', '{}', '+'],
      ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-exec', 'chown', '-h', '0:0', '{}', '+'],
      ['find', '/', '/dev/shm', '-xdev', '-user', uid, '-prune', '-exec', 'rm', '-rf', '{}', '+'],
    ]);
    // Review round 1 of PR #80 (A-R1-1): the modes are restored right after the kill, before the slow walks.
    const kill = t.order.findIndex((entry) => entry.includes('kill -9 -1'));
    // Review round 2 of PR #80 (A-R2-3): the mode of the secrets tmpfs is restored first (the restores run in reverse).
    expect(t.order.slice(kill + 1, kill + 4)).toEqual([`chmod ${SECRETS_FOLDER} 700`, `chmod ${WORKSPACES_ROOT} 755`, `chmod ${CONFIG_FOLDER} 750`]);
    // A root step runs without setpriv and without the token. (User decision of 2026-10-01, agreed extension:
    // listConfigs runs as the repository owner now, so the root step here is gitFiles, and listConfigs gets the owner's
    // setpriv, without the token.)
    await session.step('gitFiles', { repository: 'octo/hello', identity: { name: 'n', email: 'e' } });
    expect(t.steps[1].command[0]).toBe('sh');
    expect(t.steps[1].input).toBeUndefined();
    await session.step('listConfigs', { repository: 'octo/hello' });
    expect(t.steps[2].command).toEqual(['setpriv', ...privilegeArgs(1000, 1000), ...batchStepCommand('listConfigs', { repository: 'octo/hello' }).command]);
    expect(t.steps[2].input).toBeUndefined();
  });

  // User decision of 2026-10-01 ("we shall run as the repo owner user. that is what a real user would do as well."; it
  // replaces option A, under which these steps ran as the unprivileged Git user): the Compose read steps run as the owner
  // of the repository folder (1000:1000 here), with HOME=/nonexistent and no secret. CONFIG_FOLDER (the owner's) is
  // root's and 0700 during the step and gets its owner and mode back; OVERRIDE_FOLDER is cleared, made new for the owner
  // (0700) and removed after the step; /workspaces is not opened. After the step only the owner's processes are killed:
  // no walk of the volume, no removal of the owner's files, no repair of a cut-off Git step.
  // User decision of 2026-10-01, agreed extension: readFiles, listConfigs and createFolders run as the owner the same way.
  it('runs the Compose read steps, readFiles, listConfigs and createFolders as the repository owner (user decision of 2026-10-01)', async () => {
    const { t, session } = await started();
    for (const [kind, params] of [
      ['composeModel', { repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' }],
      ['composeHash', { repository: 'octo/hello', model: '{}', project: 'p' }],
      ['readFiles', { repository: 'octo/hello', configPath: '.devcontainer/devcontainer.json' }],
      ['listConfigs', { repository: 'octo/hello' }],
      ['createFolders', { repository: 'octo/hello', folders: ['/workspaces/hello/data'] }],
    ] as const) {
      t.fsCalls.length = 0;
      t.quiet.length = 0;
      const index = t.steps.length;
      const result = await session.step(kind, params);
      expect(result.exitCode, kind).toBe(0);
      const step = t.steps[index];
      // User decision of 2026-10-01: Compose reads as the repository owner (was: setpriv as the Git user, option A).
      expect(step.command, kind).toEqual(['setpriv', ...privilegeArgs(1000, 1000), ...batchStepCommand(kind, params).command]);
      expect(privilegeArgs(1000, 1000)).toEqual(['--reuid', '1000', '--regid', '1000', '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--']);
      expect(step.env.HOME, kind).toBe('/nonexistent');
      if (kind === 'composeModel' || kind === 'composeHash') expect(step.env.COMPOSE_PROJECT_NAME, kind).toBe('p');
      expect(step.input, kind).toBe(batchStepCommand(kind, params).input);
      // User decision of 2026-10-01: Compose reads as the repository owner (CONFIG_FOLDER is also made root's for the
      // step, since it belongs to the owner; OVERRIDE_FOLDER is made new for the owner and removed after the step).
      expect(t.fsCalls, kind).toEqual([
        `chmod ${CONFIG_FOLDER} 700`,
        `chown ${CONFIG_FOLDER} 0:0`,
        `rm ${OVERRIDE_FOLDER}`,
        `mkdir ${OVERRIDE_FOLDER} 700`,
        `chown ${OVERRIDE_FOLDER} 1000:1000`,
        `rm ${OVERRIDE_FOLDER}`,
        `chown ${CONFIG_FOLDER} 1000:1000`,
        `chmod ${CONFIG_FOLDER} 750`,
      ]);
      // User decision of 2026-10-01: Compose reads as the repository owner. After its step only the kill of its
      // processes; never a walk of the volume, a removal of its files, or the repair of a cut-off Git step.
      expect(t.quiet, kind).toEqual([['setpriv', ...privilegeArgs(1000, 1000), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0']]);
    }
    // User decision of 2026-10-01, agreed extension (was: createFolders stays root): the steps that need the Docker
    // socket stay root, without setpriv.
    await session.step('up', UP);
    expect(t.steps.at(-1)!.command).toEqual(batchStepCommand('up', UP).command);
  });

  // User decision of 2026-10-01: Compose reads as the repository owner; a repository of root is read as root (no
  // setpriv, and no `kill -9 -1`, which would end the helper itself), with HOME=/nonexistent all the same.
  it('runs the Compose read steps as root when root owns the repository (user decision of 2026-10-01)', async () => {
    const { t, session } = await started({ repository: 'root' });
    const params = { repository: 'octo/hello', model: '{}', project: 'p' };
    expect((await session.step('composeHash', params)).exitCode).toBe(0);
    expect(t.steps[0].command).toEqual(batchStepCommand('composeHash', params).command);
    expect(t.steps[0].env.HOME).toBe('/nonexistent');
    expect(t.fsCalls).toEqual([
      `chmod ${CONFIG_FOLDER} 700`,
      `chown ${CONFIG_FOLDER} 0:0`,
      `rm ${OVERRIDE_FOLDER}`,
      `mkdir ${OVERRIDE_FOLDER} 700`,
      `rm ${OVERRIDE_FOLDER}`,
      `chown ${CONFIG_FOLDER} 1000:1000`,
      `chmod ${CONFIG_FOLDER} 750`,
    ]);
    expect(t.quiet).toEqual([]);
  });

  for (const repository of ['symlink', 'missing'] as const) {
    // Review round 5 of PR #82 (A-R5-1): a repository folder that is not a real folder runs the step as nobody (never as
    // root), so that its script reports it as before (no configuration); the session is not refused.
    it(`runs a step as nobody when the repository folder is ${repository === 'symlink' ? 'a symbolic link' : 'missing'} (A-R5-1)`, async () => {
      const { t, session } = await started({ repository });
      const params = { repository: 'octo/hello', configPath: '.devcontainer/devcontainer.json' };
      expect((await session.step('readFiles', params)).exitCode).toBe(0);
      expect(t.steps[0].command).toEqual(['setpriv', ...privilegeArgs(65534, 65534), ...batchStepCommand('readFiles', params).command]);
      expect(t.fsCalls).toContain(`chown ${OVERRIDE_FOLDER} 65534:65534`);
      expect(t.quiet).toEqual([['setpriv', ...privilegeArgs(65534, 65534), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0']]);
      expect((await session.step('listConfigs', { repository: 'octo/hello' })).exitCode).toBe(0);
    });
  }

  // Review round 5 of PR #82 (A-R5-2): a CONFIG_FOLDER that a killed owner step left root:root 0700 goes back to the owner.
  it('gives a cut-off CONFIG_FOLDER back to the repository owner with 0755 after an owner step (A-R5-2)', async () => {
    const { t, session } = await started({ configFolder: 'cutOff' });
    expect((await session.step('listConfigs', { repository: 'octo/hello' })).exitCode).toBe(0);
    expect(t.fsCalls.slice(-2)).toEqual([`chown ${CONFIG_FOLDER} 1000:1000`, `chmod ${CONFIG_FOLDER} 755`]);
  });

  // Review round 5 of PR #82 (A-R5-3): the restore of CONFIG_FOLDER runs also when the removal of OVERRIDE_FOLDER throws.
  it('restores CONFIG_FOLDER also when the removal of OVERRIDE_FOLDER fails after an owner step (A-R5-3)', async () => {
    const { t, session } = await started();
    const { helperDeps } = t;
    let removals = 0;
    const rmSync = helperDeps.fs.rmSync;
    helperDeps.fs.rmSync = ((path: string, options: unknown) => {
      removals += 1;
      if (removals === 2) throw new Error('EBUSY');
      return (rmSync as (p: string, o: unknown) => void)(path, options);
    }) as never;
    await expect(session.step('listConfigs', { repository: 'octo/hello' })).rejects.toMatchObject({ code: 'failed' });
    expect(t.fsCalls.slice(-2)).toEqual([`chown ${CONFIG_FOLDER} 1000:1000`, `chmod ${CONFIG_FOLDER} 750`]);
  });

  // Review round 1 of PR #82, A-R1-2: a Git step is cut off only when the whole helper is killed, so the repair runs once
  // per helper process; a writing Git step still walks the volume after it, every time.
  it('repairs a cut-off Git step only before the first Git step of the helper, and walks the volume after every writing Git step', async () => {
    const { t, session } = await started();
    const uid = String(BATCH_GIT_UID);
    const repair = ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-exec', 'chown', '-h', '0:0', '{}', '+'];
    const oldClones = ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', '.devenv-clone.*', '-mmin', '+60', '-exec', 'rm', '-rf', '{}', '+'];
    const afterWritingStep = [
      ['setpriv', ...gitPrivilegeArgs(), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'],
      ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', '.devenv-clone.*', '-user', uid, '-exec', 'rm', '-rf', '{}', '+'],
      ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-exec', 'chown', '-h', '0:0', '{}', '+'],
      ['find', '/', '/dev/shm', '-xdev', '-user', uid, '-prune', '-exec', 'rm', '-rf', '{}', '+'],
    ];
    expect((await session.step('clone', { repository: 'octo/hello' }, { secret: TOKEN })).exitCode).toBe(0);
    expect(t.quiet).toEqual([repair, oldClones, ...afterWritingStep]);
    t.quiet.length = 0;
    expect((await session.step('clone', { repository: 'octo/hello' }, { secret: TOKEN })).exitCode).toBe(0);
    expect(t.quiet).toEqual(afterWritingStep);
    // A step that timed out is not cut off: its cleanup ran, and the next Git step does not repair either. (User decision
    // of 2026-10-01: Compose reads as the repository owner, so the Git step that times out is a clone now, not composeHash;
    // the fake step of a clone hangs on the secret `hang`.)
    t.quiet.length = 0;
    expect(await session.step('clone', { repository: 'octo/hello' }, { secret: 'hang', timeoutMs: 100 })).toMatchObject({ timedOut: true });
    expect(t.quiet).toEqual(afterWritingStep);
    t.quiet.length = 0;
    expect((await session.step('clone', { repository: 'octo/hello' }, { secret: TOKEN })).exitCode).toBe(0);
    // Exactly the cleanup, with no repair before it (the repair has the command of the chown walk, so the exact list
    // is the check; the removal of old clones belongs to the repair alone).
    expect(t.quiet).toEqual(afterWritingStep);
    expect(t.quiet.filter((call) => JSON.stringify(call) === JSON.stringify(repair))).toHaveLength(1);
    expect(t.quiet).not.toContainEqual(oldClones);
  });

  it('repairs a cut-off Git step again in a new helper process', async () => {
    const uid = String(BATCH_GIT_UID);
    const repair = ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-exec', 'chown', '-h', '0:0', '{}', '+'];
    for (let round = 0; round < 2; round += 1) {
      // Review round 1 of PR #82, A-R1-2: the flag lives in the helper process, so each new helper repairs once.
      const { t, session } = await started();
      // User decision of 2026-10-01: Compose reads as the repository owner, so the first Git step is a clone (was:
      // composeHash, which ran as the Git user under option A).
      await session.step('clone', { repository: 'octo/hello' }, { secret: TOKEN });
      await session.step('clone', { repository: 'octo/hello' }, { secret: TOKEN });
      // The repair is the first walk; the chown walk after each clone has the same command, so only the first is the repair.
      expect(t.quiet[0], `helper ${round}`).toEqual(repair);
      expect(t.quiet.filter((call) => JSON.stringify(call) === JSON.stringify(repair)), `helper ${round}`).toHaveLength(3);
    }
  });

  it('never leaves /workspaces sticky or writable for others, also after a Git step whose cleanup was cut off', async () => {
    // Review round 1 of PR #80 (A-R1-1): a kill of the whole helper left /workspaces at 1777; the next Git step must not
    // take that for the mode to restore.
    const { t, session } = await started({ workspacesMode: 0o41777 });
    await session.step('clone', { repository: 'octo/hello' }, { secret: TOKEN });
    expect(t.fsCalls).toContain(`chmod ${WORKSPACES_ROOT} 1777`);
    expect(t.fsCalls.filter((call) => call.startsWith(`chmod ${WORKSPACES_ROOT} `)).at(-1)).toBe(`chmod ${WORKSPACES_ROOT} 755`);
  });

  for (const configFolder of ['symlink', 'missing'] as const) {
    it(`review round 2 of PR #80, B-R2-2: a Git step never chmods CONFIG_FOLDER when it is a ${configFolder === 'symlink' ? 'symbolic link' : 'missing path'} (R23, R24)`, async () => {
      // A link planted as /workspaces/.devenv+ would otherwise give its target 0700 and then the link's own mode (0777).
      const { t, session } = await started({ configFolder });
      const result = await session.step('clone', { repository: 'octo/hello' }, { secret: TOKEN });
      expect(result.exitCode).toBe(0);
      expect(t.fsCalls.filter((call) => call.includes(CONFIG_FOLDER))).toEqual([]);
      const uid = String(BATCH_GIT_UID);
      expect(t.fsCalls).toEqual([
        `chmod ${WORKSPACES_ROOT} 1777`,
        `chown ${SECRETS_FOLDER} ${uid}:${uid}`,
        `chown ${SECRETS_FOLDER} 0:0`,
        // Review round 2 of PR #80 (A-R2-3): the secrets tmpfs gets its mode back as well.
        `chmod ${SECRETS_FOLDER} 700`,
        `chmod ${WORKSPACES_ROOT} 755`,
        `rm ${SECRETS_FOLDER}/github-token`,
      ]);
    });
  }

  it('refuses unknown kinds, a secret for a step without one, and a clone without one', async () => {
    const { t, channel, session } = await started();
    await expect(session.step('docker' as never, { args: ['ps'] })).rejects.toMatchObject({ name: 'HelperChannelError', code: 'unsendable' });
    // Sent directly, the worker refuses the kind before the helper sees it.
    await expect(channel.operation(OP_BATCH_STEP, { session: session.session, kind: 'docker', params: { args: ['ps'] } }, { reserved: true })).rejects.toMatchObject({ code: 'invalid' });
    await expect(channel.operation(OP_BATCH_STEP, { session: session.session, kind: 'listConfigs', params: { repository: 'octo/hello', command: ['id'] } }, { reserved: true })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(session.step('listConfigs', { repository: 'octo/hello' }, { secret: TOKEN })).rejects.toMatchObject({ code: 'invalid' });
    await expect(session.step('clone', { repository: 'octo/hello' })).rejects.toMatchObject({ code: 'invalid' });
    expect(t.steps).toHaveLength(0);
  });

  it('sends an input longer than one request in pieces before the step, and refuses one beyond the limit', async () => {
    const { t, session } = await started();
    const big = { ...UP, override: { text: 'ä'.repeat(300_000) } };
    await session.step('up', big);
    const ops = t.clientLines.map((line) => parseClientMessage(line)).filter((message) => message?.t === 'op').map((message) => (message as { op: string }).op);
    expect(ops.filter((op) => op === OP_BATCH_CHUNK).length).toBeGreaterThan(5);
    expect(ops.indexOf(OP_BATCH_STEP)).toBeGreaterThan(ops.lastIndexOf(OP_BATCH_CHUNK));
    expect(t.steps[0].input).toBe(batchStepCommand('up', big).input);
    expect(t.deps.sessions.get(session.session)?.inputSize).toBe(0);
    // Review round 1 of PR #80 (B-R1-15): the consumed input is gone from the map too, not only from the count (W24).
    expect(t.deps.sessions.get(session.session)?.inputs.size).toBe(0);
    await expect(session.step('up', { ...UP, override: { text: 'x'.repeat(MAX_BATCH_INPUT_CHARACTERS) } })).rejects.toMatchObject({ code: 'unsendable' });
    expect(t.steps).toHaveLength(1);
  });

  it('ends a step at its time limit alone (its group), and the session goes on', async () => {
    const { t, session } = await started();
    const result = await session.step('composeHash', { repository: 'octo/hello', model: 'hang', project: 'p' }, { timeoutMs: 100 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(t.steps[0].signals[0]).toBe('SIGTERM');
    expect(await session.step('listConfigs', { repository: 'octo/hello' })).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('forwards the cancel of a step to the helper, and the session goes on', async () => {
    const { t, session } = await started({ autoExit: false });
    const controller = new AbortController();
    const running = session.step('listConfigs', { repository: 'octo/hello' }, { signal: controller.signal });
    await waitUntil(() => t.steps.length === 1, 'the step');
    controller.abort();
    const error = await running.catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(t.steps[0].signals).toContain('SIGTERM');
    const next = session.step('listConfigs', { repository: 'octo/hello' });
    await waitUntil(() => t.steps.length === 2, 'the next step');
    t.steps[1].exit(3);
    expect(await next).toMatchObject({ exitCode: 3 });
  });

  it('runs one step at a time', async () => {
    const { t, session } = await started({ autoExit: false });
    const first = session.step('listConfigs', { repository: 'octo/hello' });
    await waitUntil(() => t.steps.length === 1, 'the step');
    await expect(session.step('listConfigs', { repository: 'octo/hello' })).rejects.toMatchObject({ code: 'busy' });
    t.steps[0].exit(0);
    await first;
  });

  it('the helper itself also runs one step at a time', async () => {
    // The table of the helper alone, without the worker in front of it.
    const steps: Array<() => void> = [];
    const operations = batchHelperOperations({
      spawnStep: () => {
        let done!: (value: { exitCode: number | null }) => void;
        steps.push(() => done({ exitCode: 0 }));
        return { exited: new Promise((resolve) => (done = resolve)), killGroup: () => {} };
      },
      runQuiet: async () => {},
      // User decision of 2026-10-01 (agreed extension): listConfigs and readFiles run as the repository owner, so the
      // helper reads the owner of the repository folder; every change is a no-op.
      fs: {
        lstatSync: (() => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40755, uid: 1000, gid: 1000 })) as never,
        chmodSync: (() => {}) as never,
        chownSync: (() => {}) as never,
        readdirSync: (() => []) as never,
        rmSync: (() => {}) as never,
        mkdirSync: (() => {}) as never,
      },
      env: {},
    });
    const context = {
      signal: new AbortController().signal,
      secret: undefined,
      progress: () => {},
      log: () => {},
      output: () => {},
      docker: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const first = operations.listConfigs({ repository: 'octo/hello' }, context);
    await expect(operations.readFiles({ repository: 'octo/hello', configPath: 'a.json' }, context)).rejects.toMatchObject({ code: 'busy' });
    steps[0]();
    expect(await first).toEqual({ exitCode: 0 });
  });

  it('the worker refuses a second step of a session while one runs, before the helper sees it', async () => {
    const { t, channel, session } = await started({ autoExit: false });
    const first = session.step('listConfigs', { repository: 'octo/hello' });
    await waitUntil(() => t.steps.length === 1, 'the step');
    const helperOps = () => t.logLines.filter((line) => line.includes('[batch ') && line.includes(': started.')).length;
    const before = helperOps();
    await expect(channel.operation(OP_BATCH_STEP, { session: session.session, kind: 'listConfigs', params: { repository: 'octo/hello' } }, { reserved: true })).rejects.toMatchObject({ code: 'busy' });
    expect(helperOps()).toBe(before);
    t.steps[0].exit(0);
    await first;
  });

  it('close ends the helper and removes its container by the session label', async () => {
    const { t, session } = await started();
    await session.close();
    await waitUntil(() => t.calls.some((call) => call[0] === 'rm'), 'the removal');
    expect(t.calls).toContainEqual(['ps', '-aq', '--no-trunc', '--filter', `label=${channelStepLabel(session.session)}`]);
    expect(t.deps.sessions.size).toBe(0);
    await expect(session.step('listConfigs', { repository: 'octo/hello' })).rejects.toBeInstanceOf(HelperOperationError);
  });

  it('reports the end of the helper as lost, and removes what is left by the label', async () => {
    const { t, session } = await started();
    t.helperExit(1);
    expect(await session.lost).toMatch(/batch helper ended/);
    await waitUntil(() => t.calls.some((call) => call[0] === 'rm'), 'the removal');
    expect(t.deps.sessions.size).toBe(0);
  });

  it('reports the ready step and refuses a batch with invalid parameters before sending it', async () => {
    const t = setup();
    const channel = await t.open();
    cleanup.push(() => {
      channel.close();
      for (const server of t.servers) server.shutdown();
    });
    for (const p of [
      { volume: '-v', image: IMAGE, socket: SOCKET },
      { volume: VOLUME, image: 'devenv-helper:latest', socket: SOCKET },
      { volume: VOLUME, image: IMAGE, socket: '/a,readonly=false' },
      { volume: VOLUME, image: IMAGE, socket: 'relative.sock' },
    ]) {
      await expect(channel.batch(p)).rejects.toBeInstanceOf(HelperChannelError);
    }
    expect(t.calls).toEqual([]);
    const session = await channel.batch({ volume: VOLUME, image: IMAGE, socket: SOCKET });
    expect(t.logLines.some((line) => line.includes(`batch#`) && line.includes(BATCH_READY_STEP))).toBe(true);
    await session.close();
  });

  /** Review round 1 of PR #80: settles with `promise`, or with 'pending' after `ms` (a hang fails the test, quickly). */
  function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
    return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
  }

  /** Review round 1 of PR #80: an open channel to the worker of `t`, closed after the test. */
  async function channelOf(t: ReturnType<typeof setup>): Promise<HelperChannel> {
    const channel = await t.open();
    cleanup.push(() => {
      channel.close();
      for (const server of t.servers) server.shutdown();
    });
    return channel;
  }

  it('review round 1 of PR #80, B-R1-9: the worker refuses a batch beyond its cap as busy and starts nothing (W3, W4, C32)', async () => {
    expect(MAX_CONCURRENT_BATCHES).toBe(8);
    // Review round 2 of PR #80, B-R2-4 (C47): the input cap of a step bounds the worker's memory per session (8 sessions).
    expect(MAX_BATCH_INPUT_CHARACTERS).toBe(3 * 1024 * 1024);
    const t = setup();
    const channel = await channelOf(t);
    // The batches of other windows on this worker.
    for (let i = 0; i < MAX_CONCURRENT_BATCHES; i++) t.deps.sessions.set(`other-${i}`, { inputs: new Map(), inputSize: 0 });
    await expect(channel.batch({ volume: VOLUME, image: IMAGE, socket: SOCKET })).rejects.toMatchObject({ code: 'busy' });
    expect(t.calls).toEqual([]);
    expect(t.deps.sessions.size).toBe(MAX_CONCURRENT_BATCHES);
    // One below the cap, it starts.
    t.deps.sessions.delete('other-0');
    const session = await channel.batch({ volume: VOLUME, image: IMAGE, socket: SOCKET });
    expect(t.calls.filter((call) => call[0] === 'run')).toHaveLength(1);
    await session.close();
  });

  it('review round 1 of PR #80, B-R1-10: a second batch with the same session is refused as invalid, and the first goes on (W2)', async () => {
    const { t, channel, session } = await started();
    const controller = new AbortController();
    const second = channel.operation(OP_BATCH, { session: session.session, volume: VOLUME, image: IMAGE, socket: SOCKET }, { signal: controller.signal }).catch((error: unknown) => error);
    const outcome = await within(second, 5_000);
    controller.abort();
    expect(outcome).toBeInstanceOf(HelperOperationError);
    expect((outcome as HelperOperationError).code).toBe('invalid');
    expect(t.calls.filter((call) => call[0] === 'run')).toHaveLength(1);
    expect(await session.step('listConfigs', { repository: 'octo/hello' })).toMatchObject({ exitCode: 0 });
  });

  it('review round 1 of PR #80, B-R1-11: the channel traffic of the helper is not kept as the stdout of its docker run (W10)', async () => {
    const { t } = await started();
    const runs = t.dockerOptions.filter((call) => call.args[0] === 'run');
    expect(runs).toHaveLength(1);
    expect(runs[0].options?.discardStdout).toBe(true);
  });

  it('review round 1 of PR #80, B-R1-12: at its hold limit the batch fails as timeout, the helper input ends, its container goes (W11, W13)', async () => {
    const { t, session } = await started({ deps: { holdLimitMs: 300 } });
    const reason = await within(session.lost, 10_000);
    expect(reason).toMatch(/longest time/);
    await waitUntil(() => t.calls.some((call) => call[0] === 'rm'), 'the removal', 10_000);
    expect(t.helperEvents.map((entry) => entry.event)).toContain('inputEnded');
    expect(t.calls).toContainEqual(['ps', '-aq', '--no-trunc', '--filter', `label=${channelStepLabel(session.session)}`]);
    expect(t.calls).toContainEqual(['rm', '-f', '0123456789abcdef0123456789abcdef']);
    expect(t.deps.sessions.size).toBe(0);
  });

  it('review round 1 of PR #80, B-R1-12: a helper that never answers fails the open at its time limit and is killed (W11)', async () => {
    const t = setup({ helper: 'silent', deps: { openTimeoutMs: 300 } });
    const channel = await channelOf(t);
    const outcome = await within(
      channel.batch({ volume: VOLUME, image: IMAGE, socket: SOCKET }).catch((error: unknown) => error),
      10_000,
    );
    expect(outcome).toBeInstanceOf(HelperOperationError);
    expect((outcome as HelperOperationError).code).toBe('failed');
    expect(t.helperEvents.map((entry) => entry.event)).toContain('kill SIGTERM');
    expect(t.deps.sessions.size).toBe(0);
  });

  it(
    'review round 1 of PR #80, B-R1-12: a helper whose open failed is killed at once, not only after the close of its input (W14)',
    async () => {
      const t = setup({ helper: 'wrongProtocol' });
      const channel = await channelOf(t);
      const outcome = await within(
        channel.batch({ volume: VOLUME, image: IMAGE, socket: SOCKET }).catch((error: unknown) => error),
        15_000,
      );
      expect(outcome).toBeInstanceOf(HelperOperationError);
      expect((outcome as HelperOperationError).code).toBe('failed');
      const hello = t.helperEvents.find((entry) => entry.event === 'hello');
      const kill = t.helperEvents.find((entry) => entry.event === 'kill SIGTERM');
      expect(hello).toBeDefined();
      expect(kill).toBeDefined();
      // The close of the channel alone kills it only after CHANNEL_CLOSE_KILL_MS (5 s): a generous margin below that.
      expect(kill!.at - hello!.at).toBeLessThan(4_000);
    },
    30_000,
  );

  it('review round 1 of PR #80, B-R1-13: the worker opens the helper channel with the long pong time limit (W20)', async () => {
    const open = vi.spyOn(HelperChannel, 'open');
    try {
      await started();
      const options = open.mock.calls.map((call) => call[2] as HelperChannelOptions).filter((o) => o.name.startsWith('batch '));
      expect(options).toHaveLength(1);
      expect(options[0].pongTimeoutMs).toBe(BATCH_HOLD_LIMIT_MS);
    } finally {
      open.mockRestore();
    }
  });

  it('review round 1 of PR #80, B-R1-14: a lost helper is looked up with ps -aq by its label, and only container IDs are removed (W18, W19)', async () => {
    const id = 'fedcba9876543210fedcba9876543210';
    const { t, session } = await started({ psOutput: `WARNING: something\n${id}\n\n` });
    t.helperExit(1);
    expect(await session.lost).toMatch(/batch helper ended/);
    await waitUntil(() => t.calls.some((call) => call[0] === 'rm'), 'the removal');
    const listed = t.calls.filter((call) => call[0] === 'ps');
    expect(listed.length).toBeGreaterThan(0);
    for (const call of listed) expect(call).toEqual(['ps', '-aq', '--no-trunc', '--filter', `label=${channelStepLabel(session.session)}`]);
    expect(t.calls.filter((call) => call[0] === 'rm')).toEqual([['rm', '-f', id]]);
  });

  it('review round 3 of PR #80, B-R3-1: a cancel during the open of the helper ends the batch once the open is done, not at its hold limit', async () => {
    let answer!: () => void;
    const lateHello = new Promise<void>((resolve) => (answer = resolve));
    // Long times: only the cancel can end this batch within the bounds below.
    const t = setup({ lateHello, workerKillGraceMs: 60_000, deps: { holdLimitMs: 60_000, openTimeoutMs: 60_000 } });
    const channel = await channelOf(t);
    const controller = new AbortController();
    const starting = channel.batch({ volume: VOLUME, image: IMAGE, socket: SOCKET }, controller.signal).catch((error: unknown) => error);
    await waitUntil(() => t.calls.some((call) => call[0] === 'run'), 'the docker run of the helper');
    controller.abort();
    // The worker took the cancel: its SIGTERM to the docker run, which the helper ignores.
    await waitUntil(() => t.helperEvents.some((entry) => entry.event === 'kill SIGTERM'), 'the SIGTERM of the cancel');
    // The helper answers its hello now: the open succeeds with the signal of the operation already aborted.
    answer();
    await waitUntil(() => t.helperEvents.some((entry) => entry.event === 'inputEnded'), 'the end of the helper input', 10_000);
    await waitUntil(() => t.deps.sessions.size === 0, 'the end of the session', 10_000);
    expect(t.helperEvents.map((entry) => entry.event)).not.toContain('kill SIGKILL');
    // The worker confirms the cancel once its operation ended.
    expect(isAbortError(await starting)).toBe(true);
  }, 30_000);
});
