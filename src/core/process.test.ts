// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURED_OUTPUT_BYTES, MAX_CAPTURED_STDERR_CHARACTERS } from './helper/analysisLimits';
import { NodeProcessRunner, OutputTooLargeError } from './process';

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
