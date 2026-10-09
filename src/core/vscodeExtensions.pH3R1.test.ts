// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3 (reviewer B, mutation testing): probes of the pure rules of the shared extension cache that no
// test pinned: the bounds of the record, the union and the failures; the 14 days in absolute times; versions that differ
// only in their patch; the end of a cache name; the engine rules of VS Code that were left open; and the strict parse of
// a Marketplace answer (a bad extension fails the answer, the version cap, a property or a file of another shape, the
// pre-release mark, the VSIX file before the asset URI, the platform at the same version whatever the order).
// Review round 1 of 11H3 (A-L6): the `.vsix` URLs of these tests are on a host of the Marketplace's CDN
// (`cdn.gallerycdn.vsassets.io`, was `cdn.example`), as a VSIX URL on any other host is now refused; nothing else changed.
import { describe, expect, it } from 'vitest';
import {
  MAX_EXTENSION_RECORD_BYTES,
  MAX_WANTED_EXTENSIONS,
  chooseExtensionVersion,
  compareVersions,
  extensionCacheName,
  extensionFilesToRemove,
  extensionRetryWaits,
  formatExtensionRecord,
  isEngineCompatible,
  parseCachedExtension,
  parseExtensionFailures,
  parseExtensionRecord,
  parseMarketplaceAnswer,
  seedSelection,
  wantedExtensions,
  type ExtensionRef,
  type MarketplaceVersion,
} from './vscodeExtensions';

const DAY = 24 * 60 * 60_000;
const NOW = 500 * DAY;
const VSIX_ASSET = 'Microsoft.VisualStudio.Services.VSIXPackage';

/** An answer of the Marketplace with one extension `a.b` and these raw version entries. */
function answerOf(versions: unknown[], extension: Record<string, unknown> = {}): string {
  return JSON.stringify({ results: [{ extensions: [{ publisher: { publisherName: 'a' }, extensionName: 'b', versions, ...extension }] }] });
}

describe('the record, the union and the failures: bounds and times (review round 1 of 11H3, reviewer B)', () => {
  it('a record larger than MAX_EXTENSION_RECORD_BYTES is refused even when it is valid JSON of the right shape', () => {
    const text = formatExtensionRecord({ at: 1, configuration: [{ id: 'a.b' }], defaults: [] });
    expect(parseExtensionRecord(text)).toBeDefined();
    const padded = `${' '.repeat(MAX_EXTENSION_RECORD_BYTES)}${text}`;
    expect(parseExtensionRecord(padded)).toBeUndefined();
  });

  it('the time of a record is a whole number', () => {
    expect(parseExtensionRecord(JSON.stringify({ at: 1.5, configuration: [], defaults: [] }))).toBeUndefined();
  });

  it('the union holds at most MAX_WANTED_EXTENSIONS entries (200) whatever the number of records', () => {
    expect(MAX_WANTED_EXTENSIONS).toBe(200);
    const records = [0, 1, 2].map((part) => ({
      at: NOW - DAY,
      configuration: Array.from({ length: 100 }, (_, index): ExtensionRef => ({ id: `p${part}.e${String(index).padStart(3, '0')}` })),
      defaults: [],
    }));
    const wanted = wantedExtensions(records, NOW);
    expect(wanted).toHaveLength(200);
    // Sorted, so the cut is stable.
    expect(wanted[0]).toEqual({ id: 'p0.e000' });
    expect(wanted[199]).toEqual({ id: 'p1.e099' });
  });

  it('a list counts for 14 days in absolute times: 13.5 days ago counts, 14 days ago does not', () => {
    const at = (days: number) => [{ at: NOW - days * DAY, configuration: [{ id: 'a.b' }], defaults: [] }];
    expect(wantedExtensions(at(13.5), NOW)).toEqual([{ id: 'a.b' }]);
    expect(wantedExtensions(at(14), NOW)).toEqual([]);
  });

  it('the failures file is bounded, and a failure has a time of zero or later', () => {
    expect(parseExtensionFailures(JSON.stringify({ 'a.b': 5 }))).toEqual(new Map([['a.b', 5]]));
    expect(parseExtensionFailures(`${' '.repeat(MAX_EXTENSION_RECORD_BYTES)}${JSON.stringify({ 'a.b': 5 })}`)).toEqual(new Map());
    expect(parseExtensionFailures(JSON.stringify({ 'a.b': -1 }))).toEqual(new Map());
  });

  it('a failure more than a day ahead of now (a clock set back) does not wait for ever', () => {
    expect(extensionRetryWaits(NOW + DAY / 2, NOW)).toBe(true);
    expect(extensionRetryWaits(NOW + 2 * DAY, NOW)).toBe(false);
  });
});

describe('cache names and versions (review round 1 of 11H3, reviewer B)', () => {
  it('a cache name is in lower case whatever the case of the ID that it is given', () => {
    expect(extensionCacheName('RedHat.VSCode-YAML', '1.24.0')).toBe('redhat.vscode-yaml-1.24.0');
    expect(extensionCacheName('Rust-Lang.Rust-Analyzer', '0.3.2', 'linux-x64')).toBe('rust-lang.rust-analyzer-0.3.2-linux-x64');
  });

  it('a file name with anything after the version (or the platform) is no cache name', () => {
    expect(parseCachedExtension('a.b-1.0.0', 'universal')).toEqual({ id: 'a.b', version: '1.0.0' });
    expect(parseCachedExtension('a.b-1.0.0.bak', 'universal')).toBeUndefined();
    expect(parseCachedExtension('a.b-1.0.0x', 'universal')).toBeUndefined();
    expect(parseCachedExtension('a.b-1.0.0-linux-x64x', 'linux-x64')).toBeUndefined();
  });

  it('versions that differ only in their patch: the newer one is the newest (seed and cleanup)', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    // The older file first, so a rule that sees them as equal keeps the first one.
    expect(extensionFilesToRemove('universal', ['a.b-1.2.3', 'a.b-1.2.4'], new Set())).toEqual(['a.b-1.2.3']);
    expect(seedSelection([{ id: 'a.b' }], { universal: ['a.b-1.2.3', 'a.b-1.2.4'] }, undefined)).toEqual(['universal/a.b-1.2.4']);
  });
});

describe('the engine rules of VS Code that were left open (review round 1 of 11H3, reviewer B)', () => {
  it('>= with a newer major is not compatible', () => {
    expect(isEngineCompatible('>=2.0.0', '1.105.0')).toBe(false);
    expect(isEngineCompatible('>=1.105.0', '1.105.0')).toBe(true);
  });

  it('an exact version needs the same patch', () => {
    expect(isEngineCompatible('1.105.1', '1.105.1')).toBe(true);
    expect(isEngineCompatible('1.105.0', '1.105.1')).toBe(false);
  });

  it('^0.y.z keeps the minor (VS Code: for a major 0 only the patch is free)', () => {
    expect(isEngineCompatible('^0.1.2', '0.1.5')).toBe(true);
    expect(isEngineCompatible('^0.1.2', '0.2.0')).toBe(false);
  });

  it('an `x` part is free from 0 on', () => {
    expect(isEngineCompatible('1.x.x', '1.0.0')).toBe(true);
    expect(isEngineCompatible('1.x.x', '1.105.3')).toBe(true);
  });

  it('white space around the engine is ignored', () => {
    expect(isEngineCompatible(' ^1.90.0 ', '1.105.0')).toBe(true);
  });
});

describe('the strict parse of a Marketplace answer and the choice (review round 1 of 11H3, reviewer B)', () => {
  const good = { version: '1.0.0', properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.90.0' }], files: [{ assetType: VSIX_ASSET, source: 'https://cdn.gallerycdn.vsassets.io/1.vsix' }] };

  it('an extension of another shape fails the whole answer', () => {
    expect(parseMarketplaceAnswer(answerOf([good]))?.get('a.b')).toHaveLength(1);
    const bad = JSON.stringify({ results: [{ extensions: [{ publisher: 'a', extensionName: 'b', versions: [good] }] }] });
    expect(parseMarketplaceAnswer(bad)).toBeUndefined();
  });

  it('an extension with more than 20000 versions fails the answer', () => {
    expect(parseMarketplaceAnswer(answerOf(Array.from({ length: 20_001 }, () => ({}))))).toBeUndefined();
    expect(parseMarketplaceAnswer(answerOf(Array.from({ length: 20_000 }, () => ({}))))?.get('a.b')).toEqual([]);
  });

  it('a version with a property or a file of another shape is left out', () => {
    expect(parseMarketplaceAnswer(answerOf([{ ...good, properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: 5 }] }]))?.get('a.b')).toEqual([]);
    expect(parseMarketplaceAnswer(answerOf([{ ...good, files: [{ assetType: VSIX_ASSET, source: 5 }] }]))?.get('a.b')).toEqual([]);
  });

  it('the pre-release mark is only the value `true`', () => {
    const marked = (value: string) =>
      parseMarketplaceAnswer(answerOf([{ ...good, properties: [...good.properties, { key: 'Microsoft.VisualStudio.Code.PreRelease', value }] }]))?.get('a.b')?.[0].preRelease;
    expect(marked('true')).toBe(true);
    expect(marked('false')).toBe(false);
  });

  it('the VSIX file of the version comes before the asset URI', () => {
    const versions = parseMarketplaceAnswer(answerOf([{ ...good, assetUri: 'https://other.example/assets' }]))?.get('a.b');
    expect(versions?.[0].vsix).toBe('https://cdn.gallerycdn.vsassets.io/1.vsix');
  });

  it('the platform at the same version wins whatever the order of the versions', () => {
    const platform: MarketplaceVersion = { version: '1.0.0', targetPlatform: 'linux-x64', preRelease: false, engine: '^1.90.0', vsix: 'https://cdn.gallerycdn.vsassets.io/x64.vsix' };
    const universal: MarketplaceVersion = { version: '1.0.0', preRelease: false, engine: '^1.90.0', vsix: 'https://cdn.gallerycdn.vsassets.io/u.vsix' };
    for (const versions of [
      [platform, universal],
      [universal, platform],
    ]) {
      expect(chooseExtensionVersion({ id: 'a.b' }, versions, '1.105.0', 'linux-x64')).toMatchObject({ targetPlatform: 'linux-x64', folder: 'linux-x64', cacheName: 'a.b-1.0.0-linux-x64' });
    }
  });
});
