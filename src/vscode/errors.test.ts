// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { CommandError, UserFacingError } from '../core/errors';
import { Actions, Messages } from '../core/messages';
import { abortError, type Logger } from '../core/ports';
import { RegistryVersionError } from '../core/storage/registry';
import { isCancellation, OPERATION_FAILED, showError } from './errors';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message, error) => lines.push(`error ${message}${error === undefined ? '' : ` | ${String(error)}`}`),
    output: () => {},
  };
  return { logger, lines };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('showError (concept 6.5)', () => {
  beforeEach(() => resetFakeVscode());

  const { window } = fakeVscode;

  function shown(): { severity: 'error' | 'warning'; message: string; actions: string[] } {
    const error = window.showErrorMessage.mock.calls[0];
    const warning = window.showWarningMessage.mock.calls[0];
    const call = error ?? warning;
    expect(call, 'a message is shown').toBeDefined();
    expect(window.showErrorMessage.mock.calls.length + window.showWarningMessage.mock.calls.length).toBe(1);
    const [message, ...actions] = call as [string, ...string[]];
    return { severity: error ? 'error' : 'warning', message, actions };
  }

  it('offers Install Docker… (the setup walkthrough) when Docker is not installed', async () => {
    const { logger } = recordingLogger();
    window.showErrorMessage.mockResolvedValue(Actions.installDocker);
    showError(new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled), { logger, showLog: vi.fn() });
    expect(shown()).toEqual({
      severity: 'error',
      message: 'Docker Desktop is not installed.',
      actions: ['Install Docker…'],
    });
    await flush();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('devEnvironments.installDocker');
    expect(fakeVscode.env.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['dockerStartFailed', Messages.dockerStartFailed],
    ['buildFailed', Messages.buildFailed],
    ['startFailed', 'The environment could not be started.'],
  ] as const)('offers Show details and Try again for %s', async (code, message) => {
    const { logger } = recordingLogger();
    const retry = vi.fn();
    const showLog = vi.fn();
    window.showErrorMessage.mockResolvedValue(Actions.tryAgain);
    showError(new UserFacingError(code, message, 'technical detail'), { logger, showLog, retry });
    expect(shown()).toEqual({ severity: 'error', message, actions: ['Show details', 'Try again'] });
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(showLog).not.toHaveBeenCalled();
  });

  it('offers only Show details when the caller cannot retry', async () => {
    const { logger } = recordingLogger();
    const showLog = vi.fn();
    window.showErrorMessage.mockResolvedValue(Actions.showDetails);
    showError(new UserFacingError('buildFailed', Messages.buildFailed), { logger, showLog });
    expect(shown().actions).toEqual(['Show details']);
    await flush();
    expect(showLog).toHaveBeenCalledTimes(1);
  });

  it('offers only Try again for a first open without internet access', () => {
    const { logger } = recordingLogger();
    showError(new UserFacingError('firstOpenOffline', Messages.firstOpenOffline), { logger, showLog: vi.fn(), retry: vi.fn() });
    expect(shown()).toEqual({
      severity: 'error',
      message: 'This repository cannot be opened without internet access.',
      actions: ['Try again'],
    });
  });

  it.each([
    ['composeNotSupported', Messages.composeNotSupported],
    ['noConfiguration', Messages.noConfiguration('acme/api')],
    ['gitSwitchFailed', Messages.gitSwitchFailed('dev', 'error: Your local changes would be overwritten.')],
  ] as const)('shows %s as a warning with Show details', (code, message) => {
    const { logger } = recordingLogger();
    showError(new UserFacingError(code, message), { logger, showLog: vi.fn(), retry: vi.fn() });
    expect(shown()).toEqual({ severity: 'warning', message, actions: ['Show details'] });
  });

  it('offers Sign in when a sign-in is required', async () => {
    const { logger } = recordingLogger();
    window.showWarningMessage.mockResolvedValue(Actions.signIn);
    showError(new UserFacingError('signInRequired', Messages.signInRequired), { logger, showLog: vi.fn() });
    expect(shown()).toEqual({ severity: 'warning', message: Messages.signInRequired, actions: ['Sign in'] });
    await flush();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('devEnvironments.signIn');
  });

  it('shows a refused configuration and an environment of another account as warnings (concept section 9)', () => {
    const { logger } = recordingLogger();
    const hostAccess = Messages.hostAccess('bind mount /Users/x, privileged mode');
    showError(new UserFacingError('hostAccess', hostAccess), { logger, showLog: vi.fn(), retry: vi.fn() });
    expect(shown()).toEqual({ severity: 'warning', message: hostAccess, actions: ['Show details'] });
    resetFakeVscode();
    showError(new UserFacingError('otherAccount', Messages.otherAccount('acme/api')), { logger, showLog: vi.fn(), retry: vi.fn() });
    expect(shown()).toEqual({ severity: 'warning', message: Messages.otherAccount('acme/api'), actions: [] });
  });

  it('shows an environment of an older version that is not assigned yet as a warning with Try again (concept 7.5)', () => {
    const { logger } = recordingLogger();
    const message = Messages.olderEnvironmentNotAssigned('acme/api');
    showError(new UserFacingError('environmentUnassigned', message), { logger, showLog: vi.fn(), retry: vi.fn() });
    expect(shown()).toEqual({ severity: 'warning', message, actions: ['Show details', 'Try again'] });
  });

  it('shows nothing for a cancellation, and logs it', () => {
    for (const error of [new UserFacingError('cancelled', 'The operation was cancelled.'), abortError()]) {
      resetFakeVscode();
      const { logger, lines } = recordingLogger();
      expect(isCancellation(error)).toBe(true);
      showError(error, { logger, showLog: vi.fn(), retry: vi.fn() });
      expect(window.showErrorMessage).not.toHaveBeenCalled();
      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(lines).toEqual(['info The operation was cancelled.']);
    }
  });

  it('shows a plain message for an unknown error and writes the technical error to the log only', () => {
    const { logger, lines } = recordingLogger();
    const error = new CommandError('docker run', 125, '', 'docker: Error response from daemon: conflict.');
    showError(error, { logger, showLog: vi.fn(), retry: vi.fn() });
    expect(shown()).toEqual({ severity: 'error', message: OPERATION_FAILED, actions: ['Show details'] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('conflict');
  });

  it('shows the message of a registry file of a newer version', () => {
    const { logger } = recordingLogger();
    const error = new RegistryVersionError(2);
    showError(error, { logger, showLog: vi.fn() });
    expect(shown()).toEqual({ severity: 'error', message: error.message, actions: ['Show details'] });
  });

  it('never offers more than one action besides Show details', () => {
    const codes = [
      'dockerNotInstalled',
      'dockerStartFailed',
      'dockerEngineNotRunning',
      'helperFailed',
      'cloneFailed',
      'firstOpenOffline',
      'composeNotSupported',
      'noConfiguration',
      'buildFailed',
      'startFailed',
      'filesMissing',
      'gitSwitchFailed',
      'signInRequired',
      'hostAccess',
      'unencryptedDockerConnection',
      'otherAccount',
      'environmentUnassigned',
    ] as const;
    for (const code of codes) {
      for (const retry of [undefined, vi.fn()]) {
        resetFakeVscode();
        showError(new UserFacingError(code, `message of ${code}`), { logger: recordingLogger().logger, showLog: vi.fn(), retry });
        const actions = shown().actions.filter((action) => action !== Actions.showDetails);
        expect(actions.length, code).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reports a failed retry in the log instead of losing it', async () => {
    const { logger, lines } = recordingLogger();
    window.showErrorMessage.mockResolvedValue(Actions.tryAgain);
    const retry = vi.fn(() => Promise.reject(new Error('retry failed')));
    showError(new UserFacingError('buildFailed', Messages.buildFailed), { logger, showLog: vi.fn(), retry });
    await flush();
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.startsWith('error') && line.includes('retry failed'))).toBe(true);
  });
});
