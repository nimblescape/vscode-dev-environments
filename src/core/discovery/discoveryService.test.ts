import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import type { Logger } from '../ports';
import type { DiscoveryData, RepositoryInfo } from '../types';
import { GitHubApi, GitHubApiError, type GraphQLError } from './githubApi';
import {
  BRANCH_CONFIGURATIONS_QUERY,
  BRANCHES_QUERY,
  classifyGraphQLError,
  DISCOVERY_QUERY,
  DiscoveryService,
  filterRepositories,
  hintUrl,
  isTrustedOwner,
  OAUTH_APP_CONNECTIONS_URL,
  organizationFromMessage,
  organizationFromPath,
  ORGANIZATIONS_QUERY,
  parseDiscoveryData,
  REPOSITORY_QUERY,
} from './discoveryService';

const TOKEN = 'gho_secretTokenValue123';
const FIXED_NOW = Date.parse('2026-09-24T12:00:00.000Z');
const clock = { now: () => FIXED_NOW };

interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
}

type Reply = { status?: number; body: unknown } | Error;

/** Answers each GraphQL request with the handler. Records the parsed requests. */
class FakeGitHub implements HttpTransport {
  readonly requests: GraphQLRequest[] = [];
  constructor(private readonly handler: (request: GraphQLRequest, index: number) => Reply) {}
  async request(request: HttpRequest): Promise<HttpResponse> {
    const parsed = JSON.parse(request.body ?? '{}') as GraphQLRequest;
    this.requests.push(parsed);
    const reply = this.handler(parsed, this.requests.length - 1);
    if (reply instanceof Error) throw reply;
    return { status: reply.status ?? 200, headers: {}, body: JSON.stringify(reply.body) };
  }
  ofQuery(query: string): GraphQLRequest[] {
    return this.requests.filter((request) => request.query === query);
  }
}

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message, error) => lines.push(`${message} ${error instanceof Error ? error.message : ''}`),
    output: (text) => lines.push(text),
  };
}

interface RepoOptions {
  config?: 'folder' | 'root' | 'sub' | 'none';
  isArchived?: boolean;
  isFork?: boolean;
  isPrivate?: boolean;
  defaultBranch?: string | null;
}

function repoNode(nameWithOwner: string, options: RepoOptions = {}): Record<string, unknown> {
  const [owner, name] = nameWithOwner.split('/');
  const config = options.config ?? 'folder';
  return {
    id: `R_${nameWithOwner}`,
    name,
    nameWithOwner,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: options.isArchived ?? false,
    isFork: options.isFork ?? false,
    isPrivate: options.isPrivate ?? true,
    pushedAt: '2026-09-20T10:00:00Z',
    owner: { login: owner },
    defaultBranchRef: options.defaultBranch === null ? null : { name: options.defaultBranch ?? 'main' },
    rootFile: config === 'root' ? { __typename: 'Blob' } : null,
    folder:
      config === 'folder'
        ? { entries: [{ name: 'devcontainer.json', type: 'blob', object: {} }] }
        : config === 'sub'
          ? { entries: [{ name: 'python', type: 'tree', object: { entries: [{ name: 'devcontainer.json', type: 'blob' }] } }] }
          : null,
  };
}

function discoverPage(
  nodes: Array<Record<string, unknown> | null>,
  options: { endCursor?: string | null; hasNextPage?: boolean; login?: string; organizations?: string[]; orgHasNext?: boolean; errors?: GraphQLError[] } = {},
): Reply {
  const viewer: Record<string, unknown> = {
    login: options.login ?? 'octo',
    repositories: {
      pageInfo: { hasNextPage: options.hasNextPage ?? false, endCursor: options.endCursor ?? null },
      nodes,
    },
  };
  if (options.organizations) {
    viewer.organizations = {
      pageInfo: { hasNextPage: options.orgHasNext ?? false, endCursor: options.orgHasNext ? 'org-cursor-1' : null },
      nodes: options.organizations.map((login) => ({ login })),
    };
  }
  return { body: { data: { viewer }, ...(options.errors ? { errors: options.errors } : {}) } };
}

const SAML_MESSAGE =
  'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.';
const oauthMessage = (org: string) =>
  `Although you appear to have the correct authorization credentials, the \`${org}\` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. For more information on these restrictions, including how to enable this app, visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/`;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  file = path.join(dir, 'repositories.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function service(transport: FakeGitHub, logger?: Logger): DiscoveryService {
  return new DiscoveryService(new GitHubApi(transport), file, logger, clock);
}

describe('DiscoveryService.refresh', () => {
  it('reads all pages, keeps the API order, drops repositories without a configuration, and stores the result', async () => {
    const transport = new FakeGitHub((request) => {
      if (request.variables.cursor === null) {
        return discoverPage(
          [repoNode('octo/zeta'), repoNode('acme/api', { config: 'sub' }), repoNode('octo/empty', { config: 'none' }), null],
          { hasNextPage: true, endCursor: 'c1', organizations: ['acme', 'Beta-Org'] },
        );
      }
      return discoverPage([repoNode('acme/alpha', { config: 'root', isFork: true, isPrivate: false }), repoNode('octo/zeta')], {
        hasNextPage: false,
        endCursor: 'c2',
      });
    });
    const logger = recordingLogger();
    const result = await service(transport, logger).refresh(TOKEN);

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0].query).toBe(DISCOVERY_QUERY);
    expect(transport.requests[0].variables).toEqual({ cursor: null, pageSize: 50, withOrganizations: true });
    expect(transport.requests[1].variables).toEqual({ cursor: 'c1', pageSize: 50, withOrganizations: false });

    expect(result.version).toBe(1);
    expect(result.fetchedAt).toBe('2026-09-24T12:00:00.000Z');
    expect(result.viewerLogin).toBe('octo');
    expect(result.organizations).toEqual(['acme', 'Beta-Org']);
    expect(result.hints).toEqual([]);
    // API order; the duplicate of octo/zeta on page 2 is dropped.
    expect(result.repositories.map((repository) => repository.nameWithOwner)).toEqual(['octo/zeta', 'acme/api', 'acme/alpha']);
    expect(result.repositories[1]).toEqual<RepositoryInfo>({
      nameWithOwner: 'acme/api',
      owner: 'acme',
      name: 'api',
      url: 'https://github.com/acme/api',
      isArchived: false,
      isFork: false,
      isPrivate: true,
      pushedAt: '2026-09-20T10:00:00Z',
      defaultBranch: 'main',
      configPaths: ['.devcontainer/python/devcontainer.json'],
    });
    expect(result.repositories[2]).toMatchObject({ isFork: true, isPrivate: false, configPaths: ['.devcontainer.json'] });

    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as DiscoveryData;
    expect(stored).toEqual(result);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(TOKEN);
    expect(await service(transport).loadStored()).toEqual(result);
    expect(logger.lines.join('\n')).not.toContain(TOKEN);
  });

  it('reads further pages of organizations', async () => {
    const transport = new FakeGitHub((request) => {
      if (request.query === ORGANIZATIONS_QUERY) {
        expect(request.variables).toEqual({ cursor: 'org-cursor-1' });
        return { body: { data: { viewer: { organizations: { pageInfo: { hasNextPage: false, endCursor: 'x' }, nodes: [{ login: 'gamma' }, null, { login: 'ACME' }] } } } } };
      }
      return discoverPage([repoNode('octo/a')], { organizations: ['acme', 'beta'], orgHasNext: true });
    });
    const result = await service(transport).refresh(TOKEN);
    expect(result.organizations).toEqual(['acme', 'beta', 'gamma']);
    expect(transport.ofQuery(ORGANIZATIONS_QUERY)).toHaveLength(1);
  });

  it('keeps the organizations of the first page when a further page fails', async () => {
    const transport = new FakeGitHub((request) =>
      request.query === ORGANIZATIONS_QUERY
        ? new Error('socket hang up')
        : discoverPage([repoNode('octo/a')], { organizations: ['acme'], orgHasNext: true }),
    );
    const result = await service(transport).refresh(TOKEN);
    expect(result.organizations).toEqual(['acme']);
  });

  it('turns SAML errors with null nodes into one hint per organization, found by a probe of the organizations', async () => {
    const samlError = (index: number): GraphQLError => ({
      type: 'FORBIDDEN',
      message: SAML_MESSAGE,
      path: ['viewer', 'repositories', 'nodes', index],
      extensions: { saml_failure: true },
    });
    const transport = new FakeGitHub((request) => {
      if (request.query.startsWith('query OrganizationAccess(')) {
        expect(request.variables).toEqual({ o0: 'acme', o1: 'secure-org' });
        return {
          body: {
            data: { o0: { login: 'acme', repositories: { nodes: [{ id: 'R1' }] } }, o1: { login: 'secure-org', repositories: { nodes: [null] } } },
            errors: [{ type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['o1', 'repositories', 'nodes', 0] }],
          },
        };
      }
      return discoverPage([repoNode('acme/api'), null, null], {
        organizations: ['acme', 'secure-org'],
        errors: [samlError(1), samlError(2)],
      });
    });
    const result = await service(transport).refresh(TOKEN);
    expect(result.repositories.map((repository) => repository.nameWithOwner)).toEqual(['acme/api']);
    expect(result.hints).toEqual([{ organization: 'secure-org', kind: 'saml', url: 'https://github.com/orgs/secure-org/sso' }]);
  });

  it('takes the organization from the message of an OAuth restriction error, without a probe', async () => {
    const error = (index: number): GraphQLError => ({
      type: 'FORBIDDEN',
      message: oauthMessage('acme-university'),
      path: ['viewer', 'repositories', 'nodes', index],
    });
    const transport = new FakeGitHub(() =>
      discoverPage([null, repoNode('octo/a'), null], { organizations: ['acme-university'], errors: [error(0), error(2)] }),
    );
    const result = await service(transport).refresh(TOKEN);
    expect(result.hints).toEqual([{ organization: 'acme-university', kind: 'oauthRestricted', url: OAUTH_APP_CONNECTIONS_URL }]);
    expect(transport.requests).toHaveLength(1);
  });

  it('takes the organization from the data when the path points into an existing node', async () => {
    const transport = new FakeGitHub(() =>
      discoverPage([repoNode('secure-org/api', { config: 'none' })], {
        errors: [{ type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['viewer', 'repositories', 'nodes', 0, 'folder'] }],
      }),
    );
    const result = await service(transport).refresh(TOKEN);
    expect(result.hints).toEqual([{ organization: 'secure-org', kind: 'saml', url: 'https://github.com/orgs/secure-org/sso' }]);
    expect(transport.requests).toHaveLength(1);
  });

  it('keeps one hint per organization, SAML before OAuth, across pages', async () => {
    const transport = new FakeGitHub((request) =>
      request.variables.cursor === null
        ? discoverPage([null], { hasNextPage: true, endCursor: 'c1', errors: [{ type: 'FORBIDDEN', message: oauthMessage('Acme'), path: ['viewer', 'repositories', 'nodes', 0] }] })
        : discoverPage([repoNode('acme/x', { config: 'none' })], {
            errors: [
              { type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['viewer', 'repositories', 'nodes', 0, 'rootFile'] },
              { type: 'FORBIDDEN', message: oauthMessage('acme'), path: ['viewer', 'repositories', 'nodes', 0] },
            ],
          }),
    );
    const result = await service(transport).refresh(TOKEN);
    expect(result.hints).toEqual([{ organization: 'Acme', kind: 'saml', url: 'https://github.com/orgs/Acme/sso' }]);
  });

  it('creates an "other" hint only for a FORBIDDEN error that names the organization', async () => {
    const transport = new FakeGitHub(() =>
      discoverPage([null, null], {
        errors: [
          {
            type: 'FORBIDDEN',
            message: 'Although you appear to have the correct authorization credentials, the `ip-org` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.',
            path: ['viewer', 'repositories', 'nodes', 0],
          },
          { type: 'FORBIDDEN', message: 'Forbidden', path: ['viewer', 'repositories', 'nodes', 1] },
          { type: 'NOT_FOUND', message: 'Could not resolve', path: ['viewer', 'repositories', 'nodes', 1] },
        ],
      }),
    );
    const result = await service(transport).refresh(TOKEN);
    expect(result.hints).toEqual([{ organization: 'ip-org', kind: 'other', url: 'https://github.com/ip-org' }]);
    // No SAML or OAuth error without an organization: no probe.
    expect(transport.requests).toHaveLength(1);
  });

  it('never creates a hint for the account of the user', async () => {
    const transport = new FakeGitHub(() =>
      discoverPage([repoNode('octo/a', { config: 'none' })], {
        errors: [{ type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['viewer', 'repositories', 'nodes', 0, 'folder'] }],
      }),
    );
    const result = await service(transport).refresh(TOKEN);
    expect(result.hints).toEqual([]);
  });

  it('does not fail when the probe of the organizations fails', async () => {
    const transport = new FakeGitHub((request) =>
      request.query.startsWith('query OrganizationAccess(')
        ? { status: 502, body: { message: 'Bad gateway' } }
        : discoverPage([repoNode('acme/a'), null], {
            organizations: ['acme'],
            errors: [{ type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['viewer', 'repositories', 'nodes', 1] }],
          }),
    );
    const logger = recordingLogger();
    const result = await service(transport, logger).refresh(TOKEN);
    expect(result.repositories).toHaveLength(1);
    expect(result.hints).toEqual([]);
    expect(logger.lines.some((line) => line.includes('could not be checked'))).toBe(true);
  });

  it('probes the organizations in chunks of 50', async () => {
    const organizations = Array.from({ length: 120 }, (_, i) => `org${i}`);
    const transport = new FakeGitHub((request) => {
      if (request.query.startsWith('query OrganizationAccess(')) {
        const count = Object.keys(request.variables).length;
        return { body: { data: Object.fromEntries(Array.from({ length: count }, (_, i) => [`o${i}`, { login: 'x', repositories: { nodes: [] } }])) } };
      }
      return discoverPage([null], { organizations, errors: [{ type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['viewer', 'repositories', 'nodes', 0] }] });
    });
    await service(transport).refresh(TOKEN);
    const probes = transport.requests.filter((request) => request.query.startsWith('query OrganizationAccess('));
    expect(probes.map((request) => Object.keys(request.variables).length)).toEqual([50, 50, 20]);
    expect(probes[2].variables.o19).toBe('org119');
  });

  it('throws on HTTP 401 and leaves the stored file unchanged', async () => {
    fs.writeFileSync(file, 'previous');
    const transport = new FakeGitHub(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const error = await service(transport).refresh(TOKEN).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(401);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
    expect(transport.requests).toHaveLength(1);
  });

  it('throws on a network failure on a later page and leaves the stored file unchanged', async () => {
    fs.writeFileSync(file, 'previous');
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' });
    const transport = new FakeGitHub((request) =>
      request.variables.cursor === null ? discoverPage([repoNode('octo/a')], { hasNextPage: true, endCursor: 'c1' }) : failure,
    );
    await expect(service(transport).refresh(TOKEN)).rejects.toBe(failure);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
  });

  it('throws when GitHub returns no repository list, and does not retry a rate limit', async () => {
    const transport = new FakeGitHub(() => ({ body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } }));
    await expect(service(transport).refresh(TOKEN)).rejects.toThrow(/API rate limit exceeded/);
    expect(transport.requests).toHaveLength(1);
  });

  it('throws when the viewer has no login', async () => {
    const transport = new FakeGitHub(() => ({ body: { data: { viewer: { repositories: { nodes: [] } } } } }));
    await expect(service(transport).refresh(TOKEN)).rejects.toThrow(/did not return the repository list/);
  });

  it('retries a page with a smaller page size when GitHub does not answer in time, and keeps the smaller size', async () => {
    const transport = new FakeGitHub((request) => {
      if (request.variables.pageSize === 50) return { status: 502, body: { message: 'Server Error' } };
      if (request.variables.cursor === null) return discoverPage([repoNode('octo/a')], { hasNextPage: true, endCursor: 'c1' });
      return discoverPage([repoNode('octo/b')]);
    });
    const logger = recordingLogger();
    const result = await service(transport, logger).refresh(TOKEN);
    expect(transport.requests.map((request) => [request.variables.cursor, request.variables.pageSize])).toEqual([
      [null, 50],
      [null, 25],
      ['c1', 25],
    ]);
    expect(transport.requests[1].variables.withOrganizations).toBe(true);
    expect(result.repositories.map((repository) => repository.nameWithOwner)).toEqual(['octo/a', 'octo/b']);
    expect(logger.lines.some((line) => line.includes('25 repositories per request'))).toBe(true);
  });

  it('retries a GraphQL timeout error down to the minimum page size, then throws', async () => {
    const transport = new FakeGitHub(() => ({
      body: { data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.' }] },
    }));
    await expect(service(transport).refresh(TOKEN)).rejects.toThrow(/Something went wrong/);
    expect(transport.requests.map((request) => request.variables.pageSize)).toEqual([50, 25, 12, 10]);
  });

  it('stops when the API repeats a cursor', async () => {
    const transport = new FakeGitHub((request) =>
      discoverPage([repoNode(request.variables.cursor === null ? 'octo/a' : 'octo/b')], { hasNextPage: true, endCursor: 'same' }),
    );
    const result = await service(transport).refresh(TOKEN);
    expect(transport.requests).toHaveLength(2);
    expect(result.repositories).toHaveLength(2);
  });

  it('stops when the cursors of the API form a cycle, for repositories and for organizations', async () => {
    const cycle: Record<string, string> = { A: 'B', B: 'A' };
    const transport = new FakeGitHub((request) => {
      const cursor = request.variables.cursor as string | null;
      if (request.query === ORGANIZATIONS_QUERY) {
        return { body: { data: { viewer: { organizations: { pageInfo: { hasNextPage: true, endCursor: cursor === 'org-cursor-1' ? 'O2' : 'org-cursor-1' }, nodes: [] } } } } };
      }
      return discoverPage([], { hasNextPage: true, endCursor: cursor === null ? 'A' : cycle[cursor], organizations: ['acme'], orgHasNext: true });
    });
    await service(transport).refresh(TOKEN);
    expect(transport.ofQuery(DISCOVERY_QUERY).map((request) => request.variables.cursor)).toEqual([null, 'A', 'B']);
    expect(transport.ofQuery(ORGANIZATIONS_QUERY).map((request) => request.variables.cursor)).toEqual(['org-cursor-1', 'O2']);
  });

  it('skips malformed repository nodes and replaces a URL outside of github.com', async () => {
    const bad = { ...repoNode('octo/b'), url: 'javascript:alert(1)' };
    const transport = new FakeGitHub(() =>
      discoverPage([{ nameWithOwner: 'no-slash' }, { nameWithOwner: 'a/b/c' }, { nameWithOwner: 42 }, bad] as Array<Record<string, unknown>>),
    );
    const result = await service(transport).refresh(TOKEN);
    expect(result.repositories.map((repository) => [repository.nameWithOwner, repository.url])).toEqual([
      ['octo/b', 'https://github.com/octo/b'],
    ]);
  });

  it('maps an empty repository (no default branch) without a configuration away', async () => {
    const transport = new FakeGitHub(() => discoverPage([repoNode('octo/empty', { config: 'none', defaultBranch: null })]));
    const result = await service(transport).refresh(TOKEN);
    expect(result.repositories).toEqual([]);
  });

  it('returns the result even when it cannot be stored', async () => {
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'a file, not a folder');
    const transport = new FakeGitHub(() => discoverPage([repoNode('octo/a')]));
    const logger = recordingLogger();
    const result = await new DiscoveryService(new GitHubApi(transport), path.join(blocked, 'repositories.json'), logger, clock).refresh(TOKEN);
    expect(result.repositories).toHaveLength(1);
    expect(logger.lines.some((line) => line.includes('could not be stored'))).toBe(true);
  });

  it('passes an abort on', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new FakeGitHub(() => discoverPage([]));
    await expect(service(transport).refresh(TOKEN, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('DiscoveryService.loadStored', () => {
  it('returns undefined without a file, for invalid JSON, and for another version', async () => {
    const transport = new FakeGitHub(() => discoverPage([]));
    expect(await service(transport).loadStored()).toBeUndefined();
    fs.writeFileSync(file, '{ invalid');
    expect(await service(transport).loadStored()).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ version: 2, fetchedAt: 'x', viewerLogin: 'a', organizations: [], repositories: [], hints: [] }));
    expect(await service(transport).loadStored()).toBeUndefined();
  });

  it('drops invalid entries', () => {
    const valid: RepositoryInfo = {
      nameWithOwner: 'octo/a',
      owner: 'octo',
      name: 'a',
      url: 'https://github.com/octo/a',
      isArchived: false,
      isFork: false,
      isPrivate: false,
      pushedAt: null,
      defaultBranch: 'main',
      configPaths: ['.devcontainer.json'],
    };
    const data = parseDiscoveryData({
      version: 1,
      fetchedAt: '2026-09-24T12:00:00Z',
      viewerLogin: 'octo',
      organizations: ['acme', 3],
      repositories: [valid, { ...valid, url: 'file:///etc/passwd' }, { ...valid, configPaths: [] }, null],
      hints: [
        { organization: 'acme', kind: 'saml', url: 'https://github.com/orgs/acme/sso' },
        { organization: 'x', kind: 'unknown', url: 'https://github.com/x' },
        { organization: 'y', kind: 'other', url: 'https://evil.example' },
      ],
    });
    expect(data).toEqual({
      version: 1,
      fetchedAt: '2026-09-24T12:00:00Z',
      viewerLogin: 'octo',
      organizations: ['acme'],
      repositories: [valid],
      hints: [{ organization: 'acme', kind: 'saml', url: 'https://github.com/orgs/acme/sso' }],
    });
  });
});

describe('DiscoveryService single repository queries', () => {
  it('listBranches puts the default branch first and removes duplicates', async () => {
    const transport = new FakeGitHub(() => ({
      body: {
        data: {
          repository: {
            defaultBranchRef: { name: 'main' },
            refs: { nodes: [{ name: 'develop' }, { name: 'feature-x' }, { name: 'main' }, null, { name: 42 }] },
          },
        },
      },
    }));
    const branches = await service(transport).listBranches('acme/api', TOKEN);
    expect(branches).toEqual(['main', 'develop', 'feature-x']);
    expect(transport.requests[0].query).toBe(BRANCHES_QUERY);
    expect(transport.requests[0].variables).toEqual({ owner: 'acme', name: 'api' });
  });

  it('listBranches throws when GitHub does not return the repository', async () => {
    const transport = new FakeGitHub(() => ({
      body: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'acme/gone'." }] },
    }));
    await expect(service(transport).listBranches('acme/gone', TOKEN)).rejects.toThrow(/Could not resolve/);
  });

  it('configurationsOnBranch passes the branch in the expressions, as variables', async () => {
    const transport = new FakeGitHub(() => ({
      body: {
        data: {
          repository: {
            rootFile: { __typename: 'Blob' },
            folder: { entries: [{ name: 'node', type: 'tree', object: { entries: [{ name: 'devcontainer.json', type: 'blob' }] } }] },
          },
        },
      },
    }));
    const paths = await service(transport).configurationsOnBranch('acme/api', 'feature/"quoted"', TOKEN);
    expect(paths).toEqual(['.devcontainer.json', '.devcontainer/node/devcontainer.json']);
    expect(transport.requests[0].query).toBe(BRANCH_CONFIGURATIONS_QUERY);
    expect(transport.requests[0].query).not.toContain('feature');
    expect(transport.requests[0].variables).toEqual({
      owner: 'acme',
      name: 'api',
      rootFile: 'feature/"quoted":.devcontainer.json',
      folder: 'feature/"quoted":.devcontainer',
    });
  });

  it('configurationsOnBranch returns an empty list for a branch without configuration', async () => {
    const transport = new FakeGitHub(() => ({ body: { data: { repository: { rootFile: null, folder: null } } } }));
    expect(await service(transport).configurationsOnBranch('acme/api', 'gone', TOKEN)).toEqual([]);
  });

  it('getRepository returns the repository also without a configuration, and undefined when it is missing', async () => {
    const transport = new FakeGitHub((request) =>
      request.variables.name === 'api'
        ? { body: { data: { repository: repoNode('acme/api', { config: 'none', isArchived: true }) } } }
        : { body: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] } },
    );
    const info = await service(transport).getRepository('acme/api', TOKEN);
    expect(info).toMatchObject({ nameWithOwner: 'acme/api', owner: 'acme', isArchived: true, configPaths: [] });
    expect(transport.requests[0].query).toBe(REPOSITORY_QUERY);
    expect(await service(transport).getRepository('acme/gone', TOKEN)).toBeUndefined();
  });

  it('getRepository returns undefined without access (SAML), but throws when the query failed', async () => {
    const replies: Record<string, Reply> = {
      saml: { body: { data: { repository: null }, errors: [{ type: 'FORBIDDEN', message: SAML_MESSAGE, path: ['repository'] }] } },
      limited: { body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } },
      timeout: {
        body: { data: { repository: null }, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout.' }] },
      },
    };
    const transport = new FakeGitHub((request) => replies[request.variables.name as string]);
    expect(await service(transport).getRepository('acme/saml', TOKEN)).toBeUndefined();
    await expect(service(transport).getRepository('acme/limited', TOKEN)).rejects.toThrow(/API rate limit exceeded/);
    await expect(service(transport).getRepository('acme/timeout', TOKEN)).rejects.toThrow(/Something went wrong/);
  });

  it('rejects an invalid repository name', async () => {
    const transport = new FakeGitHub(() => ({ body: { data: {} } }));
    await expect(service(transport).getRepository('invalid', TOKEN)).rejects.toThrow(/Invalid repository name/);
    expect(transport.requests).toHaveLength(0);
  });
});

describe('filterRepositories', () => {
  const repo = (nameWithOwner: string, flags: { isArchived?: boolean; isFork?: boolean } = {}): RepositoryInfo => ({
    nameWithOwner,
    owner: nameWithOwner.split('/')[0],
    name: nameWithOwner.split('/')[1],
    url: `https://github.com/${nameWithOwner}`,
    isArchived: flags.isArchived ?? false,
    isFork: flags.isFork ?? false,
    isPrivate: false,
    pushedAt: null,
    defaultBranch: 'main',
    configPaths: ['.devcontainer.json'],
  });
  const all = [repo('Acme/a'), repo('acme/archived', { isArchived: true }), repo('octo/fork', { isFork: true }), repo('other/c')];
  const names = (list: RepositoryInfo[]) => list.map((item) => item.nameWithOwner);

  it('shows all owners for an empty list, and hides archived repositories by default', () => {
    expect(names(filterRepositories(all, { owners: [], includeArchived: false, includeForks: true }))).toEqual(['Acme/a', 'octo/fork', 'other/c']);
  });

  it('filters owners case-insensitively and ignores empty entries', () => {
    expect(names(filterRepositories(all, { owners: [' ACME ', ''], includeArchived: true, includeForks: true }))).toEqual(['Acme/a', 'acme/archived']);
  });

  it('hides forks when includeForks is false', () => {
    expect(names(filterRepositories(all, { owners: [], includeArchived: true, includeForks: false }))).toEqual(['Acme/a', 'acme/archived', 'other/c']);
  });
});

describe('isTrustedOwner', () => {
  const data: DiscoveryData = {
    version: 1,
    fetchedAt: '2026-09-24T12:00:00Z',
    viewerLogin: 'Octo',
    organizations: ['Acme-University'],
    repositories: [],
    hints: [],
  };

  it('trusts the user and the organizations of the user, case-insensitively', () => {
    expect(isTrustedOwner(data, 'octo')).toBe(true);
    expect(isTrustedOwner(data, 'acme-university')).toBe(true);
  });

  it('does not trust other owners, an empty owner, or anything without data', () => {
    expect(isTrustedOwner(data, 'stranger')).toBe(false);
    expect(isTrustedOwner(data, '')).toBe(false);
    expect(isTrustedOwner(undefined, 'octo')).toBe(false);
  });
});

describe('error helpers', () => {
  it('classifies SAML, OAuth restriction, and other FORBIDDEN errors', () => {
    expect(classifyGraphQLError({ message: SAML_MESSAGE })).toBe('saml');
    expect(classifyGraphQLError({ message: 'Forbidden', extensions: { saml_failure: true } })).toBe('saml');
    expect(classifyGraphQLError({ message: oauthMessage('acme') })).toBe('oauthRestricted');
    expect(classifyGraphQLError({ message: 'x', type: 'FORBIDDEN' })).toBe('other');
    expect(classifyGraphQLError({ message: 'Could not resolve', type: 'NOT_FOUND' })).toBeUndefined();
  });

  it('builds the hint URLs', () => {
    expect(hintUrl('saml', 'acme')).toBe('https://github.com/orgs/acme/sso');
    expect(hintUrl('oauthRestricted', 'acme')).toBe('https://github.com/settings/connections/applications/01ab8ac9400c4e429b23');
    expect(hintUrl('other', 'acme')).toBe('https://github.com/acme');
  });

  it('finds the organization in the message or in an extension', () => {
    expect(organizationFromMessage({ message: oauthMessage('acme-university') })).toBe('acme-university');
    expect(organizationFromMessage({ message: 'Grant access at https://github.com/orgs/Secure-Org/sso?x=1' })).toBe('Secure-Org');
    expect(organizationFromMessage({ message: SAML_MESSAGE, extensions: { url: 'https://github.com/orgs/ext-org/sso' } })).toBe('ext-org');
    // "organization SAML enforcement" must not be read as an organization named SAML.
    expect(organizationFromMessage({ message: SAML_MESSAGE })).toBeUndefined();
    expect(organizationFromMessage({ message: 'the `not a login!` organization' })).toBeUndefined();
  });

  it('finds the organization through the path in the data', () => {
    const data = {
      viewer: {
        login: 'octo',
        repositories: { nodes: [null, { nameWithOwner: 'acme/x', owner: { login: 'acme' } }, { nameWithOwner: 'beta/y' }] },
        organizations: { nodes: [{ login: 'gamma' }] },
      },
    };
    expect(organizationFromPath({ message: '', path: ['viewer', 'repositories', 'nodes', 0] }, data)).toBeUndefined();
    expect(organizationFromPath({ message: '', path: ['viewer', 'repositories', 'nodes', 1, 'folder'] }, data)).toBe('acme');
    expect(organizationFromPath({ message: '', path: ['viewer', 'repositories', 'nodes', 2] }, data)).toBe('beta');
    expect(organizationFromPath({ message: '', path: ['viewer', 'organizations', 'nodes', 0, 'x'] }, data)).toBe('gamma');
    // The login of the viewer is never taken as an organization.
    expect(organizationFromPath({ message: '', path: ['viewer', 'login'] }, data)).toBeUndefined();
    expect(organizationFromPath({ message: '' }, data)).toBeUndefined();
    expect(organizationFromPath({ message: '', path: ['viewer', 'repositories', 'nodes', 1] }, undefined)).toBeUndefined();
  });
});
