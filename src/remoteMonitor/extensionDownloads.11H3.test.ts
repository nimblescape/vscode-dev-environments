// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; the user: "the monitor shall do ... extension downloads in the background"):
// the part "extensions" of the Session Monitor's background run with a store in a temporary folder, a fake Marketplace
// and fake downloads: the union of the lists recorded in the last 14 days, one query for the entries without a pin and
// one for the pinned ones, the compatibility with the newest stable server of the store, the downloads of what is new,
// each failure on its own and retried after a day; and its share of the daily cleanup (the choice, the lock without a
// wait, the leftovers of downloads, lock files never removed).
// Review round 1 of 11H3 (A-L6): the `.vsix` URLs of these tests are on a host of the Marketplace's CDN
// (`cdn.gallerycdn.vsassets.io`, was `cdn.example`), as a VSIX URL on any other host is now refused; nothing else changed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpStreamResponse } from '../core/http';
import { MARKETPLACE_QUERY_URL, RECORDED_LIST_MS, formatExtensionRecord, type ExtensionRecord } from '../core/vscodeExtensions';
import type { StoreLockAttempt } from '../core/worker/vscodeServerStore';
import { BackgroundRun, type VscodeBackgroundDeps } from './background';
import { cleanupExtensions, downloadExtensions, newestStableServerVersion, type ExtensionRunDeps } from './extensionDownloads';

const NOW = 400 * 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip')]);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function store(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-run-'));
  temps.push(root);
  return root;
}

/** A ready stable server of `version` in the store. */
function server(root: string, commit: string, version: string, platform = 'linux-x64'): void {
  const folder = path.join(root, 'server', 'stable', platform, commit);
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '');
  fs.writeFileSync(path.join(folder, 'node'), '');
  fs.writeFileSync(path.join(folder, 'product.json'), JSON.stringify({ version, commit }));
}

function record(root: string, id: string, value: ExtensionRecord): void {
  const folder = path.join(root, 'extensions', 'wanted');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.json`), formatExtensionRecord(value));
}

function cachedFile(root: string, folder: string, name: string): string {
  const file = path.join(root, 'extensions', folder, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, VSIX);
  return file;
}

/** An answer of the Marketplace with these extensions: `{ "<publisher>.<name>": [versions…] }`. */
function answer(extensions: Record<string, Array<Record<string, unknown>>>): string {
  return JSON.stringify({
    results: [
      {
        extensions: Object.entries(extensions).map(([id, versions]) => ({
          publisher: { publisherName: id.split('.')[0] },
          extensionName: id.split('.')[1],
          versions,
        })),
      },
    ],
  });
}

function version(number: string, extra: { engine?: string; pre?: boolean; targetPlatform?: string; url?: string } = {}): Record<string, unknown> {
  return {
    version: number,
    ...(extra.targetPlatform !== undefined ? { targetPlatform: extra.targetPlatform } : {}),
    properties: [
      { key: 'Microsoft.VisualStudio.Code.Engine', value: extra.engine ?? '^1.90.0' },
      ...(extra.pre === true ? [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }] : []),
    ],
    files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: extra.url ?? `https://cdn.gallerycdn.vsassets.io/${number}${extra.targetPlatform ?? ''}.vsix` }],
  };
}

interface Fake {
  deps: ExtensionRunDeps;
  queries: Array<{ ids: string[]; flags: number }>;
  downloads: string[];
  locks: string[];
  logs: string[];
}

function fake(root: string, options: { answer?: (ids: string[]) => HttpResponse; download?: (url: string) => HttpStreamResponse; busy?: string[]; now?: number } = {}): Fake {
  const queries: Fake['queries'] = [];
  const downloads: string[] = [];
  const locks: string[] = [];
  const logs: string[] = [];
  const deps: ExtensionRunDeps = {
    root,
    // Review round 1 of 11H3 (A-L5, B-D4): the lists, the failures and the chosen files are in the volume of the monitor;
    // here the same temporary folder as the store (the layout below it, `extensions/wanted` and
    // `extensions/failures.json`, is the same).
    stateDir: root,
    transport: {
      request: async (request: HttpRequest) => {
        expect(request).toMatchObject({ method: 'POST', url: MARKETPLACE_QUERY_URL });
        const body = JSON.parse(request.body ?? '{}') as { filters: Array<{ criteria: Array<{ filterType: number; value: string }> }>; flags: number };
        const ids = body.filters[0].criteria.filter((c) => c.filterType === 7).map((c) => c.value);
        queries.push({ ids, flags: body.flags });
        return options.answer?.(ids) ?? { status: 200, headers: {}, body: answer({}) };
      },
      stream: async (url: string) => {
        downloads.push(url);
        return options.download?.(url) ?? { status: 200, headers: {}, body: Readable.from([VSIX]) };
      },
    },
    architecture: async () => 'x86_64',
    lock: async (name) => {
      locks.push(name);
      return () => undefined;
    },
    tryLock: async (name): Promise<StoreLockAttempt> => {
      locks.push(`try ${name}`);
      return options.busy?.includes(name) ? { kind: 'busy' } : { kind: 'locked', release: () => undefined };
    },
    log: (message) => logs.push(message),
    now: () => options.now ?? NOW,
  };
  return { deps, queries, downloads, locks, logs };
}

describe('the part "extensions" of the background run (plan step 11H3)', () => {
  it('the version of the newest stable server of the store is the VS Code of the compatibility', async () => {
    const root = store();
    expect(await newestStableServerVersion(root, 'linux-x64')).toBeUndefined();
    server(root, 'a'.repeat(40), '1.104.2');
    server(root, 'b'.repeat(40), '1.105.0');
    // Compared by its numbers, not as text, whatever the order of the folders.
    server(root, 'e'.repeat(40), '1.99.0');
    server(root, 'c'.repeat(40), '1.200.0', 'linux-arm64');
    fs.mkdirSync(path.join(root, 'server', 'stable', 'linux-x64', 'd'.repeat(40)));
    expect(await newestStableServerVersion(root, 'linux-x64')).toBe('1.105.0');
  });

  it('downloads the newest compatible release of each entry of the lists of the last 14 days, a pin as written', async () => {
    const root = store();
    server(root, 'a'.repeat(40), '1.105.0');
    record(root, 'aaaaaaaaaa', { at: NOW - DAY, configuration: [{ id: 'redhat.vscode-yaml' }, { id: 'pin.ned', version: '1.0.0' }], defaults: [{ id: 'rust.ra' }] });
    record(root, 'bbbbbbbbbb', { at: NOW - RECORDED_LIST_MS, configuration: [{ id: 'old.only' }], defaults: [] });
    const f = fake(root, {
      answer: (ids) => ({
        status: 200,
        headers: {},
        body: ids.includes('pin.ned')
          ? answer({ 'pin.ned': [version('2.0.0'), version('1.0.0', { pre: true, engine: '^9.0.0' })] })
          : answer({
              'redhat.vscode-yaml': [version('1.25.0', { pre: true }), version('1.24.0')],
              'rust.ra': [version('0.4.0', { engine: '^1.106.0', targetPlatform: 'linux-x64' }), version('0.3.0', { targetPlatform: 'linux-x64' }), version('0.3.0', { targetPlatform: 'linux-arm64' })],
            }),
      }),
    });
    await downloadExtensions(f.deps);
    expect(f.queries).toEqual([
      { ids: ['redhat.vscode-yaml', 'rust.ra'], flags: 0x1 | 0x2 | 0x10 | 0x80 | 0x10000 },
      { ids: ['pin.ned'], flags: 0x1 | 0x2 | 0x10 | 0x80 },
    ]);
    expect(f.downloads).toEqual(['https://cdn.gallerycdn.vsassets.io/1.24.0.vsix', 'https://cdn.gallerycdn.vsassets.io/0.3.0linux-x64.vsix', 'https://cdn.gallerycdn.vsassets.io/1.0.0.vsix']);
    expect(fs.readdirSync(path.join(root, 'extensions', 'universal')).sort()).toEqual(['pin.ned-1.0.0', 'redhat.vscode-yaml-1.24.0']);
    expect(fs.readdirSync(path.join(root, 'extensions', 'linux-x64'))).toEqual(['rust.ra-0.3.0-linux-x64']);
    expect(f.locks).toEqual(['redhat.vscode-yaml-1.24.0', 'rust.ra-0.3.0-linux-x64', 'pin.ned-1.0.0']);
    expect(f.logs).toContain('The extensions for VS Code 1.105.0 (linux-x64): 3 wanted, 3 downloaded, 0 in the cache, 0 failed, 0 waiting for their retry.');

    // The next run: everything is there; the queries run, nothing is downloaded.
    const g = fake(root, { answer: (ids) => ({ status: 200, headers: {}, body: ids.includes('pin.ned') ? answer({ 'pin.ned': [version('1.0.0')] }) : answer({ 'redhat.vscode-yaml': [version('1.24.0')], 'rust.ra': [version('0.3.0', { targetPlatform: 'linux-x64' })] }) }) });
    await downloadExtensions(g.deps);
    expect(g.downloads).toEqual([]);
    expect(g.locks).toEqual([]);
  });

  it('a failed entry is one line and waits a day; the others go on', async () => {
    const root = store();
    server(root, 'a'.repeat(40), '1.105.0');
    record(root, 'aaaaaaaaaa', { at: NOW, configuration: [{ id: 'gone.ext' }, { id: 'new.ext' }, { id: 'bad.download' }, { id: 'good.ext' }], defaults: [] });
    const body = answer({ 'new.ext': [version('2.0.0', { engine: '^1.200.0' })], 'bad.download': [version('1.0.0', { url: 'https://cdn.gallerycdn.vsassets.io/bad.vsix' })], 'good.ext': [version('1.0.0', { url: 'https://cdn.gallerycdn.vsassets.io/good.vsix' })] });
    const download = (url: string): HttpStreamResponse => (url.endsWith('bad.vsix') ? { status: 500, headers: {}, body: Readable.from([]) } : { status: 200, headers: {}, body: Readable.from([VSIX]) });
    const f = fake(root, { answer: () => ({ status: 200, headers: {}, body }), download });
    await downloadExtensions(f.deps);
    expect(f.logs).toEqual(
      expect.arrayContaining([
        'The extension gone.ext is not in the shared extension cache (the Marketplace does not have it); it is tried again after a day.',
        'The extension new.ext is not in the shared extension cache (the Marketplace has no release for VS Code 1.105.0 on linux-x64); it is tried again after a day.',
        'The extension bad.download is not in the shared extension cache (the download answered HTTP 500); it is tried again after a day.',
        'The extensions for VS Code 1.105.0 (linux-x64): 4 wanted, 1 downloaded, 0 in the cache, 3 failed, 0 waiting for their retry.',
      ]),
    );
    expect(fs.existsSync(path.join(root, 'extensions', 'universal', 'good.ext-1.0.0'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'failures.json'), 'utf8'))).toEqual({ 'bad.download': NOW, 'gone.ext': NOW, 'new.ext': NOW });

    // Within the day: only good.ext is asked for.
    const g = fake(root, { now: NOW + DAY - 1, answer: () => ({ status: 200, headers: {}, body }) });
    await downloadExtensions(g.deps);
    expect(g.queries.map((q) => q.ids)).toEqual([['good.ext']]);
    expect(g.logs).toContain('The extensions for VS Code 1.105.0 (linux-x64): 4 wanted, 0 downloaded, 1 in the cache, 0 failed, 3 waiting for their retry.');
    // After the day: all of them again; a success clears its failure.
    const h = fake(root, { now: NOW + DAY, answer: () => ({ status: 200, headers: {}, body }) });
    await downloadExtensions(h.deps);
    // Review round 1 of 11H3 (A-L8): changed expectation, new.ext (no compatible release among the newest versions) is
    // asked once more for all its versions.
    expect(h.queries.map((q) => q.ids)).toEqual([['bad.download', 'gone.ext', 'good.ext', 'new.ext'], ['new.ext']]);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'failures.json'), 'utf8')) as object).sort()).toEqual(['gone.ext', 'new.ext']);
  });

  it('a failed query is one line and records no failure (the next run asks again)', async () => {
    const root = store();
    server(root, 'a'.repeat(40), '1.105.0');
    record(root, 'aaaaaaaaaa', { at: NOW, configuration: [{ id: 'a.b' }], defaults: [] });
    for (const response of [{ status: 503, headers: {}, body: '' }, { status: 200, headers: {}, body: '<html>' }]) {
      const f = fake(root, { answer: () => response });
      await downloadExtensions(f.deps);
      expect(f.logs.some((line) => line.startsWith('The Marketplace could not be asked for 1 extension(s): the Marketplace answered'))).toBe(true);
      expect(f.downloads).toEqual([]);
      expect(fs.existsSync(path.join(root, 'extensions', 'failures.json'))).toBe(false);
    }
  });

  it('nothing is asked without recorded lists, without a stable server, or on another architecture', async () => {
    const empty = fake(store());
    await downloadExtensions(empty.deps);
    expect(empty.queries).toEqual([]);
    expect(empty.logs).toEqual(['No open recorded an extension list in the last 14 days; no extension is fetched.']);

    const root = store();
    record(root, 'aaaaaaaaaa', { at: NOW, configuration: [{ id: 'a.b' }], defaults: [] });
    const noServer = fake(root);
    await downloadExtensions(noServer.deps);
    expect(noServer.queries).toEqual([]);
    expect(noServer.logs[0]).toContain('has no stable VS Code server for linux-x64');

    server(root, 'a'.repeat(40), '1.105.0');
    const other = fake(root);
    other.deps.architecture = async () => 's390x';
    await downloadExtensions(other.deps);
    expect(other.queries).toEqual([]);
  });

  it('runs in the background run after the part of the server, and its failure does not stop the run', async () => {
    const root = store();
    const logs: string[] = [];
    const f = fake(root);
    const vscode = {
      store: { root, transport: f.deps.transport },
      storeVolume: 'devenv-vscode',
      engine: { architecture: async () => 'x86_64', containerSummaries: async () => [] },
      tryLock: async () => ({ kind: 'busy' }) as StoreLockAttempt,
      ensure: async () => true,
      extensionLocks: { lock: f.deps.lock, tryLock: f.deps.tryLock },
    } as unknown as VscodeBackgroundDeps;
    const run = new BackgroundRun({ log: (message) => logs.push(message), now: () => NOW, images: async () => undefined, vscode: () => vscode, state: { read: async () => ({ lastCleanupAt: NOW }), update: async () => undefined } });
    await run.run();
    expect(logs).toContain('No open recorded an extension list in the last 14 days; no extension is fetched.');
    expect(logs[logs.length - 1]).toBe('The background run ended.');
  });
});

describe('the cleanup of the extension cache (plan step 11H3)', () => {
  it('removes older versions that no recent list pins, each under its lock without a wait; busy ones stay; lock files stay', async () => {
    const root = store();
    record(root, 'aaaaaaaaaa', { at: NOW - DAY, configuration: [{ id: 'a.b', version: '1.0.0' }], defaults: [] });
    record(root, 'bbbbbbbbbb', { at: NOW - RECORDED_LIST_MS, configuration: [{ id: 'c.d', version: '1.0.0' }], defaults: [] });
    // Review round 1 of 11H3 (A-L4): the files of an ID that no recent list names all go now; a recent list names these
    // IDs, so this test still holds the rule of the newest file and of the pins.
    record(root, 'cccccccccc', { at: NOW, configuration: [{ id: 'c.d' }, { id: 'e.f' }, { id: 'busy.one' }], defaults: [] });
    const keep = [cachedFile(root, 'universal', 'a.b-1.0.0'), cachedFile(root, 'universal', 'a.b-2.0.0'), cachedFile(root, 'universal', 'c.d-3.0.0'), cachedFile(root, 'linux-x64', 'e.f-1.0.0-linux-x64'), cachedFile(root, 'universal', 'busy.one-1.0.0'), cachedFile(root, 'universal', 'busy.one-2.0.0')];
    const gone = [cachedFile(root, 'universal', 'a.b-1.5.0'), cachedFile(root, 'universal', 'c.d-1.0.0'), cachedFile(root, 'linux-x64', 'e.f-0.9.0-linux-x64')];
    const locksFolder = path.join(root, 'locks');
    fs.mkdirSync(locksFolder);
    fs.writeFileSync(path.join(locksFolder, 'extension-c.d-1.0.0.lock'), '');
    const f = fake(root, { busy: ['busy.one-1.0.0'] });
    await cleanupExtensions(f.deps);
    for (const file of keep) expect(fs.existsSync(file)).toBe(true);
    for (const file of gone) expect(fs.existsSync(file)).toBe(false);
    expect(f.locks.sort()).toEqual(['try a.b-1.5.0', 'try busy.one-1.0.0', 'try c.d-1.0.0', 'try e.f-0.9.0-linux-x64']);
    expect(f.logs).toContain('The extension busy.one-1.0.0 is not removed from the shared extension cache now: its lock is held (a download of it runs).');
    expect(fs.readdirSync(locksFolder)).toEqual(['extension-c.d-1.0.0.lock']);
  });

  it('removes the leftovers of downloads only while their lock can be taken; other names stay', async () => {
    const root = store();
    const temp = path.join(root, 'extensions', 'tmp');
    fs.mkdirSync(temp, { recursive: true });
    for (const name of ['a.b-1.0.0-0123456789ab', 'busy.one-1.0.0-0123456789ab', 'unknown']) fs.writeFileSync(path.join(temp, name), '');
    const f = fake(root, { busy: ['busy.one-1.0.0'] });
    await cleanupExtensions(f.deps);
    expect(fs.readdirSync(temp).sort()).toEqual(['busy.one-1.0.0-0123456789ab', 'unknown']);
  });

  it('runs in the daily cleanup of the background run', async () => {
    const root = store();
    const old = cachedFile(root, 'universal', 'a.b-1.0.0');
    cachedFile(root, 'universal', 'a.b-2.0.0');
    const f = fake(root);
    const vscode = {
      store: { root, transport: f.deps.transport },
      storeVolume: 'devenv-vscode',
      engine: { architecture: async () => 'x86_64', containerSummaries: async () => [] },
      tryLock: async () => ({ kind: 'busy' }) as StoreLockAttempt,
      ensure: async () => true,
      extensionLocks: { lock: f.deps.lock, tryLock: f.deps.tryLock },
    } as unknown as VscodeBackgroundDeps;
    const transport = vscode.store.transport as { request: unknown };
    transport.request = async () => ({ status: 503, headers: {}, body: '' });
    const run = new BackgroundRun({ log: () => undefined, now: () => NOW, images: async () => undefined, vscode: () => vscode, state: { read: async () => ({}), update: async () => undefined } });
    await run.run();
    expect(fs.existsSync(old)).toBe(false);
  });
});
