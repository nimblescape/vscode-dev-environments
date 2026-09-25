// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  credentialServerName,
  hasDigest,
  isDockerHub,
  isOciFeatureReference,
  parseFeatureReference,
  parseImageReference,
  registryDisplayName,
} from './reference';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('parseImageReference', () => {
  const table: Array<[string, { registry: string; repository: string; tag: string; digest?: string }]> = [
    ['ubuntu', { registry: 'registry-1.docker.io', repository: 'library/ubuntu', tag: 'latest' }],
    ['ubuntu:22.04', { registry: 'registry-1.docker.io', repository: 'library/ubuntu', tag: '22.04' }],
    ['library/ubuntu', { registry: 'registry-1.docker.io', repository: 'library/ubuntu', tag: 'latest' }],
    ['docker.io/x/y', { registry: 'registry-1.docker.io', repository: 'x/y', tag: 'latest' }],
    ['docker.io/ubuntu', { registry: 'registry-1.docker.io', repository: 'library/ubuntu', tag: 'latest' }],
    ['index.docker.io/ubuntu:20.04', { registry: 'registry-1.docker.io', repository: 'library/ubuntu', tag: '20.04' }],
    ['x/y:1.0', { registry: 'registry-1.docker.io', repository: 'x/y', tag: '1.0' }],
    ['localhost:5000/a', { registry: 'localhost:5000', repository: 'a', tag: 'latest' }],
    ['localhost/a:b', { registry: 'localhost', repository: 'a', tag: 'b' }],
    [
      'mcr.microsoft.com/devcontainers/python:3.12',
      { registry: 'mcr.microsoft.com', repository: 'devcontainers/python', tag: '3.12' },
    ],
    [
      `ghcr.io/o/r@${DIGEST}`,
      { registry: 'ghcr.io', repository: 'o/r', tag: 'latest', digest: DIGEST },
    ],
    [
      `ghcr.io/o/r:1@${DIGEST}`,
      { registry: 'ghcr.io', repository: 'o/r', tag: '1', digest: DIGEST },
    ],
    [
      'ghcr.io/devcontainers/features/node:1',
      { registry: 'ghcr.io', repository: 'devcontainers/features/node', tag: '1' },
    ],
    ['GHCR.IO/o/r', { registry: 'ghcr.io', repository: 'o/r', tag: 'latest' }],
    ['[::1]:5000/repo:tag', { registry: '[::1]:5000', repository: 'repo', tag: 'tag' }],
    ['my-registry.example.com:8443/team/app_x.y__z-w:v1.2-rc_3', {
      registry: 'my-registry.example.com:8443',
      repository: 'team/app_x.y__z-w',
      tag: 'v1.2-rc_3',
    }],
  ];

  it.each(table)('normalizes %s', (reference, expected) => {
    const parsed = parseImageReference(reference);
    expect(parsed).toBeDefined();
    expect(parsed).toEqual({ original: reference, ...expected });
  });

  it('keeps the original text as written', () => {
    expect(parseImageReference(' ubuntu ')?.original).toBe(' ubuntu ');
  });

  it.each([
    '',
    '   ',
    'Ubuntu',
    'ubuntu:',
    'ubuntu@sha256:abc',
    '${BASE_IMAGE}',
    'mcr.microsoft.com/devcontainers/python:${VARIANT}',
    '/ubuntu',
    'ubuntu/',
    'a//b',
    'ubuntu:tag with space',
    'ubuntu:-bad',
    'exa_mple.com/a/b',
    `x/${'a'.repeat(300)}`,
    'ubuntu:$TAG',
  ])('rejects %j', (reference) => {
    expect(parseImageReference(reference)).toBeUndefined();
  });
});

describe('hasDigest', () => {
  it('detects digest references, also invalid ones', () => {
    expect(hasDigest(`ubuntu@${DIGEST}`)).toBe(true);
    expect(hasDigest(`ghcr.io/o/r:1@${DIGEST}`)).toBe(true);
    expect(hasDigest('ghcr.io/o/r@sha256:short')).toBe(true);
    expect(hasDigest('ubuntu:22.04')).toBe(false);
    expect(hasDigest('ghcr.io/devcontainers/features/node:1')).toBe(false);
  });
});

describe('credentialServerName', () => {
  it('uses the index server name for Docker Hub', () => {
    expect(credentialServerName('registry-1.docker.io')).toBe('https://index.docker.io/v1/');
    expect(credentialServerName('docker.io')).toBe('https://index.docker.io/v1/');
    expect(credentialServerName('index.docker.io')).toBe('https://index.docker.io/v1/');
  });

  it('uses the host for other registries', () => {
    expect(credentialServerName('ghcr.io')).toBe('ghcr.io');
    expect(credentialServerName('localhost:5000')).toBe('localhost:5000');
  });

  it('names Docker Hub docker.io in messages', () => {
    expect(registryDisplayName('registry-1.docker.io')).toBe('docker.io');
    expect(registryDisplayName('ghcr.io')).toBe('ghcr.io');
    expect(isDockerHub('Docker.IO')).toBe(true);
    expect(isDockerHub('ghcr.io')).toBe(false);
  });
});

describe('parseFeatureReference', () => {
  it('lower-cases the key as the Dev Container CLI does, and keeps the original text', () => {
    expect(parseFeatureReference('GHCR.io/MyOrg/Features/Node:LTS')).toEqual({
      original: 'GHCR.io/MyOrg/Features/Node:LTS',
      registry: 'ghcr.io',
      repository: 'myorg/features/node',
      tag: 'lts',
    });
  });

  it('redirects devcontainers-contrib to devcontainers-extra, as the Dev Container CLI does', () => {
    expect(parseFeatureReference('ghcr.io/devcontainers-contrib/features/act:1')).toEqual({
      original: 'ghcr.io/devcontainers-contrib/features/act:1',
      registry: 'ghcr.io',
      repository: 'devcontainers-extra/features/act',
      tag: '1',
    });
    expect(parseFeatureReference('ghcr.io/owner/devcontainers-contrib/x:1')?.repository).toBe('owner/devcontainers-contrib/x');
  });

  it('parses other Feature keys like image references', () => {
    expect(parseFeatureReference('ghcr.io/devcontainers/features/node:1')).toEqual(parseImageReference('ghcr.io/devcontainers/features/node:1'));
    expect(parseFeatureReference('ghcr.io/devcontainers/features/node')?.tag).toBe('latest');
    expect(parseFeatureReference('ghcr.io/o/f:${VERSION}')).toBeUndefined();
  });
});

describe('isOciFeatureReference', () => {
  it.each([
    ['ghcr.io/devcontainers/features/node:1', true],
    ['ghcr.io/devcontainers/features/node', true],
    ['ghcr.io/devcontainers/features/node@sha256:abc', true],
    ['localhost:5000/features/x:1', true],
    ['localhost/features/x', true],
    ['myregistry.azurecr.io/features/go:2', true],
    ['./local-feature', false],
    ['../shared/feature', false],
    ['/abs/feature', false],
    ['.\\windows-feature', false],
    ['C:\\features\\x', false],
    ['C:/features/x', false],
    ['https://example.com/features/node.tgz', false],
    ['http://example.com/feature', false],
    ['ghcr.io/o/feature.tgz', false],
    ['features/devcontainer-feature.tar.gz', false],
    ['node', false],
    ['docker-in-docker', false],
    ['owner/repo/feature@v1', false],
    ['', false],
  ])('%j → %s', (key, expected) => {
    expect(isOciFeatureReference(key)).toBe(expected);
  });
});
