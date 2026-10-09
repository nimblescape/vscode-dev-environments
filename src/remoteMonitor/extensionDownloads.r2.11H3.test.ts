// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11H3: the part "extensions" of the monitor's background run and its cleanup, with a store and a
// volume of the monitor in temporary folders (never the home folder or /state), a fake Marketplace and fake downloads.
// A-L1: the bound of a run counts the transferred bytes of every download, also of a failed one. A-L2/B R2-D2: a failed
// query of several IDs is asked again one ID at a time (bounded). A-L3/B R2-D3: the cleanup removes the old records and
// the leftover temporary files of the monitor's volume. A-L5: a record that cannot be read keeps the files of unnamed IDs.
// B R2-D1: a new choice is recorded only once its file is in the store.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '../core/http';
import { MARKETPLACE_ALL_VERSIONS_CHUNK, MAX_MARKETPLACE_SINGLE_QUERIES, RECORDED_LIST_MS, formatExtensionRecord, type ExtensionRecord } from '../core/vscodeExtensions';
import { readExtensionRecordFiles } from '../core/worker/vscodeExtensionStore';
import type { StoreLockAttempt } from '../core/worker/vscodeServerStore';
import { cleanupExtensions, downloadExtensions, type ExtensionRunDeps } from './extensionDownloads';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const NOW = 400 * DAY;
const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip')]);
const url = (id: string, version: string) => `https://cdn.gallerycdn.vsassets.io/${id}-${version}.vsix`;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devenv-ext-r2-${name}-`));
  temps.push(dir);
  return dir;
}

function setTime(file: string, at: number): void {
  fs.utimesSync(file, new Date(at), new Date(at));
}

function record(state: string, id: string, value: ExtensionRecord, mtime = value.at): string {
  const wanted = path.join(state, 'extensions', 'wanted');
  fs.mkdirSync(wanted, { recursive: true });
  const file = path.join(wanted, `${id}.json`);
  fs.writeFileSync(file, formatExtensionRecord(value));
  setTime(file, mtime);
  return file;
}

/** A store with a ready stable server 1.105.0, and a volume of the monitor with the list `configuration` of a day ago. */
function prepared(configuration: ExtensionRecord['configuration']): { root: string; state: string } {
  const root = folder('store');
  const state = folder('state');
  const server = path.join(root, 'server', 'stable', 'linux-x64', 'a'.repeat(40));
  fs.mkdirSync(path.join(server, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(server, 'bin', 'code-server'), '');
  fs.writeFileSync(path.join(server, 'node'), '');
  fs.writeFileSync(path.join(server, 'product.json'), JSON.stringify({ version: '1.105.0' }));
  record(state, 'aaaaaaaaaa', { at: NOW - DAY, configuration, defaults: [] });
  return { root, state };
}

function cachedFile(root: string, folderName: string, name: string): string {
  const file = path.join(root, 'extensions', folderName, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, VSIX);
  return file;
}

function answer(extensions: Record<string, string[]>): string {
  return JSON.stringify({
    results: [
      {
        extensions: Object.entries(extensions).map(([id, versions]) => ({
          publisher: { publisherName: id.split('.')[0] },
          extensionName: id.split('.')[1],
          versions: versions.map((version) => ({
            version,
            properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.90.0' }],
            files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: url(id, version) }],
          })),
        })),
      },
    ],
  });
}

const ok = (body: string): HttpResponse => ({ status: 200, headers: {}, body });
/** Every ID has the versions `versions`. */
const every = (versions: string[]) => (ids: string[]) => ok(answer(Object.fromEntries(ids.map((id) => [id, versions]))));

function fake(
  root: string,
  state: string,
  respond: (ids: string[]) => HttpResponse,
  extra: Partial<ExtensionRunDeps> = {},
  body: (url: string) => { status: number; data: Buffer } = () => ({ status: 200, data: VSIX }),
) {
  const queries: string[][] = [];
  const downloads: string[] = [];
  const logs: string[] = [];
  const deps: ExtensionRunDeps = {
    root,
    stateDir: state,
    transport: {
      request: async (request: HttpRequest) => {
        const parsed = JSON.parse(request.body ?? '{}') as { filters: Array<{ criteria: Array<{ filterType: number; value: string }> }> };
        const ids = parsed.filters[0].criteria.filter((c) => c.filterType === 7).map((c) => c.value);
        queries.push(ids);
        return respond(ids);
      },
      stream: async (target: string) => {
        downloads.push(target);
        const { status, data } = body(target);
        return { status, headers: {}, body: Readable.from([data]) };
      },
    },
    architecture: async () => 'x86_64',
    lock: async () => () => undefined,
    tryLock: async (): Promise<StoreLockAttempt> => ({ kind: 'locked', release: () => undefined }),
    log: (message) => logs.push(message),
    now: () => NOW,
    ...extra,
  };
  return { deps, queries, downloads, logs };
}

function chosenOf(state: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(state, 'extensions', 'chosen.json'), 'utf8'));
}

describe('the bound of a run counts every transferred byte (review round 2 of 11H3, A-L1)', () => {
  it('a download that fails after its transfer counts; no further download starts after the bound', async () => {
    const { root, state } = prepared([{ id: 'a.a' }, { id: 'b.b' }, { id: 'c.c' }]);
    const notZip = Buffer.from('this is not a zip archive');
    const f = fake(root, state, every(['1.0.0']), { maxRunBytes: 10 }, (target) => ({ status: 200, data: target === url('a.a', '1.0.0') ? notZip : VSIX }));
    await downloadExtensions(f.deps);
    expect(f.downloads).toEqual([url('a.a', '1.0.0')]);
    expect(f.logs).toContain('The extension a.a is not in the shared extension cache (the download is no VSIX (ZIP) file); it is tried again after a day.');
    expect(f.logs).toContain(`This run downloaded ${notZip.length} bytes, its bound; 2 extension(s) are left for the next run.`);
  });
});

describe('a failed query of several IDs is asked again one ID at a time (review round 2 of 11H3, A-L2, B R2-D2)', () => {
  it('one ID whose query always fails fails alone; its neighbours are downloaded', async () => {
    const pins = ['a.a', 'a.b', 'a.big', 'a.c', 'a.d'].map((id) => ({ id, version: '1.0.0' }));
    const { root, state } = prepared(pins);
    const f = fake(root, state, (ids) => (ids.includes('a.big') ? { status: 200, headers: {}, body: 'x' } : every(['1.0.0'])(ids)));
    await downloadExtensions(f.deps);
    expect(f.queries).toEqual([['a.a', 'a.b', 'a.big', 'a.c', 'a.d'], ['a.a'], ['a.b'], ['a.big'], ['a.c'], ['a.d']]);
    expect(f.downloads.sort()).toEqual(['a.a', 'a.b', 'a.c', 'a.d'].map((id) => url(id, '1.0.0')));
    expect(f.logs).toContain('The extension a.big@1.0.0 is not in the shared extension cache (its query failed: the Marketplace answered no list of extensions); it is tried again after a day.');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(state, 'extensions', 'failures.json'), 'utf8')) as object)).toEqual(['a.big@1.0.0']);
  });

  it('at most MAX_MARKETPLACE_SINGLE_QUERIES such queries a run; the rest fail with the query of their chunk', async () => {
    const count = MARKETPLACE_ALL_VERSIONS_CHUNK * 6;
    const pins = Array.from({ length: count }, (_, index) => ({ id: `p.e${String(index).padStart(2, '0')}`, version: '1.0.0' }));
    const { root, state } = prepared(pins);
    const f = fake(root, state, () => ({ status: 503, headers: {}, body: '' }));
    await downloadExtensions(f.deps);
    expect(f.queries.filter((ids) => ids.length > 1)).toHaveLength(6);
    expect(f.queries.filter((ids) => ids.length === 1)).toHaveLength(MAX_MARKETPLACE_SINGLE_QUERIES);
    expect(f.logs.filter((line) => line.includes('(its query failed: the Marketplace answered HTTP 503)'))).toHaveLength(count);
    expect(f.downloads).toEqual([]);
  });
});

describe('a new choice is recorded once its file is in the store (review round 2 of 11H3, B R2-D1)', () => {
  it('a failed download keeps the earlier choice; the next successful run records the new one', async () => {
    const { root, state } = prepared([{ id: 'a.b' }]);
    cachedFile(root, 'universal', 'a.b-1.0.0');
    fs.writeFileSync(path.join(state, 'extensions', 'chosen.json'), JSON.stringify({ 'a.b': 'universal/a.b-1.0.0' }));
    const f = fake(root, state, every(['2.0.0']), {}, () => ({ status: 500, data: Buffer.alloc(0) }));
    await downloadExtensions(f.deps);
    expect(f.downloads).toEqual([url('a.b', '2.0.0')]);
    expect(chosenOf(state)).toEqual({ 'a.b': 'universal/a.b-1.0.0' });

    // A day later the download works.
    const g = fake(root, state, every(['2.0.0']), { now: () => NOW + DAY + 1 });
    record(state, 'aaaaaaaaaa', { at: NOW + DAY, configuration: [{ id: 'a.b' }], defaults: [] });
    await downloadExtensions(g.deps);
    expect(g.downloads).toEqual([url('a.b', '2.0.0')]);
    expect(chosenOf(state)).toEqual({ 'a.b': 'universal/a.b-2.0.0' });
  });

  it('a download deferred by the bound keeps the earlier choice; a file present after the bound is recorded', async () => {
    const { root, state } = prepared([{ id: 'a.a' }, { id: 'b.b' }, { id: 'c.c' }]);
    cachedFile(root, 'universal', 'b.b-1.0.0');
    cachedFile(root, 'universal', 'c.c-2.0.0');
    fs.writeFileSync(path.join(state, 'extensions', 'chosen.json'), JSON.stringify({ 'b.b': 'universal/b.b-1.0.0' }));
    const f = fake(root, state, every(['2.0.0']), { maxRunBytes: 1 });
    await downloadExtensions(f.deps);
    expect(f.downloads).toEqual([url('a.a', '2.0.0')]);
    expect(chosenOf(state)).toEqual({ 'a.a': 'universal/a.a-2.0.0', 'b.b': 'universal/b.b-1.0.0', 'c.c': 'universal/c.c-2.0.0' });
  });
});

describe('the cleanup of the monitor volume (review round 2 of 11H3, A-L3, B R2-D3)', () => {
  it('removes the records older than 14 days and the temporary files older than an hour; nothing else', async () => {
    const root = folder('store');
    const state = folder('state');
    const base = path.join(state, 'extensions');
    const recent = record(state, 'aaaaaaaaaa', { at: NOW - DAY, configuration: [{ id: 'a.b' }], defaults: [] });
    const old = record(state, 'bbbbbbbbbb', { at: NOW - RECORDED_LIST_MS - DAY, configuration: [{ id: 'c.d' }], defaults: [] });
    // An old time in a file that was written just now (a worker renamed it into place meanwhile): it stays.
    const rewritten = record(state, 'cccccccccc', { at: NOW - RECORDED_LIST_MS - DAY, configuration: [], defaults: [] }, NOW - HOUR);
    // A recent time in a file with an old modification time: it still counts, so it stays.
    const touched = record(state, 'dddddddddd', { at: NOW - DAY, configuration: [], defaults: [] }, NOW - RECORDED_LIST_MS - DAY);
    const invalidOld = path.join(base, 'wanted', 'eeeeeeeeee.json');
    fs.writeFileSync(invalidOld, 'not a record');
    setTime(invalidOld, NOW - RECORDED_LIST_MS - DAY);
    const temporary = (dir: string, name: string, at: number) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, '{}');
      setTime(file, at);
      return file;
    };
    const oldTemp = temporary(base, '.chosen.json.0123456789ab.tmp', NOW - 2 * HOUR);
    const oldWantedTemp = temporary(path.join(base, 'wanted'), '.aaaaaaaaaa.json.0123456789ab.tmp', NOW - 2 * HOUR);
    const youngTemp = temporary(path.join(base, 'wanted'), '.bbbbbbbbbb.json.ba9876543210.tmp', NOW - 10 * 60_000);
    const otherName = temporary(base, '.chosen.json.tmp', NOW - 2 * HOUR);
    const failures = temporary(base, 'failures.json', NOW - RECORDED_LIST_MS - DAY);
    const linked = path.join(base, '.failures.json.0123456789ab.tmp');
    fs.symlinkSync(failures, linked);
    const logs: string[] = [];
    await cleanupExtensions({ ...fake(root, state, every(['1.0.0'])).deps, log: (message) => logs.push(message) });
    for (const gone of [old, invalidOld, oldTemp, oldWantedTemp]) expect(fs.existsSync(gone), gone).toBe(false);
    for (const kept of [recent, rewritten, touched, youngTemp, otherName, failures]) expect(fs.existsSync(kept), kept).toBe(true);
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(logs).toContain(
      "Removed 4 old extension list(s) and leftover temporary file(s) from the monitor's volume: .chosen.json.0123456789ab.tmp, wanted/.aaaaaaaaaa.json.0123456789ab.tmp, wanted/bbbbbbbbbb.json, wanted/eeeeeeeeee.json.",
    );
  });
});

describe('a record that cannot be read keeps the files of unnamed IDs (review round 2 of 11H3, A-L5)', () => {
  it('one line, and only the rule of the newest, pinned and chosen files for that cleanup', async () => {
    const root = folder('store');
    const state = folder('state');
    record(state, 'aaaaaaaaaa', { at: NOW - DAY, configuration: [{ id: 'a.b' }], defaults: [] });
    const broken = path.join(state, 'extensions', 'wanted', 'bbbbbbbbbb.json');
    fs.writeFileSync(broken, '{ "at": ');
    const unnamed = cachedFile(root, 'universal', 'x.y-1.0.0');
    const older = cachedFile(root, 'universal', 'a.b-1.0.0');
    cachedFile(root, 'universal', 'a.b-2.0.0');
    const f = fake(root, state, every(['1.0.0']));
    await cleanupExtensions(f.deps);
    expect(f.logs).toContain('The extension list(s) bbbbbbbbbb.json could not be read; this cleanup keeps the extension files of the IDs that no list names.');
    expect(fs.existsSync(unnamed)).toBe(true);
    expect(fs.existsSync(older)).toBe(false);

    // Once the record is valid again, the files of the IDs that no list names go.
    fs.writeFileSync(broken, formatExtensionRecord({ at: NOW - DAY, configuration: [], defaults: [] }));
    const g = fake(root, state, every(['1.0.0']));
    await cleanupExtensions(g.deps);
    expect(g.logs.some((line) => line.startsWith('The extension list(s) '))).toBe(false);
    expect(fs.existsSync(unnamed)).toBe(false);
  });

  it('readExtensionRecordFiles names the present files that are no valid record (also a link); a valid one is read', async () => {
    const state = folder('state');
    record(state, 'aaaaaaaaaa', { at: NOW, configuration: [{ id: 'a.b' }], defaults: [] });
    const wanted = path.join(state, 'extensions', 'wanted');
    fs.writeFileSync(path.join(wanted, 'bbbbbbbbbb.json'), '[]');
    fs.writeFileSync(path.join(wanted, 'cccccccccc.json'), 'x'.repeat(1024 * 1024));
    fs.symlinkSync(path.join(wanted, 'aaaaaaaaaa.json'), path.join(wanted, 'dddddddddd.json'));
    fs.writeFileSync(path.join(wanted, 'Not An ID.json'), 'x');
    const { records, unreadable } = await readExtensionRecordFiles(state);
    expect(records).toEqual([{ at: NOW, configuration: [{ id: 'a.b' }], defaults: [] }]);
    expect(unreadable).toEqual(['bbbbbbbbbb.json', 'cccccccccc.json', 'dddddddddd.json']);
  });
});
