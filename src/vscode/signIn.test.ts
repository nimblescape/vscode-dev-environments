// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The sign-in with a token that GitHub rejects (HTTP 401): VS Code keeps the session, so `createIfNone` returns it again
// without a dialog. The real VsCodeGitHubAuth, Sidebar, and the command Sign in with GitHub of the Controller, wired as
// extension.ts wires them; VS Code, the discovery, and the tree are fakes.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { GitHubApiError } from '../core/discovery/githubApi';
import { EnvironmentClaims } from '../core/ownership';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { DiscoveryData, ExtensionSettings } from '../core/types';
import { SIGNED_IN_CONTEXT_KEY, VsCodeGitHubAuth } from './auth';
import { Controller, type ControllerDeps } from './controller';
import { Sidebar, type SidebarDeps } from './sidebar';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { TreeTexts } from './treeModel';

const SETTINGS: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  waitingTimeSeconds: 30,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: true,
  refreshIntervalMinutes: 60,
};

const ACCOUNT = { id: '1001', label: 'octo' };
const REJECTED = { id: 'session-1', accessToken: 'gho_rejected', account: ACCOUNT, scopes: ['repo', 'read:org'] };
const RENEWED = { id: 'session-2', accessToken: 'gho_renewed', account: ACCOUNT, scopes: ['repo', 'read:org'] };

function data(): DiscoveryData {
  return { version: 1, fetchedAt: new Date(0).toISOString(), viewerLogin: 'octo', organizations: [], repositories: [], hints: [] };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

describe('Sign in with GitHub replaces a token that GitHub rejected', () => {
  let root: string;
  let auth: VsCodeGitHubAuth;
  let sidebar: Sidebar;
  let controller: Controller;
  let current: typeof REJECTED | undefined;
  const refresh = vi.fn();
  const disposables: Array<{ dispose(): void }> = [];

  /** The last value of the context key devEnvironments.signedIn. */
  function signedInKey(): unknown {
    const calls = fakeVscode.commands.executeCommand.mock.calls.filter((call) => call[0] === 'setContext' && call[1] === SIGNED_IN_CONTEXT_KEY);
    return calls.length === 0 ? undefined : calls[calls.length - 1][2];
  }

  beforeEach(() => {
    resetFakeVscode();
    fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: () => Promise<unknown>) => task());
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-signin-'));
    current = REJECTED;
    // VS Code: `silent` and `createIfNone` return the stored session, also when GitHub rejects its token. Only
    // `forceNewSession` makes a new one.
    fakeVscode.authentication.getSession.mockImplementation(async (_provider: string, _scopes: string[], options: Record<string, unknown>) => {
      if (options.forceNewSession) current = RENEWED;
      return current;
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn(), show: vi.fn() };
    auth = new VsCodeGitHubAuth(logger);
    // The discovery reports a 401 like GitHubApi does (onUnauthorized) before it throws.
    refresh.mockReset();
    refresh.mockImplementation(async (token: string) => {
      if (token === REJECTED.accessToken) {
        auth.reportRejectedToken(token);
        throw new GitHubApiError('GitHub API request failed with HTTP status 401: Bad credentials.', 401);
      }
      auth.reportAcceptedToken(token);
      return data();
    });
    const paths = new StoragePaths(root);
    paths.ensureDirectoriesSync();
    const registry = new EnvironmentRegistry(paths);
    const discovery = { loadStored: vi.fn(async () => undefined), refresh, getRepository: vi.fn(async () => undefined) };
    sidebar = new Sidebar({
      logger,
      registry,
      sessionFiles: new SessionFiles(paths),
      coordinator: { environmentId: null, otherActiveWindows: async () => [] },
      service: { inspectStates: async () => undefined, currentBranch: async () => undefined },
      docker: { isInstalled: () => true, isRunning: async () => true },
      discovery,
      auth,
      claims: new EnvironmentClaims({ registry, getRepository: async () => undefined, logger }),
      tree: { setModel: () => {}, getModel: () => [] },
      settings: () => SETTINGS,
    } as unknown as SidebarDeps);
    controller = new Controller({ auth, sidebar, logger } as unknown as ControllerDeps);
    // As extension.ts wires them.
    disposables.push(
      auth.onDidChangeSession(() => void sidebar.onSessionChanged()),
      auth.onDidChangeSignInState(() => void sidebar.onSessionChanged({ again: false })),
    );
  });

  afterEach(() => {
    for (const disposable of disposables.splice(0)) disposable.dispose();
    sidebar.dispose();
    auth.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('401 → not signed in → the sign-in asks for a new session → the refresh runs with the new token', async () => {
    await sidebar.initialize();
    await settle(() => refresh.mock.calls.length === 1 && signedInKey() === false, 'the rejection');
    expect(sidebar.isSignedIn).toBe(false);
    expect(await auth.isSignedIn()).toBe(false);
    // No loop: the rejected token is not tried again by itself.
    for (let index = 0; index < 20; index++) await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Nor by a refresh of the view (the timer, Refresh with the session present, the focus): no request with it.
    await sidebar.refreshDiscovery({ again: true });
    await sidebar.onSessionChanged({ again: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sidebar.isSignedIn).toBe(false);

    await controller.signIn();
    expect(fakeVscode.authentication.getSession).toHaveBeenCalledWith('github', ['repo', 'read:org'], { forceNewSession: true });
    expect(fakeVscode.authentication.getSession).not.toHaveBeenCalledWith('github', ['repo', 'read:org'], { createIfNone: true });
    // VS Code announces the new session.
    fakeVscode.fireSessionChange('github');
    await settle(() => refresh.mock.calls.some((call) => call[0] === RENEWED.accessToken), 'the refresh with the new token');
    await settle(() => signedInKey() === true, 'the sign-in state');
    expect(sidebar.isSignedIn).toBe(true);
    expect(await auth.isSignedIn()).toBe(true);
  });

  it('keeps the button, the sign-in row, and the welcome text exactly as they are', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string }>; viewsWelcome: Array<{ contents: string; when: string }> };
    };
    expect(manifest.contributes.commands.find((command) => command.command === 'devEnvironments.signIn')?.title).toBe('Sign in with GitHub');
    expect(manifest.contributes.viewsWelcome.find((welcome) => welcome.when === '!devEnvironments.signedIn')?.contents).toBe(
      'Sign in with GitHub to see your repositories that have a Dev Container configuration.\n[Sign in with GitHub](command:devEnvironments.signIn)',
    );
    expect(TreeTexts.signIn).toBe('Sign in with GitHub');
    expect(TreeTexts.signInTooltip).toBe('Sign in with GitHub to see your repositories that have a Dev Container configuration.');
  });
});
