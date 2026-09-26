// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 8 (structural fix of the parser DoS class): the host access analysis in the real worker bundle (as
// esbuild.mjs builds dist/configurationAnalysisWorker.js), with its limits of time and memory, and the refusal of every
// failure (fail closed).
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComposeModel } from './compose';
import type { ComposeAccessInput } from './composeAccess';
import { ANALYSIS_FAILED_ITEM, analysisFailure, analysisInternalItem, inProcessAnalyzer, runAnalysisJob, type AnalysisJob } from './configurationAnalysis';
import { ANALYSIS_LIMITS, WorkerConfigurationAnalyzer, type AnalysisLimits } from './configurationAnalysisRunner';

const ROOT = path.join(__dirname, '..', '..', '..');
const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = 'devenv-3f2a9c1e';
const OWN = 'devenv-acme-api-3f2a9c1e';
const REPO = '/workspaces/api';
const REFUSED = { hostAccess: [], unsupported: [ANALYSIS_FAILED_ITEM] };

let outDir: string;
let bundle: string;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  bundle = path.join(outDir, 'configurationAnalysisWorker.js');
  // Same options as esbuild.mjs.
  buildSync({
    entryPoints: [path.join(__dirname, 'configurationAnalysisWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundle,
    logLevel: 'silent',
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify('0.0.0') },
  });
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** A logger that keeps the warnings. */
function warnings(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message) => void lines.push(message), lines };
}

function analyzer(limits: Partial<AnalysisLimits> = {}, logger = warnings()): WorkerConfigurationAnalyzer {
  return new WorkerConfigurationAnalyzer(bundle, logger, { ...ANALYSIS_LIMITS, ...limits });
}

function composeInput(model: ComposeModel, extra: Partial<ComposeAccessInput> = {}): ComposeAccessInput {
  return {
    model,
    devService: Object.keys(model.services)[0],
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: OWN,
    engineApiVersion: '1.47',
    environment: { id: ID, ownerId: '42' },
    ...extra,
  };
}

/** A single container with this Dockerfile. */
function singleJob(dockerfileText: string, config: Record<string, unknown> = { build: { dockerfile: 'Dockerfile' } }): AnalysisJob {
  return {
    kind: 'single',
    input: { config, ownVolume: OWN, configFolder: `${REPO}/.devcontainer`, repositoryFolder: REPO, dockerfileText },
    checksOn: true,
    config,
    dockerfileText,
  };
}

// The repros of review round 8 (r8-S), at the sizes of the review.
/** ARGs B0 … B13 that double their value, then `lines` ARGs of `form`, then FROM alpine. */
function doubling(first: string, lines: number, form: (i: number) => string): string {
  const head = `ARG B0=${first}\n${Array.from({ length: 13 }, (_, i) => `ARG B${i + 1}=\${B${i}}\${B${i}}`).join('\n')}\n`;
  const body: string[] = [];
  for (let l = 0; l < lines / 50; l++) body.push(`ARG ${Array.from({ length: 50 }, (_, k) => form(l * 50 + k)).join(' ')}`);
  return `${head}${body.join('\n')}\nFROM alpine\n`;
}
const BUDGET = `ARG A=${'a'.repeat(4000)}\nARG P=${'*a'.repeat(500)}b\n${Array.from({ length: 20 }, (_, i) => `FROM \${A#$P}${i}`).join('\n')}\n`;
const REPROS: Array<{ name: string; job: AnalysisJob; refused: boolean }> = [
  // S8-2: 10000 ARGs of 64 KiB each (extractBaseImages: base; dockerfileImageFindings: mem4).
  { name: 'mem4 and base', job: singleJob(doubling('€€€€€€€€€€€€€€€€', 10_000, (i) => `X${i}=a$B13`)), refused: true },
  // S8-1: 1000 forms on a value of 64 KiB (their results are not used: the Dockerfile passes).
  { name: 'trim', job: singleJob(doubling('xxxxxxxxxxxxxxxy', 1000, () => 'X=${B13%x}')), refused: false },
  // S7-1 / S8-1: the budget of the pattern matcher.
  { name: 'budget', job: singleJob(BUDGET), refused: true },
  // S8-3: a directive with 40000 spaces (a valid Dockerfile).
  { name: 'directive', job: singleJob(`# check=a${' '.repeat(40_000)}b\nFROM alpine\n`), refused: false },
  // S8-5: 40000 bind mounts.
  {
    name: 'quadfind',
    job: {
      kind: 'compose',
      checksOn: true,
      input: composeInput({ name: PROJECT, services: { app: { image: 'alpine', volumes: Array.from({ length: 40_000 }, (_, i) => ({ type: 'bind', source: `/etc/x${i}`, target: `/x${i}` })) } } }),
    },
    refused: true,
  },
  // S8-4: 20 services with the Dockerfile of `budget`.
  {
    name: 'services',
    job: {
      kind: 'compose',
      checksOn: true,
      input: composeInput(
        { name: PROJECT, services: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { build: { context: REPO, dockerfile: 'Dockerfile' } }])) },
        { dockerfiles: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, BUDGET])) },
      ),
    },
    refused: true,
  },
];

describe('WorkerConfigurationAnalyzer', () => {
  it('gives the results of this thread for normal configurations', async () => {
    const worker = analyzer();
    const dockerfile = 'ARG VARIANT=3.12\nFROM mcr.microsoft.com/devcontainers/python:${VARIANT} AS base\nCOPY --from=base / /\nFROM base\n';
    const jobs: AnalysisJob[] = [
      singleJob(dockerfile, { build: { dockerfile: 'Dockerfile', args: { VARIANT: '3.11' } }, features: { 'ghcr.io/devcontainers/features/node:1': {} } }),
      singleJob('FROM devenv-11111111:1\n'),
      { kind: 'hostAccess', checksOn: true, input: { config: { runArgs: ['--privileged', '-p', '3000:3000'], mounts: ['type=bind,source=/,target=/host'] }, ownVolume: OWN } },
      { kind: 'hostAccess', checksOn: false, input: { config: { runArgs: ['--privileged'] }, ownVolume: OWN } },
      {
        kind: 'compose',
        checksOn: true,
        features: { 'ghcr.io/devcontainers/features/node:1': {} },
        input: composeInput(
          {
            name: PROJECT,
            services: {
              app: { build: { context: REPO, dockerfile: 'Dockerfile' }, volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces' }] },
              db: { image: 'postgres:16', restart: 'unless-stopped', volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }] },
              cache: { image: 'devenv-22222222:1', privileged: true },
            },
            volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
          },
          { dockerfiles: { app: dockerfile } },
        ),
      },
    ];
    for (const job of jobs) {
      const expected = runAnalysisJob(job);
      expect(await worker.analyze(job)).toEqual(expected);
      expect(await inProcessAnalyzer.analyze(job)).toEqual(expected);
    }
    // Not empty: the results say something.
    expect(runAnalysisJob(jobs[0])).toMatchObject({ references: { images: ['mcr.microsoft.com/devcontainers/python:3.11'], features: ['ghcr.io/devcontainers/features/node:1'] } });
    expect(runAnalysisJob(jobs[4]).report.hostAccess).toEqual(['service cache: image devenv-22222222:1 of another environment', 'service cache: privileged mode']);
  });

  it('finishes the repros of review round 8 in less than 2 s together, and refuses the hostile ones', async () => {
    const worker = analyzer();
    const start = performance.now();
    const results = await Promise.all(REPROS.map(async ({ job }) => worker.analyze(job)));
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(2000);
    REPROS.forEach(({ name, refused }, index) => {
      const report = results[index].report;
      expect(report.hostAccess.length + report.unsupported.length > 0, name).toBe(refused);
    });
    expect(results[0].report).toEqual({ hostAccess: [], unsupported: ['Dockerfile (the Dockerfile is too complex to check)'] });
  });

  it('refuses a job that takes longer than its time limit, and stops its worker', async () => {
    // 40 services with Dockerfiles that differ in a build argument (no cache): seconds in this thread.
    const services: ComposeModel['services'] = {};
    const dockerfiles: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      services[`s${i}`] = { build: { context: REPO, dockerfile: 'Dockerfile', args: { N: String(i) } } };
      dockerfiles[`s${i}`] = BUDGET;
    }
    const job: AnalysisJob = { kind: 'compose', checksOn: true, input: composeInput({ name: PROJECT, services }, { dockerfiles }) };
    const logger = warnings();
    const start = performance.now();
    const result = await analyzer({ timeoutMs: 300 }, logger).analyze(job);
    expect(performance.now() - start).toBeLessThan(1500);
    // Review round 9, P9-1: the result names the failure (a limit: the configuration is too complex).
    expect(result).toEqual(analysisFailure(job, { kind: 'limit', reason: 'it took longer than 300 ms' }));
    expect(result.report).toEqual(REFUSED);
    expect(logger.lines).toEqual(['The host access analysis of the configuration failed (it took longer than 300 ms); the configuration is refused.']);
  });

  // The test process runs with NODE_OPTIONS=--max-old-space-size (vitest.config.ts does not set it, the environment
  // may), where V8 ignores `resourceLimits`: the watch of the heap stops the worker.
  it('refuses a job whose worker runs out of memory', async () => {
    // 200000 bind mounts (their items alone take more than 8 MB) in a worker of 8 MB.
    const volumes = Array.from({ length: 200_000 }, (_, i) => ({ type: 'bind', source: `/etc/x${i}`, target: `/x${i}` }));
    const job: AnalysisJob = { kind: 'compose', checksOn: true, input: composeInput({ name: PROJECT, services: { app: { image: 'alpine', volumes } } }) };
    const logger = warnings();
    const start = performance.now();
    const result = await analyzer({ maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 1 }, logger).analyze(job);
    expect(performance.now() - start).toBeLessThan(2000);
    // Review round 9, P9-1: the result names the failure (a limit).
    expect(result).toEqual(analysisFailure(job, { kind: 'limit', reason: 'it used too much memory' }));
    expect(logger.lines).toEqual(['The host access analysis of the configuration failed (it used too much memory); the configuration is refused.']);
  });

  it('watches the memory of the whole process where the worker has no heap statistics (Node before 22.16)', async () => {
    const volumes = Array.from({ length: 200_000 }, (_, i) => ({ type: 'bind', source: `/etc/x${i}`, target: `/x${i}` }));
    const job: AnalysisJob = { kind: 'compose', checksOn: true, input: composeInput({ name: PROJECT, services: { app: { image: 'alpine', volumes } } }) };
    const own = Object.getOwnPropertyDescriptor(Worker.prototype, 'getHeapStatistics');
    Object.defineProperty(Worker.prototype, 'getHeapStatistics', { value: undefined, configurable: true, writable: true });
    try {
      const logger = warnings();
      const result = await analyzer({ maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 1 }, logger).analyze(job);
      // Review round 9, P9-1: the result names the failure (a limit).
      expect(result).toEqual(analysisFailure(job, { kind: 'limit', reason: 'it used too much memory' }));
      expect(logger.lines).toEqual(['The host access analysis of the configuration failed (it used too much memory); the configuration is refused.']);
    } finally {
      if (own) Object.defineProperty(Worker.prototype, 'getHeapStatistics', own);
      else delete (Worker.prototype as { getHeapStatistics?: unknown }).getHeapStatistics;
    }
  });

  it('refuses a job whose worker cannot start, crashes, ends, throws, or answers with anything but a result', async () => {
    const job: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { config: {}, ownVolume: OWN } };
    const scripts: Record<string, string> = {
      crash: 'throw new Error("crash");',
      exit: 'process.exit(3);',
      silent: 'require("worker_threads").parentPort.on("message", () => process.exit(0));',
      thrown: 'require("worker_threads").parentPort.on("message", () => require("worker_threads").parentPort.postMessage({ ok: false, error: "thrown" }));',
      garbage: 'require("worker_threads").parentPort.on("message", () => require("worker_threads").parentPort.postMessage({ ok: true, result: { report: { hostAccess: [1] } } }));',
      allow: 'require("worker_threads").parentPort.on("message", () => require("worker_threads").parentPort.postMessage({ ok: true, result: {} }));',
    };
    const paths = [path.join(outDir, 'missing.js')];
    for (const [name, text] of Object.entries(scripts)) {
      const file = path.join(outDir, `${name}.js`);
      fs.writeFileSync(file, text);
      paths.push(file);
    }
    // Review round 9, P9-2: none of them is a limit of the configuration: an internal error, with its own item (still
    // refused: never allowed).
    const internal = (result: { report: unknown; failure?: { kind: string; reason: string } }) => {
      expect(result.failure?.kind).toBe('internal');
      expect(result.report).toEqual({ hostAccess: [], unsupported: [analysisInternalItem(result.failure!.reason)] });
    };
    const reasons: string[] = [];
    for (const file of paths) {
      const logger = warnings();
      const result = await new WorkerConfigurationAnalyzer(file, logger, { ...ANALYSIS_LIMITS, timeoutMs: 5000 }).analyze(job);
      internal(result);
      reasons.push(result.failure!.reason);
      expect(logger.lines, file).toHaveLength(1);
    }
    expect(reasons[0]).toMatch(/^the worker did not start: /);
    expect(reasons.slice(1)).toEqual(['error: crash', 'the worker ended with exit code 3', 'the worker ended with exit code 0', 'error: thrown', 'an answer that is no result', 'an answer that is no result']);
    // A job that cannot be passed to a worker (a function is no structured clone).
    const unclonable = { kind: 'hostAccess', checksOn: true, input: { config: { f: () => 1 }, ownVolume: OWN } } as unknown as AnalysisJob;
    internal(await analyzer().analyze(unclonable));
    // A job that the analysis throws on, in this thread too.
    const unknown = { kind: 'other' } as unknown as AnalysisJob;
    const thrown = await analyzer().analyze(unknown);
    internal(thrown);
    expect(thrown).toMatchObject({ imageReferences: [], references: { images: [], features: [] } });
    internal(await inProcessAnalyzer.analyze(unknown));
  });

  it('refuses a job whose texts are larger than the budget before it is passed to a worker (review round 9, S9-2)', async () => {
    const logger = warnings();
    const worker = new WorkerConfigurationAnalyzer(bundle, logger, ANALYSIS_LIMITS, 1000);
    const job: AnalysisJob = singleJob(`FROM alpine\n# ${'a'.repeat(2000)}\n`);
    const result = await worker.analyze(job);
    expect(result.failure).toEqual({ kind: 'limit', reason: 'the configuration is larger than 0 million characters' });
    expect(result.report).toEqual(REFUSED);
    // Many small values count too.
    const many: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { config: { runArgs: Array.from({ length: 200 }, () => '') }, ownVolume: OWN } };
    expect((await worker.analyze(many)).failure?.kind).toBe('limit');
    // Within the budget: the worker runs it.
    expect((await new WorkerConfigurationAnalyzer(bundle, logger).analyze(job)).failure).toBeUndefined();
  });

  it('tells a worker that did not start in time apart from one that took too long (review round 9, P9-1, P9-2)', async () => {
    const file = path.join(outDir, 'slow-start.js');
    fs.writeFileSync(file, 'require("worker_threads").parentPort.on("message", () => { const t = Date.now(); while (Date.now() - t < 2000); });');
    const job: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { config: {}, ownVolume: OWN } };
    const result = await new WorkerConfigurationAnalyzer(file, warnings(), { ...ANALYSIS_LIMITS, timeoutMs: 300 }).analyze(job);
    expect(result.failure).toEqual({ kind: 'limit', reason: 'it took longer than 300 ms' });
    const early = await new WorkerConfigurationAnalyzer(file, warnings(), { ...ANALYSIS_LIMITS, timeoutMs: 1 }).analyze(job);
    expect(early.failure).toEqual({ kind: 'internal', reason: 'the worker did not start within 1 ms' });
  });

  it('is built by esbuild.mjs and included in the package', () => {
    expect(fs.readFileSync(path.join(ROOT, 'esbuild.mjs'), 'utf8')).toContain("entryPoints: ['src/core/helper/configurationAnalysisWorker.ts']");
    expect(fs.readFileSync(path.join(ROOT, 'esbuild.mjs'), 'utf8')).toContain("'dist/configurationAnalysisWorker.js'");
    expect(fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n')).toContain('!dist/configurationAnalysisWorker.js');
    expect(fs.readFileSync(path.join(ROOT, 'src', 'vscode', 'extension.ts'), 'utf8')).toContain(
      "new WorkerConfigurationAnalyzer(context.asAbsolutePath(path.join('dist', 'configurationAnalysisWorker.js')), logger)",
    );
  });
});
