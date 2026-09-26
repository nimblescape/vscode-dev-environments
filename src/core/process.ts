// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import { MAX_CAPTURED_OUTPUT_BYTES } from './helper/analysisLimits';
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
 * standard output are kept; beyond, the program is stopped and `run` rejects with OutputTooLargeError.
 */
export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly maxStdoutBytes: number = MAX_CAPTURED_OUTPUT_BYTES) {}

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
        options.onStderr?.(text);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxStdoutBytes) {
          tooLarge = true;
          stdout = '';
          child.kill();
          return;
        }
        onStdout(stdoutDecoder.decode(chunk, { stream: true }));
      });
      child.stderr.on('data', (chunk: Buffer) => onStderr(stderrDecoder.decode(chunk, { stream: true })));

      const timer =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, options.timeoutMs)
          : undefined;
      const onAbort = () => {
        aborted = true;
        child.kill();
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
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });

      // Ignore EPIPE when the process ends before it reads its input.
      child.stdin.on('error', () => {});
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}
