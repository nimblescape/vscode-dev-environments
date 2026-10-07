// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channel end to end without a Docker engine (user request 2026-09-28): the real loader (the pipe loader of plan
// step 3, with a script path in a temporary folder) and the script bundled as esbuild.mjs does, in a Node.js process of this
// computer, with a fake `docker` on PATH that records its calls. The extension's side is the real HelperChannel on
// NodeProcessRunner.start. Checked above all: the script ends by itself when the connection is lost (the end of its
// input, silence), and ends the Docker calls that still run before. The same with the real container:
// test/docker/helperChannel.test.ts. Plan step 11I1, PR B1: the operation `docker` and the removal of the containers of
// its cleanup label are gone; a running call is the prune of the operation `sweep`, which the fake `docker` holds.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { workerScriptsPlugin } from '../../scripts/workerScripts.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelperChannel } from '../core/helperChannel/helperChannel';
import { CHANNEL_ENTRY, OP_PROBE, OP_SWEEP, encodeMessage, parseProbeValue, sweepArgs } from '../core/helperChannel/protocol';
import { LOADER_EXIT_CODE, bundleHash, encodeBundle, loaderCommand } from '../core/loader/pipeLoader';
import { silentLogger, type Logger, type StartedProcess } from '../core/ports';
import { NodeProcessRunner } from '../core/process';

// Review round 1 (P9): a held call sets its SIGTERM handler before anything else. Review round 2 (C2): that alone does
// not order it before the SIGTERM of the script (its silence runs from the operation, not from the wait of the test);
// the silence of the test (5 s) leaves the start of the fake time for it. Plan step 11I1, PR B1: the held call is the
// prune of `sweep` (\`container\`; before: \`sleep\` through the removed operation \`docker\`).
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
if (args[0] === 'container') {
  process.on('SIGTERM', () => { fs.appendFileSync(log, JSON.stringify(['SIGTERM', ...args]) + '\\n'); process.exit(143); });
  setInterval(() => {}, 1000);
}
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === 'version') { process.stdout.write('27.1.0\\n'); process.exit(0); }
else if (args[0] !== 'container') { process.stderr.write('unknown\\n'); process.exit(1); }
`;

/** The tests below take a few seconds (the silence): review round 2, C2. */
const SLOW_TEST_MS = 30_000;

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeUnix('the helper channel script in a Node.js process (user request 2026-09-28)', () => {
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

  function start(silenceMs = 60_000): { process: StartedProcess; ended: () => boolean } {
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: CHANNEL_LOADER with the path
    // replaced; now the path, the hash and the entry are arguments of the pipe loader, as in channelRunArgs). A path of
    // its own per start, as each `docker run --rm` has a file system of its own: a stored script would be resumed.
    const [node, ...loader] = loaderCommand({ path: path.join(dir, `script-${++startCount}`, 'channel.js'), hash: bundleHash(script), entry: CHANNEL_ENTRY });
    expect(node).toBe('node');
    const process = runner.start('node', loader, { env: { ...env, DEVENV_CHANNEL_SILENCE_MS: String(silenceMs) } });
    let ended = false;
    void process.exited.then(() => (ended = true));
    return { process, ended: () => ended };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-channel-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
    env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_DOCKER_LOG: path.join(dir, 'calls.log') };
    const result = await esbuild.build({
      // Plan step 11B3b: the compile-time constants of esbuild.mjs (the worker now bundles the workspace helper).
      define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) },
      // Plan step 11D2: the script of the Session Monitor in the worker, as esbuild.mjs bundles it.
      plugins: [workerScriptsPlugin(path.resolve(__dirname, '..', '..'), { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) })],
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

  // Review round 1 of PR #118 (A-L2): the worker as esbuild.mjs bundles it carries no operation of a test (the
  // `holdBatch` of batchE2eWorker.testkit.ts, whose parameters are not checked).
  it('bundles no operation of a test', () => {
    expect(script).not.toContain('holdBatch');
    expect(script).not.toContain('testkit');
  });

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  // Plan step 11I1, PR B1: changed test (before: also a Docker call with input through the operation `docker`, removed):
  // the log line of the Docker call of the probe instead.
  it('opens, answers the probe with the log line of its Docker call, and ends when it is closed', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start();
    const channel = await HelperChannel.open(process, script, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    // Review round 4 (M1): with the sweep of never-started channel containers.
    // Plan step 5, PR C: `refresh`.
    // Plan step 5, PR B: changed expectation: `lock` too.
    // Plan step 6, PR B: changed expectation: the batch operations too.
    // Plan step 10A: changed expectation (before: without `pull` and `startContainers`).
    // Plan step 11B1, 11B2: changed expectation, the flows that run in the worker (`tokenRemove`, `stop`).
    // Plan step 11B3b: changed expectation, `listConfigurations`; plan step 11C1: changed expectation, `windowState`.
    // Plan step 11C2a: changed expectation, `delete`; plan step 11C2b: `deleteCheck`; plan step 11C3: `reconcile`; plan step 11D1: `heartbeat`,
    // `monitorSettings`, `recordGitState`; plan step 11D2: `monitorEnsure`; plan step 11E6: `open`, and `monitorSettings`
    // removed (decision D1 of 2026-10-05).
    // Plan step 11I1, PR B1: changed expectation: the relay operations `batch`, `batchChunk`, `batchStep`, `docker`, `lock`,
    // `pull` and `startContainers` are gone.
    expect(channel.operations).toEqual(['delete', 'deleteCheck', 'heartbeat', 'listConfigurations', 'monitorEnsure', 'open', 'probe', 'reconcile', 'recordGitState', 'refresh', 'stop', 'sweep', 'tokenRemove', 'windowState']);
    expect(parseProbeValue(await channel.operation(OP_PROBE, {}))).toEqual({ serverVersion: '27.1.0', detail: 'Docker 27.1.0' });
    expect(logLines.some((line) => line.includes('[fake-host] probe#') && line.includes('$ docker version'))).toBe(true);
    channel.close();
    await waitUntil(ended, 'the end of the script');
  });

  // Plan step 11I1, PR B1: changed test (before: a `sleep` through the operation `docker`, whose container was then removed
  // by its cleanup label): the held prune of `sweep`, which gets SIGTERM; the removal is gone with that operation.
  it('ends when its input ends: a running call gets SIGTERM', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start();
    const channel = await HelperChannel.open(process, script, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    const running = channel.operation(OP_SWEEP, {});
    await waitUntil(() => calls().some((call) => call[0] === 'container' && call[1] === 'prune'), 'the start of the call');
    // As when the connection closes: the input of the script ends.
    process.end();
    await expect(running).rejects.toThrow();
    await waitUntil(ended, 'the end of the script');
    expect(calls()).toContainEqual(['SIGTERM', ...sweepArgs()]);
  });

  // Plan step 11I1, PR B1: changed test (before: a `sleep` through the operation `docker`, with the removal of its cleanup
  // label): the held prune of `sweep`.
  it('ends after the silence when the connection hangs (no ping, the input stays open)', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start(5_000);
    let stdout = '';
    process.onStdout((text) => (stdout += text));
    process.write(encodeBundle(script));
    process.write(encodeMessage({ t: 'hello', protocol: 1 }));
    process.write(encodeMessage({ t: 'op', id: 1, op: OP_SWEEP, params: {} }));
    await waitUntil(() => stdout.includes('"t":"hello"'), 'the answer to hello');
    await waitUntil(() => calls().some((call) => call[0] === 'container' && call[1] === 'prune'), 'the start of the call');
    // Nothing more is written and the input stays open.
    await waitUntil(ended, 'the end of the script after the silence');
    expect(calls()).toContainEqual(['SIGTERM', ...sweepArgs()]);
    process.end();
  });

  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('the loader exits when the input ends before the script', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start();
    process.end();
    await waitUntil(ended, 'the end of the loader');
    expect(await process.exited).toEqual({ exitCode: LOADER_EXIT_CODE });
  });

  // Plan step 3 (pipe loading, user decision 2026-09-29): the loader checks the script against the hash of its command.
  // PR #69 review round 6, A-R6-3: an explicit time limit (before: the default of 5 s) for its real process spawns.
  it('the loader exits when the script does not match its hash, and starts nothing', { timeout: SLOW_TEST_MS }, async () => {
    const { process, ended } = start();
    let stderr = '';
    process.onStderr((text) => (stderr += text));
    process.write(encodeBundle(`${script}\n// changed`));
    await waitUntil(ended, 'the end of the loader');
    expect(await process.exited).toEqual({ exitCode: LOADER_EXIT_CODE });
    expect(stderr).toBe('devenv loader: the bundle does not match its hash\n');
  });
});
