// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Version of the Dev Container CLI in the workspace helper (implementation notes 2 and 7). package.json lists
// `@devcontainers/cli` as an exact devDependency only to pin this version: esbuild.mjs and vitest.config.ts pass it to
// the code as __DEVCONTAINER_CLI_VERSION__ (src/types/globals.d.ts). The package is neither bundled nor shipped.
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const CLI_PACKAGE = '@devcontainers/cli';
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The version of `@devcontainers/cli` in the devDependencies of package.json. Throws if it is missing or not an exact
 * `x.y.z` version: with a range, the helper image could get a CLI version that no test has seen.
 * @param {string} [packageJsonPath] Default: package.json of this repository.
 * @returns {string}
 */
export function devcontainerCliVersion(packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))) {
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = manifest?.devDependencies?.[CLI_PACKAGE];
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    const found = version === undefined ? 'it is missing' : `found ${JSON.stringify(version)}`;
    throw new Error(
      `${packageJsonPath}: devDependencies must list "${CLI_PACKAGE}" with an exact version x.y.z, for example "0.89.0" (${found}).`,
    );
  }
  return version;
}
