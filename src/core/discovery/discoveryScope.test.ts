// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scan scope of the discovery (concept 7.4, setting `owners`): exactly the expected requests, and none about another
// owner.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import type { Logger } from '../ports';
import type { DiscoveryData } from '../types';
import { GitHubApi, type GraphQLError } from './githubApi';
import {
  DISCOVERY_CONCURRENCY,
  DISCOVERY_QUERY,
  DiscoveryService,
  OWNER_REPOSITORIES_QUERY,
  parseDiscoveryData,
  SCOPE_VIEWER_QUERY,
  VIEWER_REPOSITORIES_QUERY,
} from './discoveryService';

const TOKEN = 'gho_secretTokenValue123';
const ACCOUNT_ID = '1001';
const clock = { now: () => Date.parse('2026-09-25T12:00:00.000Z') };
const SAML_MESSAGE =
  'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.';

interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
}

type Reply = { status?: number; body: unknown } | Error;

/** Answers each request after `delayMs`, and records the requests and the most requests that were open at once. */
class AsyncFakeGitHub implements HttpTransport {
  readonly requests: GraphQLRequest[] = [];
  open = 0;
  peak = 0;
  constructor(
    private readonly handler: (request: GraphQLRequest) => Reply,
    private readonly delayMs = 5,
  ) {}
  async request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    const parsed = JSON.parse(request.body ?? '{}') as GraphQLRequest;
    this.requests.push(parsed);
    this.open++;
    this.peak = Math.max(this.peak, this.open);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    } finally {
      this.open--;
    }
    const reply = this.handler(parsed);
    if (reply instanceof Error) throw reply;
    return { status: reply.status ?? 200, headers: {}, body: JSON.stringify(reply.body) };
  }
  ofQuery(query: string): GraphQLRequest[] {
    return this.requests.filter((request) => request.query === query);
  }
}

function repoNode(nameWithOwner: string, config = true): Record<string, unknown> {
  const [owner, name] = nameWithOwner.split('/');
  return {
    id: `R_${nameWithOwner}`,
    name,
    nameWithOwner,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: true,
    viewerPermission: 'WRITE',
    pushedAt: '2026-09-20T10:00:00Z',
    owner: { login: owner },
    defaultBranchRef: { name: 'main' },
    rootFile: null,
    folder: config ? { entries: [{ name: 'devcontainer.json', type: 'blob' }] } : null,
  };
}

function connection(nodes: Array<Record<string, unknown> | null>, endCursor: string | null = null) {
  return { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes };
}

function viewerReply(login = 'octo', organizations = ['acme', 'beta', 'gamma'], databaseId = 1001): Reply {
  return {
    body: { data: { viewer: { login, databaseId, organizations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: organizations.map((org) => ({ login: org })) } } } },
  };
}

function ownerReply(login: string, nodes: Array<Record<string, unknown> | null>, endCursor: string | null = null, errors?: GraphQLError[]): Reply {
  return { body: { data: { repositoryOwner: { __typename: 'Organization', login, repositories: connection(nodes, endCursor) } }, ...(errors ? { errors } : {}) } };
}

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
    output: (text) => lines.push(text),
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-scope-'));
  file = path.join(dir, `repositories-${ACCOUNT_ID}.json`);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function service(transport: HttpTransport, owners: string[], logger?: Logger): DiscoveryService {
  return new DiscoveryService(new GitHubApi(transport), () => file, logger, clock, { scope: () => owners });
}

/** The owners that the requests of a refresh were about, in lower case. */
function ownersAskedAbout(requests: GraphQLRequest[]): string[] {
  return requests
    .filter((request) => request.query === OWNER_REPOSITORIES_QUERY)
    .map((request) => String(request.variables.login).toLowerCase());
}

describe('DiscoveryService.refresh with a scan scope', () => {
  it('asks only about the configured owners: the account, then one owner query each, and never the full list', async () => {
    const transport = new AsyncFakeGitHub((request) => {
      if (request.query === SCOPE_VIEWER_QUERY) return viewerReply();
      if (request.query === OWNER_REPOSITORIES_QUERY) {
        const login = request.variables.login as string;
        return ownerReply(login, [repoNode(`${login}/api`), repoNode(`${login}/empty`, false)]);
      }
      throw new Error(`unexpected query ${request.query.slice(0, 40)}`);
    });
    const logger = recordingLogger();
    const result = await service(transport, ['acme', ' Beta ', 'ACME'], logger).refresh(TOKEN, ACCOUNT_ID);

    expect(transport.requests.map((request) => request.query)).toEqual([SCOPE_VIEWER_QUERY, OWNER_REPOSITORIES_QUERY, OWNER_REPOSITORIES_QUERY]);
    expect(transport.requests[0].variables).toEqual({});
    expect(transport.ofQuery(OWNER_REPOSITORIES_QUERY).map((request) => request.variables)).toEqual([
      { login: 'acme', cursor: null, pageSize: 50, withConfigurations: true },
      { login: 'Beta', cursor: null, pageSize: 50, withConfigurations: true },
    ]);
    expect(transport.ofQuery(DISCOVERY_QUERY)).toHaveLength(0);
    expect(result.repositories.map((info) => info.nameWithOwner)).toEqual(['acme/api', 'Beta/api']);
    expect(result.organizations).toEqual(['acme', 'beta', 'gamma']);
    expect(result.scope).toEqual(['acme', 'beta']);
    expect(result.hints).toEqual([]);
    expect(parseDiscoveryData(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(result);
    expect(logger.lines.some((line) => /loaded in \d+\.\d seconds with 3 requests \(scan scope: acme, Beta\)/.test(line))).toBe(true);
    expect(logger.lines.join('\n')).not.toContain(TOKEN);
  });

  it('reads the signed-in account itself through viewer, with its private repositories', async () => {
    const transport = new AsyncFakeGitHub((request) => {
      if (request.query === SCOPE_VIEWER_QUERY) return viewerReply('Octo');
      if (request.query === VIEWER_REPOSITORIES_QUERY) {
        return { body: { data: { viewer: { login: 'Octo', repositories: connection([repoNode('Octo/dotfiles')]) } } } };
      }
      return ownerReply(request.variables.login as string, [repoNode('acme/api')]);
    });
    const result = await service(transport, ['octo', 'acme'], undefined).refresh(TOKEN, ACCOUNT_ID);
    expect(VIEWER_REPOSITORIES_QUERY).toMatch(/affiliations: \[OWNER\]\s+ownerAffiliations: \[OWNER\]/);
    expect(transport.ofQuery(VIEWER_REPOSITORIES_QUERY).map((request) => request.variables)).toEqual([
      { cursor: null, pageSize: 50, withConfigurations: true },
    ]);
    expect(ownersAskedAbout(transport.requests)).toEqual(['acme']);
    expect(result.repositories.map((info) => info.nameWithOwner)).toEqual(['Octo/dotfiles', 'acme/api']);
  });

  it('reads the pages of one owner one after another, and never more than 4 requests at the same time', async () => {
    const owners = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
    const openPerOwner = new Map<string, number>();
    let ownerOverlap = false;
    const transport = new AsyncFakeGitHub((request) => {
      if (request.query === SCOPE_VIEWER_QUERY) return viewerReply('octo', owners);
      const login = request.variables.login as string;
      const cursor = request.variables.cursor as string | null;
      return cursor === null
        ? ownerReply(login, [repoNode(`${login}/a`)], `${login}-c1`)
        : ownerReply(login, [repoNode(`${login}/b`)]);
    }, 10);
    // Tracks open requests per owner through the transport.
    const tracking: HttpTransport = {
      request: async (request, signal) => {
        const login = (JSON.parse(request.body ?? '{}') as GraphQLRequest).variables.login as string | undefined;
        if (login) {
          const open = (openPerOwner.get(login) ?? 0) + 1;
          if (open > 1) ownerOverlap = true;
          openPerOwner.set(login, open);
        }
        try {
          return await transport.request(request, signal);
        } finally {
          if (login) openPerOwner.set(login, (openPerOwner.get(login) ?? 1) - 1);
        }
      },
    };
    const result = await service(tracking, owners).refresh(TOKEN, ACCOUNT_ID);
    expect(DISCOVERY_CONCURRENCY).toBe(4);
    expect(transport.peak).toBe(4);
    expect(ownerOverlap).toBe(false);
    expect(transport.ofQuery(OWNER_REPOSITORIES_QUERY)).toHaveLength(12);
    for (const owner of owners) {
      expect(transport.ofQuery(OWNER_REPOSITORIES_QUERY).filter((request) => request.variables.login === owner).map((request) => request.variables.cursor)).toEqual([
        null,
        `${owner}-c1`,
      ]);
    }
    // The order of the scope, then the order of the pages.
    expect(result.repositories.map((info) => info.nameWithOwner)).toEqual(owners.flatMap((owner) => [`${owner}/a`, `${owner}/b`]));
  });

  it('shows a hint for an owner that GitHub does not return, without an error', async () => {
    const transport = new AsyncFakeGitHub((request) => {
      if (request.query === SCOPE_VIEWER_QUERY) return viewerReply();
      if (request.variables.login === 'nobody-here') {
        return {
          body: {
            data: { repositoryOwner: null },
            errors: [{ type: 'NOT_FOUND', path: ['repositoryOwner'], message: "Could not resolve to a RepositoryOwner with the login of 'nobody-here'." }],
          },
        };
      }
      return ownerReply(request.variables.login as string, [repoNode('acme/api')]);
    });
    const result = await service(transport, ['acme', 'nobody-here'], recordingLogger()).refresh(TOKEN, ACCOUNT_ID);
    expect(result.repositories.map((info) => info.nameWithOwner)).toEqual(['acme/api']);
    expect(result.hints).toEqual([{ organization: 'nobody-here', kind: 'notFound', url: 'https://github.com/nobody-here' }]);
    expect(ownersAskedAbout(transport.requests)).toEqual(['acme', 'nobody-here']);
  });

  it('keeps the SAML hint for an owner of the scope, and does not probe organizations outside the scope', async () => {
    const transport = new AsyncFakeGitHub((request) => {
      if (request.query === SCOPE_VIEWER_QUERY) return viewerReply('octo', ['secure-org', 'other-org']);
      if (request.variables.login === 'secure-org') {
        return {
          body: {
            data: { repositoryOwner: { __typename: 'Organization', login: 'secure-org', repositories: connection([null, repoNode('secure-org/open')]) } },
            errors: [{ type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['repositoryOwner', 'repositories', 'nodes', 0] }],
          },
        };
      }
      throw new Error('unexpected request');
    });
    const result = await service(transport, ['secure-org'], recordingLogger()).refresh(TOKEN, ACCOUNT_ID);
    expect(result.hints).toEqual([{ organization: 'secure-org', kind: 'saml', url: 'https://github.com/orgs/secure-org/sso' }]);
    expect(result.repositories.map((info) => info.nameWithOwner)).toEqual(['secure-org/open']);
    expect(transport.requests.map((request) => request.query)).toEqual([SCOPE_VIEWER_QUERY, OWNER_REPOSITORIES_QUERY]);
  });

  it('gives an owner that SAML hides completely the SAML hint, not the not-found hint', async () => {
    const transport = new AsyncFakeGitHub((request) =>
      request.query === SCOPE_VIEWER_QUERY
        ? viewerReply('octo', ['secure-org'])
        : { body: { data: { repositoryOwner: null }, errors: [{ type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['repositoryOwner'] }] } },
    );
    const result = await service(transport, ['secure-org'], recordingLogger()).refresh(TOKEN, ACCOUNT_ID);
    expect(result.hints).toEqual([{ organization: 'secure-org', kind: 'saml', url: 'https://github.com/orgs/secure-org/sso' }]);
  });

  it('retries a page of an owner with fewer repositories when GitHub does not answer in time', async () => {
    const transport = new AsyncFakeGitHub((request) => {
      if (request.query === SCOPE_VIEWER_QUERY) return viewerReply();
      return request.variables.pageSize === 50 ? { status: 502, body: { message: 'Server Error' } } : ownerReply('acme', [repoNode('acme/api')]);
    });
    const result = await service(transport, ['acme'], recordingLogger()).refresh(TOKEN, ACCOUNT_ID);
    expect(transport.ofQuery(OWNER_REPOSITORIES_QUERY).map((request) => request.variables.pageSize)).toEqual([50, 25]);
    expect(result.repositories).toHaveLength(1);
  });

  it('fails as a whole, stops the other owners, and keeps the stored file, when an owner fails', async () => {
    fs.writeFileSync(file, 'previous');
    const transport = new AsyncFakeGitHub((request) => {
      if (request.query === SCOPE_VIEWER_QUERY) return viewerReply();
      if (request.variables.login === 'broken') return { body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } };
      return ownerReply(request.variables.login as string, [repoNode(`${request.variables.login as string}/a`)], 'more');
    });
    await expect(service(transport, ['acme', 'broken'], recordingLogger()).refresh(TOKEN, ACCOUNT_ID)).rejects.toThrow(/API rate limit exceeded/);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
  });

  it('stores nothing when the token belongs to another account, before any owner is asked', async () => {
    const transport = new AsyncFakeGitHub(() => viewerReply('someone', [], 2002));
    await expect(service(transport, ['acme']).refresh(TOKEN, ACCOUNT_ID)).rejects.toThrow(/session changed/);
    expect(transport.requests.map((request) => request.query)).toEqual([SCOPE_VIEWER_QUERY]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('scans everything with one cursor for an empty scope, and stores the empty scope', async () => {
    const transport = new AsyncFakeGitHub(() => ({
      body: { data: { viewer: { login: 'octo', databaseId: 1001, organizations: connection([]), repositories: connection([repoNode('acme/api')]) } } },
    }));
    const result: DiscoveryData = await service(transport, []).refresh(TOKEN, ACCOUNT_ID);
    expect(transport.requests.map((request) => request.query)).toEqual([DISCOVERY_QUERY]);
    expect(result.scope).toEqual([]);
  });
});

describe('the first load and uncertain detections', () => {
  it('does not keep a repository as without configuration when an error points into its node', async () => {
    const transport = new AsyncFakeGitHub(() => ({
      body: {
        data: { viewer: { login: 'octo', databaseId: 1001, organizations: connection([]), repositories: connection([repoNode('acme/timeout', false), repoNode('acme/empty', false)]) } },
        errors: [{ message: 'Something went wrong', path: ['viewer', 'repositories', 'nodes', 0, 'folder'] }],
      },
    }));
    const result = await service(transport, [], recordingLogger()).refresh(TOKEN, ACCOUNT_ID);
    expect(result.withoutConfiguration).toEqual([{ nameWithOwner: 'acme/empty', pushedAt: '2026-09-20T10:00:00Z', defaultBranch: 'main' }]);
  });
});

describe('DiscoveryService.viewerOrganizations (organization selector)', () => {
  it('reads the account and all pages of its organizations, without any repository, also with a scan scope', async () => {
    const transport = new AsyncFakeGitHub((request) => {
      if (request.query === SCOPE_VIEWER_QUERY) {
        return { body: { data: { viewer: { login: 'octo', databaseId: 1001, organizations: { pageInfo: { hasNextPage: true, endCursor: 'o1' }, nodes: [{ login: 'acme' }] } } } } };
      }
      return { body: { data: { viewer: { organizations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ login: 'beta' }] } } } } };
    });
    await expect(service(transport, ['acme']).viewerOrganizations(TOKEN)).resolves.toEqual({ login: 'octo', organizations: ['acme', 'beta'] });
    expect(transport.requests.map((request) => request.query.match(/^query \w+/)?.[0])).toEqual(['query ScopeViewer', 'query Organizations']);
    expect(JSON.stringify(transport.requests)).not.toMatch(/repositories\(/);
  });

  it('throws when GitHub does not return the account', async () => {
    const transport = new AsyncFakeGitHub(() => ({ body: { errors: [{ message: 'Bad credentials' }] } }));
    await expect(service(transport, []).viewerOrganizations(TOKEN)).rejects.toThrow(/did not return the account/);
  });
});

describe('the queries of the scan scope', () => {
  it('ask about one owner by its login, with the configuration lookups only on request', () => {
    expect(OWNER_REPOSITORIES_QUERY).toMatch(/repositoryOwner\(login: \$login\)/);
    expect(OWNER_REPOSITORIES_QUERY).toMatch(/\.\.\. on Organization \{/);
    expect(OWNER_REPOSITORIES_QUERY).toMatch(/\.\.\. on User \{\s+repositories\([^)]*ownerAffiliations: \[OWNER\]/);
    expect(OWNER_REPOSITORIES_QUERY).toContain('...ConfigurationLookups @include(if: $withConfigurations)');
    expect(OWNER_REPOSITORIES_QUERY).toContain('orderBy: { field: PUSHED_AT, direction: DESC }');
    // The account query lists no repository.
    expect(SCOPE_VIEWER_QUERY).not.toMatch(/repositories/);
  });
});

describe('parseDiscoveryData and the scope', () => {
  const base = { version: 1, fetchedAt: '2026-09-25T12:00:00Z', viewerLogin: 'octo', organizations: [], repositories: [] };

  it.each<[string, unknown, string[] | undefined]>([
    ['a list of an older version has no scope', undefined, undefined],
    ['the scope is kept normalized', ['Beta', 'acme'], ['acme', 'beta']],
    ['a scope that is not a list of texts is dropped', ['acme', 3], undefined],
  ])('%s', (_name, scope, expected) => {
    expect(parseDiscoveryData({ ...base, hints: [], ...(scope !== undefined ? { scope } : {}) })?.scope).toEqual(expected);
  });

  it('keeps a not-found hint', () => {
    const hint = { organization: 'nobody', kind: 'notFound', url: 'https://github.com/nobody' };
    expect(parseDiscoveryData({ ...base, hints: [hint] })?.hints).toEqual([hint]);
  });
});
