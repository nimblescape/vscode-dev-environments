// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeProcessRunner } from './process';

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

  it('never uses Readable.setEncoding, whose StringDecoder fails in the extension host of VS Code 1.139', async () => {
    const setEncoding = vi.spyOn(Readable.prototype, 'setEncoding');
    const result = await new NodeProcessRunner().run(node, ['-e', 'console.log("hello")']);
    expect(result.stdout).toBe('hello\n');
    expect(setEncoding).not.toHaveBeenCalled();
  });
});
