// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E2: the host access analysis in the worker. The worker starts each job in a thread of its own from the
// script in its bundle (`devenv:analysis-script`, `eval`), with the limits of the extension. This test runs that
// analyzer in the helper image as the worker runs (no network, no capability, no new privileges), with the script as
// the bundle of the worker carries it (scripts/workerScripts.mjs), and checks a result, the time limit and the memory
// limit there.
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { workerScriptsPlugin } from '../../scripts/workerScripts.mjs';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { WorkspaceHelper } from '../../src/core/helper/workspaceHelper';
import { NodeProcessRunner } from '../../src/core/process';
import { HELPER_DOCKERFILE, dockerTestContext } from './harness';

/** The program in the container: the analyzer of the worker over the script of the bundle, three jobs, their results. */
const PROGRAM = `
import analysisScript from 'devenv:analysis-script';
import { WorkerConfigurationAnalyzer, ANALYSIS_LIMITS } from './src/core/helper/configurationAnalysisRunner';
const job = { kind: 'hostAccess', checksOn: true, input: { ownVolume: 'own', metadata: [{ mounts: ['source=/etc,target=/host-etc,type=bind'] }] } };
async function main() {
  const real = await new WorkerConfigurationAnalyzer({ code: analysisScript }).analyze(job);
  const slow = 'require("worker_threads").parentPort.on("message", () => { const t = Date.now(); while (Date.now() - t < 5000); });';
  const timed = await new WorkerConfigurationAnalyzer({ code: slow }, undefined, { ...ANALYSIS_LIMITS, timeoutMs: 500 }).analyze(job);
  const greedy = 'require("worker_threads").parentPort.on("message", () => { const a = []; for (;;) a.push(new Array(1e5).fill(1)); });';
  const memory = await new WorkerConfigurationAnalyzer({ code: greedy }, undefined, { ...ANALYSIS_LIMITS, timeoutMs: 30000, maxOldGenerationSizeMb: 32 }).analyze(job);
  process.stdout.write(JSON.stringify({ real, timed: timed.failure, memory: memory.failure }));
}
main();
`;

describe('the analysis thread of the worker in the helper image (plan step 11E2)', () => {
  const { run, env, cli, log } = dockerTestContext('analysisThread');
  const docker = new ContainerAdapter(new NodeProcessRunner(), run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const root = path.resolve(__dirname, '../..');
  let bundle = '';
  let helperTag = '';

  beforeAll(async () => {
    const entry = path.join(root, `.analysis-thread-${run.runId}.ts`);
    fs.writeFileSync(entry, PROGRAM);
    try {
      const define = { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) };
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        write: false,
        logLevel: 'silent',
        define,
        plugins: [workerScriptsPlugin(root, define)],
      });
      bundle = result.outputFiles[0].text;
    } finally {
      fs.rmSync(entry, { force: true });
    }
    helperTag = await helper.ensureImage();
  });

  it('analyzes in a thread started from the script text, and holds its time and memory limits there', () => {
    const out = cli.ok(['run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', helperTag, 'node', '-'], bundle);
    const result = JSON.parse(out) as { real: { report: { hostAccess: string[] }; failure?: unknown }; timed: unknown; memory?: { kind: string } };
    expect(result.real.failure).toBeUndefined();
    expect(result.real.report.hostAccess).toEqual(['bind mount /etc']);
    expect(result.timed).toEqual({ kind: 'limit', reason: 'it took longer than 500 ms' });
    expect(result.memory?.kind).toBe('limit');
  });
});
