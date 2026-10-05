// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #106 (B, mutation probes): the HostSide of this window records the configuration path of the
// request of a first open as it is (`record createEnvironment`).
import { expect, it } from 'vitest';
import { silentLogger } from '../core/ports';
import type { EnvironmentRegistry } from '../core/storage/registry';
import type { RegistryFile } from '../core/types';
import { extensionHostSide, type HostSideDeps } from './hostSide';

const NEW = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';

it('the entry of a first open keeps the configuration path of the request', async () => {
  for (const configPath of ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']) {
    let file: RegistryFile = { version: 1, environments: [] };
    const update = (async <T>(mutator: (file: RegistryFile) => T | Promise<T>) => {
      const copy = structuredClone(file);
      const result = await mutator(copy);
      file = copy;
      return structuredClone(result);
    }) as EnvironmentRegistry['update'];
    const deps = {
      registry: { update, updateEnvironment: async () => undefined },
      sessionFiles: { readWindowStatuses: async () => [] },
      ui: {},
      auth: { getAccount: async () => ({ id: '42', login: 'octo' }) },
      credentials: {},
      settings: () => ({}),
      windowId: 'w1',
      pid: 100,
      clock: { now: () => Date.parse('2026-10-05T12:00:00.000Z') },
      isProcessAlive: () => true,
      logger: silentLogger,
    } as unknown as HostSideDeps;
    const created = await extensionHostSide(deps).records.createEnvironment(NEW, 'acme/api', configPath, { dockerHost: 'ssh://box' });
    expect(created.configPath).toBe(configPath);
    expect(file.environments[0]?.configPath).toBe(configPath);
  }
});
