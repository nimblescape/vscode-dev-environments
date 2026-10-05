// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review 11F2 R2 (mutation testing): the check of the attach (readyForWindow) lets the window connect only to a container
// that the worker read as running. An unknown state (windowStateInWorker answers undefined) and a missing Docker CLI are
// refusals after the last check, never a connect; without the CLI the worker is not asked at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { UserFacingError } from '../core/errors';
import type { WindowStateValue } from '../core/helperChannel/protocol';
import { Messages } from '../core/messages';
import type { Environment } from '../core/types';
import { Controller, type ControllerDeps } from './controller';
import { resetFakeVscode } from './testing/fakeVscode';

const CONTAINER = 'devenv-acme-api-3f2a9c1e';

function environment(): Environment {
  return {
    id: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d',
    repository: 'acme/api',
    configPath: '.devcontainer/devcontainer.json',
    volumeName: CONTAINER,
    containerName: CONTAINER,
    createdAt: new Date(0).toISOString(),
    lastUsedAt: new Date(0).toISOString(),
    remoteWorkspaceFolder: '/workspaces/api',
  } as Environment;
}

interface Probe {
  controller: Controller;
  isInstalled: ReturnType<typeof vi.fn<() => boolean>>;
  windowStateInWorker: ReturnType<typeof vi.fn<(environment: Environment, containerName: string, options?: { branch?: boolean; signal?: AbortSignal }) => Promise<WindowStateValue | undefined>>>;
  warnings: string[];
}

function probe(): Probe {
  const warnings: string[] = [];
  const logger = { info: vi.fn(), warn: vi.fn((text: string) => void warnings.push(text)), error: vi.fn(), debug: vi.fn(), show: vi.fn() };
  const isInstalled = vi.fn(() => true);
  const windowStateInWorker = vi.fn(async (): Promise<WindowStateValue | undefined> => ({ state: 'running' }));
  const deps = {
    logger,
    docker: { isInstalled },
    service: { windowStateInWorker },
    sidebar: { repositoryInfo: () => undefined },
    timing: { readyPollMs: 0 },
  } as unknown as ControllerDeps;
  return { controller: new Controller(deps), isInstalled, windowStateInWorker, warnings };
}

/** The private check of the attach, called as the Start calls it after the pipeline. */
function readyForWindow(p: Probe, containerName = CONTAINER, signal = new AbortController().signal): Promise<UserFacingError | undefined> {
  const check = (p.controller as unknown as { readyForWindow(e: Environment, c: string, s: AbortSignal): Promise<UserFacingError | undefined> }).readyForWindow;
  return check.call(p.controller, environment(), containerName, signal);
}

beforeEach(() => resetFakeVscode());
afterEach(() => vi.restoreAllMocks());

describe('readyForWindow (review 11F2 R2)', () => {
  it('lets the window connect to a container the worker reads as running, read by the name of the result', async () => {
    const p = probe();
    expect(await readyForWindow(p, 'devenv-result-name')).toBeUndefined();
    expect(p.windowStateInWorker).toHaveBeenCalledTimes(1);
    // The name of the container of the open's result, without the branch. Review round 2 of PR #113 (A2-L1): with a
    // signal (bounded, ended by the cancel of the open), so not passive.
    expect(p.windowStateInWorker.mock.calls[0][1]).toBe('devenv-result-name');
    const options = p.windowStateInWorker.mock.calls[0][2];
    expect(Object.keys(options ?? {})).toEqual(['signal']);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses the connect when the worker cannot read the state (unknown is not running)', async () => {
    const p = probe();
    p.windowStateInWorker.mockResolvedValue(undefined);
    const refusal = await readyForWindow(p);
    expect(refusal).toBeInstanceOf(UserFacingError);
    expect(refusal?.message).toBe(Messages.containerNotReady('acme/api', CONTAINER));
    expect(p.windowStateInWorker).toHaveBeenCalledTimes(5);
    expect(p.warnings.some((text) => text.includes('(state: not readable)'))).toBe(true);
  });

  it('refuses the connect without asking the worker when Docker is not installed', async () => {
    const p = probe();
    p.isInstalled.mockReturnValue(false);
    const refusal = await readyForWindow(p);
    expect(refusal).toBeInstanceOf(UserFacingError);
    expect(p.windowStateInWorker).not.toHaveBeenCalled();
    expect(p.warnings.some((text) => text.includes('(state: Docker is not installed)'))).toBe(true);
  });

  it.each(['stopped', 'missing'] as const)('refuses the connect to a %s container after every check', async (state) => {
    const p = probe();
    p.windowStateInWorker.mockResolvedValue({ state });
    expect(await readyForWindow(p)).toBeInstanceOf(UserFacingError);
    expect(p.windowStateInWorker).toHaveBeenCalledTimes(5);
    expect(p.warnings.some((text) => text.includes(`(state: ${state})`))).toBe(true);
  });

  it('connects when the container runs at a later check', async () => {
    const p = probe();
    p.windowStateInWorker.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ state: 'stopped' });
    expect(await readyForWindow(p)).toBeUndefined();
    expect(p.windowStateInWorker).toHaveBeenCalledTimes(3);
  });

  it('reports no refusal when the user cancels during the last check (the caller reports the cancel)', async () => {
    const p = probe();
    const controller = new AbortController();
    p.windowStateInWorker.mockImplementation(async () => {
      if (p.windowStateInWorker.mock.calls.length === 5) controller.abort();
      return { state: 'stopped' };
    });
    expect(await readyForWindow(p, CONTAINER, controller.signal)).toBeUndefined();
    expect(p.windowStateInWorker).toHaveBeenCalledTimes(5);
    expect(p.warnings).toEqual([]);
  });
});
