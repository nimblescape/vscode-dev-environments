// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2: the engine of the ensure of the Session Monitor over the port of the worker's engine (engineMonitor):
// how it reads the answers of the Engine API as the ensure needs them, as the extension read the Docker CLI before.
import { describe, expect, it, vi } from 'vitest';
import { LABEL_SESSION_MONITOR, REMOTE_MONITOR_SCRIPT_PATH } from '../remoteMonitor/protocol';
import { EngineError, type DockerEngine, type EngineExecResult } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { engineMonitor, limited, monitorInspected } from './engineMonitor';

const ID = 'feed'.padEnd(64, '1');
const INSPECT = {
  Id: ID,
  Created: '2026-10-04T12:00:00.5Z',
  RestartCount: 2,
  State: { Status: 'exited', ExitCode: 3 },
  Config: { Labels: { [LABEL_SESSION_MONITOR]: 'label-1', other: 'x' } },
};
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
const result = (exitCode: number | null, stdout = '', stderr = '', timedOut = false): EngineExecResult => ({ exitCode, stdout, stderr, timedOut });

function with_(methods: Partial<DockerEngine>) {
  return engineMonitor({ ...unusedEngine(), ...methods });
}

describe('the engine of the ensure of the Session Monitor over the Engine API (plan step 11D2)', () => {
  it('reads the inspect of the container: status, exit code, label, restarts, ID and creation time; missing when the engine has none', async () => {
    expect(monitorInspected(INSPECT)).toEqual({ exists: true, status: 'exited', exitCode: 3, label: 'label-1', restartCount: 2, id: ID, createdAt: Date.parse('2026-10-04T12:00:00.500Z') });
    expect(monitorInspected(undefined)).toEqual({ exists: false });
    // What cannot be read is left out, never guessed.
    expect(monitorInspected({ Id: 'short', RestartCount: -1, State: { Status: 3, ExitCode: 1.5 }, Config: {}, Created: 'yesterday' })).toEqual({
      exists: true,
      status: '',
      exitCode: undefined,
      label: '',
      restartCount: 0,
      id: undefined,
      createdAt: undefined,
    });
    const inspect = vi.fn(async () => INSPECT as unknown);
    expect(await with_({ inspect }).inspect('devenv-session-monitor')).toMatchObject({ exists: true, id: ID });
    expect(inspect).toHaveBeenCalledWith('container', 'devenv-session-monitor', expect.any(AbortSignal));
  });

  it('an inspect that fails rejects with its cause; one past its time limit with "no answer in time"; a cancel passes', async () => {
    await expect(with_({ inspect: async () => Promise.reject(new EngineError('permission denied', 403)) }).inspect('m')).rejects.toThrow('docker container inspect failed: permission denied');
    // The time limit of each call (here a short one): past it, "no answer in time"; the call gets the limit as its signal.
    const hanging = limited(50, undefined, (signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()))));
    await expect(hanging).rejects.toThrow('no answer in time');
    // The limit of the inspect is that of a Docker call (60 s): its signal aborts with it.
    let given: AbortSignal | undefined;
    await with_({
      inspect: async (_kind, _name, signal) => {
        given = signal;
        return INSPECT;
      },
    }).inspect('m');
    expect(given?.aborted).toBe(false);
    const controller = new AbortController();
    const cancelled = with_({ inspect: (_kind, _name, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(abortError()))) }).inspect('m', controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('the clock of the daemon, or why it cannot be read', async () => {
    expect(await with_({ systemTime: async () => '2026-10-04T12:00:00Z' }).daemonTime()).toBe(Date.parse('2026-10-04T12:00:00Z'));
    expect(await with_({ systemTime: async () => 'soon' }).daemonTime()).toEqual({ reason: 'the engine gave the time "soon"' });
    expect(await with_({ systemTime: async () => Promise.reject(new Error('connect ENOENT')) }).daemonTime()).toEqual({ reason: 'connect ENOENT' });
  });

  it('removes by the ID; a removal that another window runs is no failure, anything else is', async () => {
    const removeContainer = vi.fn(async () => {});
    await with_({ removeContainer }).remove(ID);
    expect(removeContainer).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
    await expect(with_({ removeContainer: async () => Promise.reject(new EngineError(`removal of container ${ID} is already in progress`, 409)) }).remove(ID)).resolves.toBeUndefined();
    await expect(with_({ removeContainer: async () => Promise.reject(new EngineError('device busy', 500)) }).remove(ID)).rejects.toThrow('docker rm failed: device busy');
    await expect(with_({ start: async () => Promise.reject(new EngineError('no such file', 500)) }).start(ID)).rejects.toThrow('docker start failed: no such file');
  });

  it('the stored script: its hash, definite evidence that there is none, or unknown', async () => {
    const exec = vi.fn(async () => result(0, `${'a'.repeat(64)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`));
    expect(await with_({ exec }).storedScript('devenv-session-monitor')).toEqual({ hash: `${'a'.repeat(64)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n` });
    expect(exec).toHaveBeenCalledWith('devenv-session-monitor', ['sha256sum', REMOTE_MONITOR_SCRIPT_PATH], { timeoutMs: 20_000 });
    const answers: [string, EngineExecResult | Error, unknown][] = [
      ['no stored file', result(1, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: No such file or directory\n`), 'none'],
      ['the runtime refuses an exec in a stopped container', result(126, 'OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown\r\n'), 'none'],
      ['the container does not exist', new EngineError('No such container: devenv-session-monitor', 404), 'none'],
      ['the container does not run', new EngineError(`Container ${ID} is not running`, 409), 'none'],
      ['the container restarts', new EngineError(`Container ${ID} is restarting, wait until the container is running`, 409), 'none'],
      ['the container is paused', new EngineError(`Container ${ID} is paused, unpause the container before exec`, 409), 'unknown'],
      ['it cannot be read', result(1, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: Permission denied\n`), 'unknown'],
      ['no answer in time', result(null, '', '', true), 'unknown'],
      ['a transport error', new Error('socket hang up'), 'unknown'],
    ];
    for (const [what, answer, expected] of answers) {
      const engine = with_({ exec: async () => (answer instanceof Error ? Promise.reject(answer) : answer) });
      expect(await engine.storedScript('devenv-session-monitor'), what).toEqual(expected);
    }
    const controller = new AbortController();
    controller.abort();
    await expect(with_({ exec: async () => Promise.reject(abortError()) }).storedScript('m', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('the IDs with a label, stopped ones included; undefined when the list fails', async () => {
    const containerIds = vi.fn(async () => [ID]);
    expect(await with_({ containerIds }).idsWithLabel('nimblescape.devenv.monitor-create=n1')).toEqual([ID]);
    expect(containerIds).toHaveBeenCalledWith({ label: ['nimblescape.devenv.monitor-create=n1'] }, expect.any(AbortSignal));
    expect(await with_({ containerIds: async () => Promise.reject(new Error('down')) }).idsWithLabel('x=y')).toBeUndefined();
  });

  it('the create is the attached create of the engine, within the time limit of a Docker call', async () => {
    const createAttached = vi.fn(async () => ({ kind: 'ready' as const }));
    const signal = new AbortController().signal;
    const spec = { name: 'm' } as never;
    expect(await with_({ createAttached }).create(spec, 'line\n', 'ready', signal)).toEqual({ kind: 'ready' });
    expect(createAttached).toHaveBeenCalledWith(spec, { input: 'line\n', readyText: 'ready', timeoutMs: 60_000, signal });
  });
});
