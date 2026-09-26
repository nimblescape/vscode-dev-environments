// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAuthority } from './connection/authority';
import { CLOSE_REMOTE_COMMAND, ConnectionAdapter, OPEN_FOLDER_COMMAND, RELOAD_WINDOW_COMMAND } from './connectionAdapter';

interface FakeUri {
  scheme: string;
  authority: string;
  path: string;
  toString(): string;
}

// The part of the `vscode` API that the Connection Adapter uses.
const fake = vi.hoisted(() => {
  const state = {
    remoteName: undefined as string | undefined,
    workspaceFile: undefined as FakeUri | undefined,
    workspaceFolders: undefined as Array<{ uri: FakeUri }> | undefined,
    commands: [] as unknown[][],
  };
  const uri = (parts: { scheme: string; authority?: string; path?: string }): FakeUri => ({
    scheme: parts.scheme,
    authority: parts.authority ?? '',
    path: parts.path ?? '',
    toString: () => `${parts.scheme}://${parts.authority ?? ''}${parts.path ?? ''}`,
  });
  const vscode = {
    env: {
      get remoteName() {
        return state.remoteName;
      },
    },
    workspace: {
      get workspaceFile() {
        return state.workspaceFile;
      },
      get workspaceFolders() {
        return state.workspaceFolders;
      },
    },
    Uri: { from: uri },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        state.commands.push(args);
      },
    },
  };
  return { state, uri, vscode };
});

// Hoisted above the imports by vitest.
vi.mock('vscode', () => fake.vscode);

const NAME = 'devenv-acme-api-3f2a9c1e';

function remoteFolder(name: string, folder = '/workspaces/api'): { uri: FakeUri } {
  return { uri: fake.uri({ scheme: 'vscode-remote', authority: encodeAuthority(name), path: folder }) };
}

describe('ConnectionAdapter', () => {
  beforeEach(() => {
    fake.state.remoteName = undefined;
    fake.state.workspaceFile = undefined;
    fake.state.workspaceFolders = undefined;
    fake.state.commands = [];
  });

  it('opens the folder URI of the container in the current window, also when the user opens folders in new windows', async () => {
    await new ConnectionAdapter().open(NAME, '/workspaces/api');
    expect(fake.state.commands).toHaveLength(1);
    const [command, uri, options] = fake.state.commands[0] as [string, FakeUri, Record<string, unknown>];
    expect(command).toBe(OPEN_FOLDER_COMMAND);
    expect(uri).toMatchObject({ scheme: 'vscode-remote', authority: encodeAuthority(NAME), path: '/workspaces/api' });
    expect(options).toEqual({ forceNewWindow: false, forceReuseWindow: true });
  });

  it('reloads the window when it has this folder of this container open already (Reconnect)', async () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api/')];
    await new ConnectionAdapter().open(`/${NAME}`, '/workspaces/api');
    expect(fake.state.commands).toEqual([[RELOAD_WINDOW_COMMAND]]);
  });

  it('opens the folder when the window shows another container or another folder', async () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder('devenv-acme-web-7c1d2e3f', '/workspaces/api')];
    await new ConnectionAdapter().open(NAME, '/workspaces/api');
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/other')];
    await new ConnectionAdapter().open(NAME, '/workspaces/api');
    expect(fake.state.commands.map((call) => call[0])).toEqual([OPEN_FOLDER_COMMAND, OPEN_FOLDER_COMMAND]);
  });

  it('opens the folder URI of the container in a new window (Start in New Window, unit 14)', async () => {
    await new ConnectionAdapter().openInNewWindow(NAME, '/workspaces/api');
    expect(fake.state.commands).toHaveLength(1);
    const [command, uri, options] = fake.state.commands[0] as [string, FakeUri, Record<string, unknown>];
    expect(command).toBe(OPEN_FOLDER_COMMAND);
    expect(uri).toMatchObject({ scheme: 'vscode-remote', authority: encodeAuthority(NAME), path: '/workspaces/api' });
    expect(options).toEqual({ forceNewWindow: true });
  });

  it('never reloads this window for a new window, also when this window shows the same folder', async () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder(NAME, '/workspaces/api')];
    await new ConnectionAdapter().openInNewWindow(NAME, '/workspaces/api');
    expect(fake.state.commands.map((call) => call[0])).toEqual([OPEN_FOLDER_COMMAND]);
  });

  it('closes the remote connection with the command of VS Code', async () => {
    await new ConnectionAdapter().closeRemoteConnection();
    expect(fake.state.commands).toEqual([[CLOSE_REMOTE_COMMAND]]);
  });

  it('finds the container of an attached window from its first folder', () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(new ConnectionAdapter().currentContainerName()).toBe(NAME);
  });

  it('finds the container while remoteName is not set yet', () => {
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(new ConnectionAdapter().currentContainerName()).toBe(NAME);
  });

  it('prefers the workspace file of an attached window', () => {
    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFile = fake.uri({
      scheme: 'vscode-remote',
      authority: encodeAuthority('devenv-acme-web-7c1d2e3f'),
      path: '/workspaces/web/web.code-workspace',
    });
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(new ConnectionAdapter().currentContainerName()).toBe('devenv-acme-web-7c1d2e3f');
  });

  it('has no container in a local window, in a window of another remote type, and in an attached window without folder', () => {
    const adapter = new ConnectionAdapter();
    fake.state.workspaceFolders = [{ uri: fake.uri({ scheme: 'file', path: '/Users/me/project' }) }];
    expect(adapter.currentContainerName()).toBeUndefined();

    fake.state.remoteName = 'ssh-remote';
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(adapter.currentContainerName()).toBeUndefined();

    fake.state.remoteName = 'attached-container';
    fake.state.workspaceFolders = [];
    expect(adapter.currentContainerName()).toBeUndefined();
  });

  it('knows an empty window', () => {
    const adapter = new ConnectionAdapter();
    expect(adapter.isEmptyWindow()).toBe(true);
    fake.state.workspaceFolders = [];
    expect(adapter.isEmptyWindow()).toBe(true);
    fake.state.workspaceFolders = [remoteFolder(NAME)];
    expect(adapter.isEmptyWindow()).toBe(false);
    fake.state.workspaceFolders = undefined;
    fake.state.workspaceFile = fake.uri({ scheme: 'untitled', path: '/Untitled (Workspace)' });
    expect(adapter.isEmptyWindow()).toBe(false);
  });

  it('does not count a remote window without a folder as empty (concept 7.10 #2: an empty local window)', () => {
    const adapter = new ConnectionAdapter();
    for (const remoteName of ['ssh-remote', 'wsl', 'tunnel', 'attached-container']) {
      fake.state.remoteName = remoteName;
      fake.state.workspaceFolders = undefined;
      expect(adapter.isEmptyWindow()).toBe(false);
      fake.state.workspaceFolders = [];
      expect(adapter.isEmptyWindow()).toBe(false);
    }
    fake.state.remoteName = undefined;
    expect(adapter.isEmptyWindow()).toBe(true);
  });
});
