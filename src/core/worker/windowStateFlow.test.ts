// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C1: what an attached window reads of its dev container, as the worker reads it (windowStateFlow), and the
// checks of its parameters and value.
import { describe, expect, it } from 'vitest';
import { LABEL_CONTAINER_VERSION, LABEL_ENVIRONMENT_ID, LABEL_HOST_ACCESS, CONTAINER_VERSION, HOST_ACCESS_UNRESTRICTED } from '../names';
import { MAX_BRANCH_LENGTH, parseWindowStateParams, parseWindowStateValue } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import type { DockerEngine, EngineContainer } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker } from './engineDocker';
import { windowStateFlow } from './windowStateFlow';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devenv-acme-api-brave-noether';

function container(labels: Record<string, string>, state: 'running' | 'stopped' = 'running'): EngineContainer {
  return { id: 'a'.repeat(64), name: NAME, state, rawState: state === 'running' ? 'running' : 'exited', labels: { [LABEL_ENVIRONMENT_ID]: ID, ...labels }, image: 'img', created: '2026-10-03T10:00:00Z' };
}

function engine(found: EngineContainer | undefined, branch: { exitCode: number; stdout: string } = { exitCode: 0, stdout: 'main\n' }) {
  const execs: { container: string; command: readonly string[]; user?: string }[] = [];
  const port: DockerEngine = {
    ...unusedEngine(),
    container: async (reference) => (reference === NAME ? found : undefined),
    containers: async () => (found ? [found] : []),
    exec: async (name, command, options = {}) => (execs.push({ container: name, command, user: options.user }), { ...branch, stderr: '', timedOut: false }),
  };
  return { docker: new EngineDocker(port, silentLogger), execs };
}

const CURRENT = { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION) };

describe('the reads of an attached window in the worker (plan step 11C1)', () => {
  it('a running current container: its state, and the branch when asked, as the Git user in the folder', async () => {
    const { docker, execs } = engine(container(CURRENT));
    expect(await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', docker })).toEqual({ state: 'running' });
    expect(execs).toEqual([]);
    expect(await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', branch: { folder: '/workspaces/api', user: 'vscode' }, docker })).toEqual({ state: 'running', branch: 'main' });
    expect(execs[0]).toMatchObject({ container: NAME, user: 'vscode' });
    expect(execs[0].command).toContain('/workspaces/api');
  });

  it('a detached HEAD is null, a failed read leaves the branch out, a stopped container reads no branch', async () => {
    expect((await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', branch: { folder: '/workspaces/api' }, docker: engine(container(CURRENT), { exitCode: 0, stdout: '\n' }).docker })).branch).toBeNull();
    expect(await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', branch: { folder: '/workspaces/api' }, docker: engine(container(CURRENT), { exitCode: 128, stdout: '' }).docker })).toEqual({ state: 'running' });
    const stopped = engine(container(CURRENT, 'stopped'));
    expect(await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', branch: { folder: '/workspaces/api' }, docker: stopped.docker })).toEqual({ state: 'stopped' });
    expect(stopped.execs).toEqual([]);
    expect(await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', docker: engine(undefined).docker })).toEqual({ state: 'missing' });
  });

  it('a container of an older version is `version`; one of the checks-off time is `hostAccess` while the checks are on', async () => {
    expect((await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', docker: engine(container({ [LABEL_CONTAINER_VERSION]: '0' })).docker })).outdated).toBe('version');
    const unrestricted = container({ ...CURRENT, [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED });
    expect((await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', docker: engine(unrestricted).docker })).outdated).toBe('hostAccess');
    expect((await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'off', docker: engine(unrestricted).docker })).outdated).toBeUndefined();
  });

  it('the checks of its parameters and of its value', () => {
    const params = { environmentId: ID, containerName: NAME, checks: 'on', branch: { folder: '/workspaces/api', user: 'vscode' } };
    expect(parseWindowStateParams(params)).toEqual(params);
    for (const odd of [
      { ...params, checks: 'maybe' },
      { ...params, containerName: '-e' },
      { ...params, environmentId: '../x' },
      { ...params, branch: { folder: '/etc' } },
      { ...params, branch: { folder: '/workspaces/api', user: '-u root' } },
      { ...params, extra: 1 },
    ]) {
      expect(parseWindowStateParams(odd), JSON.stringify(odd)).toBeUndefined();
    }
    expect(parseWindowStateValue({ state: 'running', outdated: 'version', branch: null })).toEqual({ state: 'running', outdated: 'version', branch: null });
    for (const odd of [
      { state: 'paused' },
      { state: 'running', outdated: 'old' },
      { state: 'running', branch: '' },
      { state: 'running', branch: 'a\nb' },
      { state: 'running', branch: 'b'.repeat(MAX_BRANCH_LENGTH + 1) },
      { state: 'running', extra: 1 },
    ]) {
      expect(parseWindowStateValue(odd), JSON.stringify(odd)).toBeUndefined();
    }
    expect(parseWindowStateValue({ state: 'running', branch: 'b'.repeat(MAX_BRANCH_LENGTH) })).toBeDefined();
  });
});
