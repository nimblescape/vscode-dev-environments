// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newComputerId, readOrCreateComputerId } from './computerId';
import { StoragePaths } from './paths';
import { ATOMIC_TEMPORARY_FILE } from './storageSweep';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-computer-id-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('computer.id (unit 7, PR 2)', () => {
  it('lives in the global storage folder', () => {
    expect(new StoragePaths(root).computerId).toBe(path.join(root, 'computer.id'));
  });

  it('creates a random id of 128 bits once, and reads it afterwards', () => {
    const file = new StoragePaths(root).computerId;
    const id = readOrCreateComputerId(file);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readFileSync(file, 'utf8')).toBe(id);
    expect(readOrCreateComputerId(file)).toBe(id);
    expect(newComputerId()).not.toBe(newComputerId());
  });

  it('takes the id of a file that another process wrote (surrounding white space is ignored)', () => {
    const file = path.join(root, 'computer.id');
    fs.writeFileSync(file, 'fedcba9876543210fedcba9876543210\n');
    expect(readOrCreateComputerId(file)).toBe('fedcba9876543210fedcba9876543210');
  });

  it('replaces invalid content with a new id', () => {
    const file = path.join(root, 'computer.id');
    fs.writeFileSync(file, 'not an id');
    const id = readOrCreateComputerId(file);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readFileSync(file, 'utf8')).toBe(id);
    expect(fs.readdirSync(root)).toEqual(['computer.id']);
  });

  // Review round 10 of PR #63 (B-R10-1): the replacement is written under the name form of atomicTemporaryPath, in the
  // folder of the file, so that the sweep of the storage folder (storageSweep.ts, R8) removes a leftover.
  it('writes the replacement to a temporary file that the sweep of the storage folder recognises', () => {
    const file = path.join(root, 'computer.id');
    fs.writeFileSync(file, 'not an id');
    // The namespace of the ES module `fs` cannot be spied on; its CommonJS exports can, and syncBuiltinESMExports
    // passes the spy on to the namespace that computerId.ts reads.
    const spy = vi.spyOn(createRequire(import.meta.url)('fs') as typeof fs, 'renameSync');
    syncBuiltinESMExports();
    try {
      readOrCreateComputerId(file);
      expect(spy.mock.calls.length).toBe(1);
      const [temporary, target] = spy.mock.calls[0];
      expect(target).toBe(file);
      expect(path.dirname(String(temporary))).toBe(root);
      expect(path.basename(String(temporary))).toMatch(ATOMIC_TEMPORARY_FILE);
      expect(path.basename(String(temporary)).startsWith(`.computer.id.${process.pid}.`)).toBe(true);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('creates the folder when it is missing', () => {
    const file = path.join(root, 'missing', 'computer.id');
    expect(readOrCreateComputerId(file)).toBe(fs.readFileSync(file, 'utf8'));
  });
});
