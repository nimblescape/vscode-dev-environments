// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 3 (pipe loading, user decisions 2026-09-29): the constants and the pure functions of the loader. The loader
// itself runs in pipeLoader.e2e.test.ts.
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  LOADER_BUNDLE_TIMEOUT_MS,
  LOADER_EXIT_CODE,
  MAX_BUNDLE_LINE_LENGTH,
  MAX_READABLE_STDERR_LINE,
  PIPE_LOADER,
  bundleHash,
  encodeBundle,
  loaderCommand,
  readableStderr,
} from './pipeLoader';

describe('the pipe loader', () => {
  it('has the agreed constants', () => {
    expect(LOADER_EXIT_CODE).toBe(3);
    // User decision 2026-09-29: an 8 MiB guard of the memory of the loader.
    expect(MAX_BUNDLE_LINE_LENGTH).toBe(8 * 1024 * 1024);
    expect(LOADER_BUNDLE_TIMEOUT_MS).toBe(60_000);
  });

  it('is one short line of Node.js built-ins with the constants in it', () => {
    // It is one argument of `docker run`: one line, short.
    expect(PIPE_LOADER).not.toContain('\n');
    expect(PIPE_LOADER).not.toContain('\r');
    expect(PIPE_LOADER.length).toBeLessThan(1_500);
    expect(PIPE_LOADER).toContain(`M=${MAX_BUNDLE_LINE_LENGTH}`);
    expect(PIPE_LOADER).toContain(`process.exit(${LOADER_EXIT_CODE})`);
    expect(PIPE_LOADER).toContain(`${LOADER_BUNDLE_TIMEOUT_MS})`);
    expect(PIPE_LOADER).toContain("'devenv loader: '");
    // Only built-ins; never a fixed path, a hash or an entry name (they are its arguments).
    expect(PIPE_LOADER.match(/require\('([^']+)'\)/g)).toEqual(["require('fs')", "require('crypto')", "require('path')"]);
    expect(PIPE_LOADER).not.toMatch(/\/opt\/devenv|startChannel|startMonitor/);
    // It parses as a program.
    expect(() => new Function(PIPE_LOADER)).not.toThrow();
  });

  it('loaderCommand: node -e, the loader, the path, the hash, the entry; nothing else', () => {
    const hash = bundleHash('bundle');
    expect(loaderCommand({ path: '/opt/devenv/x.js', hash, entry: 'startX' })).toEqual(['node', '-e', PIPE_LOADER, '/opt/devenv/x.js', hash, 'startX']);
  });

  it('encodeBundle: the bundle as one JSON line', () => {
    expect(encodeBundle('line 1\nline 2')).toBe('"line 1\\nline 2"\n');
    expect(encodeBundle('a "quote" and \\')).toBe('"a \\"quote\\" and \\\\"\n');
    const line = encodeBundle('x\n'.repeat(1000));
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toBe('x\n'.repeat(1000));
  });

  it('bundleHash: sha256 hex over UTF-8', () => {
    expect(bundleHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bundleHash('ä€')).toBe(createHash('sha256').update(Buffer.from('ä€', 'utf8')).digest('hex'));
    expect(bundleHash('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(bundleHash('a')).not.toBe(bundleHash('b'));
  });

  it('review round 1 of PR #69 (A-R1-3): readableStderr keeps only short lines, and drops the cut first line at the cap', () => {
    expect(MAX_READABLE_STDERR_LINE).toBe(1_000);
    const long = 'y'.repeat(4_000);
    expect(readableStderr(`${long}\ndevenv loader: x\n`, 10_000)).toBe('devenv loader: x');
    expect(readableStderr(`  one  \n\n${'a'.repeat(1_000)}\n${'b'.repeat(1_001)}\ntwo\r\n`, 10_000)).toBe(`one\n${'a'.repeat(1_000)}\ntwo`);
    // Below the cap the first line is whole; at the cap it is the end of a longer line.
    expect(readableStderr('first\nsecond', 100)).toBe('first\nsecond');
    const atCap = `cut end\n${'s'.repeat(92)}`;
    expect(atCap).toHaveLength(100);
    expect(readableStderr(atCap, 100)).toBe('s'.repeat(92));
    expect(readableStderr('', 100)).toBe('');
  });

  it('review round 2 of PR #69 (A-R2-3): readableStderr drops the source excerpt of an uncaught error by its shape', () => {
    const stack = '    at Timeout._onTimeout (/opt/devenv/monitor.js:2:52)';
    // A POSIX header, the source line, the caret line, the error, its stack (a stack position is no header).
    expect(readableStderr(`/opt/devenv/monitor.js:2\nconst SECRET = 1; throw e;\n                  ^\n\nError: bad\n${stack}\n`, 10_000)).toBe(
      '/opt/devenv/monitor.js:2\nError: bad\nat Timeout._onTimeout (/opt/devenv/monitor.js:2:52)',
    );
    // A Windows path with a space; `[eval]` with a caret line of several carets.
    expect(readableStderr('C:\\Program Files\\devenv\\monitor.js:12\n  SECRET();\n  ^\nTypeError: x', 10_000)).toBe('C:\\Program Files\\devenv\\monitor.js:12\nTypeError: x');
    expect(readableStderr('D:/devenv/monitor.js:3\nSECRET\n^\n42', 10_000)).toBe('D:/devenv/monitor.js:3\n42');
    expect(readableStderr('[eval]:1\nSECRET.x\n^^^^^^\n\nReferenceError: SECRET is not defined', 10_000)).toBe('[eval]:1\nReferenceError: SECRET is not defined');
    expect(readableStderr('[eval]-wrapper:6\nSECRET\n', 10_000)).toBe('[eval]-wrapper:6');
    // An excerpt without a caret line (the column is not known): the line after the header is dropped all the same.
    expect(readableStderr('/opt/devenv/monitor.js:7\nSECRET\nError: x\n', 10_000)).toBe('/opt/devenv/monitor.js:7\nError: x');
    expect(readableStderr('C:\\devenv\\monitor.js:7\nSECRET\nError: x\n', 10_000)).toBe('C:\\devenv\\monitor.js:7\nError: x');
    // The header cut off at the cap: the source line is dropped with its caret line.
    const cut = `nitor.js:7\nconst SECRET = 1;\n      ^\n42\n`;
    expect(readableStderr(cut.padStart(100, 'h'), 100)).toBe('42');
    expect(readableStderr('devenv loader: x\nSECRET\n  ^^\nlast', 10_000)).toBe('devenv loader: x\nlast');
    // Only the line right above a caret line; a line filtered out already takes nothing else with it.
    expect(readableStderr(`devenv loader: x\n${'y'.repeat(2_000)}\n^\nlast`, 10_000)).toBe('devenv loader: x\nlast');
    // Not headers: a plain loader line, a line with a colon and a number that is no path, a stack position.
    expect(readableStderr('devenv loader: the entry failed: 42\nnext', 10_000)).toBe('devenv loader: the entry failed: 42\nnext');
    expect(readableStderr('Error: port 22\nnext', 10_000)).toBe('Error: port 22\nnext');
    expect(readableStderr('Error: connect ECONNREFUSED 127.0.0.1:2375\nnext', 10_000)).toBe('Error: connect ECONNREFUSED 127.0.0.1:2375\nnext');
    expect(readableStderr(`${stack}\nnext`, 10_000)).toBe('at Timeout._onTimeout (/opt/devenv/monitor.js:2:52)\nnext');
    expect(readableStderr('/opt/devenv/monitor.js:2:52\nnext', 10_000)).toBe('/opt/devenv/monitor.js:2:52\nnext');
    // A header with leading blanks is recognised (lines are trimmed).
    expect(readableStderr('  /opt/devenv/monitor.js:2\nSECRET\nlast', 10_000)).toBe('/opt/devenv/monitor.js:2\nlast');
  });
});
