// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3: the files of the shared extension cache in a store of a temporary folder. A-M1: a gzip answer
// (`Content-Encoding: gzip`, or a body that starts with 1f 8b) is stored as the plain ZIP, its size bounded after the
// decoding. A-L2/B-D2 (reviewer A's probe P2): the leftovers of a download are matched by their exact name. A-L6: a VSIX
// URL off the hosts of the Marketplace is refused, the first one and every redirect. A-L5/B-D4: the records and the
// chosen files are in the folder of the monitor's volume (0700); its listing fails on anything but a missing folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { gzipSync } from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpStreamResponse } from '../http';
import type { ChosenExtension } from '../vscodeExtensions';
import { ensureExtension, readExtensionChoices, readExtensionRecords, recordExtensions, writeExtensionChoices } from './vscodeExtensionStore';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-store-r1-'));
  temps.push(root);
  return root;
}

const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('the rest of a zip archive')]);
const URL_OF = 'https://ms-python.gallerycdn.vsassets.io/extensions/a/b/1.0.0/Microsoft.VisualStudio.Services.VSIXPackage';
const CHOSEN: ChosenExtension = { version: '1.0.0', vsix: URL_OF, folder: 'universal', cacheName: 'a.b-1.0.0' };
const signal = () => new AbortController().signal;
const noLock = async () => () => undefined;

function answering(responses: Record<string, () => HttpStreamResponse>) {
  const urls: string[] = [];
  return {
    urls,
    stream: async (url: string) => {
      urls.push(url);
      return (responses[url] ?? (() => ({ status: 404, headers: {}, body: Readable.from([]) })))();
    },
  };
}

describe('a gzip answer (review round 1 of 11H3, A-M1)', () => {
  it.each([
    ['with Content-Encoding: gzip', { 'content-encoding': 'gzip' }],
    ['without the header, by its first bytes', {}],
  ])('%s: decoded, stored as the plain ZIP', async (_what, headers) => {
    const root = folder();
    const t = answering({ [URL_OF]: () => ({ status: 200, headers, body: Readable.from([gzipSync(VSIX)]) }) });
    expect(await ensureExtension({ root, transport: t, lock: noLock }, CHOSEN, signal())).toBe('downloaded');
    const file = path.join(root, 'extensions', 'universal', CHOSEN.cacheName);
    expect(fs.readFileSync(file)).toEqual(VSIX);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(path.join(root, 'extensions', 'tmp'))).toEqual([]);
  });

  it('a gzip bomb stops at the cap counted after the decoding; nothing is left behind', async () => {
    const root = folder();
    const bomb = gzipSync(Buffer.concat([VSIX, Buffer.alloc(4 * 1024 * 1024)]));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const t = answering({ [URL_OF]: () => ({ status: 200, headers: { 'content-encoding': 'gzip' }, body: Readable.from([bomb]) }) });
    await expect(ensureExtension({ root, transport: t, lock: noLock, maxBytes: 64 * 1024 }, CHOSEN, signal())).rejects.toThrow(`larger than ${64 * 1024} bytes after its gzip decoding`);
    expect(fs.readdirSync(path.join(root, 'extensions', 'tmp'))).toEqual([]);
    expect(fs.existsSync(path.join(root, 'extensions', 'universal', CHOSEN.cacheName))).toBe(false);
  });

  it('a gzip stream that does not decode to a ZIP is no VSIX', async () => {
    const root = folder();
    const t = answering({ [URL_OF]: () => ({ status: 200, headers: { 'content-encoding': 'gzip' }, body: Readable.from([gzipSync(Buffer.from('<html>'))]) }) });
    await expect(ensureExtension({ root, transport: t, lock: noLock }, CHOSEN, signal())).rejects.toThrow('no VSIX');
    expect(fs.readdirSync(path.join(root, 'extensions', 'tmp'))).toEqual([]);
  });
});

describe('the leftovers of a download (review round 1 of 11H3, A-L2/B-D2; reviewer A\'s probe P2)', () => {
  it('only `<cache name>-<12 hexadecimal digits>` goes; the download of the platform file of the same version stays', async () => {
    const root = folder();
    const temp = path.join(root, 'extensions', 'tmp');
    fs.mkdirSync(temp, { recursive: true });
    const own = path.join(temp, 'a.b-1.0.0-0123456789ab');
    const other = path.join(temp, 'a.b-1.0.0-linux-x64-0123456789ab'); // another download, under ANOTHER lock
    const similar = path.join(temp, 'a.b-1.0.0-0123456789abc');
    for (const file of [own, other, similar]) fs.writeFileSync(file, 'partial');
    const t = answering({ [URL_OF]: () => ({ status: 200, headers: {}, body: Readable.from([VSIX]) }) });
    expect(await ensureExtension({ root, transport: t, lock: noLock }, CHOSEN, signal())).toBe('downloaded');
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(similar)).toBe(true);
  });
});

describe('the hosts of a download (review round 1 of 11H3, A-L6)', () => {
  it('a VSIX URL off the Marketplace is refused before any request', async () => {
    const root = folder();
    const t = answering({});
    await expect(ensureExtension({ root, transport: t, lock: noLock }, { ...CHOSEN, vsix: 'https://evil.example/a.vsix' }, signal())).rejects.toThrow('not on an allowed host');
    expect(t.urls).toEqual([]);
  });

  it('a redirect off the Marketplace is refused; one to its CDN is followed', async () => {
    const root = folder();
    const evil = answering({ [URL_OF]: () => ({ status: 302, headers: { location: 'https://evil.example/a.vsix' }, body: Readable.from([]) }) });
    await expect(ensureExtension({ root, transport: evil, lock: noLock }, CHOSEN, signal())).rejects.toThrow('not on an allowed host');
    expect(evil.urls).toEqual([URL_OF]);
    expect(fs.readdirSync(path.join(root, 'extensions', 'tmp'))).toEqual([]);

    const next = 'https://other.gallery.vsassets.io/a.vsix';
    const cdn = answering({ [URL_OF]: () => ({ status: 302, headers: { location: next }, body: Readable.from([]) }), [next]: () => ({ status: 200, headers: {}, body: Readable.from([VSIX]) }) });
    expect(await ensureExtension({ root, transport: cdn, lock: noLock }, CHOSEN, signal())).toBe('downloaded');
    expect(cdn.urls).toEqual([URL_OF, next]);
  });
});

describe('the lists in the volume of the monitor (review round 1 of 11H3, A-L5/B-D4)', () => {
  it('the record folders are 0700, also when they existed with another mode', async () => {
    const state = folder();
    fs.mkdirSync(path.join(state, 'extensions', 'wanted'), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(state, 'extensions'), 0o755);
    fs.chmodSync(path.join(state, 'extensions', 'wanted'), 0o755);
    await recordExtensions(state, 'a1b2c3d4e5', [{ id: 'a.b' }], [], 1);
    expect(fs.statSync(path.join(state, 'extensions')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(state, 'extensions', 'wanted')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(state, 'extensions', 'wanted', 'a1b2c3d4e5.json')).mode & 0o777).toBe(0o600);
  });

  it('a missing folder has no records; a listing that fails otherwise rejects', async () => {
    const state = folder();
    expect(await readExtensionRecords(state)).toEqual([]);
    fs.mkdirSync(path.join(state, 'extensions'));
    fs.writeFileSync(path.join(state, 'extensions', 'wanted'), 'a file, no folder');
    await expect(readExtensionRecords(state)).rejects.toThrow();
  });

  it('the chosen files round-trip through extensions/chosen.json; invalid entries are left out', async () => {
    const state = folder();
    expect(await readExtensionChoices(state)).toEqual(new Map());
    await writeExtensionChoices(state, new Map([['a.b', 'universal/a.b-1.0.0'], ['c.d@2.0.0', 'linux-x64/c.d-2.0.0-linux-x64']]));
    expect(await readExtensionChoices(state)).toEqual(new Map([['a.b', 'universal/a.b-1.0.0'], ['c.d@2.0.0', 'linux-x64/c.d-2.0.0-linux-x64']]));
    fs.writeFileSync(
      path.join(state, 'extensions', 'chosen.json'),
      JSON.stringify({ 'a.b': 'universal/x.y-1.0.0', 'c.d': 'universal/../c.d-1.0.0', 'e.f': 'tmp/e.f-1.0.0', 'g.h': 'linux-x64/g.h-1.0.0', 'i.j': 'universal/i.j-1.0.0', 'K.L': 'universal/k.l-1.0.0' }),
    );
    expect(await readExtensionChoices(state)).toEqual(new Map([['i.j', 'universal/i.j-1.0.0']]));
  });
});
