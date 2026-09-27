// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { extractBaseImages, MAX_DOCKERFILE_INSTRUCTIONS, MAX_DOCKERFILE_LENGTH, MAX_REFERENCE_LENGTH, SHELL_NAME } from './dockerfile';

describe('extractBaseImages', () => {
  it('returns the image of a single FROM', () => {
    expect(extractBaseImages('FROM mcr.microsoft.com/devcontainers/python:3.12\nRUN echo hi\n')).toEqual([
      'mcr.microsoft.com/devcontainers/python:3.12',
    ]);
  });

  it('handles multi-stage builds and excludes earlier stages (case-insensitive)', () => {
    const text = [
      'FROM golang:1.22 AS Build',
      'RUN go build ./...',
      'FROM build AS test',
      'FROM debian:bookworm-slim as runtime',
      'COPY --from=build /out /out',
      'from BUILD',
    ].join('\n');
    expect(extractBaseImages(text)).toEqual(['golang:1.22', 'debian:bookworm-slim']);
  });

  it('treats a name of a later stage as an image', () => {
    const text = 'FROM base\nFROM ubuntu AS base\n';
    expect(extractBaseImages(text)).toEqual(['base', 'ubuntu']);
  });

  it('excludes scratch', () => {
    expect(extractBaseImages('FROM scratch\nFROM SCRATCH AS x\nFROM alpine')).toEqual(['alpine']);
  });

  it('deduplicates in order', () => {
    expect(extractBaseImages('FROM alpine AS a\nFROM ubuntu AS b\nFROM alpine AS c\n')).toEqual(['alpine', 'ubuntu']);
  });

  it('ignores the --platform flag', () => {
    const text = 'FROM --platform=$BUILDPLATFORM golang:1.22 AS build\nFROM --platform=linux/amd64 alpine:3.20';
    expect(extractBaseImages(text)).toEqual(['golang:1.22', 'alpine:3.20']);
  });

  it('uses ARG defaults before the first FROM', () => {
    const text = [
      'ARG VARIANT="3.12-bookworm"',
      'ARG REGISTRY=mcr.microsoft.com',
      'FROM ${REGISTRY}/devcontainers/python:${VARIANT}',
    ].join('\n');
    expect(extractBaseImages(text)).toEqual(['mcr.microsoft.com/devcontainers/python:3.12-bookworm']);
  });

  it('overrides ARG defaults with build args', () => {
    const text = 'ARG VARIANT=3.11\nFROM python:$VARIANT';
    expect(extractBaseImages(text, { VARIANT: '3.13' })).toEqual(['python:3.13']);
  });

  it('uses build args only for declared ARGs', () => {
    const text = 'FROM python:3.12${SUFFIX}';
    expect(extractBaseImages(text, { SUFFIX: '-slim' })).toEqual(['python:3.12']);
  });

  it('uses a build arg for an ARG without default', () => {
    expect(extractBaseImages('ARG BASE\nFROM ${BASE}', { BASE: 'node:22' })).toEqual(['node:22']);
  });

  it('skips a FROM whose ARG has no value', () => {
    expect(extractBaseImages('ARG BASE\nFROM ${BASE}')).toEqual([]);
  });

  it('does not use ARGs declared after the first FROM for later FROMs', () => {
    const text = 'FROM alpine\nARG TAG=1\nFROM node:${TAG:-22}';
    expect(extractBaseImages(text)).toEqual(['alpine', 'node:22']);
  });

  it('expands default and alternative values', () => {
    const text = [
      'ARG EMPTY=',
      'ARG SET=x',
      'ARG UNSET',
      'FROM a:${EMPTY:-one}',
      'FROM b:${UNSET:-two}',
      'FROM c:${EMPTY-three}',
      'FROM d:${UNSET-four}',
      'FROM e:1${SET:+-plus}',
      'FROM f:1${EMPTY:+-plus}',
      'FROM g:1${EMPTY+-set}',
      'FROM h:${NOT_DECLARED:-${SET}-nested}',
    ].join('\n');
    expect(extractBaseImages(text)).toEqual([
      'a:one',
      'b:two',
      'c:',
      'd:four',
      'e:1-plus',
      'f:1',
      'g:1-set',
      'h:x-nested',
    ]);
  });

  it('expands ARG defaults that use earlier ARGs', () => {
    const text = 'ARG MAJOR=3\nARG VERSION=${MAJOR}.12\nFROM python:$VERSION';
    expect(extractBaseImages(text)).toEqual(['python:3.12']);
  });

  it('reads several ARGs in one instruction', () => {
    const text = "ARG IMAGE=node TAG='22-bookworm'\nFROM $IMAGE:$TAG";
    expect(extractBaseImages(text)).toEqual(['node:22-bookworm']);
  });

  it('skips references that still contain $', () => {
    const text = [
      'FROM golang:1.22-${TARGETARCH}',
      'FROM alpine:${TAG:?missing}',
      'FROM busybox:${VERSION%%.*}',
      'FROM debian:\\$literal',
      'FROM ubuntu:22.04',
    ].join('\n');
    expect(extractBaseImages(text)).toEqual(['ubuntu:22.04']);
  });

  it('uses a platform ARG when a build arg sets it', () => {
    expect(extractBaseImages('FROM golang:1.22-$TARGETARCH', { TARGETARCH: 'arm64' })).toEqual(['golang:1.22-arm64']);
  });

  it('joins continuation lines and skips comments and empty lines in them', () => {
    const text = [
      '# A comment',
      'FROM \\',
      '  # comment inside the instruction',
      '',
      '  mcr.microsoft.com/devcontainers/base:bookworm \\',
      '  AS base',
      'RUN apt-get update \\',
      '  && apt-get install -y git',
      'FROM base',
    ].join('\n');
    expect(extractBaseImages(text)).toEqual(['mcr.microsoft.com/devcontainers/base:bookworm']);
  });

  it('accepts a continuation character followed by spaces', () => {
    expect(extractBaseImages('FROM \\   \n alpine:3.20')).toEqual(['alpine:3.20']);
  });

  it('handles CRLF line endings and a byte order mark', () => {
    expect(extractBaseImages('\ufeffARG V=1\r\nFROM node:$V\r\nRUN x\r\n')).toEqual(['node:1']);
  });

  it('respects the escape parser directive', () => {
    const text = ['# escape=`', 'ARG TAG=ltsc2022', 'FROM mcr.microsoft.com/windows/servercore:$TAG `', '  AS base', 'RUN dir c:\\'].join('\n');
    expect(extractBaseImages(text)).toEqual(['mcr.microsoft.com/windows/servercore:ltsc2022']);
  });

  it('ignores an escape directive after a comment', () => {
    const text = ['# a comment', '# escape=`', 'FROM alpine `', 'FROM ubuntu'].join('\n');
    // With the default escape character, the backtick is no line continuation.
    expect(extractBaseImages(text)).toEqual(['alpine', 'ubuntu']);
  });

  it('skips a syntax directive', () => {
    expect(extractBaseImages('# syntax=docker/dockerfile:1\n# escape=\\\nFROM alpine')).toEqual(['alpine']);
  });

  it('is case-insensitive for instructions', () => {
    expect(extractBaseImages('arg V=3\nfrom python:$V AS x\nFrom x')).toEqual(['python:3']);
  });

  it('ignores FROM lines inside heredocs', () => {
    const text = [
      'FROM alpine AS base',
      'RUN <<EOF',
      'FROM not-an-image',
      'EOF',
      'COPY <<-"END" /etc/file',
      '\tFROM also-not-an-image',
      '\tEND',
      'FROM ubuntu',
    ].join('\n');
    expect(extractBaseImages(text)).toEqual(['alpine', 'ubuntu']);
  });

  it('stops after the target stage', () => {
    const text = 'FROM node:22 AS dev\nFROM nginx:1.27 AS prod\n';
    expect(extractBaseImages(text, {}, { target: 'Dev' })).toEqual(['node:22']);
    expect(extractBaseImages(text, {}, { target: 'prod' })).toEqual(['node:22', 'nginx:1.27']);
    expect(extractBaseImages(text)).toEqual(['node:22', 'nginx:1.27']);
  });

  it('removes quotes around the image', () => {
    expect(extractBaseImages('FROM "alpine:3.20"')).toEqual(['alpine:3.20']);
  });

  it('returns an empty list for an empty file or a FROM without image', () => {
    expect(extractBaseImages('')).toEqual([]);
    expect(extractBaseImages('FROM\nFROM --platform=linux/amd64\n')).toEqual([]);
  });
});

/** Milliseconds that `fn` takes. */
function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

// Dockerfile refusals removed (user decision 2026-09-27): the image references of `COPY --from`, `RUN --mount from`,
// and `# syntax` are no longer read, and neither are the pattern forms of variables; the Dockerfiles of the former tests
// of extractImageReferences, extractBuilderFlags, the pattern matcher, and detectSyntax give their FROM images for the
// update check, or skip what cannot be read.
describe('extractBaseImages on the Dockerfiles of the removed image-reference checks', () => {
  it('names only the FROM images, not COPY --from, RUN --mount from, or the syntax directive', () => {
    const text = [
      '# syntax=docker/dockerfile:1.7',
      'FROM alpine:3.22 AS base',
      'COPY --from=devenv-11111111:2 /x /x',
      'COPY --chown=1000 --from=ghcr.io/acme/tools:1 /t /t',
      'RUN --mount=type=bind,from=devenv-22222222,source=/a,target=/a --mount=type=cache,target=/c true',
      'RUN --mount type=cache,from=cache-image,target=/c true',
      'ADD --chown=1 https://example.com/x /x',
    ].join('\n');
    // Dockerfile refusals removed (user decision 2026-09-27): before, extractImageReferences named all six.
    expect(extractBaseImages(text)).toEqual(['alpine:3.22']);
  });

  it('leaves out stage names of earlier stages and scratch, and reads a later stage name as an image', () => {
    const text = ['FROM scratch AS Empty', 'FROM alpine AS build', 'COPY --from=0 /a /a', 'COPY --from=BUILD /b /b', 'COPY --from=later /c /c', 'RUN --mount=from=empty,target=/e true', 'FROM debian AS later'].join('\n');
    expect(extractBaseImages(text)).toEqual(['alpine', 'debian']);
  });

  it('skips a FROM with a variable that is not resolved, and COPY --from with ENVs and stage ARGs', () => {
    const text = [
      'ARG TAG=2',
      'FROM alpine',
      'ARG TAG',
      'ARG SOURCE=devenv-11111111',
      'ENV OTHER=devenv-33333333',
      'COPY --from=${SOURCE}:${TAG} /a /a',
      'COPY --from=$OTHER /b /b',
      'ARG TARGETARCH',
      'RUN --mount=from=tools-$TARGETARCH,target=/t true',
      'FROM devenv-${TARGETVARIANT}',
    ].join('\n');
    // Dockerfile refusals removed (user decision 2026-09-27): before, extractImageReferences kept devenv-${TARGETVARIANT} for a refusal.
    expect(extractBaseImages(text)).toEqual(['alpine']);
    expect(extractBaseImages(text, { TARGETVARIANT: 'v8' })).toEqual(['alpine', 'devenv-v8']);
  });

  it('stops after the target stage, whatever COPY --from names', () => {
    const text = ['FROM alpine AS one', 'COPY --from=devenv-1 /a /a', 'FROM debian AS two', 'COPY --from=devenv-2 /b /b'].join('\n');
    expect(extractBaseImages(text, {}, { target: 'one' })).toEqual(['alpine']);
  });

  it('reads the FROM of a Dockerfile with quoted --mount fields', () => {
    const text = 'FROM alpine\nRUN --mount=type=bind,\\"from=devenv-1\\",target=/x --mount="from=devenv-2, target=/y" ls\n';
    // Dockerfile refusals removed (user decision 2026-09-27): before, the RUN --mount images were named too.
    expect(extractBaseImages(text)).toEqual(['alpine']);
  });

  it.each([
    'ARG A=a.b.c\nFROM x:${A#*.}',
    'ARG A=a.b.c\nFROM x:${A##*.}',
    'ARG A=a.b.c\nFROM x:${A%.*}',
    'ARG A=a.b.c\nFROM x:${A%%.*}',
    'ARG A=a.b.a\nFROM x:${A/a/z}',
    'ARG A=a.b.a\nFROM x:${A//a/z}',
    'FROM x:1${NOPE%%.*}',
    'FROM alpine:${NOPE%x}',
    'ARG A=alpine\nFROM ${A:0:3}',
    'ARG A=devenv-1\nFROM ${A:0:3}',
    'ARG A=alpine\nARG B=${A:0:3}\nFROM $B',
    'FROM ${}',
    'FROM ${:x}',
  ])('skips the pattern form or unknown operator in %j for the update check', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, these forms were evaluated or refused.
    expect(extractBaseImages(`${text}\nFROM debian`)).toEqual(['debian']);
  });

  it('leaves the pattern operators unevaluated', () => {
    expect(extractBaseImages('ARG A=a.b\nFROM x:${A%.*}\nFROM y')).toEqual(['y']);
  });

  it.each([
    '# syntax=a/b:1\nFROM x',
    '\ufeff# syntax=a/b:1\nFROM x',
    '# escape=`\n# check=skip=all\n# syntax=a/b:1\nFROM x',
    '// syntax=a/b:1\nFROM x',
    '# syntax=devenv-11111111:1\nFROM x',
    '# syntax=docker.io/attacker/frontend:1\nFROM x',
  ])('reads the FROM image of %j whatever frontend it names', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, a frontend other than docker/dockerfile was refused.
    expect(extractBaseImages(text)).toEqual(['x']);
  });
});

describe('review round 5 of unit 6 (S5-1): variable names as BuildKit reads them', () => {
  it.each([
    ['1env', '1'],
    ['12x', '12'],
    ['٣٤x', '٣٤'],
    ['@env', '@'],
    ['*x', '*'],
    ['#x', '#'],
    ['?x', '?'],
    ['-x', '-'],
    ['$x', '$'],
    ['!x', '!'],
    ['0x', '0'],
    ['éenv-1', 'éenv'],
    ['_a1é-x', '_a1é'],
    ['Aé٣_b.c', 'Aé٣_b'],
  ])('reads the name at the start of %j as BuildKit processName does (S5-1)', (text, name) => {
    expect(SHELL_NAME.exec(text)?.[0]).toBe(name);
  });

  it('reads no name at the start of a text that starts with another character (S5-1)', () => {
    for (const text of ['.x', '/x', '{x', '}', ':x', '%x', '']) expect(SHELL_NAME.exec(text)).toBeNull();
  });

  it('expands positional and special parameters and names of Unicode letters that are not set to the empty text (S5-1)', () => {
    // Dockerfile refusals removed (user decision 2026-09-27): read with extractBaseImages (extractImageReferences is gone).
    expect(extractBaseImages('FROM dev$1env$@-${2}x$$y$éa$é\\z\n')).toEqual(['devenv-xyz']);
    expect(extractBaseImages('ARG é=alp\nARG 1=ine\nFROM $é${1}\n')).toEqual(['alpine']);
    expect(extractBaseImages('ARG é=alpine\nFROM $é\n')).toEqual(['alpine']);
  });
});

describe('the limits of extractBaseImages: skipped for the update check, in linear time', () => {
  /** ARGs B0 … B13 that double their value (B13: MAX_EXPANDED_LENGTH characters, cut), then `lines` ARGs of `form`. */
  function doubling(first: string, lines: number, form: (i: number) => string): string {
    const head = `ARG B0=${first}\n${Array.from({ length: 13 }, (_, i) => `ARG B${i + 1}=\${B${i}}\${B${i}}`).join('\n')}\n`;
    const body: string[] = [];
    for (let l = 0; l < lines / 50; l++) body.push(`ARG ${Array.from({ length: 50 }, (_, k) => form(l * 50 + k)).join(' ')}`);
    return `${head}${body.join('\n')}\nFROM alpine\n`;
  }

  it('reads the pattern forms that ran out of the budget of the former matcher quickly, and skips them', () => {
    const forms = Array.from({ length: 12 }, (_, i) => `ARG B${i}=\${A#*a*a*a*a*a*a*a*a*a*a*b}`).join('\n');
    const text = `ARG A=${'a'.repeat(60_000)}\n${forms}\nFROM alpine:\${B11}\nCOPY --from=base:\${B0} / /\nFROM debian:\${A#a}\nFROM ubuntu\n`;
    const { result, ms } = timed(() => extractBaseImages(text));
    expect(ms).toBeLessThan(1000);
    // Dockerfile refusals removed (user decision 2026-09-27): before, the Dockerfile was refused as too complex to check.
    expect(result).toEqual(['ubuntu']);
    expect(timed(() => extractBaseImages(`ARG A=${'a'.repeat(60_000)}\nFROM \${A#*a*a*a*a*b}\n`)).ms).toBeLessThan(1000);
    const replaced = `ARG A=${'a'.repeat(60_000)}\n${Array.from({ length: 20 }, (_, i) => `ARG B${i}=\${A//a*b/x}`).join('\n')}\nFROM alpine\n`;
    expect(timed(() => extractBaseImages(replaced)).ms).toBeLessThan(1000);
  });

  it('reads 10000 stages and 10000 COPY --from lines in linear time', () => {
    const n = 10_000;
    const text = `${Array.from({ length: n }, (_, i) => `FROM a AS s${i}`).join('\n')}\n${Array.from({ length: n }, (_, i) => `COPY --from=$Y${i} a b`).join('\n')}\n`;
    const { result, ms } = timed(() => extractBaseImages(text));
    expect(ms).toBeLessThan(1000);
    expect(result).toEqual(['a']);
  });

  it('reads 20000 FROM images in linear time', () => {
    const text = `${Array.from({ length: MAX_DOCKERFILE_INSTRUCTIONS }, (_, i) => `FROM a${i}`).join('\n')}\n`;
    const { result, ms } = timed(() => extractBaseImages(text));
    expect(result).toHaveLength(MAX_DOCKERFILE_INSTRUCTIONS);
    expect(ms).toBeLessThan(1000);
  });

  it('keeps the stages apart: a FROM names only earlier stages', () => {
    expect(extractBaseImages('FROM a AS one\nFROM $TARGETARCH AS two\nFROM b AS three\nCOPY --from=$Y / /\nFROM three\nFROM four\n')).toEqual(['a', 'b', 'four']);
  });

  it('gives no base images for a Dockerfile with more instructions or characters than it reads', () => {
    const many = `${Array.from({ length: MAX_DOCKERFILE_INSTRUCTIONS + 1 }, (_, i) => `FROM a${i}`).join('\n')}\n`;
    // Dockerfile refusals removed (user decision 2026-09-27): before, such a Dockerfile was refused as too large to check.
    expect(extractBaseImages(many)).toEqual([]);
    expect(extractBaseImages(`FROM alpine\n# ${'x'.repeat(MAX_DOCKERFILE_LENGTH)}\n`)).toEqual([]);
    expect(extractBaseImages(`FROM devenv-11111111:1\n# ${'x'.repeat(MAX_DOCKERFILE_LENGTH)}\n`, { BUILDKIT_SYNTAX: 'evil/frontend' })).toEqual([]);
  });

  it('reads 1000 pattern forms on a value of 64 KiB quickly', () => {
    const text = doubling('xxxxxxxxxxxxxxxy', 1000, () => 'X=${B13%x}');
    const { result, ms } = timed(() => extractBaseImages(`${text}FROM alpine:\${X}\n`));
    expect(ms).toBeLessThan(1500);
    // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM alpine:${B13%x}` was refused as too complex.
    expect(result).toEqual(['alpine']);
  });

  it('gives no base images for a Dockerfile whose expansions make more than MAX_EXPANDED_CHARACTERS characters', () => {
    // 2000 ARGs of 64 KiB each.
    const text = doubling('€€€€€€€€€€€€€€€€', 2000, (i) => `X${i}=a$B13`);
    const heap = process.memoryUsage().heapUsed;
    const { result, ms } = timed(() => extractBaseImages(text));
    expect(ms).toBeLessThan(1000);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(150 * 1024 * 1024);
    // Dockerfile refusals removed (user decision 2026-09-27): before, it was refused as too complex to check.
    expect(result).toEqual([]);
    // Below the limit, as before.
    expect(extractBaseImages(doubling('€', 20, (i) => `X${i}=a$B13`))).toEqual(['alpine']);
  });

  it('skips a reference longer than MAX_REFERENCE_LENGTH and a nesting deeper than 32 levels', () => {
    expect(extractBaseImages(`FROM ${'a'.repeat(MAX_REFERENCE_LENGTH + 1)}\nFROM b\n`)).toEqual(['b']);
    expect(extractBaseImages(`ARG A=${'a'.repeat(4000)}\nFROM \${A}\${A}\nFROM b\n`)).toEqual(['b']);
    const nested = `FROM x${'${A:-'.repeat(40)}y${'}'.repeat(40)}\nFROM b\n`;
    expect(extractBaseImages(nested)).toEqual(['b']);
    expect(extractBaseImages(`FROM x${'${A:-'.repeat(20)}y${'}'.repeat(20)}\n`)).toEqual(['xy']);
  });

  it('reads a directive with many spaces in linear time', () => {
    expect(timed(() => extractBaseImages(`# check=a${' '.repeat(40_000)}b\nFROM alpine\n`)).ms).toBeLessThan(300);
    expect(timed(() => extractBaseImages(`// syntax=a${' '.repeat(40_000)}b\nFROM alpine\n`)).ms).toBeLessThan(300);
    expect(extractBaseImages('# escape=`\nFROM a`\n:1\n')).toEqual(['a:1']);
  });
});
