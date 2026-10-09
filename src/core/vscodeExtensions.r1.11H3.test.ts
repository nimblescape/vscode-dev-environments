// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3: the pure rules of the shared extension cache. A-L3/B-D1 (reviewer A's probe P3, with the fixed
// behaviour): a pinned newer version never displaces the release that the monitor chose for the entry without a pin,
// neither in the cleanup nor in the seed. A-L4: the cleanup removes every file of an ID that no recent list names.
// A-L6: the hosts of a VSIX URL. B-D3: a record far in the future does not count.
import { describe, expect, it } from 'vitest';
import {
  RECORDED_LIST_MS,
  RECORD_AHEAD_MS,
  chooseExtensionVersion,
  extensionEntryText,
  extensionFilesToRemove,
  formatExtensionChoices,
  isMarketplaceDownloadUrl,
  parseExtensionChoices,
  parseMarketplaceAnswer,
  seedSelection,
  wantedExtensions,
} from './vscodeExtensions';

describe('a pin newer than the release (review round 1 of 11H3, A-L3/B-D1; reviewer A\'s probe P3)', () => {
  const now = 1_000_000_000_000;
  const records = [
    { at: now, configuration: [{ id: 'ms-python.python', version: '2025.3.0' }], defaults: [] }, // env A pins a pre-release
    { at: now, configuration: [{ id: 'ms-python.python' }], defaults: [] }, // env B wants the release
  ];
  const versions = [
    { version: '2025.3.0', preRelease: true, engine: '^1.90.0', vsix: 'https://ms-python.gallerycdn.vsassets.io/p' },
    { version: '2025.2.0', preRelease: false, engine: '^1.90.0', vsix: 'https://ms-python.gallerycdn.vsassets.io/r' },
  ];

  it('the cleanup keeps the release that the run chose and the pinned version', () => {
    const wanted = wantedExtensions(records, now);
    const unpinned = chooseExtensionVersion({ id: 'ms-python.python' }, versions, '1.95.0', 'linux-x64')!;
    const pinned = chooseExtensionVersion({ id: 'ms-python.python', version: '2025.3.0' }, versions, '1.95.0', 'linux-x64')!;
    expect([unpinned.cacheName, pinned.cacheName]).toEqual(['ms-python.python-2025.2.0', 'ms-python.python-2025.3.0']);
    const pins = new Set(wanted.filter((ref) => ref.version !== undefined).map(extensionEntryText));
    const named = new Set(wanted.map((ref) => ref.id));
    const chosen = new Set([`universal/${unpinned.cacheName}`, `universal/${pinned.cacheName}`]);
    expect(extensionFilesToRemove('universal', [unpinned.cacheName, pinned.cacheName], pins, { named, chosen })).toEqual([]);
    // An older file that no run chose and no list pins still goes.
    expect(extensionFilesToRemove('universal', ['ms-python.python-2025.1.0', unpinned.cacheName, pinned.cacheName], pins, { named, chosen })).toEqual(['ms-python.python-2025.1.0']);
  });

  it('the open of the entry without a pin seeds the chosen release, not the newer pinned file', () => {
    const files = { universal: ['ms-python.python-2025.2.0', 'ms-python.python-2025.3.0'] };
    const choices = new Map([
      ['ms-python.python', 'universal/ms-python.python-2025.2.0'],
      ['ms-python.python@2025.3.0', 'universal/ms-python.python-2025.3.0'],
    ]);
    expect(seedSelection([{ id: 'ms-python.python' }], files, 'linux-x64', choices)).toEqual(['universal/ms-python.python-2025.2.0']);
    // A pin is seeded as written, whatever the choices.
    expect(seedSelection([{ id: 'ms-python.python', version: '2025.3.0' }], files, 'linux-x64', choices)).toEqual(['universal/ms-python.python-2025.3.0']);
    // A chosen file that the store lacks, of another ID, or of a folder that this container cannot take: the newest file.
    for (const choice of ['universal/ms-python.python-2025.0.0', 'universal/other.ext-1.0.0', 'linux-arm64/ms-python.python-2025.2.0-linux-arm64']) {
      expect(seedSelection([{ id: 'ms-python.python' }], { ...files, 'linux-arm64': ['ms-python.python-2025.2.0-linux-arm64'] }, 'linux-x64', new Map([['ms-python.python', choice]]))).toEqual([
        'universal/ms-python.python-2025.3.0',
      ]);
    }
  });

  it('the chosen files are a strict record (entry, folder, a cache name of the entry\'s ID)', () => {
    const choices = new Map([['b.c', 'linux-x64/b.c-1.0.0-linux-x64'], ['a.b@1.0.0', 'universal/a.b-1.0.0']]);
    const text = formatExtensionChoices(choices);
    expect(text).toBe('{"a.b@1.0.0":"universal/a.b-1.0.0","b.c":"linux-x64/b.c-1.0.0-linux-x64"}\n');
    expect(parseExtensionChoices(text)).toEqual(choices);
    for (const junk of ['', 'null', '[]', '{"a.b":1}', '{"a.b":"universal/a.b-1.0.0-linux-x64"}', '{"a.b":"linux-x64/a.b-1.0.0"}', `{"a.b":"universal/a.b-1.0.0","x":"${'y'.repeat(300 * 1024)}"}`]) {
      expect(parseExtensionChoices(junk)).toEqual(new Map());
    }
  });
});

describe('the cleanup of IDs that no list names (review round 1 of 11H3, A-L4)', () => {
  it('with the named IDs, every file of another ID goes, the newest and a chosen one too', () => {
    const names = ['a.b-1.0.0', 'a.b-2.0.0', 'gone.ext-1.0.0', 'gone.ext-3.0.0', 'not a cache name'];
    expect(extensionFilesToRemove('universal', names, new Set(), { named: new Set(['a.b']), chosen: new Set(['universal/gone.ext-3.0.0']) })).toEqual(['a.b-1.0.0', 'gone.ext-1.0.0', 'gone.ext-3.0.0']);
    // Without them (as before): only the older versions.
    expect(extensionFilesToRemove('universal', names, new Set())).toEqual(['a.b-1.0.0', 'gone.ext-1.0.0']);
  });
});

describe('the hosts of a VSIX URL (review round 1 of 11H3, A-L6)', () => {
  it.each([
    ['https://marketplace.visualstudio.com/_apis/public/gallery/publishers/a/vsextensions/b/1.0.0/vspackage', true],
    ['https://ms-python.gallerycdn.vsassets.io/extensions/ms-python/python/1/x.vsix', true],
    ['https://a.b.gallery.vsassets.io/x', true],
    ['https://MS-Python.GalleryCDN.vsassets.io:443/x', true],
    ['http://ms-python.gallerycdn.vsassets.io/x', false],
    ['https://gallerycdn.vsassets.io/x', false],
    ['https://evil.example/x', false],
    ['https://ms-python.gallerycdn.vsassets.io.evil.example/x', false],
    ['https://evilgallerycdn.vsassets.io/x', false],
    ['https://marketplace.visualstudio.com.evil.example/x', false],
    ['https://user:pass@marketplace.visualstudio.com/x', false],
    ['https://marketplace.visualstudio.com:8443/x', false],
    ['not a url', false],
  ])('%s: %s', (url, allowed) => {
    expect(isMarketplaceDownloadUrl(url)).toBe(allowed);
  });

  it('the parse of an answer leaves out a VSIX URL off the Marketplace', () => {
    const version = (source: string) => ({ version: '1.0.0', properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.90.0' }], files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source }] });
    const answer = JSON.stringify({
      results: [{ extensions: [{ publisher: { publisherName: 'a' }, extensionName: 'b', versions: [version('https://evil.example/b.vsix'), version('https://a.gallerycdn.vsassets.io/b.vsix')] }] }],
    });
    expect(parseMarketplaceAnswer(answer)?.get('a.b')?.map((v) => v.vsix)).toEqual([undefined, 'https://a.gallerycdn.vsassets.io/b.vsix']);
  });
});

describe('a record in the future (review round 1 of 11H3, B-D3)', () => {
  it('up to a day ahead counts as now; further ahead it is left out', () => {
    const now = 100 * RECORDED_LIST_MS;
    const record = (at: number, id: string) => ({ at, configuration: [{ id }], defaults: [] });
    expect(wantedExtensions([record(now + RECORD_AHEAD_MS, 'near.future'), record(now + RECORD_AHEAD_MS + 1, 'far.future'), record(now, 'now.ext')], now)).toEqual([{ id: 'near.future' }, { id: 'now.ext' }]);
    expect(RECORD_AHEAD_MS).toBe(24 * 60 * 60_000);
  });
});
