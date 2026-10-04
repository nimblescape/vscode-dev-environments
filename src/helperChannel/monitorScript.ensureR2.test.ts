// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #100 (B, mutation probes): the esbuild plugin of the module `devenv:monitor-script`
// (scripts/monitorScript.mjs): its resolve filter, the options of its nested build, its watched files after a success,
// and after a failure (review rounds 1 and 2 of PR #100, A-L2 and A-L1).
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nested = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('esbuild', () => ({ build: nested.build }));

import { monitorScriptPlugin } from '../../scripts/monitorScript.mjs';

const DEFINE = { __DEVCONTAINER_CLI_VERSION__: '"0.0.0"' };
const REPO = path.resolve(__dirname, '../..');
const FAKE_ROOT = path.resolve('/nonexistent-devenv-root');

type OnLoad = () => Promise<{ contents?: string; loader?: string; errors?: unknown[]; watchFiles?: string[]; watchDirs?: string[] }>;

function setUp(root: string) {
  let filter: RegExp | undefined;
  let onLoad: OnLoad | undefined;
  const build = {
    onResolve: (options: { filter: RegExp }) => (filter = options.filter),
    onLoad: (_options: unknown, callback: OnLoad) => (onLoad = callback),
  };
  (monitorScriptPlugin(root, DEFINE) as unknown as { setup(build: unknown): void }).setup(build);
  return { filter: filter as RegExp, load: onLoad as OnLoad };
}

const succeeded = (text: string, inputs: string[]) => ({ outputFiles: [{ text }], metafile: { inputs: Object.fromEntries(inputs.map((file) => [file, {}])) } });

describe('the plugin of the monitor script (review round 2 of PR #100)', () => {
  beforeEach(() => nested.build.mockReset());

  it('resolves only the exact module name', () => {
    const { filter } = setUp(FAKE_ROOT);
    expect(filter.test('devenv:monitor-script')).toBe(true);
    expect(filter.test('xdevenv:monitor-script')).toBe(false);
    expect(filter.test('devenv:monitor-script/x')).toBe(false);
  });

  it('builds the monitor minified from the root, exports its text, and watches its inputs resolved against the root', async () => {
    nested.build.mockResolvedValueOnce(succeeded('console.log(1)', ['src/remoteMonitor/main.ts', 'src/core/a.ts']));
    const { load } = setUp(FAKE_ROOT);
    const loaded = await load();
    expect(nested.build).toHaveBeenCalledWith(
      expect.objectContaining({
        absWorkingDir: FAKE_ROOT,
        entryPoints: [path.join(FAKE_ROOT, 'src', 'remoteMonitor', 'main.ts')],
        bundle: true,
        minify: true,
        write: false,
        metafile: true,
        define: DEFINE,
      }),
    );
    expect(loaded).toEqual({
      contents: `export default ${JSON.stringify('console.log(1)')};`,
      loader: 'js',
      watchFiles: [path.join(FAKE_ROOT, 'src/remoteMonitor/main.ts'), path.join(FAKE_ROOT, 'src/core/a.ts')],
    });
  });

  it('a first build that fails passes its errors on and watches the .ts files of the monitor and the files of the errors', async () => {
    const errors = [{ text: 'e1', location: { file: 'src/core/broken.ts' } }];
    nested.build.mockRejectedValueOnce({ errors });
    const { load } = setUp(REPO);
    const loaded = await load();
    const folder = path.join(REPO, 'src', 'remoteMonitor');
    expect(loaded.errors).toEqual(errors);
    expect(loaded.watchDirs).toEqual([folder]);
    expect(loaded.watchFiles).toContain(path.join(folder, 'main.ts'));
    expect(loaded.watchFiles).toContain(path.join(REPO, 'src/core/broken.ts'));
    expect(loaded.watchFiles?.filter((file) => !file.startsWith(folder + path.sep))).toEqual([path.join(REPO, 'src/core/broken.ts')]);
    expect(loaded.watchFiles?.every((file) => file.endsWith('.ts'))).toBe(true);
  });

  it('a later build that fails watches the inputs of the last success; an error without messages is its text', async () => {
    nested.build.mockResolvedValueOnce(succeeded('x', ['src/remoteMonitor/main.ts', 'src/core/a.ts']));
    nested.build.mockRejectedValueOnce(new Error('boom'));
    const { load } = setUp(FAKE_ROOT);
    await load();
    const loaded = await load();
    expect(loaded.errors).toEqual([{ text: 'Error: boom' }]);
    expect(loaded.watchFiles).toEqual([path.join(FAKE_ROOT, 'src/remoteMonitor/main.ts'), path.join(FAKE_ROOT, 'src/core/a.ts')]);
    expect(loaded.watchDirs).toEqual([path.join(FAKE_ROOT, 'src', 'remoteMonitor')]);
  });
});
