// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scripts that the worker's bundle (dist/helperChannel.js) carries as text, each a module whose default export is the
// minified bundle of its entry:
// - `devenv:monitor-script` (plan step 11D2, decision of 2026-10-03, the worker is the deputy): the script of the Session
//   Monitor (src/remoteMonitor/main.ts), as the loader of the monitor gets it on its input; the worker creates the monitor
//   container itself.
// - `devenv:analysis-script` (plan step 11E2): the thread of the host access analysis
//   (src/core/helper/configurationAnalysisWorker.ts), which the worker starts from its text (`eval`) with its limits.
// esbuild.mjs and the tests that bundle the worker give their builds this plugin; the files of each script are watched
// with the worker's own (a change of one rebuilds the worker in watch mode).
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';

/** The modules of the worker's scripts and their entries, relative to the root of the repository. */
export const WORKER_SCRIPT_ENTRIES = {
  'devenv:monitor-script': ['src', 'remoteMonitor', 'main.ts'],
  'devenv:analysis-script': ['src', 'core', 'helper', 'configurationAnalysisWorker.ts'],
};

/**
 * @param {string} root The folder of the repository.
 * @param {Record<string, string>} define The compile-time constants of the bundles.
 * @param {(script: string, inputs: string[]) => void} [onScriptInputs] Called with the inputs of each script that was
 *   built (relative to `root`, as in a metafile of esbuild); review round 1 of PR #129 (A-L1): src/workerBundle.test.ts
 *   checks them, since the builds of the scripts never reach the metafile of the worker's bundle.
 * @returns {import('esbuild').Plugin}
 */
export function workerScriptsPlugin(root, define, onScriptInputs) {
  return {
    name: 'worker-scripts',
    setup(build) {
      build.onResolve({ filter: /^devenv:(?:monitor|analysis)-script$/ }, (args) => ({ path: args.path, namespace: 'devenv-worker-script' }));
      // Review round 1 of PR #100 (A-L2): the inputs of the metafile are relative to absWorkingDir, so it is the root; a
      // failed build still watches the files of its script, so its fix rebuilds the worker (review round 2 of PR #100,
      // A-L1: before any build succeeded, the .ts files of its folder and the files of the errors).
      /** @type {Map<string, string[]>} */
      const watched = new Map();
      build.onLoad({ filter: /.*/, namespace: 'devenv-worker-script' }, async (args) => {
        const entry = path.join(root, ...WORKER_SCRIPT_ENTRIES[args.path]);
        const folder = path.dirname(entry);
        let result;
        try {
          result = await esbuild.build({
            absWorkingDir: root,
            entryPoints: [entry],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node20',
            minify: true,
            write: false,
            metafile: true,
            logLevel: 'silent',
            define,
          });
        } catch (error) {
          const errors = error.errors ?? [{ text: String(error) }];
          const files = errors.flatMap((message) => (message.location?.file ? [path.resolve(root, message.location.file)] : []));
          const known = watched.get(args.path) ?? [];
          const fallback = known.length > 0 ? known : sourcesOf(folder);
          return { errors, watchFiles: [...new Set([...fallback, ...files])], watchDirs: [folder] };
        }
        onScriptInputs?.(args.path, Object.keys(result.metafile.inputs));
        const inputs = Object.keys(result.metafile.inputs).map((file) => path.resolve(root, file));
        watched.set(args.path, inputs);
        return {
          contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
          loader: 'js',
          watchFiles: inputs,
        };
      });
    },
  };
}

/**
 * The options of the worker's bundle (dist/helperChannel.js) on top of the options that every bundle shares (`shared` in
 * esbuild.mjs): its entry, always minified and without a source map (the extension sends it over SSH as the first input
 * line of the pipe loader, plan step 3), and the plugin of its scripts after the shared plugins. Review round 1 of PR
 * #129 (A-L2): esbuild.mjs and src/workerBundle.test.ts build the worker from these, so the test checks the real bundle.
 * @param {string} root The folder of the repository.
 * @param {{ define: Record<string, string>, plugins: import('esbuild').Plugin[] } & import('esbuild').BuildOptions} shared
 * @param {(script: string, inputs: string[]) => void} [onScriptInputs] See workerScriptsPlugin.
 * @returns {import('esbuild').BuildOptions}
 */
export function workerBundleOptions(root, shared, onScriptInputs) {
  return {
    ...shared,
    entryPoints: ['src/helperChannel/main.ts'],
    minify: true,
    sourcemap: false,
    plugins: [...shared.plugins, workerScriptsPlugin(root, shared.define, onScriptInputs)],
  };
}

/** The .ts files under `folder`. */
function sourcesOf(folder) {
  return fs
    .readdirSync(folder, { recursive: true })
    .filter((file) => String(file).endsWith('.ts'))
    .map((file) => path.join(folder, String(file)));
}
