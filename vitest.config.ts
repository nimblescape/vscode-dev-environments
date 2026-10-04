// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as path from 'path';
import { defineConfig } from 'vitest/config';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';

export default defineConfig({
  // The same compile-time constants as in esbuild.mjs (src/types/globals.d.ts).
  define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) },
  // Plan step 11D2 (and 11E2): the scripts in the bundle of the worker; the tests that import the worker's code get stubs
  // (a worker that a test bundles gets the real scripts, scripts/workerScripts.mjs).
  resolve: {
    alias: [
      { find: /^devenv:monitor-script$/, replacement: path.resolve(__dirname, 'src/helperChannel/monitorScript.stub.ts') },
      { find: /^devenv:analysis-script$/, replacement: path.resolve(__dirname, 'src/helperChannel/analysisScript.stub.ts') },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
