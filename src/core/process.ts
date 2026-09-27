// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { MAX_CAPTURED_OUTPUT_BYTES, MAX_CAPTURED_STDERR_CHARACTERS } from './helper/analysisLimits';
import { abortError, type ProcessRunner, type RunOptions, type RunResult } from './ports';

/**
 * Review round 9 (S9-2): a program printed more than MAX_CAPTURED_OUTPUT_BYTES on its standard output. It was stopped,
 * and its run fails: an output cut at the limit is never used as a result.
 */
export class OutputTooLargeError extends Error {
  readonly code = 'EOUTPUTTOOLARGE';
  constructor(file: string, limitBytes: number) {
    super(`The output of ${file} is larger than ${Math.round(limitBytes / (1024 * 1024))} MB. It was stopped.`);
    this.name = 'OutputTooLargeError';
  }
}

/**
 * ProcessRunner with `child_process.spawn`, without a shell. Review round 9 (S9-2): at most `maxStdoutBytes` of
 * standard output are kept; beyond, the program is stopped and `run` rejects with OutputTooLargeError. Review round 10
 * (S10-5): of the standard error output, only the last `maxStderrCharacters` characters are kept (the program goes on;
 * `onStderr` still gets all of it), so that an endless log (for example of a lifecycle command of `devcontainer up`,
 * which has no time limit) cannot fill the memory of the extension host.
 */
export class NodeProcessRunner implements ProcessRunner {
  private readonly platform: NodeJS.Platform;
  private readonly killTree: (pid: number, fallback: () => void) => void;

  constructor(
    private readonly maxStdoutBytes: number = MAX_CAPTURED_OUTPUT_BYTES,
    private readonly maxStderrCharacters: number = MAX_CAPTURED_STDERR_CHARACTERS,
    options: { platform?: NodeJS.Platform; killTree?: (pid: number, fallback: () => void) => void } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.killTree = options.killTree ?? ((pid, fallback) => runTaskkill(pid, process.env, fallback));
  }

  /**
   * Stops `child` (time limit, abort, too much output). Review, C3: on Windows, the whole process tree
   * (`taskkill /T /F /PID <pid>`): docker.exe starts ssh.exe, which a kill of docker.exe alone leaves running. Elsewhere
   * the signal of `child.kill()` as before.
   */
  private stop(child: ChildProcess): void {
    if (this.platform === 'win32' && child.pid !== undefined) {
      try {
        this.killTree(child.pid, () => child.kill());
        return;
      } catch {
        // Below: at least the program itself.
      }
    }
    child.kill();
  }

  run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const child = spawn(file, [...args], {
        env: options.env ?? process.env,
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let tooLarge = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      // The output is decoded with TextDecoder (streaming, so a character split between two chunks stays whole), not
      // with Readable.setEncoding: that uses Node's string_decoder module, which fails in the extension host of VS Code
      // 1.139 (Electron 43) with "StringDecoder is not a constructor", so that no program could be started at all.
      const stdoutDecoder = new TextDecoder('utf-8');
      const stderrDecoder = new TextDecoder('utf-8');
      const onStdout = (text: string) => {
        if (text === '') return;
        stdout += text;
        options.onStdout?.(text);
      };
      const onStderr = (text: string) => {
        if (text === '') return;
        stderr += text;
        // Cut to the limit only once it is twice as long: linear time, however small the chunks are.
        if (stderr.length > 2 * this.maxStderrCharacters) stderr = stderr.slice(-this.maxStderrCharacters);
        options.onStderr?.(text);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxStdoutBytes) {
          tooLarge = true;
          stdout = '';
          this.stop(child);
          return;
        }
        onStdout(stdoutDecoder.decode(chunk, { stream: true }));
      });
      child.stderr.on('data', (chunk: Buffer) => onStderr(stderrDecoder.decode(chunk, { stream: true })));

      const timer =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              this.stop(child);
            }, options.timeoutMs)
          : undefined;
      const onAbort = () => {
        aborted = true;
        this.stop(child);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        finish();
        if (aborted) {
          reject(abortError());
          return;
        }
        if (tooLarge) {
          reject(new OutputTooLargeError(file, this.maxStdoutBytes));
          return;
        }
        // The rest of an incomplete character at the end of the output.
        onStdout(stdoutDecoder.decode());
        onStderr(stderrDecoder.decode());
        if (stderr.length > this.maxStderrCharacters) stderr = stderr.slice(-this.maxStderrCharacters);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });

      // Ignore EPIPE when the process ends before it reads its input.
      child.stdin.on('error', () => {});
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}

/**
 * The command that ends the process `pid` and all processes that it started, on Windows: `taskkill /T /F /PID <pid>`
 * (taskkill of Windows: /T the tree, /F by force), from the System32 folder of Windows (SystemRoot), never through a
 * shell or a PATH lookup.
 */
export function windowsTreeKillCommand(pid: number, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  const root = Object.keys(env).find((key) => key.toUpperCase() === 'SYSTEMROOT');
  const systemRoot = (root !== undefined ? env[root] : undefined) || 'C:\\Windows';
  return { file: path.win32.join(systemRoot, 'System32', 'taskkill.exe'), args: ['/T', '/F', '/PID', String(Math.trunc(pid))] };
}

function runTaskkill(pid: number, env: NodeJS.ProcessEnv, fallback: () => void): void {
  const { file, args } = windowsTreeKillCommand(pid, env);
  const killer = spawn(file, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  // taskkill could not be started: at least the program itself. A taskkill that fails (for example because the process
  // ended already) changes nothing.
  killer.on('error', fallback);
}
