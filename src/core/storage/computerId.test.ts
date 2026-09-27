// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newComputerId, readOrCreateComputerId } from './computerId';
import { StoragePaths } from './paths';

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

  it('creates the folder when it is missing', () => {
    const file = path.join(root, 'missing', 'computer.id');
    expect(readOrCreateComputerId(file)).toBe(fs.readFileSync(file, 'utf8'));
  });
});
