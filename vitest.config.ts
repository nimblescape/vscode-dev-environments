import { defineConfig } from 'vitest/config';
import { devcontainerCliVersion } from './scripts/cliVersion.mjs';

export default defineConfig({
  // The same compile-time constants as in esbuild.mjs (src/types/globals.d.ts).
  define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(devcontainerCliVersion()) },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
