// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): the VS Code server that an open carries
// (OpenParams.vscodeServer), checked strictly on both sides: exactly a commit of 40 lower-case hexadecimal characters and
// a quality `stable` or `insider`; never a URL or another key.
import { describe, expect, it } from 'vitest';
import { parseOpenParams, parseOpenValue, parseVscodeServerLink, parseVscodeServerRef } from './protocol';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const IMAGES = { prefixes: [], schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };
const SETTINGS = { updateImagesOnConnect: true, hostAccessChecks: 'on', waitingTimeSeconds: 30, stopOnClose: true, respectShutdownActionNone: false };
const EXISTING = { dockerHost: '', owner: { windowId: 'window-1', pid: 7 }, monitorSource: SOURCE, settings: SETTINGS, images: IMAGES, repository: 'acme/app', environmentId: ID };
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('the VS Code server of an open (plan step 11H1)', () => {
  it('takes a commit and a quality, and an open without one as before', () => {
    expect(parseVscodeServerRef({ commit: COMMIT, quality: 'stable' })).toEqual({ commit: COMMIT, quality: 'stable' });
    expect(parseVscodeServerRef({ commit: COMMIT, quality: 'insider' })).toEqual({ commit: COMMIT, quality: 'insider' });
    expect(parseOpenParams({ ...EXISTING, vscodeServer: { commit: COMMIT, quality: 'stable' } })).toEqual({ ...EXISTING, vscodeServer: { commit: COMMIT, quality: 'stable' } });
    expect(parseOpenParams(EXISTING)).toEqual(EXISTING);
    expect(parseOpenParams(EXISTING)).not.toHaveProperty('vscodeServer');
  });

  it.each([
    ['a short commit', { commit: COMMIT.slice(1), quality: 'stable' }],
    ['a long commit', { commit: `${COMMIT}0`, quality: 'stable' }],
    ['an upper-case commit', { commit: COMMIT.toUpperCase(), quality: 'stable' }],
    ['a commit with a path', { commit: `../${COMMIT.slice(3)}`, quality: 'stable' }],
    ['a commit that is no text', { commit: 1, quality: 'stable' }],
    ['another quality', { commit: COMMIT, quality: 'exploration' }],
    ['no quality', { commit: COMMIT }],
    ['no commit', { quality: 'stable' }],
    ['a URL', { commit: COMMIT, quality: 'stable', url: 'https://example.com/server.tar.gz' }],
    ['an updateUrl', { commit: COMMIT, quality: 'stable', updateUrl: 'https://update.code.visualstudio.com' }],
    ['a text', `${COMMIT}/stable`],
    ['null', null],
    ['a list', [COMMIT, 'stable']],
  ])('refuses %s, and the open that carries it', (_name, value) => {
    expect(parseVscodeServerRef(value)).toBeUndefined();
    expect(parseOpenParams({ ...EXISTING, vscodeServer: value })).toBeUndefined();
  });
});

describe('what the link of the server did, in the value of an open (plan step 11H1)', () => {
  const OPENED = { environmentId: ID, containerName: 'acme-api-3f2a9c1e', remoteWorkspaceFolder: '/workspaces/api' };

  it('takes the four outcomes, and an open without one as before', () => {
    for (const outcome of ['linked', 'present', 'missing', 'skipped'] as const) {
      expect(parseVscodeServerLink({ outcome })).toEqual({ outcome });
      expect(parseOpenValue({ opened: OPENED, vscodeServer: { outcome } })).toEqual({ opened: OPENED, vscodeServer: { outcome } });
    }
    expect(parseOpenValue({ opened: OPENED })).toEqual({ opened: OPENED });
  });

  it.each([
    ['another outcome', { outcome: 'downloaded' }],
    ['another key', { outcome: 'linked', path: '/home/v/.vscode-server/bin/x' }],
    ['a platform (no longer a key)', { outcome: 'missing', platform: 'linux-x64' }],
    ['a text', 'linked'],
    ['null', null],
  ])('refuses %s, and the value that carries it', (_name, value) => {
    expect(parseVscodeServerLink(value)).toBeUndefined();
    expect(parseOpenValue({ opened: OPENED, vscodeServer: value })).toBeUndefined();
  });

  it('a refusal carries none', () => {
    expect(parseOpenValue({ refused: { code: 'cancelled', message: 'x' }, vscodeServer: { outcome: 'linked' } })).toBeUndefined();
  });
});
