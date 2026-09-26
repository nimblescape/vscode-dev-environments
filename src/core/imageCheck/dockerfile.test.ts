// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { cutAtSpace, detectSyntax, extractBaseImages, extractBuilderFlags, extractImageReferences, SHELL_NAME } from './dockerfile';

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
