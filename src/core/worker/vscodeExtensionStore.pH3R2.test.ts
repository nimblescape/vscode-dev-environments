// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Reviewer B, review round 2 of 11H3 (mutation testing): probes of the store's files changed in round 1 that no test
// pinned: the chosen files written on their own (folder 0700, file 0600, atomically: never through a planted link; the
// largest file a run writes read whole), the exact leftover sweep (a longer cache name that ends like this one; a name
// that differs only where the cache name has a dot), the gzip decoding (a decoded file of exactly the cap is kept, one
// byte more is refused; the decoding gets the signal of the download and writes a temporary file of the leftover
// pattern). Everything in temporary folders.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { gzipSync } from 'zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_WANTED_EXTENSIONS, type ChosenExtension } from '../vscodeExtensions';
import { ensureExtension, readExtensionChoices, writeExtensionChoices } from './vscodeExtensionStore';

const pipelineCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('stream/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('stream/promises')>();
  return {
    ...actual,
    pipeline: (...args: unknown[]) => {
      pipelineCalls.push(args);
      return (actual.pipeline as (...a: unknown[]) => Promise<void>)(...args);
    },
  };
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  pipelineCalls.length = 0;
});

function folder(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-store-pH3R2-'));
  temps.push(root);
  return root;
}

const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('the rest of a zip archive')]);
const URL_OF = 'https://ms-python.gallerycdn.vsassets.io/extensions/a/b/1.0.0/Microsoft.VisualStudio.Services.VSIXPackage';
const CHOSEN: ChosenExtension = { version: '1.0.0', vsix: URL_OF, folder: 'universal', cacheName: 'a.b-1.0.0' };
const noLock = async () => () => undefined;
const transport = (body: Buffer, headers: Record<string, string> = {}) => ({ stream: async () => ({ status: 200, headers, body: Readable.from([body]) }) });

describe('the chosen files on their own (reviewer B, round 2 of 11H3)', () => {
  it('written alone: the folder 0700 (also when it was 0755), the file 0600', async () => {
    const fresh = folder();
    await writeExtensionChoices(fresh, new Map([['a.b', 'universal/a.b-1.0.0']]));
    expect(fs.statSync(path.join(fresh, 'extensions')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(fresh, 'extensions', 'chosen.json')).mode & 0o777).toBe(0o600);
    const existing = folder();
    fs.mkdirSync(path.join(existing, 'extensions'), { mode: 0o755 });
    fs.chmodSync(path.join(existing, 'extensions'), 0o755);
    await writeExtensionChoices(existing, new Map([['a.b', 'universal/a.b-1.0.0']]));
    expect(fs.statSync(path.join(existing, 'extensions')).mode & 0o777).toBe(0o700);
  });

  it('a link planted at chosen.json is replaced, never written through', async () => {
    const state = folder();
    const outside = path.join(folder(), 'outside.txt');
    fs.writeFileSync(outside, 'untouched');
    fs.mkdirSync(path.join(state, 'extensions'), { mode: 0o700 });
    fs.symlinkSync(outside, path.join(state, 'extensions', 'chosen.json'));
    await writeExtensionChoices(state, new Map([['a.b', 'universal/a.b-1.0.0']]));
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
    expect(fs.lstatSync(path.join(state, 'extensions', 'chosen.json')).isFile()).toBe(true);
    expect(await readExtensionChoices(state)).toEqual(new Map([['a.b', 'universal/a.b-1.0.0']]));
  });

  it('the largest file that a run writes is read back whole (more than a record\'s 64 KiB)', async () => {
    const state = folder();
    const choices = new Map<string, string>();
    for (let index = 0; index < MAX_WANTED_EXTENSIONS; index++) {
      const id = `p${String(index).padStart(3, '0')}.${'n'.repeat(240)}`;
      choices.set(id, `linux-arm64/${id}-123456789.123456789.123456789-linux-arm64`);
    }
    await writeExtensionChoices(state, choices);
    expect(fs.statSync(path.join(state, 'extensions', 'chosen.json')).size).toBeGreaterThan(64 * 1024);
    expect(await readExtensionChoices(state)).toEqual(choices);
  });
});

describe('the leftover sweep matches the whole name (reviewer B, round 2 of 11H3)', () => {
  it('the temporary files of another cache name stay: a longer one that ends like it, one that differs where it has a dot', async () => {
    const root = folder();
    const temp = path.join(root, 'extensions', 'tmp');
    fs.mkdirSync(temp, { recursive: true });
    const own = path.join(temp, 'a.b-1.0.0-0123456789ab');
    const longer = path.join(temp, 'xa.b-1.0.0-0123456789ab'); // the download of `xa.b` 1.0.0, under its own lock
    const dotless = path.join(temp, 'a-b-1.0.0-0123456789ab');
    for (const file of [own, longer, dotless]) fs.writeFileSync(file, 'partial');
    expect(await ensureExtension({ root, transport: transport(VSIX), lock: noLock }, CHOSEN, new AbortController().signal)).toBe('downloaded');
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(longer)).toBe(true);
    expect(fs.existsSync(dotless)).toBe(true);
  });
});

describe('the gzip decoding, further cases (reviewer B, round 2 of 11H3)', () => {
  it('a decoded file of exactly the cap is kept (the cap is the largest allowed size)', async () => {
    const root = folder();
    const exact = Buffer.concat([VSIX, Buffer.alloc(4096 - VSIX.length)]);
    const body = gzipSync(exact);
    expect(body.length).toBeLessThan(4096);
    expect(await ensureExtension({ root, transport: transport(body), lock: noLock, maxBytes: 4096 }, CHOSEN, new AbortController().signal)).toBe('downloaded');
    expect(fs.readFileSync(path.join(root, 'extensions', 'universal', CHOSEN.cacheName))).toEqual(exact);
    // One byte more after the decoding is refused (the cap is the decoded size itself, not a multiple of it).
    const other = folder();
    const over = gzipSync(Buffer.concat([exact, Buffer.alloc(1)]));
    expect(over.length).toBeLessThan(4096);
    await expect(ensureExtension({ root: other, transport: transport(over), lock: noLock, maxBytes: 4096 }, CHOSEN, new AbortController().signal)).rejects.toThrow('larger than 4096 bytes after its gzip decoding');
    expect(fs.readdirSync(path.join(other, 'extensions', 'tmp'))).toEqual([]);
  });

  it('the decoding runs under the signal of the download (the run\'s end and the time limit stop it)', async () => {
    const root = folder();
    expect(await ensureExtension({ root, transport: transport(gzipSync(VSIX)), lock: noLock }, CHOSEN, new AbortController().signal)).toBe('downloaded');
    // The download (body, counter, file) and the decoding (file, gunzip, counter, file): each with a signal.
    expect(pipelineCalls.map((args) => args.length)).toEqual([4, 5]);
    for (const args of pipelineCalls) expect((args[args.length - 1] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    // The decoded file is a temporary file of the exact leftover pattern (a killed decoding is swept with the download).
    expect(path.basename(String((pipelineCalls[1][3] as { path?: unknown }).path))).toMatch(/^a\.b-1\.0\.0-[0-9a-f]{12}$/);
  });
});
