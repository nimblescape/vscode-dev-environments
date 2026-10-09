// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1 (reviewer B, E08): the link of the shared VS Code server reads the mount of the
// container of the open itself. A container that the inspect finds under the environment but that is not the container of
// the open (another ID and name) does not count, even when it mounts the store.
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET, VSCODE_STORE_VOLUME } from '../names';
import { VSCODE_SERVER_LINK_SCRIPT } from '../worker/vscodeServerLink';
import { ENV_ID, REPO, createHarness, type Harness } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';
import type { RepositoryTarget } from './operationBase';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const STORE_MOUNT = { type: 'volume', volume: VSCODE_STORE_VOLUME, target: VSCODE_STORE_TARGET, readOnly: true as const };

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe('the link checks the mount of the container of the open (review round 1 of 11H1, E08)', () => {
  it('another container with the mount (another ID and name) does not count: skipped, no script', async () => {
    const t = createHarness({ newEnvironmentId: () => ENV_ID, vscodeServer: { server: SERVER, fetch: async () => 'linux-x64' }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    h = t;
    t.helper.containerMounts = [STORE_MOUNT];
    const find = t.docker.findContainer.bind(t.docker);
    // Only the inspect of the link (linkVscodeServer) gets another container; every other step sees the real one.
    t.docker.findContainer = async (environmentId, containerName) => {
      const found = await find(environmentId, containerName);
      if (found === undefined || !(new Error().stack ?? '').includes('linkVscodeServer')) return found;
      return { ...found, id: 'f'.repeat(64), name: 'devenv-other-container', mountTargets: [STORE_MOUNT] };
    };
    const scripts: string[] = [];
    const exec = t.docker.exec.bind(t.docker);
    t.docker.exec = async (container, command, options) => {
      if (command[2] === VSCODE_SERVER_LINK_SCRIPT) scripts.push(container);
      return exec(container, command, options);
    };
    expect((await t.service.open(TARGET, { progress: t.progress })).vscodeServer).toEqual({ outcome: 'skipped' });
    expect(scripts).toEqual([]);
    expect(t.logger.infos.some((line) => line.includes('does not mount the shared store'))).toBe(true);
  });

  it('the same container (the check passes): linked', async () => {
    const t = createHarness({ newEnvironmentId: () => ENV_ID, vscodeServer: { server: SERVER, fetch: async () => 'linux-x64' }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    h = t;
    t.helper.containerMounts = [STORE_MOUNT];
    const exec = t.docker.exec.bind(t.docker);
    t.docker.exec = async (container, command, options) =>
      command[2] === VSCODE_SERVER_LINK_SCRIPT ? { exitCode: 0, stdout: 'linked\n', stderr: '', timedOut: false } : exec(container, command, options);
    expect((await t.service.open(TARGET, { progress: t.progress })).vscodeServer).toEqual({ outcome: 'linked' });
  });
});
