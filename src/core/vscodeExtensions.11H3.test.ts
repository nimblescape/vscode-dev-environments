// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; live check 3 of the user): the pure rules of the shared extension cache: the
// list of an open (merged or own configuration, `-` entries, defaults, pins, bounds), the record, the union of 14 days,
// the cache name, the seed's choice of files, the cleanup's choice, the engine rules of VS Code, and the Marketplace
// query and its strict parse.
// Review round 1 of 11H3 (A-L6): the `.vsix` URLs of these tests are on a host of the Marketplace's CDN
// (`cdn.gallerycdn.vsassets.io`, was `cdn.example`), as a VSIX URL on any other host is now refused; nothing else changed.
import { describe, expect, it } from 'vitest';
import {
  MARKETPLACE_QUERY_URL,
  MAX_LISTED_EXTENSIONS,
  MAX_MARKETPLACE_ANSWER_BYTES,
  RECORDED_LIST_MS,
  chooseExtensionVersion,
  combinedExtensions,
  configurationExtensions,
  defaultExtensionsOf,
  extensionCacheName,
  extensionFilesToRemove,
  extensionRetryWaits,
  formatExtensionRecord,
  isEngineCompatible,
  marketplaceQueryBody,
  parseCachedExtension,
  parseExtensionEntry,
  parseExtensionFailures,
  parseExtensionList,
  parseExtensionRecord,
  parseMarketplaceAnswer,
  seedSelection,
  wantedExtensions,
  type MarketplaceVersion,
} from './vscodeExtensions';

describe('the extension list of an open (plan step 11H3)', () => {
  it('parses an entry strictly: publisher.name in lower case, an optional @x.y.z pin', () => {
    expect(parseExtensionEntry('RedHat.vscode-YAML')).toEqual({ id: 'redhat.vscode-yaml' });
    expect(parseExtensionEntry('ms-python.python@2024.2.1')).toEqual({ id: 'ms-python.python', version: '2024.2.1' });
    for (const junk of ['', 'noid', 'a.b.c', '-a.b', 'a.b@latest', 'a.b@1.2', 'a b.c', 'a/b.c', 'a.b@1.2.3-pre', `a.${'b'.repeat(300)}`, 42, null]) {
      expect(parseExtensionEntry(junk)).toBeUndefined();
    }
  });

  it('takes the merged configuration (a list of entries) when there is one, else the own; a `-` entry removes its ID', () => {
    const own = { customizations: { vscode: { extensions: ['own.ext'] } } };
    const merged = { customizations: { vscode: [{ extensions: ['feature.a', 'feature.b', 'bad id'] }, { extensions: ['-feature.b', 'repo.c@1.0.0', 'FEATURE.A'] }, { settings: {} }] } };
    expect(configurationExtensions(own, merged)).toEqual([{ id: 'feature.a' }, { id: 'repo.c', version: '1.0.0' }]);
    expect(configurationExtensions(own, undefined)).toEqual([{ id: 'own.ext' }]);
    expect(configurationExtensions(own)).toEqual([{ id: 'own.ext' }]);
    expect(configurationExtensions({ customizations: { vscode: { extensions: 'x.y' } } })).toEqual([]);
    expect(configurationExtensions(undefined)).toEqual([]);
  });

  it('is bounded: at most MAX_LISTED_EXTENSIONS entries', () => {
    const many = Array.from({ length: MAX_LISTED_EXTENSIONS + 5 }, (_, i) => `p.e${i}`);
    expect(configurationExtensions({ customizations: { vscode: { extensions: many } } })).toHaveLength(MAX_LISTED_EXTENSIONS);
    expect(defaultExtensionsOf(many)).toMatchObject({ dropped: 5 });
    expect(combinedExtensions(many.map((id) => ({ id })), [{ id: 'x.y' }])).toHaveLength(MAX_LISTED_EXTENSIONS);
  });

  it('defaults: the valid entries, each ID once, the others counted as dropped', () => {
    expect(defaultExtensionsOf(['A.b', 'a.b@1.0.0', 'bad', 7, 'c.d@2.0.0'])).toEqual({ list: [{ id: 'a.b' }, { id: 'c.d', version: '2.0.0' }], dropped: 3 });
    expect(defaultExtensionsOf(undefined)).toEqual({ list: [], dropped: 0 });
    expect(defaultExtensionsOf('a.b')).toEqual({ list: [], dropped: 1 });
  });

  it('the configuration comes first, then the defaults; an ID of both once', () => {
    expect(combinedExtensions([{ id: 'a.b', version: '1.0.0' }], [{ id: 'a.b' }, { id: 'c.d' }])).toEqual([{ id: 'a.b', version: '1.0.0' }, { id: 'c.d' }]);
  });

  it('a list of the protocol is strict: canonical text, no ID twice, bounded', () => {
    expect(parseExtensionList(['a.b', 'c.d@1.2.3'])).toEqual([{ id: 'a.b' }, { id: 'c.d', version: '1.2.3' }]);
    expect(parseExtensionList(['A.b'])).toBeUndefined();
    expect(parseExtensionList(['a.b', 'a.b@1.0.0'])).toBeUndefined();
    expect(parseExtensionList(['x'])).toBeUndefined();
    expect(parseExtensionList('a.b')).toBeUndefined();
    expect(parseExtensionList(Array.from({ length: MAX_LISTED_EXTENSIONS + 1 }, (_, i) => `p.e${i}`))).toBeUndefined();
  });
});

describe('the record of an open and the union of 14 days (plan step 11H3)', () => {
  it('round-trips, and refuses anything else', () => {
    const record = { at: 1000, configuration: [{ id: 'a.b', version: '1.0.0' }], defaults: [{ id: 'c.d' }] };
    expect(parseExtensionRecord(formatExtensionRecord(record))).toEqual(record);
    for (const junk of ['', '[]', '{"at":1,"configuration":[],"defaults":[],"x":1}', '{"at":-1,"configuration":[],"defaults":[]}', '{"at":1,"configuration":["A.b"],"defaults":[]}', `{"at":1,"configuration":[],"defaults":[],"pad":"${'x'.repeat(70_000)}"}`]) {
      expect(parseExtensionRecord(junk)).toBeUndefined();
    }
  });

  it('the union of the lists of the last 14 days, each entry once, a pin apart from its ID', () => {
    const now = 100 * RECORDED_LIST_MS;
    const records = [
      { at: now - 1000, configuration: [{ id: 'a.b' }], defaults: [{ id: 'c.d' }] },
      { at: now - RECORDED_LIST_MS + 1, configuration: [{ id: 'a.b', version: '1.0.0' }], defaults: [] },
      { at: now - RECORDED_LIST_MS, configuration: [{ id: 'old.one' }], defaults: [] },
      { at: now + 60_000, configuration: [{ id: 'future.one' }], defaults: [{ id: 'c.d' }] },
    ];
    expect(wantedExtensions(records, now)).toEqual([{ id: 'a.b' }, { id: 'a.b', version: '1.0.0' }, { id: 'c.d' }, { id: 'future.one' }]);
  });
});

describe('cache names and the files of the store (plan step 11H3)', () => {
  it('names a version as the server does: lower case, the target platform when it has one', () => {
    expect(extensionCacheName('editorconfig.editorconfig', '0.18.2')).toBe('editorconfig.editorconfig-0.18.2');
    expect(extensionCacheName('rust-lang.rust-analyzer', '0.3.2', 'linux-x64')).toBe('rust-lang.rust-analyzer-0.3.2-linux-x64');
    expect(parseCachedExtension('rust-lang.rust-analyzer-0.3.2-linux-x64', 'linux-x64')).toEqual({ id: 'rust-lang.rust-analyzer', version: '0.3.2' });
    expect(parseCachedExtension('rust-lang.rust-analyzer-0.3.2-linux-x64', 'universal')).toBeUndefined();
    expect(parseCachedExtension('redhat.vscode-yaml-1.24.0', 'linux-x64')).toBeUndefined();
    expect(parseCachedExtension('redhat.vscode-yaml-1.24.0', 'universal')).toEqual({ id: 'redhat.vscode-yaml', version: '1.24.0' });
    expect(parseCachedExtension('.hidden', 'universal')).toBeUndefined();
  });

  it('the seed takes the newest of each entry for the platform or universal, a pin as written, the platform at the same version', () => {
    const files = {
      universal: ['a.b-1.0.0', 'a.b-1.10.0', 'c.d-2.0.0', 'pin.ned-1.0.0', 'pin.ned-2.0.0'],
      'linux-x64': ['c.d-2.0.0-linux-x64', 'e.f-0.1.0-linux-x64'],
      'linux-arm64': ['e.f-0.2.0-linux-arm64'],
    };
    const wanted = [{ id: 'a.b' }, { id: 'c.d' }, { id: 'e.f' }, { id: 'pin.ned', version: '1.0.0' }, { id: 'none.here' }];
    expect(seedSelection(wanted, files, 'linux-x64')).toEqual(['universal/a.b-1.10.0', 'linux-x64/c.d-2.0.0-linux-x64', 'linux-x64/e.f-0.1.0-linux-x64', 'universal/pin.ned-1.0.0']);
    expect(seedSelection(wanted, files, 'linux-arm64')).toEqual(['universal/a.b-1.10.0', 'universal/c.d-2.0.0', 'linux-arm64/e.f-0.2.0-linux-arm64', 'universal/pin.ned-1.0.0']);
    // Without a known platform: universal only.
    expect(seedSelection(wanted, files, undefined)).toEqual(['universal/a.b-1.10.0', 'universal/c.d-2.0.0', 'universal/pin.ned-1.0.0']);
    expect(seedSelection(wanted, {}, 'linux-x64')).toEqual([]);
  });

  it('the cleanup removes what is not the newest of its ID and pinned by no list; unknown names stay', () => {
    const names = ['a.b-1.0.0', 'a.b-1.2.0', 'a.b-1.10.0', 'c.d-1.0.0', 'pin.ned-1.0.0', 'pin.ned-2.0.0', 'junk', 'x.y-1.0.0-linux-x64'];
    expect(extensionFilesToRemove('universal', names, new Set(['pin.ned@1.0.0']))).toEqual(['a.b-1.0.0', 'a.b-1.2.0']);
    expect(extensionFilesToRemove('universal', names, new Set())).toEqual(['a.b-1.0.0', 'a.b-1.2.0', 'pin.ned-1.0.0']);
  });
});

describe('the engine rules of VS Code (plan step 11H3; isEngineValid of VS Code)', () => {
  it.each([
    ['*', '1.105.0', true],
    ['^1.75.0', '1.105.0', true],
    ['^1.106.0', '1.105.0', false],
    ['^1.105.1', '1.105.0', false],
    ['^1.105.0', '1.105.3', true],
    ['^2.0.0', '1.105.0', false],
    ['>=1.105.0', '1.105.0', true],
    ['>=1.105.1', '1.105.0', false],
    ['>=1.90.0', '2.0.0', true],
    ['1.105.0', '1.105.0', true],
    ['1.104.0', '1.105.0', false],
    ['1.x.x', '1.105.0', true],
    ['1.105.x', '1.105.7', true],
    ['^0.10.0', '1.105.0', true],
    ['0.10.x', '1.105.0', true],
    ['0.10.0', '1.105.0', false],
    ['^1.105.0-20251001', '1.105.0', true],
    ['', '1.105.0', false],
    ['latest', '1.105.0', false],
    ['~1.105.0', '1.105.0', false],
  ])('engine %j on VS Code %s: %s', (engine, version, compatible) => {
    expect(isEngineCompatible(engine, version)).toBe(compatible);
  });
});

/** A version of an answer. */
function v(version: string, extra: Partial<MarketplaceVersion> & { pre?: boolean } = {}): MarketplaceVersion {
  const { pre, ...rest } = extra;
  return { version, preRelease: pre === true, engine: '^1.80.0', vsix: `https://cdn.gallerycdn.vsassets.io/${version}.vsix`, ...rest };
}

describe('the Marketplace (plan step 11H3)', () => {
  it('asks for all the IDs in one page, for VS Code, without unpublished ones; the newest versions only without pins', () => {
    expect(MARKETPLACE_QUERY_URL).toBe('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery');
    const body = JSON.parse(marketplaceQueryBody(['a.b', 'c.d'], true)) as { filters: Array<{ criteria: unknown[]; pageSize: number }>; flags: number };
    expect(body.filters[0].criteria).toEqual([
      { filterType: 7, value: 'a.b' },
      { filterType: 7, value: 'c.d' },
      { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
      { filterType: 12, value: '4096' },
    ]);
    expect(body.filters[0].pageSize).toBe(2);
    expect(body.flags).toBe(0x1 | 0x2 | 0x10 | 0x80 | 0x10000);
    expect((JSON.parse(marketplaceQueryBody(['a.b'], false)) as { flags: number }).flags).toBe(0x1 | 0x2 | 0x10 | 0x80);
  });

  it('parses an answer strictly; a version entry that does not fit is left out', () => {
    const answer = {
      results: [
        {
          extensions: [
            {
              publisher: { publisherName: 'RedHat' },
              extensionName: 'vscode-yaml',
              versions: [
                {
                  version: '1.25.0',
                  properties: [
                    { key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.80.0' },
                    { key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' },
                  ],
                  files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: 'https://cdn.gallerycdn.vsassets.io/yaml-1.25.0.vsix' }],
                },
                { version: '1.24.0', targetPlatform: 'linux-x64', properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.80.0' }], assetUri: 'https://cdn.gallerycdn.vsassets.io/yaml/1.24.0/' },
                { version: '1.23.0', files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: 'http://cdn.example/plain.vsix' }] },
                { version: 'latest' },
                { version: '1.22.0', properties: 'junk' },
                'junk',
              ],
            },
          ],
        },
      ],
    };
    expect(parseMarketplaceAnswer(JSON.stringify(answer))).toEqual(
      new Map([
        [
          'redhat.vscode-yaml',
          [
            { version: '1.25.0', preRelease: true, engine: '^1.80.0', vsix: 'https://cdn.gallerycdn.vsassets.io/yaml-1.25.0.vsix' },
            { version: '1.24.0', targetPlatform: 'linux-x64', preRelease: false, engine: '^1.80.0', vsix: 'https://cdn.gallerycdn.vsassets.io/yaml/1.24.0/Microsoft.VisualStudio.Services.VSIXPackage' },
            { version: '1.23.0', preRelease: false },
          ],
        ],
      ]),
    );
    for (const junk of ['', 'null', '{}', '{"results":{}}', '{"results":[{"extensions":[{"publisher":{},"extensionName":"x","versions":[]}]}]}', '{"results":[{"extensions":[{"publisher":{"publisherName":"a"},"extensionName":"b","versions":{}}]}]}']) {
      expect(parseMarketplaceAnswer(junk)).toBeUndefined();
    }
    expect(parseMarketplaceAnswer(`{"results":[],"pad":"${'x'.repeat(MAX_MARKETPLACE_ANSWER_BYTES)}"}`)).toBeUndefined();
  });

  it('chooses the newest release that the engine accepts, of the platform or universal; the platform at the same version', () => {
    const versions = [
      v('1.25.0', { pre: true }),
      v('1.24.1', { engine: '^1.106.0' }),
      v('1.24.0'),
      v('1.24.0', { targetPlatform: 'linux-x64', vsix: 'https://cdn.gallerycdn.vsassets.io/x64.vsix' }),
      v('1.30.0', { targetPlatform: 'darwin-arm64' }),
      v('1.29.0', { vsix: undefined }),
      v('1.28.0', { engine: undefined }),
      v('1.0.0'),
    ];
    expect(chooseExtensionVersion({ id: 'redhat.vscode-yaml' }, versions, '1.105.0', 'linux-x64')).toEqual({
      version: '1.24.0',
      targetPlatform: 'linux-x64',
      vsix: 'https://cdn.gallerycdn.vsassets.io/x64.vsix',
      folder: 'linux-x64',
      cacheName: 'redhat.vscode-yaml-1.24.0-linux-x64',
    });
    expect(chooseExtensionVersion({ id: 'redhat.vscode-yaml' }, versions, '1.105.0', 'linux-arm64')).toMatchObject({ version: '1.24.0', folder: 'universal', cacheName: 'redhat.vscode-yaml-1.24.0' });
    // A newer VS Code accepts 1.24.1.
    expect(chooseExtensionVersion({ id: 'redhat.vscode-yaml' }, versions, '1.106.0', 'linux-arm64')).toMatchObject({ version: '1.24.1' });
    // A pin as written: also a pre-release, whatever its engine.
    expect(chooseExtensionVersion({ id: 'redhat.vscode-yaml', version: '1.25.0' }, versions, '1.0.0', 'linux-x64')).toMatchObject({ version: '1.25.0', cacheName: 'redhat.vscode-yaml-1.25.0' });
    expect(chooseExtensionVersion({ id: 'redhat.vscode-yaml', version: '9.9.9' }, versions, '1.105.0', 'linux-x64')).toBeUndefined();
    expect(chooseExtensionVersion({ id: 'redhat.vscode-yaml' }, [v('2.0.0', { pre: true })], '1.105.0', 'linux-x64')).toBeUndefined();
  });

  it('keeps a failed entry for a day', () => {
    const failures = parseExtensionFailures('{"a.b":1000,"A.b":5,"c.d@1.0.0":7,"e.f":"x"}');
    expect([...failures]).toEqual([
      ['a.b', 1000],
      ['c.d@1.0.0', 7],
    ]);
    expect(parseExtensionFailures('junk').size).toBe(0);
    expect(extensionRetryWaits(1000, 1000 + 24 * 60 * 60_000 - 1)).toBe(true);
    expect(extensionRetryWaits(1000, 1000 + 24 * 60 * 60_000)).toBe(false);
    expect(extensionRetryWaits(undefined, 1000)).toBe(false);
  });
});
