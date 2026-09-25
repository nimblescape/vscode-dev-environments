// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { DockerContextKeys } from '../core/docker/dockerSetup';
import { DOCKER_WALKTHROUGH_ID, DockerSetup, DockerSetupUiTexts, OPEN_WALKTHROUGH_COMMAND } from './dockerSetup';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const ROOT = path.join(__dirname, '..', '..');

function contextCalls(): Array<[string, boolean]> {
  return fakeVscode.commands.executeCommand.mock.calls
    .filter((call) => call[0] === 'setContext')
    .map((call) => [call[1] as string, call[2] as boolean]);
}

function setup(installed: boolean) {
  const docker = { isInstalled: vi.fn(() => installed) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const changed = vi.fn();
  const dockerSetup = new DockerSetup({ docker, logger, onDidChangeInstalled: changed });
  return { dockerSetup, docker, logger, changed };
}

beforeEach(() => {
  resetFakeVscode();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DockerSetup: context keys and CLI checks', () => {
  it('sets all context keys at activation', () => {
    const { dockerSetup } = setup(false);
    dockerSetup.initialize();
    expect(contextCalls()).toEqual([
      [DockerContextKeys.missing, true],
      [DockerContextKeys.installed, false],
      [DockerContextKeys.ready, false],
      [DockerContextKeys.wslReady, false],
    ]);
    expect(dockerSetup.dockerMissing).toBe(true);
    dockerSetup.dispose();
  });

  it('looks the CLI up every 10 seconds while it is missing, then stops and updates the sidebar', () => {
    const { dockerSetup, docker, changed } = setup(false);
    dockerSetup.initialize();
    expect(docker.isInstalled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_999);
    expect(docker.isInstalled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(docker.isInstalled).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    fakeVscode.commands.executeCommand.mockClear();

    docker.isInstalled.mockReturnValue(true);
    vi.advanceTimersByTime(10_000);
    expect(docker.isInstalled).toHaveBeenCalledTimes(3);
    expect(dockerSetup.dockerMissing).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(contextCalls()).toEqual([
      [DockerContextKeys.missing, false],
      [DockerContextKeys.installed, true],
    ]);
    vi.advanceTimersByTime(60_000);
    expect(docker.isInstalled).toHaveBeenCalledTimes(3);
    dockerSetup.dispose();
  });

  it('does not look up an installed CLI in the background', () => {
    const { dockerSetup, docker, changed } = setup(true);
    dockerSetup.initialize();
    vi.advanceTimersByTime(120_000);
    expect(docker.isInstalled).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(contextCalls()).toContainEqual([DockerContextKeys.missing, false]);
    dockerSetup.dispose();
  });

  it('sets dockerReady from the results of docker info that ran anyway', () => {
    const { dockerSetup } = setup(true);
    dockerSetup.initialize();
    fakeVscode.commands.executeCommand.mockClear();
    dockerSetup.reportDaemonStatus(true);
    dockerSetup.reportDaemonStatus(true);
    expect(contextCalls()).toEqual([[DockerContextKeys.ready, true]]);
    dockerSetup.reportDaemonStatus(false);
    expect(contextCalls()).toEqual([
      [DockerContextKeys.ready, true],
      [DockerContextKeys.ready, false],
    ]);
    dockerSetup.dispose();
  });

  it('stops the checks when disposed', () => {
    const { dockerSetup, docker } = setup(false);
    dockerSetup.initialize();
    dockerSetup.dispose();
    vi.advanceTimersByTime(60_000);
    expect(docker.isInstalled).toHaveBeenCalledTimes(1);
  });

  it('counts a failed lookup as missing', () => {
    const { dockerSetup, docker, logger } = setup(true);
    docker.isInstalled.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(dockerSetup.checkCli()).toBe(false);
    expect(dockerSetup.dockerMissing).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    dockerSetup.dispose();
  });
});

describe('DockerSetup: Install Docker…', () => {
  it('opens the walkthrough in a local window', async () => {
    const { dockerSetup } = setup(false);
    await dockerSetup.openWizard();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith(OPEN_WALKTHROUGH_COMMAND, DOCKER_WALKTHROUGH_ID, false);
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('asks for a local window in a remote window', async () => {
    fakeVscode.env.remoteName = 'ssh-remote';
    const { dockerSetup } = setup(false);
    await dockerSetup.openWizard();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith('Open a local window to install Docker.');
    expect(DockerSetupUiTexts.localWindowNeeded).toBe('Open a local window to install Docker.');
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('names the walkthrough of package.json', () => {
    expect(OPEN_WALKTHROUGH_COMMAND).toBe('workbench.action.openWalkthrough');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      publisher: string;
      name: string;
    };
    expect(DOCKER_WALKTHROUGH_ID).toBe(`${manifest.publisher}.${manifest.name}#dockerSetup`);
  });
});
