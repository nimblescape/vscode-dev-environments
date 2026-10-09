// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR H (reviewer B): the maintenance of an open in HelperChannels (ready, withChannel) beyond the
// tests of PR H, for the mutants that survived them:
// - B07 (ready opens the worker first and runs the maintaining preparation after it): the maintenance runs before the
//   worker of the open is opened.
// - B06 (ready ignores a failed maintaining preparation and opens the worker anyway): a helper image that cannot be
//   prepared refuses the open as before (HelperChannelError 'unavailable' with the cause, no worker opened), and a
//   cancel of the preparation stays a cancel.
// - B01 (withChannel prepares the new worker of its retry after a closed channel without the maintenance): the worker
//   that is set up for the open on that retry is prepared with the maintenance too.
import { describe, expect, it, vi } from 'vitest';
import { dockerTargetOf, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import { UserFacingError } from '../errors';
import type { HelperMaintenance } from '../helper/helperImages';
import { abortError, silentLogger } from '../ports';
import { HelperChannelError, type HelperChannel } from './helperChannel';
import { HelperChannels } from './helperChannels';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
const MAINTENANCE: HelperMaintenance = { checkBaseImage: true, onBuild: () => {}, onBuildEnd: () => {} };

/** A channel stand-in whose close tells its listeners (HelperChannels then forgets it), with flows that answer at once. */
function fakeChannel() {
  const listeners: ((reason: string) => void)[] = [];
  const channel = {
    isOpen: true,
    busy: 0,
    lastUsed: Date.now(),
    onClose: (listener: (reason: string) => void) => {
      listeners.push(listener);
      return () => {};
    },
    close: () => {
      channel.isOpen = false;
      for (const listener of listeners) listener('closed');
    },
    closeNow: () => channel.close(),
    flow: vi.fn(async (_op: string, _params: unknown, _options?: unknown): Promise<unknown> => ({ ok: true })),
  };
  return channel;
}

describe('HelperChannels and the maintenance of an open: before its worker, its failure, its retry (review round 1 of PR H, reviewer B)', () => {
  it('runs the maintaining preparation before the worker of the open is opened (B07)', async () => {
    const events: string[] = [];
    const channel = fakeChannel();
    const open = vi.fn(async () => {
      events.push('open');
      return channel as unknown as HelperChannel;
    });
    const prepare = vi.fn(async (_target: DockerTarget, _signal: AbortSignal | undefined, maintenance?: HelperMaintenance) => {
      events.push(maintenance === undefined ? 'prepare' : 'maintain');
    });
    const channels = new HelperChannels({ open, prepare, logger: silentLogger });
    expect(await channels.flow(REMOTE, 'open', { repository: 'acme/api' }, { helperMaintenance: MAINTENANCE })).toEqual({ ok: true });
    expect(events).toEqual(['maintain', 'open']);
    channels.dispose();
  });

  it('a maintaining preparation that fails refuses the open with its cause and opens no worker; a cancel stays a cancel (B06)', async () => {
    const open = vi.fn(async () => fakeChannel() as unknown as HelperChannel);
    const prepare = vi.fn(async (_target: DockerTarget, _signal: AbortSignal | undefined, _maintenance?: HelperMaintenance): Promise<void> => {
      throw new UserFacingError('helperFailed', 'The workspace helper could not be prepared.', 'no space left on device');
    });
    const channels = new HelperChannels({ open, prepare, logger: silentLogger });
    await expect(channels.flow(REMOTE, 'open', {}, { helperMaintenance: MAINTENANCE })).rejects.toMatchObject({
      name: 'HelperChannelError',
      code: 'unavailable',
      message: 'the helper image could not be prepared: The workspace helper could not be prepared. no space left on device',
    });
    prepare.mockImplementationOnce(async () => {
      throw abortError();
    });
    await expect(channels.flow(REMOTE, 'open', {}, { helperMaintenance: MAINTENANCE })).rejects.toMatchObject({ name: 'AbortError' });
    expect(prepare.mock.calls).toEqual([
      [REMOTE, undefined, MAINTENANCE],
      [REMOTE, undefined, MAINTENANCE],
    ]);
    expect(open).not.toHaveBeenCalled();
    channels.dispose();
  });

  it('prepares the new worker of the retry after a channel that closed before the open was sent with the maintenance (B01)', async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const prepare = vi.fn(async (_target: DockerTarget, _signal: AbortSignal | undefined, _maintenance?: HelperMaintenance) => {});
    const channels = new HelperChannels({ open, prepare, logger: silentLogger });
    // A worker is open on the engine (a Stop opened it): the open finds it and prepares nothing for it.
    expect(await channels.flow(REMOTE, 'stop', {})).toEqual({ ok: true });
    // Its channel closes before the open is sent (`closed`: the open did not run there): the open is sent once more
    // through a new worker, which is set up for the open, so with its maintenance.
    first.flow.mockImplementationOnce(async () => {
      first.close();
      throw new HelperChannelError('closed', 'closed');
    });
    expect(await channels.flow(REMOTE, 'open', { repository: 'acme/api' }, { helperMaintenance: MAINTENANCE })).toEqual({ ok: true });
    expect(prepare.mock.calls).toEqual([
      [REMOTE, undefined],
      [REMOTE, undefined, MAINTENANCE],
    ]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(second.flow).toHaveBeenCalledWith('open', { repository: 'acme/api' }, {});
    channels.dispose();
  });
});
