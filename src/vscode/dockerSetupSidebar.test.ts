// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker setup lives only in the sidebar (welcome view): no walkthrough, no command that opens it, and no message
// "Docker Desktop is not installed." at activation (user decision 2026-09-27).
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { DockerContextKeys } from '../core/docker/dockerSetup';
import { Messages } from '../core/messages';
import { Commands } from './commands';
import { Controller } from './controller';
import { DockerSetup, type DockerSetupDeps } from './dockerSetup';
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
  activationEvents?: string[];
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
  it('sets up the sidebar setup without any notification, also while the CLI is looked up again', () => {
    const docker = { isInstalled: vi.fn(() => false), lookUpCliNow: vi.fn(() => false) };
    const dockerSetup = new DockerSetup({
      docker,
      runner: { run: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false })) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() },
      showLog: vi.fn(),
      platform: 'darwin',
      env: {},
      onDidChangeInstalled: vi.fn(),
      remoteDockerHostConfigured: () => false,
    } as unknown as DockerSetupDeps);
    dockerSetup.initialize();
    vi.advanceTimersByTime(60_000);
    expect(dockerSetup.setupRequired).toBe(true);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', DockerContextKeys.setupRequired, true);
    expect(messageCalls()).toBe(0);
    dockerSetup.dispose();
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

  it('has no activation event of the removed command', () => {
    expect(manifest().activationEvents ?? []).not.toContain(`onCommand:${REMOVED_COMMAND}`);
  });
});

describe('the Docker setup in the sidebar welcome view', () => {
  it('no longer links the removed Setup Guide', () => {
    const welcome = manifest().contributes.viewsWelcome;
    for (const view of welcome) {
      expect(view.contents).not.toContain(REMOVED_COMMAND);
      expect(view.contents).not.toContain('Setup Guide');
    }
    const after = welcome.find((view) => view.contents.startsWith('After the installation'));
    expect(after).toEqual({
      view: 'devEnvironments.repositories',
      contents: 'After the installation, your repositories appear here. Dev Environments starts Docker when it is needed.',
      when: DockerContextKeys.setupRequired,
    });
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
      expect(view.contents).toContain(
        '[Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/)',
      );
    }
  });

  it('is the view that the action Install Docker… of the error shows', () => {
    const errors = fs.readFileSync(path.join(ROOT, 'src', 'vscode', 'errors.ts'), 'utf8');
    const views = manifest().contributes.views.devEnvironments.map((view) => view.id);
    expect(views).toContain('devEnvironments.repositories');
    expect(errors).toContain("const INSTALL_DOCKER_COMMAND = 'devEnvironments.repositories.focus';");
  });
});
