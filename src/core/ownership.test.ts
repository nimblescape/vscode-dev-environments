// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from './discovery/discoveryService';
import { GitHubApi } from './discovery/githubApi';
import type { HttpRequest, HttpResponse, HttpTransport } from './http';
import {
  EnvironmentClaims,
  availableEnvironments,
  canClaim,
  isAvailableTo,
  isUnambiguousClaim,
  ownerOf,
  unownedEnvironments,
} from './ownership';
import { silentLogger, type Logger } from './ports';
import { StoragePaths } from './storage/paths';
import { EnvironmentRegistry } from './storage/registry';
import type { Environment, GitHubAccount, RepositoryInfo } from './types';

const SCALARION: GitHubAccount = { id: '1001', login: 'scalarion' };
const STAUSSH: GitHubAccount = { id: '2002', login: 'staussh' };

function environment(id: string, repository: string, owner?: GitHubAccount): Environment {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devenv-${id}`,
    containerName: `devenv-${id}`,
    createdAt: '2026-09-24T10:00:00.000Z',
    lastUsedAt: '2026-09-24T10:00:00.000Z',
    ...(owner ? { owner } : {}),
  };
}

/** A repository as GitHub returns it; by default a private one that the account can push to. */
function info(nameWithOwner: string, options: { isPrivate?: boolean; viewerPermission?: string } = {}): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: options.isPrivate ?? true,
    viewerPermission: options.viewerPermission ?? 'ADMIN',
    pushedAt: null,
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
  };
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

describe('isAvailableTo (concept 7.5, section 9 "Accounts")', () => {
  it.each([
    ['the owner', { owner: SCALARION }, SCALARION, true],
    ['the owner with another login (renamed on GitHub)', { owner: { id: '1001', login: 'old-name' } }, SCALARION, true],
    ['an owner restored from a volume label (no login yet)', { owner: { id: '1001', login: '' } }, SCALARION, true],
    ['another account', { owner: SCALARION }, STAUSSH, false],
    ['another account with the same login', { owner: SCALARION }, { id: '3003', login: 'scalarion' }, false],
    ['nobody signed in', { owner: SCALARION }, undefined, false],
    ['an entry of an older version without owner (until a claim)', {}, SCALARION, false],
    ['an entry without owner, nobody signed in', {}, undefined, false],
  ])('%s', (_name, environment: Pick<Environment, 'owner'>, account: GitHubAccount | undefined, expected) => {
    expect(isAvailableTo(environment, account)).toBe(expected);
  });

  it('keeps only the environments of the account, in their order', () => {
    const list = [environment('a', 'o/a', SCALARION), environment('b', 'o/b', STAUSSH), environment('c', 'o/c'), environment('d', 'o/d', SCALARION)];
    expect(availableEnvironments(list, SCALARION).map((entry) => entry.id)).toEqual(['a', 'd']);
    expect(availableEnvironments(list, STAUSSH).map((entry) => entry.id)).toEqual(['b']);
    expect(availableEnvironments(list, undefined)).toEqual([]);
  });

  it('lists the entries without owner', () => {
    const list = [environment('a', 'o/a', SCALARION), environment('b', 'o/b'), environment('c', 'o/c', STAUSSH)];
    expect(unownedEnvironments(list).map((entry) => entry.id)).toEqual(['b']);
  });

  it('stores the ID and the login of the account as the owner', () => {
    expect(ownerOf({ ...SCALARION, extra: 1 } as GitHubAccount)).toEqual(SCALARION);
  });
});

describe('canClaim (concept 7.5, D-3): an account never gets a second environment of a repository', () => {
  const OLDER = environment('older', 'acme/api');
  it.each<[string, Environment[], Environment, boolean]>([
    ['an entry without owner, the account has no environment of its repository', [OLDER, environment('web', 'acme/web', SCALARION)], OLDER, true],
    ['another account has an environment of the repository', [OLDER, environment('theirs', 'acme/api', STAUSSH)], OLDER, true],
    ['the account has an environment of the repository', [OLDER, environment('own', 'acme/api', SCALARION)], OLDER, false],
    ['the same, with the repository in another case', [OLDER, environment('own', 'ACME/Api', SCALARION)], OLDER, false],
    ['the entry belongs to another account', [environment('theirs', 'acme/api', STAUSSH)], environment('theirs', 'acme/api', STAUSSH), false],
    ['the entry belongs to the account already', [environment('own', 'acme/api', SCALARION)], environment('own', 'acme/api', SCALARION), false],
  ])('%s', (_name, environments, entry, expected) => {
    expect(canClaim(environments, entry, SCALARION)).toBe(expected);
  });
});

describe('isUnambiguousClaim (concept 7.5): read access alone never assigns an entry', () => {
  it.each([
    ['a private repository of the account that it can push to', info('scalarion/app'), true],
    ['the same, with the login in another case', info('Scalarion/app', { viewerPermission: 'WRITE' }), true],
    ['a public repository of the account', info('scalarion/app', { isPrivate: false }), false],
    ['a public repository of another owner', info('torvalds/linux', { isPrivate: false, viewerPermission: 'READ' }), false],
    ['a private repository of an organization, with write access', info('majikmate/module-ts', { viewerPermission: 'WRITE' }), false],
    ['a private repository of an organization, as its admin', info('majikmate/module-ts', { viewerPermission: 'ADMIN' }), false],
    ['a private repository of another user, as a collaborator', info('staussh/app', { viewerPermission: 'WRITE' }), false],
    ['read access only', info('scalarion/app', { viewerPermission: 'READ' }), false],
    ['triage access only', info('scalarion/app', { viewerPermission: 'TRIAGE' }), false],
    ['no permission returned (older list)', { ...info('scalarion/app'), viewerPermission: undefined }, false],
  ])('%s', (_name, repository: RepositoryInfo, expected) => {
    expect(isUnambiguousClaim(repository, SCALARION)).toBe(expected);
  });

  it('needs the login of the account', () => {
    expect(isUnambiguousClaim(info('scalarion/app'), { id: '1001', login: '' })).toBe(false);
  });
});

describe('EnvironmentClaims', () => {
  let root: string;
  let registry: EnvironmentRegistry;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
    const paths = new StoragePaths(root);
    paths.ensureDirectoriesSync();
    registry = new EnvironmentRegistry(paths);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('claims in the background only entries that can belong to no other account, and never asks', async () => {
    await registry.add(environment('own-private', 'scalarion/app'));
    await registry.add(environment('own-public', 'scalarion/pub'));
    await registry.add(environment('org-shared', 'majikmate/module-ts'));
    await registry.add(environment('read-only', 'staussh/notes'));
    await registry.add(environment('no-access', 'majikmate/private'));
    await registry.add(environment('offline', 'majikmate/web'));
    await registry.add(environment('owned', 'acme/api', STAUSSH));
    const getRepository = vi.fn(async (repository: string, token: string) => {
      expect(token).toBe('gho_scalarion');
      if (repository === 'scalarion/app') return info(repository);
      if (repository === 'scalarion/pub') return info(repository, { isPrivate: false });
      if (repository === 'majikmate/module-ts') return info(repository, { viewerPermission: 'WRITE' });
      if (repository === 'staussh/notes') return info(repository, { viewerPermission: 'READ' });
      // An error message with the repository name must not reach the log.
      if (repository === 'majikmate/web') throw new Error('GitHub did not answer the query for the repository majikmate/web');
      return undefined;
    });
    const confirm = vi.fn(async () => true);
    const logger = recordingLogger();
    const claims = new EnvironmentClaims({ registry, getRepository, confirm, logger });

    await expect(claims.claim(SCALARION, 'gho_scalarion')).resolves.toEqual(['own-private']);
    // Only entries without owner are asked about; an owned entry never changes its owner.
    expect(getRepository.mock.calls.map((call) => call[0]).sort()).toEqual([
      'majikmate/module-ts',
      'majikmate/private',
      'majikmate/web',
      'scalarion/app',
      'scalarion/pub',
      'staussh/notes',
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect((await registry.get('own-private'))?.owner).toEqual(SCALARION);
    for (const id of ['own-public', 'org-shared', 'read-only', 'no-access', 'offline']) {
      expect((await registry.get(id))?.owner).toBeUndefined();
    }
    expect((await registry.get('owned'))?.owner).toEqual(STAUSSH);
    // The names of the repositories that stay hidden are not logged.
    const logged = logger.lines.join('\n');
    for (const name of ['scalarion/pub', 'majikmate/module-ts', 'staussh/notes', 'majikmate/private', 'majikmate/web']) {
      expect(logged).not.toContain(name);
    }
    expect(logged).toContain('now belongs to the GitHub account scalarion');
  });

  it('asks in the interactive mode before it claims an entry of a public or shared repository', async () => {
    await registry.add(environment('public', 'torvalds/linux'));
    await registry.add(environment('shared', 'majikmate/module-ts'));
    const getRepository = vi.fn(async (repository: string) =>
      repository === 'torvalds/linux' ? info(repository, { isPrivate: false, viewerPermission: 'READ' }) : info(repository, { viewerPermission: 'WRITE' }),
    );
    const confirm = vi.fn(async (entry: Environment, _account: GitHubAccount) => entry.id === 'public');
    const claims = new EnvironmentClaims({ registry, getRepository, confirm, logger: silentLogger });

    await expect(claims.claim(STAUSSH, 'token', { mode: 'interactive' })).resolves.toEqual(['public']);
    expect(confirm.mock.calls.map((call) => [call[0].id, call[1]])).toEqual([
      ['public', STAUSSH],
      ['shared', STAUSSH],
    ]);
    expect((await registry.get('public'))?.owner).toEqual(STAUSSH);
    expect((await registry.get('shared'))?.owner).toBeUndefined();

    // A declined entry is not asked about again in this session, and stays without owner.
    await expect(claims.claim(STAUSSH, 'token', { mode: 'interactive', environmentIds: ['shared'] })).resolves.toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect((await registry.get('shared'))?.owner).toBeUndefined();
    // Another account is asked for itself.
    await claims.claim(SCALARION, 'token', { mode: 'interactive', environmentIds: ['shared'] });
    expect(confirm).toHaveBeenCalledTimes(3);
    expect((await registry.get('shared'))?.owner).toBeUndefined();
  });

  it('claims an unambiguous entry in the interactive mode without a question, and never asks about an inaccessible one', async () => {
    await registry.add(environment('own', 'scalarion/app'));
    await registry.add(environment('gone', 'scalarion/deleted'));
    const getRepository = vi.fn(async (repository: string) => (repository === 'scalarion/app' ? info(repository) : undefined));
    const confirm = vi.fn(async () => true);
    const claims = new EnvironmentClaims({ registry, getRepository, confirm, logger: silentLogger });
    await expect(claims.claim(SCALARION, 'token', { mode: 'interactive' })).resolves.toEqual(['own']);
    expect(confirm).not.toHaveBeenCalled();
    expect((await registry.get('gone'))?.owner).toBeUndefined();
  });

  it('claims nothing ambiguous without a question to ask, and when the question fails', async () => {
    await registry.add(environment('shared', 'majikmate/module-ts'));
    const getRepository = async (repository: string) => info(repository, { viewerPermission: 'WRITE' });
    const withoutConfirm = new EnvironmentClaims({ registry, getRepository, logger: silentLogger });
    await expect(withoutConfirm.claim(SCALARION, 'token', { mode: 'interactive' })).resolves.toEqual([]);
    const failing = new EnvironmentClaims({
      registry,
      getRepository,
      confirm: async () => Promise.reject(new Error('The window closed')),
      logger: silentLogger,
    });
    await expect(failing.claim(SCALARION, 'token', { mode: 'interactive' })).resolves.toEqual([]);
    expect((await registry.get('shared'))?.owner).toBeUndefined();
  });

  it('asks only about the given environments', async () => {
    await registry.add(environment('a', 'scalarion/a'));
    await registry.add(environment('b', 'scalarion/b'));
    const getRepository = vi.fn(async (repository: string) => info(repository));
    const claims = new EnvironmentClaims({ registry, getRepository, logger: silentLogger });
    await expect(claims.claim(SCALARION, 'token', { environmentIds: ['b'] })).resolves.toEqual(['b']);
    expect(getRepository.mock.calls.map((call) => call[0])).toEqual(['scalarion/b']);
    expect((await registry.get('a'))?.owner).toBeUndefined();
  });

  it('runs one claim at a time, and never gives one entry to two accounts', async () => {
    await registry.add(environment('a', 'majikmate/module-ts'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getRepository = vi.fn(async (repository: string) => {
      await gate;
      return info(repository, { viewerPermission: 'WRITE' });
    });
    const confirm = vi.fn(async () => true);
    const claims = new EnvironmentClaims({ registry, getRepository, confirm, logger: silentLogger });
    const first = claims.claim(SCALARION, 'token-1', { mode: 'interactive' });
    const second = claims.claim(STAUSSH, 'token-2', { mode: 'interactive' });
    await vi.waitFor(() => expect(getRepository).toHaveBeenCalledTimes(1));
    release();
    await expect(first).resolves.toEqual(['a']);
    // The second claim runs after the first: the entry has an owner, so it is neither asked about nor claimed again.
    await expect(second).resolves.toEqual([]);
    expect(getRepository).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((await registry.get('a'))?.owner).toEqual(SCALARION);
  });

  it('adopts chosen entries without owner, without GitHub, and never takes an entry of another account', async () => {
    await registry.add(environment('gone', 'scalarion/deleted'));
    await registry.add(environment('other', 'acme/api', STAUSSH));
    const getRepository = vi.fn(async () => undefined);
    const logger = recordingLogger();
    const claims = new EnvironmentClaims({ registry, getRepository, logger });
    await expect(claims.adopt(SCALARION, ['gone', 'other', 'missing'])).resolves.toEqual(['gone']);
    expect(getRepository).not.toHaveBeenCalled();
    expect((await registry.get('gone'))?.owner).toEqual(SCALARION);
    expect((await registry.get('other'))?.owner).toEqual(STAUSSH);
    expect(logger.lines.join('\n')).not.toContain('acme/api');
    // Adopting an entry of the account again changes nothing.
    await expect(claims.adopt(SCALARION, ['gone'])).resolves.toEqual(['gone']);
  });

  it('gives an entry that two accounts adopt at the same time to exactly one of them', async () => {
    await registry.add(environment('gone', 'scalarion/deleted'));
    const claims = [
      new EnvironmentClaims({ registry, getRepository: async () => undefined, logger: silentLogger }),
      new EnvironmentClaims({ registry, getRepository: async () => undefined, logger: silentLogger }),
    ];
    const results = await Promise.all([claims[0].adopt(SCALARION, ['gone']), claims[1].adopt(STAUSSH, ['gone'])]);
    expect(results.flat()).toHaveLength(1);
    const owner = (await registry.get('gone'))?.owner;
    expect(owner).toEqual(results[0].length === 1 ? SCALARION : STAUSSH);
  });

  it('claims no entry of a repository of which the account has an environment, and asks neither GitHub nor the user', async () => {
    await registry.add(environment('own', 'scalarion/app', SCALARION));
    await registry.add(environment('older', 'Scalarion/App'));
    await registry.add(environment('shared', 'majikmate/module-ts'));
    const getRepository = vi.fn(async (repository: string) => info(repository, { viewerPermission: 'WRITE' }));
    const confirm = vi.fn(async (_entry: Environment, _account: GitHubAccount) => true);
    const logger = recordingLogger();
    const claims = new EnvironmentClaims({ registry, getRepository, confirm, logger });

    await expect(claims.claim(SCALARION, 'token', { mode: 'interactive' })).resolves.toEqual(['shared']);
    expect(getRepository.mock.calls.map((call) => call[0])).toEqual(['majikmate/module-ts']);
    expect(confirm.mock.calls.map((call) => call[0].id)).toEqual(['shared']);
    expect((await registry.get('older'))?.owner).toBeUndefined();
    expect(logger.lines).toContain('The environment older stays hidden: the signed-in account has an environment of its repository.');
    expect(logger.lines.join('\n')).not.toMatch(/scalarion\/app/i);
    // An account without an environment of the repository can take it over.
    await expect(claims.claim(STAUSSH, 'token', { mode: 'interactive', environmentIds: ['older'] })).resolves.toEqual(['older']);
    expect((await registry.get('older'))?.owner).toEqual(STAUSSH);
  });

  it('checks again under the registry lock: no claim when the account got an environment of the repository meanwhile', async () => {
    await registry.add(environment('older', 'scalarion/app'));
    const getRepository = vi.fn(async (repository: string) => {
      // Another window of the account creates its environment of the repository while GitHub is asked.
      await registry.add(environment('new', 'scalarion/app', SCALARION));
      return info(repository);
    });
    const logger = recordingLogger();
    const claims = new EnvironmentClaims({ registry, getRepository, logger });
    await expect(claims.claim(SCALARION, 'token')).resolves.toEqual([]);
    expect(getRepository).toHaveBeenCalledTimes(1);
    expect((await registry.get('older'))?.owner).toBeUndefined();
    expect((await registry.get('new'))?.owner).toEqual(SCALARION);
    expect(logger.lines).toContain('The environment older stays hidden: the signed-in account has an environment of its repository.');
  });

  it('reports the entries that stay without owner because GitHub could not be asked, and only those', async () => {
    await registry.add(environment('offline', 'majikmate/web'));
    await registry.add(environment('no-access', 'majikmate/private'));
    await registry.add(environment('declined', 'majikmate/module-ts'));
    await registry.add(environment('own', 'scalarion/app'));
    const getRepository = vi.fn(async (repository: string) => {
      if (repository === 'majikmate/web') throw new Error('getaddrinfo ENOTFOUND api.github.com');
      if (repository === 'majikmate/private') return undefined;
      return info(repository, { viewerPermission: 'WRITE' });
    });
    const unanswered: string[] = [];
    const claims = new EnvironmentClaims({ registry, getRepository, confirm: async () => false, logger: silentLogger });
    const claimed = await claims.claim(SCALARION, 'token', { mode: 'interactive', onUnanswered: (id) => unanswered.push(id) });
    expect(claimed).toEqual(['own']);
    expect(unanswered).toEqual(['offline']);
  });

  it('claims at most one of two entries without owner of one repository, and asks only once', async () => {
    // Not created by this version (add refuses it); written directly, as a registry of an unknown origin could have it.
    await registry.update((file) => {
      file.environments.push(environment('first', 'majikmate/module-ts'), environment('second', 'majikmate/module-ts'));
    });
    const getRepository = vi.fn(async (repository: string) => info(repository, { viewerPermission: 'WRITE' }));
    const confirm = vi.fn(async () => true);
    const claims = new EnvironmentClaims({ registry, getRepository, confirm, logger: silentLogger });
    await expect(claims.claim(SCALARION, 'token', { mode: 'interactive' })).resolves.toEqual(['first']);
    expect(getRepository).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((await registry.get('second'))?.owner).toBeUndefined();
  });

  it('adopts no entry of a repository of which the account has an environment', async () => {
    await registry.add(environment('own', 'scalarion/deleted', SCALARION));
    await registry.add(environment('gone', 'scalarion/deleted'));
    const claims = new EnvironmentClaims({ registry, getRepository: async () => undefined, logger: silentLogger });
    await expect(claims.adopt(SCALARION, ['gone'])).resolves.toEqual([]);
    expect((await registry.get('gone'))?.owner).toBeUndefined();
    await expect(claims.adopt(STAUSSH, ['gone'])).resolves.toEqual(['gone']);
    expect((await registry.get('gone'))?.owner).toEqual(STAUSSH);
  });

  it('never throws, also when the registry cannot be read', async () => {
    const claims = new EnvironmentClaims({
      registry: { list: async () => Promise.reject(new Error('EACCES')), update: async () => undefined as never },
      getRepository: async () => undefined,
      logger: silentLogger,
    });
    await expect(claims.claim(SCALARION, 'token')).resolves.toEqual([]);
    await expect(
      new EnvironmentClaims({
        registry: { list: async () => [], update: async () => Promise.reject(new Error('lock timeout')) },
        getRepository: async () => undefined,
        logger: silentLogger,
      }).adopt(SCALARION, ['a']),
    ).resolves.toEqual([]);
  });

  it('logs no repository name of an entry that stays hidden, with the real discovery in its quiet mode', async () => {
    await registry.add(environment('no-access', 'majikmate/secret'));
    await registry.add(environment('timeout', 'majikmate/slow'));
    await registry.add(environment('limited', 'majikmate/limited'));
    await registry.add(environment('http', 'majikmate/down'));
    const replies: Record<string, { status?: number; body: unknown }> = {
      secret: {
        body: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'majikmate/secret'." }] },
      },
      slow: {
        body: { data: { repository: null }, errors: [{ message: "Something went wrong while executing your query for 'majikmate/slow'." }] },
      },
      limited: { body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for majikmate/limited' }] } },
      down: { status: 502, body: { message: 'Bad gateway for majikmate/down' } },
    };
    const transport: HttpTransport = {
      async request(request: HttpRequest): Promise<HttpResponse> {
        const { variables } = JSON.parse(request.body ?? '{}') as { variables: { name: string } };
        const reply = replies[variables.name];
        return { status: reply.status ?? 200, headers: {}, body: JSON.stringify(reply.body) };
      },
    };
    const logger = recordingLogger();
    const discovery = new DiscoveryService(new GitHubApi(transport, logger), () => path.join(root, 'unused.json'), logger);
    const claims = new EnvironmentClaims({
      registry,
      getRepository: (repository, token, signal) => discovery.getRepository(repository, token, signal, { quiet: true }),
      logger,
    });
    await expect(claims.claim(STAUSSH, 'token')).resolves.toEqual([]);
    for (const id of ['no-access', 'timeout', 'limited', 'http']) expect((await registry.get(id))?.owner).toBeUndefined();
    const logged = logger.lines.join('\n');
    for (const name of ['secret', 'slow', 'limited', 'down']) expect(logged).not.toContain(`majikmate/${name}`);
    // The reason stays: the status of a failed request.
    expect(logged).toContain('(HTTP 502)');
  });
});
