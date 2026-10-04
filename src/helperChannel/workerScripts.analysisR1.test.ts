// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #103 (B, mutation probes): a first build of `devenv:analysis-script` that fails watches the
// folder of its own entry (src/core/helper) and its .ts files, never those of the monitor.
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nested = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('esbuild', () => ({ build: nested.build }));

import { workerScriptsPlugin } from '../../scripts/workerScripts.mjs';

const REPO = path.resolve(__dirname, '../..');

type OnLoad = (args: { path: string }) => Promise<{ errors?: unknown[]; watchFiles?: string[]; watchDirs?: string[] }>;

function load(name: string) {
  let onLoad: OnLoad | undefined;
  const build = { onResolve: () => undefined, onLoad: (_options: unknown, callback: OnLoad) => (onLoad = callback) };
  (workerScriptsPlugin(REPO, {}) as unknown as { setup(build: unknown): void }).setup(build);
  return (onLoad as OnLoad)({ path: name });
}

describe('the plugin of the analysis script (review round 1 of PR #103, B)', () => {
  beforeEach(() => nested.build.mockReset());

  it('a first failed build watches the .ts files and the folder of the analysis thread', async () => {
    nested.build.mockRejectedValueOnce(new Error('boom'));
    const loaded = await load('devenv:analysis-script');
    const folder = path.join(REPO, 'src', 'core', 'helper');
    expect(loaded.watchDirs).toEqual([folder]);
    expect(loaded.watchFiles).toContain(path.join(folder, 'configurationAnalysisWorker.ts'));
    expect(loaded.watchFiles?.every((file) => file.startsWith(folder + path.sep) && file.endsWith('.ts'))).toBe(true);
  });
});
