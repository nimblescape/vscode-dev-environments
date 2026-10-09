// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Reviewer B, review round 2 of 11H3 (mutation testing): probes of the rules changed in round 1 that no test pinned:
// the hosts of a VSIX URL (user info alone, a password alone, characters outside a host label, a sibling of the CDN
// domain, a look-alike domain, a host that only ends like the Marketplace), the strict parse of the chosen files (a
// further path part; a file of the largest size that a run writes), and the seed's check of a chosen file's ID.
import { describe, expect, it } from 'vitest';
import { MAX_EXTENSION_CHOICES_BYTES, MAX_WANTED_EXTENSIONS, formatExtensionChoices, isMarketplaceDownloadUrl, parseExtensionChoices, seedSelection } from './vscodeExtensions';

describe('the hosts of a VSIX URL, further cases (reviewer B, round 2 of 11H3)', () => {
  it.each([
    // User info of any kind (a user alone, a password alone).
    ['https://user@marketplace.visualstudio.com/x', false],
    ['https://:secret@marketplace.visualstudio.com/x', false],
    // A label of the CDN with a character that no host label of the Marketplace has.
    ['https://a_b.gallerycdn.vsassets.io/x', false],
    // Another service under vsassets.io, not the gallery's CDN.
    ['https://a.other.vsassets.io/x', false],
    // Look-alike domains that anyone can register (the dots are literal).
    ['https://a.gallery-vsassets.io/x', false],
    ['https://a.gallerycdn.vsassetsxio/x', false],
    // A host that only ends like the Marketplace.
    ['https://evilmarketplace.visualstudio.com/x', false],
    // A trailing dot is not the Marketplace's spelling (refused, conservatively).
    ['https://a.gallerycdn.vsassets.io./x', false],
    // Still allowed: a publisher label with digits and dashes.
    ['https://ms-python2.gallerycdn.vsassets.io/x', true],
  ])('%s: %s', (url, allowed) => {
    expect(isMarketplaceDownloadUrl(url)).toBe(allowed);
    expect(isMarketplaceDownloadUrl(new URL(url))).toBe(allowed);
  });
});

describe('the chosen files, further cases (reviewer B, round 2 of 11H3)', () => {
  it('a file with a further path part is left out', () => {
    expect(parseExtensionChoices('{"a.b":"universal/a.b-1.0.0/x","c.d":"universal/c.d-1.0.0"}')).toEqual(new Map([['c.d', 'universal/c.d-1.0.0']]));
  });

  it('the largest file that a run writes (MAX_WANTED_EXTENSIONS entries with long IDs) is read whole', () => {
    const choices = new Map<string, string>();
    for (let index = 0; index < MAX_WANTED_EXTENSIONS; index++) {
      const id = `p${String(index).padStart(3, '0')}.${'n'.repeat(240)}`;
      choices.set(id, `linux-arm64/${id}-123456789.123456789.123456789-linux-arm64`);
    }
    const text = formatExtensionChoices(choices);
    expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_EXTENSION_CHOICES_BYTES);
    expect(parseExtensionChoices(text)).toEqual(choices);
  });
});

describe('the seed of a chosen file (reviewer B, round 2 of 11H3)', () => {
  it('a choice that names a file of another ID is not seeded for the entry', () => {
    const files = { universal: ['a.b-1.0.0', 'c.d-2.0.0'] };
    expect(seedSelection([{ id: 'a.b' }], files, 'linux-x64', new Map([['a.b', 'universal/c.d-2.0.0']]))).toEqual(['universal/a.b-1.0.0']);
  });
});
