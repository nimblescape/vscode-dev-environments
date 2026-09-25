import * as fs from 'fs';
import * as esbuild from 'esbuild';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // Compile-time constants (src/types/globals.d.ts). Both bundles get them, so that code of src/core that the session
  // monitor imports later never contains an undefined global.
  define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) },
};

const outfiles = ['dist/extension.js', 'dist/sessionMonitor.js'];

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
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
