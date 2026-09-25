// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Discovery Service (concept 7.4): finds the repositories with a Dev Container configuration through the GitHub
// GraphQL API and stores the result in repositories-<account ID>.json, one file per GitHub account (concept 6.2). Security
// (concept section 9): the token is only passed on to the GitHubApi; the stored file contains metadata only.
import { allOrAbort, Semaphore } from '../concurrency';
import { readJson, writeJsonAtomic } from '../storage/atomicJson';
import type { GitHubViewer } from '../helper/containerGit';
import { splitRepository } from '../names';
import { abortError, isAbortError, isoTime, silentLogger, systemClock, type Clock, type Logger } from '../ports';
import type {
  CheckedRepository,
  DiscoveryData,
  ExtensionSettings,
  OrganizationHint,
  OrganizationHintKind,
  RepositoryInfo,
} from '../types';
import { detectConfigurations, type ConfigurationNode } from './detect';
import { checkedRepository, needsConfigurationLookup, nodesWithErrors, storedDetections, type StoredDetection } from './incremental';
import {
  describeGraphQLErrors,
  GitHubApiError,
  GitHubTimeoutError,
  type GitHubApi,
  type GraphQLError,
} from './githubApi';
import { normalizeScope, scopeLogins } from './scope';

/** Repositories per list request (concept 7.4): without the configuration lookups, so the most that GitHub allows. */
export const DISCOVERY_PAGE_SIZE = 100;
/**
 * Repositories per request of the configuration lookups (concept 7.4). Assumption (V-5): GitHub answers 50 repositories
 * with the lookups within its time limit in most cases (about 3 seconds).
 */
export const LOOKUP_BATCH_SIZE = 50;
/** Smallest page size when GitHub does not answer a page in time. */
export const DISCOVERY_MIN_PAGE_SIZE = 10;
/** Requests of one refresh that run at the same time at most (concept 7.4). */
export const DISCOVERY_CONCURRENCY = 4;
/** Protection against a pagination that never ends. */
const MAX_PAGES = 1000;
const ORGANIZATIONS_PAGE_SIZE = 100;
const MAX_ORGANIZATION_PAGES = 20;
const PROBE_CHUNK_SIZE = 50;
const BRANCH_LIMIT = 100;

/** Client ID of the GitHub OAuth app that VS Code uses for the GitHub sign-in. */
export const VSCODE_GITHUB_OAUTH_APP_CLIENT_ID = '01ab8ac9400c4e429b23';
/** Page where the user requests or grants access of the OAuth app to an organization. */
export const OAUTH_APP_CONNECTIONS_URL = `https://github.com/settings/connections/applications/${VSCODE_GITHUB_OAUTH_APP_CLIENT_ID}`;

/** Fields of the configuration folder: sub-folders with their entries, one level deep (concept 7.4). */
const CONFIGURATION_FOLDER_FRAGMENT = `fragment ConfigurationFolder on Tree {
  entries {
    name
    type
    object {
      ... on Tree {
        entries {
          name
          type
        }
      }
    }
  }
}`;

// `HEAD` is the default branch (concept 7.4).
const REPOSITORY_FIELDS_FRAGMENT = `fragment RepositoryFields on Repository {
  id
  name
  nameWithOwner
  url
  isArchived
  isFork
  isPrivate
  viewerPermission
  pushedAt
  owner {
    login
  }
  defaultBranchRef {
    name
  }
  rootFile: object(expression: "HEAD:.devcontainer.json") {
    __typename
  }
  folder: object(expression: "HEAD:.devcontainer") {
    ...ConfigurationFolder
  }
}`;

/** The fields of a repository without the configuration lookups, which make a request slow. */
const REPOSITORY_LIST_FIELDS_FRAGMENT = `fragment RepositoryListFields on Repository {
  id
  name
  nameWithOwner
  url
  isArchived
  isFork
  isPrivate
  viewerPermission
  pushedAt
  owner {
    login
  }
  defaultBranchRef {
    name
  }
}`;

/**
 * The list query of concept 7.4 with `owner { login }`, `isPrivate`, and `viewerPermission`, without the configuration
 * lookups, which make a request slow: they follow in batches (`configurationsQuery`). The first page also reads the
 * login of the user and the organizations where the user is a member (`$withOrganizations`).
 * Variables: `cursor` (String, null for the first page), `pageSize` (Int, normally 100), `withOrganizations` (Boolean).
 */
// Assumption (V-5): `affiliations` and `ownerAffiliations` with OWNER, COLLABORATOR, ORGANIZATION_MEMBER return all
// repositories that the user can access, including organization repositories through teams. Internal repositories of
// other organizations of the same enterprise may be missing.
export const DISCOVERY_QUERY = `query Discover($cursor: String, $pageSize: Int!, $withOrganizations: Boolean!) {
  viewer {
    login
    databaseId
    organizations(first: ${ORGANIZATIONS_PAGE_SIZE}) @include(if: $withOrganizations) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        login
      }
    }
    repositories(
      first: $pageSize
      after: $cursor
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ...RepositoryListFields
      }
    }
  }
}
${REPOSITORY_LIST_FIELDS_FRAGMENT}`;

/** Further pages of the organizations of the user (more than 100 organizations). */
export const ORGANIZATIONS_QUERY = `query Organizations($cursor: String) {
  viewer {
    organizations(first: ${ORGANIZATIONS_PAGE_SIZE}, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        login
      }
    }
  }
}`;

/** The signed-in account: its user ID, login, and profile name (the Git identity of the container, concept section 9). */
export const VIEWER_QUERY = `query Viewer {
  viewer {
    databaseId
    login
    name
  }
}`;

/** One repository by owner and name. GitHub follows renames of repositories. */
export const REPOSITORY_QUERY = `query Repository($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ...RepositoryFields
  }
}
${REPOSITORY_FIELDS_FRAGMENT}
${CONFIGURATION_FOLDER_FRAGMENT}`;

/** Branches of a repository, and its default branch. */
export const BRANCHES_QUERY = `query Branches($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      name
    }
    refs(refPrefix: "refs/heads/", first: ${BRANCH_LIMIT}, orderBy: { field: ALPHABETICAL, direction: ASC }) {
      nodes {
        name
      }
    }
  }
}`;

/** Configuration files on one branch. The expressions are variables, so a branch name is never part of the query text. */
export const BRANCH_CONFIGURATIONS_QUERY = `query BranchConfigurations($owner: String!, $name: String!, $rootFile: String!, $folder: String!) {
  repository(owner: $owner, name: $name) {
    rootFile: object(expression: $rootFile) {
      __typename
    }
    folder: object(expression: $folder) {
      ...ConfigurationFolder
    }
  }
}
${CONFIGURATION_FOLDER_FRAGMENT}`;

// `HEAD` is the default branch (concept 7.4).
const CONFIGURATION_LOOKUPS_FRAGMENT = `fragment ConfigurationLookups on Repository {
  rootFile: object(expression: "HEAD:.devcontainer.json") {
    __typename
  }
  folder: object(expression: "HEAD:.devcontainer") {
    ...ConfigurationFolder
  }
}`;

/** One page of a repository connection of the scan scope, without the configuration lookups. */
function scopeConnection(argumentsText: string): string {
  return `repositories(
        first: $pageSize
        after: $cursor
        ${argumentsText}orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ...RepositoryListFields
        }
      }`;
}

/**
 * The signed-in account and its organizations, without repositories: the first request of a refresh with a scan scope,
 * and the list of the organization selector. Further pages of organizations: ORGANIZATIONS_QUERY.
 */
export const SCOPE_VIEWER_QUERY = `query ScopeViewer {
  viewer {
    login
    databaseId
    organizations(first: ${ORGANIZATIONS_PAGE_SIZE}) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        login
      }
    }
  }
}`;

/**
 * The repositories of one organization or user account of the scan scope (concept 7.4), last push first.
 * Variables: `login`, `cursor`, `pageSize`. `repositoryOwner` is `null` for an unknown login.
 */
export const OWNER_REPOSITORIES_QUERY = `query OwnerRepositories($login: String!, $cursor: String, $pageSize: Int!) {
  repositoryOwner(login: $login) {
    __typename
    login
    ... on Organization {
      ${scopeConnection('')}
    }
    ... on User {
      ${scopeConnection('ownerAffiliations: [OWNER]\n        ')}
    }
  }
}
${REPOSITORY_LIST_FIELDS_FRAGMENT}`;

/**
 * The repositories of the signed-in account itself when it is in the scan scope: `viewer` also returns its private
 * repositories. Variables: `cursor`, `pageSize`.
 */
export const VIEWER_REPOSITORIES_QUERY = `query ViewerRepositories($cursor: String, $pageSize: Int!) {
  viewer {
    login
    ${scopeConnection('affiliations: [OWNER]\n        ownerAffiliations: [OWNER]\n        ')}
  }
}
${REPOSITORY_LIST_FIELDS_FRAGMENT}`;

/**
 * The configuration lookups of up to LOOKUP_BATCH_SIZE repositories in one request, as aliases `r0`, `r1`, …
 * Variables: `o<i>` (owner) and `n<i>` (name) of each repository.
 */
export function configurationsQuery(count: number): string {
  const variables: string[] = [];
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    variables.push(`$o${i}: String!, $n${i}: String!`);
    fields.push(`  r${i}: repository(owner: $o${i}, name: $n${i}) {\n    ...ConfigurationLookups\n  }`);
  }
  return `query Configurations(${variables.join(', ')}) {\n${fields.join('\n')}\n}\n${CONFIGURATION_LOOKUPS_FRAGMENT}\n${CONFIGURATION_FOLDER_FRAGMENT}`;
}

/** Query that reads one repository of each given organization. An organization that restricts access answers with an error. */
export function organizationAccessQuery(count: number): string {
  const variables: string[] = [];
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    variables.push(`$o${i}: String!`);
    fields.push(`  o${i}: organization(login: $o${i}) {\n    login\n    repositories(first: 1) {\n      nodes {\n        id\n      }\n    }\n  }`);
  }
  return `query OrganizationAccess(${variables.join(', ')}) {\n${fields.join('\n')}\n}`;
}

// Shapes of the query results. Every field is optional: the data comes from the network and is checked before use.
interface PageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface Connection<T> {
  pageInfo?: PageInfo | null;
  nodes?: Array<T | null> | null;
}

interface LoginNode {
  login?: string;
}

interface RepositoryNode extends ConfigurationNode {
  id?: string;
  name?: string;
  nameWithOwner?: string;
  url?: string;
  isArchived?: boolean;
  isFork?: boolean;
  isPrivate?: boolean;
  viewerPermission?: string | null;
  pushedAt?: string | null;
  owner?: LoginNode | null;
  defaultBranchRef?: { name?: string } | null;
}

interface ViewerNode {
  login?: string;
  databaseId?: number | null;
  organizations?: Connection<LoginNode> | null;
  repositories?: Connection<RepositoryNode> | null;
}

interface DiscoverData {
  viewer?: ViewerNode | null;
}

/** A viewer node of a usable page: with the login and the repository connection. */
type PageViewer = ViewerNode & { login: string; repositories: Connection<RepositoryNode> };

function isPageViewer(viewer: ViewerNode | null | undefined): viewer is PageViewer {
  return isRecord(viewer) && typeof viewer.login === 'string' && viewer.login !== '' && isRecord(viewer.repositories);
}

interface ViewerData {
  viewer?: { databaseId?: number | null; login?: string; name?: string | null } | null;
}

interface OrganizationsData {
  viewer?: { organizations?: Connection<LoginNode> | null } | null;
}

interface RepositoryData {
  repository?: RepositoryNode | null;
}

interface BranchesData {
  repository?: {
    defaultBranchRef?: { name?: string } | null;
    refs?: Connection<{ name?: string }> | null;
  } | null;
}

interface BranchConfigurationsData {
  repository?: ConfigurationNode | null;
}

/** A GraphQL error together with the data of the same response, to find the organization through the path. */
interface CollectedError {
  error: GraphQLError;
  data: unknown;
  /** The organization or account that the request was about, for a request about one owner of the scan scope. */
  organization?: string;
}

interface ScopeViewerData {
  viewer?: { login?: string; databaseId?: number | null; organizations?: Connection<LoginNode> | null } | null;
}

interface OwnerPageData {
  repositoryOwner?: { login?: string; repositories?: Connection<RepositoryNode> | null } | null;
  viewer?: { login?: string; repositories?: Connection<RepositoryNode> | null } | null;
}

export interface DiscoveryOptions {
  /**
   * The setting `owners`, read at each refresh: the scan scope (concept 7.4). Configured, the refresh asks GitHub only
   * about the repositories of these organizations and accounts. Empty (default): all repositories of the account.
   */
  scope?: () => readonly string[];
}

/** A part of the result of a running refresh (DiscoveryService.onPartialResult). */
export interface PartialDiscovery {
  /** The account whose list is loading. */
  accountId: string;
  /**
   * The repositories with a configuration found so far, in the scope of the refresh (`scope`); no organizations and no
   * hints yet. A repository whose configurations are read joins after its batch of lookups.
   */
  data: DiscoveryData;
}

/** The requests of one refresh: the token, the limit of parallel requests, the collected errors, and a counter for the log. */
interface RefreshRun {
  token: string;
  accountId: string;
  scope: string[];
  limiter: Semaphore;
  /** Aborts every request of the refresh at its first failure (`failure`), or when the signal of the caller aborts. */
  controller: AbortController;
  failure?: { error: unknown };
  onAbort: () => void;
  requests: number;
  lookupRequests: number;
  /** The configuration lookups, started while the list still loads. */
  lookups: LookupQueue;
  errors: CollectedError[];
  viewerLogin: string;
  /** The collectors of the scan in the order of the result: one for the full list, or one per owner of the scope. */
  collectors: RepositoryCollector[];
}

/** The repositories of a scan, before the organizations and the hints. */
interface ScanResult {
  viewerLogin: string;
  organizations: Connection<LoginNode> | null | undefined;
  collector: RepositoryCollector;
  /** Owners of the scan scope that GitHub did not return (unknown, or no access). */
  missingOwners: string[];
}

/** The repositories of one owner of the scan scope. `missing`: GitHub did not return the owner. */
interface OwnerScan {
  collector: RepositoryCollector;
  missing: boolean;
}

/**
 * The stored detection results of a refresh with a stored list (incremental detection), or `undefined` for the first
 * load, which reads the configurations of all repositories.
 */
type Detections = Map<string, StoredDetection> | undefined;

/** An owner of the scan scope that GitHub does not return: `repositoryOwner` is `null`. */
const MISSING_OWNER = 'missing';

export class DiscoveryService {
  constructor(
    private readonly api: GitHubApi,
    /** The file of the stored list of an account (StoragePaths.repositoriesFile). */
    private readonly fileOf: (accountId: string) => string,
    private readonly logger: Logger = silentLogger,
    private readonly clock: Clock = systemClock,
    private readonly options: DiscoveryOptions = {},
  ) {}

  private readonly partialListeners = new Set<(result: PartialDiscovery) => void>();

  /**
   * Progressive display (concept 7.4): `listener` gets the repositories found so far after each page of the list, and
   * after each batch of configuration lookups. The complete list is the result of `refresh`.
   */
  onPartialResult(listener: (result: PartialDiscovery) => void): { dispose(): void } {
    this.partialListeners.add(listener);
    return { dispose: () => this.partialListeners.delete(listener) };
  }

  /**
   * The stored result of the last discovery of the account `accountId`. `undefined` if there is none or if the file is
   * not valid. The list of another account is never read.
   */
  async loadStored(accountId: string): Promise<DiscoveryData | undefined> {
    return parseDiscoveryData(await readJson<unknown>(this.fileOf(accountId)));
  }

  /**
   * Full discovery for the account `accountId` with its token, in the scan scope of DiscoveryOptions.scope (concept 7.4):
   * - empty scope: all pages of `viewer.repositories` with up to 100 repositories each, without the configuration
   *   lookups, one after another, in the order of the API (last push first);
   * - configured scope: first the account and its organizations, then the repositories of each owner of the scope, the
   *   owners in parallel, the pages of one owner one after another. No request is about another owner. An owner that
   *   GitHub does not return gets a `notFound` hint.
   * The configuration lookups follow in batches of LOOKUP_BATCH_SIZE, each started as soon as its repositories are listed:
   * for all repositories on the first load, else only for new and changed ones (incremental detection). All requests
   * share the limit of DISCOVERY_CONCURRENCY at the same time; the list pages go first. Keeps only repositories with at least one configuration. Errors for organizations with SAML single sign-on or OAuth
   * app access restrictions become one hint per organization. Partial data with errors is used. Stores the result with
   * its scope atomically in the file of the account and returns it. Throws on a network failure, an HTTP error, when
   * GitHub does not return the list, or when the token belongs to another account (a sign-in changed the session
   * meanwhile); the stored file then stays unchanged.
   */
  async refresh(token: string, accountId: string, signal?: AbortSignal): Promise<DiscoveryData> {
    const started = this.clock.now();
    const logins = scopeLogins(this.options.scope?.() ?? []);
    const run = this.newRun(token, accountId, normalizeScope(logins), DISCOVERY_CONCURRENCY, signal);
    // Concept 7.4: with a stored list, only new and changed repositories get the (slow) configuration lookups. The
    // results do not depend on the scope, so a list of another scope helps too; it is never shown for this scope.
    const previous = await this.loadStored(accountId).catch(() => undefined);
    const detections: Detections = previous ? storedDetections(previous) : undefined;
    let scan: ScanResult;
    try {
      scan = logins.length === 0 ? await this.scanAll(run, accountId, detections) : await this.scanScope(run, accountId, logins, detections);
      await run.lookups.finish();
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw run.failure ? run.failure.error : error;
    } finally {
      signal?.removeEventListener('abort', run.onAbort);
    }
    if (run.lookups.count > 0) {
      this.logger.info(
        `Repository list: configurations of ${run.lookups.count} ${detections ? 'new or changed ' : ''}repositories read with ${run.lookupRequests} requests.`,
      );
    }

    const organizations = await this.collectOrganizations(scan.organizations, run, signal);
    const hints = new HintCollector(scan.viewerLogin);
    for (const { error, data, organization } of run.errors) hints.add(error, data, organization);
    if (hints.unattributed > 0) {
      // With a scan scope, only organizations of the scope are asked.
      const scope = new Set(normalizeScope(logins));
      await this.probeOrganizations(
        organizations.filter(
          (organization) => !hints.has(organization) && (scope.size === 0 || scope.has(organization.toLowerCase())),
        ),
        hints,
        run,
        signal,
      );
    }
    for (const owner of scan.missingOwners) hints.addNotFound(owner);
    this.logErrors(run.errors);

    const repositories = scan.collector.repositories();
    const result: DiscoveryData = {
      version: 1,
      fetchedAt: isoTime(this.clock),
      viewerLogin: scan.viewerLogin,
      organizations,
      repositories,
      hints: hints.list(),
      scope: normalizeScope(logins),
      withoutConfiguration: scan.collector.withoutConfiguration(),
    };
    const uncertain = scan.collector.uncertain();
    if (uncertain.length > 0) result.uncertain = uncertain;
    this.logger.info(
      `Repository list: ${repositories.length} of ${scan.collector.scanned} repositories have a Dev Container configuration` +
        (result.hints.length > 0 ? `, ${result.hints.length} organizations need an authorization or were not found.` : '.'),
    );
    const seconds = Math.max(0, this.clock.now() - started) / 1000;
    this.logger.info(
      `Repository list: loaded in ${seconds.toFixed(1)} seconds with ${run.requests} requests` +
        (logins.length > 0 ? ` (scan scope: ${logins.join(', ')}).` : '.'),
    );
    try {
      await writeJsonAtomic(this.fileOf(accountId), result);
    } catch (error) {
      // The list is still valid for this session; the next refresh stores it again.
      this.logger.error('Repository list: the list could not be stored.', error);
    }
    return result;
  }

  /**
   * The login of the account of the token and the organizations where it is a member, without any repository (for the
   * organization selector; allowed with any scan scope). Throws when GitHub does not return the account; a failed further
   * page of organizations only shortens the list.
   */
  async viewerOrganizations(token: string, signal?: AbortSignal): Promise<{ login: string; organizations: string[] }> {
    const run = this.newRun(token, '', [], 1, signal);
    try {
      const viewer = await this.scopeViewer(run);
      const organizations = await this.collectOrganizations(viewer.organizations, run, run.controller.signal);
      return { login: viewer.login, organizations };
    } finally {
      signal?.removeEventListener('abort', run.onAbort);
    }
  }

  /** The account of the token: user ID, login, and profile name. Throws when GitHub does not return it. */
  async viewer(token: string, signal?: AbortSignal): Promise<GitHubViewer> {
    const result = await this.api.graphql<ViewerData>(VIEWER_QUERY, {}, token, signal);
    const viewer = result.data?.viewer;
    if (!isRecord(viewer) || typeof viewer.databaseId !== 'number' || typeof viewer.login !== 'string' || viewer.login === '') {
      throw new Error(`GitHub did not return the account: ${describeGraphQLErrors(result.errors)}`);
    }
    return { databaseId: viewer.databaseId, login: viewer.login, name: typeof viewer.name === 'string' ? viewer.name : null };
  }

  /** Branch names (refs/heads, up to 100, alphabetical), the default branch first. */
  async listBranches(repository: string, token: string, signal?: AbortSignal): Promise<string[]> {
    const { owner, name } = splitRepository(repository);
    const result = await this.api.graphql<BranchesData>(BRANCHES_QUERY, { owner, name }, token, signal);
    const node = result.data?.repository;
    if (!isRecord(node)) {
      throw new Error(`GitHub did not return the repository ${repository}: ${describeGraphQLErrors(result.errors)}`);
    }
    if (result.errors) this.logger.warn(`Branches of ${repository}: ${describeGraphQLErrors(result.errors)}`);
    const names: string[] = [];
    const defaultBranch = node.defaultBranchRef?.name;
    if (typeof defaultBranch === 'string' && defaultBranch !== '') names.push(defaultBranch);
    for (const ref of asArray(node.refs?.nodes)) {
      const branch = isRecord(ref) ? ref.name : undefined;
      if (typeof branch === 'string' && branch !== '' && !names.includes(branch)) names.push(branch);
    }
    return names;
  }

  /**
   * Configuration paths on a branch, with the same detection rules as the discovery. An empty list means that the
   * branch has no configuration, or that the branch does not exist.
   */
  // Assumption (V-5): `object(expression: "<branch>:<path>")` resolves the branch like `git rev-parse`. A tag with the
  // same name as the branch would win; such repositories are rare.
  async configurationsOnBranch(repository: string, branch: string, token: string, signal?: AbortSignal): Promise<string[]> {
    const { owner, name } = splitRepository(repository);
    const result = await this.api.graphql<BranchConfigurationsData>(
      BRANCH_CONFIGURATIONS_QUERY,
      { owner, name, rootFile: `${branch}:.devcontainer.json`, folder: `${branch}:.devcontainer` },
      token,
      signal,
    );
    const node = result.data?.repository;
    if (!isRecord(node)) {
      throw new Error(`GitHub did not return the repository ${repository}: ${describeGraphQLErrors(result.errors)}`);
    }
    if (result.errors) this.logger.warn(`Configurations of ${repository} on ${branch}: ${describeGraphQLErrors(result.errors)}`);
    return detectConfigurations(node);
  }

  /**
   * One repository, for repositories that are not in the stored list (for example environments that only the registry
   * knows). `undefined` if GitHub does not return it (not found, or no access). The result can have no configuration.
   * Throws when the query failed (for example a rate limit or a timeout), because the answer is then unknown.
   * `quiet` (for repositories that may belong to another account, concept 7.5): nothing is logged, and an error message
   * names neither the repository nor quotes GitHub, whose messages can contain the name.
   */
  async getRepository(
    repository: string,
    token: string,
    signal?: AbortSignal,
    options: { quiet?: boolean } = {},
  ): Promise<RepositoryInfo | undefined> {
    const quiet = options.quiet === true;
    let owner: string;
    let name: string;
    try {
      ({ owner, name } = splitRepository(repository));
    } catch (error) {
      if (quiet) throw new Error('Invalid repository name.');
      throw error;
    }
    const result = await this.api.graphql<RepositoryData>(REPOSITORY_QUERY, { owner, name }, token, signal);
    if (result.errors && !quiet) this.logger.info(`Repository ${repository}: ${describeGraphQLErrors(result.errors)}`);
    const node = result.data?.repository;
    if (isRecord(node)) return toRepositoryInfo(node);
    const notFoundOrNoAccess =
      result.data !== undefined &&
      node === null &&
      (result.errors ?? []).every((error) => error.type === 'NOT_FOUND' || classifyGraphQLError(error) !== undefined);
    if (notFoundOrNoAccess) return undefined;
    if (quiet) throw new Error(`GitHub did not answer the query for a repository (${graphQLErrorKinds(result.errors)}).`);
    throw new Error(`GitHub did not answer the query for the repository ${repository}: ${describeGraphQLErrors(result.errors)}`);
  }

  /** Empty scan scope: all pages of `viewer.repositories`, one after another (GitHub has no parallel cursor). */
  private async scanAll(run: RefreshRun, accountId: string, detections: Detections): Promise<ScanResult> {
    const collector = new RepositoryCollector(detections);
    run.collectors = [collector];
    let viewerLogin = '';
    let organizations: Connection<LoginNode> | null | undefined;
    let cursor: string | null = null;
    const usedCursors = new Set<string>();
    let pageSize = DISCOVERY_PAGE_SIZE;
    let pages = 0;

    for (;;) {
      if (pages >= MAX_PAGES) {
        this.logger.warn(`Repository list: stopped after ${pages} pages.`);
        break;
      }
      const withOrganizations = pages === 0;
      const after: string | null = cursor;
      const page = await this.fetchPage(
        run,
        DISCOVERY_QUERY,
        (size) => ({ cursor: after, pageSize: size, withOrganizations }),
        pageSize,
        (data: DiscoverData | undefined) => (isPageViewer(data?.viewer) ? data.viewer : undefined),
      );
      pages++;
      pageSize = page.pageSize;
      const viewer = page.value;
      if (pages === 1) {
        viewerLogin = viewer.login;
        organizations = viewer.organizations;
        checkAccount(viewer.databaseId, accountId);
        run.viewerLogin = viewerLogin;
      }
      for (const error of page.errors) run.errors.push({ error, data: page.data });
      run.lookups.add(collector.addPage(asArray(viewer.repositories.nodes), page.errors));
      this.reportPartial(run);
      const next = nextCursor(viewer.repositories.pageInfo, usedCursors);
      if (next === undefined) break;
      cursor = next;
    }
    return { viewerLogin, organizations, collector, missingOwners: [] };
  }

  /**
   * Configured scan scope: the account and its organizations (no repository), then each owner of the scope in parallel.
   * The first failure of an owner stops the others.
   */
  private async scanScope(
    run: RefreshRun,
    accountId: string,
    logins: readonly string[],
    detections: Detections,
  ): Promise<ScanResult> {
    const viewer = await this.scopeViewer(run);
    checkAccount(viewer.databaseId, accountId);
    run.viewerLogin = viewer.login;
    run.collectors = logins.map(() => new RepositoryCollector(detections));
    const scans = await Promise.all(
      logins.map((login, index) =>
        this.guard(run, this.scanOwner(run, login, viewer.login, run.collectors[index])),
      ),
    );
    const collector = new RepositoryCollector(detections);
    const missingOwners: string[] = [];
    scans.forEach((scan, index) => {
      if (scan.missing) missingOwners.push(logins[index]);
      collector.addAll(scan.collector);
    });
    return { viewerLogin: viewer.login, organizations: viewer.organizations, collector, missingOwners };
  }

  /** The signed-in account and the first page of its organizations. Throws when GitHub does not return the account. */
  private async scopeViewer(
    run: RefreshRun,
  ): Promise<{ login: string; databaseId: number | null | undefined; organizations: Connection<LoginNode> | null | undefined }> {
    const result = await this.request<ScopeViewerData>(run, SCOPE_VIEWER_QUERY, {}, run.controller.signal, true);
    const viewer = result.data?.viewer;
    if (!isRecord(viewer) || typeof viewer.login !== 'string' || viewer.login === '') {
      throw new Error(`GitHub did not return the account: ${describeGraphQLErrors(result.errors)}`);
    }
    for (const error of result.errors ?? []) run.errors.push({ error, data: result.data });
    return { login: viewer.login, databaseId: viewer.databaseId, organizations: viewer.organizations };
  }

  /**
   * All pages of one owner of the scan scope, one after another. The signed-in account itself is read through `viewer`,
   * which includes its private repositories.
   */
  private async scanOwner(
    run: RefreshRun,
    login: string,
    viewerLogin: string,
    collector: RepositoryCollector,
  ): Promise<OwnerScan> {
    const own = login.toLowerCase() === viewerLogin.toLowerCase();
    let cursor: string | null = null;
    const usedCursors = new Set<string>();
    let pageSize = DISCOVERY_PAGE_SIZE;
    let pages = 0;
    for (;;) {
      if (pages >= MAX_PAGES) {
        this.logger.warn(`Repository list: stopped after ${pages} pages of ${login}.`);
        break;
      }
      const after: string | null = cursor;
      const page = await this.fetchPage(
        run,
        own ? VIEWER_REPOSITORIES_QUERY : OWNER_REPOSITORIES_QUERY,
        (size) => ({ ...(own ? {} : { login }), cursor: after, pageSize: size }),
        pageSize,
        (data: OwnerPageData | undefined, errors) => readOwnerPage(own ? data?.viewer : data?.repositoryOwner, data, errors),
      );
      pages++;
      pageSize = page.pageSize;
      for (const error of page.errors) run.errors.push({ error, data: page.data, organization: login });
      if (page.value === MISSING_OWNER) return { collector, missing: pages === 1 };
      run.lookups.add(collector.addPage(asArray(page.value.nodes), page.errors));
      this.reportPartial(run);
      const next = nextCursor(page.value.pageInfo, usedCursors);
      if (next === undefined) break;
      cursor = next;
    }
    return { collector, missing: false };
  }

  /**
   * The state of one refresh. Its requests share one limit of `concurrency` requests at the same time, and one abort:
   * the first failure (`guard`) or an abort of `signal` stops all of them.
   */
  private newRun(token: string, accountId: string, scope: string[], concurrency: number, signal: AbortSignal | undefined): RefreshRun {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const run: RefreshRun = {
      token,
      accountId,
      scope,
      limiter: new Semaphore(concurrency),
      controller,
      onAbort,
      requests: 0,
      lookupRequests: 0,
      lookups: new LookupQueue((batch) => this.guard(run, this.lookUpBatch(run, batch, controller.signal))),
      errors: [],
      viewerLogin: '',
      collectors: [],
    };
    return run;
  }

  /** The first failure of a part of the refresh stops the other parts; the refresh then fails with it. */
  private async guard<T>(run: RefreshRun, work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      if (!run.failure && !isAbortError(error)) {
        run.failure = { error };
        run.controller.abort();
      }
      throw error;
    }
  }

  private async lookUpBatch(run: RefreshRun, batch: CollectedRepository[], signal: AbortSignal): Promise<void> {
    const variables: Record<string, unknown> = {};
    batch.forEach((entry, index) => {
      variables[`o${index}`] = entry.info.owner;
      variables[`n${index}`] = entry.info.name;
    });
    let failure: unknown;
    let retryable: boolean;
    try {
      run.lookupRequests++;
      const result = await this.request<Record<string, ConfigurationNode | null>>(run, configurationsQuery(batch.length), variables, signal);
      const data = result.data;
      const answered = isRecord(data) && batch.some((_entry, index) => isRecord(data[`r${index}`]));
      if (isRecord(data) && (answered || !isTimeoutResponse(result.errors))) {
        const uncertain = new Set<number>();
        for (const error of result.errors ?? []) {
          const match = typeof error.path?.[0] === 'string' ? /^r(\d+)$/.exec(error.path[0]) : null;
          const entry = match ? batch[Number(match[1])] : undefined;
          if (match) uncertain.add(Number(match[1]));
          run.errors.push({ error, data, organization: entry?.info.owner });
        }
        batch.forEach((entry, index) => {
          const node = data[`r${index}`];
          // A repository that GitHub does not return now (renamed, removed, or no access) is read again next time.
          entry.info = { ...entry.info, configPaths: isRecord(node) ? detectConfigurations(node) : [] };
          entry.checked = isRecord(node) && !uncertain.has(index);
          entry.lookup = false;
        });
        this.reportPartial(run);
        return;
      }
      failure = new Error(`GitHub did not return the configurations of the repositories: ${describeGraphQLErrors(result.errors)}`);
      retryable = isTimeoutResponse(result.errors);
    } catch (error) {
      if (isAbortError(error)) throw error;
      failure = error;
      retryable = isRetryableError(error);
    }
    if (!retryable || batch.length <= DISCOVERY_MIN_PAGE_SIZE) throw failure;
    this.logger.warn('Repository list: GitHub did not read the configurations in time. Trying again in smaller requests.');
    const half = Math.ceil(batch.length / 2);
    await allOrAbort([batch.slice(0, half), batch.slice(half)], (part, partSignal) => this.lookUpBatch(run, part, partSignal), signal);
  }

  /** Gives the repositories found so far to the listeners of onPartialResult. A failing listener is logged. */
  private reportPartial(run: RefreshRun): void {
    if (this.partialListeners.size === 0) return;
    const merged = new RepositoryCollector(undefined);
    for (const collector of run.collectors) merged.addAll(collector);
    const data: DiscoveryData = {
      version: 1,
      fetchedAt: isoTime(this.clock),
      viewerLogin: run.viewerLogin,
      organizations: [],
      repositories: merged.repositories(),
      hints: [],
      scope: [...run.scope],
    };
    for (const listener of this.partialListeners) {
      try {
        listener({ accountId: run.accountId, data });
      } catch (error) {
        this.logger.warn(`Repository list: a part of the list could not be shown: ${errorText(error)}`);
      }
    }
  }

  /**
   * One GraphQL request of a refresh, within the limit of parallel requests. A `priority` request (a page of the list)
   * goes before the waiting lookups, so the list keeps loading while the lookups run.
   */
  private request<T>(
    run: RefreshRun,
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal | undefined,
    priority = false,
  ): Promise<{ data?: T; errors?: GraphQLError[] }> {
    return run.limiter.run(() => {
      run.requests++;
      return this.api.graphql<T>(query, variables, run.token, signal);
    }, priority);
  }

  /**
   * One page of a repository list. `read` returns the usable part of the response, or `undefined` when GitHub did not
   * return the list. GitHub stops a query that takes too long: then the page is asked again with fewer repositories.
   */
  private async fetchPage<D, P>(
    run: RefreshRun,
    query: string,
    variables: (pageSize: number) => Record<string, unknown>,
    initialPageSize: number,
    read: (data: D | undefined, errors: GraphQLError[] | undefined) => P | undefined,
  ): Promise<{ value: P; errors: GraphQLError[]; data: unknown; pageSize: number }> {
    let pageSize = initialPageSize;
    for (;;) {
      let failure: unknown;
      let retryable: boolean;
      try {
        const result = await this.request<D>(run, query, variables(pageSize), run.controller.signal, true);
        const value = read(result.data, result.errors);
        if (value !== undefined) return { value, errors: result.errors ?? [], data: result.data, pageSize };
        failure = new Error(`GitHub did not return the repository list: ${describeGraphQLErrors(result.errors)}`);
        retryable = isTimeoutResponse(result.errors);
      } catch (error) {
        if (isAbortError(error)) throw error;
        failure = error;
        retryable = isRetryableError(error);
      }
      if (!retryable || pageSize <= DISCOVERY_MIN_PAGE_SIZE) throw failure;
      pageSize = Math.max(DISCOVERY_MIN_PAGE_SIZE, Math.floor(pageSize / 2));
      this.logger.warn(`Repository list: GitHub did not answer in time. Trying again with ${pageSize} repositories per request.`);
    }
  }

  /** Organizations of the first page, plus further pages. A failed further page only shortens the list. */
  private async collectOrganizations(
    first: Connection<LoginNode> | null | undefined,
    run: RefreshRun,
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const logins = new Map<string, string>();
    const addAll = (connection: Connection<LoginNode> | null | undefined) => {
      for (const node of asArray(connection?.nodes)) {
        const login = isRecord(node) ? node.login : undefined;
        if (typeof login === 'string' && login !== '' && !logins.has(login.toLowerCase())) {
          logins.set(login.toLowerCase(), login);
        }
      }
    };
    addAll(first);
    const usedCursors = new Set<string>();
    let connection = first;
    for (let page = 0; page < MAX_ORGANIZATION_PAGES; page++) {
      const cursor = nextCursor(connection?.pageInfo, usedCursors);
      if (cursor === undefined) break;
      try {
        const result = await this.request<OrganizationsData>(run, ORGANIZATIONS_QUERY, { cursor }, signal);
        for (const error of result.errors ?? []) run.errors.push({ error, data: result.data });
        connection = result.data?.viewer?.organizations;
        addAll(connection);
      } catch (error) {
        if (isAbortError(error)) throw error;
        this.logger.warn(`Repository list: further organizations could not be read: ${errorText(error)}`);
        break;
      }
    }
    return [...logins.values()];
  }

  /**
   * GitHub does not always name the organization in a SAML error, and the repository node of the error is `null`.
   * Then one repository of each organization is read, and the errors of this request name the organization through
   * their path. A failure here does not fail the discovery.
   */
  // Assumption (V-5): an organization that requires SAML single sign-on or restricts OAuth apps answers the query of
  // `organizationAccessQuery` with an error whose path starts with the alias of the organization.
  private async probeOrganizations(
    candidates: string[],
    hints: HintCollector,
    run: RefreshRun,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (let start = 0; start < candidates.length; start += PROBE_CHUNK_SIZE) {
      const chunk = candidates.slice(start, start + PROBE_CHUNK_SIZE);
      const variables: Record<string, unknown> = {};
      chunk.forEach((login, index) => {
        variables[`o${index}`] = login;
      });
      try {
        const result = await this.request<Record<string, unknown>>(run, organizationAccessQuery(chunk.length), variables, signal);
        for (const error of result.errors ?? []) {
          const alias = error.path?.[0];
          const match = typeof alias === 'string' ? /^o(\d+)$/.exec(alias) : null;
          const organization = match ? chunk[Number(match[1])] : undefined;
          hints.add(error, result.data, organization);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        this.logger.warn(`Repository list: the access to the organizations could not be checked: ${errorText(error)}`);
        return;
      }
    }
  }

  private logErrors(errors: CollectedError[]): void {
    if (errors.length === 0) return;
    this.logger.warn(
      `Repository list: GitHub returned ${errors.length} errors: ${describeGraphQLErrors(errors.map((entry) => entry.error))}`,
    );
  }
}

/** Filters by the settings `owners` (case-insensitive; an empty list shows all), `includeArchived`, and `includeForks`. */
export function filterRepositories(
  repositories: RepositoryInfo[],
  settings: Pick<ExtensionSettings, 'owners' | 'includeArchived' | 'includeForks'>,
): RepositoryInfo[] {
  const owners = new Set(
    (settings.owners ?? [])
      .filter((owner): owner is string => typeof owner === 'string')
      .map((owner) => owner.trim().toLowerCase())
      .filter((owner) => owner !== ''),
  );
  return repositories.filter(
    (repository) =>
      (owners.size === 0 || owners.has(repository.owner.toLowerCase())) &&
      (settings.includeArchived || !repository.isArchived) &&
      (settings.includeForks || !repository.isFork),
  );
}

/**
 * Security (concept section 9): the owner is the signed-in user or an organization where the user is a member.
 * Without discovery data, no owner is trusted. The data belongs to `data.viewerLogin`: after a change of the GitHub
 * account, a refresh is needed first.
 */
export function isTrustedOwner(data: DiscoveryData | undefined, owner: string): boolean {
  if (!data) return false;
  const wanted = owner.trim().toLowerCase();
  if (wanted === '') return false;
  if (data.viewerLogin.toLowerCase() === wanted) return true;
  return data.organizations.some((organization) => organization.toLowerCase() === wanted);
}

// ---------------------------------------------------------------------------------------------------------------------
// Organization hints

const HINT_PRIORITY: Record<OrganizationHintKind, number> = { saml: 3, oauthRestricted: 2, other: 1, notFound: 0 };
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MESSAGE_ORGANIZATION_PATTERNS = [
  // "… the `acme` organization has enabled OAuth App access restrictions …"
  /\bthe `([^`\s]+)` organization\b/i,
  /\borganization `([^`\s]+)`/i,
  /github\.com\/orgs\/([A-Za-z0-9-]+)/i,
];
const OAUTH_RESTRICTION_PATTERN =
  /OAuth App access restrictions|restricting-access-to-your-organization|third-party (?:application|access) restrictions/i;
const TIMEOUT_PATTERN = /timeout|timed out|in time|something went wrong/i;

/** Kind of an error that hides the repositories of an organization. `undefined` for other errors. */
export function classifyGraphQLError(error: GraphQLError): OrganizationHintKind | undefined {
  if (/\bSAML\b/i.test(error.message) || error.extensions?.saml_failure === true) return 'saml';
  if (OAUTH_RESTRICTION_PATTERN.test(error.message)) return 'oauthRestricted';
  if (error.type === 'FORBIDDEN') return 'other';
  return undefined;
}

/** URL where the user can authorize the access for this organization. */
export function hintUrl(kind: OrganizationHintKind, organization: string): string {
  const login = encodeURIComponent(organization);
  switch (kind) {
    case 'saml':
      return `https://github.com/orgs/${login}/sso`;
    case 'oauthRestricted':
      return OAUTH_APP_CONNECTIONS_URL;
    case 'other':
    case 'notFound':
      return `https://github.com/${login}`;
  }
}

/** The organization that the message or an extension of the error names. */
export function organizationFromMessage(error: GraphQLError): string | undefined {
  const texts = [error.message];
  for (const value of Object.values(error.extensions ?? {})) {
    if (typeof value === 'string') texts.push(value);
  }
  for (const text of texts) {
    for (const pattern of MESSAGE_ORGANIZATION_PATTERNS) {
      const login = pattern.exec(text)?.[1];
      if (login && LOGIN_PATTERN.test(login)) return login;
    }
  }
  return undefined;
}

/**
 * The organization of the list element that the path of the error points into: the owner of a repository node, or the
 * login of an organization node. `undefined` if the element is `null`.
 */
export function organizationFromPath(error: GraphQLError, data: unknown): string | undefined {
  const path = error.path;
  if (!path || path.length === 0) return undefined;
  const elements: Array<{ value: Record<string, unknown>; list: string | number | undefined }> = [];
  let current: unknown = data;
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (typeof part === 'number') {
      current = Array.isArray(current) ? current[part] : undefined;
      // Path of a list element: [..., '<list field>', 'nodes', <index>].
      if (isRecord(current)) elements.push({ value: current, list: path[i - 2] });
    } else {
      current = isRecord(current) ? current[part] : undefined;
    }
    if (current === undefined || current === null) break;
  }
  for (const { value, list } of elements.reverse()) {
    const owner = value.owner;
    if (isRecord(owner) && typeof owner.login === 'string' && LOGIN_PATTERN.test(owner.login)) return owner.login;
    if (typeof value.nameWithOwner === 'string') {
      const login = value.nameWithOwner.split('/')[0];
      if (LOGIN_PATTERN.test(login)) return login;
    }
    if (list === 'organizations' && typeof value.login === 'string' && LOGIN_PATTERN.test(value.login)) return value.login;
  }
  return undefined;
}

/** Collects one hint per organization (case-insensitive). A SAML hint wins over an OAuth hint, which wins over others. */
class HintCollector {
  private readonly hints = new Map<string, OrganizationHint>();
  /** SAML and OAuth errors whose organization is not known yet. */
  unattributed = 0;

  constructor(private readonly viewerLogin: string) {}

  add(error: GraphQLError, data: unknown, knownOrganization?: string): void {
    const kind = classifyGraphQLError(error);
    if (!kind) return;
    let organization = organizationFromMessage(error);
    // A FORBIDDEN error without a known reason counts only when the message names the organization.
    if (!organization && kind !== 'other') organization = knownOrganization ?? organizationFromPath(error, data);
    if (!organization || organization.toLowerCase() === this.viewerLogin.toLowerCase()) {
      if (kind !== 'other' && !organization) this.unattributed++;
      return;
    }
    const key = organization.toLowerCase();
    const existing = this.hints.get(key);
    if (existing && HINT_PRIORITY[existing.kind] >= HINT_PRIORITY[kind]) return;
    const name = existing?.organization ?? organization;
    this.hints.set(key, { organization: name, kind, url: hintUrl(kind, name) });
  }

  /** An owner of the scan scope that GitHub did not return. A hint of another kind for it wins. */
  addNotFound(owner: string): void {
    const key = owner.toLowerCase();
    if (key === '' || this.hints.has(key)) return;
    this.hints.set(key, { organization: owner, kind: 'notFound', url: hintUrl('notFound', owner) });
  }

  has(organization: string): boolean {
    return this.hints.has(organization.toLowerCase());
  }

  list(): OrganizationHint[] {
    return [...this.hints.values()];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The cursor of the next page, or `undefined` at the end. A cursor that was used before also ends the pagination, so a
 * cycle of cursors cannot cause many requests. `used` collects the returned cursors.
 */
function nextCursor(pageInfo: PageInfo | null | undefined, used: Set<string>): string | undefined {
  if (!isRecord(pageInfo) || pageInfo.hasNextPage !== true) return undefined;
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== 'string' || cursor === '' || used.has(cursor)) return undefined;
  used.add(cursor);
  return cursor;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof GitHubTimeoutError) return true;
  return error instanceof GitHubApiError && (error.status === 502 || error.status === 503 || error.status === 504);
}

/** The kinds of GraphQL errors, without their messages (which can name a repository), for example `RATE_LIMITED, timeout`. */
function graphQLErrorKinds(errors: GraphQLError[] | undefined): string {
  const kinds = new Set((errors ?? []).map((error) => error.type ?? (TIMEOUT_PATTERN.test(error.message) ? 'timeout' : 'error')));
  return kinds.size > 0 ? [...kinds].join(', ') : 'no details';
}

/** GitHub answers a query that takes too long with an error "Something went wrong … This may be the result of a timeout". */
function isTimeoutResponse(errors: GraphQLError[] | undefined): boolean {
  if (!errors || errors.length === 0) return false;
  if (errors.some((error) => error.type === 'RATE_LIMITED')) return false;
  return errors.some((error) => TIMEOUT_PATTERN.test(error.message));
}

/** Throws when the list belongs to another account than `accountId` (a sign-in changed the session meanwhile). */
function checkAccount(databaseId: number | null | undefined, accountId: string): void {
  if (typeof databaseId === 'number' && String(databaseId) !== accountId) {
    throw new Error('The GitHub session changed while the repository list was loaded.');
  }
}

/**
 * The repository connection of a page of an owner of the scan scope, `MISSING_OWNER` when GitHub does not return the
 * owner (unknown login, or no access), or `undefined` when the page failed.
 */
function readOwnerPage(
  owner: { repositories?: Connection<RepositoryNode> | null } | null | undefined,
  data: unknown,
  errors: GraphQLError[] | undefined,
): Connection<RepositoryNode> | typeof MISSING_OWNER | undefined {
  if (isRecord(owner) && isRecord(owner.repositories)) return owner.repositories;
  const notReturned = owner === null || (isRecord(owner) && owner.repositories === null);
  const expected = (errors ?? []).every((error) => error.type === 'NOT_FOUND' || classifyGraphQLError(error) !== undefined);
  return data !== undefined && notReturned && expected ? MISSING_OWNER : undefined;
}

/** A repository of a scan. */
interface CollectedRepository {
  info: RepositoryInfo;
  /** The detection is certain and is kept for the next refresh. */
  checked: boolean;
  /** Its configurations must still be read (incremental detection). */
  lookup: boolean;
}

/**
 * Collects the repositories of a scan in the order of the pages, each repository once. The first load marks every
 * repository for a lookup; a refresh with a stored list takes the configurations of an unchanged repository from the
 * stored detection, and marks the others for a lookup.
 */
class RepositoryCollector {
  private readonly entries: CollectedRepository[] = [];
  private readonly seen = new Set<string>();
  /** Repository nodes that GitHub returned, with and without configuration. */
  scanned = 0;

  constructor(readonly detections: Detections) {}

  /**
   * Adds the repositories of a page. Returns the new ones whose configurations must be read: all on the first load, else
   * the new and changed ones, and those that an error of the page points into.
   */
  addPage(nodes: ReadonlyArray<RepositoryNode | null>, errors: readonly GraphQLError[]): CollectedRepository[] {
    const uncertain = nodesWithErrors(errors);
    const lookups: CollectedRepository[] = [];
    nodes.forEach((node, index) => {
      this.scanned++;
      if (!isRecord(node)) return;
      const info = toRepositoryInfo(node);
      if (!info) return;
      const stored = this.detections?.get(info.nameWithOwner.toLowerCase());
      const entry: CollectedRepository =
        stored && !uncertain.has(index) && !needsConfigurationLookup(info, stored)
          ? { info: { ...info, configPaths: [...stored.configPaths] }, checked: true, lookup: false }
          : { info, checked: false, lookup: true };
      if (this.add(entry) && entry.lookup) lookups.push(entry);
    });
    return lookups;
  }

  addAll(other: RepositoryCollector): void {
    this.scanned += other.scanned;
    for (const entry of other.entries) this.add(entry);
  }

  repositories(): RepositoryInfo[] {
    return this.entries.filter((entry) => entry.info.configPaths.length > 0).map((entry) => entry.info);
  }

  /** The repositories with a configuration whose detection is not certain: a later refresh reads them again. */
  uncertain(): string[] {
    return this.entries.filter((entry) => !entry.checked && entry.info.configPaths.length > 0).map((entry) => entry.info.nameWithOwner);
  }

  withoutConfiguration(): CheckedRepository[] {
    return this.entries
      .filter((entry) => entry.checked && entry.info.configPaths.length === 0)
      .map((entry) => checkedRepository(entry.info));
  }

  /** False for a repository that was added before. */
  private add(entry: CollectedRepository): boolean {
    // The order by last push can move a repository to another page while the pages load.
    const key = entry.info.nameWithOwner.toLowerCase();
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.entries.push(entry);
    return true;
  }
}

/**
 * The configuration lookups of a refresh (concept 7.4): a batch starts as soon as LOOKUP_BATCH_SIZE repositories are
 * listed, while the list still loads; `finish` starts the rest and waits for all batches.
 */
class LookupQueue {
  private buffer: CollectedRepository[] = [];
  private readonly running: Array<Promise<void>> = [];
  /** Repositories handed to a lookup. */
  count = 0;

  constructor(private readonly start: (batch: CollectedRepository[]) => Promise<void>) {}

  add(entries: readonly CollectedRepository[]): void {
    this.buffer.push(...entries);
    this.count += entries.length;
    while (this.buffer.length >= LOOKUP_BATCH_SIZE) this.launch(this.buffer.splice(0, LOOKUP_BATCH_SIZE));
  }

  async finish(): Promise<void> {
    if (this.buffer.length > 0) this.launch(this.buffer.splice(0));
    await Promise.all(this.running);
  }

  private launch(batch: CollectedRepository[]): void {
    const promise = this.start(batch);
    // The failure reaches the refresh through `finish` (and the abort of the run); no unhandled rejection meanwhile.
    promise.catch(() => undefined);
    this.running.push(promise);
  }
}

function isGitHubUrl(url: string): boolean {
  return url.startsWith('https://github.com/');
}

function toRepositoryInfo(node: RepositoryNode): RepositoryInfo | undefined {
  const nameWithOwner = node.nameWithOwner;
  if (typeof nameWithOwner !== 'string') return undefined;
  const slash = nameWithOwner.indexOf('/');
  if (slash <= 0 || slash === nameWithOwner.length - 1 || nameWithOwner.indexOf('/', slash + 1) >= 0) return undefined;
  const ownerLogin = isRecord(node.owner) ? node.owner.login : undefined;
  const defaultBranch = isRecord(node.defaultBranchRef) ? node.defaultBranchRef.name : undefined;
  return {
    nameWithOwner,
    owner: typeof ownerLogin === 'string' && ownerLogin !== '' ? ownerLogin : nameWithOwner.slice(0, slash),
    name: typeof node.name === 'string' && node.name !== '' ? node.name : nameWithOwner.slice(slash + 1),
    url: typeof node.url === 'string' && isGitHubUrl(node.url) ? node.url : `https://github.com/${nameWithOwner}`,
    isArchived: node.isArchived === true,
    isFork: node.isFork === true,
    isPrivate: node.isPrivate === true,
    ...(typeof node.viewerPermission === 'string' && node.viewerPermission !== ''
      ? { viewerPermission: node.viewerPermission }
      : {}),
    pushedAt: typeof node.pushedAt === 'string' ? node.pushedAt : null,
    defaultBranch: typeof defaultBranch === 'string' && defaultBranch !== '' ? defaultBranch : null,
    configPaths: detectConfigurations(node),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Stored file

const HINT_KINDS: readonly OrganizationHintKind[] = ['saml', 'oauthRestricted', 'other', 'notFound'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRepositoryInfo(value: unknown): value is RepositoryInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.nameWithOwner === 'string' &&
    typeof value.owner === 'string' &&
    typeof value.name === 'string' &&
    typeof value.url === 'string' &&
    isGitHubUrl(value.url) &&
    typeof value.isArchived === 'boolean' &&
    typeof value.isFork === 'boolean' &&
    typeof value.isPrivate === 'boolean' &&
    // Lists of older versions have no permission.
    (value.viewerPermission === undefined || typeof value.viewerPermission === 'string') &&
    (value.pushedAt === null || typeof value.pushedAt === 'string') &&
    (value.defaultBranch === null || typeof value.defaultBranch === 'string') &&
    isStringArray(value.configPaths) &&
    value.configPaths.length > 0
  );
}

function isOrganizationHint(value: unknown): value is OrganizationHint {
  return (
    isRecord(value) &&
    typeof value.organization === 'string' &&
    typeof value.kind === 'string' &&
    (HINT_KINDS as readonly string[]).includes(value.kind) &&
    typeof value.url === 'string' &&
    isGitHubUrl(value.url)
  );
}

/** Checks the content of repositories-<account ID>.json. Invalid entries are dropped; an invalid file gives `undefined`. */
export function parseDiscoveryData(value: unknown): DiscoveryData | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.fetchedAt !== 'string' || typeof value.viewerLogin !== 'string') return undefined;
  if (!Array.isArray(value.organizations) || !Array.isArray(value.repositories)) return undefined;
  return {
    version: 1,
    fetchedAt: value.fetchedAt,
    viewerLogin: value.viewerLogin,
    organizations: value.organizations.filter((item): item is string => typeof item === 'string'),
    repositories: value.repositories.filter(isRepositoryInfo),
    hints: Array.isArray(value.hints) ? value.hints.filter(isOrganizationHint) : [],
    // Lists of older versions have no scope: they were built from all repositories.
    ...(isStringArray(value.scope) ? { scope: normalizeScope(value.scope) } : {}),
    ...(Array.isArray(value.withoutConfiguration)
      ? { withoutConfiguration: value.withoutConfiguration.filter(isCheckedRepository).map(checkedRepository) }
      : {}),
    ...(isStringArray(value.uncertain) ? { uncertain: [...value.uncertain] } : {}),
  };
}

function isCheckedRepository(value: unknown): value is CheckedRepository {
  return (
    isRecord(value) &&
    typeof value.nameWithOwner === 'string' &&
    value.nameWithOwner.includes('/') &&
    (value.pushedAt === null || typeof value.pushedAt === 'string') &&
    (value.defaultBranch === null || typeof value.defaultBranch === 'string')
  );
}
