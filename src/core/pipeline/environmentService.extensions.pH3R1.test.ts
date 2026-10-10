// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3 (reviewer B, mutation testing): probes of the shared extension cache in the open that no test
// pinned: the seed script runs with the time limit of the container scripts and the quality of the open's server
// (`insider` seeds ~/.vscode-server-insiders); an empty list asks for no files; an open that did not read its
// configuration keeps the recorded one (it records `undefined`, not an empty list); and a Docker Compose configuration
// records the extensions of its merged configuration too.
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET, VSCODE_STORE_VOLUME, composeProjectName } from '../names';
import type { ComposeModel } from '../helper/composeModel';
import type { ComposeModelOutput } from '../helper/compose';
import type { VscodePlatform } from '../helperChannel/protocol';
import { VSCODE_EXTENSION_SEED_SCRIPT } from '../worker/vscodeExtensionSeed';
import { VSCODE_SERVER_LINK_SCRIPT } from '../worker/vscodeServerLink';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import type { ExtensionRef } from '../vscodeExtensions';
import { BASE_IMAGE, DIGEST_NEW, ENV_ID, FEATURE, FEATURE_DIGEST, REPO, checked, createHarness, seedEnvironment, type Harness, type HarnessOverrides } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import type { RepositoryTarget } from './operationBase';
import type { VscodeExtensionCache } from './environmentPorts';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const STORE_MOUNT = { type: 'volume', volume: VSCODE_STORE_VOLUME, target: VSCODE_STORE_TARGET, readOnly: true as const };

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function fakeCache(list: (configuration: ExtensionRef[] | undefined) => ExtensionRef[] = (configuration) => [...(configuration ?? []), { id: 'user.default' }]) {
  const records: Array<ExtensionRef[] | undefined> = [];
  const seeds: Array<{ list: ExtensionRef[]; platform: VscodePlatform | undefined }> = [];
  const cache: VscodeExtensionCache = {
    record: async (_environmentId, configuration) => {
      records.push(configuration);
      return list(configuration);
    },
    seedFiles: async (wanted, platform) => {
      seeds.push({ list: wanted, platform });
      return wanted.map((ref) => `universal/${ref.id}-1.0.0`);
    },
  };
  return { cache, records, seeds };
}

/** A harness whose execs keep their options. */
function harness(overrides: HarnessOverrides): { t: Harness; options: Array<{ command: readonly string[]; timeoutMs?: number }> } {
  const t = createHarness({ newEnvironmentId: () => ENV_ID, vscodeStoreVolume: VSCODE_STORE_VOLUME, ...overrides });
  h = t;
  t.helper.containerMounts = [STORE_MOUNT];
  t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'linked\n' } : command[2] === VSCODE_EXTENSION_SEED_SCRIPT ? { stdout: 'seeded: 1 copied, 0 present, 0 skipped, 0 failed\n' } : {});
  const options: Array<{ command: readonly string[]; timeoutMs?: number }> = [];
  const docker = t.docker as unknown as { exec: (container: string, command: readonly string[], options?: { timeoutMs?: number }) => Promise<unknown> };
  const exec = docker.exec.bind(t.docker);
  docker.exec = (container, command, execOptions) => {
    options.push({ command, ...(execOptions?.timeoutMs !== undefined ? { timeoutMs: execOptions.timeoutMs } : {}) });
    return exec(container, command, execOptions);
  };
  return { t, options };
}

describe('the shared extension cache in the open, probes (review round 1 of 11H3, reviewer B)', () => {
  it('the seed runs with the time limit of the container scripts (30 s)', async () => {
    const c = fakeCache();
    const { t, options } = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    await t.service.open(TARGET, { progress: t.progress });
    const seed = options.filter((entry) => entry.command[2] === VSCODE_EXTENSION_SEED_SCRIPT);
    expect(seed).toHaveLength(1);
    expect(seed[0].timeoutMs).toBe(30_000);
  });

  it('the quality of the open\'s server goes to the seed (insider: ~/.vscode-server-insiders)', async () => {
    const c = fakeCache();
    const { t } = harness({ vscodeServer: { server: { ...SERVER, quality: 'insider' }, fetch: async () => 'linux-x64', extensions: c.cache } });
    await t.service.open(TARGET, { progress: t.progress });
    const seed = t.docker.execs.filter((exec) => exec.command[2] === VSCODE_EXTENSION_SEED_SCRIPT);
    expect(seed.map((exec) => exec.command.slice(4, 6))).toEqual([['insider', 'linux-x64']]);
  });

  it('an empty list of the open asks for no files and runs no script', async () => {
    const c = fakeCache(() => []);
    const { t } = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    await t.service.open(TARGET, { progress: t.progress });
    expect(c.records).toHaveLength(1);
    expect(c.seeds).toEqual([]);
    expect(t.docker.execs.filter((exec) => exec.command[2] === VSCODE_EXTENSION_SEED_SCRIPT)).toEqual([]);
  });

  it('an open of a running container that reads no configuration records `undefined` (the recorded list stays)', async () => {
    const c = fakeCache();
    const { t } = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    await seedEnvironment(t, { container: 'running' });
    // The helper image cannot be prepared: the running, current container opens as it is, without its configuration.
    t.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    t.helper.tagPresent = true;
    await t.service.openEnvironment(ENV_ID, { progress: t.progress });
    expect(t.logger.errors.some((line) => line.includes('The running environment is opened as it is.'))).toBe(true);
    expect(c.records).toEqual([undefined]);
  });
});

// A Docker Compose configuration as in environmentService.compose.test.ts (the template "… & Postgres").
const PROJECT = composeProjectName(REPO, ENV_ID);
const DB_IMAGE = 'postgres:16';
const DB_DIGEST = `sha256:${'d'.repeat(64)}`;
const FOLDER = '/workspaces/api';
const CONFIG_TEXT = `{
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode"
}`;

function composeOutput(): ComposeModelOutput {
  const model: ComposeModel = {
    name: PROJECT,
    services: {
      app: { image: BASE_IMAGE, command: ['sleep', 'infinity'], volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces', bind: {} }], networks: { default: null } },
      db: { image: DB_IMAGE, networks: { default: null } },
    },
    networks: { default: { name: `${PROJECT}_default` } },
  } as ComposeModel;
  return { version: '2.40.3', dollarEscaped: true, model, dockerfiles: {}, realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/x`]: `${FOLDER}/x` }, inputsHash: 'inputs-1' };
}

describe('the shared extension cache in a Docker Compose open, probe (review round 1 of 11H3, reviewer B)', () => {
  it('records the extensions of the merged configuration', async () => {
    const c = fakeCache();
    const { t } = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64', extensions: c.cache } });
    t.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT } };
    t.helper.composeOutput = composeOutput();
    t.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
    t.helper.merged = { customizations: { vscode: [{ extensions: ['Feature.Ext'] }] } };
    await t.service.open(TARGET, { progress: t.progress });
    expect(c.records).toEqual([[{ id: 'feature.ext' }]]);
  });
});
