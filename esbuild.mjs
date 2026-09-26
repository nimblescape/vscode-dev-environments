// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as esbuild from 'esbuild';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Watch mode output for the problem matcher of .vscode/tasks.json: one "[watch] build started" / "[watch] build
// finished" pair while any of the bundles builds (so the debugger starts only when both are written), and each message
// as "✘ [ERROR] <text>" followed by "    <file>:<line>:<column>:" (1-based column).
let runningBuilds = 0;
const watchReporter = {
  name: 'watch-reporter',
  setup(build) {
    build.onStart(() => {
      if (runningBuilds++ === 0) console.log('[watch] build started');
    });
    build.onEnd((result) => {
      for (const [kind, messages] of [['ERROR', result.errors], ['WARNING', result.warnings]]) {
        for (const { text, location } of messages) {
          console.error(`✘ [${kind}] ${text}`);
          if (location) console.error(`    ${location.file}:${location.line}:${location.column + 1}:`);
        }
      }
      if (--runningBuilds === 0) console.log('[watch] build finished');
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  // In watch mode the reporter above writes all output; esbuild's own "[watch] build finished" lines per bundle would
  // end the problem matcher's build too early.
  logLevel: watch ? 'silent' : 'info',
  plugins: watch ? [watchReporter] : [],
  // Compile-time constants (src/types/globals.d.ts). Both bundles get them, so that code of src/core that the session
  // monitor imports later never contains an undefined global.
  define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) },
};

const outfiles = ['dist/extension.js', 'dist/sessionMonitor.js', 'dist/groupsPreviewWorker.js'];

// A production build writes no source maps: remove maps of an earlier development build, so that no map that does not
// match the minified bundles stays in dist/.
if (production) {
  for (const outfile of outfiles) fs.rmSync(`${outfile}.map`, { force: true });
}

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ['src/vscode/extension.ts'],
    outfile: outfiles[0],
    external: ['vscode'],
  }),
  esbuild.context({
    ...shared,
    entryPoints: ['src/monitor/sessionMonitor.ts'],
    outfile: outfiles[1],
  }),
  // The worker thread of the repository groups editor: runs the regular expressions of the draft with a time limit.
  esbuild.context({
    ...shared,
    entryPoints: ['src/vscode/groupsPreviewWorker.ts'],
    outfile: outfiles[2],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
