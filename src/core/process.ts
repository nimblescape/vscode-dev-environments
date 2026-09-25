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

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        stdout += text;
        options.onStdout?.(text);
      });
      child.stderr.on('data', (text: string) => {
        stderr += text;
        options.onStderr?.(text);
      });

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
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });

      // Ignore EPIPE when the process ends before it reads its input.
      child.stdin.on('error', () => {});
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}
