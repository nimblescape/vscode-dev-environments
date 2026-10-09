// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3 (reviewer B, mutation testing): probes of the files of the shared extension cache in a store of
// a temporary folder that no test pinned: the record is written atomically (never through a planted link) and private;
// the reads never follow a link and skip a folder or a name that is no environment ID; a link in place of a folder of the
// cache is never listed or written through; a folder of the cache gets 0755 back; the ZIP check reads all four bytes; the
// download has its time limit, its default size cap and its bounded lock wait, and releases its lock on every outcome.
// Review round 1 of 11H3 (A-L6): the `.vsix` URLs of these tests are on a host of the Marketplace's CDN
// (`cdn.gallerycdn.vsassets.io`, was `cdn.example`), as a VSIX URL on any other host is now refused; nothing else changed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpStreamResponse } from '../http';
import { formatExtensionRecord, type ChosenExtension } from '../vscodeExtensions';
import { MAX_VSIX_BYTES, cachedExtensionFiles, ensureExtension, readExtensionRecords, recordExtensions } from './vscodeExtensionStore';

const ENV = 'a1b2c3d4e5';
const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest of a zip')]);
const CHOSEN: ChosenExtension = { version: '1.24.0', vsix: 'https://cdn.gallerycdn.vsassets.io/yaml.vsix', folder: 'universal', cacheName: 'redhat.vscode-yaml-1.24.0' };

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A sandbox with the store and a folder outside of it. */
function sandbox(): { root: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-store-pH3R1-'));
  temps.push(base);
  const root = path.join(base, 'store');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  return { root, outside };
}

function answering(response: () => HttpStreamResponse) {
  const urls: string[] = [];
  return {
    urls,
    stream: async (url: string) => {
      urls.push(url);
      return response();
    },
  };
}

/** A lock that counts its takes and releases and records its wait. */
function countingLock(onTake: () => void = () => undefined) {
  const state = { taken: 0, released: 0, waits: [] as number[] };
  return {
    state,
    lock: async (_name: string, waitSeconds: number) => {
      state.taken++;
      state.waits.push(waitSeconds);
      onTake();
      return () => {
        state.released++;
      };
    },
  };
}

describe('the record and its reads (review round 1 of 11H3, reviewer B)', () => {
  it('writes the record atomically: a link planted in its place is replaced, never written through; the file is private', async () => {
    const { root, outside } = sandbox();
    const wanted = path.join(root, 'extensions', 'wanted');
    fs.mkdirSync(wanted, { recursive: true });
    const victim = path.join(outside, 'victim');
    fs.writeFileSync(victim, 'untouched');
    fs.symlinkSync(victim, path.join(wanted, `${ENV}.json`));
    await recordExtensions(root, ENV, [{ id: 'a.b' }], [], 7);
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    const stat = fs.lstatSync(path.join(wanted, `${ENV}.json`));
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o077).toBe(0);
  });

  it('an open without its configuration takes its own defaults, also none', async () => {
    const { root } = sandbox();
    await recordExtensions(root, ENV, [{ id: 'a.b' }], [{ id: 'user.default' }], 1);
    await recordExtensions(root, ENV, undefined, [], 2);
    expect(await readExtensionRecords(root)).toEqual([{ at: 2, configuration: [{ id: 'a.b' }], defaults: [] }]);
  });

  it('the reads never follow a link, skip a folder of a record name and a name that is no environment ID', async () => {
    const { root, outside } = sandbox();
    const wanted = path.join(root, 'extensions', 'wanted');
    fs.mkdirSync(wanted, { recursive: true });
    const text = formatExtensionRecord({ at: 3, configuration: [{ id: 'c.d' }], defaults: [] });
    fs.writeFileSync(path.join(outside, 'record.json'), text);
    fs.symlinkSync(path.join(outside, 'record.json'), path.join(wanted, 'linked0001.json'));
    fs.mkdirSync(path.join(wanted, 'afolder001.json'));
    fs.writeFileSync(path.join(wanted, 'bad.id.json'), text);
    fs.writeFileSync(path.join(wanted, `${ENV}.json`), formatExtensionRecord({ at: 4, configuration: [{ id: 'e.f' }], defaults: [] }));
    expect(await readExtensionRecords(root)).toEqual([{ at: 4, configuration: [{ id: 'e.f' }], defaults: [] }]);
  });
});

describe('the folders of the cache (review round 1 of 11H3, reviewer B)', () => {
  it('a link in place of a folder of the cache is not listed', async () => {
    const { root, outside } = sandbox();
    fs.writeFileSync(path.join(outside, 'a.b-1.0.0'), VSIX);
    fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'extensions', 'universal'));
    expect((await cachedExtensionFiles(root)).universal).toEqual([]);
  });

  it('a download never lands through a link in place of its folder', async () => {
    const { root, outside } = sandbox();
    fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'extensions', 'universal'));
    const t = answering(() => ({ status: 200, headers: {}, body: Readable.from([VSIX]) }));
    await expect(ensureExtension({ root, transport: t, lock: async () => () => undefined }, CHOSEN, new AbortController().signal)).rejects.toThrow('is not a folder');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('folders of the cache that exist with another mode get 0755 back (the dev containers read them)', async () => {
    const { root } = sandbox();
    fs.mkdirSync(path.join(root, 'extensions', 'universal'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(root, 'extensions'), 0o700);
    fs.chmodSync(path.join(root, 'extensions', 'universal'), 0o700);
    const t = answering(() => ({ status: 200, headers: {}, body: Readable.from([VSIX]) }));
    expect(await ensureExtension({ root, transport: t, lock: async () => () => undefined }, CHOSEN, new AbortController().signal)).toBe('downloaded');
    expect(fs.statSync(path.join(root, 'extensions')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, 'extensions', 'universal')).mode & 0o777).toBe(0o755);
  });
});

describe('the download of one file (review round 1 of 11H3, reviewer B)', () => {
  it('the ZIP check reads all four bytes of a local file header (an empty archive is no VSIX)', async () => {
    const { root } = sandbox();
    const t = answering(() => ({ status: 200, headers: {}, body: Readable.from([Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0])]) }));
    await expect(ensureExtension({ root, transport: t, lock: async () => () => undefined }, CHOSEN, new AbortController().signal)).rejects.toThrow('no VSIX');
  });

  it('the default size cap is MAX_VSIX_BYTES (a larger announced length is refused)', async () => {
    const { root } = sandbox();
    const t = answering(() => ({ status: 200, headers: { 'content-length': String(MAX_VSIX_BYTES + 1) }, body: Readable.from([VSIX]) }));
    await expect(ensureExtension({ root, transport: t, lock: async () => () => undefined }, CHOSEN, new AbortController().signal)).rejects.toThrow(`larger than ${MAX_VSIX_BYTES} bytes`);
    expect(fs.existsSync(path.join(root, 'extensions', 'universal', CHOSEN.cacheName))).toBe(false);
  });

  it('a download that never ends is ended by its time limit', async () => {
    const { root } = sandbox();
    const t = answering(() => ({ status: 200, headers: {}, body: new Readable({ read() {} }) }));
    await expect(ensureExtension({ root, transport: t, lock: async () => () => undefined, timeoutMs: 200 }, CHOSEN, new AbortController().signal)).rejects.toThrow('took longer than');
    expect(fs.readdirSync(path.join(root, 'extensions', 'tmp'))).toEqual([]);
  }, 10_000);

  it('waits for the lock of the file as long as its time limit, and releases it on every outcome', async () => {
    const { root } = sandbox();
    const ok = countingLock();
    const t = answering(() => ({ status: 200, headers: {}, body: Readable.from([VSIX]) }));
    expect(await ensureExtension({ root, transport: t, lock: ok.lock, timeoutMs: 2500 }, CHOSEN, new AbortController().signal)).toBe('downloaded');
    expect(ok.state).toEqual({ taken: 1, released: 1, waits: [3] });

    const other = sandbox();
    const failing = countingLock();
    const bad = answering(() => ({ status: 503, headers: {}, body: Readable.from([]) }));
    await expect(ensureExtension({ root: other.root, transport: bad, lock: failing.lock }, CHOSEN, new AbortController().signal)).rejects.toThrow('HTTP 503');
    expect(failing.state).toEqual({ taken: 1, released: 1, waits: [600] });

    const third = sandbox();
    const finished = countingLock(() => {
      fs.mkdirSync(path.join(third.root, 'extensions', 'universal'), { recursive: true });
      fs.writeFileSync(path.join(third.root, 'extensions', 'universal', CHOSEN.cacheName), VSIX);
    });
    expect(await ensureExtension({ root: third.root, transport: answering(() => ({ status: 500, headers: {}, body: Readable.from([]) })), lock: finished.lock }, CHOSEN, new AbortController().signal)).toBe('present');
    expect(finished.state.released).toBe(1);
  });
});
