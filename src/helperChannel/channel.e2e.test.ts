// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channel end to end without a Docker engine (user request 2026-09-28): the real loader (CHANNEL_LOADER, with
// a script path in a temporary folder) and the script bundled as esbuild.mjs does, in a Node.js process of this
// computer, with a fake `docker` on PATH that records its calls. The extension's side is the real HelperChannel on
// NodeProcessRunner.start. Checked above all: the script ends by itself when the connection is lost (the end of its
// input, silence), and ends the Docker calls that still run and removes their containers before. The same with the
// real container: test/docker/helperChannel.test.ts.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelperChannel } from '../core/helperChannel/helperChannel';
import { CHANNEL_LOADER, CHANNEL_SCRIPT_PATH, OP_PROBE, encodeMessage, encodeScript, parseProbeValue } from '../core/helperChannel/protocol';
import { silentLogger, type Logger, type StartedProcess } from '../core/ports';
import { NodeProcessRunner } from '../core/process';

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === 'version') { process.stdout.write('27.1.0\\n'); process.exit(0); }
if (args[0] === 'rm') process.exit(0);
if (args[0] === 'cat') { process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(0)); }
else if (args[0] === 'sleep') {
  process.on('SIGTERM', () => { fs.appendFileSync(log, JSON.stringify(['SIGTERM', ...args]) + '\\n'); process.exit(143); });
  setInterval(() => {}, 1000);
} else { process.stderr.write('unknown\\n'); process.exit(1); }
`;

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
  let loader = '';
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
    const process = runner.start('node', ['-e', loader], { env: { ...env, DEVENV_CHANNEL_SILENCE_MS: String(silenceMs) } });
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
    loader = CHANNEL_LOADER.replace(JSON.stringify(CHANNEL_SCRIPT_PATH), JSON.stringify(path.join(dir, 'script', 'channel.js')));
    expect(loader).not.toBe(CHANNEL_LOADER);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens, answers the probe and a Docker call with input, and ends when it is closed', async () => {
    const { process, ended } = start();
    const channel = await HelperChannel.open(process, script, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    expect(channel.operations).toEqual(['docker', 'probe']);
    expect(parseProbeValue(await channel.operation(OP_PROBE, {}))).toEqual({ serverVersion: '27.1.0', detail: 'Docker 27.1.0' });
    const result = await channel.docker(['cat'], { input: 'hello channel' });
    expect(result).toEqual({ exitCode: 0, stdout: 'hello channel', stderr: '', timedOut: false });
    expect(logLines.some((line) => line.includes('[fake-host] docker#') && line.includes('$ docker cat'))).toBe(true);
    channel.close();
    await waitUntil(ended, 'the end of the script');
  });

  it('ends when its input ends: a running call gets SIGTERM and its container is removed', async () => {
    const { process, ended } = start();
    const channel = await HelperChannel.open(process, script, { logger, name: 'fake-host', openTimeoutMs: 20_000 });
    const running = channel.docker(['sleep', 'one'], { cleanup: ['step-one'] });
    await waitUntil(() => calls().some((call) => call[0] === 'sleep' && call[1] === 'one'), 'the start of the call');
    // As when the connection closes: the input of the script ends.
    process.end();
    await expect(running).rejects.toThrow();
    await waitUntil(ended, 'the end of the script');
    expect(calls()).toContainEqual(['SIGTERM', 'sleep', 'one']);
    expect(calls()).toContainEqual(['rm', '-f', 'step-one']);
  });

  it('ends after the silence when the connection hangs (no ping, the input stays open)', async () => {
    const { process, ended } = start(800);
    let stdout = '';
    process.onStdout((text) => (stdout += text));
    process.write(encodeScript(script));
    process.write(encodeMessage({ t: 'hello', protocol: 1 }));
    process.write(encodeMessage({ t: 'op', id: 1, op: 'docker', params: { args: ['sleep', 'two'], cleanup: ['step-two'] } }));
    await waitUntil(() => stdout.includes('"t":"hello"'), 'the answer to hello');
    // Nothing more is written and the input stays open.
    await waitUntil(ended, 'the end of the script after the silence');
    expect(calls()).toContainEqual(['SIGTERM', 'sleep', 'two']);
    expect(calls()).toContainEqual(['rm', '-f', 'step-two']);
    process.end();
  });

  it('the loader exits when the input ends before the script', async () => {
    const { process, ended } = start();
    process.end();
    await waitUntil(ended, 'the end of the loader');
    expect(await process.exited).toEqual({ exitCode: 3 });
  });
});
