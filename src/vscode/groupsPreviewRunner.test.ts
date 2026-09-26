// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Runs the real worker bundle (as esbuild.mjs builds dist/groupsPreviewWorker.js) with a regular expression whose
// matching takes seconds (review finding 3): the runner must stop it after the time limit.
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DiscoveryData, RepositoryInfo } from '../core/types';
import { PREVIEW_TIME_LIMIT_MS, PreviewWorkerRunner } from './groupsPreviewRunner';
import { cloneableInput, type EditorEntry } from './repositoryGroupsEditorModel';
import type { TreeInput } from './treeModel';

let outDir: string;
let bundle: string;
let runner: PreviewWorkerRunner | undefined;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  bundle = path.join(outDir, 'groupsPreviewWorker.js');
  // Same options as esbuild.mjs.
  buildSync({
    entryPoints: [path.join(__dirname, 'groupsPreviewWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundle,
    logLevel: 'silent',
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify('0.0.0') },
  });
});

afterEach(() => {
  runner?.dispose();
  runner = undefined;
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** 2^n steps for a name of n word characters that does not match: seconds for about 27 characters. */
const SLOW = String.raw`^(\w+)+$`;
const SLOW_NAME = `${'a'.repeat(32)}-`;

function repo(nameWithOwner: string): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: null,
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
  };
}

function input(names: string[]): TreeInput | undefined {
  const discovery: DiscoveryData = {
    version: 1,
    fetchedAt: '2026-09-26T00:00:00.000Z',
    viewerLogin: 'me',
    organizations: [],
    repositories: names.map((name) => repo(`school/${name}`)),
    hints: [],
  };
  return cloneableInput({
    discovery,
    settings: { owners: [], includeArchived: false, includeForks: true },
    environments: [],
    runtime: undefined,
    currentEnvironmentId: null,
    otherWindowEnvironmentIds: new Set(),
    busyEnvironmentIds: new Set(),
    liveBranches: new Map(),
    signedIn: true,
    formatTime: (value) => value,
  });
}

const entry = (pattern: string): EditorEntry => ({ name: '', pattern, flags: '' });

describe('PreviewWorkerRunner', () => {
  it('makes the preview and the test in the worker thread', async () => {
    runner = new PreviewWorkerRunner(bundle);
    const run = await runner.run({ entries: [entry('^(web)-(.+)$')], testName: 'web-shop', input: input(['web-shop', 'api']) });
    expect(run.preview?.owners[0]).toMatchObject({ owner: 'school', counts: [1], hidden: ['api'] });
    expect(run.test).toMatchObject({ matched: true, path: ['web', 'shop'] });
  });

  it('stops a regular expression that is too slow for the names of the view, names the entry, and goes on', async () => {
    runner = new PreviewWorkerRunner(bundle, 300);
    const started = Date.now();
    const run = await runner.run({ entries: [entry('^x-'), entry(SLOW)], testName: '', input: input([SLOW_NAME]) });
    expect(Date.now() - started).toBeLessThan(PREVIEW_TIME_LIMIT_MS + 1000);
    expect(run).toEqual({ previewTooSlow: true, slowEntry: 1 });
    // The next job gets a new worker.
    const next = await runner.run({ entries: [entry('^(a+)-$')], testName: '', input: input([SLOW_NAME]) });
    expect(next.preview?.owners[0].counts).toEqual([1]);
  });

  it('stops a test name that is too slow and keeps the preview', async () => {
    runner = new PreviewWorkerRunner(bundle, 300);
    const run = await runner.run({ entries: [entry(SLOW)], testName: SLOW_NAME, input: input(['short']) });
    expect(run.testTooSlow).toBe(true);
    expect(run.preview?.owners[0].counts).toEqual([1]);
  });

  it('ends the running job and the queued jobs at dispose without starting a new worker (review round 2 of PR #21, W6r)', async () => {
    const current = new PreviewWorkerRunner(bundle, 5000);
    runner = current;
    const workerOf = () => (current as unknown as { worker: unknown }).worker;
    const plain = { entries: [entry('^(web)-(.+)$')], testName: '', input: input(['web-shop']) };
    expect((await current.run(plain)).preview?.owners[0].counts).toEqual([1]);
    // A slow job runs, two more wait behind it.
    const slow = current.run({ entries: [entry(SLOW)], testName: '', input: input([SLOW_NAME]) });
    const queued = [current.run(plain), current.run(plain)];
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workerOf()).toBeDefined();
    const started = Date.now();
    current.dispose();
    expect(await slow).toMatchObject({ failed: true });
    for (const job of queued) expect(await job).toEqual({ failed: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(workerOf()).toBeUndefined();
    // Jobs queued behind a finished job, disposed before they start.
    const waiting = [current.run(plain), current.run(plain)];
    current.dispose();
    for (const job of waiting) expect(await job).toEqual({ failed: true });
    expect(workerOf()).toBeUndefined();
    // A run after the dispose (the editor opened again) starts a new worker.
    expect((await current.run(plain)).preview?.owners[0].counts).toEqual([1]);
    expect(workerOf()).toBeDefined();
  });

  it('reports a worker that cannot start', async () => {
    runner = new PreviewWorkerRunner(path.join(outDir, 'missing.js'));
    expect(await runner.run({ entries: [], testName: '', input: undefined })).toMatchObject({ failed: true });
  });
});
