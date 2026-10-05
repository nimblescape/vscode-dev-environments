// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E6: the strict checks of the operation `open` (OpenParams on both sides, OpenValue on the extension's).
import { describe, expect, it } from 'vitest';
import { MAX_REFUSAL_MESSAGE_LENGTH, parseOpenParams, parseOpenValue } from './protocol';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const IMAGES = { prefixes: ['ghcr.io/acme/base'], schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };
const SETTINGS = { updateImagesOnConnect: true, hostAccessChecks: 'on', waitingTimeSeconds: 30, stopOnClose: true, respectShutdownActionNone: false };
const BASE = { dockerHost: 'ssh://box', owner: { windowId: 'window-1', pid: 7 }, monitorSource: SOURCE, settings: SETTINGS, images: IMAGES, repository: 'acme/app' };
const EXISTING = { ...BASE, environmentId: ID };
const FIRST = { ...BASE, target: { defaultBranch: 'main', configPaths: ['.devcontainer/devcontainer.json'], trusted: false } };

describe('the parameters of the open (plan step 11E6)', () => {
  it('an existing environment, or the repository for the signed-in account; with the options of the open', () => {
    expect(parseOpenParams(EXISTING)).toEqual(EXISTING);
    expect(parseOpenParams(FIRST)).toEqual(FIRST);
    const full = { ...EXISTING, settings: { ...SETTINGS, stopAfterMinutes: 30 }, repositories: ['ghcr.io/acme/app'], forceRebuild: true, configPath: '.devcontainer/b/devcontainer.json' };
    expect(parseOpenParams(full)).toEqual(full);
    // An unknown default branch (null) and none at all.
    expect(parseOpenParams({ ...FIRST, target: { ...FIRST.target, defaultBranch: null } })?.target?.defaultBranch).toBeNull();
    expect(parseOpenParams({ ...FIRST, target: { configPaths: [], trusted: true } })?.target).toEqual({ configPaths: [], trusted: true });
  });

  it('review round 1 of PR #108 (A-L2): the computer and the settings are required', () => {
    for (const key of ['monitorSource', 'settings', 'images', 'repository', 'dockerHost', 'owner'] as const) {
      const { [key]: _left, ...rest } = EXISTING;
      expect(parseOpenParams(rest), key).toBeUndefined();
    }
    expect(parseOpenParams({ ...EXISTING, monitorSource: 'not-a-source' })).toBeUndefined();
  });

  it('refuses parameters that do not fit', () => {
    for (const odd of [
      undefined,
      null,
      [],
      { ...EXISTING, extra: 1 },
      // Both, or neither.
      { ...EXISTING, target: FIRST.target },
      BASE,
      { ...EXISTING, environmentId: '../x' },
      { ...EXISTING, repository: 'acme' },
      { ...EXISTING, repository: 'acme/app/x' },
      { ...EXISTING, repository: 'acme/a b' },
      { ...EXISTING, repository: `acme/${'x'.repeat(256)}` },
      { ...EXISTING, owner: { windowId: 'window-1', pid: 0 } },
      { ...EXISTING, dockerHost: 'ssh://box\n' },
      { ...EXISTING, settings: { ...SETTINGS, hostAccessChecks: 'maybe' } },
      { ...EXISTING, settings: { ...SETTINGS, waitingTimeSeconds: '30' } },
      { ...EXISTING, settings: { ...SETTINGS, waitingTimeSeconds: Number.NaN } },
      { ...EXISTING, settings: { ...SETTINGS, stopOnClose: 'yes' } },
      { ...EXISTING, settings: { ...SETTINGS, stopAfterMinutes: Infinity } },
      { ...EXISTING, settings: { ...SETTINGS, hostAccessChecksOff: ['acme/app'] } },
      { ...EXISTING, settings: { updateImagesOnConnect: true } },
      // The image settings and the list as the monitor reads them (from the checks of `monitorSettings`, removed).
      { ...EXISTING, images: { ...IMAGES, schedule: 'daily' } },
      { ...EXISTING, images: { ...IMAGES, timeZone: 'Mars/Base' } },
      { ...EXISTING, images: { ...IMAGES, prefixes: ['docker.io/library'] } },
      { ...EXISTING, repositories: ['not a repository'] },
      { ...EXISTING, repositories: Array.from({ length: 501 }, (_, i) => `ghcr.io/acme/app${i}`) },
      { ...EXISTING, forceRebuild: false },
      { ...EXISTING, configPath: '' },
      { ...EXISTING, configPath: 'a\u0000b' },
      { ...FIRST, target: { ...FIRST.target, trusted: 'yes' } },
      { ...FIRST, target: { ...FIRST.target, extra: 1 } },
      { ...FIRST, target: { ...FIRST.target, defaultBranch: '' } },
      { ...FIRST, target: { ...FIRST.target, defaultBranch: 'x'.repeat(256) } },
      { ...FIRST, target: { ...FIRST.target, configPaths: [''] } },
      { ...FIRST, target: { ...FIRST.target, configPaths: 'a' } },
      { ...FIRST, target: { ...FIRST.target, configPaths: Array.from({ length: 1001 }, () => 'a.json') } },
    ]) {
      expect(parseOpenParams(odd), JSON.stringify(odd)?.slice(0, 120)).toBeUndefined();
    }
  });

  it('duplicate repositories of the list once, as the monitor reads them', () => {
    expect(parseOpenParams({ ...EXISTING, repositories: ['ghcr.io/acme/app', 'ghcr.io/acme/app'] })?.repositories).toEqual(['ghcr.io/acme/app']);
  });
});

describe('the value of the open (plan step 11E6, decision A1)', () => {
  const OPENED = { environmentId: ID, containerName: 'devenv-acme-app-brave-noether', remoteWorkspaceFolder: '/workspaces/app' };

  it('what the window needs to connect, or the refusal; whether the image list was given', () => {
    expect(parseOpenValue({ opened: OPENED })).toEqual({ opened: OPENED });
    expect(parseOpenValue({ opened: OPENED, imageListSent: true })).toEqual({ opened: OPENED, imageListSent: true });
    const refused = { code: 'startFailed', message: 'No.' };
    expect(parseOpenValue({ refused })).toEqual({ refused });
    expect(parseOpenValue({ refused, imageListSent: true })).toEqual({ refused, imageListSent: true });
  });

  it('refuses a value that does not fit', () => {
    for (const odd of [
      null,
      {},
      { opened: OPENED, refused: { code: 'startFailed', message: 'No.' } },
      { opened: OPENED, imageListSent: false },
      { opened: OPENED, extra: 1 },
      { opened: { ...OPENED, user: 'root' } },
      { opened: { ...OPENED, environmentId: '../x' } },
      { opened: { ...OPENED, containerName: '-x' } },
      { opened: { ...OPENED, containerName: 'a b' } },
      { opened: { ...OPENED, remoteWorkspaceFolder: 'workspaces/app' } },
      { opened: { ...OPENED, remoteWorkspaceFolder: '' } },
      { opened: { ...OPENED, remoteWorkspaceFolder: '/workspaces/a\nb' } },
      { opened: { ...OPENED, remoteWorkspaceFolder: `/${'x'.repeat(4096)}` } },
      { refused: { code: 'startFailed', message: 'x'.repeat(MAX_REFUSAL_MESSAGE_LENGTH + 1) } },
      { refused: { code: 'not-a-code', message: 'No.' } },
    ]) {
      expect(parseOpenValue(odd), JSON.stringify(odd)?.slice(0, 120)).toBeUndefined();
    }
  });
});
