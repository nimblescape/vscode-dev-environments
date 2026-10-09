// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3 (reviewer B, mutation testing): probes of the part "extensions" of the Session Monitor's
// background run and of its cleanup that no test pinned, with a store in a temporary folder, a fake Marketplace and fake
// downloads: the time limits of the read of the architecture and of a query; the size cap of an answer; an answer that is
// not HTTP 200; a failed first query does not end the part; only ready servers of a commit name with a valid product.json
// count; the failures of entries no list wants any more go; a failed write of the failures is one line; every lock of the
// cleanup is released, and a failure there never escapes; the default locks are the files' own lock files
// (locks/extension-<cache name>.lock, with real flock); and the wiring into the background run.
// Review round 1 of 11H3 (A-L6): the `.vsix` URLs of these tests are on a host of the Marketplace's CDN
// (`cdn.gallerycdn.vsassets.io`, was `cdn.example`), as a VSIX URL on any other host is now refused; nothing else changed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse, HttpStreamResponse } from '../core/http';
import { MAX_MARKETPLACE_ANSWER_BYTES, formatExtensionRecord, type ExtensionRecord } from '../core/vscodeExtensions';
import { extensionLockFile } from '../core/worker/vscodeExtensionStore';
import { storeLock, storeTryLock, type StoreLockAttempt } from '../core/worker/vscodeServerStore';
import { BackgroundRun, extensionRunDeps, type VscodeBackgroundDeps } from './background';
import { MARKETPLACE_TIMEOUT_MS, cleanupExtensions, downloadExtensions, newestStableServerVersion, type ExtensionRunDeps } from './extensionDownloads';

const DAY = 24 * 60 * 60_000;
const NOW = 400 * DAY;
const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip')]);

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function store(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-run-pH3R1-'));
  temps.push(root);
  return root;
}

function server(root: string, commit: string, product: string | undefined, ready = true): void {
  const folder = path.join(root, 'server', 'stable', 'linux-x64', commit);
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  if (ready) {
    fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '');
    fs.writeFileSync(path.join(folder, 'node'), '');
  }
  if (product !== undefined) fs.writeFileSync(path.join(folder, 'product.json'), product);
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

function answer(extensions: Record<string, string[]>): string {
  return JSON.stringify({
    results: [
      {
        extensions: Object.entries(extensions).map(([id, versions]) => ({
          publisher: { publisherName: id.split('.')[0] },
          extensionName: id.split('.')[1],
          versions: versions.map((number) => ({
            version: number,
            properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.90.0' }],
            files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: `https://cdn.gallerycdn.vsassets.io/${id}-${number}.vsix` }],
          })),
        })),
      },
    ],
  });
}

interface Fake {
  deps: ExtensionRunDeps;
  requests: Array<{ request: HttpRequest; signal?: AbortSignal; ids: string[] }>;
  downloads: string[];
  logs: string[];
  architectureSignals: AbortSignal[];
}

function fake(root: string, options: { answer?: (ids: string[]) => HttpResponse; download?: (url: string) => Promise<HttpStreamResponse> } = {}): Fake {
  const requests: Fake['requests'] = [];
  const downloads: string[] = [];
  const logs: string[] = [];
  const architectureSignals: AbortSignal[] = [];
  const deps: ExtensionRunDeps = {
    root,
    // Review round 1 of 11H3 (A-L5, B-D4): the lists, the failures and the chosen files are in the volume of the monitor;
    // here the same temporary folder as the store (the layout below it, `extensions/wanted` and
    // `extensions/failures.json`, is the same).
    stateDir: root,
    transport: {
      request: async (request: HttpRequest, signal?: AbortSignal) => {
        const body = JSON.parse(request.body ?? '{}') as { filters: Array<{ criteria: Array<{ filterType: number; value: string }> }> };
        const ids = body.filters[0].criteria.filter((c) => c.filterType === 7).map((c) => c.value);
        requests.push({ request, signal, ids });
        return options.answer?.(ids) ?? { status: 200, headers: {}, body: answer({}) };
      },
      stream: async (url: string) => {
        downloads.push(url);
        return options.download !== undefined ? options.download(url) : { status: 200, headers: {}, body: Readable.from([VSIX]) };
      },
    },
    architecture: async (signal) => {
      architectureSignals.push(signal);
      return 'x86_64';
    },
    lock: async () => () => undefined,
    tryLock: async (): Promise<StoreLockAttempt> => ({ kind: 'locked', release: () => undefined }),
    log: (message) => logs.push(message),
    now: () => NOW,
  };
  return { deps, requests, downloads, logs, architectureSignals };
}

/** A store with a ready stable server 1.105.0 and a list of `configuration` recorded a day ago. */
function prepared(configuration: ExtensionRecord['configuration']): string {
  const root = store();
  server(root, 'a'.repeat(40), JSON.stringify({ version: '1.105.0' }));
  record(root, 'aaaaaaaaaa', { at: NOW - DAY, configuration, defaults: [] });
  return root;
}

describe('the part "extensions": limits and failures (review round 1 of 11H3, reviewer B)', () => {
  it('the read of the architecture and each query have their time limit of 60 s', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    const root = prepared([{ id: 'a.b' }]);
    const f = fake(root, { answer: () => ({ status: 200, headers: {}, body: answer({ 'a.b': ['1.0.0'] }) }) });
    await downloadExtensions(f.deps);
    const limitOf = (signal: AbortSignal | undefined) => timeouts.mock.calls[timeouts.mock.results.findIndex((result) => result.value === signal)]?.[0];
    expect(MARKETPLACE_TIMEOUT_MS).toBe(60_000);
    expect(f.architectureSignals).toHaveLength(1);
    expect(limitOf(f.architectureSignals[0])).toBe(60_000);
    expect(f.requests).toHaveLength(1);
    expect(limitOf(f.requests[0].signal)).toBe(60_000);
  });

  it('a query reads at most MAX_MARKETPLACE_ANSWER_BYTES', async () => {
    const f = fake(prepared([{ id: 'a.b' }]));
    await downloadExtensions(f.deps);
    expect(f.requests[0].request.maxBodyBytes).toBe(MAX_MARKETPLACE_ANSWER_BYTES);
  });

  it('an answer that is not HTTP 200 is a failed query, whatever its body', async () => {
    const f = fake(prepared([{ id: 'a.b' }]), { answer: () => ({ status: 500, headers: {}, body: answer({ 'a.b': ['1.0.0'] }) }) });
    await downloadExtensions(f.deps);
    expect(f.downloads).toEqual([]);
    expect(f.logs).toContain('The Marketplace could not be asked for 1 extension(s): the Marketplace answered HTTP 500');
  });

  it('a failed query for the entries without a pin does not keep the pinned ones from being asked for', async () => {
    const root = prepared([{ id: 'a.b' }, { id: 'c.d', version: '1.0.0' }]);
    const f = fake(root, { answer: (ids) => (ids.includes('c.d') ? { status: 200, headers: {}, body: answer({ 'c.d': ['1.0.0'] }) } : { status: 503, headers: {}, body: '' }) });
    await downloadExtensions(f.deps);
    expect(f.requests.map((r) => r.ids)).toEqual([['a.b'], ['c.d']]);
    expect(fs.existsSync(path.join(root, 'extensions', 'universal', 'c.d-1.0.0'))).toBe(true);
  });

  it('a failure of the architecture read is one line, never a failure of the part', async () => {
    const f = fake(prepared([{ id: 'a.b' }]));
    f.deps.architecture = async () => {
      throw new Error('engine gone');
    };
    await expect(downloadExtensions(f.deps)).resolves.toBeUndefined();
    expect(f.logs.some((line) => line.startsWith('The architecture of the engine could not be read, so no extension is fetched:'))).toBe(true);
    expect(f.requests).toEqual([]);
  });

  it('only a ready server of a commit name with a product.json of at most 1 MiB and an x.y.z version counts', async () => {
    const root = store();
    server(root, 'a'.repeat(40), JSON.stringify({ version: '1.105.0' }));
    server(root, 'not-a-commit', JSON.stringify({ version: '1.200.0' }));
    server(root, 'b'.repeat(40), JSON.stringify({ version: '1.201.0' }), false);
    server(root, 'c'.repeat(40), `${JSON.stringify({ version: '1.202.0' })}${' '.repeat(1024 * 1024)}`);
    server(root, 'd'.repeat(40), JSON.stringify({ version: '1.203.0-insider' }));
    expect(await newestStableServerVersion(root, 'linux-x64')).toBe('1.105.0');
  });

  it('the failures of entries that no list wants any more are dropped from failures.json', async () => {
    const root = prepared([{ id: 'a.b' }]);
    fs.writeFileSync(path.join(root, 'extensions', 'failures.json'), JSON.stringify({ 'gone.ext': NOW - 2 * DAY }));
    const f = fake(root, { answer: () => ({ status: 200, headers: {}, body: answer({ 'a.b': ['1.0.0'] }) }) });
    await downloadExtensions(f.deps);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'failures.json'), 'utf8'))).toEqual({});
  });

  it('a failed write of failures.json is one line; the part ends with its summary', async () => {
    const root = prepared([{ id: 'a.b' }]);
    fs.mkdirSync(path.join(root, 'extensions', 'failures.json'));
    const f = fake(root);
    await expect(downloadExtensions(f.deps)).resolves.toBeUndefined();
    expect(f.logs.some((line) => line.startsWith('The failed extensions could not be stored:'))).toBe(true);
    expect(f.logs[f.logs.length - 1]).toBe('The extensions for VS Code 1.105.0 (linux-x64): 1 wanted, 0 downloaded, 0 in the cache, 1 failed, 0 waiting for their retry.');
  });
});

describe('the cleanup: locks (review round 1 of 11H3, reviewer B)', () => {
  it('releases every lock it takes, for the files and for the leftovers of downloads', async () => {
    const root = store();
    cachedFile(root, 'universal', 'a.b-1.0.0');
    cachedFile(root, 'universal', 'a.b-2.0.0');
    cachedFile(root, 'universal', 'a.b-3.0.0');
    // Review round 1 of 11H3 (A-L4): the files of an ID that no recent list names all go now; a recent list names a.b,
    // so its newest file stays as before.
    record(root, 'aaaaaaaaaa', { at: NOW, configuration: [{ id: 'a.b' }], defaults: [] });
    const temp = path.join(root, 'extensions', 'tmp');
    fs.mkdirSync(temp);
    fs.writeFileSync(path.join(temp, 'c.d-1.0.0-0123456789ab'), '');
    const f = fake(root);
    const counts = { taken: 0, released: 0 };
    f.deps.tryLock = async () => {
      counts.taken++;
      return { kind: 'locked', release: () => void counts.released++ };
    };
    await cleanupExtensions(f.deps);
    expect(counts).toEqual({ taken: 3, released: 3 });
    expect(fs.readdirSync(path.join(root, 'extensions', 'universal'))).toEqual(['a.b-3.0.0']);
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  it('a failing lock is one line, never a failure of the cleanup', async () => {
    const root = store();
    cachedFile(root, 'universal', 'a.b-1.0.0');
    cachedFile(root, 'universal', 'a.b-2.0.0');
    const f = fake(root);
    f.deps.tryLock = async () => {
      throw new Error('no flock');
    };
    await expect(cleanupExtensions(f.deps)).resolves.toBeUndefined();
    expect(f.logs).toContain('The shared extension cache could not be cleaned up: no flock');
  });

  it('the default locks are the files\' own lock files (locks/extension-<cache name>.lock), with flock', async () => {
    // The cleanup: a file whose own lock is held stays.
    const root = store();
    const old = cachedFile(root, 'universal', 'a.b-1.0.0');
    cachedFile(root, 'universal', 'a.b-2.0.0');
    const held = await storeLock(root, 'a.b-1.0.0', 5, new AbortController().signal, undefined, extensionLockFile(root, 'a.b-1.0.0'));
    const f = fake(root);
    delete f.deps.lock;
    delete f.deps.tryLock;
    try {
      await cleanupExtensions(f.deps);
      expect(fs.existsSync(old)).toBe(true);
    } finally {
      held();
    }
    await cleanupExtensions(f.deps);
    expect(fs.existsSync(old)).toBe(false);

    // The download: its file's own lock is held while it runs.
    const other = prepared([{ id: 'c.d' }]);
    const seen: string[] = [];
    const g = fake(other, {
      answer: () => ({ status: 200, headers: {}, body: answer({ 'c.d': ['1.0.0'] }) }),
      download: async () => {
        const attempt = await storeTryLock(other, 'c.d-1.0.0', undefined, extensionLockFile(other, 'c.d-1.0.0'));
        seen.push(attempt.kind);
        if (attempt.kind === 'locked') attempt.release();
        return { status: 200, headers: {}, body: Readable.from([VSIX]) };
      },
    });
    delete g.deps.lock;
    delete g.deps.tryLock;
    await downloadExtensions(g.deps);
    expect(seen).toEqual(['busy']);
    expect(fs.existsSync(path.join(other, 'extensions', 'universal', 'c.d-1.0.0'))).toBe(true);
  });
});

describe('the wiring into the background run (review round 1 of 11H3, reviewer B)', () => {
  function vscodeDeps(root: string, f: Fake): VscodeBackgroundDeps {
    return {
      store: { root, transport: f.deps.transport },
      storeVolume: 'devenv-vscode',
      engine: { architecture: async () => 'x86_64', containerSummaries: async () => [] },
      tryLock: async () => ({ kind: 'busy' }) as StoreLockAttempt,
      ensure: async () => true,
      extensionLocks: { lock: f.deps.lock, tryLock: f.deps.tryLock },
    } as unknown as VscodeBackgroundDeps;
  }

  it('the part and the cleanup get the locks of the VS Code part', () => {
    const root = store();
    const f = fake(root);
    const deps = extensionRunDeps(vscodeDeps(root, f), { log: () => undefined, now: () => NOW });
    expect(deps.lock).toBe(f.deps.lock);
    expect(deps.tryLock).toBe(f.deps.tryLock);
    expect(deps.root).toBe(root);
  });

  it('the part "extensions" runs after the part of the server', async () => {
    const root = store();
    const f = fake(root);
    (f.deps.transport as { request: unknown }).request = async () => ({ status: 503, headers: {}, body: '' });
    const logs: string[] = [];
    const run = new BackgroundRun({ log: (message) => logs.push(message), now: () => NOW, images: async () => undefined, vscode: () => vscodeDeps(root, f), state: { read: async () => ({ lastCleanupAt: NOW }), update: async () => undefined } });
    await run.run();
    const server = logs.findIndex((line) => line.startsWith('The newest VS Code server (stable, linux-x64) could not be read from the update service'));
    const extensions = logs.indexOf('No open recorded an extension list in the last 14 days; no extension is fetched.');
    expect(server).toBeGreaterThanOrEqual(0);
    expect(extensions).toBeGreaterThan(server);
  });
});
