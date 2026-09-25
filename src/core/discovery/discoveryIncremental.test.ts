// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Incremental detection of the discovery (concept 7.4): after the first load, a refresh reads the configurations only
// of new and changed repositories, in aliased batches.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import type { Logger } from '../ports';
import { GitHubApi } from './githubApi';
import {
  DISCOVERY_LIST_QUERY,
  DISCOVERY_QUERY,
  DiscoveryService,
  LOOKUP_BATCH_SIZE,
  OWNER_REPOSITORIES_QUERY,
  SCOPE_VIEWER_QUERY,
} from './discoveryService';

const TOKEN = 'gho_secretTokenValue123';
const ACCOUNT_ID = '1001';
const clock = { now: () => Date.parse('2026-09-25T12:00:00.000Z') };

interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
}

interface FakeRepository {
  nameWithOwner: string;
  pushedAt: string;
  config: boolean;
}

/**
 * A small GitHub: answers the list queries, the owner queries, and the batches of configuration lookups from `repos`.
 * `lookupErrors` makes the lookup of these repositories fail with an error.
 */
class FakeGitHub implements HttpTransport {
  readonly requests: GraphQLRequest[] = [];
  repos: FakeRepository[] = [];
  lookupErrors = new Set<string>();
  /** Answers with a timeout error while a batch has more than this many repositories. */
  batchLimit = Infinity;
  open = 0;
  peak = 0;

  async request(request: HttpRequest): Promise<HttpResponse> {
    const parsed = JSON.parse(request.body ?? '{}') as GraphQLRequest;
    this.requests.push(parsed);
    this.open++;
    this.peak = Math.max(this.peak, this.open);
    await new Promise((resolve) => setTimeout(resolve, 3));
    this.open--;
    return { status: 200, headers: {}, body: JSON.stringify(this.answer(parsed)) };
  }

  ofQuery(query: string): GraphQLRequest[] {
    return this.requests.filter((request) => request.query === query);
  }

  lookups(): GraphQLRequest[] {
    return this.requests.filter((request) => request.query.startsWith('query Configurations('));
  }

  private answer({ query, variables }: GraphQLRequest): unknown {
    if (query === DISCOVERY_QUERY || query === DISCOVERY_LIST_QUERY) {
      const repositories = this.page(this.repos, variables, query === DISCOVERY_QUERY);
      return { data: { viewer: { login: 'octo', databaseId: 1001, organizations: { pageInfo: { hasNextPage: false }, nodes: [] }, repositories } } };
    }
    if (query === SCOPE_VIEWER_QUERY) {
      return { data: { viewer: { login: 'octo', databaseId: 1001, organizations: { pageInfo: { hasNextPage: false }, nodes: [{ login: 'acme' }] } } } };
    }
    if (query === OWNER_REPOSITORIES_QUERY) {
      const login = String(variables.login).toLowerCase();
      const own = this.repos.filter((repo) => repo.nameWithOwner.split('/')[0].toLowerCase() === login);
      const repositories = this.page(own, variables, variables.withConfigurations === true);
      return { data: { repositoryOwner: { __typename: 'Organization', login, repositories } } };
    }
    if (query.startsWith('query Configurations(')) {
      const count = Object.keys(variables).length / 2;
      if (count > this.batchLimit) {
        return { data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout.' }] };
      }
      const data: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const name = `${String(variables[`o${i}`])}/${String(variables[`n${i}`])}`;
        const repo = this.repos.find((candidate) => candidate.nameWithOwner === name);
        if (this.lookupErrors.has(name)) {
          data[`r${i}`] = null;
          errors.push({ type: 'SERVICE_UNAVAILABLE', message: 'Something failed', path: [`r${i}`] });
        } else {
          data[`r${i}`] = repo ? lookups(repo) : null;
        }
      }
      return { data, ...(errors.length > 0 ? { errors } : {}) };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  }

  private page(repos: FakeRepository[], variables: Record<string, unknown>, withLookups: boolean): unknown {
    const start = variables.cursor === null ? 0 : Number(variables.cursor);
    const size = Number(variables.pageSize);
    const slice = repos.slice(start, start + size);
    const end = start + slice.length;
    return {
      pageInfo: { hasNextPage: end < repos.length, endCursor: String(end) },
      nodes: slice.map((repo) => ({ ...listFields(repo), ...(withLookups ? lookups(repo) : {}) })),
    };
  }
}

function listFields(repo: FakeRepository): Record<string, unknown> {
  const [owner, name] = repo.nameWithOwner.split('/');
  return {
    id: `R_${repo.nameWithOwner}`,
    name,
    nameWithOwner: repo.nameWithOwner,
    url: `https://github.com/${repo.nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: true,
    pushedAt: repo.pushedAt,
    owner: { login: owner },
    defaultBranchRef: { name: 'main' },
  };
}

function lookups(repo: FakeRepository): Record<string, unknown> {
  return { rootFile: repo.config ? { __typename: 'Blob' } : null, folder: null };
}

function repo(nameWithOwner: string, config = true, pushedAt = '2026-09-20T10:00:00Z'): FakeRepository {
  return { nameWithOwner, pushedAt, config };
}

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), output: (t) => lines.push(t) };
}

let dir: string;
let file: string;
let github: FakeGitHub;
let owners: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-incremental-'));
  file = path.join(dir, `repositories-${ACCOUNT_ID}.json`);
  github = new FakeGitHub();
  owners = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function service(logger?: Logger): DiscoveryService {
  return new DiscoveryService(new GitHubApi(github), () => file, logger, clock, { scope: () => owners });
}

/** The operation name of a request, for example `query Configurations`. */
const operation = (request: GraphQLRequest) => /^query \w+/.exec(request.query)?.[0];
const names = (list: Array<{ nameWithOwner: string }>) => list.map((item) => item.nameWithOwner);

describe('incremental detection, empty scope', () => {
  it('reads the configurations with the list on the first load, and stores the repositories without one', async () => {
    github.repos = [repo('acme/api'), repo('acme/empty', false)];
    const result = await service().refresh(TOKEN, ACCOUNT_ID);
    expect(github.requests.map((request) => request.query)).toEqual([DISCOVERY_QUERY]);
    expect(names(result.repositories)).toEqual(['acme/api']);
    expect(result.withoutConfiguration).toEqual([{ nameWithOwner: 'acme/empty', pushedAt: '2026-09-20T10:00:00Z', defaultBranch: 'main' }]);
  });

  it('reads only the list when nothing changed: no configuration lookup, 100 repositories per request', async () => {
    github.repos = [repo('acme/api'), repo('acme/empty', false)];
    const first = await service().refresh(TOKEN, ACCOUNT_ID);
    github.requests.length = 0;
    const second = await service().refresh(TOKEN, ACCOUNT_ID);
    expect(github.requests.map((request) => request.query)).toEqual([DISCOVERY_LIST_QUERY]);
    expect(github.requests[0].variables).toEqual({ cursor: null, pageSize: 100, withOrganizations: true });
    expect(DISCOVERY_LIST_QUERY).not.toMatch(/rootFile|folder|ConfigurationLookups/);
    expect(second.repositories).toEqual(first.repositories);
    expect(second.withoutConfiguration).toEqual(first.withoutConfiguration);
  });

  it('reads the configurations only of new repositories and of repositories with another pushedAt', async () => {
    github.repos = [repo('acme/api'), repo('acme/web'), repo('acme/empty', false), repo('acme/stale', false)];
    await service().refresh(TOKEN, ACCOUNT_ID);
    github.requests.length = 0;
    github.repos = [
      repo('acme/api'),
      // The configuration was removed with a push.
      repo('acme/web', false, '2026-09-24T09:00:00Z'),
      // A configuration was added with a push.
      repo('acme/empty', true, '2026-09-24T10:00:00Z'),
      // Changed on GitHub without a push: not read again, the stored result stays.
      repo('acme/stale', true),
      repo('acme/new'),
    ];
    const logger = recordingLogger();
    const result = await service(logger).refresh(TOKEN, ACCOUNT_ID);
    expect(github.requests.map((request) => operation(request))).toEqual(['query DiscoverList', 'query Configurations']);
    expect(github.lookups()[0].variables).toEqual({ o0: 'acme', n0: 'web', o1: 'acme', n1: 'empty', o2: 'acme', n2: 'new' });
    expect(names(result.repositories)).toEqual(['acme/api', 'acme/empty', 'acme/new']);
    expect(names(result.withoutConfiguration ?? [])).toEqual(['acme/web', 'acme/stale']);
    expect(logger.lines).toContain('Repository list: 3 new or changed repositories, configurations read with 1 requests.');
    expect(logger.lines.some((line) => /^Repository list: loaded in \d+\.\d seconds with 2 requests\.$/.test(line))).toBe(true);
  });

  it('reads the changed repositories in batches of 50, at most 4 requests at the same time', async () => {
    const many = Array.from({ length: 230 }, (_, i) => repo(`acme/r${i}`, i % 2 === 0));
    github.repos = many;
    await service().refresh(TOKEN, ACCOUNT_ID);
    github.requests.length = 0;
    github.peak = 0;
    github.repos = many.map((item) => ({ ...item, pushedAt: '2026-09-25T08:00:00Z' }));
    const result = await service().refresh(TOKEN, ACCOUNT_ID);
    expect(LOOKUP_BATCH_SIZE).toBe(50);
    expect(github.lookups().map((request) => Object.keys(request.variables).length / 2)).toEqual([50, 50, 50, 50, 30]);
    expect(github.peak).toBe(4);
    expect(result.repositories).toHaveLength(115);
  });

  it('splits a batch that GitHub does not answer in time', async () => {
    github.repos = [repo('acme/a')];
    await service().refresh(TOKEN, ACCOUNT_ID);
    github.repos = Array.from({ length: 40 }, (_, i) => repo(`acme/n${i}`));
    github.batchLimit = 20;
    github.requests.length = 0;
    const result = await service(recordingLogger()).refresh(TOKEN, ACCOUNT_ID);
    expect(github.lookups().map((request) => Object.keys(request.variables).length / 2)).toEqual([40, 20, 20]);
    expect(result.repositories).toHaveLength(40);
  });

  it('reads a repository again whose lookup failed, and does not keep it as without configuration', async () => {
    github.repos = [repo('acme/api')];
    await service().refresh(TOKEN, ACCOUNT_ID);
    github.repos = [repo('acme/api'), repo('acme/flaky')];
    github.lookupErrors.add('acme/flaky');
    const second = await service(recordingLogger()).refresh(TOKEN, ACCOUNT_ID);
    expect(names(second.repositories)).toEqual(['acme/api']);
    expect(second.withoutConfiguration).toEqual([]);
    github.lookupErrors.clear();
    github.requests.length = 0;
    const third = await service().refresh(TOKEN, ACCOUNT_ID);
    expect(github.lookups()[0].variables).toEqual({ o0: 'acme', n0: 'flaky' });
    expect(names(third.repositories)).toEqual(['acme/api', 'acme/flaky']);
  });

  it('reads the repositories without configuration of a list of an older version once', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, fetchedAt: '', viewerLogin: 'octo', organizations: [], hints: [], repositories: [] }),
    );
    github.repos = [repo('acme/empty', false)];
    const result = await service().refresh(TOKEN, ACCOUNT_ID);
    expect(github.requests.map((request) => operation(request))).toEqual(['query DiscoverList', 'query Configurations']);
    expect(names(result.withoutConfiguration ?? [])).toEqual(['acme/empty']);
  });
});

describe('incremental detection with a scan scope', () => {
  it('lists the owners without lookups, and reads only the changed repositories of the scope', async () => {
    owners = ['acme'];
    github.repos = [repo('acme/api'), repo('acme/web', false), repo('other/secret')];
    const first = await service().refresh(TOKEN, ACCOUNT_ID);
    expect(github.ofQuery(OWNER_REPOSITORIES_QUERY).map((request) => request.variables)).toEqual([
      { login: 'acme', cursor: null, pageSize: 50, withConfigurations: true },
    ]);
    expect(names(first.repositories)).toEqual(['acme/api']);
    github.requests.length = 0;
    github.repos = [repo('acme/api'), repo('acme/web', true, '2026-09-24T09:00:00Z'), repo('other/secret', true, '2026-09-24T09:00:00Z')];
    const second = await service().refresh(TOKEN, ACCOUNT_ID);
    expect(github.requests.map((request) => operation(request))).toEqual([
      'query ScopeViewer',
      'query OwnerRepositories',
      'query Configurations',
    ]);
    expect(github.ofQuery(OWNER_REPOSITORIES_QUERY)[0].variables).toEqual({ login: 'acme', cursor: null, pageSize: 100, withConfigurations: false });
    expect(github.lookups()[0].variables).toEqual({ o0: 'acme', n0: 'web' });
    expect(JSON.stringify(github.requests)).not.toContain('other');
    expect(names(second.repositories)).toEqual(['acme/api', 'acme/web']);
  });

  it('uses the stored detections of a list of another scope, but lists only the owners of the new scope', async () => {
    github.repos = [repo('acme/api'), repo('beta/tool')];
    await service().refresh(TOKEN, ACCOUNT_ID);
    owners = ['beta'];
    github.requests.length = 0;
    const result = await service().refresh(TOKEN, ACCOUNT_ID);
    expect(github.requests.map((request) => operation(request))).toEqual(['query ScopeViewer', 'query OwnerRepositories']);
    expect(names(result.repositories)).toEqual(['beta/tool']);
    expect(result.scope).toEqual(['beta']);
  });
});
