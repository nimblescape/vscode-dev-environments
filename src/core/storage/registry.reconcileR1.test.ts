// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11C3 (reviewer B, mutation probe): EnvironmentRegistry.restore leaves out an entry of a known ID.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Environment } from '../types';
import { StoragePaths } from './paths';
import { EnvironmentRegistry } from './registry';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

function entry(repository: string, volumeName: string): Environment {
  return {
    id: ID,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName,
    containerName: volumeName,
    createdAt: '2026-10-04T12:00:00.000Z',
    lastUsedAt: '2026-10-04T12:00:00.000Z',
    owner: { id: '42', login: '' },
  };
}

let root: string;
let registry: EnvironmentRegistry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-restore-r1-'));
  registry = new EnvironmentRegistry(new StoragePaths(root));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('EnvironmentRegistry.restore (review round 1 of 11C3, reviewer B)', () => {
  it('leaves out an entry whose ID the registry has, also with another volume and repository', async () => {
    await registry.add(entry('acme/api', 'volume-a'));
    expect(await registry.restore([entry('acme/web', 'volume-b')])).toEqual({ added: 0, skipped: [] });
    expect((await registry.list()).map((e) => e.volumeName)).toEqual(['volume-a']);
  });
});
