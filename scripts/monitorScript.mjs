// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2 (decision of 2026-10-03, the worker is the deputy): the worker creates the Session Monitor container
// itself, so its bundle (dist/helperChannel.js) holds the script of the monitor (src/remoteMonitor/main.ts, minified,
// as the loader of the monitor gets it on its input). The module `devenv:monitor-script` is that script as its default
// export; esbuild.mjs and the Docker tests give their builds of the worker this plugin, and the files of the monitor are
// watched with the worker's own (a change of the monitor rebuilds the worker in watch mode).
import * as path from 'path';
import * as esbuild from 'esbuild';

export const MONITOR_SCRIPT_MODULE = 'devenv:monitor-script';

/**
 * @param {string} root The folder of the repository.
 * @param {Record<string, string>} define The compile-time constants of the bundles.
 * @returns {import('esbuild').Plugin}
 */
export function monitorScriptPlugin(root, define) {
  return {
    name: 'monitor-script',
    setup(build) {
      build.onResolve({ filter: /^devenv:monitor-script$/ }, () => ({ path: 'monitor-script', namespace: 'devenv-monitor-script' }));
      build.onLoad({ filter: /.*/, namespace: 'devenv-monitor-script' }, async () => {
        const result = await esbuild.build({
          entryPoints: [path.join(root, 'src', 'remoteMonitor', 'main.ts')],
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
        return {
          contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
          loader: 'js',
          watchFiles: Object.keys(result.metafile.inputs).map((file) => path.resolve(root, file)),
        };
      });
    },
  };
}
