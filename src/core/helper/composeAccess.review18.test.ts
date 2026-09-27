// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 18 (S18-1, P18-2): a build argument named `__proto__` (Docker Compose and single container), and the time
// of the check of the last stage name of the Dockerfile of the dev service.
import { describe, expect, it } from 'vitest';
import { collectReferences } from '../imageCheck/imageCheck';
import type { DevcontainerConfig } from '../types';
import { composeReferences, type ComposeModel } from './compose';
import { MAX_DOCKERFILE_LENGTH } from '../imageCheck/dockerfile';
import { composeAccessReport, composeImageReferences, type ComposeAccessInput } from './composeAccess';
import { runAnalysisJob } from './configurationAnalysis';
import { singleImageReferences, type HostAccessReport } from './hostAccess';

const PROJECT = 'devenv-3f2a9c1e';
const REPO = '/workspaces/api';

/** A model of `docker compose config` whose dev service builds with `build` (parsed from JSON, as the model run does). */
function model(build: Record<string, unknown>): ComposeModel {
  return JSON.parse(
    JSON.stringify({
      name: PROJECT,
      services: { app: { build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile', ...build }, command: ['sleep', 'infinity'] } },
    }),
  ) as ComposeModel;
}

/** A build argument named `__proto__` as an own property (JSON.parse, js-yaml, and Object.fromEntries keep it so). */
function protoArgs(value: string): Record<string, unknown> {
  return JSON.parse(`{ "__proto__": ${JSON.stringify(value)} }`) as Record<string, unknown>;
}

function input(build: Record<string, unknown>, dockerfile: string): ComposeAccessInput {
  return {
    model: model(build),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: 'devenv-acme-api-3f2a9c1e',
    engineApiVersion: '1.47',
    dockerfiles: { app: dockerfile },
  };
}

function refused(report: HostAccessReport): string[] {
  return [...report.hostAccess, ...report.unsupported];
}

describe('review round 18 (S18-1): a build argument named __proto__', () => {
  it('is an own property of the parsed model', () => {
    const args = protoArgs('x');
    expect(Object.keys(args)).toEqual(['__proto__']);
  });

  it('Docker Compose: allows FROM the image of another environment through it', () => {
    const report = composeAccessReport(input({ args: protoArgs('devenv-0badc0de:3') }, 'ARG __proto__\nFROM $__proto__\n'));
    // Dockerfile refusals removed (user decision 2026-09-27): before, `… devenv-0badc0de:3 of another environment`.
    expect(refused(report)).toEqual([]);
  });

  it('Docker Compose: the references of the image check hold its image', () => {
    const m = model({ args: protoArgs('cafe1234') });
    // Dockerfile refusals removed (user decision 2026-09-27): the Dockerfile images are no image references for the
    // question of image IDs any more (before: `cafe1234`).
    expect(composeImageReferences(m)).toEqual([]);
    expect(composeReferences(m, { app: 'ARG __proto__\nFROM $__proto__\n' }, undefined).images).toContain('cafe1234');
  });

  it('single container: `--build-arg __proto__=…` of build.options is allowed with the Dockerfile', () => {
    const config = { build: { dockerfile: 'Dockerfile', options: ['--build-arg', '__proto__=devenv-0badc0de:3'] } };
    const analysis = runAnalysisJob({ kind: 'single', input: { config, ownVolume: 'devenv-acme-api-3f2a9c1e' }, checksOn: true, config, dockerfileText: 'ARG __proto__\nFROM $__proto__\n' });
    // Dockerfile refusals removed (user decision 2026-09-27): before, `… devenv-0badc0de:3 of another environment`, and
    // `cafe1234` was an image reference for the question of image IDs.
    expect(refused(analysis.report)).toEqual([]);
    expect(analysis.imageReferences).toEqual([]);
    expect(singleImageReferences({ build: { dockerfile: 'Dockerfile', options: ['--build-arg', '__proto__=cafe1234'] } })).toEqual([]);
  });

  it('single container: the image check reads it from build.args of a parsed configuration', () => {
    const config = JSON.parse('{ "build": { "dockerfile": "Dockerfile", "args": { "__proto__": "node:22" } } }') as DevcontainerConfig;
    expect(collectReferences(config, 'ARG __proto__\nFROM $__proto__\n').images).toEqual(['node:22']);
  });
});

describe('Docker\'s view: an image of the Dockerfile', () => {
  const config = { build: { dockerfile: 'Dockerfile' } };
  const single = (dockerfile: string) =>
    runAnalysisJob({ kind: 'single', input: { config, ownVolume: 'devenv-acme-api-3f2a9c1e' }, checksOn: true, config, dockerfileText: dockerfile });

  it('allows an image of another environment, and names it only for the update check', () => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM image devenv-7c1d2e3f:2 of another environment`
    // (single and Compose), and `cafe1234` was an image reference for the question of image IDs.
    expect(refused(single('FROM devenv-7c1d2e3f:2\n').report)).toEqual([]);
    expect(refused(composeAccessReport(input({}, 'FROM devenv-7c1d2e3f:2\n')))).toEqual([]);
    expect(single('FROM cafe1234\n').imageReferences).toEqual([]);
    expect(single('FROM cafe1234\n').references.images).toEqual(['cafe1234']);
  });

  it('refuses a Dockerfile of the dev service that is longer than the model run reads (the build writes the text it read)', () => {
    const long = `FROM alpine\n# ${'x'.repeat(MAX_DOCKERFILE_LENGTH)}\n`;
    expect(composeAccessReport(input({}, long)).unsupported).toEqual([
      `service app: the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the dev service is built from the text that Dev Environments read)`,
    ]);
    expect(composeAccessReport(input({}, long), false).unsupported).toHaveLength(1);
    // review, U1/U2: the same Dockerfile of another service is refused too (a size limit): the configuration hash sees
    // only the text that the model run read, so an edit after it would offer no rebuild.
    const other: ComposeAccessInput = { ...input({}, 'FROM alpine\n'), model: { name: PROJECT, services: { ...model({}).services, db: { build: { context: REPO } } } }, dockerfiles: { app: 'FROM alpine\n', db: long } };
    expect(composeAccessReport(other)).toEqual({
      hostAccess: [],
      unsupported: [`service db: the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the Dockerfile is too large)`],
    });
  });

  it('U1: refuses a Dockerfile of a side service of MAX_DOCKERFILE_LENGTH + 1 characters, whatever the switch says', () => {
    const long = `FROM alpine\n#${'x'.repeat(MAX_DOCKERFILE_LENGTH - 12)}`;
    expect(long.length).toBe(MAX_DOCKERFILE_LENGTH + 1);
    const side = (text: string): ComposeAccessInput => ({
      ...input({}, 'FROM alpine\n'),
      model: { name: PROJECT, services: { ...model({}).services, db: { build: { context: REPO } } } },
      dockerfiles: { app: 'FROM alpine\n', db: text },
    });
    const item = `service db: the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the Dockerfile is too large)`;
    expect(composeAccessReport(side(long)).unsupported).toEqual([item]);
    expect(composeAccessReport(side(long), false).unsupported).toEqual([item]);
    // A Dockerfile of exactly MAX_DOCKERFILE_LENGTH characters, and a normal one, are allowed.
    expect(composeAccessReport(side(long.slice(0, -1)))).toEqual({ hostAccess: [], unsupported: [] });
    expect(composeAccessReport(side('FROM alpine\nRUN echo hi\n'))).toEqual({ hostAccess: [], unsupported: [] });
  });
});

describe('review round 18 (P18-2): long runs of blank lines', () => {
  it('refuses the Dockerfile of the dev service quickly when its last stage name is read', () => {
    const dockerfile = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS dev\nUSER vscode\n' + ' \n'.repeat(60_000) + 'RUN x';
    const started = Date.now();
    expect(composeAccessReport(input({}, dockerfile)).unsupported.join('\n')).toContain('too many blank lines in a row');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('with a build target, the last stage name is not read, and the check finishes quickly', () => {
    // slim-down: the user that the Dev Container CLI computes with Features (its reader) is no longer modelled, so with a
    // target nothing reads the whole Dockerfile line by line; the check must still be fast and refuse nothing.
    const dockerfile = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS dev\nUSER vscode\n' + ' \n'.repeat(60_000) + 'RUN x';
    const started = Date.now();
    expect(composeAccessReport(input({ target: 'dev' }, dockerfile)).unsupported.join('\n')).not.toContain('too many blank lines in a row');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
