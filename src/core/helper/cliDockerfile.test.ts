// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 17 (P17-1, P17-2): the port of the Dev Container CLI's reading of a Dockerfile against the CLI's own
// functions, loaded from the vendored bundle.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CLI_DOCKERFILE_BUDGET,
  CLI_MAX_BLANK_LINES,
  CLI_PLATFORM_VARIABLES,
  CliDockerfileError,
  cliArchitecture,
  cliBaseImage,
  cliEnvironment,
  cliImageUser,
  cliPlatformVariables,
  parseCliDockerfile,
} from './cliDockerfile';

const CLI_FOLDER = path.resolve(__dirname, '../../../node_modules/@devcontainers/cli');
const BUNDLE = fs.readFileSync(path.join(CLI_FOLDER, 'dist', 'spec-node', 'devContainersSpecCLI.js'), 'utf8');
// The regular expressions and the functions EG, Nj, QG, uG, bj, CG, Gj, Cg, Lj, cG of the CLI, one block of the bundle.
const START = BUNDLE.indexOf('Sj=/^');
const END = BUNDLE.indexOf('function DQ(');
const CLI_SOURCE = BUNDLE.slice(START, END);
/** The SHA-256 of that block in CLI 0.89.0: another value means that the port must be checked against the new CLI. */
const CLI_SOURCE_SHA256 = 'ac40d4302b2a60048182e04c2c5c989c08a8a0ca2b45f6d2a3f70791dc6efce5';

interface CliReader {
  EG: (text: string) => unknown;
  uG: (file: unknown, args: Record<string, unknown>, target: string | undefined, platform: Record<string, unknown>) => string | undefined;
  QG: (file: unknown, args: Record<string, unknown>, env: Record<string, unknown>, platform: Record<string, unknown>, target: string | undefined) => string | undefined;
}

const cli = new Function(`var ${CLI_SOURCE}\nreturn { EG, uG, QG };`)() as CliReader;
const ht = (entries: string[]) =>
  entries.reduce<Record<string, string>>((labels, entry) => {
    const index = entry.indexOf('=');
    if (index !== -1) labels[entry.substring(0, index)] = entry.substring(index + 1);
    return labels;
  }, {});

type Outcome = { value: string | undefined } | { error: true };
function outcome(run: () => string | undefined): Outcome {
  try {
    return { value: run() };
  } catch {
    return { error: true };
  }
}

/** Both readings of `dockerfile` for the base image and the user, ours and the CLI's. */
function compare(
  dockerfile: string,
  args: Record<string, unknown>,
  env: string[],
  target: string | undefined,
  ours: Readonly<Record<string, string>> = CLI_PLATFORM_VARIABLES,
): void {
  const platform = { ...ours };
  const file = parseCliDockerfile(dockerfile);
  const label = JSON.stringify({ dockerfile, args, env, target, platform });
  expect(outcome(() => cliBaseImage(file, { ...args }, target, ours)), label).toEqual(outcome(() => cli.uG(cli.EG(dockerfile), { ...args }, target, platform)));
  expect(outcome(() => cliImageUser(file, { ...args }, cliEnvironment(env), target, ours)), label).toEqual(
    outcome(() => cli.QG(cli.EG(dockerfile), { ...args }, ht(env), platform, target)),
  );
}

const DOCKERFILES = [
  'FROM mcr.microsoft.com/devcontainers/python:3.12 AS dev\nRUN x\nFROM registry.corp.example/prod/base:1 AS prod\nFROM nvidia/cuda:12.4.1 AS gpu\n',
  'ARG VARIANT=3.12\nFROM mcr.microsoft.com/devcontainers/python:${VARIANT} AS dev\nFROM gcr.io/private/prod:1 AS prod\nFROM --platform=$BUILDPLATFORM golang:1.22 AS b\n',
  'FROM mcr.microsoft.com/devcontainers/base:bookworm\nARG USERNAME=vscode\nARG EXTRA_CA_CERT\nRUN echo "$EXTRA_CA_CERT" > /x.crt\nUSER $USERNAME\n',
  'FROM node:22 AS base\nFROM base\nUSER node\n',
  'ARG V=22\nFROM node:${V}\nFROM scratch\nUSER $U\n',
  'FROM alpine AS a\nENV A=${B:-x}\nENV B=$A\nUSER ${A}:${B:+"q"}\n',
  'FROM alpine AS a\nUSER a\nFROM a AS b\nARG U\nFROM b AS c\nUSER ${U}\n',
  'FROM c AS a\nFROM a AS b\nFROM b AS c\n',
  'FROM alpine AS constructor\nFROM constructor\n',
  'ARG B=toString\nFROM ${B}\nUSER x\n',
  'FROM alpine\nENV X\nUSER $X\n',
  'FROM "alpine:3" AS "q"\nUSER "${HOME}"\n',
  'FROM --platform=linux/amd64 golang:${TARGETARCH}\nUSER ${TARGETOS}\n',
  '# syntax=docker/dockerfile:1\nARG IMG=debian\n  from ${IMG}:12 as Build\nuser ${IMG}\n',
  'RUN x\n',
  '',
  'FROM a AS x\nARG A=1\nFROM x\nARG A\nUSER $A\n',
  'ARG A=pre\nFROM alpine\nARG A\nUSER $A-${A:-d}-${NOPE:-d}-${A:+p}\n',
  // Review round 18 (S18-2, P18-3): the platform variables.
  'FROM alpine:3.22 AS alpin\nARG EVIL\nUSER $EVIL\nFROM alpin${TARGETVARIANT:+e}\nRUN true\n',
  'ARG TARGETARCH\nFROM ghcr.io/acme/toolchain:2-${TARGETARCH}\nUSER ${BUILDPLATFORM}:${TARGETOS:-x}${BUILDVARIANT:-v}\n',
  'FROM alpine AS s-amd64\nUSER a\nFROM alpine AS s-arm64\nUSER b\nFROM s-${TARGETARCH:-x}\n',
  'FROM --platform=$BUILDPLATFORM golang:1.22 AS b\nFROM mcr.microsoft.com/devcontainers/base:${TARGETOS:-bookworm}${TARGETVARIANT:+-v}\n',
];
const ARGS: Array<Record<string, unknown>> = [
  {},
  { USERNAME: 'root\n  ssh: x', U: 'a b', VARIANT: '3.11', A: 'v' },
  { EXTRA_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', USERNAME: 'vscode' },
  { constructor: 'x', B: 'alpine' },
];
const ENVS: string[][] = [[], ['HOME=/root', 'X=a\nb', 'U=from-env', 'A=env'], ['nothing', 'A=1=2']];
const TARGETS = [undefined, 'dev', 'prod', 'a', 'b', 'c', 'constructor', '__proto__', 'missing', 'Build'];

describe('cliDockerfile: as Dev Container CLI 0.89.0 reads a Dockerfile (review round 17, P17-1, P17-2)', () => {
  it('the block of the CLI is the one that the port follows', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLI_FOLDER, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.89.0');
    expect(START).toBeGreaterThan(0);
    expect(END).toBeGreaterThan(START);
    expect(crypto.createHash('sha256').update(CLI_SOURCE).digest('hex')).toBe(CLI_SOURCE_SHA256);
  });

  it('finds the same base image and user as the CLI', () => {
    for (const dockerfile of DOCKERFILES) {
      for (const args of ARGS) for (const env of ENVS) for (const target of TARGETS) compare(dockerfile, args, env, target);
    }
  });

  it('finds the same base image and user as the CLI for generated Dockerfiles', () => {
    let seed = 17;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = <T>(values: readonly T[]): T => values[random(values.length)];
    const names = ['A', 'B', 'U', 'HOME', 'TARGETARCH'];
    const words = () => pick(['x', '$A', '${B}', '${U:-d}', '${A:+"p"}', 'a$B', '${HOME}', "'q'", 'constructor', '']);
    for (let run = 0; run < 400; run++) {
      const lines: string[] = [];
      const count = 1 + random(8);
      for (let line = 0; line < count; line++) {
        switch (random(5)) {
          case 0:
            lines.push(`FROM ${pick(['alpine', 's0', 's1', '${B}', 'img:$A'])}${random(2) ? ` AS ${pick(['s0', 's1', 's2'])}` : ''}`);
            break;
          case 1:
            lines.push(`ARG ${pick(names)}${random(2) ? `=${words()}` : ''}`);
            break;
          case 2:
            lines.push(`ENV ${pick(names)}${random(3) ? `=${words()}` : ''}`);
            break;
          case 3:
            lines.push(`USER ${words() || 'u'}`);
            break;
          default:
            lines.push('RUN true');
        }
      }
      compare(lines.join('\n'), pick(ARGS), pick(ENVS), pick([undefined, 's0', 's1', 's2']));
    }
  });

  it('stops within its budget where the CLI takes exponential time', () => {
    const lines = ['FROM alpine', 'ENV V0=x'];
    for (let i = 1; i < 60; i++) lines.push(`ENV V${i}=$V${i - 1}$V${i - 1}`);
    lines.push('USER $V59');
    const started = Date.now();
    expect(() => cliImageUser(parseCliDockerfile(lines.join('\n')), {}, {}, undefined)).toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(CLI_DOCKERFILE_BUDGET.steps).toBeGreaterThan(1000);
  });

  it('finds the same base image and user as the CLI with the platform variables of each architecture (review round 18, S18-2, P18-3)', () => {
    for (const arch of ['amd64', 'arm64', 'arm', 'ia32', 'ppc64', 's390x']) {
      const platform = cliPlatformVariables(arch);
      for (const dockerfile of DOCKERFILES) for (const args of ARGS) for (const target of [undefined, 'dev', 'a', 'b']) compare(dockerfile, args, ENVS[1], target, platform);
    }
  });

  it('writes the platform variables as the CLI computes them from its Node process (review round 18, S18-2, P18-3)', () => {
    // Tj: BUILDPLATFORM is [os, arch, variant].filter(Boolean).join('/'), VARIANT `variant ?? ''` of {os: yo(platform), arch: mo(arch)}.
    const tj = BUNDLE.slice(BUNDLE.indexOf('async function Tj('), BUNDLE.indexOf('var EI="devcontainer.metadata"'));
    expect(tj).toContain('BUILDPLATFORM:[s.os,s.arch,s.variant].filter(Boolean).join("/"),BUILDOS:s.os,BUILDARCH:s.arch,BUILDVARIANT:s.variant??""');
    expect(BUNDLE).toContain('function mo(e){return e==="x64"?"amd64":e}function yo(e){return e==="win32"?"windows":e}');
    expect(cliPlatformVariables('arm64')).toEqual({
      BUILDPLATFORM: 'linux/arm64',
      BUILDOS: 'linux',
      BUILDARCH: 'arm64',
      BUILDVARIANT: '',
      TARGETPLATFORM: 'linux/arm64',
      TARGETOS: 'linux',
      TARGETARCH: 'arm64',
      TARGETVARIANT: '',
    });
    // The check of the configuration: the architecture is not known yet, never empty.
    expect(CLI_PLATFORM_VARIABLES).toMatchObject({ BUILDOS: 'linux', TARGETOS: 'linux', BUILDVARIANT: '', TARGETVARIANT: '', TARGETARCH: '${TARGETARCH}', TARGETPLATFORM: 'linux/${TARGETARCH}' });
  });

  it('maps the architecture of the Docker Engine to the Node architecture of the helper (review round 18, P18-3)', () => {
    expect(['amd64', 'arm64', 'arm', '386', 'ppc64le', 's390x', 'riscv64', 'mips64le', '', 'x64', 'constructor'].map(cliArchitecture)).toEqual([
      'amd64',
      'arm64',
      'arm',
      'ia32',
      'ppc64',
      's390x',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('reads long runs of blank lines in linear time, and refuses more than CLI_MAX_BLANK_LINES in a row (review round 18, P18-2)', () => {
    const slow = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS dev\nUSER vscode\n' + ' \n'.repeat(60_000) + 'RUN x';
    let started = Date.now();
    expect(() => parseCliDockerfile(slow)).toThrow(CliDockerfileError);
    expect(Date.now() - started).toBeLessThan(500);
    // Just below the cap, in every form of line break of `^`.
    for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
      const breaks = newline === '\r\n' ? CLI_MAX_BLANK_LINES / 2 : CLI_MAX_BLANK_LINES;
      const blank = `FROM alpine AS dev${newline.repeat(breaks)}USER vscode\n`;
      expect(cliImageUser(parseCliDockerfile(blank), {}, {}, undefined), JSON.stringify(newline)).toBe('vscode');
      expect(() => parseCliDockerfile(`FROM alpine${' \t'.repeat(3)}${newline.repeat(breaks + 1)}USER x`)).toThrow(CliDockerfileError);
    }
    // Many short runs are fine: the cap is on one run.
    const many = `FROM alpine AS dev\n${'RUN x\n\n\n'.repeat(20_000)}USER vscode\n`;
    started = Date.now();
    expect(cliImageUser(parseCliDockerfile(many), {}, {}, undefined)).toBe('vscode');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
