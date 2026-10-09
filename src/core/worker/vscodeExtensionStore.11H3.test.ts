// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; live check 3 of the user): the files of the shared extension cache in a store
// of a temporary folder: the record of an open (atomic, bounded, the recorded configuration kept when the open could not
// read its own), the read of the records, the listing of the cached files, and the download of one `.vsix` (present: no
// lock and no network; under the lock of its file; a temporary file renamed into place; `https:` only; a size cap; a ZIP
// check, as the Marketplace gives no hash; leftovers of the same file removed, other files never touched).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpStreamResponse } from '../http';
import {
  EXTENSION_TEMP_FOLDER,
  STORE_EXTENSION_FOLDER,
  cachedExtensionFiles,
  ensureExtension,
  extensionLockFile,
  readExtensionRecords,
  recordExtensions,
  writeExtensionFailures,
  readExtensionFailures,
} from './vscodeExtensionStore';
import { storeLock, storeTryLock } from './vscodeServerStore';
import type { ChosenExtension } from '../vscodeExtensions';

const ENV = 'a1b2c3d4e5';
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function store(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-store-'));
  temps.push(root);
  return root;
}

const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest of a zip')]);
const CHOSEN: ChosenExtension = { version: '1.24.0', vsix: 'https://cdn.example/yaml.vsix', folder: 'universal', cacheName: 'redhat.vscode-yaml-1.24.0' };

/** A transport whose downloads answer by URL; it records each URL. */
function transport(answers: Record<string, () => HttpStreamResponse>) {
  const urls: string[] = [];
  return {
    urls,
    stream: async (url: string) => {
      urls.push(url);
      return (answers[url] ?? (() => ({ status: 404, headers: {}, body: Readable.from([]) })))();
    },
  };
}

/** A lock that records its names and what the store held when it was taken. */
function recordingLock(root: string) {
  const taken: Array<{ name: string; temp: string[] }> = [];
  return {
    taken,
    lock: async (name: string) => {
      taken.push({ name, temp: fs.readdirSync(path.join(root, STORE_EXTENSION_FOLDER, EXTENSION_TEMP_FOLDER), { withFileTypes: true }).map((e) => e.name) });
      return () => undefined;
    },
  };
}

describe('the record of an open (plan step 11H3)', () => {
  it('writes the list atomically into extensions/wanted/<environment-id>.json and resolves with the list of the open', async () => {
    const root = store();
    const list = await recordExtensions(root, ENV, [{ id: 'a.b', version: '1.0.0' }], [{ id: 'c.d' }, { id: 'a.b' }], 1234);
    expect(list).toEqual([{ id: 'a.b', version: '1.0.0' }, { id: 'c.d' }]);
    const folder = path.join(root, 'extensions', 'wanted');
    expect(fs.readdirSync(folder)).toEqual([`${ENV}.json`]);
    expect(JSON.parse(fs.readFileSync(path.join(folder, `${ENV}.json`), 'utf8'))).toEqual({ at: 1234, configuration: ['a.b@1.0.0'], defaults: ['c.d', 'a.b'] });
    expect(fs.statSync(path.join(root, 'extensions')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(await readExtensionRecords(root)).toEqual([{ at: 1234, configuration: [{ id: 'a.b', version: '1.0.0' }], defaults: [{ id: 'c.d' }, { id: 'a.b' }] }]);
  });

  it('an open without its configuration keeps the recorded configuration and takes its own defaults and time', async () => {
    const root = store();
    await recordExtensions(root, ENV, [{ id: 'a.b' }], [{ id: 'old.default' }], 1);
    expect(await recordExtensions(root, ENV, undefined, [{ id: 'new.default' }], 2)).toEqual([{ id: 'a.b' }, { id: 'new.default' }]);
    expect(await readExtensionRecords(root)).toEqual([{ at: 2, configuration: [{ id: 'a.b' }], defaults: [{ id: 'new.default' }] }]);
  });

  it('refuses an invalid environment ID and a link in place of its folder; the records skip junk files', async () => {
    const root = store();
    await expect(recordExtensions(root, '../x', [], [], 1)).rejects.toThrow('invalid');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-elsewhere-'));
    temps.push(elsewhere);
    fs.symlinkSync(elsewhere, path.join(root, 'extensions'));
    await expect(recordExtensions(root, ENV, [], [], 1)).rejects.toThrow('is not a folder');
    expect(fs.readdirSync(elsewhere)).toEqual([]);

    const other = store();
    const wanted = path.join(other, 'extensions', 'wanted');
    fs.mkdirSync(wanted, { recursive: true });
    fs.writeFileSync(path.join(wanted, 'junk.txt'), '{}');
    fs.writeFileSync(path.join(wanted, `${ENV}.json`), 'not json');
    fs.symlinkSync(path.join(wanted, `${ENV}.json`), path.join(wanted, 'b1b2c3d4e5.json'));
    expect(await readExtensionRecords(other)).toEqual([]);
  });

  it('the failures of the monitor round-trip through extensions/failures.json', async () => {
    const root = store();
    expect(await readExtensionFailures(root)).toBe('');
    await writeExtensionFailures(root, new Map([['a.b', 5]]));
    expect(JSON.parse(await readExtensionFailures(root))).toEqual({ 'a.b': 5 });
  });
});

describe('the cached files (plan step 11H3)', () => {
  it('lists the plain files of each folder, never links or folders', async () => {
    const root = store();
    const universal = path.join(root, 'extensions', 'universal');
    fs.mkdirSync(universal, { recursive: true });
    fs.writeFileSync(path.join(universal, 'a.b-1.0.0'), '');
    fs.symlinkSync('/etc/passwd', path.join(universal, 'c.d-1.0.0'));
    fs.mkdirSync(path.join(universal, 'e.f-1.0.0'));
    expect(await cachedExtensionFiles(root)).toEqual({ universal: ['a.b-1.0.0'], 'linux-x64': [], 'linux-arm64': [] });
  });
});

describe('the download of one .vsix (plan step 11H3)', () => {
  it('a file that is there: present, no lock, no network', async () => {
    const root = store();
    fs.mkdirSync(path.join(root, 'extensions', 'universal'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', 'universal', CHOSEN.cacheName), VSIX);
    const t = transport({});
    let locked = 0;
    const lock = async () => {
      locked++;
      return () => undefined;
    };
    expect(await ensureExtension({ root, transport: t, lock }, CHOSEN, new AbortController().signal)).toBe('present');
    expect(locked).toBe(0);
    expect(t.urls).toEqual([]);
  });

  it('downloads under the lock of its file into a temporary file, removes its own leftovers only, and renames it into place', async () => {
    const root = store();
    const temp = path.join(root, 'extensions', 'tmp');
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(temp, `${CHOSEN.cacheName}-0123456789ab`), 'leftover');
    fs.writeFileSync(path.join(temp, 'other.ext-1.0.0-0123456789ab'), 'another download');
    const t = transport({ [CHOSEN.vsix]: () => ({ status: 200, headers: {}, body: Readable.from([VSIX]) }) });
    const l = recordingLock(root);
    expect(await ensureExtension({ root, transport: t, lock: l.lock }, CHOSEN, new AbortController().signal)).toBe('downloaded');
    expect(l.taken.map((entry) => entry.name)).toEqual([CHOSEN.cacheName]);
    const file = path.join(root, 'extensions', 'universal', CHOSEN.cacheName);
    expect(fs.readFileSync(file)).toEqual(VSIX);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(root, 'extensions', 'universal')).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(temp)).toEqual(['other.ext-1.0.0-0123456789ab']);
  });

  it('checks again under the lock: a file that another download finished is present', async () => {
    const root = store();
    const t = transport({});
    const lock = async () => {
      fs.mkdirSync(path.join(root, 'extensions', 'universal'), { recursive: true });
      fs.writeFileSync(path.join(root, 'extensions', 'universal', CHOSEN.cacheName), VSIX);
      return () => undefined;
    };
    expect(await ensureExtension({ root, transport: t, lock }, CHOSEN, new AbortController().signal)).toBe('present');
    expect(t.urls).toEqual([]);
  });

  it.each([
    ['a body that is no ZIP', { [CHOSEN.vsix]: () => ({ status: 200, headers: {}, body: Readable.from([Buffer.from('<html>')]) }) }, 'no VSIX'],
    ['a larger body than the cap', { [CHOSEN.vsix]: () => ({ status: 200, headers: {}, body: Readable.from([Buffer.alloc(64, 0x50)]) }) }, 'larger than 32 bytes'],
    ['a redirect to http', { [CHOSEN.vsix]: () => ({ status: 302, headers: { location: 'http://cdn.example/plain.vsix' }, body: Readable.from([]) }) }, 'not https'],
    ['an HTTP error', { [CHOSEN.vsix]: () => ({ status: 503, headers: {}, body: Readable.from([]) }) }, 'HTTP 503'],
  ])('%s: rejects, and leaves nothing behind', async (_what, answers, reason) => {
    const root = store();
    const t = transport(answers as Record<string, () => HttpStreamResponse>);
    await expect(ensureExtension({ root, transport: t, lock: async () => () => undefined, maxBytes: 32 }, CHOSEN, new AbortController().signal)).rejects.toThrow(reason);
    expect(fs.readdirSync(path.join(root, 'extensions', 'tmp'))).toEqual([]);
    expect(fs.existsSync(path.join(root, 'extensions', 'universal', CHOSEN.cacheName))).toBe(false);
  });

  it('the lock file of a file of the cache is locks/extension-<cache name>.lock, taken with flock (never removed)', async () => {
    const root = store();
    const file = extensionLockFile(root, CHOSEN.cacheName);
    expect(file).toBe(path.join(root, 'locks', `extension-${CHOSEN.cacheName}.lock`));
    const release = await storeLock(root, CHOSEN.cacheName, 5, new AbortController().signal, undefined, file);
    expect(await storeTryLock(root, CHOSEN.cacheName, undefined, file)).toEqual({ kind: 'busy' });
    // The lock of the server version of the same name is another file.
    const server = await storeTryLock(root, CHOSEN.cacheName);
    expect(server.kind).toBe('locked');
    if (server.kind === 'locked') server.release();
    release();
    const again = await storeTryLock(root, CHOSEN.cacheName, undefined, file);
    expect(again.kind).toBe('locked');
    if (again.kind === 'locked') again.release();
    expect(fs.existsSync(file)).toBe(true);
  });
});
