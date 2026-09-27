// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 19 (S19-3, P19-2): the base image that the Dev Container CLI 0.89.0 reads for the build of a single
// container, with its build arguments as the CLI holds them (null-prototype) and with a variable that it resolves to ''.
import { describe, expect, it } from 'vitest';
import { cliBaseImage, cliPlatformVariables, parseCliDockerfile } from './cliDockerfile';
import { cliBaseImageCheck, hostAccessReport, singleCliBaseImageCheck, singleImageReferences } from './hostAccess';

const OWN_VOLUME = 'devenv-acme-api-3f2a9c1e';
const OTHER = 'devenv-0badc0de:3';

/** A Dockerfile whose last FROM line only the CLI reads (a line continuation), with an ARG of the name `name`. */
function dockerfile(name: string): string {
  return `ARG ${name}=${OTHER}\nFROM mcr.microsoft.com/devcontainers/base:bookworm AS x\nRUN echo \\\nFROM \${${name}:-alpine}\n`;
}

describe('review round 19 (S19-3): the build arguments of a single container are null-prototype, as in the CLI', () => {
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    it(`an ARG named ${name} resolves as in the CLI (the image of another environment is refused)`, () => {
      const text = dockerfile(name);
      // devcontainer.json as read-configuration prints it (JSON), with build.args.
      const config = JSON.parse('{"build":{"dockerfile":"Dockerfile","args":{"A":"1"}}}') as Record<string, unknown>;
      // What the CLI resolves (its substituted args: Object.create(null) with the own keys).
      const cliArgs = Object.assign(Object.create(null), { A: '1' }) as Record<string, unknown>;
      expect(cliBaseImage(parseCliDockerfile(text), cliArgs, undefined, cliPlatformVariables('amd64'))).toBe(OTHER);
      // Statically and at runtime.
      const report = hostAccessReport({ config, ownVolume: OWN_VOLUME, dockerfileText: text });
      expect([...report.hostAccess, ...report.unsupported].join('\n')).toContain('devenv-0badc0de');
      const runtime = singleCliBaseImageCheck(config, text, cliPlatformVariables('amd64'), []);
      expect(runtime.findings.map((finding) => finding.item).join('\n')).toContain('devenv-0badc0de');
    });

    it(`an ARG named ${name} without build.args: the plain object of the CLI (\`args || {}\`)`, () => {
      const text = dockerfile(name);
      const config = { build: { dockerfile: 'Dockerfile' } };
      const cli = (() => {
        try {
          return cliBaseImage(parseCliDockerfile(text), {}, undefined, cliPlatformVariables('amd64'));
        } catch {
          return 'error';
        }
      })();
      const runtime = singleCliBaseImageCheck(config, text, cliPlatformVariables('amd64'), []);
      if (cli === OTHER) expect(runtime.findings.map((finding) => finding.item).join('\n')).toContain('devenv-0badc0de');
      else expect(runtime.reference?.reference).not.toBe(OTHER);
    });
  }

  it('an own build argument of that name still counts', () => {
    const config = JSON.parse('{"build":{"dockerfile":"Dockerfile","args":{"constructor":"mcr.microsoft.com/devcontainers/base:ubuntu"}}}') as Record<string, unknown>;
    const check = singleCliBaseImageCheck(config, dockerfile('constructor'), cliPlatformVariables('amd64'), []);
    expect(check).toEqual({ findings: [], reference: { reference: 'mcr.microsoft.com/devcontainers/base:ubuntu', what: 'base image of the Dev Container CLI' } });
  });
});

describe('review round 19 (P19-2): a base image that the CLI resolves to the empty text is not inspected', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ build: { dockerfile: 'Dockerfile', options: ['--build-arg', 'BASE=mcr.microsoft.com/devcontainers/base:ubuntu'] } }, 'ARG BASE\nFROM ${BASE}\n'],
    [{ build: { dockerfile: 'Dockerfile', options: ['--build-arg=BASE=mcr.microsoft.com/devcontainers/base:ubuntu'] } }, 'ARG BASE\nFROM $BASE\n'],
  ];
  for (const [config, text] of cases) {
    it(`no finding and no reference: ${text.split('\n')[1]}`, () => {
      expect(singleCliBaseImageCheck(config, text)).toEqual({ findings: [] });
      expect(singleCliBaseImageCheck(config, text, cliPlatformVariables('amd64'))).toEqual({ findings: [] });
      expect(singleCliBaseImageCheck(config, text, cliPlatformVariables('arm64'), [])).toEqual({ findings: [] });
      const report = hostAccessReport({ config, ownVolume: OWN_VOLUME, dockerfileText: text });
      expect(report).toEqual({ hostAccess: [], unsupported: [] });
      expect(singleImageReferences(config, text).map((entry) => entry.reference)).toEqual(['mcr.microsoft.com/devcontainers/base:ubuntu']);
    });
  }

  it('only the empty text: any other resolved text is still checked', () => {
    expect(cliBaseImageCheck('FROM ${B}x\n', {}, undefined)).toEqual({ findings: [], reference: { reference: 'x', what: 'base image of the Dev Container CLI' } });
    expect(cliBaseImageCheck('ARG B\nFROM ${B}\n', { B: 'devenv-0badc0de:3' }, undefined).findings).not.toEqual([]);
    // A blank is not the empty text: the CLI inspects it, so it stays a reference (refused as an invalid one).
    expect(cliBaseImageCheck('ARG B\nFROM ${B}\n', { B: ' ' }, undefined).reference).toBeDefined();
  });
});
