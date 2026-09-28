// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { dockerTargetOf, LOCAL_DOCKER_TARGET } from '../core/docker/dockerHost';
import { silentLogger } from '../core/ports';
import { DockerHostIndicator, DockerHostTexts, REMOTE_DOCKER_HOST_CONTEXT_KEY } from './dockerHostIndicator';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

// User request 2026-09-28: "it shall be indicated that we are on a remote host in the sidebar".
describe('DockerHostIndicator', () => {
  beforeEach(() => resetFakeVscode());

  function setContextCalls(): unknown[][] {
    return fakeVscode.commands.executeCommand.mock.calls.filter((call: unknown[]) => call[0] === 'setContext');
  }

  it('shows the remote host next to the view name and sets the context key of the title-bar icon', () => {
    const view: { description?: string } = {};
    new DockerHostIndicator(view, silentLogger).update(dockerTargetOf('ssh://machines', 'devenv-remote-5709ff28'));
    expect(view.description).toBe(DockerHostTexts.remote('machines'));
    expect(view.description).toBe('Remote: machines');
    expect(setContextCalls()).toEqual([['setContext', REMOTE_DOCKER_HOST_CONTEXT_KEY, true]]);
  });

  it('shows nothing for the local Docker and for an endpoint that is not supported', () => {
    const view: { description?: string } = { description: 'Remote: machines' };
    const indicator = new DockerHostIndicator(view, silentLogger);
    indicator.update(LOCAL_DOCKER_TARGET);
    expect(view.description).toBeUndefined();
    indicator.update(dockerTargetOf('tcp://192.0.2.10:2376', 'other'));
    expect(view.description).toBeUndefined();
    expect(setContextCalls()).toEqual([['setContext', REMOTE_DOCKER_HOST_CONTEXT_KEY, false]]);
  });

  it('follows a switch, and sets the key only when something changed', () => {
    const view: { description?: string } = {};
    const indicator = new DockerHostIndicator(view, silentLogger);
    indicator.update(dockerTargetOf('ssh://machines', 'a'));
    indicator.update(dockerTargetOf('ssh://machines', 'a'));
    indicator.update(dockerTargetOf('ssh://htldvm', 'b'));
    indicator.update(LOCAL_DOCKER_TARGET);
    expect(view.description).toBeUndefined();
    expect(setContextCalls().map((call) => call[2])).toEqual([true, true, false]);
  });
});
