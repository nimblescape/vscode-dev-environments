// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"; decision of 2026-10-09, "11H: the shared VS
// Code server and the Session Monitor's daily run"): the open with a VS Code server (EnvironmentServiceDeps.vscodeServer).
// A container that the open creates mounts the store read-only; the fetch of the server starts at the start of the open;
// before the open returns, it waits for the fetch (with a progress detail while it runs) and links the server as the
// remote user, only into a container that mounts the store. A failed fetch or link never fails the open; without a
// server nothing changes.
import { afterEach, describe, expect, it } from 'vitest';
import { LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, LABEL_VOLUME, VOLUME_KIND_ADDITIONAL, VSCODE_STORE_TARGET, VSCODE_STORE_VOLUME, environmentImageName, resourceName, vscodeStoreMount } from '../names';
import type { VscodePlatform } from '../helperChannel/protocol';
import { VSCODE_SERVER_LINK_SCRIPT } from '../worker/vscodeServerLink';
import { ACCOUNT, ENV_ID, REPO, createHarness, seedEnvironment, type Harness, type HarnessOverrides } from './environmentService.testkit';
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

/** A fetch that records its calls (and what the pipeline had done by then) and resolves as `answer` says. */
function fakeFetch(answer: (signal: AbortSignal) => Promise<VscodePlatform | undefined> = async () => 'linux-x64') {
  const calls: Array<{ signal: AbortSignal; helperCallsBefore: number; clonesBefore: number }> = [];
  return {
    calls,
    fetch: (signal: AbortSignal) => {
      calls.push({ signal, helperCallsBefore: h!.helper.calls.length, clonesBefore: h!.helper.clones.length });
      return answer(signal);
    },
  };
}

function harness(overrides: HarnessOverrides): Harness {
  h = createHarness({ newEnvironmentId: () => ENV_ID, ...overrides });
  // The created container mounts the store, as `docker run` gives it to a container of the override.
  h.helper.containerMounts = [STORE_MOUNT];
  return h;
}

/** The runs of the link script. */
const links = (harness: Harness) => harness.docker.execs.filter((exec) => exec.command[2] === VSCODE_SERVER_LINK_SCRIPT);

describe('the open with the shared VS Code server (plan step 11H1)', () => {
  it('first open: the fetch starts before the clone, the new container mounts the store read-only, the link runs as the remote user', async () => {
    const f = fakeFetch();
    const t = harness({ vscodeServer: { server: SERVER, fetch: f.fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'linked\n' } : {});
    const result = await t.service.open(TARGET, { progress: t.progress });
    // Started once, at the start of the open (nothing of the helper ran yet), with the signal of the open.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].clonesBefore).toBe(0);
    expect(f.calls[0].helperCallsBefore).toBe(0);
    // The override mounts the store read-only, last.
    expect((t.helper.ups[0].override.runArgs as string[]).slice(-2)).toEqual(['--mount', vscodeStoreMount(VSCODE_STORE_VOLUME)]);
    // Never created or recorded as a volume of the environment (hazard 1 of the survey).
    expect(t.docker.volumes.has(VSCODE_STORE_VOLUME)).toBe(false);
    expect((await t.registry.get(ENV_ID))?.additionalVolumes ?? []).not.toContain(VSCODE_STORE_VOLUME);
    // The link: as the remote user, with the commit, the quality, and the platform of the store.
    expect(links(t).map((exec) => [exec.user, exec.command.slice(4)])).toEqual([['vscode', [SERVER.commit, 'stable', 'linux-x64']]]);
    expect(result.vscodeServer).toEqual({ outcome: 'linked' });
    expect(t.logger.infos).toContain(`The VS Code server ${SERVER.commit} is linked from the shared store into the container of ${REPO}.`);
    // A fetch that was done by then: no wait, no detail.
    expect(t.progress.details).not.toContain(PipelineTexts.downloadingVscodeServer);
  });

  it('Start of an existing container that mounts the store: the link runs too (every open), present is left as it is', async () => {
    const f = fakeFetch();
    const t = harness({ vscodeServer: { server: SERVER, fetch: f.fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    await seedEnvironment(t, { container: 'stopped' });
    const id = t.docker.containersOf(ENV_ID)[0].id;
    t.docker.containers.set(id, { ...t.docker.containers.get(id)!, mountTargets: [STORE_MOUNT] });
    t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'present\n' } : {});
    const result = await t.service.openEnvironment(ENV_ID, { progress: t.progress });
    expect(f.calls).toHaveLength(1);
    expect(links(t)).toHaveLength(1);
    expect(result.vscodeServer).toEqual({ outcome: 'present' });
  });

  it('waits for a fetch that still runs, with the detail "Downloading the VS Code server." only while it runs', async () => {
    let finish: (platform: VscodePlatform | undefined) => void = () => undefined;
    const f = fakeFetch(() => new Promise((resolve) => (finish = resolve)));
    const t = harness({ vscodeServer: { server: SERVER, fetch: f.fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'linked\n' } : {});
    const opened = t.service.open(TARGET, { progress: t.progress });
    for (let i = 0; i < 200 && !t.progress.details.includes(PipelineTexts.downloadingVscodeServer); i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(t.progress.details).toContain(PipelineTexts.downloadingVscodeServer);
    // The open has not linked yet: it waits.
    expect(links(t)).toHaveLength(0);
    finish('linux-x64');
    const result = await opened;
    expect(result.vscodeServer).toEqual({ outcome: 'linked' });
    // The detail is cleared after the wait.
    expect(t.progress.details.slice(t.progress.details.indexOf(PipelineTexts.downloadingVscodeServer))).toEqual([PipelineTexts.downloadingVscodeServer, '']);
  });

  it('a fetch that failed: no link, `missing`, and the open succeeds', async () => {
    const t = harness({ vscodeServer: { server: SERVER, fetch: fakeFetch(async () => undefined).fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    const result = await t.service.open(TARGET, { progress: t.progress });
    expect(links(t)).toHaveLength(0);
    expect(result.vscodeServer).toEqual({ outcome: 'missing' });
    expect(t.logger.infos).toContain(`The shared store does not have the VS Code server ${SERVER.commit}; the Dev Containers extension installs it into the container of ${REPO}.`);
  });

  it('a fetch that rejects (never by ensureEngineServer) counts as failed; the open succeeds', async () => {
    const t = harness({
      vscodeServer: {
        server: SERVER,
        fetch: fakeFetch(async () => {
          throw new Error('defect');
        }).fetch,
      },
      vscodeStoreVolume: VSCODE_STORE_VOLUME,
    });
    expect((await t.service.open(TARGET, { progress: t.progress })).vscodeServer).toEqual({ outcome: 'missing' });
  });

  it('a container without the store (created before 11H1): no wait, no link, `skipped`', async () => {
    // A fetch that never ends: the open does not wait for it.
    const f = fakeFetch(() => new Promise(() => undefined));
    const t = harness({ vscodeServer: { server: SERVER, fetch: f.fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    await seedEnvironment(t, { container: 'running' });
    const result = await t.service.openEnvironment(ENV_ID, { progress: t.progress });
    expect(f.calls).toHaveLength(1);
    expect(links(t)).toHaveLength(0);
    expect(result.vscodeServer).toEqual({ outcome: 'skipped' });
    expect(t.progress.details).not.toContain(PipelineTexts.downloadingVscodeServer);
  });

  it.each([
    ['a store mounted read-write', [{ ...STORE_MOUNT, readOnly: undefined }]],
    ['another volume at the target', [{ ...STORE_MOUNT, volume: 'other' }]],
    ['the store at another target', [{ ...STORE_MOUNT, target: '/opt/other' }]],
    ['a subpath of the store', [{ ...STORE_MOUNT, subpath: 'server' }]],
  ])('%s is not our mount: no link', async (_name, mounts) => {
    const t = harness({ vscodeServer: { server: SERVER, fetch: fakeFetch().fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    t.helper.containerMounts = mounts as typeof t.helper.containerMounts;
    expect((await t.service.open(TARGET, { progress: t.progress })).vscodeServer).toEqual({ outcome: 'skipped' });
    expect(links(t)).toHaveLength(0);
  });

  it('a failed link script, or a refusal, never fails the open', async () => {
    for (const answer of [{ exitCode: 1, stderr: 'mkdir: Permission denied' }, { stdout: 'refused: /home/vscode/.vscode-server is a link\n' }]) {
      const t = harness({ vscodeServer: { server: SERVER, fetch: fakeFetch().fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
      t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_LINK_SCRIPT ? answer : {});
      expect((await t.service.open(TARGET, { progress: t.progress })).vscodeServer).toEqual({ outcome: 'skipped' });
      t.cleanup();
      h = undefined;
    }
  });

  it('a link that throws (an exec that fails) never fails the open', async () => {
    const t = harness({ vscodeServer: { server: SERVER, fetch: fakeFetch().fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    const exec = t.docker.exec.bind(t.docker);
    t.docker.exec = async (container, command, options) => {
      if (command[2] === VSCODE_SERVER_LINK_SCRIPT) throw new Error('the exec could not be created');
      return exec(container, command, options);
    };
    expect((await t.service.open(TARGET, { progress: t.progress })).vscodeServer).toEqual({ outcome: 'skipped' });
    expect(t.logger.warnings.some((line) => line.includes('could not be linked') && line.includes('the exec could not be created'))).toBe(true);
  });

  it('the store is never recorded as a volume of the environment, also when it carries labels that would make it one', async () => {
    const t = harness({ vscodeServer: { server: SERVER, fetch: fakeFetch().fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    // A store that someone created with the labels of an additional volume of another environment of this account,
    // mounted by the container (such a volume would be recorded, to protect it).
    t.docker.volumes.set(VSCODE_STORE_VOLUME, { [LABEL_ENVIRONMENT_ID]: 'e0000001-0000-4000-8000-000000000009', [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL });
    t.helper.containerVolumes = [VSCODE_STORE_VOLUME];
    await t.service.open(TARGET, { progress: t.progress });
    expect((await t.registry.get(ENV_ID))?.additionalVolumes ?? []).not.toContain(VSCODE_STORE_VOLUME);
  });

  it('a cancel during the wait ends the open', async () => {
    const controller = new AbortController();
    const f = fakeFetch(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(undefined), { once: true });
        }),
    );
    const t = harness({ vscodeServer: { server: SERVER, fetch: f.fetch }, vscodeStoreVolume: VSCODE_STORE_VOLUME });
    const opened = t.service.open(TARGET, { progress: t.progress, signal: controller.signal });
    for (let i = 0; i < 200 && !t.progress.details.includes(PipelineTexts.downloadingVscodeServer); i++) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(opened).rejects.toMatchObject({ code: 'cancelled' });
    // The fetch had the signal of the open, so it ended too.
    expect(f.calls[0].signal.aborted).toBe(true);
    expect(links(t)).toHaveLength(0);
  });

  it('without a server: no mount, no fetch, no link, no value (the open as before)', async () => {
    const t = harness({ vscodeStoreVolume: VSCODE_STORE_VOLUME });
    const result = await t.service.open(TARGET, { progress: t.progress });
    expect(t.helper.ups[0].override.runArgs as string[]).not.toContain(vscodeStoreMount(VSCODE_STORE_VOLUME));
    expect(links(t)).toHaveLength(0);
    expect(result).not.toHaveProperty('vscodeServer');
  });

  it('the store of the worker by its name (a volume of the Docker tests): mounted, never created, and checked by that name', async () => {
    const store = 'devenv-test-vscode-x';
    const t = harness({ vscodeServer: { server: SERVER, fetch: fakeFetch().fetch }, vscodeStoreVolume: store });
    t.helper.containerMounts = [{ ...STORE_MOUNT, volume: store }];
    t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'linked\n' } : {});
    const result = await t.service.open(TARGET, { progress: t.progress });
    expect((t.helper.ups[0].override.runArgs as string[]).slice(-2)).toEqual(['--mount', vscodeStoreMount(store)]);
    expect(t.docker.volumes.has(store)).toBe(false);
    expect(result.vscodeServer).toEqual({ outcome: 'linked' });
  });

  it('a lost registry: the store that the container of an environment mounts is not recorded again (by either name)', async () => {
    for (const store of [VSCODE_STORE_VOLUME, 'devenv-test-vscode-x']) {
      const t = harness({ vscodeStoreVolume: store });
      const workspace = resourceName(REPO, ENV_ID);
      t.docker.volumes.set(workspace, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
      // Docker created the store at the start of a worker: no labels.
      t.docker.volumes.set(store, {});
      const container = t.docker.addContainer({ environmentId: ENV_ID, name: workspace, state: 'stopped', image: environmentImageName(REPO, ENV_ID, 1) });
      t.docker.containers.set(container.id, { ...container, volumes: [workspace, store] });
      expect(await t.service.reconcileFromVolumes()).toBe(1);
      expect((await t.registry.get(ENV_ID))?.additionalVolumes).toBeUndefined();
      t.cleanup();
      h = undefined;
    }
  });
});
