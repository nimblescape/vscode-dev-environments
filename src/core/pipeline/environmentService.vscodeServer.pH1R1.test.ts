// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1 (reviewer B, mutation testing): probes of the open with the shared VS Code server that
// no test held: the fetch starts before Docker is started, one fetch per open also when openFirst hands over to
// openExisting, a Cancel ends the wait for a fetch that does not end by itself, the link script runs with the signal and
// the time limit of the open (the dev container is untrusted: its `ldd` or `uname` may never end), and the fixed name
// devenv-vscode stays excluded when the worker's store has another name.
import { afterEach, describe, expect, it } from 'vitest';
import { LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, LABEL_VOLUME, VOLUME_KIND_ADDITIONAL, VSCODE_STORE_TARGET, VSCODE_STORE_VOLUME, environmentImageName, resourceName } from '../names';
import type { VscodePlatform } from '../helperChannel/protocol';
import { VSCODE_SERVER_LINK_SCRIPT } from '../worker/vscodeServerLink';
import { ACCOUNT, ENV_ID, REPO, createHarness, type Harness, type HarnessOverrides } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { PipelineTexts, type RepositoryTarget } from './operationBase';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const STORE_MOUNT = { type: 'volume', volume: VSCODE_STORE_VOLUME, target: VSCODE_STORE_TARGET, readOnly: true as const };

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(overrides: HarnessOverrides): Harness {
  h = createHarness({ newEnvironmentId: () => ENV_ID, ...overrides });
  h.helper.containerMounts = [STORE_MOUNT];
  return h;
}

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
};

describe('the open with the shared VS Code server, probes (review round 1 of 11H1, reviewer B)', () => {
  it('starts the fetch before Docker is started (so it runs in parallel with every step of the open)', async () => {
    const startsAtFetch: number[] = [];
    const t = harness({
      vscodeServer: {
        server: SERVER,
        fetch: async () => {
          startsAtFetch.push(h!.dockerStarts);
          return 'linux-x64';
        },
      },
      vscodeStoreVolume: VSCODE_STORE_VOLUME,
    });
    await t.service.open(TARGET, { progress: t.progress });
    expect(startsAtFetch).toEqual([0]);
  });

  it('one fetch per open, also when openFirst hands the open over to openExisting (an environment restored from its volume)', async () => {
    const calls: AbortSignal[] = [];
    const t = harness({
      vscodeServer: {
        server: SERVER,
        fetch: async (signal) => {
          calls.push(signal);
          return 'linux-x64';
        },
      },
      vscodeStoreVolume: VSCODE_STORE_VOLUME,
    });
    // A lost registry: the labeled workspace volume and the stopped container of the environment are there.
    const workspace = resourceName(REPO, ENV_ID);
    t.docker.volumes.set(workspace, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    const container = t.docker.addContainer({ environmentId: ENV_ID, name: workspace, state: 'stopped', image: environmentImageName(REPO, ENV_ID, 1) });
    t.docker.containers.set(container.id, { ...container, volumes: [workspace], mountTargets: [STORE_MOUNT] });
    await t.service.open(TARGET, { progress: t.progress });
    expect(t.logger.infos.some((line) => line.includes('was restored from its volume'))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a Cancel ends the wait also for a fetch that does not end by itself', async () => {
    const controller = new AbortController();
    // A fetch that ignores its signal and never ends.
    const t = harness({ vscodeServer: { server: SERVER, fetch: () => new Promise<VscodePlatform | undefined>(() => undefined) }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    const opened = t.service.open(TARGET, { progress: t.progress, signal: controller.signal });
    await until(() => t.progress.details.includes(PipelineTexts.downloadingVscodeServer));
    expect(t.progress.details).toContain(PipelineTexts.downloadingVscodeServer);
    controller.abort();
    await expect(opened).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('runs the link script with the signal of the open and a time limit (an untrusted container may never answer)', async () => {
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64' }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    const seen: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
    const exec = t.docker.exec.bind(t.docker);
    t.docker.exec = async (container, command, options) => {
      if (command[2] === VSCODE_SERVER_LINK_SCRIPT) {
        seen.push({ signal: options?.signal, timeoutMs: options?.timeoutMs });
        return { exitCode: 0, stdout: 'linked\n', stderr: '', timedOut: false };
      }
      return exec(container, command, options);
    };
    const controller = new AbortController();
    expect((await t.service.open(TARGET, { progress: t.progress, signal: controller.signal })).vscodeServer).toEqual({ outcome: 'linked' });
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeDefined();
    expect(typeof seen[0].timeoutMs).toBe('number');
    expect(seen[0].timeoutMs).toBeGreaterThan(0);
    expect(seen[0].timeoutMs).toBeLessThanOrEqual(60_000);
  });

  it('devenv-vscode is never recorded, also when the worker mounts a store of another name', async () => {
    const t = harness({ vscodeServer: { server: SERVER, fetch: async () => 'linux-x64' }, vscodeStoreVolume: 'devenv-test-vscode-x' });
    t.helper.containerMounts = [{ ...STORE_MOUNT, volume: 'devenv-test-vscode-x' }];
    // devenv-vscode with the labels of an additional volume of another environment of this account, mounted by the container.
    t.docker.volumes.set(VSCODE_STORE_VOLUME, { [LABEL_ENVIRONMENT_ID]: 'e0000001-0000-4000-8000-000000000009', [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL });
    t.helper.containerVolumes = [VSCODE_STORE_VOLUME];
    await t.service.open(TARGET, { progress: t.progress });
    expect((await t.registry.get(ENV_ID))?.additionalVolumes ?? []).not.toContain(VSCODE_STORE_VOLUME);
  });
});
