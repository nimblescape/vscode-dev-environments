// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E2: the host access analysis in the worker. The plugin of the worker's scripts serves the analysis
// thread (`devenv:analysis-script`) beside the monitor; the operations of the worker give their pipeline an analyzer
// that starts each job from that script (the unit tests get a stub that throws, so a job is refused and logged), and
// the deps of the pipeline take it.
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nested = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('esbuild', () => ({ build: nested.build }));

import { WORKER_SCRIPT_ENTRIES, workerScriptsPlugin } from '../../scripts/workerScripts.mjs';
import { analysisInternalItem } from '../core/helper/configurationAnalysis';
import { workerAnalyzer } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const DEFINE = { __DEVCONTAINER_CLI_VERSION__: '"0.0.0"' };
const ROOT = path.resolve('/nonexistent-devenv-root');

type OnLoad = (args: { path: string }) => Promise<{ contents?: string; errors?: unknown[]; watchFiles?: string[]; watchDirs?: string[] }>;

function setUp() {
  let filter: RegExp | undefined;
  let onLoad: OnLoad | undefined;
  const build = {
    onResolve: (options: { filter: RegExp }, callback: (args: { path: string }) => unknown) => {
      filter = options.filter;
      resolve = callback;
    },
    onLoad: (_options: unknown, callback: OnLoad) => (onLoad = callback),
  };
  let resolve: ((args: { path: string }) => unknown) | undefined;
  (workerScriptsPlugin(ROOT, DEFINE) as unknown as { setup(build: unknown): void }).setup(build);
  return { filter: filter as RegExp, resolve: resolve!, load: onLoad as OnLoad };
}

const succeeded = (text: string, inputs: string[]) => ({ outputFiles: [{ text }], metafile: { inputs: Object.fromEntries(inputs.map((file) => [file, {}])) } });

describe('the analysis thread in the worker (plan step 11E2)', () => {
  beforeEach(() => nested.build.mockReset());

  it('the plugin resolves both scripts of the worker, and nothing else', () => {
    const { filter, resolve } = setUp();
    for (const name of ['devenv:monitor-script', 'devenv:analysis-script']) {
      expect(filter.test(name)).toBe(true);
      expect(resolve({ path: name })).toEqual({ path: name, namespace: 'devenv-worker-script' });
    }
    for (const name of ['devenv:analysis-scripts', 'xdevenv:analysis-script', 'devenv:other-script', 'devenv:analysis']) expect(filter.test(name)).toBe(false);
    expect(WORKER_SCRIPT_ENTRIES).toEqual({
      'devenv:monitor-script': ['src', 'remoteMonitor', 'main.ts'],
      'devenv:analysis-script': ['src', 'core', 'helper', 'configurationAnalysisWorker.ts'],
    });
  });

  it('the plugin builds the analysis thread from its entry, minified, and watches each script on its own', async () => {
    const { load } = setUp();
    nested.build.mockResolvedValueOnce(succeeded('analysis()', ['src/core/helper/configurationAnalysisWorker.ts', 'src/core/helper/dockerfile.ts']));
    const analysis = await load({ path: 'devenv:analysis-script' });
    expect(nested.build).toHaveBeenLastCalledWith(
      expect.objectContaining({ absWorkingDir: ROOT, entryPoints: [path.join(ROOT, 'src', 'core', 'helper', 'configurationAnalysisWorker.ts')], minify: true, define: DEFINE }),
    );
    expect(analysis).toMatchObject({ contents: `export default ${JSON.stringify('analysis()')};`, watchFiles: [path.join(ROOT, 'src/core/helper/configurationAnalysisWorker.ts'), path.join(ROOT, 'src/core/helper/dockerfile.ts')] });
    // A failed build of the monitor watches what the monitor last had, never the inputs of the analysis.
    nested.build.mockResolvedValueOnce(succeeded('monitor()', ['src/remoteMonitor/main.ts']));
    await load({ path: 'devenv:monitor-script' });
    nested.build.mockRejectedValueOnce(new Error('boom'));
    const failed = await load({ path: 'devenv:monitor-script' });
    expect(failed.watchFiles).toEqual([path.join(ROOT, 'src/remoteMonitor/main.ts')]);
    expect(failed.watchDirs).toEqual([path.join(ROOT, 'src', 'remoteMonitor')]);
    nested.build.mockRejectedValueOnce(new Error('boom'));
    expect((await load({ path: 'devenv:analysis-script' })).watchFiles).toEqual([
      path.join(ROOT, 'src/core/helper/configurationAnalysisWorker.ts'),
      path.join(ROOT, 'src/core/helper/dockerfile.ts'),
    ]);
  });

  it('the analyzer of an operation starts each job from the script of the bundle, and its failure is refused and logged to the operation', async () => {
    const lines: string[] = [];
    const context = {
      signal: new AbortController().signal,
      ...contextSecrets(),
      progress: () => {},
      log: (text: string, level?: string) => lines.push(`${level ?? 'info'}: ${text}`),
      output: () => {},
      docker: async () => {
        throw new Error('No Docker CLI call.');
      },
    } satisfies OperationContext;
    // The unit tests' stub of `devenv:analysis-script` throws (analysisScript.stub.ts).
    const result = await workerAnalyzer(context).analyze({ kind: 'hostAccess', checksOn: true, input: { ownVolume: 'own' } });
    expect(result.failure?.kind).toBe('internal');
    expect(result.failure?.reason).toContain('the analysis thread of the unit tests');
    expect(result.report).toEqual({ hostAccess: [], unsupported: [analysisInternalItem(result.failure!.reason)] });
    expect(lines).toEqual([expect.stringMatching(/^warn: The host access analysis of the configuration failed \(.*the analysis thread of the unit tests.*\); the configuration is refused\.$/)]);
  });
});
