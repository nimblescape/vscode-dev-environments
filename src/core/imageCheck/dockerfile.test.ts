// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  analyzeDockerfileImages,
  cutAtSpace,
  detectSyntax,
  extractBaseImages,
  extractBuilderFlags,
  extractImageReferences,
  MAX_DOCKERFILE_INSTRUCTIONS,
  MAX_DOCKERFILE_LENGTH,
  replaceShellPattern,
  SHELL_NAME,
  trimShellPrefix,
  trimShellSuffix,
} from './dockerfile';
import { dockerfileImageFindings } from '../helper/hostAccess';

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

describe('extractImageReferences (review round 2, S2-02)', () => {
  const refs = (text: string, args?: Record<string, string>, target?: string) =>
    extractImageReferences(text, args, target !== undefined ? { target } : {}).map((ref) => `${ref.kind} ${ref.reference}`);

  it('names FROM, COPY --from, RUN --mount from, and the syntax directive', () => {
    const text = [
      '# syntax=docker/dockerfile:1.7',
      'FROM alpine:3.22 AS base',
      'COPY --from=devenv-11111111:2 /x /x',
      'COPY --chown=1000 --from=ghcr.io/acme/tools:1 /t /t',
      'RUN --mount=type=bind,from=devenv-22222222,source=/a,target=/a --mount=type=cache,target=/c true',
      'RUN --mount type=cache,from=cache-image,target=/c true',
      'ADD --chown=1 https://example.com/x /x',
    ].join('\n');
    expect(refs(text)).toEqual([
      'syntax docker/dockerfile:1.7',
      'FROM alpine:3.22',
      'COPY --from devenv-11111111:2',
      'COPY --from ghcr.io/acme/tools:1',
      'RUN --mount from devenv-22222222',
      'RUN --mount from cache-image',
    ]);
  });

  it('leaves out stage names (of the whole file, any case), stage indexes, and scratch', () => {
    const text = ['FROM scratch AS Empty', 'FROM alpine AS build', 'COPY --from=0 /a /a', 'COPY --from=BUILD /b /b', 'COPY --from=later /c /c', 'RUN --mount=from=empty,target=/e true', 'FROM debian AS later'].join('\n');
    expect(refs(text)).toEqual(['FROM alpine', 'FROM debian']);
  });

  it('resolves the ARGs and ENVs of the stage and the build arguments, and keeps an unresolved variable with its $', () => {
    const text = [
      'ARG TAG=2',
      'FROM alpine',
      'ARG TAG',
      'ARG SOURCE=devenv-11111111',
      'ENV OTHER=devenv-33333333',
      'COPY --from=${SOURCE}:${TAG} /a /a',
      'COPY --from=$OTHER /b /b',
      'COPY --from=devenv-$UNKNOWN /c /c',
      'ARG TARGETARCH',
      'RUN --mount=from=tools-$TARGETARCH,target=/t true',
      'FROM devenv-${TARGETVARIANT}',
    ].join('\n');
    expect(refs(text)).toEqual([
      'FROM alpine',
      'COPY --from devenv-11111111:2',
      'COPY --from devenv-33333333',
      'COPY --from devenv-$UNKNOWN',
      'RUN --mount from tools-$TARGETARCH',
      'FROM devenv-${TARGETVARIANT}',
    ]);
    expect(refs(text, { SOURCE: 'devenv-44444444' })).toContain('COPY --from devenv-44444444:2');
  });

  it('stops after the target stage, as extractBaseImages', () => {
    const text = ['FROM alpine AS one', 'COPY --from=devenv-1 /a /a', 'FROM debian AS two', 'COPY --from=devenv-2 /b /b'].join('\n');
    expect(refs(text, undefined, 'one')).toEqual(['FROM alpine', 'COPY --from devenv-1']);
  });
});

describe('extractBuilderFlags (review round 3, S3-5)', () => {
  it.each<[string, string[]]>([
    ['--from=a /x /y', ['--from=a']],
    ['--mount="from=a,target=/x" ls', ['--mount=from=a,target=/x']],
    ['--mount=type=bind,"from=a" ls', ['--mount=type=bind,from=a']],
    ["--mount='type=bind, from=a b' ls", ['--mount=type=bind, from=a b']],
    ['--mount=type=bind,\\"from=a\\" ls', ['--mount=type=bind,"from=a"']],
    ['--network=none --mount=from=a ls', ['--network=none', '--mount=from=a']],
    ['--mount type=cache,from=b true', ['--mount', 'type=cache,from=b']],
    ['-- --from=a', []],
    ['ls --from=a', []],
  ])('%j → %j', (line, words) => {
    expect(extractBuilderFlags(line)).toEqual(words);
  });

  it('finds the images of quoted --mount fields', () => {
    const text = 'FROM alpine\nRUN --mount=type=bind,\\"from=devenv-1\\",target=/x --mount="from=devenv-2, target=/y" ls\n';
    expect(extractImageReferences(text).map((ref) => `${ref.kind} ${ref.reference}`)).toEqual(['FROM alpine', 'RUN --mount from devenv-1', 'RUN --mount from devenv-2']);
  });
});

describe('pattern operators of variables (review round 4, S4-3)', () => {
  const from = (text: string) => extractImageReferences(text).map((ref) => (ref.unchecked ? `${ref.reference} (${ref.unchecked})` : ref.reference));

  it.each([
    ['ARG A=a.b.c\nFROM x:${A#*.}', 'x:b.c'],
    ['ARG A=a.b.c\nFROM x:${A##*.}', 'x:c'],
    ['ARG A=a.b.c\nFROM x:${A%.*}', 'x:a.b'],
    ['ARG A=a.b.c\nFROM x:${A%%.*}', 'x:a'],
    ['ARG A=a.b.c\nFROM x:${A#?}', 'x:.b.c'],
    ['ARG A=a.b.c\nFROM x:${A#z}', 'x:a.b.c'],
    ['ARG A=a.b.a\nFROM x:${A/a/z}', 'x:z.b.a'],
    ['ARG A=a.b.a\nFROM x:${A//a/z}', 'x:z.b.z'],
    // Greedy, and Go's rule for empty matches (ReplaceAllString).
    ['ARG A=abc\nFROM x:${A//*/z}', 'x:z'],
    ['ARG A=abc\nFROM x${A///-}', 'x-a-b-c-'],
    ['ARG A=a*b\nFROM x:${A/\\*/-}', 'x:a-b'],
    ['ARG A=a.b\nFROM x:${A/./-}', 'x:a-b'],
    // An undeclared variable of the global scope is empty.
    ['FROM x:1${NOPE%%.*}', 'x:1'],
  ])('%j gives %j', (text, reference) => {
    expect(from(text)).toEqual([reference]);
  });

  it('marks a form that cannot be evaluated', () => {
    expect(from('FROM alpine\nCOPY --from=${NOPE%x} / /')).toEqual(['alpine', '${NOPE%x} (protected)']);
    expect(from('ARG A=alpine\nFROM ${A:0:3}')).toEqual(['${A:0:3} (unsupported)']);
    expect(from('ARG A=devenv-1\nFROM ${A:0:3}')).toEqual(['${A:0:3} (protected)']);
    // A variable whose value came from such a form carries the mark.
    expect(from('ARG A=alpine\nARG B=${A:0:3}\nFROM $B')).toEqual(['${A:0:3} (unsupported)']);
  });

  it('leaves the pattern operators unevaluated for extractBaseImages', () => {
    expect(extractBaseImages('ARG A=a.b\nFROM x:${A%.*}\nFROM y')).toEqual(['y']);
  });
});

describe('review round 5 of unit 6 (S5-1, S5-3, P5-2)', () => {
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
    expect(extractImageReferences('FROM dev$1env$@-${2}x$$y$éa$é\\z\n').map((r) => r.reference)).toEqual(['devenv-xyz']);
    expect(extractImageReferences('ARG é=alp\nARG 1=ine\nFROM $é${1}\n').map((r) => r.reference)).toEqual(['alpine']);
    expect(extractBaseImages('ARG é=alpine\nFROM $é\n')).toEqual(['alpine']);
  });

  it.each([
    ['# syntax=a/b:1\nFROM x', 'a/b:1'],
    ['﻿# syntax=a/b:1\nFROM x', 'a/b:1'],
    ['#!/bin/sh\n# syntax=a/b:1\nFROM x', 'a/b:1'],
    ['#!/bin/sh\r\n# syntax=a/b:1\r\nFROM x', 'a/b:1'],
    ['# escape=`\n# check=skip=all\n# syntax=a/b:1\nFROM x', 'a/b:1'],
    ['// syntax=a/b:1\nFROM x', 'a/b:1'],
    ['#!/bin/sh\n//escape=`\n//syntax = a/b:1\nFROM x', 'a/b:1'],
    ['{"syntax": "a/b:1"}', 'a/b:1'],
    ['#!/bin/sh\n{"x": 1, "syntax": "a/b:1 c"}\n', 'a/b:1'],
    ['# syntax=a/b:1 # comment\nFROM x', 'a/b:1'],
    ['# syntax=a/b:1\t# comment\nFROM x', 'a/b:1\t#'],
  ])('finds the frontend of %j as BuildKit DetectSyntax does (S5-3, P5-2)', (text, syntax) => {
    expect(detectSyntax(text)).toBe(syntax);
  });

  it.each([
    'FROM x\n# syntax=a/b:1',
    '# hello\n# syntax=a/b:1\nFROM x',
    '#!/bin/sh\n#!/bin/sh\n# syntax=a/b:1\nFROM x',
    '{"syntax": 1}',
    '["syntax"]',
    '{"syntax": "a/b:1"} x',
    // Each form of directives starts at the first line.
    '# escape=`\n// syntax=a/b:1\nFROM x',
  ])('finds no frontend in %j (S5-3)', (text) => {
    expect(detectSyntax(text)).toBeUndefined();
  });

  it('cuts a value at its first ASCII space only (P5-2)', () => {
    expect(cutAtSpace('a b c')).toBe('a');
    expect(cutAtSpace('a\tb')).toBe('a\tb');
    expect(cutAtSpace('a')).toBe('a');
  });
});

describe('review round 7 of unit 6 (S7-1): the pattern matcher', () => {
  /** Milliseconds that `fn` takes. */
  function timed<T>(fn: () => T): { result: T; ms: number } {
    const start = performance.now();
    const result = fn();
    return { result, ms: performance.now() - start };
  }

  it('evaluates ${A#*a*a*a*a*b} on 400 characters in linear time (before: 65 s)', () => {
    const value = 'a'.repeat(400);
    const { result, ms } = timed(() => extractImageReferences(`ARG A=${value}\nFROM \${A#*a*a*a*a*b}\n`));
    expect(ms).toBeLessThan(1000);
    // No match: the value stays.
    expect(result).toEqual([{ reference: value, kind: 'FROM' }]);
    expect(timed(() => extractImageReferences(`ARG A=${'a'.repeat(60_000)}\nFROM \${A#*a*a*a*a*b}\n`)).ms).toBeLessThan(1000);
  });

  it('evaluates ${A//*a*a*a*b/x} on 200 characters in linear time (before: 4 s)', () => {
    const value = 'a'.repeat(200);
    const { result, ms } = timed(() => extractImageReferences(`ARG A=${value}\nFROM alpine\${A//*a*a*a*b/x}\n`));
    expect(ms).toBeLessThan(1000);
    expect(result).toEqual([{ reference: `alpine${value}`, kind: 'FROM' }]);
    const text = `ARG A=${'a'.repeat(60_000)}\n${Array.from({ length: 20 }, (_, i) => `ARG B${i}=\${A//a*b/x}`).join('\n')}\nFROM alpine\n`;
    expect(timed(() => dockerfileImageFindings(text, {})).ms).toBeLessThan(1000);
  });

  it('refuses a Dockerfile that runs out of the budget of the matcher as too complex', () => {
    const forms = Array.from({ length: 12 }, (_, i) => `ARG B${i}=\${A#*a*a*a*a*a*a*a*a*a*a*b}`).join('\n');
    const text = `ARG A=${'a'.repeat(60_000)}\n${forms}\nFROM alpine:\${B11}\nCOPY --from=base:\${B0} / /\nFROM debian:\${A#a}\n`;
    const { result, ms } = timed(() => extractImageReferences(text));
    expect(ms).toBeLessThan(2000);
    const late = result.find((reference) => reference.kind === 'FROM' && reference.reference.startsWith('alpine:'));
    expect(late).toMatchObject({ unchecked: 'unsupported', tooComplex: true });
    // After the budget ran out, no pattern form of the file is evaluated.
    expect(result.find((reference) => reference.reference.startsWith('debian:'))).toMatchObject({ unchecked: 'unsupported', tooComplex: true });
    // The variable keeps the form that was not evaluated.
    expect(late?.reference).toBe('alpine:${A#*a*a*a*a*a*a*a*a*a*a*b}');
    expect(dockerfileImageFindings(text, {})).toEqual([
      { item: 'FROM image alpine:${A#*a*a*a*a*a*a*a*a*a*a*b} (the Dockerfile is too complex to check)', class: 'unsupported' },
      { item: 'FROM image debian:${A#a} (the Dockerfile is too complex to check)', class: 'unsupported' },
    ]);
    // A value with `devenv` stays protected.
    const protectedText = `ARG A=devenv-${'a'.repeat(60_000)}\n${forms}\nFROM alpine:\${B11}\n`;
    expect(dockerfileImageFindings(protectedText, {}).map((finding) => finding.class)).toEqual(['protected']);
  });

  it('gives each Dockerfile a budget of its own', () => {
    const forms = Array.from({ length: 12 }, (_, i) => `ARG B${i}=\${A#*a*a*a*a*a*a*a*a*a*a*b}`).join('\n');
    extractImageReferences(`ARG A=${'a'.repeat(60_000)}\n${forms}\nFROM alpine\n`);
    expect(extractImageReferences('ARG A=a.b.c\nFROM x:${A##*.}\n')).toEqual([{ reference: 'x:c', kind: 'FROM' }]);
  });

  // The implementation of review rounds 4 to 6: BuildKit's regular expression in JavaScript (a backtracking matcher).
  function oracleRegex(pattern: string, greedy: boolean, anchored: boolean): RegExp | undefined {
    const chars = Array.from(pattern);
    let out = anchored ? '^' : '';
    for (let i = 0; i < chars.length; i++) {
      let char = chars[i];
      if (char === '*') {
        out += greedy ? '.*' : '.*?';
        continue;
      }
      if (char === '?') {
        out += '.';
        continue;
      }
      if (char === '\\') {
        if (chars[i + 1] === '}' || chars[i + 1] === '/') continue;
        char = chars[++i];
        if (char !== '*' && char !== '?' && char !== '\\') return undefined;
        out += `\\${char}`;
        continue;
      }
      out += /[[\]{}.+()|^$]/.test(char) ? `\\${char}` : char;
    }
    return new RegExp(out, 'u');
  }
  function oraclePrefix(pattern: string, value: string, greedy: boolean): string | undefined {
    const regex = oracleRegex(pattern, greedy, true);
    if (regex === undefined) return undefined;
    const match = regex.exec(value);
    return match ? value.slice(match.index + match[0].length) : value;
  }
  function oracleSuffix(pattern: string, value: string, greedy: boolean): string | undefined {
    const chars = Array.from(pattern);
    const reversed: string[] = new Array<string>(chars.length);
    const last = chars.length - 1;
    for (let i = 0; i <= last; ) {
      const out = last - i;
      if (chars[i] === '\\' && i !== last) {
        reversed[out - 1] = chars[i];
        reversed[out] = chars[i + 1];
        i += 2;
      } else {
        reversed[out] = chars[i];
        i++;
      }
    }
    const trimmed = oraclePrefix(reversed.join(''), Array.from(value).reverse().join(''), greedy);
    return trimmed === undefined ? undefined : Array.from(trimmed).reverse().join('');
  }
  function oracleReplace(pattern: string, replacement: string, value: string, all: boolean): string | undefined {
    const regex = oracleRegex(pattern, true, false);
    if (regex === undefined) return undefined;
    const global = new RegExp(regex.source, `${regex.flags}g`);
    const width = (index: number): number => ((value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
    let result = '';
    let position = 0;
    let previousEnd = -1;
    let searchFrom = 0;
    while (searchFrom <= value.length) {
      global.lastIndex = searchFrom;
      const match = global.exec(value);
      if (match === null) break;
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;
      if (matchEnd === matchStart && matchStart === previousEnd) {
        searchFrom = matchStart + width(matchStart);
        continue;
      }
      result += value.slice(position, matchStart) + replacement;
      position = matchEnd;
      previousEnd = matchEnd;
      if (!all) break;
      searchFrom = matchEnd > matchStart ? matchEnd : matchStart + width(matchStart);
    }
    return result + value.slice(position);
  }

  it('gives the results of the regular expressions of review round 4 on a random corpus', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const VALUE = ['a', 'b', 'c', 'a', 'b', '.', '/', '*', '?', '[', '\n', '\u{1F600}', '-'];
    const PATTERN = ['a', 'b', 'c', '*', '*', '?', '.', '/', '[', '\\*', '\\?', '\\\\', '\\}', '\\/', '\u{1F600}', '\\x'];
    let compared = 0;
    for (let n = 0; n < 4000; n++) {
      const value = Array.from({ length: Math.floor(random() * 10) }, () => pick(VALUE)).join('');
      const pattern = Array.from({ length: Math.floor(random() * 6) }, () => pick(PATTERN)).join('');
      const context = JSON.stringify({ value, pattern });
      for (const greedy of [false, true]) {
        expect(trimShellPrefix(pattern, value, greedy), `# ${greedy} ${context}`).toBe(oraclePrefix(pattern, value, greedy));
        expect(trimShellSuffix(pattern, value, greedy), `% ${greedy} ${context}`).toBe(oracleSuffix(pattern, value, greedy));
      }
      for (const all of [false, true]) expect(replaceShellPattern(pattern, 'X', value, all), `/ ${all} ${context}`).toBe(oracleReplace(pattern, 'X', value, all));
      compared++;
    }
    expect(compared).toBe(4000);
  });
});

describe('review round 7 of unit 6 (S7-2): large Dockerfiles', () => {
  it('reads 20000 references with 10000 stages in linear time', () => {
    const n = 10_000;
    const text = `${Array.from({ length: n }, (_, i) => `FROM a AS s${i}`).join('\n')}\n${Array.from({ length: n }, (_, i) => `COPY --from=$Y${i} a b`).join('\n')}\n`;
    const heap = process.memoryUsage().heapUsed;
    const start = performance.now();
    const findings = dockerfileImageFindings(text, {});
    expect(performance.now() - start).toBeLessThan(1000);
    // Before: 8 s and 600 MB (a copy of the stage names for each reference).
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(300 * 1024 * 1024);
    expect(findings).toEqual([]);
    const images = analyzeDockerfileImages(text, {}, { withStages: true });
    expect(images.stageNames).toHaveLength(n);
    expect(images.references.filter((reference) => reference.kind === 'COPY --from').every((reference) => reference.stagesBefore === n)).toBe(true);
  });

  it('reads 20000 FROM images in linear time', () => {
    const text = `${Array.from({ length: MAX_DOCKERFILE_INSTRUCTIONS }, (_, i) => `FROM a${i}`).join('\n')}\n`;
    const start = performance.now();
    expect(extractImageReferences(text)).toHaveLength(MAX_DOCKERFILE_INSTRUCTIONS);
    expect(dockerfileImageFindings(text, {})).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('keeps the stages of a reference with a variable apart: FROM the earlier ones, the others all', () => {
    const images = analyzeDockerfileImages('FROM a AS one\nFROM $TARGETARCH AS two\nFROM b AS three\nCOPY --from=$Y / /\n', {}, { withStages: true });
    expect(images.stageNames).toEqual(['one', 'two', 'three']);
    expect(images.references).toEqual([
      { reference: 'a', kind: 'FROM' },
      { reference: '$TARGETARCH', kind: 'FROM', stagesBefore: 1 },
      { reference: 'b', kind: 'FROM' },
      { reference: '$Y', kind: 'COPY --from', stagesBefore: 3 },
    ]);
  });

  it('refuses a Dockerfile with more instructions or characters than the check reads', () => {
    const many = `${Array.from({ length: MAX_DOCKERFILE_INSTRUCTIONS + 1 }, (_, i) => `FROM a${i}`).join('\n')}\n`;
    expect(analyzeDockerfileImages(many)).toEqual({ references: [], stageNames: [], tooLarge: true });
    expect(dockerfileImageFindings(many, {})).toEqual([{ item: 'Dockerfile (the Dockerfile is too large to check)', class: 'unsupported' }]);
    const long = `FROM alpine\n# ${'x'.repeat(MAX_DOCKERFILE_LENGTH)}\n`;
    expect(dockerfileImageFindings(long, {})).toEqual([{ item: 'Dockerfile (the Dockerfile is too large to check)', class: 'unsupported' }]);
    expect(dockerfileImageFindings(`FROM devenv-11111111:1\n# ${'x'.repeat(MAX_DOCKERFILE_LENGTH)}\n`, { BUILDKIT_SYNTAX: 'evil/frontend' })).toHaveLength(1);
  });
});
