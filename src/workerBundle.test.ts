// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (U7, decision of 2026-10-08): the worker's bundle (dist/helperChannel.js) holds no code of the helper
// image of the extension. The worker runs from its own image (section 3b of the plan), so its WorkspaceHelper builds,
// checks, maintains and records no helper image; HelperImages and what it runs (helperImage.ts) are the extension's.
// Checked on the modules that esbuild bundles into dist/helperChannel.js (its metafile), as esbuild.mjs builds it (with
// the scripts of the worker, scripts/workerScripts.mjs).
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { workerScriptsPlugin } from '../scripts/workerScripts.mjs';

const ROOT = path.resolve(__dirname, '..');

/** The modules of the helper image of the extension: HelperImages, its build, check, cleanup and record, its prebuild. */
const HELPER_IMAGE_MODULES = ['src/core/helper/helperImages.ts', 'src/core/helper/helperImage.ts', 'src/core/helper/helperPrebuild.ts'];

let inputs: string[] = [];

beforeAll(async () => {
  const define = { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) };
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['src/helperChannel/main.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: true,
    define,
    plugins: [workerScriptsPlugin(ROOT, define)],
    write: false,
    metafile: true,
    logLevel: 'silent',
    outfile: 'dist/helperChannel.js',
  });
  inputs = Object.keys(result.metafile.inputs);
}, 60_000);

describe("the worker's bundle (plan step 11I, U7)", () => {
  it('holds the pipeline and the workspace helper (the check below is not empty by accident)', () => {
    expect(inputs).toContain('src/core/worker/workerServices.ts');
    expect(inputs).toContain('src/core/helper/workspaceHelper.ts');
  });

  it('holds no module of the helper image of the extension', () => {
    expect(inputs.filter((input) => HELPER_IMAGE_MODULES.includes(input))).toEqual([]);
  });
});
