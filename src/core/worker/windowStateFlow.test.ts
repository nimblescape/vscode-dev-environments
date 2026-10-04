// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C1: what an attached window reads of its dev container, as the worker reads it (windowStateFlow), and the
// checks of its parameters and value.
import { describe, expect, it } from 'vitest';
import { LABEL_COMPOSE_SERVICE, LABEL_CONTAINER_VERSION, LABEL_ENVIRONMENT_ID, LABEL_HOST_ACCESS, CONTAINER_VERSION, HOST_ACCESS_UNRESTRICTED } from '../names';
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
  const execs: { container: string; command: readonly string[]; user?: string; signal?: AbortSignal }[] = [];
  const port: DockerEngine = {
    ...unusedEngine(),
    container: async (reference) => (reference === NAME ? found : undefined),
    containers: async () => (found ? [found] : []),
    exec: async (name, command, options = {}) => (execs.push({ container: name, command, user: options.user, signal: options.signal }), { ...branch, stderr: '', timedOut: false }),
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
    // Review round 1 of 11C1 (B-R1-3, B-R1-12): a stopped or missing container is a state; odd keys of the branch and a
    // DEL in its name are refused.
    expect(parseWindowStateValue({ state: 'missing' })).toEqual({ state: 'missing' });
    expect(parseWindowStateValue({ state: 'stopped' })).toEqual({ state: 'stopped' });
    expect(parseWindowStateParams({ ...params, branch: { folder: '/workspaces/api', extra: 1 } })).toBeUndefined();
    expect(parseWindowStateValue({ state: 'running', branch: 'a\u007fb' })).toBeUndefined();
  });
});

// Review round 1 of plan step 11C1 (B-R1-4, B-R1-8, B-R1-9, B-R1-10).
describe('the reads of an attached window in the worker: review round 1 of 11C1', () => {
  it('rejects when the engine fails: never a state that it did not read', async () => {
    const port: DockerEngine = { ...unusedEngine(), container: async () => Promise.reject(new Error('socket closed')), containers: async () => [] };
    await expect(windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', docker: new EngineDocker(port, silentLogger) })).rejects.toThrow();
  });

  it('a container of an older version that was made while the checks were off is `version`', async () => {
    const old = container({ [LABEL_CONTAINER_VERSION]: '0', [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED });
    expect((await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', docker: engine(old).docker })).outdated).toBe('version');
  });

  it('the labels of the dev container decide, never those of a service of Docker Compose', async () => {
    const dev = container(CURRENT);
    const service: EngineContainer = { ...container({ [LABEL_CONTAINER_VERSION]: '0', [LABEL_COMPOSE_SERVICE]: 'db' }), id: 'b'.repeat(64), name: 'devenv-acme-api-db-1' };
    const port: DockerEngine = {
      ...unusedEngine(),
      container: async (reference) => [dev, service].find((each) => each.name === reference),
      containers: async () => [service, dev],
    };
    expect(await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', docker: new EngineDocker(port, silentLogger) })).toEqual({ state: 'running' });
  });

  // Review round 2 of 11C1 (B-R2 W15): the container of the window decides, not another dev container of the environment.
  it('the labels of the container of the window decide, also when another dev container of the environment runs', async () => {
    const own: EngineContainer = { ...container(CURRENT, 'stopped') };
    const other: EngineContainer = { ...container({ [LABEL_CONTAINER_VERSION]: '0' }), id: 'c'.repeat(64), name: 'devenv-acme-api-other' };
    const port: DockerEngine = {
      ...unusedEngine(),
      container: async (reference) => [own, other].find((each) => each.name === reference),
      containers: async () => [other, own],
    };
    expect(await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', docker: new EngineDocker(port, silentLogger) })).toEqual({ state: 'stopped' });
  });

  it('the signal of the read reaches the read of the branch', async () => {
    const { docker, execs } = engine(container(CURRENT));
    const signal = new AbortController().signal;
    await windowStateFlow({ environmentId: ID, containerName: NAME, checks: 'on', branch: { folder: '/workspaces/api' }, docker, signal });
    expect(execs[0].signal).toBe(signal);
  });
});
