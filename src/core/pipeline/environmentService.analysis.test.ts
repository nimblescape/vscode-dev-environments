// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 8 (structural fix of the parser DoS class): the open pipeline with the host access analysis in the real
// worker bundle (WorkerConfigurationAnalyzer, as the extension runs it). A normal configuration opens as before; a
// failed analysis (too slow, too much memory, a worker that does not start) refuses the configuration before anything
// is built.
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { ANALYSIS_FAILED_ITEM, analysisInternalItem } from '../helper/configurationAnalysis';
import { ANALYSIS_LIMITS, WorkerConfigurationAnalyzer, type AnalysisLimits } from '../helper/configurationAnalysisRunner';
import { Messages } from '../messages';
import type { RepositoryTarget } from './environmentService';
import { REPO, createHarness, type Harness } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const FAILED_LINE = /^The host access analysis of the configuration failed \((.*)\); the configuration is refused\.$/;

let outDir: string;
let bundle: string;
let h: Harness | undefined;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  bundle = path.join(outDir, 'configurationAnalysisWorker.js');
  // Same options as esbuild.mjs.
  buildSync({
    entryPoints: [path.join(__dirname, '..', 'helper', 'configurationAnalysisWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundle,
    logLevel: 'silent',
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify('0.0.0') },
  });
});

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** A harness whose pipeline analyses in the worker at `script` with `limits`. */
function harness(limits: Partial<AnalysisLimits> = {}, script = bundle): Harness {
  let created: Harness | undefined;
  const logger = { warn: (message: string) => created?.logger.warn(message) };
  created = createHarness({ analyzer: new WorkerConfigurationAnalyzer(script, logger, { ...ANALYSIS_LIMITS, ...limits }) });
  h = created;
  return created;
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UserFacingError);
    return error as UserFacingError;
  }
  throw new Error('The promise did not reject.');
}

/** A single container with this Dockerfile. */
function withDockerfile(harness: Harness, dockerfileText: string): void {
  harness.helper.config = { build: { dockerfile: 'Dockerfile' }, features: {} };
  harness.helper.files[DEFAULT_CONFIG_PATH] = { configText: '{ "build": { "dockerfile": "Dockerfile" } }', dockerfilePath: '.devcontainer/Dockerfile', dockerfileText };
}

describe('the open pipeline with the host access analysis in the worker (review round 8)', () => {
  it('opens a normal configuration as before', async () => {
    const worker = harness();
    withDockerfile(worker, 'ARG VARIANT=22\nFROM node:${VARIANT} AS build\nFROM ubuntu:24.04\n');
    await worker.service.open(TARGET, { progress: worker.progress });
    // The same as with the analysis in this thread.
    const local = createHarness();
    try {
      withDockerfile(local, 'ARG VARIANT=22\nFROM node:${VARIANT} AS build\nFROM ubuntu:24.04\n');
      await local.service.open(TARGET, { progress: local.progress });
      // User decisions 2026-10-03: the name of the environment (resourceName) instead of the short ID, which is gone.
      const names = new Map<Harness, string>();
      for (const one of [worker, local]) names.set(one, (await one.registry.list())[0].volumeName);
      const calls = (harness: Harness): string[] => harness.helper.calls.map((call) => call.split(names.get(harness)!).join('<name>'));
      expect(calls(worker)).toEqual(calls(local));
      expect(calls(worker)).toContain('build <name>:1');
      expect(worker.checker.calls).toEqual(local.checker.calls);
      expect(worker.checker.calls.at(-1)?.images).toEqual(['node:22', 'ubuntu:24.04']);
    } finally {
      local.cleanup();
    }
    expect(worker.logger.warnings.filter((line) => FAILED_LINE.test(line))).toEqual([]);
  });

  it('refuses the configuration when the worker does not start, before anything is built', async () => {
    const failing = harness({}, path.join(outDir, 'missing.js'));
    const error = await rejection(failing.service.open(TARGET, { progress: failing.progress }));
    expect(error.code).toBe('hostAccess');
    // Review round 9, P9-2: an internal error, not "too complex, change the configuration" (the configuration is not to
    // blame); still refused.
    expect(error.message).toMatch(/^The configuration check failed to start \(internal error\): the worker did not start: .*\. Try again; if it fails again, reinstall Dev Environments\.$/);
    expect(failing.helper.builds).toEqual([]);
    expect(failing.helper.ups).toEqual([]);
    expect(failing.logger.warnings.filter((line) => FAILED_LINE.test(line))).toHaveLength(1);
  });

  it('refuses the configuration when the analysis takes longer than its time limit', async () => {
    const slow = harness({ timeoutMs: 1 });
    const error = await rejection(slow.service.open(TARGET, { progress: slow.progress }));
    // Review round 9, P9-2: within 1 ms the worker is not even running: that is no limit of the configuration.
    expect(error.message).toBe(Messages.configurationCheckInternal(analysisInternalItem('the worker did not start within 1 ms')));
    expect(slow.helper.builds).toEqual([]);
    expect(slow.logger.warnings.filter((line) => FAILED_LINE.test(line))).toEqual([
      'The host access analysis of the configuration failed (the worker did not start within 1 ms); the configuration is refused.',
    ]);
  });

  it('allows a Dockerfile whose expansions grow without bound (S8-2), within 2 s', async () => {
    const worker = harness();
    const head = `ARG B0=€€€€€€€€€€€€€€€€\n${Array.from({ length: 13 }, (_, i) => `ARG B${i + 1}=\${B${i}}\${B${i}}`).join('\n')}\n`;
    const body = Array.from({ length: 200 }, (_, l) => `ARG ${Array.from({ length: 50 }, (_, k) => `X${l * 50 + k}=a$B13`).join(' ')}`).join('\n');
    withDockerfile(worker, `${head}${body}\nFROM alpine\n`);
    const start = performance.now();
    await worker.service.open(TARGET, { progress: worker.progress });
    expect(performance.now() - start).toBeLessThan(2000);
    // Dockerfile refusals removed (user decision 2026-09-27): before, `Dockerfile (the Dockerfile is too complex to check)`;
    // the update check skips it (no base images).
    expect(worker.helper.builds).toHaveLength(1);
    expect(worker.checker.calls.at(-1)?.images ?? []).toEqual([]);
  });
});
