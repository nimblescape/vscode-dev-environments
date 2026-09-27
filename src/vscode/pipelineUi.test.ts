// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Actions, Messages } from '../core/messages';
import { silentLogger } from '../core/ports';
import type { VsCodeGitHubAuth } from './auth';
import { MESSAGE_DEDUPLICATION_MS, VsCodePipelineUi } from './pipelineUi';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now };
  const getPackagesCredentials = vi.fn(async () => ({ username: 'me', password: 'token' }));
  const auth = { getPackagesCredentials } as unknown as VsCodeGitHubAuth;
  const showLog = vi.fn();
  const ui = new VsCodePipelineUi(auth, silentLogger, showLog, clock);
  return { ui, showLog, getPackagesCredentials, advance: (ms: number) => (now += ms) };
}

describe('VsCodePipelineUi', () => {
  beforeEach(() => resetFakeVscode());
  const { window } = fakeVscode;

  it('asks before the first open of a repository of another owner (modal)', async () => {
    const { ui } = setup();
    window.showWarningMessage.mockResolvedValueOnce(Actions.open);
    await expect(ui.confirmUntrustedRepository('other/repo')).resolves.toBe(true);
    expect(window.showWarningMessage).toHaveBeenCalledWith(Messages.untrustedRepository('other/repo'), { modal: true }, 'Open');
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui.confirmUntrustedRepository('other/repo')).resolves.toBe(false);
  });

  it('asks before an environment of an older version is assigned to the account (modal): Assign, or Not now', async () => {
    const { ui } = setup();
    window.showWarningMessage.mockImplementationOnce(async (_message, _options, assign) => assign);
    await expect(ui.confirmAssignment('acme/api', 'octo')).resolves.toBe(true);
    const [message, options, ...items] = window.showWarningMessage.mock.calls[0];
    expect(message).toBe(Messages.assignOlderEnvironment('acme/api', 'octo'));
    expect(options).toEqual({ modal: true });
    expect(items).toEqual([{ title: 'Assign' }, { title: 'Not now', isCloseAffordance: true }]);

    window.showWarningMessage.mockImplementationOnce(async (_message, _options, _assign, notNow) => notNow);
    await expect(ui.confirmAssignment('acme/api', 'octo')).resolves.toBe(false);
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui.confirmAssignment('acme/api', 'octo')).resolves.toBe(false);
  });

  it('asks about a changed configuration: Rebuild now, or Later (also when dismissed)', async () => {
    const { ui } = setup();
    window.showInformationMessage.mockImplementationOnce(async (_message, _options, rebuildNow) => rebuildNow);
    await expect(ui.configurationChanged('acme/api')).resolves.toBe('rebuildNow');
    const [message, options, ...items] = window.showInformationMessage.mock.calls[0];
    expect(message).toBe('The environment configuration changed.');
    expect(options).toMatchObject({ modal: true });
    expect(items.map((item: { title: string }) => item.title)).toEqual(['Rebuild now', 'Later']);

    window.showInformationMessage.mockImplementationOnce(async (_message, _options, _rebuildNow, later) => later);
    await expect(ui.configurationChanged('acme/api')).resolves.toBe('later');
    window.showInformationMessage.mockResolvedValueOnce(undefined);
    await expect(ui.configurationChanged('acme/api')).resolves.toBe('later');
  });

  it('asks about a switch between Docker Compose and a single container: Rebuild now, or Later (also when dismissed) (review round 4, D4-3)', async () => {
    const { ui } = setup();
    const text = Messages.configurationKindChanged(true, '.devcontainer/devcontainer.json');
    window.showWarningMessage.mockImplementationOnce(async (_message, _options, rebuildNow) => rebuildNow);
    await expect(ui.configurationKindChanged('acme/api', text)).resolves.toBe('rebuildNow');
    const [message, options, ...items] = window.showWarningMessage.mock.calls[0];
    expect(message).toBe(text);
    expect(options).toEqual({ modal: true, detail: 'acme/api' });
    expect(items).toEqual([{ title: 'Rebuild now' }, { title: 'Later', isCloseAffordance: true }]);
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui.configurationKindChanged('acme/api', text)).resolves.toBe('later');
  });

  it('asks what to do when the files are missing: Clone again, Delete environment, or cancel', async () => {
    const { ui } = setup();
    window.showWarningMessage.mockResolvedValueOnce(Actions.cloneAgain);
    await expect(ui.filesMissing('acme/api')).resolves.toBe('cloneAgain');
    const [message, , ...items] = window.showWarningMessage.mock.calls[0];
    expect(message).toBe('The files of this environment are missing.');
    expect(items).toEqual(['Clone again', 'Delete environment']);
    window.showWarningMessage.mockResolvedValueOnce(Actions.deleteEnvironment);
    await expect(ui.filesMissing('acme/api')).resolves.toBe('deleteEnvironment');
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui.filesMissing('acme/api')).resolves.toBeUndefined();
  });

  it('shows an identical information message once per minute', () => {
    const { ui, advance } = setup();
    ui.info(Messages.registryUnreachable);
    ui.info(Messages.registryUnreachable);
    advance(MESSAGE_DEDUPLICATION_MS - 1);
    ui.info(Messages.registryUnreachable);
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      'No connection to the image registry. The update check was skipped. The environment uses the local image.',
    );
    ui.info('Another message.');
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
    advance(1);
    ui.info(Messages.registryUnreachable);
    expect(window.showInformationMessage).toHaveBeenCalledTimes(3);
  });

  it('shows a warning with Show details, which opens the log', async () => {
    const { ui, showLog } = setup();
    window.showWarningMessage.mockResolvedValueOnce(Actions.showDetails);
    ui.warn(Messages.buildFailed);
    expect(window.showWarningMessage).toHaveBeenCalledWith('The environment could not be prepared.', 'Show details');
    await flush();
    expect(showLog).toHaveBeenCalledTimes(1);
    ui.warn(Messages.buildFailed);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('offers Sign in for ghcr.io only, and signs in with the scope read:packages', async () => {
    const { ui, getPackagesCredentials } = setup();
    window.showInformationMessage.mockResolvedValueOnce(Actions.signIn);
    ui.registrySignIn('ghcr.io');
    expect(window.showInformationMessage).toHaveBeenCalledWith('The registry ghcr.io requires a sign-in.', 'Sign in');
    await flush();
    expect(getPackagesCredentials).toHaveBeenCalledWith({ interactive: true });

    ui.registrySignIn('docker.io');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('The registry docker.io requires a sign-in.');
    ui.registrySignIn('docker.io');
    ui.registrySignIn('GHCR.IO');
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
  });
});
