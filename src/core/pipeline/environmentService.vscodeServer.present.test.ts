// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Fix after the live check of 2026-10-10 (a second open of a running container waited the whole time limit of a stalled
// download for a server that the container had already): before it waits for a fetch that still runs, the open asks the
// container (vscodeServerPresent, as the remote user) whether the server of the window is there already; then the link
// would leave it as it is, so the open does not wait (`present`). Otherwise, and when the check fails, it waits as before.
import { afterEach, describe, expect, it } from 'vitest';
import type { VscodePlatform } from '../helperChannel/protocol';
import { VSCODE_STORE_TARGET, VSCODE_STORE_VOLUME } from '../names';
import { VSCODE_SERVER_LINK_SCRIPT, VSCODE_SERVER_PRESENT_SCRIPT } from '../worker/vscodeServerLink';
import { ENV_ID, REPO, createHarness, seedEnvironment, type Harness, type HarnessOverrides } from './environmentService.testkit';
import { PipelineTexts } from './operationBase';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const STORE_MOUNT = { type: 'volume', volume: VSCODE_STORE_VOLUME, target: VSCODE_STORE_TARGET, readOnly: true as const };

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

/** A running container of the environment that mounts the store, and a fetch as `answer` says. */
async function runningWithStore(answer: () => Promise<VscodePlatform | undefined>, overrides: HarnessOverrides = {}): Promise<Harness> {
  h = createHarness({ newEnvironmentId: () => ENV_ID, vscodeServer: { server: SERVER, fetch: answer }, vscodeStoreVolume: VSCODE_STORE_VOLUME, ...overrides });
  await seedEnvironment(h, { container: 'running' });
  const id = h.docker.containersOf(ENV_ID)[0].id;
  h.docker.containers.set(id, { ...h.docker.containers.get(id)!, mountTargets: [STORE_MOUNT] });
  return h;
}

const checks = (t: Harness) => t.docker.execs.filter((exec) => exec.command[2] === VSCODE_SERVER_PRESENT_SCRIPT);
const links = (t: Harness) => t.docker.execs.filter((exec) => exec.command[2] === VSCODE_SERVER_LINK_SCRIPT);

describe('the open does not wait for a server that the container has (live check of 2026-10-10)', () => {
  it('a fetch that still runs and a container with the server: no wait, no detail, no link, `present`', async () => {
    // A fetch that never ends (a stalled download): the open must not wait for it.
    const t = await runningWithStore(() => new Promise(() => undefined));
    t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_PRESENT_SCRIPT ? { stdout: 'present\n' } : {});
    const result = await t.service.openEnvironment(ENV_ID, { progress: t.progress });
    expect(result.vscodeServer).toEqual({ outcome: 'present' });
    // Asked once, as the remote user, with the commit and the quality.
    expect(checks(t).map((exec) => [exec.user, exec.command.slice(4)])).toEqual([['vscode', [SERVER.commit, 'stable']]]);
    expect(links(t)).toHaveLength(0);
    expect(t.progress.details).not.toContain(PipelineTexts.downloadingVscodeServer);
    expect(t.logger.infos).toContain(`The VS Code server ${SERVER.commit} is in the container of ${REPO} already; the open does not wait for its download into the shared store.`);
  });

  it('a container without the server: the open waits for the fetch as before, then links', async () => {
    let finish: (platform: VscodePlatform | undefined) => void = () => undefined;
    const t = await runningWithStore(() => new Promise((resolve) => (finish = resolve)));
    t.docker.execHandler = (_container, command) =>
      command[2] === VSCODE_SERVER_PRESENT_SCRIPT ? { stdout: 'missing\n' } : command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'linked\n' } : {};
    const opened = t.service.openEnvironment(ENV_ID, { progress: t.progress });
    for (let i = 0; i < 200 && !t.progress.details.includes(PipelineTexts.downloadingVscodeServer); i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(t.progress.details).toContain(PipelineTexts.downloadingVscodeServer);
    expect(checks(t)).toHaveLength(1);
    expect(links(t)).toHaveLength(0);
    finish('linux-x64');
    expect((await opened).vscodeServer).toEqual({ outcome: 'linked' });
  });

  it.each([
    ['fails', { exitCode: 1, stdout: '', stderr: 'awk: not found' }],
    ['answers something else', { stdout: 'what\n' }],
  ])('a check that %s: the open waits as before', async (_name, answer) => {
    let finish: (platform: VscodePlatform | undefined) => void = () => undefined;
    const t = await runningWithStore(() => new Promise((resolve) => (finish = resolve)));
    t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_PRESENT_SCRIPT ? answer : command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'present\n' } : {});
    const opened = t.service.openEnvironment(ENV_ID, { progress: t.progress });
    for (let i = 0; i < 200 && !t.progress.details.includes(PipelineTexts.downloadingVscodeServer); i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(t.progress.details).toContain(PipelineTexts.downloadingVscodeServer);
    finish('linux-x64');
    expect((await opened).vscodeServer).toEqual({ outcome: 'present' });
    expect(links(t)).toHaveLength(1);
  });

  it('a fetch that is done already: no check, the link decides as before', async () => {
    const t = await runningWithStore(async () => 'linux-x64');
    t.docker.execHandler = (_container, command) => (command[2] === VSCODE_SERVER_LINK_SCRIPT ? { stdout: 'linked\n' } : {});
    // Let the fetch settle before the open reaches the link (it starts at the open's start and resolves at once).
    const result = await t.service.openEnvironment(ENV_ID, { progress: t.progress });
    expect(result.vscodeServer).toEqual({ outcome: 'linked' });
    expect(checks(t)).toHaveLength(0);
  });
});
