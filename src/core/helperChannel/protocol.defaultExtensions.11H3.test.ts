// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; live check 3 of the user): the user's default extensions that an open carries
// (OpenParams.defaultExtensions), checked strictly on both sides and only with a VS Code server of the open.
import { describe, expect, it } from 'vitest';
import { MAX_LISTED_EXTENSIONS } from '../vscodeExtensions';
import { parseOpenParams } from './protocol';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const IMAGES = { prefixes: [], schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };
const SETTINGS = { updateImagesOnConnect: true, hostAccessChecks: 'on', waitingTimeSeconds: 30, stopOnClose: true, respectShutdownActionNone: false };
const EXISTING = { dockerHost: '', owner: { windowId: 'window-1', pid: 7 }, monitorSource: SOURCE, settings: SETTINGS, images: IMAGES, repository: 'acme/app', environmentId: ID };
const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' };

describe('the default extensions of an open (plan step 11H3)', () => {
  it('are taken with a VS Code server', () => {
    const params = { ...EXISTING, vscodeServer: SERVER, defaultExtensions: ['redhat.vscode-yaml', 'ms-python.python@2024.2.1'] };
    expect(parseOpenParams(params)).toEqual(params);
  });

  it.each([
    ['without a VS Code server', { ...EXISTING, defaultExtensions: ['a.b'] }],
    ['an invalid ID', { ...EXISTING, vscodeServer: SERVER, defaultExtensions: ['not an id'] }],
    ['an ID not in lower case', { ...EXISTING, vscodeServer: SERVER, defaultExtensions: ['A.b'] }],
    ['an ID twice', { ...EXISTING, vscodeServer: SERVER, defaultExtensions: ['a.b', 'a.b@1.0.0'] }],
    ['too many', { ...EXISTING, vscodeServer: SERVER, defaultExtensions: Array.from({ length: MAX_LISTED_EXTENSIONS + 1 }, (_, i) => `p.e${i}`) }],
    ['no list', { ...EXISTING, vscodeServer: SERVER, defaultExtensions: 'a.b' }],
  ])('refuse %s', (_what, params) => {
    expect(parseOpenParams(params)).toBeUndefined();
  });
});
