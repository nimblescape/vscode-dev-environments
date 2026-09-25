// Discovery Service (concept 7.4): finds the repositories with a Dev Container configuration through the GitHub
// GraphQL API and stores the result in repositories-<account ID>.json, one file per GitHub account (concept 6.2). Security
// (concept section 9): the token is only passed on to the GitHubApi; the stored file contains metadata only.
import { readJson, writeJsonAtomic } from '../storage/atomicJson';
import type { GitHubViewer } from '../helper/containerGit';
import { splitRepository } from '../names';
import { isAbortError, isoTime, silentLogger, systemClock, type Clock, type Logger } from '../ports';
import type { DiscoveryData, ExtensionSettings, OrganizationHint, OrganizationHintKind, RepositoryInfo } from '../types';
import { detectConfigurations, type ConfigurationNode } from './detect';
import {
  describeGraphQLErrors,
  GitHubApiError,
  GitHubTimeoutError,
  type GitHubApi,
  type GraphQLError,
} from './githubApi';

/** Repositories per request (concept 7.4). */
export const DISCOVERY_PAGE_SIZE = 50;
/** Smallest page size when GitHub does not answer a page in time. */
export const DISCOVERY_MIN_PAGE_SIZE = 10;
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

/**
 * The discovery query of concept 7.4 with `owner { login }` and `isPrivate`. The first page also reads the login of
 * the user and the organizations where the user is a member (`$withOrganizations`).
 * Variables: `cursor` (String, null for the first page), `pageSize` (Int, normally 50), `withOrganizations` (Boolean).
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
        ...RepositoryFields
      }
    }
  }
}
${REPOSITORY_FIELDS_FRAGMENT}
${CONFIGURATION_FOLDER_FRAGMENT}`;

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
}

export class DiscoveryService {
  constructor(
    private readonly api: GitHubApi,
    /** The file of the stored list of an account (StoragePaths.repositoriesFile). */
    private readonly fileOf: (accountId: string) => string,
    private readonly logger: Logger = silentLogger,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * The stored result of the last discovery of the account `accountId`. `undefined` if there is none or if the file is
   * not valid. The list of another account is never read.
   */
  async loadStored(accountId: string): Promise<DiscoveryData | undefined> {
    return parseDiscoveryData(await readJson<unknown>(this.fileOf(accountId)));
  }

  /**
   * Full discovery for the account `accountId` with its token: all pages with up to 50 repositories each, in the order of
   * the API (last push first). Keeps only repositories with at least one configuration. Errors for organizations with
   * SAML single sign-on or OAuth app access restrictions become one hint per organization. Partial data with errors is
   * used. Stores the result atomically in the file of the account and returns it. Throws on a network failure, an HTTP
   * error, when GitHub does not return the list, or when the token belongs to another account (a sign-in changed the
   * session meanwhile); the stored file then stays unchanged.
   */
  async refresh(token: string, accountId: string, signal?: AbortSignal): Promise<DiscoveryData> {
    const repositories: RepositoryInfo[] = [];
    const seen = new Set<string>();
    const errors: CollectedError[] = [];
    let viewerLogin = '';
    let organizationsConnection: Connection<LoginNode> | null | undefined;
    let cursor: string | null = null;
    const usedCursors = new Set<string>();
    let pageSize = DISCOVERY_PAGE_SIZE;
    let scanned = 0;
    let pages = 0;

    for (;;) {
      if (pages >= MAX_PAGES) {
        this.logger.warn(`Repository list: stopped after ${pages} pages.`);
        break;
      }
      const page = await this.fetchRepositoryPage(cursor, pages === 0, pageSize, token, signal);
      pages++;
      pageSize = page.pageSize;
      if (pages === 1) {
        viewerLogin = page.viewer.login;
        organizationsConnection = page.viewer.organizations;
        const viewerId = page.viewer.databaseId;
        if (typeof viewerId === 'number' && String(viewerId) !== accountId) {
          throw new Error('The GitHub session changed while the repository list was loaded.');
        }
      }
      for (const error of page.errors) errors.push({ error, data: page.data });

      const connection = page.viewer.repositories;
      for (const node of asArray(connection.nodes)) {
        scanned++;
        if (!isRecord(node)) continue;
        const info = toRepositoryInfo(node);
        if (!info) continue;
        // The order by last push can move a repository to another page while the pages load.
        const key = info.nameWithOwner.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (info.configPaths.length > 0) repositories.push(info);
      }

      const next = nextCursor(connection.pageInfo, usedCursors);
      if (next === undefined) break;
      cursor = next;
    }

    const organizations = await this.collectOrganizations(organizationsConnection, errors, token, signal);
    const hints = new HintCollector(viewerLogin);
    for (const { error, data } of errors) hints.add(error, data);
    if (hints.unattributed > 0) {
      await this.probeOrganizations(
        organizations.filter((organization) => !hints.has(organization)),
        hints,
        token,
        signal,
      );
    }
    this.logErrors(errors);

    const result: DiscoveryData = {
      version: 1,
      fetchedAt: isoTime(this.clock),
      viewerLogin,
      organizations,
      repositories,
      hints: hints.list(),
    };
    this.logger.info(
      `Repository list: ${repositories.length} of ${scanned} repositories have a Dev Container configuration` +
        (result.hints.length > 0 ? `, ${result.hints.length} organizations need an authorization.` : '.'),
    );
    try {
      await writeJsonAtomic(this.fileOf(accountId), result);
    } catch (error) {
      // The list is still valid for this session; the next refresh stores it again.
      this.logger.error('Repository list: the list could not be stored.', error);
    }
    return result;
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

  private async fetchRepositoryPage(
    cursor: string | null,
    withOrganizations: boolean,
    initialPageSize: number,
    token: string,
    signal: AbortSignal | undefined,
  ): Promise<{ viewer: PageViewer; errors: GraphQLError[]; data: unknown; pageSize: number }> {
    let pageSize = initialPageSize;
    for (;;) {
      let failure: unknown;
      let retryable: boolean;
      try {
        const result = await this.api.graphql<DiscoverData>(
          DISCOVERY_QUERY,
          { cursor, pageSize, withOrganizations },
          token,
          signal,
        );
        const viewer = result.data?.viewer;
        if (isPageViewer(viewer)) {
          return {
            viewer,
            errors: result.errors ?? [],
            data: result.data,
            pageSize,
          };
        }
        failure = new Error(`GitHub did not return the repository list: ${describeGraphQLErrors(result.errors)}`);
        retryable = isTimeoutResponse(result.errors);
      } catch (error) {
        if (isAbortError(error)) throw error;
        failure = error;
        retryable = isRetryableError(error);
      }
      // GitHub stops a query that takes too long. A smaller page needs less time.
      // Assumption (V-5): 50 repositories with the configuration lookups fit into the time limit of GitHub in most cases.
      if (!retryable || pageSize <= DISCOVERY_MIN_PAGE_SIZE) throw failure;
      pageSize = Math.max(DISCOVERY_MIN_PAGE_SIZE, Math.floor(pageSize / 2));
      this.logger.warn(`Repository list: GitHub did not answer in time. Trying again with ${pageSize} repositories per request.`);
    }
  }

  /** Organizations of the first page, plus further pages. A failed further page only shortens the list. */
  private async collectOrganizations(
    first: Connection<LoginNode> | null | undefined,
    errors: CollectedError[],
    token: string,
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
        const result = await this.api.graphql<OrganizationsData>(ORGANIZATIONS_QUERY, { cursor }, token, signal);
        for (const error of result.errors ?? []) errors.push({ error, data: result.data });
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
    token: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (let start = 0; start < candidates.length; start += PROBE_CHUNK_SIZE) {
      const chunk = candidates.slice(start, start + PROBE_CHUNK_SIZE);
      const variables: Record<string, unknown> = {};
      chunk.forEach((login, index) => {
        variables[`o${index}`] = login;
      });
      try {
        const result = await this.api.graphql<Record<string, unknown>>(
          organizationAccessQuery(chunk.length),
          variables,
          token,
          signal,
        );
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

const HINT_PRIORITY: Record<OrganizationHintKind, number> = { saml: 3, oauthRestricted: 2, other: 1 };
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

const HINT_KINDS: readonly OrganizationHintKind[] = ['saml', 'oauthRestricted', 'other'];

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
  };
}
