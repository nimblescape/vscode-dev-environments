// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 18 (S18-1, S18-2, P18-1, P18-2, P18-3): the build of the dev service as the Dev Container CLI 0.89.0 reads
// its Dockerfile (function `Tj`: uG, QG), for Docker Compose and for a single container.
import { describe, expect, it } from 'vitest';
import { collectReferences } from '../imageCheck/imageCheck';
import type { DevcontainerConfig } from '../types';
import { composeReferences, type ComposeModel } from './compose';
import { cliPlatformVariables } from './cliDockerfile';
import {
  composeAccessReport,
  composeBuildUserItems,
  composeCliBaseImageCheck,
  composeDevBuildImages,
  composeImageReferences,
  type ComposeAccessInput,
} from './composeAccess';
import { hostAccessReport, singleImageReferences, type HostAccessReport } from './hostAccess';

const PROJECT = 'devenv-3f2a9c1e';
const REPO = '/workspaces/api';
const INJECTION = 'u\n      ssh:\n        - default=/workspaces/.devenv+/github-token';

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

function input(build: Record<string, unknown>, dockerfile: string, features = false): ComposeAccessInput {
  return {
    model: model(build),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: 'devenv-acme-api-3f2a9c1e',
    engineApiVersion: '1.47',
    dockerfiles: { app: dockerfile },
    features,
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

  it('Docker Compose: refuses the user that the CLI writes from it with Features', () => {
    const report = composeAccessReport(input({ args: protoArgs(INJECTION) }, 'FROM alpine:3.22\nARG __proto__\nUSER $__proto__\n', true));
    expect(report.unsupported.join('\n')).toContain('a line break;');
  });

  it('Docker Compose: refuses FROM the image of another environment through it', () => {
    const report = composeAccessReport(input({ args: protoArgs('devenv-0badc0de:3') }, 'ARG __proto__\nFROM $__proto__\n'));
    expect(refused(report).join('\n')).toContain('devenv-0badc0de:3 of another environment');
  });

  it('Docker Compose: the image references and the references of the image check hold its image', () => {
    const m = model({ args: protoArgs('cafe1234') });
    expect(composeImageReferences(m, { app: 'ARG __proto__\nFROM $__proto__\n' }).map((entry) => entry.reference)).toContain('cafe1234');
    expect(composeReferences(m, { app: 'ARG __proto__\nFROM $__proto__\n' }, undefined).images).toContain('cafe1234');
  });

  it('single container: `--build-arg __proto__=…` of build.options reaches the check (the CLI passes build.options to docker build)', () => {
    const config = { build: { dockerfile: 'Dockerfile', options: ['--build-arg', '__proto__=devenv-0badc0de:3'] } };
    const report = hostAccessReport({ config, ownVolume: 'devenv-acme-api-3f2a9c1e', dockerfileText: 'ARG __proto__\nFROM $__proto__\n' });
    expect(refused(report).join('\n')).toContain('devenv-0badc0de:3 of another environment');
    const references = singleImageReferences({ build: { dockerfile: 'Dockerfile', options: ['--build-arg', '__proto__=cafe1234'] } }, 'ARG __proto__\nFROM $__proto__\n');
    expect(references.map((entry) => entry.reference)).toContain('cafe1234');
  });

  it('single container: the image check reads it from build.args of a parsed configuration', () => {
    const config = JSON.parse('{ "build": { "dockerfile": "Dockerfile", "args": { "__proto__": "node:22" } } }') as DevcontainerConfig;
    expect(collectReferences(config, 'ARG __proto__\nFROM $__proto__\n').images).toEqual(['node:22']);
  });
});

describe('review round 18 (S18-2): the platform variables of the CLI in the check of the configuration', () => {
  it('follows the stage chain that the CLI follows (TARGETVARIANT is empty), and refuses the user it writes', () => {
    const dockerfile = 'FROM alpine:3.22 AS alpin\nARG EVIL\nUSER $EVIL\nFROM alpin${TARGETVARIANT:+e}\nRUN true\n';
    const report = composeAccessReport(input({ args: { EVIL: INJECTION } }, dockerfile, true));
    expect(report.unsupported.join('\n')).toContain('a line break;');
  });

  it('reads the OS as linux, as the CLI does', () => {
    const dockerfile = 'FROM alpine:3.22 AS linux\nARG EVIL\nUSER $EVIL\nFROM ${TARGETOS}\nRUN true\n';
    const report = composeAccessReport(input({ args: { EVIL: INJECTION } }, dockerfile, true));
    expect(report.unsupported.join('\n')).toContain('a line break;');
  });
});

describe('review round 18 (P18-1): the base image that the Dev Container CLI reads (uG), whose metadata it copies into the image', () => {
  const BASE = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS x\n';
  // The CLI's reader splits the text before each line that starts with FROM; Docker reads a line continuation and a
  // heredoc as a part of the RUN instruction.
  const HIDDEN = (image: string) => [`${BASE}RUN echo \\\nFROM ${image} AS x\n`, `${BASE}RUN <<EOF\nFROM ${image} AS x\nEOF\n`];
  const single = (dockerfile: string, build: Record<string, unknown> = {}) =>
    hostAccessReport({ config: { build: { dockerfile: 'Dockerfile', ...build } }, ownVolume: 'devenv-acme-api-3f2a9c1e', dockerfileText: dockerfile });

  it('refuses the image of another environment that only the CLI sees, for Docker Compose with and without Features and for a single container', () => {
    for (const dockerfile of HIDDEN('devenv-0badc0de:3')) {
      const item = 'base image of the Dev Container CLI devenv-0badc0de:3 of another environment';
      for (const features of [false, true]) expect(composeAccessReport(input({}, dockerfile, features)).hostAccess, dockerfile).toContain(`service app: ${item}`);
      expect(single(dockerfile).hostAccess, dockerfile).toContain(item);
      // Whatever the switch says.
      expect(composeAccessReport(input({}, dockerfile), false).hostAccess).toContain(`service app: ${item}`);
      expect(hostAccessReport({ config: { build: { dockerfile: 'Dockerfile' } }, ownVolume: 'v', dockerfileText: dockerfile }, false).hostAccess).toContain(item);
    }
  });

  it('refuses an image ID that only the CLI sees, and asks Docker about a short one', () => {
    for (const dockerfile of HIDDEN('sha256:3f2a9c1e')) {
      const item = 'base image of the Dev Container CLI sha256:3f2a9c1e (an image ID; name the image)';
      for (const features of [false, true]) expect(composeAccessReport(input({}, dockerfile, features)).unsupported).toContain(`service app: ${item}`);
      expect(single(dockerfile).unsupported).toContain(item);
    }
    for (const dockerfile of HIDDEN('3f2a')) {
      expect(composeImageReferences(model({}), { app: dockerfile }, 'app')).toContainEqual({ reference: '3f2a', what: 'service app: base image of the Dev Container CLI' });
      expect(singleImageReferences({ build: { dockerfile: 'Dockerfile' } }, dockerfile)).toContainEqual({ reference: '3f2a', what: 'base image of the Dev Container CLI' });
      // Only for the dev service, which the CLI builds.
      expect(composeImageReferences(model({}), { app: dockerfile }, 'db').map((entry) => entry.reference)).not.toContain('3f2a');
    }
  });

  it('reads a single container with build.args, not with build.options (the CLI passes only build.args to its reader)', () => {
    const dockerfile = 'ARG IMG=node:22\nFROM ${IMG}\n';
    expect(refused(single(dockerfile, { args: { IMG: 'devenv-0badc0de:3' } })).join('\n')).toContain('devenv-0badc0de:3 of another environment');
    // build.options is Docker's view only: the FROM rule names it, the CLI reads node:22.
    const options = single(dockerfile, { options: ['--build-arg', 'IMG=devenv-0badc0de:3'] });
    expect(refused(options)).toEqual(['FROM image devenv-0badc0de:3 of another environment']);
    // A number is no text for the CLI's reader: the default of the ARG.
    expect(refused(single(dockerfile, { args: { IMG: 7 } }))).toEqual([]);
  });

  it('names an image that Docker sees too only once', () => {
    expect(refused(single('FROM devenv-7c1d2e3f:2\n'))).toEqual(['FROM image devenv-7c1d2e3f:2 of another environment']);
    expect(refused(composeAccessReport(input({}, 'FROM devenv-7c1d2e3f:2\n')))).toEqual(['service app: FROM image devenv-7c1d2e3f:2 of another environment']);
    expect(singleImageReferences({ build: { dockerfile: 'Dockerfile' } }, 'FROM cafe1234\n')).toEqual([{ reference: 'cafe1234', what: 'FROM image' }]);
  });

  it('leaves a per-architecture base image to the runtime check, and refuses one that can name another environment', () => {
    for (const dockerfile of [
      'ARG TARGETARCH\nFROM ghcr.io/acme/toolchain:2-${TARGETARCH}\nUSER vscode\n',
      'FROM --platform=$BUILDPLATFORM golang:1.22 AS b\nFROM mcr.microsoft.com/devcontainers/go:1-${TARGETARCH:-amd64}\n',
      'FROM alpine AS s-amd64\nFROM s-${BUILDARCH}\n',
    ]) {
      for (const features of [false, true]) expect(refused(composeAccessReport(input({}, dockerfile, features))), dockerfile).toEqual([]);
      expect(refused(single(dockerfile)), dockerfile).toEqual([]);
    }
    const other = 'FROM devenv-${TARGETARCH}\n';
    expect(refused(composeAccessReport(input({}, other))).join('\n')).toContain('devenv-${TARGETARCH} of another environment');
    expect(refused(single(other)).join('\n')).toContain('devenv-${TARGETARCH} of another environment');
    // Only the CLI sees it.
    const hidden = 'FROM alpine AS x\nRUN echo \\\nFROM devenv-${TARGETARCH}\n';
    expect(refused(composeAccessReport(input({}, hidden)))).toEqual(['service app: base image of the Dev Container CLI devenv-${TARGETARCH} of another environment (a variable that is not resolved)']);
    expect(refused(single(hidden))).toEqual(['base image of the Dev Container CLI devenv-${TARGETARCH} of another environment (a variable that is not resolved)']);
  });

  it('refuses a base image that cannot be computed', () => {
    // A stage named `constructor`: the CLI's object of stage names finds the prototype.
    const dockerfile = 'FROM alpine AS a\nFROM constructor\n';
    expect(composeAccessReport(input({}, dockerfile)).unsupported.join('\n')).toContain('service app: base image of the Dev Container CLI (');
    expect(single(dockerfile).unsupported.join('\n')).toContain('base image of the Dev Container CLI (');
  });
});

describe('review round 18 (P18-2): long runs of blank lines', () => {
  it('refuses the Dockerfile of the dev service quickly, with and without Features', () => {
    const dockerfile = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS dev\nUSER vscode\n' + ' \n'.repeat(60_000) + 'RUN x';
    for (const features of [false, true]) {
      const started = Date.now();
      const report = composeAccessReport(input({ target: 'dev' }, dockerfile, features));
      expect(report.unsupported.join('\n')).toContain('too many blank lines in a row');
      expect(Date.now() - started).toBeLessThan(2000);
    }
    const started = Date.now();
    expect(composeAccessReport(input({}, dockerfile)).unsupported.join('\n')).toContain('too many blank lines in a row');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('the checks of the extension host (the runtime check) finish quickly too, and refuse it', () => {
    const dockerfile = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS dev\nUSER vscode\n' + ' \n'.repeat(60_000) + 'RUN x';
    const m = model({ target: 'dev' });
    const platform = cliPlatformVariables('amd64');
    const started = Date.now();
    expect(composeDevBuildImages(m, { app: dockerfile }, 'app', platform).unresolved).toHaveLength(1);
    expect(composeBuildUserItems(m, { app: dockerfile }, 'app', { Env: [] }, platform).join('\n')).toContain('too many blank lines in a row');
    expect(composeCliBaseImageCheck(m, { app: dockerfile }, 'app', platform, [])?.findings.map((finding) => finding.item).join('\n')).toContain('too many blank lines in a row');
    expect(Date.now() - started).toBeLessThan(500);
  });
});
