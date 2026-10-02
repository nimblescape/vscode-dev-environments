// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { DOCKER_SOCKET } from '../core/helper/workspaceHelper';
import { sessionMonitorEnsure } from './sessionMonitorEnsure';

type EnsureCall = [string, string, AbortSignal | undefined, string | undefined];

function fakeMonitor(fail?: Error) {
  const calls: EnsureCall[] = [];
  return {
    calls,
    monitor: {
      ensureOrThrow: async (helperTag: string, socketPath: string, signal?: AbortSignal, helperImage?: string) => {
        calls.push([helperTag, socketPath, signal, helperImage]);
        if (fail) throw fail;
        return 'running' as const;
      },
    },
  };
}

const REMOTE = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' } as const;
const LOCAL = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' } as const;

describe('sessionMonitorEnsure (the Session Monitor of extension.ts, review round 2 of PR #64, B-M9)', () => {
  // user decision 2026-09-29: no previous helper image; the image ID is the one of the helper image of the open.
  it('passes the checked image ID of the helper image of the open on as the image of the monitor', async () => {
    const { calls, monitor } = fakeMonitor();
    const signal = new AbortController().signal;
    const image = `sha256:${'5'.repeat(64)}`;
    await sessionMonitorEnsure(monitor, async () => DOCKER_SOCKET)(REMOTE, 'devenv-helper:0123456789ab', signal, image);
    expect(calls).toEqual([['devenv-helper:0123456789ab', DOCKER_SOCKET, signal, image]]);
  });

  it('runs the tag when the image ID is unknown, with the socket of the engine of the target', async () => {
    const { calls, monitor } = fakeMonitor();
    const targets: string[] = [];
    // Changed fixture, plan step 8 PR A: the socket is asked for the target (before: the rootless socket of a host).
    const ensure = sessionMonitorEnsure(monitor, async (target) => {
      targets.push(`${target.kind} ${target.host}`);
      return '/run/user/1000/docker.sock';
    });
    await ensure(REMOTE, 'devenv-helper:abcdef012345', undefined, undefined);
    expect(targets).toEqual(['remote build-box']);
    expect(calls).toEqual([['devenv-helper:abcdef012345', '/run/user/1000/docker.sock', undefined, undefined]]);
  });

  // Plan step 8, PR A: the local Docker too.
  it('ensures the monitor on the local Docker with the socket of its endpoint', async () => {
    const { calls, monitor } = fakeMonitor();
    await sessionMonitorEnsure(monitor, async (target) => (target.kind === 'local' ? '/var/run/docker.sock' : 'unexpected'))(LOCAL, 'devenv-helper:abcdef012345', undefined, undefined);
    expect(calls).toEqual([['devenv-helper:abcdef012345', '/var/run/docker.sock', undefined, undefined]]);
  });

  // Plan step 8, PR A (user decision Q3 of 2026-10-02): a failure rejects with its cause, so the open is refused.
  it('rejects when the monitor cannot be ensured', async () => {
    const { monitor } = fakeMonitor(new Error('docker run failed: no space left on device'));
    await expect(sessionMonitorEnsure(monitor, async () => DOCKER_SOCKET)(LOCAL, 'devenv-helper:abcdef012345', undefined, undefined)).rejects.toThrow(
      'no space left on device',
    );
  });
});
