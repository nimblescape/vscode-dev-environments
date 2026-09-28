// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { execFileSync } from 'child_process';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURED_OUTPUT_BYTES, MAX_CAPTURED_STDERR_CHARACTERS } from './helper/analysisLimits';
import { NodeProcessRunner, OutputTooLargeError, windowsTreeKillCommand } from './process';

const node = process.execPath;

describe('NodeProcessRunner', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives the output of the program as text, and its exit code', async () => {
    const result = await new NodeProcessRunner().run(node, ['-e', 'process.stdout.write("out ä"); process.stderr.write("err ö"); process.exit(3)']);
    expect(result).toEqual({ exitCode: 3, stdout: 'out ä', stderr: 'err ö', timedOut: false });
  });

  it('keeps a character whole whose bytes arrive in two chunks', async () => {
    // "€" is E2 82 AC in UTF-8: the first byte comes alone, the rest 50 ms later.
    const script =
      'process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac, 0x21])), 50)';
    const chunks: string[] = [];
    const result = await new NodeProcessRunner().run(node, ['-e', script], { onStdout: (text) => chunks.push(text) });
    expect(result.stdout).toBe('€!');
    expect(chunks.join('')).toBe('€!');
    expect(chunks).not.toContain('');
  });

  it('stops a program whose output is larger than the limit, and fails instead of giving a cut output (review round 9, S9-2)', async () => {
    // An endless output: before, all of it was kept in the extension host.
    const endless = 'const b = "x".repeat(65536); const w = () => process.stdout.write(b, w); w();';
    const start = performance.now();
    await expect(new NodeProcessRunner(1024 * 1024).run(node, ['-e', endless])).rejects.toBeInstanceOf(OutputTooLargeError);
    expect(performance.now() - start).toBeLessThan(5000);
    await expect(new NodeProcessRunner(1000).run(node, ['-e', 'process.stdout.write("y".repeat(1001))'])).rejects.toThrow(
      'The output of',
    );
    expect((await new NodeProcessRunner(1000).run(node, ['-e', 'process.stdout.write("y".repeat(1000))'])).stdout).toBe('y'.repeat(1000));
    expect(MAX_CAPTURED_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
  });

  it('keeps only the end of a long standard error output, and still streams all of it (review round 10, S10-5)', async () => {
    // 3 MiB on stderr, then a last line: before, all of it was kept in the extension host (an endless log of a lifecycle
    // command of `devcontainer up`, which has no time limit, grew it without bound).
    const script = 'const b = "e".repeat(1024 * 1024); process.stderr.write(b); process.stderr.write(b); process.stderr.write(b, () => process.stderr.write("\\nError: No such image: x\\n"));';
    let streamed = 0;
    const result = await new NodeProcessRunner().run(node, ['-e', script], { onStderr: (text) => (streamed += text.length) });
    expect(streamed).toBe(3 * 1024 * 1024 + '\nError: No such image: x\n'.length);
    expect(result.stderr.length).toBe(1024 * 1024);
    expect(MAX_CAPTURED_STDERR_CHARACTERS).toBe(1024 * 1024);
    expect(result.stderr.endsWith('e\nError: No such image: x\n')).toBe(true);
    // A short output is kept whole.
    expect((await new NodeProcessRunner(1024, 10).run(node, ['-e', 'process.stderr.write("0123456789")'])).stderr).toBe('0123456789');
    expect((await new NodeProcessRunner(1024, 10).run(node, ['-e', 'process.stderr.write("0123456789ab")'])).stderr).toBe('23456789ab');
  });

  it('never uses Readable.setEncoding, whose StringDecoder fails in the extension host of VS Code 1.139', async () => {
    const setEncoding = vi.spyOn(Readable.prototype, 'setEncoding');
    const result = await new NodeProcessRunner().run(node, ['-e', 'console.log("hello")']);
    expect(result.stdout).toBe('hello\n');
    expect(setEncoding).not.toHaveBeenCalled();
  });
});

describe('the end of a program on Windows: its whole process tree (review, C3)', () => {
  const sleeper = ['-e', 'setTimeout(() => {}, 60000)'];

  it('builds taskkill /T /F /PID <pid> from the System32 folder, as arguments without a shell', () => {
    expect(windowsTreeKillCommand(4242, { SystemRoot: 'D:\\Win' })).toEqual({
      file: 'D:\\Win\\System32\\taskkill.exe',
      args: ['/T', '/F', '/PID', '4242'],
    });
    expect(windowsTreeKillCommand(7, { SYSTEMROOT: 'C:\\Windows' }).file).toBe('C:\\Windows\\System32\\taskkill.exe');
    expect(windowsTreeKillCommand(7, {}).file).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  it('on win32, ends the tree at the time limit and at an abort', async () => {
    const killed: number[] = [];
    const killTree = vi.fn((pid: number) => {
      killed.push(pid);
      process.kill(pid);
    });
    const runner = new NodeProcessRunner(undefined, undefined, { platform: 'win32', killTree });
    const result = await runner.run(node, sleeper, { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(killTree).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(runner.run(node, sleeper, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(killTree).toHaveBeenCalledTimes(2);
    expect(killed.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);
  });

  it('elsewhere, only the program itself, as before', async () => {
    const killTree = vi.fn();
    const runner = new NodeProcessRunner(undefined, undefined, { platform: 'linux', killTree });
    const result = await runner.run(node, sleeper, { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(killTree).not.toHaveBeenCalled();
  });

  it('on win32, ends the program itself when taskkill cannot be started', async () => {
    const runner = new NodeProcessRunner(undefined, undefined, { platform: 'win32', killTree: (_pid, fallback) => fallback() });
    const result = await runner.run(node, sleeper, { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });
});

describe('NodeProcessRunner.start (user request 2026-09-28: the helper channel)', () => {
  it('keeps the input open: writes reach the program as they come, its output comes as it is written, end closes the input', async () => {
    const echo = 'process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => process.stdout.write("got " + d)); process.stdin.on("end", () => process.exit(4));';
    const started = new NodeProcessRunner().start(node, ['-e', echo]);
    let stdout = '';
    started.onStdout((text) => (stdout += text));
    expect(started.write('one\n')).toBe(true);
    for (let wait = 0; wait < 100 && !stdout.includes('one'); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stdout).toBe('got one\n');
    started.write('two ä\n');
    started.end();
    expect(await started.exited).toEqual({ exitCode: 4 });
    expect(stdout).toBe('got one\ngot two ä\n');
    expect(started.write('late')).toBe(false);
  });

  it('keeps output that came before a listener was set', async () => {
    const started = new NodeProcessRunner().start(node, ['-e', 'process.stdout.write("early"); process.stderr.write("err")']);
    await started.exited;
    const out: string[] = [];
    started.onStdout((text) => out.push(text));
    started.onStderr((text) => out.push(text));
    expect(out).toEqual(['early', 'err']);
  });

  it('kill stops it, on win32 with its process tree', async () => {
    const killTree = vi.fn((pid: number) => process.kill(pid));
    const started = new NodeProcessRunner(undefined, undefined, { platform: 'win32', killTree }).start(node, ['-e', 'setInterval(() => {}, 1000)']);
    started.kill();
    expect((await started.exited).exitCode).not.toBe(0);
    expect(killTree).toHaveBeenCalledTimes(1);
  });

  it('kill sends SIGKILL after the grace time to a program that does not end on SIGTERM (review round 1, L2)', async () => {
    if (process.platform === 'win32') return;
    const ignoring = 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)';
    const started = new NodeProcessRunner(undefined, undefined, { startKillGraceMs: 300 }).start(node, ['-e', ignoring]);
    let stdout = '';
    started.onStdout((text) => (stdout += text));
    for (let wait = 0; wait < 100 && stdout !== 'ready'; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    const killedAt = Date.now();
    started.kill();
    const { exitCode } = await started.exited;
    expect(exitCode).toBeNull();
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(250);
  });

  it('sends no pkill for a program that exited already (review round 3, K2: its pid may be another program now)', async () => {
    if (process.platform === 'win32') return;
    const killed: number[] = [];
    const runner = new NodeProcessRunner(undefined, undefined, {
      startKillGraceMs: 200,
      killChildren: (pid, done) => {
        killed.push(pid);
        done();
      },
    });
    // It exits on SIGTERM, but a detached grandchild keeps its stdout open, so 'close' comes late.
    const script = [
      'const { spawn } = require("child_process");',
      'spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();',
      'process.on("SIGTERM", () => process.exit(0));',
      'process.stdout.write("ready");',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const started = runner.start(node, ['-e', script]);
    let stdout = '';
    started.onStdout((text) => (stdout += text));
    for (let wait = 0; wait < 100 && stdout !== 'ready'; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    started.kill();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(killed).toEqual([]);
    await started.exited;
  });

  it('the SIGKILL goes first to the programs that it started (review round 2, A3: the ssh of the Docker CLI)', async () => {
    if (process.platform === 'win32') return;
    const killed: number[] = [];
    const runner = new NodeProcessRunner(undefined, undefined, {
      startKillGraceMs: 200,
      killChildren: (pid, done) => {
        killed.push(pid);
        done();
      },
    });
    const started = runner.start(node, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    started.kill();
    await started.exited;
    expect(killed).toEqual([started.pid]);
  });

  it('pkill ends a child in a session of its own, which no signal to its parent reaches', async () => {
    if (process.platform === 'win32') return;
    // A parent that ignores SIGTERM starts a detached child (setsid) that ignores SIGTERM too, and prints its pid.
    const parent = [
      'const { spawn } = require("child_process");',
      'process.on("SIGTERM", () => {});',
      'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
      'process.stdout.write(String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const started = new NodeProcessRunner(undefined, undefined, { startKillGraceMs: 200 }).start(node, ['-e', parent]);
    let stdout = '';
    started.onStdout((text) => (stdout += text));
    for (let wait = 0; wait < 100 && stdout === ''; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    const childPid = Number(stdout);
    expect(childPid).toBeGreaterThan(0);
    started.kill();
    await started.exited;
    // Ended: gone, or a zombie that nobody reaps (its parent was killed; process 1 of a container may not reap it).
    // Review round 3 (K6): only "no such process" counts as gone; without `ps` the test fails instead of passing.
    const alive = () => {
      try {
        const state = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { encoding: 'utf8' }).trim();
        return state !== '' && !state.startsWith('Z');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
        return false;
      }
    };
    for (let wait = 0; wait < 100 && alive(); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
  });

  it('killNow ends it and the programs that it started synchronously (review round 4, M3: the end of the extension host)', async () => {
    if (process.platform === 'win32') return;
    const parent = [
      'const { spawn } = require("child_process");',
      'process.on("SIGTERM", () => {});',
      'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
      'process.stdout.write(String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const started = new NodeProcessRunner().start(node, ['-e', parent]);
    let stdout = '';
    started.onStdout((text) => (stdout += text));
    for (let wait = 0; wait < 100 && stdout === ''; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    const childPid = Number(stdout);
    started.killNow?.();
    expect((await started.exited).exitCode).toBeNull();
    const state = () => {
      try {
        return execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { encoding: 'utf8' }).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
        return '';
      }
    };
    for (let wait = 0; wait < 100 && state() !== '' && !state().startsWith('Z'); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state() === '' || state().startsWith('Z')).toBe(true);
  });

  it('reports a program that cannot be started in `exited`, without throwing', async () => {
    const started = new NodeProcessRunner().start('/nonexistent/program-of-the-test', []);
    const { exitCode, error } = await started.exited;
    expect(exitCode).toBeNull();
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });
});
