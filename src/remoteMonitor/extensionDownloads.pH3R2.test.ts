// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Reviewer B, review round 2 of 11H3 (mutation testing): probes of the monitor's part changed in round 1 that no test
// pinned: the chosen files across runs (an entry that waits for its retry keeps its choice, an entry that no list wants
// any more loses it; a choice that cannot be stored never ends the part), a failed query for all versions fails only its
// own entries (one line each), a pinned entry missing from the answer, and the default bound of a run (1 GiB; a file in
// the cache after the bound still clears its failure). The store and the monitor's volume are temporary folders (the
// helpers as in extensionDownloads.r1.11H3.test.ts).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '../core/http';
import { MARKETPLACE_FLAGS, MARKETPLACE_LATEST_ONLY_FLAG, formatExtensionRecord, type ExtensionRecord } from '../core/vscodeExtensions';
import type { StoreLockAttempt } from '../core/worker/vscodeServerStore';
import { MAX_EXTENSION_BYTES_PER_RUN, downloadExtensions, type ExtensionRunDeps } from './extensionDownloads';

/** The download whose transferred bytes count as the whole default bound of a run (see the test of the default bound). */
const BIG_DOWNLOAD = 'https://cdn.gallerycdn.vsassets.io/a.a-1.0.0.vsix';
// Review round 2 of 11H3 (A-L1): changed setup: the bound of a run counts the bytes that downloadToFile reports as
// transferred (onBytes), no longer the size of the stored file, so the download of a.a reports the whole bound once (in
// place of a spy on the size of its file; nothing that large is transferred). Every other download is the real one.
vi.mock('../core/worker/vscodeServerStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/worker/vscodeServerStore')>();
  return {
    ...original,
    downloadToFile: async (...args: Parameters<typeof original.downloadToFile>) => {
      const [transport, url, file, maxBytes, signal, allowedUrl, onBytes] = args;
      if (url !== BIG_DOWNLOAD || onBytes === undefined) return original.downloadToFile(...args);
      const { MAX_EXTENSION_BYTES_PER_RUN: bound } = await import('./extensionDownloads');
      let reported = false;
      return original.downloadToFile(transport, url, file, maxBytes, signal, allowedUrl, () => {
        if (!reported) onBytes(bound);
        reported = true;
      });
    },
  };
});

const DAY = 24 * 60 * 60_000;
const NOW = 400 * DAY;
const VSIX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip')]);

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devenv-ext-pH3R2-${name}-`));
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


function chosenOf(state: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(state, 'extensions', 'chosen.json'), 'utf8'));
}

function failuresOf(state: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(state, 'extensions', 'failures.json'), 'utf8'));
}

describe('the chosen files across runs (reviewer B, round 2 of 11H3)', () => {
  it('an entry that waits for its retry keeps its earlier choice; one that no list wants loses it', async () => {
    const { root, state } = prepared([{ id: 'wait.ext' }, { id: 'new.ext' }]);
    fs.writeFileSync(path.join(state, 'extensions', 'chosen.json'), JSON.stringify({ 'wait.ext': 'universal/wait.ext-1.0.0', 'gone.ext': 'universal/gone.ext-1.0.0' }));
    fs.writeFileSync(path.join(state, 'extensions', 'failures.json'), JSON.stringify({ 'wait.ext': NOW - 60_000 }));
    const f = fake(root, state, (ids) => ok(answer(Object.fromEntries(ids.map((id) => [id, [{ version: '2.0.0' }]])))));
    await downloadExtensions(f.deps);
    expect(f.queries.map((q) => q.ids)).toEqual([['new.ext']]);
    expect(chosenOf(state)).toEqual({ 'new.ext': 'universal/new.ext-2.0.0', 'wait.ext': 'universal/wait.ext-1.0.0' });
  });

  it('a choice that cannot be stored is one line; the downloads still run', async () => {
    const { root, state } = prepared([{ id: 'a.b' }]);
    // A folder at the name of the file: the rename onto it fails (also for root).
    fs.mkdirSync(path.join(state, 'extensions', 'chosen.json', 'x'), { recursive: true });
    const f = fake(root, state, () => ok(answer({ 'a.b': [{ version: '1.0.0' }] })));
    await downloadExtensions(f.deps);
    expect(f.downloads).toEqual(['https://cdn.gallerycdn.vsassets.io/a.b-1.0.0.vsix']);
    expect(f.logs.some((line) => line.startsWith('The chosen extension files could not be stored: '))).toBe(true);
    expect(fs.existsSync(path.join(root, 'extensions', 'universal', 'a.b-1.0.0'))).toBe(true);
  });
});

describe('the queries for all versions, further cases (reviewer B, round 2 of 11H3)', () => {
  it('a failed query fails only its own entries, one line each; a pinned entry missing from an answer is "not there"', async () => {
    const pins = Array.from({ length: 7 }, (_, index) => ({ id: `p.e${index}`, version: '1.0.0' }));
    const { root, state } = prepared(pins);
    const f = fake(root, state, (ids) =>
      ids.includes('p.e0') ? ok(answer(Object.fromEntries(ids.filter((id) => id !== 'p.e1').map((id) => [id, [{ version: '1.0.0' }]])))) : { status: 503, headers: {}, body: '' },
    );
    await downloadExtensions(f.deps);
    // Review round 2 of 11H3 (A-L2, B R2-D2): changed expectation: the failed query of p.e5 and p.e6 is asked again one ID
    // at a time (both fail again, so the failures below stay the same).
    expect(f.queries.map((q) => q.ids)).toEqual([['p.e0', 'p.e1', 'p.e2', 'p.e3', 'p.e4'], ['p.e5', 'p.e6'], ['p.e5'], ['p.e6']]);
    const failed = f.logs.filter((line) => line.startsWith('The extension ') && line.endsWith('it is tried again after a day.'));
    expect(failed).toHaveLength(3);
    expect(failed).toContain('The extension p.e1@1.0.0 is not in the shared extension cache (the Marketplace does not have it); it is tried again after a day.');
    expect(failed.filter((line) => line.includes('(its query failed: '))).toHaveLength(2);
    expect(Object.keys(failuresOf(state) as object).sort()).toEqual(['p.e1@1.0.0', 'p.e5@1.0.0', 'p.e6@1.0.0']);
  });
});

describe('the default bound of a run (reviewer B, round 2 of 11H3)', () => {
  it('MAX_EXTENSION_BYTES_PER_RUN without maxRunBytes; a file in the cache after the bound clears its failure', async () => {
    const { root, state } = prepared([{ id: 'a.a' }, { id: 'b.b' }, { id: 'c.c' }]);
    cachedFile(root, 'universal', 'c.c-1.0.0');
    // c.c failed two days ago (due again) and is in the cache now.
    fs.writeFileSync(path.join(state, 'extensions', 'failures.json'), JSON.stringify({ 'c.c': NOW - 2 * DAY }));
    // Review round 2 of 11H3 (A-L1): changed setup: the download of a.a reports the whole bound as transferred (the
    // vi.mock of downloadToFile above, BIG_DOWNLOAD), in place of the spy that made its stored file that large.
    const f = fake(root, state, (ids) => ok(answer(Object.fromEntries(ids.map((id) => [id, [{ version: '1.0.0' }]])))));
    expect(f.deps.maxRunBytes).toBeUndefined();
    await downloadExtensions(f.deps);
    expect(f.downloads).toEqual([BIG_DOWNLOAD]);
    expect(f.logs).toContain(`This run downloaded ${MAX_EXTENSION_BYTES_PER_RUN} bytes, its bound; 1 extension(s) are left for the next run.`);
    expect(f.logs).toContain('The extensions for VS Code 1.105.0 (linux-x64): 3 wanted, 1 downloaded, 1 in the cache, 0 failed, 0 waiting for their retry.');
    expect(failuresOf(state)).toEqual({});
  });
});
