// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { DownloadOptions } from '../core/docker/dockerDownload';
import {
  DOCKER_DESKTOP_DOWNLOADS,
  DOCKER_ENGINE_INSTALL_URL,
  DockerContextKeys,
  DockerSetupTexts,
  installConfirmation,
  installPlan,
  type InstallPlanInput,
  type SetupTool,
} from '../core/docker/dockerSetup';
import { UserFacingError } from '../core/errors';
import { Messages, Steps } from '../core/messages';
import { abortError, type RunResult } from '../core/ports';
import { Commands } from './commands';
import {
  DOCKER_SETUP_START_COMMAND,
  DOCKER_WALKTHROUGH_ID,
  DockerSetup,
  DockerSetupUiTexts,
  INSTALL_TERMINAL_NAME,
  OPEN_WALKTHROUGH_COMMAND,
  type DockerSetupDeps,
} from './dockerSetup';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const ROOT = path.join(__dirname, '..', '..');

function contextCalls(): Array<[string, boolean]> {
  return fakeVscode.commands.executeCommand.mock.calls
    .filter((call) => call[0] === 'setContext')
    .map((call) => [call[1] as string, call[2] as boolean]);
}

interface SetupOptions {
  platform?: NodeJS.Platform;
  input?: Partial<InstallPlanInput>;
  tools?: SetupTool[];
  wsl?: () => RunResult | Promise<RunResult>;
  download?: (options: DownloadOptions) => Promise<void>;
  startDocker?: DockerSetupDeps['startDocker'];
}

function setup(installed: boolean, options: SetupOptions = {}) {
  const platform = options.platform ?? 'darwin';
  const docker = { isInstalled: vi.fn(() => installed), lookUpCliNow: vi.fn(() => installed) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const changed = vi.fn();
  const runner = {
    run: vi.fn(async (_file: string, _args: readonly string[]) =>
      options.wsl ? options.wsl() : { exitCode: 1, stdout: '', stderr: '', timedOut: false },
    ),
  };
  const launch = vi.fn(async () => {});
  const showLog = vi.fn();
  const download = vi.fn(options.download ?? (async () => {}));
  const tools = options.tools ?? [];
  const dockerSetup = new DockerSetup({
    docker,
    runner,
    logger,
    showLog,
    platform,
    env: {},
    onDidChangeInstalled: changed,
    planInput: async () => ({ platform, arch: 'arm64', has: (tool: SetupTool) => tools.includes(tool), ...options.input }),
    downloadFolder: path.join(os.tmpdir(), 'devenv-downloads-test'),
    download,
    launch,
    startDocker: options.startDocker ?? (async () => {}),
  } as unknown as DockerSetupDeps);
  return { dockerSetup, docker, logger, changed, runner, launch, showLog, download };
}

/** Lets the pending promise callbacks run (the fake timers do not delay them). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function confirmWith(button: string | undefined): void {
  fakeVscode.window.showWarningMessage.mockResolvedValue(button);
}

function modalCalls(): Array<[string, { modal: boolean; detail: string }, string]> {
  return fakeVscode.window.showWarningMessage.mock.calls as Array<[string, { modal: boolean; detail: string }, string]>;
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

describe('DockerSetup: Install Docker (walkthrough step 2)', () => {
  it('runs the Homebrew command in a visible terminal after the modal confirmation, and nothing before it', async () => {
    const { dockerSetup } = setup(false, { tools: ['brew'] });
    confirmWith(DockerSetupTexts.install);
    await dockerSetup.install();
    const plan = installPlan({ platform: 'darwin', arch: 'arm64', has: (tool) => tool === 'brew' });
    const confirmation = installConfirmation(plan)!;
    expect(modalCalls()).toEqual([[confirmation.message, { modal: true, detail: confirmation.detail }, confirmation.button]]);
    expect(confirmation.detail).toContain('brew install --cask docker-desktop');
    expect(fakeVscode.terminals).toHaveLength(1);
    expect(fakeVscode.terminals[0]).toMatchObject({ name: INSTALL_TERMINAL_NAME, shown: 1, lines: ['brew install --cask docker-desktop'] });
    dockerSetup.dispose();
  });

  it('runs nothing when the confirmation is cancelled', async () => {
    const { dockerSetup, download } = setup(false, { tools: ['brew'] });
    confirmWith(undefined);
    await dockerSetup.install();
    expect(fakeVscode.terminals).toEqual([]);
    const withoutBrew = setup(false);
    await withoutBrew.dockerSetup.install();
    expect(download).not.toHaveBeenCalled();
    expect(withoutBrew.download).not.toHaveBeenCalled();
    expect(withoutBrew.launch).not.toHaveBeenCalled();
    dockerSetup.dispose();
    withoutBrew.dockerSetup.dispose();
  });

  it('joins the Linux commands with && in one terminal line', async () => {
    const osRelease = { ID: 'ubuntu', VERSION_CODENAME: 'noble' };
    const { dockerSetup } = setup(false, { platform: 'linux', input: { arch: 'x64', osRelease } });
    confirmWith(DockerSetupTexts.install);
    await dockerSetup.install();
    const plan = installPlan({ platform: 'linux', arch: 'x64', osRelease, has: () => false });
    if (plan.kind !== 'terminal') throw new Error('terminal plan expected');
    expect(fakeVscode.terminals[0].lines).toEqual([plan.commands.join(' && ')]);
    expect(modalCalls()[0][1].detail).toContain(DockerSetupTexts.adminPassword);
    dockerSetup.dispose();
  });

  it('sends the winget command as its own line on Windows', async () => {
    const { dockerSetup } = setup(false, { platform: 'win32', tools: ['winget'], input: { arch: 'x64' } });
    confirmWith(DockerSetupTexts.install);
    await dockerSetup.install();
    expect(fakeVscode.terminals[0].lines).toEqual([
      'winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements',
    ]);
    dockerSetup.dispose();
  });

  it('opens the installation guide for a distribution without a plan', async () => {
    const { dockerSetup } = setup(false, { platform: 'linux', input: { osRelease: { ID: 'arch' } } });
    await dockerSetup.install();
    expect(fakeVscode.env.openExternal).toHaveBeenCalledTimes(1);
    expect(String(fakeVscode.env.openExternal.mock.calls[0][0])).toBe(DOCKER_ENGINE_INSTALL_URL);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(DockerSetupUiTexts.manualInstall);
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.terminals).toEqual([]);
    dockerSetup.dispose();
  });

  it('downloads the .dmg with a cancellable progress after the confirmation, then opens it', async () => {
    const { dockerSetup, download, launch } = setup(false, {
      download: async (options) => {
        options.onProgress?.(3 * 1_048_576, 10 * 1_048_576);
      },
    });
    const reports: unknown[] = [];
    fakeVscode.window.withProgress.mockImplementation(async (progressOptions: unknown, task: (...args: unknown[]) => Promise<unknown>) => {
      reports.push(progressOptions);
      return task({ report: (value: unknown) => reports.push(value) }, { onCancellationRequested: () => ({ dispose() {} }) });
    });
    confirmWith(DockerSetupTexts.download);
    await dockerSetup.install();
    const target = path.join(os.tmpdir(), 'devenv-downloads-test', 'Docker.dmg');
    expect(modalCalls()[0][0]).toBe(DockerSetupTexts.confirmDownload);
    expect(modalCalls()[0][1].detail).toContain(DOCKER_DESKTOP_DOWNLOADS.macArm64);
    expect(modalCalls()[0][1].detail).toContain(target);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0]).toMatchObject({ url: DOCKER_DESKTOP_DOWNLOADS.macArm64, target });
    expect(reports[0]).toEqual({ location: 15, title: DockerSetupUiTexts.downloading, cancellable: true });
    expect(reports[1]).toEqual({ message: '3 of 10 MB', increment: 30 });
    expect(launch).toHaveBeenCalledWith('/usr/bin/open', [target]);
    expect(fakeVscode.terminals).toEqual([]);
    dockerSetup.dispose();
  });

  it('starts the downloaded installer on Windows through the shell of the system', async () => {
    const { dockerSetup, launch } = setup(false, { platform: 'win32', input: { arch: 'x64' } });
    fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
      task({ report: () => {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    );
    confirmWith(DockerSetupTexts.download);
    await dockerSetup.install();
    expect(launch).not.toHaveBeenCalled();
    const opened = fakeVscode.env.openExternal.mock.calls[0][0] as { scheme: string; fsPath: string };
    expect(opened.scheme).toBe('file');
    expect(opened.fsPath).toBe(path.join(os.tmpdir(), 'devenv-downloads-test', 'Docker Desktop Installer.exe'));
    dockerSetup.dispose();
  });

  it('opens nothing after a cancelled download', async () => {
    const { dockerSetup, launch, logger } = setup(false, {
      download: async () => {
        throw abortError();
      },
    });
    fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
      task({ report: () => {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    );
    confirmWith(DockerSetupTexts.download);
    await dockerSetup.install();
    expect(launch).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('The download of Docker Desktop was cancelled.');
    dockerSetup.dispose();
  });

  it('shows a failed download with Show details', async () => {
    const { dockerSetup, launch, showLog } = setup(false, {
      download: async () => {
        throw new Error('HTTP status 500');
      },
    });
    fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
      task({ report: () => {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    );
    fakeVscode.window.showErrorMessage.mockResolvedValue(DockerSetupUiTexts.showDetails);
    confirmWith(DockerSetupTexts.download);
    await dockerSetup.install();
    await flush();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(DockerSetupUiTexts.downloadFailed, DockerSetupUiTexts.showDetails);
    expect(showLog).toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    dockerSetup.dispose();
  });

  it('looks the CLI up every 5 seconds after the installation, then offers Start Docker', async () => {
    const { dockerSetup, docker, changed } = setup(false, { tools: ['brew'] });
    dockerSetup.initialize();
    confirmWith(DockerSetupTexts.install);
    await dockerSetup.install();
    vi.advanceTimersByTime(5_000);
    expect(docker.lookUpCliNow).toHaveBeenCalledTimes(1);
    docker.lookUpCliNow.mockReturnValue(true);
    fakeVscode.window.showInformationMessage.mockResolvedValue(DockerSetupUiTexts.startDocker);
    vi.advanceTimersByTime(5_000);
    expect(docker.lookUpCliNow).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(DockerSetupUiTexts.installedStartNow, DockerSetupUiTexts.startDocker);
    await flush();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith(DOCKER_SETUP_START_COMMAND);
    expect(DOCKER_SETUP_START_COMMAND).toBe(Commands.dockerSetupStart);
    vi.advanceTimersByTime(60_000);
    expect(docker.lookUpCliNow).toHaveBeenCalledTimes(2);
    dockerSetup.dispose();
  });

  it('stops looking after 30 minutes', async () => {
    const { dockerSetup, docker } = setup(false, { tools: ['brew'] });
    confirmWith(DockerSetupTexts.install);
    await dockerSetup.install();
    vi.advanceTimersByTime(30 * 60_000);
    const calls = docker.lookUpCliNow.mock.calls.length;
    expect(calls).toBe(360);
    vi.advanceTimersByTime(60_000);
    expect(docker.lookUpCliNow).toHaveBeenCalledTimes(calls);
    dockerSetup.dispose();
  });

  it('asks for a local window in a remote window, and runs nothing', async () => {
    fakeVscode.env.remoteName = 'wsl';
    const { dockerSetup, download, runner } = setup(false, { tools: ['brew'] });
    await dockerSetup.install();
    await dockerSetup.start();
    await dockerSetup.installWsl();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(3);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(DockerSetupUiTexts.localWindowNeeded);
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.terminals).toEqual([]);
    expect(download).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    dockerSetup.dispose();
  });
});

describe('DockerSetup: Start Docker (walkthrough step 3)', () => {
  it('starts Docker with a progress notification', async () => {
    const startDocker = vi.fn(async () => {});
    const { dockerSetup } = setup(true, { startDocker });
    const titles: unknown[] = [];
    fakeVscode.window.withProgress.mockImplementation(async (options: unknown, task: (...args: unknown[]) => Promise<unknown>) => {
      titles.push(options);
      return task({ report: () => {} }, { onCancellationRequested: () => ({ dispose() {} }) });
    });
    await dockerSetup.start();
    expect(titles).toEqual([{ location: 15, title: Steps.startingDocker, cancellable: true }]);
    expect(startDocker).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(DockerSetupUiTexts.dockerRunning);
    dockerSetup.dispose();
  });

  it('starts Docker Engine on Linux with systemctl in the terminal, after the confirmation', async () => {
    const { dockerSetup } = setup(true, {
      platform: 'linux',
      startDocker: async () => {
        throw new UserFacingError('dockerEngineNotRunning', Messages.dockerEngineNotRunning);
      },
    });
    fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
      task({ report: () => {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    );
    confirmWith(DockerSetupTexts.start);
    await dockerSetup.start();
    expect(modalCalls()).toEqual([
      [
        DockerSetupTexts.confirmStartEngine,
        { modal: true, detail: `${DockerSetupTexts.confirmCommands}\n\nsudo systemctl enable --now docker\n\n${DockerSetupTexts.adminPassword}` },
        DockerSetupTexts.start,
      ],
    ]);
    expect(fakeVscode.terminals[0].lines).toEqual(['sudo systemctl enable --now docker']);
    dockerSetup.dispose();
  });

  it('passes other errors to the caller, which shows them', async () => {
    const error = new UserFacingError('dockerStartFailed', Messages.dockerStartFailed);
    const { dockerSetup } = setup(true, {
      startDocker: async () => {
        throw error;
      },
    });
    fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
      task({ report: () => {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    );
    await expect(dockerSetup.start()).rejects.toBe(error);
    expect(fakeVscode.terminals).toEqual([]);
    dockerSetup.dispose();
  });
});

describe('DockerSetup: WSL 2 (walkthrough step 1, Windows)', () => {
  const status = (exitCode: number): RunResult => ({ exitCode, stdout: '', stderr: '', timedOut: false });

  it('checks wsl --status at activation while Docker is missing', async () => {
    const { dockerSetup, runner } = setup(false, { platform: 'win32', wsl: () => status(0) });
    dockerSetup.initialize();
    await flush();
    expect(runner.run).toHaveBeenCalledWith('wsl.exe', ['--status'], { timeoutMs: 15_000 });
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, true]);
    dockerSetup.dispose();
  });

  it('does not run wsl on other platforms or when Docker is installed', async () => {
    const mac = setup(false, { platform: 'darwin' });
    mac.dockerSetup.initialize();
    const installed = setup(true, { platform: 'win32' });
    installed.dockerSetup.initialize();
    await flush();
    expect(mac.runner.run).not.toHaveBeenCalled();
    expect(installed.runner.run).not.toHaveBeenCalled();
    mac.dockerSetup.dispose();
    installed.dockerSetup.dispose();
  });

  it('runs wsl --install in the terminal after the confirmation, then checks again', async () => {
    let exitCode = 1;
    const { dockerSetup, runner } = setup(false, { platform: 'win32', wsl: () => status(exitCode) });
    confirmWith(DockerSetupTexts.install);
    await dockerSetup.installWsl();
    expect(modalCalls()[0][0]).toBe(DockerSetupTexts.confirmWsl);
    expect(modalCalls()[0][1].detail).toBe(`${DockerSetupTexts.confirmCommands}\n\nwsl --install\n\n${DockerSetupTexts.wslRestart}`);
    expect(fakeVscode.terminals[0].lines).toEqual(['wsl --install']);
    exitCode = 0;
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, true]);
    dockerSetup.dispose();
  });

  it('counts a wsl that cannot run as not ready', async () => {
    const { dockerSetup } = setup(false, {
      platform: 'win32',
      wsl: () => {
        throw new Error('spawn wsl.exe ENOENT');
      },
    });
    dockerSetup.initialize();
    await flush();
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, false]);
    dockerSetup.dispose();
  });
});

describe('walkthrough (package.json)', () => {
  interface Step {
    id: string;
    title: string;
    description: string;
    media: { markdown: string };
    completionEvents: string[];
    when?: string;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: {
      walkthroughs: Array<{ id: string; title: string; steps: Step[] }>;
      commands: Array<{ command: string; title: string; category: string }>;
      menus: { commandPalette: Array<{ command: string; when: string }> };
    };
    files?: string[];
  };
  const [walkthrough] = manifest.contributes.walkthroughs;
  const step = (id: string) => walkthrough.steps.find((candidate) => candidate.id === id)!;

  it('is the walkthrough dockerSetup with its title', () => {
    expect(manifest.contributes.walkthroughs).toHaveLength(1);
    expect(walkthrough.id).toBe('dockerSetup');
    expect(walkthrough.title).toBe('Set up Docker for Dev Environments');
  });

  it('has the steps per platform, which check themselves off through the context keys', () => {
    expect(walkthrough.steps.map((entry) => [entry.id, entry.when, entry.completionEvents])).toEqual([
      ['wsl', 'isWindows', ['onContext:devEnvironments.wslReady']],
      ['installMac', 'isMac', ['onContext:devEnvironments.dockerInstalled']],
      ['installWindows', 'isWindows', ['onContext:devEnvironments.dockerInstalled']],
      ['installLinux', 'isLinux', ['onContext:devEnvironments.dockerInstalled']],
      ['startDesktop', 'isMac || isWindows', ['onContext:devEnvironments.dockerReady']],
      ['startLinux', 'isLinux', ['onContext:devEnvironments.dockerReady']],
      ['signIn', undefined, ['onContext:devEnvironments.signedIn']],
    ]);
  });

  it('has the buttons of the steps', () => {
    expect(step('wsl').description).toContain('(command:devEnvironments.dockerSetup.installWsl)');
    for (const id of ['installMac', 'installWindows', 'installLinux']) {
      expect(step(id).description).toContain('[Install Docker](command:devEnvironments.dockerSetup.install)');
    }
    for (const id of ['startDesktop', 'startLinux']) {
      expect(step(id).description).toContain('[Start Docker](command:devEnvironments.dockerSetup.start)');
    }
    expect(step('signIn').description).toContain('[Sign in with GitHub](command:devEnvironments.signIn)');
  });

  it('uses the context keys that the extension sets', () => {
    const keys = new Set(walkthrough.steps.flatMap((entry) => entry.completionEvents.map((event) => event.replace('onContext:', ''))));
    expect([...keys].sort()).toEqual(
      [DockerContextKeys.wslReady, DockerContextKeys.installed, DockerContextKeys.ready, 'devEnvironments.signedIn'].sort(),
    );
  });

  it('has a media file for each step in resources/walkthrough, which the package includes', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
    expect(ignore).toContain('!resources/**');
    for (const entry of walkthrough.steps) {
      expect(entry.media.markdown).toMatch(/^resources\/walkthrough\/[a-z-]+\.md$/);
      expect(fs.existsSync(path.join(ROOT, entry.media.markdown)), entry.media.markdown).toBe(true);
    }
  });

  it('names the license of Docker Desktop and the signature of the installers in the install steps', () => {
    const read = (id: string) => fs.readFileSync(path.join(ROOT, step(id).media.markdown), 'utf8');
    for (const id of ['installMac', 'installWindows']) {
      expect(read(id)).toContain('Docker Subscription Service Agreement');
      expect(read(id)).toContain('desktop.docker.com');
      expect(read(id)).toMatch(/signed/);
    }
    expect(read('installMac')).toContain('drag **Docker** to the **Applications** folder');
    expect(read('installLinux')).toContain('sudo usermod -aG docker $USER');
    expect(read('installLinux')).toContain('newgrp docker');
    expect(read('startLinux')).toContain('sudo systemctl enable --now docker');
  });

  it('declares the buttons as commands, hidden in the Command Palette', () => {
    const commands = [Commands.dockerSetupInstall, Commands.dockerSetupStart, Commands.dockerSetupInstallWsl];
    for (const command of commands) {
      expect(manifest.contributes.commands.find((entry) => entry.command === command)?.category).toBe('Dev Environments');
      expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: 'false' });
    }
  });
});
