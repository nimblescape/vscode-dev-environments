// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (U7, decision of 2026-10-08): the worker's bundle (dist/helperChannel.js) holds no code of the helper
// image of the extension. The worker runs from its own image (section 3b of the plan), so its WorkspaceHelper builds,
// checks, maintains and records no helper image; HelperImages and what it runs (helperImage.ts) are the extension's.
// Checked on the modules that esbuild bundles into dist/helperChannel.js (its metafile), built with the options of
// esbuild.mjs (workerBundleOptions of scripts/workerScripts.mjs), and on the inputs of the scripts that the bundle
// carries as text (the Session Monitor and the thread of the host access analysis), whose own builds never reach that
// metafile (review round 1 of PR #129, A-L1 and A-L2).
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { WORKER_SCRIPT_ENTRIES, workerBundleOptions } from '../scripts/workerScripts.mjs';

const ROOT = path.resolve(__dirname, '..');

/** The modules of the helper image of the extension: HelperImages, its build, check, cleanup and record, its prebuild. */
const HELPER_IMAGE_MODULES = ['src/core/helper/helperImages.ts', 'src/core/helper/helperImage.ts', 'src/core/helper/helperPrebuild.ts'];

let inputs: string[] = [];
/** The inputs of each script of the worker (WORKER_SCRIPT_ENTRIES), from its own build. */
const scriptInputs = new Map<string, string[]>();

beforeAll(async () => {
  const define = { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) };
  // What esbuild.mjs gives every bundle (`shared`) as far as it decides which modules are bundled; the rest of the
  // worker's options are workerBundleOptions'.
  const shared = { bundle: true, platform: 'node' as const, format: 'cjs' as const, target: 'node20', define, plugins: [] };
  const result = await esbuild.build({
    ...workerBundleOptions(ROOT, shared, (script, files) => scriptInputs.set(script, files)),
    absWorkingDir: ROOT,
    outfile: 'dist/helperChannel.js',
    write: false,
    metafile: true,
    logLevel: 'silent',
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

  // Review round 1 of PR #129 (A-L1): the scripts are separate builds of the plugin; an import of HelperImages in the
  // script of the Session Monitor put the code into dist/helperChannel.js while the check above still passed.
  it('holds no module of the helper image of the extension in the scripts that it carries', () => {
    expect([...scriptInputs.keys()].sort()).toEqual(Object.keys(WORKER_SCRIPT_ENTRIES).sort());
    expect(scriptInputs.get('devenv:monitor-script')).toContain('src/remoteMonitor/main.ts');
    expect(scriptInputs.get('devenv:analysis-script')).toContain('src/core/helper/configurationAnalysisWorker.ts');
    for (const [script, files] of scriptInputs) {
      expect(
        files.filter((input) => HELPER_IMAGE_MODULES.includes(input)),
        script,
      ).toEqual([]);
    }
  });

  // Review round 1 of PR #129 (A-L1): a renamed or moved module would make the checks above pass without checking it.
  it('names modules that exist', () => {
    for (const module of HELPER_IMAGE_MODULES) expect(fs.existsSync(path.join(ROOT, module)), module).toBe(true);
  });
});
