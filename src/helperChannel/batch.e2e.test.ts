// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the batch helper end to end without a Docker engine, as channel.e2e.test.ts: the real pipe loader and
// the bundled script as the worker, in a Node.js process. Plan step 11G3: changed setup: the worker starts the helper
// over the Engine API (DockerEngine.runAttached) instead of its own `docker run`, so a fake engine answers on a Unix
// socket of the test (the bundle of the worker is built with that socket instead of /var/run/docker.sock), and a `docker`
// on PATH only records that no call reaches it. The fake engine runs the command of the created container (the pipe
// loader with the same script and the entry startBatchHelper) as a Node.js process at its start, its input and output
// over the attached connection (the input closed when that connection closes it or goes away, as StdinOnce), and
// answers the wait with its exit code. The helper is not root here (or lacks its socket folder), so it refuses to run
// steps (`unsafe`): that refusal, relayed back, shows the path of a step through the worker and the helper. Checked: the
// volume check (a missing volume starts nothing), exactly one helper per session, the relay of a step, an unknown kind
// and an invalid parameter refused, the removal by the session label, and that the helper ends after a close, after a
// hard kill of the worker, and after its silence when the worker hangs.
// Plan step 11I1, PR B1 (user decision D5 of 2026-10-07: this file is the one test of the end of the batch helper with its
// worker): the operations `batch`, `batchStep` and `batchChunk` are gone, so the session is the worker's own
// (workerBatchSession), held by the operation of the test OP_HOLD_BATCH in a worker bundled from batchE2eWorker.testkit.ts
// (main.ts with that operation) in place of a flow, which would need the lock folder of the Session Monitor, its own
// helper image and the records of the extension. The chunked input is gone with `batchChunk`.
import * as fs from 'fs';
import * as http from 'http';
import type * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import * as esbuild from 'esbuild';
import { workerScriptsPlugin } from '../../scripts/workerScripts.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelperChannel } from '../core/helperChannel/helperChannel';
import { CHANNEL_ENTRY } from '../core/helperChannel/protocol';
import { HELD_STEP, OP_HOLD_BATCH, type HoldBatchParams, type HoldBatchValue } from './batchE2eWorker.testkit';
// Plan step 11I (PR A): the plugin of the engine socket of the test, shared with channel.e2e.test.ts (before: defined here).
import { engineSocketPlugin } from './engineSocket.testkit';
import { bundleHash, loaderCommand } from '../core/loader/pipeLoader';
import { silentLogger, type Logger, type StartedProcess } from '../core/ports';
import { NodeProcessRunner } from '../core/process';

// Plan step 11G3: the worker runs no `docker` process for the batch helper; a call would be recorded here.
const FAKE_DOCKER = `#!/usr/bin/env node
require('fs').appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write('unexpected\\n');
process.exit(1);
`;

/** A container of the fake engine. */
interface FakeContainer {
  id: string;
  name: string;
  body: { Cmd: string[]; Labels: Record<string, string>; HostConfig: { AutoRemove?: boolean } };
  attach?: net.Socket;
  child?: ChildProcess;
  exitCode?: number | null;
  waits: http.ServerResponse[];
}

/**
 * Plan step 11G3: the Engine API as the worker uses it for the batch helper: the inspect of a volume, the create, the
 * attach (a hijacked connection with framed output), the wait, the start, the stop, the list by a label and the removal.
 */
function fakeEngine(dir: string) {
  const calls: string[] = [];
  const events: string[][] = [];
  const containers = new Map<string, FakeContainer>();
  /** Plan step 11I1, PR B1: every container that was created, also one that the engine removed since (AutoRemove). */
  const created: FakeContainer[] = [];
  let next = 0;
  const frame = (stream: 1 | 2, data: Buffer) => {
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
  };
  const ended = (container: FakeContainer, code: number | null) => {
    container.exitCode = code;
    events.push(['helper-ended', String(code)]);
    container.attach?.end();
    // AutoRemove: the engine removes it, and answers the waits for its removal.
    containers.delete(container.id);
    for (const res of container.waits.splice(0)) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ StatusCode: code ?? 137 }));
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      const json = (status: number, value?: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value));
      const volume = /^\/volumes\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && volume) return volume[1] === 'devenv-missing' ? json(404, { message: 'get devenv-missing: no such volume' }) : json(200, { Name: decodeURIComponent(volume[1]) });
      if (req.method === 'GET' && url.pathname === '/containers/json') {
        const labels = (JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] }).label ?? [];
        const found = [...containers.values()].filter((container) => labels.every((label) => { const [key, value] = label.split('='); return container.body.Labels[key] === value; }));
        return json(200, found.map((container) => ({ Id: container.id })));
      }
      const match = /^\/containers\/([0-9a-f]+)(?:\/(start|wait|stop))?$/.exec(url.pathname);
      const container = match ? containers.get(match[1]) : undefined;
      if (match && container === undefined) return json(404, { message: 'No such container' });
      if (container && match?.[2] === 'wait') return void container.waits.push(res);
      if (container && match?.[2] === 'start') {
        // The command of the container: the pipe loader of the helper, its script stored in a folder of its own.
        const [, e, loader, , hash, entry] = container.body.Cmd;
        const folder = fs.mkdtempSync(path.join(dir, 'helper-'));
        const child = spawn(process.execPath, [e, loader, path.join(folder, 'batch.js'), hash, entry], { stdio: ['pipe', 'pipe', 'pipe'], env: engine.helperEnv });
        container.child = child;
        events.push(['helper-started', String(child.pid)]);
        child.stdout?.on('data', (data: Buffer) => container.attach?.write(frame(1, data)));
        child.stderr?.on('data', (data: Buffer) => container.attach?.write(frame(2, data)));
        child.stdin?.on('error', () => {});
        child.on('exit', (code) => ended(container, code));
        return json(204);
      }
      if (container && match?.[2] === 'stop') {
        container.child?.kill('SIGTERM');
        const timer = setTimeout(() => container.child?.kill('SIGKILL'), Number(url.searchParams.get('t') ?? '10') * 1000);
        container.child?.on('exit', () => (clearTimeout(timer), json(204)));
        if (container.child === undefined) json(304);
        return;
      }
      if (container && req.method === 'DELETE') {
        container.child?.kill('SIGKILL');
        if (container.child === undefined) containers.delete(container.id);
        return json(204);
      }
      if (req.method === 'POST' && url.pathname === '/containers/create') {
        const id = (++next).toString(16).padStart(64, '0');
        const container: FakeContainer = { id, name: url.searchParams.get('name') ?? '', body: JSON.parse(body) as FakeContainer['body'], waits: [] };
        containers.set(id, container);
        created.push(container);
        return json(201, { Id: id });
      }
      json(500, { message: 'unexpected' });
    });
  });
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    calls.push(`POST ${req.url}`);
    const id = /^\/containers\/([0-9a-f]+)\/attach/.exec(req.url ?? '')?.[1] ?? '';
    const container = containers.get(id);
    if (container === undefined) return void socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    container.attach = socket;
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.on('data', (data: Buffer) => container.child?.stdin?.write(data));
    // StdinOnce: the input of the container closes when the attached client closes it, or goes away.
    socket.on('end', () => container.child?.stdin?.end());
    socket.on('close', () => container.child?.stdin?.end());
    socket.on('error', () => {});
  });
  const socketPath = path.join(dir, 'engine.sock');
  const engine = {
    /** The variables of the helper processes (the shorter silence of the test, as the fake `docker run` passed it on). */
    helperEnv: process.env,
    socketPath,
    calls,
    events,
    containers,
    created,
    listen: () => new Promise<void>((resolve) => server.listen(socketPath, resolve)),
    close: () => new Promise<void>((resolve) => {
      for (const container of containers.values()) container.child?.kill('SIGKILL');
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  return engine;
}

const VOLUME = 'devenv-e2e-volume';
const IMAGE = `sha256:${'b'.repeat(64)}`;
const SOCKET = '/var/run/docker.sock';
const SLOW_TEST_MS = 40_000;

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

/** Whether the process runs (not gone, not a zombie that nobody reaped yet). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return process.platform !== 'linux';
  }
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeUnix('the batch helper of the worker in Node.js processes (plan step 6, PR B)', () => {
  let dir = '';
  let script = '';
  let startCount = 0;
  let env: NodeJS.ProcessEnv = {};
  const runner = new NodeProcessRunner();
  const logLines: string[] = [];
  const logger: Logger = { ...silentLogger, info: (line) => logLines.push(line), warn: (line) => logLines.push(line) };

  // Plan step 11G3: changed setup: the requests and the helpers of the fake engine (was: the calls of the fake `docker`),
  // and the calls that still reach the `docker` on PATH (none).
  let engine: ReturnType<typeof fakeEngine>;
  const calls = (): string[] => engine.calls;
  const dockerCalls = (): string[][] => {
    const file = path.join(dir, 'calls.log');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);
  };
  const ended = () => engine.events.filter((event) => event[0] === 'helper-ended').length;
  const creates = () => calls().filter((call) => call.startsWith('POST /containers/create'));

  async function worker(silenceMs = 60_000): Promise<{ process: StartedProcess; channel: HelperChannel }> {
    const [, ...loader] = loaderCommand({ path: path.join(dir, `worker-${++startCount}`, 'channel.js'), hash: bundleHash(script), entry: CHANNEL_ENTRY });
    const process = runner.start('node', loader, { env: { ...env, DEVENV_CHANNEL_SILENCE_MS: String(silenceMs) } });
    // Plan step 11G3: the helper gets the shorter silence of the test from the fake engine (the fake `docker run`, a child
    // of the worker, passed on the variables of the worker).
    engine.helperEnv = { ...env, DEVENV_CHANNEL_SILENCE_MS: String(silenceMs) };
    const channel = await HelperChannel.open(process, script, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    return { process, channel };
  }

  /** Plan step 11I1, PR B1: a session of the worker that runs `steps` through it and closes it (OP_HOLD_BATCH). */
  async function batch(channel: HelperChannel, p: Omit<HoldBatchParams, 'hold'>): Promise<HoldBatchValue> {
    return (await channel.operation(OP_HOLD_BATCH, p, { timeoutMs: SLOW_TEST_MS })) as HoldBatchValue;
  }

  /**
   * Plan step 11I1, PR B1: a session of the worker held by OP_HOLD_BATCH until `signal` aborts; resolves with its session
   * once it is held, and the pid of its helper.
   */
  async function held(channel: HelperChannel, signal: AbortSignal): Promise<{ session: string; helperPid: number; done: Promise<unknown> }> {
    let session: string | undefined;
    const done = channel
      .operation(OP_HOLD_BATCH, { volume: VOLUME, image: IMAGE, socket: SOCKET, hold: true } satisfies HoldBatchParams, {
        signal,
        onProgress: (step, detail) => (step === HELD_STEP ? (session = detail) : undefined),
      })
      .catch((error: unknown) => error);
    await waitUntil(() => session !== undefined, 'the held batch session');
    const started = engine.events.filter((event) => event[0] === 'helper-started');
    return { session: session!, helperPid: Number(started[started.length - 1][1]), done };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-batch-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
    env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_DOCKER_LOG: path.join(dir, 'calls.log') };
    engine = fakeEngine(dir);
    await engine.listen();
    const result = await esbuild.build({
      // Plan step 11B3b: the compile-time constants of esbuild.mjs (the worker now bundles the workspace helper).
      define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) },
      // Plan step 11D2: the script of the Session Monitor in the worker, as esbuild.mjs bundles it. Plan step 11G3: the
      // Engine API of this bundle on the socket of the fake engine (only in the build of this test).
      plugins: [workerScriptsPlugin(path.resolve(__dirname, '..', '..'), { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) }), engineSocketPlugin(engine.socketPath)],
      // Plan step 11I1, PR B1: the worker of main.ts with the operation of the test (batchE2eWorker.testkit.ts).
      entryPoints: [path.resolve(__dirname, 'batchE2eWorker.testkit.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      minify: true,
      write: false,
      logLevel: 'silent',
    });
    script = result.outputFiles[0].text;
  });

  afterAll(async () => {
    await engine?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Plan step 11I1, PR B1: changed test: the worker's own session through OP_HOLD_BATCH (was: HelperChannel.batch and its
  // steps through the worker); an unknown kind is refused by the session before the helper sees it (was: by the worker for a
  // request `batchStep` of the extension), and the chunked input is gone with `batchChunk` (the large input goes to the
  // helper in one request now).
  it('starts one helper per session and relays its steps; an unknown kind and an invalid parameter are refused', { timeout: SLOW_TEST_MS }, async () => {
    const { channel } = await worker();
    const before = calls().length;
    const big = { repository: 'octo/hello', environmentId: 'e-1', removeExistingContainer: false };
    const value = await batch(channel, {
      volume: VOLUME,
      image: IMAGE,
      socket: SOCKET,
      steps: [
        { kind: 'listConfigs', params: { repository: 'octo/hello' } },
        { kind: 'up', params: big, overrideText: 600_000 },
        { kind: 'up', params: { ...big, environmentId: '../x' }, overrideText: 600_000 },
        { kind: 'exec', params: {} },
      ],
    });
    // Plan step 11G3: changed expectation: the inspect of the volume and one attached create over the Engine API (was:
    // `docker volume inspect` and one `docker run`).
    expect(creates()).toEqual([`POST /containers/create?name=devenv-batch-${value.session}`]);
    expect(calls()[before]).toBe(`GET /volumes/${VOLUME}`);
    const created = engine.created.at(-1)!;
    expect(created.body.Labels['nimblescape.devenv.channel-step']).toBe(value.session);
    expect(created.body.HostConfig.AutoRemove).toBe(true);
    // The helper is the same script, loaded by its own pipe loader with the entry of the helper.
    expect(created.body.Cmd.slice(-3)).toEqual(['/opt/devenv/batch.js', bundleHash(script), 'startBatchHelper']);
    expect(value.outcomes).toEqual([
      // Not root (or no socket folder) here: the helper refuses to run a step, and the refusal comes back to the worker.
      { name: 'HelperOperationError', code: 'unsafe' },
      // A large input arrives whole: its parameters pass the checks of the helper (else `invalid`).
      { name: 'HelperOperationError', code: 'unsafe' },
      { name: 'HelperOperationError', code: 'invalid' },
      // An unknown kind is not sent to the helper.
      { name: 'HelperChannelError', code: 'unsendable' },
    ]);
    // The session was closed when the operation ended: the helper ended, and the worker looked for what was left by the
    // session label. Plan step 11G3: changed expectation: the list by the session label over the Engine API (was:
    // `docker ps -aq`).
    await waitUntil(() => ended() === 1, 'the end of the helper');
    const filters = encodeURIComponent(JSON.stringify({ label: [`nimblescape.devenv.channel-step=${value.session}`] }));
    expect(calls()).toContain(`GET /containers/json?all=true&filters=${filters}`);
    expect(engine.containers.size).toBe(0);
    // Plan step 11G3: added expectation: the worker ran no `docker` process.
    expect(dockerCalls()).toEqual([]);
    channel.close();
  });

  // Plan step 11I1, PR B1: changed call: the worker's own session through OP_HOLD_BATCH (was: HelperChannel.batch).
  it('refuses a missing volume and starts no helper', { timeout: SLOW_TEST_MS }, async () => {
    const before = calls().length;
    const { channel } = await worker();
    await expect(batch(channel, { volume: 'devenv-missing', image: IMAGE, socket: SOCKET })).rejects.toMatchObject({ code: 'missingVolume' });
    // Plan step 11G3: changed expectation: the inspect over the Engine API (was: `docker volume inspect`).
    expect(calls().slice(before)).toEqual(['GET /volumes/devenv-missing']);
    channel.close();
  });

  // Plan step 11I1, PR B1: added: the end of a held session at the cancel of its operation (was: the release of the
  // `batch` operation by the extension).
  it('the helper of a held session ends at the cancel of its operation, and is looked for by its label', { timeout: SLOW_TEST_MS }, async () => {
    const { channel } = await worker();
    const controller = new AbortController();
    const { session, helperPid, done } = await held(channel, controller.signal);
    expect(running(helperPid)).toBe(true);
    controller.abort();
    expect(await done).toMatchObject({ name: 'AbortError' });
    await waitUntil(() => !running(helperPid), 'the end of the helper after the cancel');
    const filters = encodeURIComponent(JSON.stringify({ label: [`nimblescape.devenv.channel-step=${session}`] }));
    await waitUntil(() => calls().includes(`GET /containers/json?all=true&filters=${filters}`), 'the list by the session label');
    channel.close();
  });

  // Plan step 11I1, PR B1: changed setup: a session held by the worker's operation OP_HOLD_BATCH (was: by `batch`).
  it('the helper ends when the worker is killed hard', { timeout: SLOW_TEST_MS }, async () => {
    const { process: workerProcess, channel } = await worker();
    const { helperPid } = await held(channel, new AbortController().signal);
    expect(running(helperPid)).toBe(true);
    // SIGKILL of the worker alone: the input of the helper ends. Plan step 11G3: its attached connection goes with it,
    // and the engine closes the input of the container (StdinOnce; was: its `docker run`, which went with its connection).
    process.kill(workerProcess.pid!, 'SIGKILL');
    await waitUntil(() => !running(helperPid), 'the end of the helper after the worker');
    channel.closeNow();
  });

  // Plan step 11I1, PR B1: changed setup: a session held by the worker's operation OP_HOLD_BATCH (was: by `batch`).
  it('the helper ends by its silence when the worker hangs', { timeout: SLOW_TEST_MS }, async () => {
    const before = ended();
    const { process: workerProcess, channel } = await worker(3_000);
    await held(channel, new AbortController().signal);
    const pid = workerProcess.pid!;
    process.kill(pid, 'SIGSTOP');
    try {
      await waitUntil(() => ended() === before + 1, 'the end of the helper by its silence', 20_000);
    } finally {
      process.kill(pid, 'SIGCONT');
      channel.closeNow();
    }
  });
});
