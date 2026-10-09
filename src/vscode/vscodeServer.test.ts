// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): the VS Code server of this window, from the
// product.json under vscode.env.appRoot (a fake file here), only for a build of the Microsoft update service.
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { MICROSOFT_UPDATE_URL, vscodeServerOf, windowVscodeServer } from './vscodeServer';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const PRODUCT = { nameShort: 'Code', quality: 'stable', commit: COMMIT, updateUrl: 'https://update.code.visualstudio.com', serverDataFolderName: '.vscode-server' };

describe('the VS Code server of the window (plan step 11H1)', () => {
  it('is the commit and the quality of a build of the Microsoft update service', () => {
    expect(MICROSOFT_UPDATE_URL).toBe('https://update.code.visualstudio.com');
    expect(vscodeServerOf(PRODUCT)).toEqual({ commit: COMMIT, quality: 'stable' });
    expect(vscodeServerOf({ ...PRODUCT, quality: 'insider' })).toEqual({ commit: COMMIT, quality: 'insider' });
  });

  it.each([
    ['another update service (VSCodium)', { ...PRODUCT, updateUrl: 'https://vscodium.now.sh' }],
    ['the update service with a trailing slash', { ...PRODUCT, updateUrl: 'https://update.code.visualstudio.com/' }],
    ['the update service over http', { ...PRODUCT, updateUrl: 'http://update.code.visualstudio.com' }],
    ['no update service (a build of the sources)', { ...PRODUCT, updateUrl: undefined }],
    ['another quality', { ...PRODUCT, quality: 'exploration' }],
    ['no quality', { ...PRODUCT, quality: undefined }],
    ['an upper-case commit', { ...PRODUCT, commit: COMMIT.toUpperCase() }],
    ['a short commit', { ...PRODUCT, commit: COMMIT.slice(0, 39) }],
    ['no commit', { ...PRODUCT, commit: undefined }],
    ['no object', 'stable'],
    ['null', null],
    ['a list', [PRODUCT]],
  ])('is none for %s', (_name, product) => {
    expect(vscodeServerOf(product)).toBeUndefined();
  });

  it('reads <appRoot>/product.json once', async () => {
    const reads: string[] = [];
    const errors: string[] = [];
    const server = windowVscodeServer(
      '/usr/share/code/resources/app',
      async (file) => {
        reads.push(file);
        return JSON.stringify(PRODUCT);
      },
      (message) => errors.push(message),
    );
    expect(await server()).toEqual({ commit: COMMIT, quality: 'stable' });
    expect(await server()).toEqual({ commit: COMMIT, quality: 'stable' });
    expect(reads).toEqual([path.join('/usr/share/code/resources/app', 'product.json')]);
    expect(errors).toEqual([]);
  });

  it('gives none, with one line, when the file cannot be read or parsed', async () => {
    for (const read of [async () => Promise.reject(new Error('ENOENT')), async () => '{ not json']) {
      const errors: string[] = [];
      const server = windowVscodeServer('/app', read, (message) => errors.push(message));
      expect(await server()).toBeUndefined();
      expect(await server()).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('without the shared VS Code server');
    }
  });
});
