// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F1 (decision 1 of 2026-10-03: no bypass of the worker, by construction): the extension's bundle holds no
// pipeline. Its operations send their flows to the worker (EnvironmentOperations); the pipeline (EnvironmentService), the
// image update check and the host access analysis run only there. Checked on the modules that esbuild bundles into
// dist/extension.js (its metafile), as esbuild.mjs builds it.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** The modules of the pipeline that only the worker runs (relative to the repository root). */
const PIPELINE_MODULES = [
  'src/core/pipeline/environmentService.ts',
  'src/core/imageCheck/imageCheck.ts',
  'src/core/helper/configurationAnalysis.ts',
  'src/core/helper/configurationAnalysisRunner.ts',
  'src/core/helper/configurationAnalysisWorker.ts',
  'src/core/worker/workerServices.ts',
  'src/core/worker/engineDocker.ts',
];

let inputs: string[] = [];

beforeAll(async () => {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['src/vscode/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify('0.0.0') },
    write: false,
    metafile: true,
    logLevel: 'silent',
    outfile: 'dist/extension.js',
  });
  inputs = Object.keys(result.metafile.inputs);
}, 60_000);

describe("the extension's bundle (plan step 11F1)", () => {
  it('holds the operations of the window, which send the flows to the worker', () => {
    expect(inputs).toContain('src/core/pipeline/environmentOperations.ts');
    expect(inputs).toContain('src/core/helperChannel/helperChannels.ts');
  });

  it('holds no module of the pipeline', () => {
    expect(inputs.filter((input) => PIPELINE_MODULES.includes(input))).toEqual([]);
  });
});
