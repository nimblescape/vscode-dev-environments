// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker setup lives only in the sidebar (welcome view): no walkthrough, no command that opens it, and no message
// "Docker Desktop is not installed." at activation (user decision 2026-09-27).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { fakeVscode } = await import('./testing/fakeVscode');
  return { ...fakeVscode, ExtensionMode: { Production: 1, Development: 2, Test: 3 } };
});
// No Docker CLI on this computer (activation test).
const foundDockerCli = vi.hoisted(() => vi.fn((): string | undefined => undefined));
vi.mock('../core/docker/dockerCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/docker/dockerCli')>();
  return { ...actual, findDockerCli: foundDockerCli };
});
// The activation test starts no Session Monitor process.
vi.mock('./sessionCoordinator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionCoordinator')>();
  class SessionCoordinatorWithoutMonitor extends actual.SessionCoordinator {
    constructor(deps: ConstructorParameters<typeof actual.SessionCoordinator>[0]) {
      super({ ...deps, spawnProcess: () => ({ unref() {}, on: () => undefined }) });
    }
  }
  return { ...actual, SessionCoordinator: SessionCoordinatorWithoutMonitor };
});

import { DockerContextKeys } from '../core/docker/dockerSetup';
import { Messages } from '../core/messages';
import { Commands } from './commands';
import { Controller } from './controller';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const ROOT = path.join(__dirname, '..', '..');
const REMOVED_COMMAND = 'devEnvironments.installDocker';

interface Manifest {
  contributes: {
    walkthroughs?: unknown;
    views: Record<string, Array<{ id: string }>>;
    viewsWelcome: Array<{ view: string; contents: string; when: string }>;
    commands: Array<{ command: string }>;
    menus: Record<string, Array<{ command?: string; submenu?: string }>>;
    keybindings?: Array<{ command: string }>;
  };
}

function manifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;
}

function sourceFiles(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

function messageCalls(): number {
  const { showInformationMessage, showWarningMessage, showErrorMessage } = fakeVscode.window;
  return showInformationMessage.mock.calls.length + showWarningMessage.mock.calls.length + showErrorMessage.mock.calls.length;
}

beforeEach(() => {
  resetFakeVscode();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('no message at activation when Docker is missing', () => {
  it('activates with the sidebar visible and no Docker CLI without any notification, also when the view is shown again', async () => {
    vi.useRealTimers();
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-activation-test-'));
    const visibility = new fakeVscode.EventEmitter<{ visible: boolean }>();
    const view = { visible: true, onDidChangeVisibility: visibility.event, dispose() {} };
    const window = fakeVscode.window as unknown as Record<string, unknown>;
    window.createTreeView = vi.fn(() => view);
    window.onDidChangeWindowState = vi.fn(() => ({ dispose() {} }));
    const workspace = fakeVscode.workspace as unknown as Record<string, unknown>;
    workspace.onDidChangeConfiguration = vi.fn(() => ({ dispose() {} }));
    workspace.workspaceFolders = undefined;
    workspace.workspaceFile = undefined;
    fakeVscode.workspace.getConfiguration.mockImplementation(() => ({
      get: () => undefined,
      inspect: () => undefined,
      update: async () => {},
    }));
    const context = {
      subscriptions: [] as Array<{ dispose(): unknown }>,
      globalStorageUri: { fsPath: storage },
      extensionUri: { fsPath: ROOT },
      extensionMode: 1,
      asAbsolutePath: (relative: string) => path.join(storage, 'extension', relative),
      // user decision 2026-09-29: no previous helper image. Changed input: the background prebuild of the helper image
      // reads the extension version and remembers it in globalState.
      extension: { packageJSON: { version: '0.1.0' } },
      globalState: { get: () => undefined, update: async () => undefined },
    };
    try {
      const { activate } = await import('./extension');
      await activate(context as never);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The view becomes visible again (for example after another view was shown).
      view.visible = false;
      visibility.fire({ visible: false });
      view.visible = true;
      visibility.fire({ visible: true });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(foundDockerCli).toHaveBeenCalled();
      // The sidebar shows the Docker setup (welcome view) instead of the repositories.
      expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', DockerContextKeys.setupRequired, true);
      expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(messageCalls()).toBe(0);
    } finally {
      for (const subscription of context.subscriptions) {
        try {
          subscription.dispose();
        } catch {
          // Only the cleanup of the test.
        }
      }
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('has no check of the view that shows "Docker Desktop is not installed." once', () => {
    expect('onViewVisible' in Controller.prototype).toBe(false);
    const extension = fs.readFileSync(path.join(ROOT, 'src', 'vscode', 'extension.ts'), 'utf8');
    expect(extension).not.toContain('onViewVisible');
  });

  it('uses "Docker Desktop is not installed." only as the error of an operation that needs Docker', () => {
    const uses: string[] = [];
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes('Messages.dockerNotInstalled')) uses.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/UserFacingError\('dockerNotInstalled', Messages\.dockerNotInstalled/);
    expect(Messages.dockerNotInstalled).toBe('Docker Desktop is not installed.');
  });
});

describe('package.json without the walkthrough', () => {
  it('has no walkthroughs and no walkthrough media', () => {
    expect(manifest().contributes.walkthroughs).toBeUndefined();
    expect(fs.existsSync(path.join(ROOT, 'resources', 'walkthrough'))).toBe(false);
  });

  it('declares only commands that the extension registers, and references only declared commands', () => {
    const contributes = manifest().contributes;
    const declared = contributes.commands.map((entry) => entry.command);
    const registered = new Set<string>(Object.values(Commands));
    for (const command of declared) expect(registered.has(command), command).toBe(true);
    expect(declared).not.toContain(REMOVED_COMMAND);
    expect(Object.values(Commands)).not.toContain(REMOVED_COMMAND);

    const referenced = [
      ...Object.values(contributes.menus).flatMap((entries) => entries.flatMap((entry) => (entry.command ? [entry.command] : []))),
      ...(contributes.keybindings ?? []).map((entry) => entry.command),
      ...contributes.viewsWelcome.flatMap((view) => [...view.contents.matchAll(/\(command:([\w.]+)\)/g)].map((match) => match[1])),
    ];
    expect(referenced.length).toBeGreaterThan(0);
    for (const command of referenced) expect(declared, command).toContain(command);
  });
});

describe('the Docker setup in the sidebar welcome view', () => {
  it('no longer links the removed Setup Guide', () => {
    const welcome = manifest().contributes.viewsWelcome;
    for (const view of welcome) {
      expect(view.contents).not.toContain(REMOVED_COMMAND);
      expect(view.contents).not.toContain('Setup Guide');
    }
    const after = welcome.filter((view) => view.contents.startsWith('Your repositories appear here once Docker is installed'));
    expect(after).toEqual([
      {
        view: 'devEnvironments.repositories',
        contents: 'Your repositories appear here once Docker is installed. Dev Environments starts Docker when needed.',
        when: `${DockerContextKeys.setupRequired} && !isLinux`,
      },
      {
        // Docker Engine on Linux needs administrator rights to start: the error offers Start Docker instead.
        view: 'devEnvironments.repositories',
        contents: 'Your repositories appear here once Docker is installed. Dev Environments asks to start Docker Engine when needed.',
        when: `${DockerContextKeys.setupRequired} && isLinux`,
      },
    ]);
  });

  it('keeps the buttons of the setup and the sign-in', () => {
    const links = manifest()
      .contributes.viewsWelcome.map((view) => view.contents)
      .join('\n');
    expect(links).toContain(`(command:${Commands.dockerSetupInstall})`);
    expect(links).toContain(`(command:${Commands.dockerSetupInstallWsl})`);
    expect(links).toContain(`(command:${Commands.signIn})`);
  });

  it('names the license of Docker Desktop in the steps that install it (moved from the walkthrough)', () => {
    const welcome = manifest().contributes.viewsWelcome;
    const desktopSteps = welcome.filter((view) => view.contents.includes('Install Docker Desktop'));
    expect(desktopSteps.map((view) => view.when)).toEqual([
      `${DockerContextKeys.setupRequired} && isMac`,
      `${DockerContextKeys.setupRequired} && isWindows`,
    ]);
    for (const view of desktopSteps) {
      // User decision 2026-09-27: shorter text; the license terms stay named and linked.
      expect(view.contents).toContain('free for personal use, education, non-commercial open source, and small businesses');
      expect(view.contents).toContain('(https://www.docker.com/legal/docker-subscription-service-agreement/)');
    }
  });
});
