// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Compile-time constants. esbuild.mjs and vitest.config.ts replace them with their values (esbuild option `define`).

/** Version of `@devcontainers/cli` in the helper image: the exact devDependency in package.json (scripts/cliVersion.mjs). */
declare const __DEVCONTAINER_CLI_VERSION__: string;
