// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #125 (reviewer B): probes of the mutants of the open of a channel after plan step 11I (PR D) sends
// the sweep without a check of the operations of the worker. The tests of the PR record the operation and the parameters
// of what the open sends, not its time limit, and never what an open that fails sends; each probe names its mutant.
import { describe, expect, it, vi } from 'vitest';
import { dockerTargetOf, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import { silentLogger, type StartedProcess } from '../ports';
import { HelperChannelError } from './helperChannel';
import { CHANNEL_PROBE_TIMEOUT_MS, openHelperChannel } from './helperChannels';
import { CHANNEL_PROTOCOL_VERSION, encodeMessage, parseClientMessage } from './protocol';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
/** The engine identity as the extension's Docker CLI prints it (ENGINE_IDENTITY_ARGS), and as the worker answers it. */
const ENGINE = '"7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11" "/var/lib/docker"';
const ENGINE_IDENTITY = { id: '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11', rootDir: '/var/lib/docker' };

/** A worker that answers hello, the probe with `engine`, and the sweep; records each operation with its time limit. */
function workerProcess(engine: unknown) {
  let stdout: ((text: string) => void) | undefined;
  const sent: Array<{ op: string; params: unknown; timeoutMs: number | undefined }> = [];
  const process: StartedProcess = {
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) {
        const message = parseClientMessage(line);
        if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['probe', 'sweep'] })));
        if (message?.t !== 'op') continue;
        sent.push({ op: message.op, params: message.params, timeoutMs: message.timeoutMs });
        const value = message.op === 'probe' ? { serverVersion: '27.1.0', detail: 'Docker 27.1.0', ...(engine === undefined ? {} : { engine }) } : { removed: 0 };
        queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value })));
      }
      return true;
    },
    end: () => {},
    kill: () => {},
    onStdout: (listener) => (stdout = listener),
    onStderr: () => {},
    exited: new Promise(() => {}),
  };
  return { process, sent };
}

function open(worker: ReturnType<typeof workerProcess>, directStdout = ENGINE) {
  return openHelperChannel(
    {
      start: () => worker.process,
      runDirect: async () => ({ exitCode: directStdout === '' ? 1 : 0, stdout: directStdout === '' ? '' : `${directStdout}\n`, stderr: '', timedOut: false }),
      logger: silentLogger,
      script: async () => 'S',
      helperTag: async () => 't',
      socketPath: async () => '/s',
      stateVolume: 'devenv-session-monitor',
      vscodeVolume: 'devenv-vscode',
    },
    REMOTE,
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('review round 1 of PR #125 (reviewer B): the probe and the sweep of the open of a channel', () => {
  // Mutant HC-sweep-notimeout: the sweep without its time limit (a worker that never answers it would keep the channel
  // busy, so it never closed after its time without use).
  it('sends the sweep with the time limit of the probe', async () => {
    // Plan step 11I (U9 PR; review round 1 of PR #128, B L1): the clock (Date only; the timers, the microtasks and the
    // streams stay real) is held still in this test, so the exact value below holds: HelperChannel.operation takes the
    // time that passed between the call and the write from the time limit (review round 6, R6-2), and under load a
    // millisecond could pass (the test failed about 2 of 25 runs, found in review round 1 of PR #127).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const worker = workerProcess(ENGINE_IDENTITY);
      const channel = await open(worker);
      await settle();
      expect(worker.sent).toEqual([
        { op: 'probe', params: {}, timeoutMs: CHANNEL_PROBE_TIMEOUT_MS },
        { op: 'sweep', params: {}, timeoutMs: CHANNEL_PROBE_TIMEOUT_MS },
      ]);
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutant HC-sweep-early: the sweep sent before the engine identity is compared. The sweep removes containers on the
  // engine of the worker; a worker that reaches another engine than the target's (or one that cannot be identified)
  // must never remove anything there.
  for (const [what, engine, directStdout] of [
    ['another engine', { id: 'other-id', rootDir: '/var/lib/docker' }, ENGINE],
    ['a worker that names no engine', undefined, ENGINE],
    ['an engine that cannot be identified without the worker', ENGINE_IDENTITY, ''],
  ] as const) {
    it(`sends no sweep to ${what}`, async () => {
      const worker = workerProcess(engine);
      await expect(open(worker, directStdout)).rejects.toBeInstanceOf(HelperChannelError);
      await settle();
      expect(worker.sent.map((entry) => entry.op)).toEqual(['probe']);
    });
  }
});
