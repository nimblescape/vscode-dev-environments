// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the batch helper end to end without a Docker engine, as channel.e2e.test.ts: the real pipe loader and
// the bundled script as the worker, in a Node.js process, with a fake `docker` on PATH. Its `run` starts the command of
// the helper container (the pipe loader with the same script and the entry startBatchHelper) as a Node.js process with
// the input and output of the call. The helper is not root here (or lacks its socket folder), so it refuses to run steps
// (`unsafe`): that refusal, relayed back, shows the path of a step through the worker and the helper. Checked: the
// volume check (a missing volume starts nothing), exactly one helper per session, the relay of a step and of a chunked
// input, an unknown kind refused by the worker, and that the helper ends after a close, after a hard kill of the worker,
// and after its silence when the worker hangs.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OP_BATCH_STEP } from '../core/helperChannel/batch';
import { HelperChannel, HelperOperationError } from '../core/helperChannel/helperChannel';
import { CHANNEL_ENTRY } from '../core/helperChannel/protocol';
import { bundleHash, loaderCommand } from '../core/loader/pipeLoader';
import { silentLogger, type Logger, type StartedProcess } from '../core/ports';
import { NodeProcessRunner } from '../core/process';

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === 'volume') {
  if (args[4] === 'devenv-missing') { process.stderr.write('Error: No such volume\\n'); process.exit(1); }
  process.stdout.write(args[4] + '\\n');
  process.exit(0);
} else if (args[0] === 'ps') { process.stdout.write('0123456789abcdef0123456789abcdef\\n'); process.exit(0); }
else if (args[0] === 'rm') process.exit(0);
else if (args[0] === 'run') {
  const at = args.lastIndexOf('node');
  const [, e, loader, , hash, entry] = args.slice(at);
  const dir = fs.mkdtempSync(process.env.FAKE_DOCKER_DIR + '/helper-');
  const child = spawn(process.execPath, [e, loader, dir + '/batch.js', hash, entry], { stdio: 'inherit' });
  fs.appendFileSync(log, JSON.stringify(['helper-started', String(child.pid)]) + '\\n');
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => { fs.appendFileSync(log, JSON.stringify(['helper-ended', String(code)]) + '\\n'); process.exit(code === null ? 1 : code); });
} else { process.stderr.write('unknown\\n'); process.exit(1); }
`;

const VOLUME = 'devenv-e2e-volume';
const IMAGE = `sha256:${'b'.repeat(64)}`;
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

  const calls = (): string[][] => {
    const file = path.join(dir, 'calls.log');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);
  };
  const ended = () => calls().filter((call) => call[0] === 'helper-ended').length;

  async function worker(silenceMs = 60_000): Promise<{ process: StartedProcess; channel: HelperChannel }> {
    const [, ...loader] = loaderCommand({ path: path.join(dir, `worker-${++startCount}`, 'channel.js'), hash: bundleHash(script), entry: CHANNEL_ENTRY });
    const process = runner.start('node', loader, { env: { ...env, DEVENV_CHANNEL_SILENCE_MS: String(silenceMs) } });
    const channel = await HelperChannel.open(process, script, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    return { process, channel };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-batch-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
    env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_DOCKER_LOG: path.join(dir, 'calls.log'), FAKE_DOCKER_DIR: dir };
    const result = await esbuild.build({
      // Plan step 11B3b: the compile-time constants of esbuild.mjs (the worker now bundles the workspace helper).
      define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) },
      entryPoints: [path.resolve(__dirname, 'main.ts')],
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

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts one helper per session and relays its steps, also a chunked input; the worker refuses an unknown kind', { timeout: SLOW_TEST_MS }, async () => {
    const { channel } = await worker();
    const session = await channel.batch({ volume: VOLUME, image: IMAGE, socket: '/var/run/docker.sock' });
    const runs = calls().filter((call) => call[0] === 'run');
    expect(runs).toHaveLength(1);
    expect(calls()[0]).toEqual(['volume', 'inspect', '--format', '{{.Name}}', VOLUME]);
    // The helper is the same script, loaded by its own pipe loader with the entry of the helper.
    expect(runs[0].slice(-3)).toEqual(['/opt/devenv/batch.js', bundleHash(script), 'startBatchHelper']);
    // Not root (or no socket folder) here: the helper refuses to run a step, and the refusal comes back through the worker.
    const refused = await session.step('listConfigs', { repository: 'octo/hello' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HelperOperationError);
    expect((refused as HelperOperationError).code).toBe('unsafe');
    // A chunked input arrives whole: its parameters pass the checks of the helper (else `invalid`).
    const big = { repository: 'octo/hello', override: { text: 'x'.repeat(600_000) }, environmentId: 'e-1', removeExistingContainer: false };
    await expect(session.step('up', big)).rejects.toMatchObject({ code: 'unsafe' });
    await expect(session.step('up', { ...big, environmentId: '../x' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(channel.operation(OP_BATCH_STEP, { session: session.session, kind: 'exec', params: {} }, { reserved: true })).rejects.toMatchObject({ code: 'invalid' });
    expect(calls().filter((call) => call[0] === 'run')).toHaveLength(1);
    await session.close();
    await waitUntil(() => ended() === 1, 'the end of the helper');
    expect(calls()).toContainEqual(['ps', '-aq', '--no-trunc', '--filter', `label=nimblescape.devenv.channel-step=${session.session}`]);
    channel.close();
  });

  it('refuses a missing volume and starts no helper', { timeout: SLOW_TEST_MS }, async () => {
    const before = calls().length;
    const { channel } = await worker();
    await expect(channel.batch({ volume: 'devenv-missing', image: IMAGE, socket: '/var/run/docker.sock' })).rejects.toMatchObject({ code: 'missingVolume' });
    expect(calls().slice(before)).toEqual([['volume', 'inspect', '--format', '{{.Name}}', 'devenv-missing']]);
    channel.close();
  });

  it('the helper ends when the worker is killed hard', { timeout: SLOW_TEST_MS }, async () => {
    const { process: workerProcess, channel } = await worker();
    await channel.batch({ volume: VOLUME, image: IMAGE, socket: '/var/run/docker.sock' });
    const started = calls().filter((call) => call[0] === 'helper-started');
    const helperPid = Number(started[started.length - 1][1]);
    expect(running(helperPid)).toBe(true);
    // SIGKILL of the worker alone (its `docker run` stays, as the CLI in a killed container goes with its connection):
    // the input of the helper ends.
    process.kill(workerProcess.pid!, 'SIGKILL');
    await waitUntil(() => !running(helperPid), 'the end of the helper after the worker');
    channel.closeNow();
  });

  it('the helper ends by its silence when the worker hangs', { timeout: SLOW_TEST_MS }, async () => {
    const before = ended();
    const { process: workerProcess, channel } = await worker(3_000);
    await channel.batch({ volume: VOLUME, image: IMAGE, socket: '/var/run/docker.sock' });
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
