// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E6 (decision D1 of 2026-10-05): the image list that an open carries for the Session Monitor of its engine
// (imageLists): read in the background at most once an hour per engine, given with the next open until the monitor took it.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger } from '../core/ports';
import { MAX_IMAGE_REPOSITORIES } from '../core/remoteMonitor/protocol';
import { IMAGE_LIST_INTERVAL_MS, imageLists, type ImageListsDeps } from './imageLists';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides: Partial<ImageListsDeps> = {}) {
  let now = 1_000_000;
  const lines: string[] = [];
  const logger: Logger = { ...silentLogger, info: (text) => lines.push(`info ${text}`), warn: (text) => lines.push(`warn ${text}`) };
  const read = vi.fn(async (_token: string, _prefixes: string[]) => ['ghcr.io/acme/app']);
  const offerSignIn = vi.fn();
  const listFor = imageLists({
    prefixes: () => ['ghcr.io/acme/'],
    packagesToken: async () => 'gho_packages',
    read,
    offerSignIn,
    logger,
    now: () => now,
    ...overrides,
  });
  return { listFor, read, offerSignIn, lines, advance: (ms: number) => (now += ms) };
}

describe('the image list of an open (plan step 11E6, decision D1)', () => {
  it('the first open starts the read; the next open carries the list until the monitor took it', async () => {
    const { listFor, read } = setup();
    const first = listFor('ssh://box');
    expect(first.repositories).toBeUndefined();
    await settle();
    expect(read).toHaveBeenCalledWith('gho_packages', ['ghcr.io/acme/']);
    const second = listFor('ssh://box');
    expect(second.repositories).toEqual(['ghcr.io/acme/app']);
    // Not taken: it goes again.
    expect(listFor('ssh://box').repositories).toEqual(['ghcr.io/acme/app']);
    second.listSent();
    expect(listFor('ssh://box').repositories).toBeUndefined();
    // Within the hour, no other read.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads again after an hour, per engine', async () => {
    const { listFor, read, advance } = setup();
    listFor('ssh://box');
    listFor('');
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    listFor('ssh://box').listSent();
    advance(IMAGE_LIST_INTERVAL_MS - 1);
    listFor('ssh://box');
    expect(read).toHaveBeenCalledTimes(2);
    advance(1);
    listFor('ssh://box');
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    expect(listFor('ssh://box').repositories).toEqual(['ghcr.io/acme/app']);
  });

  it('a list taken while a newer read came in leaves the newer one to send', async () => {
    let answer = ['ghcr.io/acme/app'];
    const { listFor, advance } = setup({ read: async () => answer });
    listFor('ssh://box');
    await settle();
    const carried = listFor('ssh://box');
    advance(IMAGE_LIST_INTERVAL_MS);
    answer = ['ghcr.io/acme/app', 'ghcr.io/acme/db'];
    listFor('ssh://box');
    await settle();
    carried.listSent();
    expect(listFor('ssh://box').repositories).toEqual(['ghcr.io/acme/app', 'ghcr.io/acme/db']);
  });

  it('a failed read is logged and tried again at the next open', async () => {
    const read = vi.fn(async () => {
      throw new Error('GitHub answered 502');
    });
    const { listFor, lines } = setup({ read });
    listFor('ssh://box');
    await settle();
    expect(lines).toContain('warn The image repositories could not be read from GitHub: GitHub answered 502');
    listFor('ssh://box');
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('without the sign-in for packages: nothing is read, the sign-in is offered once per window', async () => {
    const { listFor, read, offerSignIn, lines } = setup({ packagesToken: async () => undefined });
    listFor('ssh://box');
    await settle();
    listFor('');
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(offerSignIn).toHaveBeenCalledTimes(1);
    expect(offerSignIn).toHaveBeenCalledWith('ssh://box');
    expect(lines).toContain('info The image list for the local Docker needs the GitHub sign-in for packages; the Session Monitor there updates only the images that it has.');
  });

  it('without a prefix on ghcr.io there is no list and no read', async () => {
    const { listFor, read } = setup({ prefixes: () => ['quay.io/acme/'] });
    const list = listFor('ssh://box');
    await settle();
    expect(list.repositories).toBeUndefined();
    expect(() => list.listSent()).not.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('a list beyond the limit of the monitor is cut and logged', async () => {
    const many = Array.from({ length: MAX_IMAGE_REPOSITORIES + 3 }, (_, i) => `ghcr.io/acme/app${i}`);
    const { listFor, lines } = setup({ read: async () => many });
    listFor('ssh://box');
    await settle();
    expect(listFor('ssh://box').repositories).toHaveLength(MAX_IMAGE_REPOSITORIES);
    expect(lines.some((line) => line.startsWith(`warn GitHub lists ${MAX_IMAGE_REPOSITORIES + 3} image repositories`))).toBe(true);
  });
});
