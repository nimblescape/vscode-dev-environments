// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of PR #111 (mutation probes): the open in the worker from the extension's side. The trust of the
// repository is sent as it is (B1-75); the answer of the worker is checked against this window's registry on each of its
// own terms: the environment of the open (B1-32, B1-77), of the signed-in account (B1-33) and of the Docker host of the
// operation (B1-34), each with all other terms fitting; the default of stopOnClose is on (B1-52).
import type { OperationFlow } from './environmentOperations';
import { describe, expect, it } from 'vitest';
import type { EnvironmentServiceDeps } from './environmentService';
import { ENV_ID, OTHER_ACCOUNT, OTHER_ID, REPO, createHarness, seedEnvironment } from './environmentService.testkit';

const OPENED = { environmentId: ENV_ID, containerName: 'devenv-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };
const TARGET = { repository: REPO, defaultBranch: null, configPaths: ['.devcontainer/devcontainer.json'], trusted: true };

function harness(answer: (h: ReturnType<typeof createHarness>) => Promise<unknown>) {
  const sent: Record<string, unknown>[] = [];
  const h: ReturnType<typeof createHarness> = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: { prefixes: [], schedule: '7 6 * * *', timeZone: 'UTC' }, listSent: () => {} }),
    flow: (async (_op: string, params: unknown) => (sent.push(params as Record<string, unknown>), answer(h))) as OperationFlow,
  });
  return { h, sent };
}

const rejection = (promise: Promise<unknown>) => promise.then((value) => ({ resolved: value }), (error: unknown) => error);
const notTheOne = (error: unknown) => expect((error as Error).message).toContain('not the one of the open');

describe('the open in the worker (review B, round 1 of PR #111)', () => {
  it('B1-75: the trust of an untrusted repository is sent as it is (the worker asks the confirmation)', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedEnvironment(h, { container: 'stopped' });
    await h.operations.openInWorker({ ...TARGET, trusted: false }, { progress: h.progress });
    expect(sent[0]).toMatchObject({ target: { trusted: false } });
  });

  it('B1-32: an answer with another environment of the same account, host and folder is refused', async () => {
    const { h } = harness(async () => ({ opened: { ...OPENED, environmentId: OTHER_ID } }));
    await seedEnvironment(h, { container: 'stopped' });
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: 'stopped', extra: { remoteWorkspaceFolder: OPENED.remoteWorkspaceFolder } });
    notTheOne(await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress })));
  });

  it('B1-77: the open of a repository is answered with the environment of that repository for the account only', async () => {
    const { h } = harness(async () => ({ opened: { ...OPENED, environmentId: OTHER_ID } }));
    await seedEnvironment(h, { container: 'stopped' });
    // Of another repository, but with the same folder: only the expected environment tells them apart.
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: 'stopped', extra: { remoteWorkspaceFolder: OPENED.remoteWorkspaceFolder } });
    notTheOne(await rejection(h.operations.openInWorker(TARGET, { progress: h.progress })));
  });

  it('B1-33: an environment that belongs to another account by the time of the answer is refused', async () => {
    const { h } = harness(async (hh) => {
      await hh.registry.updateEnvironment(ENV_ID, (entry) => void (entry.owner = OTHER_ACCOUNT));
      return { opened: OPENED };
    });
    await seedEnvironment(h, { container: 'stopped' });
    notTheOne(await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress })));
  });

  it('B1-34: an environment that is on another Docker host by the time of the answer is refused', async () => {
    const { h } = harness(async (hh) => {
      await hh.registry.updateEnvironment(ENV_ID, (entry) => void (entry.dockerHost = 'ssh://box'));
      return { opened: OPENED };
    });
    await seedEnvironment(h, { container: 'stopped' });
    notTheOne(await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress })));
  });

  it('B1-52: without the setting stopOnClose, the open stops the container on close (its default)', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedEnvironment(h, { container: 'stopped' });
    const { stopOnClose: _unset, ...settings } = h.settings;
    h.settings = settings as typeof h.settings;
    await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
    expect(sent[0]).toMatchObject({ settings: { stopOnClose: true } });
  });
});
