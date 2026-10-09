// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the batch helper in one process: the worker's own batch session of a flow (workerBatchSession, with
// a fake OperationContext of its operation) and, as the run of the helper, a second ChannelServer with the step table of
// the helper (fake step processes and file system). Checked: one helper per session after the volume check (a missing
// volume is refused and nothing is started); a step (its command from the builders, its variables on the process only,
// its output masked); the token only as the secret of the step and the standard input of the clone, which runs as the
// Git user with the cleanup after it; unknown kinds refused; a long input; the time limit and the cancel of a step end
// that step alone; one step at a time; close and the end of the helper. Plan step 11I1, PR B1: before, the session was
// the extension's HelperChannel.batch through the worker's operations `batch`, `batchStep` and `batchChunk` (removed);
// the cases of that relay are gone, the others run on the worker's own session.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BATCH_GIT_UID, BATCH_HOLD_LIMIT_MS, BATCH_MISSING_VOLUME_CODE, MAX_BATCH_INPUT_CHARACTERS, batchRunSpec } from '../core/helperChannel/batch';
import { batchStepCommand } from '../core/helper/batchSteps';
import { OVERRIDE_FOLDER, SECRETS_FOLDER } from '../core/helper/scripts';
import { HelperChannel, HelperChannelError, type HelperBatchSession, type HelperChannelOptions } from '../core/helperChannel/helperChannel';
import { CHANNEL_PROTOCOL_VERSION, channelStepLabel, encodeMessage, parseClientMessage, type ClientMessage } from '../core/helperChannel/protocol';
import { bundleHash } from '../core/loader/pipeLoader';
import { CONFIG_FOLDER, WORKSPACES_ROOT } from '../core/names';
import { isAbortError } from '../core/ports';
import { workerBatchSession, type BatchDeps } from './batch';
import { batchHelperOperations, gitPrivilegeArgs, privilegeArgs, type BatchHelperDeps, type StepProcess } from './batchHelper';
// Follow-up of plan step 11I (the links of the owner): the descriptor calls of the helper on the fakes by paths.
import { withDescriptors } from './batchHelperFs.testkit';
import { ChannelServer, OperationError, type OperationContext } from './server';
import type { DockerEngine, EngineAttachedOptions, EngineAttachedRun, EngineAttachedSpec } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { contextSecrets } from './operationContext.testkit';

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
  /** Review round 1 of PR #80 (B-R1-12): the deps of the worker's batch helper (openTimeoutMs). */
  deps?: Partial<BatchDeps>;
  /**
   * Review round 1 of PR #80 (B-R1-12): the `docker run` of the helper: a ChannelServer (default); one that never
   * answers and ends only by a kill (`silent`); one that answers `hello` with another protocol version.
   */
  helper?: 'channel' | 'silent' | 'wrongProtocol';
  /**
   * Review round 1 of PR #80 (B-R1-14): the containers of the session label that the engine lists. Plan step 11G3: the
   * IDs of DockerEngine.containerIds (was: the output of `docker ps`).
   */
  listedIds?: string[];
  /**
   * Plan step 11G3: the time of the fake engine from the SIGTERM of a kill of the helper (`docker stop`) to its SIGKILL
   * (default: the stopSeconds of the run).
   */
  engineStopMs?: number;
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
  /**
   * User decision of 2026-10-01: Compose reads as the repository owner. What `lstat` of the repository folder
   * (/workspaces/hello) finds: a folder of 1000:1000 (default), of root, a symbolic link, or nothing.
   */
  repository?: 'user' | 'root' | 'symlink' | 'missing';
}

/**
 * The helper process behind the run of the fake engine: its input stays open. Plan step 11G3: its own type (was a
 * ServerChild of the worker's `docker run`, whose `write` is removed with it). Plan step 11I (PR A): written out, as
 * ServerChild is gone with the Docker calls of the server.
 */
interface HelperChild {
  write(text: string): boolean;
  /** Writes the input (if any) and closes the standard input. */
  end(input?: string): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  readonly exited: Promise<{ exitCode: number | null; error?: string }>;
}

function setup(options: SetupOptions = {}) {
  const calls: string[][] = [];
  const steps: FakeStep[] = [];
  const quiet: string[][] = [];
  const fsCalls: string[] = [];
  // The quiet commands and the file system calls in one order (review round 1 of PR #80, A-R1-1).
  const order: string[] = [];
  const logLines: string[] = [];
  /** Plan step 11I1, PR B1: the lines that the worker's client wrote to the helper after the bundle (was: to the worker). */
  const helperLines: string[] = [];
  /** Plan step 11I1, PR B1: the progress of the operation of the session (step and detail). */
  const progress: string[] = [];
  const bundles: string[] = [];
  const servers: ChannelServer[] = [];
  // Review round 1 of PR #80 (B-R1-11, B-R1-12): what the helper child saw. Plan step 11I (PR A): the options of the
  // worker's Docker calls are gone with OperationContext.docker (the operation cannot make one).
  const helperEvents: Array<{ event: string; at: number }> = [];
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
    fs: withDescriptors({
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
    }),
    env: { PATH: '/usr/bin', HOME: '/root', DOCKER_HOST: 'tcp://elsewhere:2375', COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'true' },
  };
  const helperChild = (onStdout: (text: string) => void): HelperChild => {
    let resolveExit!: (value: { exitCode: number | null }) => void;
    const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
    const helper = new ChannelServer({
      write: (text) => {
        onStdout(text);
        return true;
      },
      // Plan step 11I (PR A): no `spawnDocker` (the server starts no Docker call) and no `killGraceMs` (the grace of the
      // SIGKILL of such a call; the hard deadline of the shutdown is SHUTDOWN_DEADLINE_MS, which no test here reaches).
      operations: batchHelperOperations(helperDeps),
      exit: (code) => resolveExit({ exitCode: code }),
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
    let bundled = false;
    return {
      write: (text) => {
        // The first line is the bundle; the rest are the messages of the worker's client.
        const lines = text.split('\n').filter((line) => line !== '');
        helperLines.push(...(bundled ? lines : lines.slice(1)));
        bundled = true;
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
  const stubbornChild = (onStdout: (text: string) => void): HelperChild => {
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
  // Plan step 11G3: changed setup: the helper runs over the port of the engine (the inspect of the volume, runAttached,
  // and the removal by the label with containerIds and removeContainer), which records its calls in `calls` as
  // ['inspect', 'volume', <name>], ['run', <name>], ['ps', <label>] and ['rm', <id>]; the worker's ChannelServer gets no
  // Docker call of the batch helper (was: `docker volume inspect`, `docker run`, `docker ps`, `docker rm`).
  const runs: Array<{ spec: EngineAttachedSpec; options: EngineAttachedOptions }> = [];
  /** The helper as a run of the port: its process over the child, a kill as `docker stop` (SIGTERM, later SIGKILL) and removal. */
  const runOf = (spec: EngineAttachedSpec, runOptions: EngineAttachedOptions): EngineAttachedRun => {
    let toStdout: (text: string) => void = () => {};
    const child = options.helper === 'silent' || options.helper === 'wrongProtocol' ? stubbornChild((text) => toStdout(text)) : helperChild((text) => toStdout(text));
    let exited = false;
    void child.exited.then(() => (exited = true));
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      child.kill('SIGTERM');
      const timer = setTimeout(() => (exited ? undefined : child.kill('SIGKILL')), options.engineStopMs ?? (runOptions.stopSeconds ?? 10) * 1000);
      void child.exited.then(() => clearTimeout(timer));
    };
    if (runOptions.signal?.aborted) kill();
    else runOptions.signal?.addEventListener('abort', kill, { once: true });
    return {
      id: 'c'.repeat(64),
      process: {
        write: (text) => child.write(text),
        end: () => child.end(),
        kill,
        onStdout: (listener) => (toStdout = listener),
        onStderr: () => {},
        exited: child.exited.then(({ exitCode }) => ({ exitCode })),
      },
      pause: () => {},
      resume: () => {},
    };
  };
  const engine: DockerEngine = {
    ...unusedEngine(),
    inspect: async (kind, reference) => {
      calls.push(['inspect', kind, reference]);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (reference === VOLUME) return { Name: VOLUME };
      // An answer without the name of the volume counts as missing too.
      if (reference === 'devenv-unnamed') return {};
      return undefined;
    },
    runAttached: async (spec, runOptions = {}) => {
      calls.push(['run', spec.name]);
      runs.push({ spec, options: runOptions });
      return runOf(spec, runOptions);
    },
    containerIds: async (filters) => {
      calls.push(['ps', ...(filters.label ?? [])]);
      return options.listedIds ?? ['0123456789abcdef0123456789abcdef'];
    },
    removeContainer: async (container) => void calls.push(['rm', container]),
  };
  const deps: BatchDeps = { engineOf: () => engine, readScript: () => HELPER_SCRIPT, ...options.deps };
  // Plan step 11I1, PR B1: changed setup: the session is the worker's own (workerBatchSession) within a fake operation
  // of the worker (was: HelperChannel.batch of the extension through the worker's ChannelServer with `batch`, `batchStep`
  // and `batchChunk`); its log lines and progress are recorded. Plan step 11I (PR A): changed setup: no record of the
  // Docker calls of the operation (OperationContext.docker is removed, so it cannot make one; it runs over the port of
  // the engine).
  const operation = new AbortController();
  const context: OperationContext = {
    signal: operation.signal,
    ...contextSecrets(),
    progress: (step, detail) => progress.push(detail === undefined ? step : `${step} ${detail}`),
    log: (text) => logLines.push(text),
    output: () => {},
  };
  /** Opens a session of `p` (default: the volume, image and socket of the tests); `signal` ends its open. */
  const open = (p: { volume: string; image: string; socket: string } = { volume: VOLUME, image: IMAGE, socket: SOCKET }, signal?: AbortSignal) =>
    workerBatchSession(deps, signal === undefined ? context : { ...context, signal: AbortSignal.any([operation.signal, signal]) }, p);
  const helperOps = () => helperLines.map((line) => parseClientMessage(line)).filter((message): message is Extract<ClientMessage, { t: 'op' }> => message?.t === 'op');
  return {
    calls,
    runs,
    steps,
    quiet,
    order,
    fsCalls,
    logLines,
    progress,
    helperOps,
    bundles,
    servers,
    deps,
    helperEvents,
    open,
    end: () => operation.abort(),
    helperDeps,
    helperExit: (code: number | null) => helperExit?.(code),
  };
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

  /** A setup whose operation and helpers end after the test. */
  function tracked(options: SetupOptions = {}): ReturnType<typeof setup> {
    const t = setup(options);
    cleanup.push(() => {
      t.end();
      for (const server of t.servers) server.shutdown();
    });
    return t;
  }

  // Plan step 11I1, PR B1: changed setup: the worker's own session (was: HelperChannel.batch through the worker).
  async function started(options: SetupOptions = {}): Promise<{ t: ReturnType<typeof setup>; session: HelperBatchSession }> {
    const t = tracked(options);
    const session = await t.open();
    cleanup.unshift(() => void session.close());
    return { t, session };
  }

  it('checks the volume, then starts exactly one helper with the pinned image, the session label and no variable', async () => {
    const { t, session } = await started();
    // Plan step 11G3: changed expectation: the inspect of the volume and the run of the port (was: the arguments of
    // `docker volume inspect` and `docker run`); the spec of the run is batchRunSpec, with the session label and without
    // a variable (the spec has no field for one), and the run ends with the cancel of the operation.
    expect(t.calls[0]).toEqual(['inspect', 'volume', VOLUME]);
    const runs = t.calls.filter((call) => call[0] === 'run');
    expect(runs).toEqual([['run', `devenv-batch-${session.session}`]]);
    expect(t.runs.map((run) => run.spec)).toEqual([batchRunSpec({ session: session.session, volume: VOLUME, image: IMAGE, socket: SOCKET, scriptHash: bundleHash(HELPER_SCRIPT) })]);
    expect(t.runs[0].spec.labels[channelStepLabel(session.session).split('=')[0]]).toBe(session.session);
    expect(Object.keys(t.runs[0].spec)).not.toContain('env');
    expect(t.runs[0].options.signal).toBeDefined();
    // Plan step 11I (PR A): changed expectation: no check that the context got no Docker call (OperationContext.docker is
    // removed, so the session cannot make one); the run of the port above is the only start.
    // The helper got the script of the worker as its first line (the pipe loader).
    expect(t.bundles).toEqual([JSON.stringify(HELPER_SCRIPT)]);
    await session.step('listConfigs', { repository: 'octo/hello' });
    await session.step('listConfigs', { repository: 'octo/hello' });
    expect(t.calls.filter((call) => call[0] === 'run')).toHaveLength(1);
  });

  it('refuses a missing volume and starts nothing (the volume is never created)', async () => {
    const t = tracked();
    const failure = await t.open({ volume: 'devenv-missing', image: IMAGE, socket: SOCKET }).catch((error: unknown) => error);
    // Plan step 11I1, PR B1: changed expectation: the OperationError of the worker's own session (was: the
    // HelperOperationError of the extension's client, which the worker answered with that code).
    expect(failure).toBeInstanceOf(OperationError);
    expect((failure as OperationError).code).toBe(BATCH_MISSING_VOLUME_CODE);
    // Plan step 11G3: changed expectation: the inspect of the port (was: `docker volume inspect`).
    expect(t.calls).toEqual([['inspect', 'volume', 'devenv-missing']]);
    await expect(t.open({ volume: 'devenv-unnamed', image: IMAGE, socket: SOCKET })).rejects.toMatchObject({ code: BATCH_MISSING_VOLUME_CODE });
    expect(t.calls.filter((call) => call[0] === 'run')).toEqual([]);
  });

  it('relays a step: its command from the builders, its variables on the process only, its output masked everywhere', async () => {
    const { t, session } = await started({ autoExit: false });
    const seen: string[] = [];
    const running = session.step('up', UP, { secrets: { token: TOKEN }, onOutput: (_stream, text) => seen.push(text) });
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
    // The token travels only in the `secret` field of the request. Plan step 11I1, PR B1: changed expectation: the request
    // of the worker's client to the helper (was: the request `batchStep` of the extension to the worker).
    const request = t.helperOps().find((message) => message.op === 'up');
    // Plan step 11A: changed expectation (before: one `secret`): named secrets.
    expect(request).toMatchObject({ secrets: { token: TOKEN } });
    expect(JSON.stringify((request as { params: unknown }).params)).not.toContain(TOKEN);
  });

  it('runs the clone as the Git user with the token only on its standard input, and cleans up after it', async () => {
    const { t, session } = await started();
    const result = await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: TOKEN } });
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
    // Review round 1 of the follow-up of plan step 11I (A-F1): changed expectation (before: one `find … -exec chown -h 0:0
    // {} +` each time, whose chown resolved each whole path again, also through a link that replaced a folder): the
    // entries of the Git user at the top of the volume go to root with `chown -R` in the folder that find has open, then
    // its other files with `-execdir chown -h` (gitUserFilesToRootCommands).
    const toRoot = [
      ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-user', uid, '-execdir', 'chown', '-R', '-h', `--from=${uid}`, '0:0', '{}', '+'],
      ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-execdir', 'chown', '-h', '0:0', '{}', '+'],
    ];
    expect(t.quiet).toEqual([
      ...toRoot,
      ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', '.devenv-clone.*', '-mmin', '+60', '-exec', 'rm', '-rf', '{}', '+'],
      ['setpriv', ...gitPrivilegeArgs(), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'],
      ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', '.devenv-clone.*', '-user', uid, '-exec', 'rm', '-rf', '{}', '+'],
      ...toRoot,
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
    // Follow-up of plan step 11I (the links of the owner): changed expectation, gitFiles is a Node.js script (was sh),
    // still started directly, without setpriv.
    expect(t.steps[1].command[0]).toBe('node');
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
      // user decision 2026-10-02: Delete runs no Git: changed input, gitSummary (plan step 7, an owner step as well) is
      // no step any more.
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
      // Review round 1 of PR #84, A-R1-1: changed expectation (before: every owner step closed CONFIG_FOLDER): only the
      // Compose steps close it; readFiles, listConfigs and createFolders leave its owner and mode unchanged.
      const compose = kind === 'composeModel' || kind === 'composeHash';
      expect(batchStepCommand(kind, params).closeConfigFolder === true, kind).toBe(compose);
      expect(t.fsCalls, kind).toEqual([
        ...(compose ? [`chmod ${CONFIG_FOLDER} 700`, `chown ${CONFIG_FOLDER} 0:0`] : []),
        `rm ${OVERRIDE_FOLDER}`,
        `mkdir ${OVERRIDE_FOLDER} 700`,
        `chown ${OVERRIDE_FOLDER} 1000:1000`,
        `rm ${OVERRIDE_FOLDER}`,
        ...(compose ? [`chown ${CONFIG_FOLDER} 1000:1000`, `chmod ${CONFIG_FOLDER} 750`] : []),
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
  // Review round 1 of PR #84, A-R1-1: changed expectation (before: listConfigs closed CONFIG_FOLDER and gave it back
  // after the step): a step that does not close it repairs it at once, before the step, and touches it no more.
  it('gives a cut-off CONFIG_FOLDER back to the repository owner with 0755 after an owner step (A-R5-2)', async () => {
    const { t, session } = await started({ configFolder: 'cutOff' });
    expect((await session.step('listConfigs', { repository: 'octo/hello' })).exitCode).toBe(0);
    expect(t.fsCalls).toEqual([
      `chown ${CONFIG_FOLDER} 1000:1000`,
      `chmod ${CONFIG_FOLDER} 755`,
      `rm ${OVERRIDE_FOLDER}`,
      `mkdir ${OVERRIDE_FOLDER} 700`,
      `chown ${OVERRIDE_FOLDER} 1000:1000`,
      `rm ${OVERRIDE_FOLDER}`,
    ]);
  });

  // Review round 1 of PR #84, A-R1-1: the repair of a cut-off CONFIG_FOLDER applies to every owner step; a Compose step
  // closes it for the step and gives it back to the owner with 0755 afterwards, the others repair it before the step.
  for (const [kind, params] of [
    ['composeModel', { repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' }],
    ['composeHash', { repository: 'octo/hello', model: '{}', project: 'p' }],
    ['readFiles', { repository: 'octo/hello', configPath: '.devcontainer/devcontainer.json' }],
    ['listConfigs', { repository: 'octo/hello' }],
    ['createFolders', { repository: 'octo/hello', folders: ['/workspaces/hello/data'] }],
    // user decision 2026-10-02: Delete runs no Git: the case gitSummary is removed with its step.
  ] as const) {
    it(`review round 1 of PR #84, A-R1-1: ${kind} repairs a cut-off CONFIG_FOLDER (back to the owner with 0755)`, async () => {
      const { t, session } = await started({ configFolder: 'cutOff' });
      expect((await session.step(kind, params)).exitCode).toBe(0);
      const repair = [`chown ${CONFIG_FOLDER} 1000:1000`, `chmod ${CONFIG_FOLDER} 755`];
      if (kind === 'composeModel' || kind === 'composeHash') {
        expect(t.fsCalls.slice(0, 2)).toEqual([`chmod ${CONFIG_FOLDER} 700`, `chown ${CONFIG_FOLDER} 0:0`]);
        expect(t.fsCalls.slice(-2)).toEqual(repair);
      } else {
        expect(t.fsCalls.slice(0, 2)).toEqual(repair);
        expect(t.fsCalls.filter((call) => call.includes(CONFIG_FOLDER))).toEqual(repair);
      }
    });
  }

  // Review round 5 of PR #82 (A-R5-3): the restore of CONFIG_FOLDER runs also when the removal of OVERRIDE_FOLDER throws.
  // Review round 1 of PR #84, A-R1-1: changed step (before: listConfigs, which no longer closes CONFIG_FOLDER): a
  // Compose step, which still closes and restores it.
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
    await expect(session.step('composeModel', { repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' })).rejects.toMatchObject({ code: 'failed' });
    expect(t.fsCalls.slice(-2)).toEqual([`chown ${CONFIG_FOLDER} 1000:1000`, `chmod ${CONFIG_FOLDER} 750`]);
  });

  // Review round 5 of PR #82 (B-R5-1): the uid and the gid of the repository owner are kept apart (every other fake has
  // uid === gid). 1001:0 (an arbitrary uid with group root) runs as 1001:0, never as root; 0:1000 is root (decided by the
  // uid only). CONFIG_FOLDER gets its own uid:gid back, OVERRIDE_FOLDER is the owner's uid:gid.
  for (const [repoUid, repoGid] of [
    [1001, 0],
    [0, 1000],
  ] as const) {
    // Review round 1 of PR #84, A-R1-1: for readFiles (CONFIG_FOLDER left open, a cut-off one repaired before the step)
    // and composeModel (CONFIG_FOLDER closed for the step); before, readFiles alone, which closed it.
    for (const [configFolder, kind] of [
      ['folder', 'readFiles'],
      ['cutOff', 'readFiles'],
      ['folder', 'composeModel'],
      ['cutOff', 'composeModel'],
    ] as const) {
      it(`review round 5 of PR #82, B-R5-1: an owner step (${kind}) of a repository of ${repoUid}:${repoGid} (CONFIG_FOLDER ${configFolder}) keeps uid and gid apart`, async () => {
        const { t, session } = await started();
        const { helperDeps } = t;
        const lstatSync = helperDeps.fs.lstatSync as (path: string) => unknown;
        const folder = (uid: number, gid: number, mode: number) => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40000 | mode, uid, gid });
        Object.assign(helperDeps.fs, {
          lstatSync: (path: string) => {
            if (path === `${WORKSPACES_ROOT}/hello`) return folder(repoUid, repoGid, 0o755);
            if (path === CONFIG_FOLDER) return configFolder === 'cutOff' ? folder(0, 0, 0o700) : folder(1001, 1002, 0o750);
            return lstatSync(path);
          },
        });
        const params =
          kind === 'readFiles'
            ? { repository: 'octo/hello', configPath: '.devcontainer/devcontainer.json' }
            : { repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' };
        expect((await session.step(kind, params)).exitCode).toBe(0);
        const restored = configFolder === 'cutOff' ? [`chown ${CONFIG_FOLDER} ${repoUid}:${repoGid}`, `chmod ${CONFIG_FOLDER} 755`] : [`chown ${CONFIG_FOLDER} 1001:1002`, `chmod ${CONFIG_FOLDER} 750`];
        // Review round 1 of PR #84, A-R1-1: readFiles leaves CONFIG_FOLDER open (a cut-off one is repaired before the
        // step); composeModel closes it for the step and restores it after.
        const close = kind === 'composeModel';
        const before = close ? [`chmod ${CONFIG_FOLDER} 700`, `chown ${CONFIG_FOLDER} 0:0`] : configFolder === 'cutOff' ? restored : [];
        const after = close ? restored : [];
        if (repoUid === 0) {
          // Root (by the uid): no setpriv, no `kill -9 -1`, no chown of OVERRIDE_FOLDER.
          expect(t.steps[0].command).toEqual(batchStepCommand(kind, params).command);
          expect(t.quiet).toEqual([]);
          expect(t.fsCalls).toEqual([...before, `rm ${OVERRIDE_FOLDER}`, `mkdir ${OVERRIDE_FOLDER} 700`, `rm ${OVERRIDE_FOLDER}`, ...after]);
        } else {
          const privilege = ['--reuid', '1001', '--regid', '0', '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--'];
          expect(t.steps[0].command).toEqual(['setpriv', ...privilege, ...batchStepCommand(kind, params).command]);
          expect(t.quiet).toEqual([['setpriv', ...privilege, 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0']]);
          expect(t.fsCalls).toEqual([
            ...before,
            `rm ${OVERRIDE_FOLDER}`,
            `mkdir ${OVERRIDE_FOLDER} 700`,
            `chown ${OVERRIDE_FOLDER} 1001:0`,
            `rm ${OVERRIDE_FOLDER}`,
            ...after,
          ]);
        }
      });
    }
  }

  // Review round 6 of PR #82 (B-R6-1): a cut-off CONFIG_FOLDER goes back to an owner only when the repository folder is
  // real. With a link or a missing folder the step runs as nobody, and CONFIG_FOLDER keeps root:root 0700 (never the
  // owner of the link, never nobody).
  // Review round 1 of PR #84, A-R1-1: for composeModel (closes CONFIG_FOLDER for the step, then restores root:root 0700)
  // and readFiles (changed expectation: before, it closed and restored it too; now it does not touch it at all).
  for (const repository of ['symlink', 'missing'] as const) {
    for (const kind of ['readFiles', 'composeModel'] as const) {
      it(`review round 6 of PR #82, B-R6-1: a cut-off CONFIG_FOLDER stays root:root 0700 after ${kind} when the repository folder is ${repository === 'symlink' ? 'a symbolic link' : 'missing'}`, async () => {
        const { t, session } = await started({ repository, configFolder: 'cutOff' });
        const params =
          kind === 'readFiles'
            ? { repository: 'octo/hello', configPath: '.devcontainer/devcontainer.json' }
            : { repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' };
        expect((await session.step(kind, params)).exitCode).toBe(0);
        expect(t.steps[0].command).toEqual(['setpriv', ...privilegeArgs(65534, 65534), ...batchStepCommand(kind, params).command]);
        if (kind === 'composeModel') expect(t.fsCalls.slice(-2)).toEqual([`chown ${CONFIG_FOLDER} 0:0`, `chmod ${CONFIG_FOLDER} 700`]);
        else expect(t.fsCalls.filter((call) => call.includes(CONFIG_FOLDER))).toEqual([]);
      });
    }
  }

  // Review round 6 of PR #82 (B-R6-3): only root:root 0700 counts as cut off. Each of uid, gid and mode alone keeps
  // CONFIG_FOLDER as it was found (a repository of 1001:0, so that a wrong repair would show as 1001:0 755).
  for (const [configUid, configGid, configMode] of [
    [1001, 0, 0o700],
    [0, 1002, 0o700],
    [0, 0, 0o755],
  ] as const) {
    // Review round 1 of PR #84, A-R1-1: for composeModel (closes and restores) and readFiles (changed expectation: before,
    // it closed and restored CONFIG_FOLDER too; now a folder that is not cut off is not touched at all).
    for (const kind of ['readFiles', 'composeModel'] as const) {
    it(`review round 6 of PR #82, B-R6-3: a CONFIG_FOLDER of ${configUid}:${configGid} ${configMode.toString(8)} is restored as it was found (${kind})`, async () => {
      const { t, session } = await started();
      const { helperDeps } = t;
      const lstatSync = helperDeps.fs.lstatSync as (path: string) => unknown;
      const folder = (uid: number, gid: number, mode: number) => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40000 | mode, uid, gid });
      Object.assign(helperDeps.fs, {
        lstatSync: (path: string) => {
          if (path === `${WORKSPACES_ROOT}/hello`) return folder(1001, 0, 0o755);
          if (path === CONFIG_FOLDER) return folder(configUid, configGid, configMode);
          return lstatSync(path);
        },
      });
      const params =
        kind === 'readFiles'
          ? { repository: 'octo/hello', configPath: '.devcontainer/devcontainer.json' }
          : { repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' };
      expect((await session.step(kind, params)).exitCode).toBe(0);
      if (kind === 'composeModel') expect(t.fsCalls.slice(-2)).toEqual([`chown ${CONFIG_FOLDER} ${configUid}:${configGid}`, `chmod ${CONFIG_FOLDER} ${configMode.toString(8)}`]);
      else expect(t.fsCalls.filter((call) => call.includes(CONFIG_FOLDER))).toEqual([]);
    });
    }
  }

  // Review round 5 of PR #82 (B-R5-2): an owner step never chmods or chowns CONFIG_FOLDER when it is a symbolic link
  // (chmod and chown follow it, and the restore would give its target to the owner) or missing.
  for (const configFolder of ['symlink', 'missing'] as const) {
    it(`review round 5 of PR #82, B-R5-2: an owner step leaves CONFIG_FOLDER alone when it is ${configFolder === 'symlink' ? 'a symbolic link' : 'missing'}`, async () => {
      const { t, session } = await started({ configFolder });
      expect((await session.step('composeModel', { repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' })).exitCode).toBe(0);
      expect(t.fsCalls.filter((call) => call.includes(CONFIG_FOLDER))).toEqual([]);
      expect(t.fsCalls).toEqual([`rm ${OVERRIDE_FOLDER}`, `mkdir ${OVERRIDE_FOLDER} 700`, `chown ${OVERRIDE_FOLDER} 1000:1000`, `rm ${OVERRIDE_FOLDER}`]);
    });
  }

  // Review round 5 of PR #82 (B-R5-3): the processes of the owner are killed (and the kill has ended) before root removes
  // OVERRIDE_FOLDER and gives CONFIG_FOLDER back, so that a process that left its group cannot plant a folder or link there.
  it('review round 5 of PR #82, B-R5-3: an owner step kills the owner before the removal of OVERRIDE_FOLDER and the restore of CONFIG_FOLDER', async () => {
    const { t, session } = await started();
    const { helperDeps } = t;
    const runQuiet = helperDeps.runQuiet;
    // The kill ends only after a turn of the event loop (no timer); its end is recorded in `order`.
    helperDeps.runQuiet = async (command) => {
      await runQuiet(command);
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.order.push(`ended: ${command.join(' ')}`);
    };
    const { rmSync, chownSync } = helperDeps.fs;
    helperDeps.fs.rmSync = ((path: string, options: unknown) => {
      t.order.push(`rm ${path}`);
      return (rmSync as (p: string, o: unknown) => void)(path, options);
    }) as never;
    helperDeps.fs.chownSync = ((path: string, uid: number, gid: number) => {
      t.order.push(`chown ${path} ${uid}:${gid}`);
      return (chownSync as (p: string, u: number, g: number) => void)(path, uid, gid);
    }) as never;
    // Review round 1 of PR #84, A-R1-1: changed step (before: listConfigs, which no longer closes CONFIG_FOLDER): a
    // Compose step, which still closes and restores it.
    expect((await session.step('composeModel', { repository: 'octo/hello', files: ['/workspaces/hello/compose.yml'], project: 'p' })).exitCode).toBe(0);
    const kill = ['setpriv', ...privilegeArgs(1000, 1000), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'].join(' ');
    const start = t.order.indexOf(`chown ${OVERRIDE_FOLDER} 1000:1000`);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(t.order.slice(start + 1)).toEqual([kill, `ended: ${kill}`, `rm ${OVERRIDE_FOLDER}`, `chown ${CONFIG_FOLDER} 1000:1000`, `chmod ${CONFIG_FOLDER} 750`]);
  });

  // Review round 1 of PR #82, A-R1-2: a Git step is cut off only when the whole helper is killed, so the repair runs once
  // per helper process; a writing Git step still walks the volume after it, every time.
  it('repairs a cut-off Git step only before the first Git step of the helper, and walks the volume after every writing Git step', async () => {
    const { t, session } = await started();
    const uid = String(BATCH_GIT_UID);
    // Review round 1 of the follow-up of plan step 11I (A-F1): changed expectation (before: `-exec chown -h 0:0 {} +`,
    // one walk): the `chown -R` of the top entries of the Git user in the folder that find has open, then the walk with
    // `-execdir chown -h`; `repair` is that walk, which the repair and the cleanup after a clone share.
    const topToRoot = ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-user', uid, '-execdir', 'chown', '-R', '-h', `--from=${uid}`, '0:0', '{}', '+'];
    const repair = ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-execdir', 'chown', '-h', '0:0', '{}', '+'];
    const oldClones = ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', '.devenv-clone.*', '-mmin', '+60', '-exec', 'rm', '-rf', '{}', '+'];
    const afterWritingStep = [
      ['setpriv', ...gitPrivilegeArgs(), 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'],
      ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', '.devenv-clone.*', '-user', uid, '-exec', 'rm', '-rf', '{}', '+'],
      topToRoot,
      ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-execdir', 'chown', '-h', '0:0', '{}', '+'],
      ['find', '/', '/dev/shm', '-xdev', '-user', uid, '-prune', '-exec', 'rm', '-rf', '{}', '+'],
    ];
    expect((await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: TOKEN } })).exitCode).toBe(0);
    expect(t.quiet).toEqual([topToRoot, repair, oldClones, ...afterWritingStep]);
    t.quiet.length = 0;
    expect((await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: TOKEN } })).exitCode).toBe(0);
    expect(t.quiet).toEqual(afterWritingStep);
    // A step that timed out is not cut off: its cleanup ran, and the next Git step does not repair either. (User decision
    // of 2026-10-01: Compose reads as the repository owner, so the Git step that times out is a clone now, not composeHash;
    // the fake step of a clone hangs on the secret `hang`.)
    t.quiet.length = 0;
    expect(await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: 'hang' }, timeoutMs: 100 })).toMatchObject({ timedOut: true });
    expect(t.quiet).toEqual(afterWritingStep);
    t.quiet.length = 0;
    expect((await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: TOKEN } })).exitCode).toBe(0);
    // Exactly the cleanup, with no repair before it (the repair has the command of the chown walk, so the exact list
    // is the check; the removal of old clones belongs to the repair alone).
    expect(t.quiet).toEqual(afterWritingStep);
    expect(t.quiet.filter((call) => JSON.stringify(call) === JSON.stringify(repair))).toHaveLength(1);
    expect(t.quiet).not.toContainEqual(oldClones);
  });

  it('repairs a cut-off Git step again in a new helper process', async () => {
    const uid = String(BATCH_GIT_UID);
    // Review round 1 of the follow-up of plan step 11I (A-F1): changed expectation (before: `-exec chown -h 0:0 {} +`):
    // the repair starts with the `chown -R` of the top entries of the Git user, then this walk with `-execdir`.
    const topToRoot = ['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-user', uid, '-execdir', 'chown', '-R', '-h', `--from=${uid}`, '0:0', '{}', '+'];
    const repair = ['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-execdir', 'chown', '-h', '0:0', '{}', '+'];
    for (let round = 0; round < 2; round += 1) {
      // Review round 1 of PR #82, A-R1-2: the flag lives in the helper process, so each new helper repairs once.
      const { t, session } = await started();
      // User decision of 2026-10-01: Compose reads as the repository owner, so the first Git step is a clone (was:
      // composeHash, which ran as the Git user under option A).
      await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: TOKEN } });
      await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: TOKEN } });
      // The repair is the first walk; the chown walk after each clone has the same command, so only the first is the repair.
      expect(t.quiet.slice(0, 2), `helper ${round}`).toEqual([topToRoot, repair]);
      expect(t.quiet.filter((call) => JSON.stringify(call) === JSON.stringify(repair)), `helper ${round}`).toHaveLength(3);
      expect(t.quiet.filter((call) => JSON.stringify(call) === JSON.stringify(topToRoot)), `helper ${round}`).toHaveLength(3);
    }
  });

  it('never leaves /workspaces sticky or writable for others, also after a Git step whose cleanup was cut off', async () => {
    // Review round 1 of PR #80 (A-R1-1): a kill of the whole helper left /workspaces at 1777; the next Git step must not
    // take that for the mode to restore.
    const { t, session } = await started({ workspacesMode: 0o41777 });
    await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: TOKEN } });
    expect(t.fsCalls).toContain(`chmod ${WORKSPACES_ROOT} 1777`);
    expect(t.fsCalls.filter((call) => call.startsWith(`chmod ${WORKSPACES_ROOT} `)).at(-1)).toBe(`chmod ${WORKSPACES_ROOT} 755`);
  });

  for (const configFolder of ['symlink', 'missing'] as const) {
    it(`review round 2 of PR #80, B-R2-2: a Git step never chmods CONFIG_FOLDER when it is a ${configFolder === 'symlink' ? 'symbolic link' : 'missing path'} (R23, R24)`, async () => {
      // A link planted as /workspaces/.devenv+ would otherwise give its target 0700 and then the link's own mode (0777).
      const { t, session } = await started({ configFolder });
      const result = await session.step('clone', { repository: 'octo/hello' }, { secrets: { token: TOKEN } });
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

  // Plan step 11I1, PR B1: changed test: the refusal of the kind by the worker for a request of the extension that skipped
  // the checks of its client is gone with the operation `batchStep`; the parameters beyond the builder go to the helper
  // through the session itself (was: sent directly to the worker), which refuses them.
  it('refuses unknown kinds, a secret for a step without one, and a clone without one', async () => {
    const { t, session } = await started();
    await expect(session.step('docker' as never, { args: ['ps'] })).rejects.toMatchObject({ name: 'HelperChannelError', code: 'unsendable' });
    await expect(session.step('listConfigs', { repository: 'octo/hello', command: ['id'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(session.step('listConfigs', { repository: 'octo/hello' }, { secrets: { token: TOKEN } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(session.step('clone', { repository: 'octo/hello' })).rejects.toMatchObject({ code: 'invalid' });
    expect(t.steps).toHaveLength(0);
  });

  // Plan step 11I1, PR B1: changed expectation: the long input goes to the helper in the one request of its step (the
  // worker's client of the helper allows it, maxRequestBytes); the pieces of `batchChunk` and their bookkeeping in the
  // worker (B-R1-15) are gone with that operation.
  it('sends an input longer than a request of the extension to the helper in its step, and refuses one beyond the limit', async () => {
    const { t, session } = await started();
    const big = { ...UP, override: { text: 'ä'.repeat(300_000) } };
    await session.step('up', big);
    expect(t.helperOps().map((message) => message.op)).toEqual(['up']);
    expect(t.steps[0].input).toBe(batchStepCommand('up', big).input);
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

  // Plan step 11I1, PR B1: the second step is refused by the helper (was: by the worker before the helper saw it).
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
      fs: withDescriptors({
        lstatSync: (() => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40755, uid: 1000, gid: 1000 })) as never,
        chmodSync: (() => {}) as never,
        chownSync: (() => {}) as never,
        readdirSync: (() => []) as never,
        rmSync: (() => {}) as never,
        mkdirSync: (() => {}) as never,
      }),
      env: {},
    });
    const context = {
      signal: new AbortController().signal,
      ...contextSecrets(),
      progress: () => {},
      log: () => {},
      output: () => {},
    };
    const first = operations.listConfigs({ repository: 'octo/hello' }, context);
    await expect(operations.readFiles({ repository: 'octo/hello', configPath: 'a.json' }, context)).rejects.toMatchObject({ code: 'busy' });
    steps[0]();
    expect(await first).toEqual({ exitCode: 0 });
  });

  it('close ends the helper and removes its container by the session label', async () => {
    const { t, session } = await started();
    await session.close();
    await waitUntil(() => t.calls.some((call) => call[0] === 'rm'), 'the removal');
    // Plan step 11G3: changed expectation: the list by the label is containerIds of the port (was: `docker ps -aq`).
    expect(t.calls).toContainEqual(['ps', channelStepLabel(session.session)]);
    // Plan step 11I1, PR B1: changed expectation: the client of the closed helper refuses the step (HelperChannelError
    // `closed`; was: the worker's HelperOperationError for a session that it no longer held).
    await expect(session.step('listConfigs', { repository: 'octo/hello' })).rejects.toMatchObject({ name: 'HelperChannelError', code: 'closed' });
  });

  // Plan step 11I1, PR B1: changed expectation: the reason is the one of the client of the helper (was: the `batch`
  // operation's "The batch helper ended"), and what is left is removed at the close of the session, which the batch scope
  // of the pipeline always runs (was: at the end of the `batch` operation).
  it('reports the end of the helper as lost, and removes what is left by the label at the close', async () => {
    const { t, session } = await started();
    t.helperExit(1);
    expect(await session.lost).toMatch(/helper ended/);
    await session.close();
    await waitUntil(() => t.calls.some((call) => call[0] === 'rm'), 'the removal');
  });

  // Plan step 11I1, PR B1: changed expectation: the progress `batch` with the volume of the worker's own session (was: the
  // ready step of the `batch` operation, BATCH_READY_STEP, removed with it).
  it('reports the batch and refuses a batch with invalid parameters before it starts anything', async () => {
    const t = tracked();
    for (const p of [
      { volume: '-v', image: IMAGE, socket: SOCKET },
      { volume: VOLUME, image: 'devenv-helper:latest', socket: SOCKET },
      { volume: VOLUME, image: IMAGE, socket: '/a,readonly=false' },
      { volume: VOLUME, image: IMAGE, socket: 'relative.sock' },
    ]) {
      await expect(t.open(p)).rejects.toBeInstanceOf(HelperChannelError);
    }
    expect(t.calls).toEqual([]);
    expect(t.progress).toEqual([]);
    const session = await t.open();
    expect(t.progress).toEqual([`batch ${VOLUME}`]);
    await session.close();
  });

  /** Review round 1 of PR #80: settles with `promise`, or with 'pending' after `ms` (a hang fails the test, quickly). */
  function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
    return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
  }

  it('review round 1 of PR #80, B-R1-11: the channel traffic of the helper is not kept as the stdout of its docker run (W10)', async () => {
    const { t } = await started();
    // Plan step 11G3: changed expectation: the helper is no Docker call of the worker anymore (its output goes only to the
    // client of its channel, over the attached run of the port), so no call keeps its output (was: `discardStdout`).
    // Plan step 11I (PR A): changed expectation: no check of the options of the Docker calls of the operation (there are
    // none to keep: OperationContext.docker is removed); the helper is the one run of the port.
    expect(t.calls.filter((call) => call[0] === 'run')).toHaveLength(1);
  });

  // Plan step 11I1, PR B1: changed expectation: the OperationError of the worker's own session (was: the
  // HelperOperationError of the extension's client).
  it('review round 1 of PR #80, B-R1-12: a helper that never answers fails the open at its time limit and is killed (W11)', async () => {
    const t = tracked({ helper: 'silent', deps: { openTimeoutMs: 300 } });
    const outcome = await within(
      t.open().catch((error: unknown) => error),
      10_000,
    );
    expect(outcome).toBeInstanceOf(OperationError);
    expect((outcome as OperationError).code).toBe('failed');
    expect(t.helperEvents.map((entry) => entry.event)).toContain('kill SIGTERM');
  });

  it(
    'review round 1 of PR #80, B-R1-12: a helper whose open failed is killed at once, not only after the close of its input (W14)',
    async () => {
      const t = tracked({ helper: 'wrongProtocol' });
      const outcome = await within(
        t.open().catch((error: unknown) => error),
        15_000,
      );
      // Plan step 11I1, PR B1: changed expectation: the OperationError of the worker's own session (was: the
      // HelperOperationError of the extension's client).
      expect(outcome).toBeInstanceOf(OperationError);
      expect((outcome as OperationError).code).toBe('failed');
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
    const other = '0123456789abcdef0123456789abcdef';
    // Plan step 11G3: changed setup: the IDs that containerIds of the port lists by the label (the port reads only the
    // IDs of the answer of the engine; was: the output of `docker ps` with a warning line).
    const { t, session } = await started({ listedIds: [id, other] });
    t.helperExit(1);
    // Plan step 11I1, PR B1: changed expectation: the reason of the client of the helper, and the removal at the close of
    // the session (see the test of the end of the helper above).
    expect(await session.lost).toMatch(/helper ended/);
    await session.close();
    await waitUntil(() => t.calls.filter((call) => call[0] === 'rm').length === 2, 'the removal');
    const listed = t.calls.filter((call) => call[0] === 'ps');
    expect(listed.length).toBeGreaterThan(0);
    // Plan step 11G3: changed expectation: by the label, with containerIds, and each listed ID removed by removeContainer
    // (was: `docker ps -aq` and one `docker rm -f`); never by the name.
    for (const call of listed) expect(call).toEqual(['ps', channelStepLabel(session.session)]);
    expect(t.calls.filter((call) => call[0] === 'rm')).toEqual([['rm', id], ['rm', other]]);
    expect(t.calls.some((call) => call.includes(`devenv-batch-${session.session}`) && call[0] !== 'run')).toBe(false);
  });

  // Plan step 11I1, PR B1: changed test: the cancel of the open of the worker's own session (was: of the `batch` operation
  // through the extension, which had a hold limit); its outcome is the OperationError `cancelled` of the session (was: the
  // AbortError of the extension's client once the worker confirmed the cancel).
  it('review round 3 of PR #80, B-R3-1: a cancel during the open of the helper ends the helper once the open is done', async () => {
    let answer!: () => void;
    const lateHello = new Promise<void>((resolve) => (answer = resolve));
    // Long times: only the cancel can end this helper within the bounds below.
    // Plan step 11G3: changed setup: the stop time of the fake engine (the kill of the run is `docker stop`; was: the kill
    // grace of the worker for its `docker run`).
    const t = tracked({ lateHello, engineStopMs: 60_000, deps: { openTimeoutMs: 60_000 } });
    const controller = new AbortController();
    const starting = t.open({ volume: VOLUME, image: IMAGE, socket: SOCKET }, controller.signal).catch((error: unknown) => error);
    await waitUntil(() => t.calls.some((call) => call[0] === 'run'), 'the docker run of the helper');
    controller.abort();
    // The worker took the cancel: its SIGTERM to the docker run, which the helper ignores. Plan step 11G3: the stop of the
    // run of the port.
    await waitUntil(() => t.helperEvents.some((entry) => entry.event === 'kill SIGTERM'), 'the SIGTERM of the cancel');
    // The helper answers its hello now: the open succeeds with the signal of the operation already aborted.
    answer();
    await waitUntil(() => t.helperEvents.some((entry) => entry.event === 'inputEnded'), 'the end of the helper input', 10_000);
    expect(await within(starting, 10_000)).toMatchObject({ name: 'OperationError', code: 'cancelled' });
    expect(t.helperEvents.map((entry) => entry.event)).not.toContain('kill SIGKILL');
    // Plan step 11G3: added expectation: after the cancel, the session itself removed the containers of the session label
    // over the port (the server removes nothing for it: it started no Docker call).
    const session = t.runs[0].spec.labels['nimblescape.devenv.channel-step'];
    expect(t.calls).toContainEqual(['ps', channelStepLabel(session)]);
    expect(t.calls).toContainEqual(['rm', '0123456789abcdef0123456789abcdef']);
    // Plan step 11I (PR A): changed expectation: no check that the context got no Docker call (OperationContext.docker is
    // removed, so the session cannot make one).
  }, 30_000);
});
