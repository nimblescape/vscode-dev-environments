// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; live check 3 of the user): the open with a VS Code server records the extension
// list of its environment (the merged configuration's `customizations.vscode.extensions` when it has it, else the
// configuration's own, and the user's defaults) and, right after the link of the server, seeds the cached `.vsix` files
// of the store into the container's extension cache with one script as the remote user; no network, no wait, and a
// failure never fails the open.
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET, VSCODE_STORE_VOLUME } from '../names';
import type { VscodePlatform } from '../helperChannel/protocol';
import { VSCODE_EXTENSION_SEED_SCRIPT } from '../worker/vscodeExtensionSeed';
import { VSCODE_SERVER_LINK_SCRIPT } from '../worker/vscodeServerLink';
import type { ExtensionRef } from '../vscodeExtensions';
import { ENV_ID, REPO, createHarness, seedEnvironment, type Harness, type HarnessOverrides } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';
import type { RepositoryTarget } from './operationBase';
import type { VscodeExtensionCache } from './environmentService';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const STORE_MOUNT = { type: 'volume', volume: VSCODE_STORE_VOLUME, target: VSCODE_STORE_TARGET, readOnly: true as const };

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

/** A cache that records its calls; its files are `files` of the list. */
function fakeCache(files: (list: ExtensionRef[], platform: VscodePlatform | undefined) => string[] = (list) => list.map((ref) => `universal/${ref.id}-1.0.0`)) {
  const records: Array<{ environmentId: string; configuration: ExtensionRef[] | undefined }> = [];
  const seeds: Array<{ list: ExtensionRef[]; platform: VscodePlatform | undefined }> = [];
  const cache: VscodeExtensionCache & { fail?: Error } = {
    record: async (environmentId, configuration) => {
      records.push({ environmentId, configuration });
      if (cache.fail) throw cache.fail;
      return [...(configuration ?? [{ id: 'recorded.only' }]), { id: 'user.default' }];
    },
    seedFiles: async (list, platform) => {
      seeds.push({ list, platform });
      return files(list, platform);
    },
  };
  return { cache, records, seeds };
}

function harness(overrides: HarnessOverrides, platform: VscodePlatform | undefined = 'linux-x64'): Harness {
  h = createHarness({ newEnvironmentId: () => ENV_ID, vscodeStoreVolume: VSCODE_STORE_VOLUME, ...overrides });
  h.helper.containerMounts = [STORE_MOUNT];
  h.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: platform ? 'linked\n' : 'skipped: x\n' } : command[2] === VSCODE_EXTENSION_SEED_SCRIPT ? { stdout: 'seeded: 2 copied, 0 present, 0 skipped, 0 failed\n' } : {});
  return h;
}

const seedsRun = (t: Harness) => t.docker.execs.filter((exec) => exec.command[2] === VSCODE_EXTENSION_SEED_SCRIPT);

describe('the shared extension cache in the open (plan step 11H3)', () => {
  it('records the merged configuration\'s extensions and seeds the cached files once, after the link, as the remote user', async () => {
    const c = fakeCache();
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    t.helper.config = { ...t.helper.config, customizations: { vscode: { extensions: ['own.only'] } } };
    t.helper.merged = { customizations: { vscode: [{ extensions: ['Feature.Ext', 'drop.me'] }, { extensions: ['-drop.me', 'repo.ext@1.2.3'] }] } };
    await t.service.open(TARGET, { progress: t.progress });
    expect(c.records).toEqual([{ environmentId: ENV_ID, configuration: [{ id: 'feature.ext' }, { id: 'repo.ext', version: '1.2.3' }] }]);
    expect(c.seeds).toEqual([{ list: [{ id: 'feature.ext' }, { id: 'repo.ext', version: '1.2.3' }, { id: 'user.default' }], platform: 'linux-x64' }]);
    const seeds = seedsRun(t);
    expect(seeds.map((exec) => [exec.user, exec.command.slice(4)])).toEqual([
      ['vscode', ['stable', 'linux-x64', 'universal/feature.ext-1.0.0', 'universal/repo.ext-1.0.0', 'universal/user.default-1.0.0']],
    ]);
    // Right after the link of the server.
    const order = t.docker.execs.map((exec) => exec.command[2]);
    expect(order.indexOf(VSCODE_EXTENSION_SEED_SCRIPT)).toBe(order.indexOf(VSCODE_SERVER_LINK_SCRIPT) + 1);
    expect(t.logger.infos.some((line) => line.startsWith(`The shared extension cache seeded the container of ${REPO}: 2 copied`))).toBe(true);
  });

  it('uses the configuration\'s own extensions when the merged configuration is not known', async () => {
    const c = fakeCache();
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    t.helper.config = { ...t.helper.config, customizations: { vscode: { extensions: ['own.ext', '-own.ext', 'kept.ext'] } } };
    t.helper.merged = undefined;
    await t.service.open(TARGET, { progress: t.progress });
    expect(c.records[0].configuration).toEqual([{ id: 'kept.ext' }]);
  });

  it('a fetch of the server that found no platform: the seed gets `none` (universal files only)', async () => {
    const c = fakeCache();
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => undefined, extensions: c.cache } }, undefined);
    await t.service.open(TARGET, { progress: t.progress });
    expect(c.seeds[0].platform).toBeUndefined();
    expect(seedsRun(t)[0].command.slice(4, 6)).toEqual(['stable', 'none']);
  });

  it('no cached files: the list is recorded, no script runs', async () => {
    const c = fakeCache(() => []);
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    await t.service.open(TARGET, { progress: t.progress });
    expect(c.records).toHaveLength(1);
    expect(seedsRun(t)).toHaveLength(0);
  });

  it('a container without the store: the list is recorded, nothing is seeded', async () => {
    const c = fakeCache();
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    await seedEnvironment(t, { container: 'running' });
    await t.service.openEnvironment(ENV_ID, { progress: t.progress });
    expect(c.records).toHaveLength(1);
    expect(c.seeds).toHaveLength(0);
    expect(seedsRun(t)).toHaveLength(0);
  });

  it('a failed record or a failed script is one line; the open succeeds', async () => {
    const c = fakeCache();
    c.cache.fail = new Error('disk full');
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    const result = await t.service.open(TARGET, { progress: t.progress });
    expect(result.containerName).toBeTruthy();
    expect(t.logger.warnings).toContain(`The shared extension cache could not seed the container of ${REPO}: disk full`);
    expect(seedsRun(t)).toHaveLength(0);

    const d = fakeCache();
    const u = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: d.cache } });
    u.docker.execHandler = (_container, command) => (command[2] === VSCODE_EXTENSION_SEED_SCRIPT ? { exitCode: 1, stderr: 'boom' } : command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'linked\n' } : {});
    expect((await u.service.open(TARGET, { progress: u.progress })).containerName).toBeTruthy();
    expect(u.logger.infos).toContain(`The shared extension cache did not seed the container of ${REPO} (failed: exit code 1: boom).`);
  });

  it('without the extension cache (no VS Code server of the open): nothing is recorded or seeded', async () => {
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64' } });
    await t.service.open(TARGET, { progress: t.progress });
    expect(seedsRun(t)).toHaveLength(0);
    const u = harness({});
    await u.service.open(TARGET, { progress: u.progress });
    expect(seedsRun(u)).toHaveLength(0);
  });
});
