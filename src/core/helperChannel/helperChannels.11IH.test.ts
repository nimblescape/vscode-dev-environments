// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR H, a follow-up of plan step 11I (decision of 2026-10-09, docs/plan-remote-worker.md section 2): the flow of an
// operation `open` carries the helper image maintenance (`helperMaintenance`) to the preparation of a worker that is not
// open yet (HelperChannelsOptions.prepare), never to the worker itself; a worker that is open is used as it is.
import { describe, expect, it, vi } from 'vitest';
import { dockerTargetOf, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import type { HelperMaintenance } from '../helper/helperImages';
import { silentLogger } from '../ports';
import type { HelperChannel } from './helperChannel';
import { HelperChannels } from './helperChannels';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
const MAINTENANCE: HelperMaintenance = { checkBaseImage: true, onBuild: () => {}, onBuildEnd: () => {} };

/** An open channel whose flows answer at once. */
function openChannel() {
  const channel = {
    isOpen: true,
    busy: 0,
    lastUsed: Date.now(),
    onClose: () => () => {},
    close: () => {
      channel.isOpen = false;
    },
    closeNow: () => channel.close(),
    flow: vi.fn(async (_op: string, _params: unknown, _options?: unknown): Promise<unknown> => ({ ok: true })),
  };
  return channel;
}

describe('HelperChannels and the helper image maintenance of an open (PR H)', () => {
  it('passes it to the preparation of a worker that is not open, never to the worker; an open worker is used as it is', async () => {
    const channel = openChannel();
    const prepare = vi.fn(async (_target: DockerTarget, _signal: AbortSignal | undefined, _maintenance?: HelperMaintenance) => {});
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, prepare, logger: silentLogger });
    const signal = new AbortController().signal;
    expect(await channels.flow(REMOTE, 'open', { repository: 'acme/api' }, { signal, timeoutMs: 1000, helperMaintenance: MAINTENANCE })).toEqual({ ok: true });
    expect(prepare.mock.calls).toEqual([[REMOTE, signal, MAINTENANCE]]);
    expect(channel.flow).toHaveBeenCalledWith('open', { repository: 'acme/api' }, { signal, timeoutMs: 1000 });
    // The worker is open now: the next open is not prepared again (no maintenance under a running worker).
    await channels.flow(REMOTE, 'open', {}, { helperMaintenance: MAINTENANCE });
    expect(prepare).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  // Review round 1 of PR H (A-L1): reviewer A's probe, inverted.
  it('an open whose worker another call is opening gets the preparation without the maintenance, and joins that worker', async () => {
    const worker = openChannel();
    let opened: (channel: HelperChannel) => void = () => {};
    const open = vi.fn(() => new Promise<HelperChannel>((resolve) => (opened = resolve)));
    const prepare = vi.fn(async (_target: DockerTarget, _signal: AbortSignal | undefined, maintenance?: HelperMaintenance) => {
      // The maintaining ensure of an open would report its rebuild here; the others find the tag present.
      maintenance?.onBuild?.('refresh');
      maintenance?.onBuildEnd?.();
    });
    const channels = new HelperChannels({ open, prepare, logger: silentLogger });
    // Another call (a Stop; a heartbeat or the passive refresh likewise) prepares at once and starts the worker.
    const stop = channels.flow(REMOTE, 'stop', {});
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    // The open arrives while that worker is being opened: no maintenance, as it joins the worker that is being opened.
    const events: string[] = [];
    const maintenance: HelperMaintenance = { checkBaseImage: true, onBuild: (kind) => events.push(`build ${kind}`), onBuildEnd: () => events.push('end') };
    const openFlow = channels.flow(REMOTE, 'open', { repository: 'acme/api' }, { helperMaintenance: maintenance });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    opened(worker as unknown as HelperChannel);
    expect(await stop).toEqual({ ok: true });
    expect(await openFlow).toEqual({ ok: true });
    expect(events).toEqual([]);
    expect(prepare.mock.calls).toEqual([
      [REMOTE, undefined],
      [REMOTE, undefined],
    ]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(worker.flow.mock.calls.map((call) => call[0])).toEqual(['stop', 'open']);
    channels.dispose();
  });

  it('a flow without it prepares the worker without a maintenance, and a passive read never gets one', async () => {
    const prepare = vi.fn(async (_target: DockerTarget, _signal: AbortSignal | undefined, _maintenance?: HelperMaintenance) => {});
    const checkPresent = vi.fn(async (_target: DockerTarget, _signal: AbortSignal | undefined, _maintenance?: HelperMaintenance) => {});
    const first = new HelperChannels({ open: async () => openChannel() as unknown as HelperChannel, prepare, checkPresent, logger: silentLogger });
    await first.flow(REMOTE, 'stop', {});
    expect(prepare.mock.calls).toEqual([[REMOTE, undefined]]);
    first.dispose();
    const second = new HelperChannels({ open: async () => openChannel() as unknown as HelperChannel, prepare, checkPresent, logger: silentLogger });
    await second.flow(REMOTE, 'windowState', {}, { passive: true, helperMaintenance: MAINTENANCE });
    expect(checkPresent.mock.calls).toEqual([[REMOTE, undefined]]);
    expect(prepare).toHaveBeenCalledTimes(1);
    second.dispose();
  });
});
