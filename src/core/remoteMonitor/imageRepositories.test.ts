// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { ghcrOwnerOf, ghcrRepositories } from './imageRepositories';
import { isImageRepository, parseImageListInput } from './protocol';

function transport(answer: (request: HttpRequest) => HttpResponse) {
  const requests: HttpRequest[] = [];
  const value: HttpTransport = {
    request: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  return { transport: value, requests };
}

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

// User request 2026-09-28 ("all images"): the repositories of the prefixes from the packages of GitHub.
describe('ghcrRepositories', () => {
  it('lists the container packages of the owner that start with a prefix, as ghcr.io repositories; the token only in the header', async () => {
    const { transport: http, requests } = transport((request) =>
      ok(request.url.includes('page=1') ? [{ name: 'devcontainer-dev' }, { name: 'devcontainer-classroom-web' }, { name: 'website' }, { name: 'devcontainer-base' }] : []),
    );
    const repositories = await ghcrRepositories(http, 'gho_token', ['ghcr.io/majikmate/devcontainer-classroom', 'ghcr.io/majikmate/devcontainer-dev', 'docker.io/x/y']);
    expect(repositories).toEqual(['ghcr.io/majikmate/devcontainer-classroom-web', 'ghcr.io/majikmate/devcontainer-dev']);
    expect(requests.map((request) => request.url)).toEqual(['https://api.github.com/orgs/majikmate/packages?package_type=container&per_page=100&page=1']);
    expect(requests[0].headers?.authorization).toBe('Bearer gho_token');
    expect(requests[0].url).not.toContain('gho_token');
  });

  it('reads further pages, and the packages of a user when the owner is no organization', async () => {
    const { transport: http, requests } = transport((request) => {
      if (request.url.includes('/orgs/')) return { status: 404, headers: {}, body: '{}' };
      if (request.url.endsWith('page=1')) return ok(Array.from({ length: 100 }, (_, index) => ({ name: `devcontainer-dev-${index}` })));
      return ok([{ name: 'devcontainer-dev-last' }]);
    });
    const repositories = await ghcrRepositories(http, 't', ['ghcr.io/someone/devcontainer-dev']);
    expect(repositories).toHaveLength(101);
    expect(requests.map((request) => request.url.replace('https://api.github.com', ''))).toEqual([
      '/orgs/someone/packages?package_type=container&per_page=100&page=1',
      '/users/someone/packages?package_type=container&per_page=100&page=1',
      '/users/someone/packages?package_type=container&per_page=100&page=2',
    ]);
  });

  // Review round 1 of PR #57 (J): the monitor reads the tags without a token; a private package could never be updated.
  it('lists only public packages', async () => {
    const { transport: http } = transport(() =>
      ok([
        { name: 'devcontainer-dev', visibility: 'public' },
        { name: 'devcontainer-dev-secret', visibility: 'private' },
        { name: 'devcontainer-dev-inside', visibility: 'internal' },
      ]),
    );
    expect(await ghcrRepositories(http, 't', ['ghcr.io/majikmate/devcontainer-dev'])).toEqual(['ghcr.io/majikmate/devcontainer-dev']);
  });

  it('rejects when GitHub refuses (for example a token without read:packages)', async () => {
    const { transport: http } = transport(() => ({ status: 403, headers: {}, body: '{}' }));
    await expect(ghcrRepositories(http, 't', ['ghcr.io/majikmate/devcontainer-dev'])).rejects.toThrow('GitHub answered HTTP 403 for the packages of majikmate.');
  });

  it('knows the owner of a ghcr.io prefix only', () => {
    expect(ghcrOwnerOf('ghcr.io/majikmate/devcontainer-dev')).toEqual({ owner: 'majikmate', namePrefix: 'devcontainer-dev' });
    expect(ghcrOwnerOf('docker.io/library/ubuntu')).toBeUndefined();
  });
});

describe('the image list of the monitor protocol', () => {
  it('accepts repositories with a registry, in lower case, without tag or digest', () => {
    expect(isImageRepository('ghcr.io/majikmate/devcontainer-dev')).toBe(true);
    expect(isImageRepository('localhost:5000/team/app')).toBe(true);
    for (const value of ['ubuntu', 'library/ubuntu', 'ghcr.io/A/b', 'ghcr.io/a/b:2', 'ghcr.io/a/b@sha256:00', 'ghcr.io/a//b', 'ghcr.io/-a/b']) {
      expect(isImageRepository(value), value).toBe(false);
    }
    expect(parseImageListInput(JSON.stringify({ repositories: Array.from({ length: 501 }, (_, index) => `ghcr.io/a/b${index}`) }))).toBeUndefined();
  });
});
