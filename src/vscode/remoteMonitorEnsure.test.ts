// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { DOCKER_SOCKET } from '../core/helper/workspaceHelper';
import { remoteMonitorEnsure } from './remoteMonitorEnsure';

type EnsureCall = [string, string, AbortSignal | undefined, string | undefined];

function fakeMonitor() {
  const calls: EnsureCall[] = [];
  return {
    calls,
    monitor: {
      ensure: async (helperTag: string, socketPath: string, signal?: AbortSignal, helperImage?: string) => {
        calls.push([helperTag, socketPath, signal, helperImage]);
        return { kind: 'running' } as never;
      },
    },
  };
}

describe('remoteMonitorEnsure (the remote Session Monitor of extension.ts, review round 2 of PR #64, B-M9)', () => {
  // user decision 2026-09-29: no previous helper image; the image ID is the one of the helper image of the open.
  it('passes the checked image ID of the helper image of the open on as the image of the monitor', async () => {
    const { calls, monitor } = fakeMonitor();
    const signal = new AbortController().signal;
    const image = `sha256:${'5'.repeat(64)}`;
    await remoteMonitorEnsure(monitor, async () => undefined)('build-box', 'devenv-helper:0123456789ab', signal, image);
    expect(calls).toEqual([['devenv-helper:0123456789ab', DOCKER_SOCKET, signal, image]]);
  });

  it('runs the tag when the image ID is unknown, with the rootless socket of the host', async () => {
    const { calls, monitor } = fakeMonitor();
    const hosts: string[] = [];
    const ensure = remoteMonitorEnsure(monitor, async (host) => {
      hosts.push(host);
      return '/run/user/1000/docker.sock';
    });
    await ensure('build-box', 'devenv-helper:abcdef012345', undefined, undefined);
    expect(hosts).toEqual(['build-box']);
    expect(calls).toEqual([['devenv-helper:abcdef012345', '/run/user/1000/docker.sock', undefined, undefined]]);
  });
});
