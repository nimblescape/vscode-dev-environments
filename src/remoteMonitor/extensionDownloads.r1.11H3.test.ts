// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3: the part "extensions" of the monitor's background run and its cleanup, with a store and a
// volume of the monitor in temporary folders (separate here), a fake Marketplace and fake downloads. A-L5/B-D4: the lists
// are read from the monitor's volume, never from the store. A-L7: all versions are asked for in queries of at most 5 IDs;
// a failed one fails only its entries. A-L8: an entry without a compatible newest release is asked again for all its
// versions. A-L4: a run downloads a bounded total; the cleanup removes the files of IDs that no list names. A-L3/B-D1: the
// run records its choices, and the cleanup keeps them.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '../core/http';
import { MARKETPLACE_FLAGS, MARKETPLACE_LATEST_ONLY_FLAG, formatExtensionRecord, type ExtensionRecord } from '../core/vscodeExtensions';
import type { StoreLockAttempt } from '../core/worker/vscodeServerStore';
import { MAX_EXTENSION_BYTES_PER_RUN, cleanupExtensions, downloadExtensions, type ExtensionRunDeps } from './extensionDownloads';

const DAY = 24 * 60 * 60_000;
const NOW = 400 * DAY;
const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip')]);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devenv-ext-r1-${name}-`));
  temps.push(dir);
  return dir;
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

function record(state: string, id: string, value: ExtensionRecord): void {
  const wanted = path.join(state, 'extensions', 'wanted');
  fs.mkdirSync(wanted, { recursive: true });
  fs.writeFileSync(path.join(wanted, `${id}.json`), formatExtensionRecord(value));
}

function cachedFile(root: string, folderName: string, name: string): string {
  const file = path.join(root, 'extensions', folderName, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, VSIX);
  return file;
}

type Version = { version: string; engine?: string; pre?: boolean };
function answer(extensions: Record<string, Version[]>): string {
  return JSON.stringify({
    results: [
      {
        extensions: Object.entries(extensions).map(([id, versions]) => ({
          publisher: { publisherName: id.split('.')[0] },
          extensionName: id.split('.')[1],
          versions: versions.map((v) => ({
            version: v.version,
            properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: v.engine ?? '^1.90.0' }, ...(v.pre === true ? [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }] : [])],
            files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: `https://cdn.gallerycdn.vsassets.io/${id}-${v.version}.vsix` }],
          })),
        })),
      },
    ],
  });
}

function fake(root: string, state: string, respond: (ids: string[], latestOnly: boolean) => HttpResponse, extra: Partial<ExtensionRunDeps> = {}) {
  const queries: Array<{ ids: string[]; latestOnly: boolean }> = [];
  const downloads: string[] = [];
  const logs: string[] = [];
  const deps: ExtensionRunDeps = {
    root,
    stateDir: state,
    transport: {
      request: async (request: HttpRequest) => {
        const body = JSON.parse(request.body ?? '{}') as { filters: Array<{ criteria: Array<{ filterType: number; value: string }> }>; flags: number };
        const ids = body.filters[0].criteria.filter((c) => c.filterType === 7).map((c) => c.value);
        const latestOnly = body.flags === (MARKETPLACE_FLAGS | MARKETPLACE_LATEST_ONLY_FLAG);
        expect(body.flags === MARKETPLACE_FLAGS || latestOnly).toBe(true);
        queries.push({ ids, latestOnly });
        return respond(ids, latestOnly);
      },
      stream: async (url: string) => {
        downloads.push(url);
        return { status: 200, headers: {}, body: Readable.from([VSIX]) };
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

const ok = (body: string): HttpResponse => ({ status: 200, headers: {}, body });

describe('the lists are in the volume of the monitor (review round 1 of 11H3, A-L5/B-D4)', () => {
  it('reads the records and writes the failures and the choices there; the store holds none of them', async () => {
    const { root, state } = prepared([{ id: 'a.b' }, { id: 'gone.ext' }]);
    // A record in the store (where 11H3 kept them first) is not read.
    record(root, 'bbbbbbbbbb', { at: NOW, configuration: [{ id: 'store.only' }], defaults: [] });
    const f = fake(root, state, () => ok(answer({ 'a.b': [{ version: '1.0.0' }] })));
    await downloadExtensions(f.deps);
    expect(f.queries.map((q) => q.ids)).toEqual([['a.b', 'gone.ext']]);
    expect(JSON.parse(fs.readFileSync(path.join(state, 'extensions', 'failures.json'), 'utf8'))).toEqual({ 'gone.ext': NOW });
    expect(JSON.parse(fs.readFileSync(path.join(state, 'extensions', 'chosen.json'), 'utf8'))).toEqual({ 'a.b': 'universal/a.b-1.0.0' });
    expect(fs.statSync(path.join(state, 'extensions')).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.join(root, 'extensions')).sort()).toEqual(['tmp', 'universal', 'wanted']);
    expect(fs.existsSync(path.join(root, 'extensions', 'failures.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'extensions', 'universal', 'a.b-1.0.0'))).toBe(true);
  });
});

describe('the queries for all versions (review round 1 of 11H3, A-L7 and A-L8)', () => {
  it('the pinned entries in queries of at most 5 IDs; a failed query fails only its entries, which wait a day', async () => {
    const pins = Array.from({ length: 12 }, (_, index) => ({ id: `p.e${String(index).padStart(2, '0')}`, version: '1.0.0' }));
    const { root, state } = prepared(pins);
    const f = fake(root, state, (ids) =>
      ids.includes('p.e05') ? { status: 200, headers: {}, body: 'x'.repeat(10) } : ok(answer(Object.fromEntries(ids.map((id) => [id, [{ version: '1.0.0' }, { version: '2.0.0' }]])))),
    );
    await downloadExtensions(f.deps);
    expect(f.queries).toEqual([
      { ids: ['p.e00', 'p.e01', 'p.e02', 'p.e03', 'p.e04'], latestOnly: false },
      { ids: ['p.e05', 'p.e06', 'p.e07', 'p.e08', 'p.e09'], latestOnly: false },
      { ids: ['p.e10', 'p.e11'], latestOnly: false },
    ]);
    expect(f.downloads).toHaveLength(7);
    expect(f.logs).toContain('The Marketplace could not be asked for 5 extension(s): the Marketplace answered no list of extensions');
    expect(f.logs).toContain('The extension p.e05@1.0.0 is not in the shared extension cache (its query failed: the Marketplace answered no list of extensions); it is tried again after a day.');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(state, 'extensions', 'failures.json'), 'utf8')) as object)).toEqual(['p.e05@1.0.0', 'p.e06@1.0.0', 'p.e07@1.0.0', 'p.e08@1.0.0', 'p.e09@1.0.0']);

    // Within the day only the others are asked for again (all present: no download).
    const g = fake(root, state, (ids) => ok(answer(Object.fromEntries(ids.map((id) => [id, [{ version: '1.0.0' }]])))));
    await downloadExtensions(g.deps);
    expect(g.queries.map((q) => q.ids)).toEqual([['p.e00', 'p.e01', 'p.e02', 'p.e03', 'p.e04'], ['p.e10', 'p.e11']]);
    expect(g.downloads).toEqual([]);
  });

  it('an entry whose newest versions have no compatible release is asked once more for all versions, and gets an older release', async () => {
    const { root, state } = prepared([{ id: 'new.vscode' }, { id: 'fine.ext' }, { id: 'none.fits' }]);
    const f = fake(root, state, (ids, latestOnly) =>
      ok(
        answer({
          ...(ids.includes('new.vscode') ? { 'new.vscode': latestOnly ? [{ version: '3.0.0', engine: '^1.106.0' }, { version: '3.1.0', pre: true }] : [{ version: '3.0.0', engine: '^1.106.0' }, { version: '2.9.0', engine: '^1.104.0' }, { version: '2.8.0' }] } : {}),
          ...(ids.includes('fine.ext') ? { 'fine.ext': [{ version: '1.0.0' }] } : {}),
          ...(ids.includes('none.fits') ? { 'none.fits': [{ version: '1.0.0', engine: '^2.0.0' }] } : {}),
        }),
      ),
    );
    await downloadExtensions(f.deps);
    expect(f.queries).toEqual([
      { ids: ['fine.ext', 'new.vscode', 'none.fits'], latestOnly: true },
      { ids: ['new.vscode', 'none.fits'], latestOnly: false },
    ]);
    expect(fs.readdirSync(path.join(root, 'extensions', 'universal')).sort()).toEqual(['fine.ext-1.0.0', 'new.vscode-2.9.0']);
    expect(f.logs).toContain('The extension none.fits is not in the shared extension cache (the Marketplace has no release for VS Code 1.105.0 on linux-x64); it is tried again after a day.');
  });

  it('at most 20 entries a run are asked again; the others fail as before', async () => {
    const ids = Array.from({ length: 23 }, (_, index) => `n.e${String(index).padStart(2, '0')}`);
    const { root, state } = prepared(ids.map((id) => ({ id })));
    const f = fake(root, state, (asked) => ok(answer(Object.fromEntries(asked.map((id) => [id, [{ version: '1.0.0', engine: '^1.200.0' }]])))));
    await downloadExtensions(f.deps);
    expect(f.queries.filter((q) => !q.latestOnly).flatMap((q) => q.ids)).toEqual(ids.slice(0, 20));
    expect(f.queries.filter((q) => !q.latestOnly).every((q) => q.ids.length <= 5)).toBe(true);
    expect(f.logs).toContain('The extensions for VS Code 1.105.0 (linux-x64): 23 wanted, 0 downloaded, 0 in the cache, 23 failed, 0 waiting for their retry.');
  });
});

describe('the bound of a run (review round 1 of 11H3, A-L4)', () => {
  it('no download starts once the run downloaded its bound; the rest comes with the next run', async () => {
    expect(MAX_EXTENSION_BYTES_PER_RUN).toBe(1024 * 1024 * 1024);
    const { root, state } = prepared([{ id: 'a.a' }, { id: 'b.b' }, { id: 'c.c' }, { id: 'd.d' }]);
    cachedFile(root, 'universal', 'd.d-1.0.0');
    const respond = (ids: string[]) => ok(answer(Object.fromEntries(ids.map((id) => [id, [{ version: '1.0.0' }]]))));
    const f = fake(root, state, respond, { maxRunBytes: 2 * VSIX.length });
    await downloadExtensions(f.deps);
    expect(f.downloads).toEqual(['https://cdn.gallerycdn.vsassets.io/a.a-1.0.0.vsix', 'https://cdn.gallerycdn.vsassets.io/b.b-1.0.0.vsix']);
    expect(f.logs).toContain(`This run downloaded ${2 * VSIX.length} bytes, its bound; 1 extension(s) are left for the next run.`);
    expect(f.logs).toContain('The extensions for VS Code 1.105.0 (linux-x64): 4 wanted, 2 downloaded, 1 in the cache, 0 failed, 0 waiting for their retry.');
    // Nothing failed: the next run takes the rest.
    expect(fs.existsSync(path.join(state, 'extensions', 'failures.json'))).toBe(false);
    const g = fake(root, state, respond, { maxRunBytes: 2 * VSIX.length });
    await downloadExtensions(g.deps);
    expect(g.downloads).toEqual(['https://cdn.gallerycdn.vsassets.io/c.c-1.0.0.vsix']);
  });
});

describe('the cleanup with the lists and the choices (review round 1 of 11H3, A-L3/B-D1 and A-L4)', () => {
  it('a pinned newer version and the release of the entry without a pin both stay, run after run', async () => {
    const { root, state } = prepared([{ id: 'ms-python.python', version: '2025.3.0' }]);
    record(state, 'bbbbbbbbbb', { at: NOW, configuration: [{ id: 'ms-python.python' }], defaults: [] });
    const respond = (_ids: string[], latestOnly: boolean) =>
      ok(answer({ 'ms-python.python': latestOnly ? [{ version: '2025.3.0', pre: true }, { version: '2025.2.0' }] : [{ version: '2025.3.0', pre: true }, { version: '2025.2.0' }, { version: '2025.1.0' }] }));
    const f = fake(root, state, respond);
    await downloadExtensions(f.deps);
    const universal = path.join(root, 'extensions', 'universal');
    expect(fs.readdirSync(universal).sort()).toEqual(['ms-python.python-2025.2.0', 'ms-python.python-2025.3.0']);
    cachedFile(root, 'universal', 'ms-python.python-2025.1.0');
    await cleanupExtensions(f.deps);
    expect(fs.readdirSync(universal).sort()).toEqual(['ms-python.python-2025.2.0', 'ms-python.python-2025.3.0']);
    const g = fake(root, state, respond);
    await downloadExtensions(g.deps);
    expect(g.downloads).toEqual([]);
  });

  it('every file of an ID that no list of the last 14 days names goes, its newest too; a list in the store does not count', async () => {
    const { root, state } = prepared([{ id: 'a.b' }]);
    record(root, 'bbbbbbbbbb', { at: NOW, configuration: [{ id: 'store.only' }], defaults: [] });
    const keep = cachedFile(root, 'universal', 'a.b-2.0.0');
    const gone = [cachedFile(root, 'universal', 'a.b-1.0.0'), cachedFile(root, 'universal', 'old.ext-9.0.0'), cachedFile(root, 'linux-x64', 'old.ext-9.0.0-linux-x64'), cachedFile(root, 'universal', 'store.only-1.0.0')];
    const f = fake(root, state, () => ok(answer({})));
    await cleanupExtensions(f.deps);
    expect(fs.existsSync(keep)).toBe(true);
    for (const file of gone) expect(fs.existsSync(file)).toBe(false);
  });

  it('a volume whose lists cannot be listed: nothing is removed', async () => {
    const root = folder('store');
    const state = folder('state');
    fs.mkdirSync(path.join(state, 'extensions'));
    fs.writeFileSync(path.join(state, 'extensions', 'wanted'), 'no folder');
    const file = cachedFile(root, 'universal', 'a.b-1.0.0');
    const f = fake(root, state, () => ok(answer({})));
    await cleanupExtensions(f.deps);
    expect(fs.existsSync(file)).toBe(true);
    expect(f.logs.some((line) => line.startsWith('The shared extension cache could not be cleaned up:'))).toBe(true);
  });
});
