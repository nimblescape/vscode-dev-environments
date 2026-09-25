// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLogger } from './monitorLog';

const T0 = Date.parse('2026-09-24T17:00:00.000Z');

describe('FileLogger', () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
    file = path.join(root, 'monitor.log');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('appends one line per entry with time, process ID, and level', () => {
    const logger = new FileLogger(file, { clock: { now: () => T0 }, pid: 77 });
    logger.info('started');
    logger.warn('two\nlines');
    logger.error('failed', new Error('boom'));
    logger.output('raw text');
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    expect(lines[0]).toBe('2026-09-24T17:00:00.000Z [77] INFO started');
    expect(lines[1]).toBe('2026-09-24T17:00:00.000Z [77] WARN two');
    expect(lines[2]).toBe('    lines');
    expect(lines[3]).toMatch(/^2026-09-24T17:00:00\.000Z \[77\] ERROR failed Error: boom/);
    expect(text.endsWith('raw text\n')).toBe(true);
  });

  it('keeps the content of an existing file', () => {
    fs.writeFileSync(file, 'earlier line\n');
    new FileLogger(file, { clock: { now: () => T0 }, pid: 1 }).info('next');
    expect(fs.readFileSync(file, 'utf8')).toBe('earlier line\n2026-09-24T17:00:00.000Z [1] INFO next\n');
  });

  it('cuts the file to its newer half, at a line start, when it grows above the limit', () => {
    const maxBytes = 4096;
    const logger = new FileLogger(file, { maxBytes, clock: { now: () => T0 }, pid: 1 });
    for (let i = 0; i < 500; i++) logger.info(`entry ${String(i).padStart(4, '0')}`);
    const text = fs.readFileSync(file, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxBytes);
    expect(Buffer.byteLength(text)).toBeGreaterThan(maxBytes / 4);
    expect(text.startsWith('2026-09-24T17:00:00.000Z [1] INFO entry ')).toBe(true);
    expect(text.endsWith('INFO entry 0499\n')).toBe(true);
    expect(fs.readdirSync(root)).toEqual(['monitor.log']);
  });

  it('measures the file now and then, so that content of another process counts too', () => {
    const maxBytes = 8192;
    const logger = new FileLogger(file, { maxBytes, clock: { now: () => T0 }, pid: 1 });
    logger.info('first');
    fs.appendFileSync(file, `${'x'.repeat(100)}\n`.repeat(75));
    // The own estimate stays below the limit for these lines; only the measurement finds the larger file.
    for (let i = 0; i < 70; i++) logger.info('more');
    expect(fs.statSync(file).size).toBeLessThanOrEqual(maxBytes);
  });

  it('never throws when the file cannot be written', () => {
    fs.mkdirSync(file);
    const logger = new FileLogger(file);
    expect(() => {
      logger.info('x');
      logger.error('y', new Error('z'));
      logger.output('z');
    }).not.toThrow();
  });
});
