// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import { abortError, type ProcessRunner, type RunOptions, type RunResult } from './ports';

/** ProcessRunner with `child_process.spawn`, without a shell. */
export class NodeProcessRunner implements ProcessRunner {
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
      child.stdout.on('data', (chunk: Buffer) => onStdout(stdoutDecoder.decode(chunk, { stream: true })));
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
        // The rest of an incomplete character at the end of the output.
        onStdout(stdoutDecoder.decode());
        onStderr(stderrDecoder.decode());
        if (aborted) {
          reject(abortError());
          return;
        }
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });

      // Ignore EPIPE when the process ends before it reads its input.
      child.stdin.on('error', () => {});
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}
