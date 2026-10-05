// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F1, review B round 1 (mutation probe): the list of extensionBundle.test.ts names the pipeline, the image
// check and the analysis, but not the other modules that only the worker's pipeline runs. A value import of one of them
// into the extension (for example readEnvironmentStates, a direct read of Docker that bypasses the worker's refresh, or
// writeContainerToken, a write of the GitHub token into a container from this computer) passed that test. Checked on the
// same metafile of dist/extension.js as esbuild.mjs builds it.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** The modules that only the worker's pipeline (EnvironmentService) runs, besides those of extensionBundle.test.ts. */
const WORKER_ONLY_MODULES = [
  // The direct reads of Docker of the refresh (plan step 5, PR D, rule D1: never read directly in a window).
  'src/core/pipeline/refreshStates.ts',
  // The check of Delete and its Git reads (plan step 11C2b: only in the worker).
  'src/core/pipeline/deleteCheck.ts',
  // The write of the GitHub token into a container (unit 15).
  'src/core/helper/containerToken.ts',
  // The checks of a configuration before its build.
  'src/core/helper/configChecks.ts',
];

async function bundledModules(entryPoint: string): Promise<string[]> {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entryPoint],
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
  return Object.keys(result.metafile.inputs);
}

let inputs: string[] = [];
let pipelineInputs: string[] = [];

beforeAll(async () => {
  inputs = await bundledModules('src/vscode/extension.ts');
  pipelineInputs = await bundledModules('src/core/pipeline/environmentService.ts');
}, 60_000);

describe("the extension's bundle (plan step 11F1, review B round 1)", () => {
  it('was built from the extension (the check below is not empty by accident)', () => {
    expect(inputs).toContain('src/core/pipeline/environmentOperations.ts');
  });

  it('names each module as the metafile does (the pipeline itself holds each one)', () => {
    expect(WORKER_ONLY_MODULES.filter((module) => !pipelineInputs.includes(module))).toEqual([]);
  });

  it('holds none of the other modules that only the worker runs', () => {
    expect(inputs.filter((input) => WORKER_ONLY_MODULES.includes(input))).toEqual([]);
  });
});
