import { describe, expect, it } from 'vitest';
import { extractBaseImages } from './dockerfile';

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
