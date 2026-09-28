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

const outfiles = [
  'dist/extension.js',
  'dist/sessionMonitor.js',
  'dist/groupsPreviewWorker.js',
  'dist/configurationAnalysisWorker.js',
  'dist/remoteMonitor.js',
  'dist/helperChannel.js',
];

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
  // Review round 8: the worker thread of the host access analysis (configurationAnalysisRunner.ts): analyses the
  // Dockerfiles and the Compose model of a repository with limits of time and memory.
  esbuild.context({
    ...shared,
    entryPoints: ['src/core/helper/configurationAnalysisWorker.ts'],
    outfile: outfiles[3],
  }),
  // Unit 7, PR 2: the Session Monitor on a remote Docker host. The container gets it as an argument of `docker run`
  // (MAX_SCRIPT_LENGTH in src/core/remoteMonitor/protocol.ts), so it is always minified and has no source map.
  esbuild.context({
    ...shared,
    entryPoints: ['src/remoteMonitor/main.ts'],
    outfile: outfiles[4],
    minify: true,
    sourcemap: false,
  }),
  // User request 2026-09-28: the script of the helper channel on a remote Docker host. The extension sends it as the
  // first line of the channel (src/core/helperChannel/protocol.ts), so it is always minified and has no source map.
  esbuild.context({
    ...shared,
    entryPoints: ['src/helperChannel/main.ts'],
    outfile: outfiles[5],
    minify: true,
    sourcemap: false,
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
