// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { dockerTargetOf, LOCAL_DOCKER_TARGET } from '../core/docker/dockerHost';
import { silentLogger } from '../core/ports';
import { DockerHostIndicator, DockerHostTexts } from './dockerHostIndicator';
import type { ShownDockerHost } from './treeView';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

// User request 2026-09-28: "it shall be indicated that we are on a remote host in the sidebar".
describe('DockerHostIndicator', () => {
  beforeEach(() => resetFakeVscode());

  it('shows the remote host next to the view name and in the title', () => {
    const view: { description?: string; title?: string } = {};
    new DockerHostIndicator(view, silentLogger).update(dockerTargetOf('ssh://machines', 'devenv-remote-5709ff28'));
    expect(view.description).toBe(DockerHostTexts.remote('machines'));
    expect(view.description).toBe('Remote: machines');
    // User screenshot 2026-09-28: the merged header of the single view shows the title, not the description.
    expect(view.title).toBe('machines (remote)');
  });

  // User request 2026-09-28 ("the headline shall be shown also in local mode"): the title names the local Docker too
  // (it was the view name "Dev Environments" there), and an endpoint that is not supported.
  it('names the local Docker and an endpoint that is not supported in the title', () => {
    const view: { description?: string; title?: string } = { description: 'Remote: machines', title: 'machines (remote)' };
    const indicator = new DockerHostIndicator(view, silentLogger);
    indicator.update(LOCAL_DOCKER_TARGET);
    expect(view.description).toBeUndefined();
    expect(view.title).toBe('Local Docker');
    indicator.update(dockerTargetOf('tcp://192.0.2.10:2376', 'other'));
    expect(view.description).toBeUndefined();
    expect(view.title).toBe('tcp://192.0.2.10:2376 (not supported)');
  });

  // User request 2026-09-28 ("the icon can then go away"): no context key of a title-bar icon is set anymore.
  it('sets no context key', () => {
    new DockerHostIndicator({}, silentLogger).update(dockerTargetOf('ssh://machines', 'a'));
    expect(fakeVscode.commands.executeCommand.mock.calls.filter((call: unknown[]) => call[0] === 'setContext')).toEqual([]);
  });

  // User report 2026-09-28: the first row of the list names the Docker host (the merged header did not show it); user
  // request 2026-09-28: also the local Docker.
  it('gives the list the Docker host for its first row, and only when it changed', () => {
    const rows: ShownDockerHost[] = [];
    const indicator = new DockerHostIndicator({}, silentLogger, (host) => rows.push(host));
    indicator.update(dockerTargetOf('ssh://htldvmhn', 'devenv-remote-2e9f507b'));
    indicator.update(dockerTargetOf('ssh://htldvmhn', 'devenv-remote-2e9f507b'));
    indicator.update(dockerTargetOf('ssh://machines', 'devenv-remote-5709ff28'));
    indicator.update(LOCAL_DOCKER_TARGET);
    indicator.update(LOCAL_DOCKER_TARGET);
    expect(rows).toEqual([
      { kind: 'remote', host: 'htldvmhn' },
      { kind: 'remote', host: 'machines' },
      { kind: 'local', host: '' },
    ]);
  });

  it('the view name of package.json stays "Dev Environments" (the title names the Docker host)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { views: { devEnvironments: Array<{ id: string; name: string }> } };
    };
    expect(manifest.contributes.views.devEnvironments[0].name).toBe('Dev Environments');
  });
});
