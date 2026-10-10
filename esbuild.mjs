// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';
import { workerBundleOptions } from './scripts/workerScripts.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Watch mode output for the problem matcher of .vscode/tasks.json: one "[watch] build started" / "[watch] build
// finished" pair while any of the bundles builds (so the debugger starts only when all are written), and each message
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
  // Compile-time constants (src/types/globals.d.ts). Every bundle gets them, so that code of src/core that a bundle
  // imports never contains an undefined global.
  define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) },
};

const outfiles = [
  'dist/extension.js',
  'dist/groupsPreviewWorker.js',
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
  // The worker thread of the repository groups editor: runs the regular expressions of the draft with a time limit.
  esbuild.context({
    ...shared,
    entryPoints: ['src/vscode/groupsPreviewWorker.ts'],
    outfile: outfiles[1],
  }),
  // User request 2026-09-28: the script of the helper channel on a remote Docker host. The extension sends it over SSH as
  // the first input line of the pipe loader of the channel container (plan step 3, src/core/loader/pipeLoader.ts), so it
  // is always minified (less data over SSH) and has no source map. Plan step 11D2: it holds the script of the Session
  // Monitor (the module `devenv:monitor-script`, scripts/workerScripts.mjs), which it gives the monitor container it
  // creates; before, the extension read dist/remoteMonitor.js for it. Plan step 11E2: and the thread of the host access
  // analysis (the module `devenv:analysis-script`), which it starts from that text.
  // Review round 1 of PR #129 (A-L2): its options (workerBundleOptions) are the ones that src/workerBundle.test.ts builds.
  esbuild.context({
    ...workerBundleOptions(fileURLToPath(new URL('.', import.meta.url)), shared),
    outfile: outfiles[2],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
