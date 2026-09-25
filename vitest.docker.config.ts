import { defineConfig } from 'vitest/config';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';

// Integration tests against the real Docker engine (npm run test:docker). `npm test` does not run them.
export default defineConfig({
  // The same compile-time constants as in esbuild.mjs (src/types/globals.d.ts).
  define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) },
  test: {
    include: ['test/docker/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/docker/globalSetup.ts'],
    // One file at a time: the files share the Docker engine, and the check for leftovers needs a quiet engine.
    fileParallelism: false,
    // A first run builds the workspace helper image, which can take some minutes.
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    teardownTimeout: 60_000,
    reporters: ['verbose'],
  },
});
