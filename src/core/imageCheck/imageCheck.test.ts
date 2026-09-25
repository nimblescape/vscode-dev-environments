// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { isAbortError } from '../ports';
import type { BuildRecord, DevcontainerConfig } from '../types';
import { collectReferences, compareWithBuildRecord, ImageChecker, type CheckedOutcome } from './imageCheck';
import { RegistryClient, type CredentialsProvider } from './registryClient';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const PINNED = `ghcr.io/o/r@${digest('f')}`;

type Answer = { status?: number; headers?: Record<string, string | undefined>; body?: string } | Error | 'hang';

function responseOf(answer: Exclude<Answer, Error | 'hang'>): HttpResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(answer.headers ?? {})) if (value !== undefined) headers[name] = value;
  return { status: answer.status ?? 200, headers, body: answer.body ?? '' };
}

function transportFor(handler: (request: HttpRequest) => Answer): HttpTransport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    request(request) {
      requests.push(request);
      const answer = handler(request);
      if (answer === 'hang') return new Promise<HttpResponse>(() => {});
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(responseOf(answer));
    },
  };
}

/** Answers per host: a digest, a status, an error, or no answer. */
function registries(hosts: Record<string, string | number | Error | 'hang'>): HttpTransport & { requests: HttpRequest[] } {
  return transportFor((request) => {
    const answer = hosts[new URL(request.url).host];
    if (answer === undefined) return new Error(`getaddrinfo ENOTFOUND ${new URL(request.url).host}`);
    if (answer === 'hang' || answer instanceof Error) return answer;
    if (typeof answer === 'number') return { status: answer };
    return { headers: { 'docker-content-digest': answer } };
  });
}

const noCredentials: CredentialsProvider = async () => undefined;

function checker(transport: HttpTransport, credentials: CredentialsProvider = noCredentials): ImageChecker {
  return new ImageChecker(new RegistryClient(transport, credentials));
}

describe('collectReferences', () => {
  it('collects the image and the OCI Features', () => {
    const config: DevcontainerConfig = {
      image: 'mcr.microsoft.com/devcontainers/python:3.12',
      features: {
        'ghcr.io/devcontainers/features/node:1': {},
        './local-feature': {},
        'https://example.com/feature.tgz': {},
        [`ghcr.io/devcontainers/features/go@${digest('a')}`]: {},
        'ghcr.io/devcontainers/features/git': { version: 'latest' },
      },
    };
    expect(collectReferences(config)).toEqual({
      images: ['mcr.microsoft.com/devcontainers/python:3.12'],
      features: ['ghcr.io/devcontainers/features/node:1', 'ghcr.io/devcontainers/features/git'],
    });
  });

  it('collects the FROM images of the Dockerfile with build.args and ARG defaults', () => {
    const config: DevcontainerConfig = {
      build: { dockerfile: 'Dockerfile', args: { VARIANT: '3.13' }, target: 'dev' },
    };
    const dockerfile = [
      'ARG VARIANT=3.11',
      'ARG NODE=22',
      'FROM mcr.microsoft.com/devcontainers/python:${VARIANT} AS dev',
      'FROM node:${NODE} AS web',
    ].join('\n');
    expect(collectReferences(config, dockerfile)).toEqual({
      images: ['mcr.microsoft.com/devcontainers/python:3.13'],
      features: [],
    });
  });

  it('skips digest references and deduplicates', () => {
    const config: DevcontainerConfig = { image: PINNED, build: { dockerfile: 'Dockerfile' } };
    const dockerfile = `FROM alpine:3.20 AS a\nFROM ${PINNED}\nFROM alpine:3.20\nFROM ubuntu@${digest('b')}`;
    expect(collectReferences(config, dockerfile)).toEqual({ images: ['alpine:3.20'], features: [] });
  });

  it('returns empty lists for a configuration without images', () => {
    expect(collectReferences({})).toEqual({ images: [], features: [] });
  });

  it('does not check image in a Dockerfile configuration, where it only names the built image', () => {
    const dockerfile = 'FROM node:22';
    expect(collectReferences({ image: 'ghcr.io/team/dev-image', build: { dockerfile: 'Dockerfile' } }, dockerfile)).toEqual({
      images: ['node:22'],
      features: [],
    });
    expect(collectReferences({ image: 'ghcr.io/team/dev-image', dockerFile: 'Dockerfile' })).toEqual({ images: [], features: [] });
    expect(collectReferences({ image: 'ubuntu', build: { args: { A: '1' } } })).toEqual({ images: ['ubuntu'], features: [] });
  });
});

describe('ImageChecker', () => {
  it('returns the digests of all images and Features', async () => {
    const transport = registries({ 'mcr.microsoft.com': digest('1'), 'ghcr.io': digest('2') });
    const outcome = await checker(transport).check({
      images: ['mcr.microsoft.com/devcontainers/python:3.12'],
      features: ['ghcr.io/devcontainers/features/node:1'],
    });
    expect(outcome).toEqual({
      status: 'checked',
      images: { 'mcr.microsoft.com/devcontainers/python:3.12': digest('1') },
      features: { 'ghcr.io/devcontainers/features/node:1': digest('2') },
      authRequired: [],
      failed: [],
    });
  });

  it('runs all requests in parallel', async () => {
    let open = 0;
    let maxOpen = 0;
    const transport: HttpTransport = {
      async request() {
        open++;
        maxOpen = Math.max(maxOpen, open);
        await new Promise((resolve) => setTimeout(resolve, 20));
        open--;
        return { status: 200, headers: { 'docker-content-digest': digest('1') }, body: '' };
      },
    };
    await checker(transport).check({ images: ['registry.example.com/a', 'registry.example.com/b'], features: ['ghcr.io/x/y'] });
    expect(maxOpen).toBe(3);
  });

  it('returns checked without requests when there are no references', async () => {
    const transport = registries({});
    expect(await checker(transport).check({ images: [], features: [] })).toEqual({
      status: 'checked',
      images: {},
      features: {},
      authRequired: [],
      failed: [],
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('is unreachable when one registry cannot be resolved, and does not wait for the others', async () => {
    const transport = registries({ 'mcr.microsoft.com': 'hang' });
    const start = Date.now();
    const outcome = await checker(transport).check(
      { images: ['mcr.microsoft.com/devcontainers/base:bookworm'], features: ['ghcr.io/devcontainers/features/node:1'] },
      { timeoutMs: 5000 },
    );
    expect(outcome).toEqual({ status: 'unreachable', registries: ['ghcr.io'] });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('is unreachable when a registry does not answer within the time limit', async () => {
    const transport = registries({ 'ghcr.io': digest('1'), 'mcr.microsoft.com': 'hang' });
    const start = Date.now();
    const outcome = await checker(transport).check(
      { images: ['mcr.microsoft.com/devcontainers/base:bookworm', 'ghcr.io/o/r'], features: [] },
      { timeoutMs: 100 },
    );
    const elapsed = Date.now() - start;
    expect(outcome).toEqual({ status: 'unreachable', registries: ['mcr.microsoft.com'] });
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);
  });

  it('counts the token request in the time limit', async () => {
    const transport = transportFor((request) =>
      request.url.startsWith('https://auth.example.com/')
        ? 'hang'
        : { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example.com/token"' } },
    );
    const start = Date.now();
    const outcome = await checker(transport).check({ images: ['registry.example.com/a'], features: [] }, { timeoutMs: 100 });
    expect(outcome).toEqual({ status: 'unreachable', registries: ['registry.example.com'] });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('counts the credential helper call in the time limit', async () => {
    const hangingTransport = transportFor(() => ({ status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } }));
    const hangingCredentials: CredentialsProvider = () => new Promise(() => {});
    const start = Date.now();
    const outcome = await checker(hangingTransport, hangingCredentials).check(
      { images: ['registry.example.com/a'], features: [] },
      { timeoutMs: 100 },
    );
    expect(outcome).toEqual({ status: 'unreachable', registries: ['registry.example.com'] });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('does not count a hanging credential helper as an unreachable registry', async () => {
    const transport = transportFor((request) => {
      if (request.url.startsWith('https://auth.docker.io/')) return { status: 200, body: JSON.stringify({ token: 'anon' }) };
      if (request.headers?.Authorization === 'Bearer anon') return { headers: { 'docker-content-digest': digest('5') } };
      return { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } };
    });
    const client = new RegistryClient(transport, () => new Promise(() => {}), undefined, { credentialsTimeoutMs: 30 });
    const outcome = await new ImageChecker(client).check({ images: ['ubuntu'], features: [] }, { timeoutMs: 1000 });
    expect(outcome).toEqual({ status: 'checked', images: { ubuntu: digest('5') }, features: {}, authRequired: [], failed: [] });
  });

  it('asks for Feature keys as the Dev Container CLI resolves them, and keeps the keys as written', async () => {
    const transport = registries({ 'ghcr.io': digest('6') });
    const outcome = await checker(transport).check({
      images: [],
      features: ['ghcr.io/devcontainers-contrib/features/act:1', 'ghcr.io/MyOrg/Features/Tool:1'],
    });
    expect(outcome).toEqual({
      status: 'checked',
      images: {},
      features: { 'ghcr.io/devcontainers-contrib/features/act:1': digest('6'), 'ghcr.io/MyOrg/Features/Tool:1': digest('6') },
      authRequired: [],
      failed: [],
    });
    expect(transport.requests.map((request) => request.url).sort()).toEqual([
      'https://ghcr.io/v2/devcontainers-extra/features/act/manifests/1',
      'https://ghcr.io/v2/myorg/features/tool/manifests/1',
    ]);
  });

  it('is unreachable on a server error', async () => {
    const outcome = await checker(registries({ 'ghcr.io': 502 })).check({ images: ['ghcr.io/o/r'], features: [] });
    expect(outcome).toEqual({ status: 'unreachable', registries: ['ghcr.io'] });
  });

  it('keeps authRequired, notFound, and invalid references apart from unreachable', async () => {
    const transport = registries({ 'ghcr.io': 401, 'registry.example.com': 404, 'mcr.microsoft.com': digest('3') });
    const outcome = await checker(transport).check({
      images: ['ghcr.io/o/private', 'registry.example.com/missing', 'mcr.microsoft.com/a', 'Invalid Reference'],
      features: ['ghcr.io/o/feature'],
    });
    expect(outcome).toEqual({
      status: 'checked',
      images: { 'mcr.microsoft.com/a': digest('3') },
      features: {},
      authRequired: ['ghcr.io'],
      failed: ['ghcr.io/o/private', 'registry.example.com/missing', 'Invalid Reference', 'ghcr.io/o/feature'],
    });
  });

  it('rejects with an AbortError when the caller cancels', async () => {
    const controller = new AbortController();
    const pending = checker(registries({ 'ghcr.io': 'hang' })).check(
      { images: ['ghcr.io/o/r'], features: [] },
      { timeoutMs: 5000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    const error = await pending.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
  });

  it('rejects at once for an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await checker(registries({})).check({ images: ['a'], features: [] }, { signal: controller.signal }).catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
  });
});

describe('compareWithBuildRecord', () => {
  const record: BuildRecord = {
    builtAt: '2026-09-24T15:44:00Z',
    environmentImage: 'devenv-3f2a9c1e:2',
    buildNumber: 2,
    configPath: '.devcontainer/devcontainer.json',
    configHash: 'sha256:7d0f',
    images: { 'mcr.microsoft.com/devcontainers/python:3.12': digest('1') },
    features: { 'ghcr.io/devcontainers/features/node:1': digest('2') },
  };

  const outcome = (overrides: Partial<CheckedOutcome> = {}): CheckedOutcome => ({
    status: 'checked',
    images: { 'mcr.microsoft.com/devcontainers/python:3.12': digest('1') },
    features: { 'ghcr.io/devcontainers/features/node:1': digest('2') },
    authRequired: [],
    failed: [],
    ...overrides,
  });

  it('is up to date when all digests are equal', () => {
    expect(compareWithBuildRecord(record, outcome())).toEqual({ upToDate: true, changedImages: [], changedFeatures: [] });
  });

  it('compares digests without regard to case', () => {
    const upper = outcome({ images: { 'mcr.microsoft.com/devcontainers/python:3.12': digest('A') } });
    const lowerRecord = { ...record, images: { 'mcr.microsoft.com/devcontainers/python:3.12': digest('a') } };
    expect(compareWithBuildRecord(lowerRecord, upper).upToDate).toBe(true);
  });

  it('reports changed images and Features', () => {
    const changed = outcome({
      images: { 'mcr.microsoft.com/devcontainers/python:3.12': digest('9') },
      features: { 'ghcr.io/devcontainers/features/node:1': digest('8') },
    });
    expect(compareWithBuildRecord(record, changed)).toEqual({
      upToDate: false,
      changedImages: ['mcr.microsoft.com/devcontainers/python:3.12'],
      changedFeatures: ['ghcr.io/devcontainers/features/node:1'],
    });
  });

  it('counts a reference that is not in the record as changed', () => {
    const added = outcome({ features: { 'ghcr.io/devcontainers/features/node:1': digest('2'), 'ghcr.io/devcontainers/features/go:1': digest('4') } });
    expect(compareWithBuildRecord(record, added)).toEqual({
      upToDate: false,
      changedImages: [],
      changedFeatures: ['ghcr.io/devcontainers/features/go:1'],
    });
  });

  it('counts a failed reference as unchanged, also when it is not in the record', () => {
    const failed = outcome({
      images: {},
      features: {},
      failed: ['mcr.microsoft.com/devcontainers/python:3.12', 'ghcr.io/devcontainers/features/node:1', 'ghcr.io/o/new'],
    });
    expect(compareWithBuildRecord(record, failed)).toEqual({ upToDate: true, changedImages: [], changedFeatures: [] });
  });

  it('ignores references of the record that the configuration no longer has', () => {
    expect(compareWithBuildRecord(record, outcome({ features: {} })).upToDate).toBe(true);
  });

  it('counts everything as changed without a record', () => {
    expect(compareWithBuildRecord(undefined, outcome())).toEqual({
      upToDate: false,
      changedImages: ['mcr.microsoft.com/devcontainers/python:3.12'],
      changedFeatures: ['ghcr.io/devcontainers/features/node:1'],
    });
    expect(compareWithBuildRecord(undefined, outcome({ images: {}, features: {} })).upToDate).toBe(false);
  });
});
