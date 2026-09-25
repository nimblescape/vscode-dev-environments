// Pure model of the sidebar (concept 6.2): one list of repositories, grouped by owner. This module never imports
// `vscode`, so the rules for rows, states, actions, and sorting are unit-tested; treeView.ts only maps the model to
// tree items.
import { filterRepositories } from '../core/discovery/discoveryService';
import { formatChanges, Messages, StateTexts } from '../core/messages';
import { configurationName } from '../core/names';
import type {
  BusyOperation,
  ContainerState,
  DiscoveryData,
  Environment,
  EnvironmentState,
  ExtensionSettings,
  RepositoryInfo,
} from '../core/types';

// User-visible texts that messages.ts lacks; to be moved there.
export const TreeTexts = {
  branch: (branch: string) => `Branch: ${branch}`,
  defaultBranch: (branch: string) => `Default branch: ${branch}`,
  configuration: (name: string) => `Configuration: ${name}`,
  lastUsed: (time: string) => `Last used: ${time}`,
  noEnvironment: 'No environment yet. Start creates it on the default branch.',
  /** A repository with an environment of another GitHub account (concept 7.5, D-3). */
  otherAccountEnvironment: 'Environment of another account',
  otherAccountEnvironmentTooltip:
    'This computer has an environment of this repository for another GitHub account. It keeps one environment per repository, so the signed-in account cannot make its own. Sign in with that account to use it.',
  notListedOnGitHub: 'GitHub does not list this repository.',
  archived: 'Archived repository',
  /** Label of the sign-in row (the title of the command devEnvironments.signIn). */
  signIn: 'Sign in with GitHub',
  signInTooltip: 'Sign in with GitHub to see your repositories that have a Dev Container configuration.',
} as const;

/** Container and volume state of one environment, as Docker reports it. */
export interface EnvironmentRuntime {
  container: ContainerState;
  volume: boolean;
}

export interface TreeInput {
  /** Stored or fresh result of the discovery. `undefined` while no list is loaded. */
  discovery: DiscoveryData | undefined;
  settings: Pick<ExtensionSettings, 'owners' | 'includeArchived' | 'includeForks'>;
  /**
   * The entries of the Environment Registry that the signed-in account may use (concept 7.5, `availableEnvironments`).
   * Environments of another account are never passed, so no row, name, or count reveals them.
   */
  environments: readonly Environment[];
  /**
   * Lower-case `owner/name` of the repositories that have an environment of another GitHub account. D-3 allows one
   * environment per repository on this computer, so their rows offer no Start (concept 7.5). Only repositories that the
   * list of the signed-in account names get such a row; the others stay hidden.
   */
  lockedRepositories?: ReadonlySet<string>;
  /** Container and volume state per environment ID. `undefined`: Docker is not running or not asked yet. */
  runtime: ReadonlyMap<string, EnvironmentRuntime> | undefined;
  /** Environment of this window. */
  currentEnvironmentId: string | null;
  /** Environments of other live windows. */
  otherWindowEnvironmentIds: ReadonlySet<string>;
  /** Environments with a busy mark whose owner process is alive. */
  busyEnvironmentIds: ReadonlySet<string>;
  /** Environment ID → branch read from the running container. */
  liveBranches: ReadonlyMap<string, string>;
  signedIn: boolean;
  /**
   * Results of single repository lookups on GitHub (`DiscoveryService.getRepository`) for environments whose repository
   * the discovery does not list (it stores only repositories with a configuration on the default branch). Key: lower-case
   * `owner/name`. A `RepositoryInfo`: GitHub has the repository (no `not on GitHub`, Show on GitHub). `null`: GitHub
   * does not return it (not found, or no access), so the row shows `not on GitHub`.
   * When the map is given, an environment whose repository is neither in the discovery nor in the map is unknown (for
   * example the lookup failed) and shows no `not on GitHub`. Without the map, every environment that the discovery does
   * not list shows `not on GitHub`.
   */
  repositoryLookups?: ReadonlyMap<string, RepositoryInfo | null>;
  /** Formats the time of the last use for the tooltip. Default: the local date and time format. */
  formatTime?: (isoTime: string) => string;
}

/** Actions that a row offers (concept 6.2). The flags of `contextValue` are made from these. */
export interface RowActions {
  canStart: boolean;
  canStop: boolean;
  canDelete: boolean;
  canRebuild: boolean;
  /** The repository has more than one configuration: Select configuration… */
  multiConfig: boolean;
  /** The discovery lists the repository: Show on GitHub. */
  onGitHub: boolean;
}

export interface RepositoryRow {
  kind: 'repository';
  /** Stable tree item ID: `repo:` + lower-case owner/name. */
  id: string;
  /** `owner/name`, with the case that GitHub uses when the discovery lists it. */
  repository: string;
  owner: string;
  name: string;
  /** From the discovery. */
  info?: RepositoryInfo;
  environment?: Environment;
  /** `undefined`: the repository has no environment (no symbol). */
  state?: EnvironmentState;
  /** Branch shown in the row, if known. */
  branch?: string;
  /** Configuration name shown in brackets; only when the repository has more than one configuration. */
  configurationName?: string;
  /** The row has an environment, and GitHub does not list its repository. */
  notOnGitHub: boolean;
  actions: RowActions;
  /** Repository name. */
  label: string;
  /** For example `main (python)   Stopped · 3 unpushed`, `main   Connected`, or `` for a repository without environment. */
  description: string;
  /** Includes the time of the last use. */
  tooltip: string;
  /** `repository;canStart;canStop;canDelete;canRebuild;multiConfig;onGitHub`, only the flags that apply (package.json menus). */
  contextValue: string;
}

/** Organization whose repositories GitHub did not return (concept 7.4). The row opens `url` (action Authorize). */
export interface HintRow {
  kind: 'hint';
  /** `hint:` + lower-case organization. */
  id: string;
  organization: string;
  /** `Messages.organizationNotAuthorized(organization)`. */
  label: string;
  url: string;
}

/**
 * Row at the top of the view when the user is not signed in but the view lists environments: the welcome view with its
 * sign-in button only shows while the view is empty.
 */
export interface SignInRow {
  kind: 'signIn';
  id: typeof SIGN_IN_ROW_ID;
  label: string;
  tooltip: string;
}

export const SIGN_IN_ROW_ID = 'signIn';

export interface OwnerGroup {
  kind: 'owner';
  /** `owner:` + lower-case owner. */
  id: string;
  owner: string;
  /** Hints first, then the repositories with an environment, then the other repositories. */
  children: Array<RepositoryRow | HintRow>;
}

/** Icon of a state (concept 6.2), as a codicon ID and an optional theme color ID. */
export interface StateIcon {
  id: string;
  color?: string;
}

const STATE_ICONS: Record<EnvironmentState, StateIcon> = {
  connected: { id: 'circle-filled', color: 'charts.green' },
  connectedOtherWindow: { id: 'circle-filled', color: 'charts.green' },
  running: { id: 'color-mode' },
  stopped: { id: 'circle-outline' },
  updating: { id: 'sync~spin' },
  // A dashed circle (◌) is not available as a codicon.
  noContainer: { id: 'circle-large-outline' },
  filesMissing: { id: 'warning', color: 'list.warningForeground' },
};

/** Icon of a state: ● connected, ◐ running, ○ stopped, ↻ updating, ◌ no container, ⚠ files missing. */
export function stateIcon(state: EnvironmentState): StateIcon {
  return STATE_ICONS[state];
}

/** State text of concept 6.2, for example `Connected · other window`. */
export function stateText(state: EnvironmentState): string {
  return StateTexts[state];
}

type StateInput = Pick<TreeInput, 'runtime' | 'currentEnvironmentId' | 'otherWindowEnvironmentIds' | 'busyEnvironmentIds'>;

/**
 * State of an environment (concept 6.2, 7.15). Precedence: busy → updating; volume known to be missing → files
 * missing; this window → connected; another window → connected · other window; then the container state
 * (running, stopped, no container). Without runtime data (Docker not running or not asked yet) the registry decides:
 * connected when a window references the environment, otherwise stopped.
 * A window counts as connected only while the container may run: when Docker reports the container stopped or
 * missing, the connection is lost, and the row shows the container state (so Start can reconnect).
 */
export function environmentState(environment: Environment, input: StateInput): EnvironmentState {
  if (input.busyEnvironmentIds.has(environment.id)) return 'updating';
  const runtime = input.runtime?.get(environment.id);
  if (runtime && !runtime.volume) return 'filesMissing';
  const containerMayRun = runtime === undefined || runtime.container === 'running';
  if (containerMayRun && input.currentEnvironmentId === environment.id) return 'connected';
  if (containerMayRun && input.otherWindowEnvironmentIds.has(environment.id)) return 'connectedOtherWindow';
  if (!runtime) return 'stopped';
  switch (runtime.container) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'missing':
      return 'noContainer';
  }
}

/** True for the states in which the container runs. */
export function containerRuns(state: EnvironmentState | undefined): boolean {
  return state === 'connected' || state === 'connectedOtherWindow' || state === 'running';
}

/**
 * Actions of a row (concept 6.2). `state` is `undefined` for a repository without environment. `busyOperation` is the
 * operation of the live busy mark while the state is `updating`.
 * Delete is possible in every state (concept 7.15); during an operation of another window it runs after that operation,
 * and it is hidden only while the environment is being deleted. Start, Stop, and Rebuild are hidden while the
 * environment is updating: a busy environment is in use and must not be stopped or changed (concept 7.9 rule 1).
 */
export function rowActions(
  state: EnvironmentState | undefined,
  info: RepositoryInfo | undefined,
  busyOperation?: BusyOperation,
): RowActions {
  const hasEnvironment = state !== undefined;
  return {
    canStart: state !== 'connected' && state !== 'updating',
    canStop: containerRuns(state),
    canDelete: hasEnvironment && !(state === 'updating' && busyOperation === 'delete'),
    canRebuild: hasEnvironment && state !== 'updating',
    multiConfig: (info?.configPaths.length ?? 0) > 1,
    onGitHub: info !== undefined,
  };
}

/** `contextValue` of a repository row; the `when` clauses in package.json match these flags. */
export function contextValue(actions: RowActions): string {
  const flags = ['repository'];
  if (actions.canStart) flags.push('canStart');
  if (actions.canStop) flags.push('canStop');
  if (actions.canDelete) flags.push('canDelete');
  if (actions.canRebuild) flags.push('canRebuild');
  if (actions.multiConfig) flags.push('multiConfig');
  if (actions.onGitHub) flags.push('onGitHub');
  return flags.join(';');
}

/**
 * The sidebar model (concept 6.2): the repositories of the discovery (filtered by the settings) plus every repository
 * that has an environment. Environments are always listed, also when the settings filter their repository out, when
 * GitHub does not list the repository (`not on GitHub`), and when the user is not signed in, because they hold the
 * user's work. Without a sign-in, only the environments are listed.
 * Groups are sorted by owner; in each group, hints come first, then the repositories with an environment, then the
 * other repositories, each part in alphabetical order.
 */
export function buildTreeModel(input: TreeInput): OwnerGroup[] {
  const discovered = input.discovery?.repositories ?? [];
  const infoByKey = new Map<string, RepositoryInfo>();
  for (const info of discovered) {
    const key = info.nameWithOwner.toLowerCase();
    if (!infoByKey.has(key)) infoByKey.set(key, info);
  }

  interface GroupParts {
    group: OwnerGroup;
    hints: HintRow[];
    environments: RepositoryRow[];
    others: RepositoryRow[];
  }
  const groups = new Map<string, GroupParts>();
  const groupFor = (owner: string) => {
    const key = owner.toLowerCase();
    let entry = groups.get(key);
    if (!entry) {
      entry = { group: { kind: 'owner', id: `owner:${key}`, owner, children: [] }, hints: [], environments: [], others: [] };
      groups.set(key, entry);
    }
    return entry;
  };

  // Most recently used first, so that the plain row ID goes to that environment if the registry ever holds two
  // environments of one repository (tree item IDs must be unique).
  const environments = [...input.environments].sort((a, b) => timeValue(b.lastUsedAt) - timeValue(a.lastUsedAt));
  const usedIds = new Set<string>();
  const repositoriesWithEnvironment = new Set<string>();
  for (const environment of environments) {
    const key = environment.repository.toLowerCase();
    const lookup = input.repositoryLookups?.get(key);
    const info = infoByKey.get(key) ?? lookup ?? undefined;
    const confirmedMissing = input.repositoryLookups === undefined || lookup === null;
    const baseId = `repo:${key}`;
    const id = usedIds.has(baseId) ? `${baseId}#${environment.id}` : baseId;
    usedIds.add(id);
    repositoriesWithEnvironment.add(key);
    const row = environmentRow(id, environment, info, confirmedMissing, input);
    groupFor(row.owner).environments.push(row);
  }

  if (input.signedIn && input.discovery) {
    for (const info of filterRepositories(discovered, input.settings)) {
      const key = info.nameWithOwner.toLowerCase();
      if (repositoriesWithEnvironment.has(key)) continue;
      const id = `repo:${key}`;
      if (usedIds.has(id)) continue;
      usedIds.add(id);
      const row = repositoryRow(id, info, input.lockedRepositories?.has(key) === true);
      groupFor(row.owner).others.push(row);
    }

    const owners = ownerFilter(input.settings.owners);
    const hintIds = new Set<string>();
    for (const hint of input.discovery.hints) {
      const key = hint.organization.toLowerCase();
      if (key === '' || (owners.size > 0 && !owners.has(key))) continue;
      const id = `hint:${key}`;
      if (hintIds.has(id)) continue;
      hintIds.add(id);
      groupFor(hint.organization).hints.push({
        kind: 'hint',
        id,
        organization: hint.organization,
        label: Messages.organizationNotAuthorized(hint.organization),
        url: hint.url,
      });
    }
  }

  const byName = (a: RepositoryRow, b: RepositoryRow) => compareNames(a.name, b.name) || compareNames(a.id, b.id);
  return [...groups.values()]
    .sort((a, b) => compareNames(a.group.owner, b.group.owner))
    .map(({ group, hints, environments: withEnvironment, others }) => {
      hints.sort((a, b) => compareNames(a.organization, b.organization));
      withEnvironment.sort(byName);
      others.sort(byName);
      group.children = [...hints, ...withEnvironment, ...others];
      return group;
    });
}

/**
 * Top-level nodes of the view: the groups, and the sign-in row first when the user is not signed in and the view is not
 * empty (an empty view shows the welcome view with its sign-in button instead).
 */
export function rootNodes(groups: readonly OwnerGroup[], signedIn: boolean): Array<SignInRow | OwnerGroup> {
  if (signedIn || groups.length === 0) return [...groups];
  const signIn: SignInRow = { kind: 'signIn', id: SIGN_IN_ROW_ID, label: TreeTexts.signIn, tooltip: TreeTexts.signInTooltip };
  return [signIn, ...groups];
}

/** All repository rows of the model, in display order. */
export function repositoryRows(groups: readonly OwnerGroup[]): RepositoryRow[] {
  const rows: RepositoryRow[] = [];
  for (const group of groups) {
    for (const child of group.children) {
      if (child.kind === 'repository') rows.push(child);
    }
  }
  return rows;
}

/** The row of an environment. */
export function findRowByEnvironmentId(groups: readonly OwnerGroup[], environmentId: string): RepositoryRow | undefined {
  return repositoryRows(groups).find((row) => row.environment?.id === environmentId);
}

/** The row of a repository (`owner/name`, case-insensitive). */
export function findRowByRepository(groups: readonly OwnerGroup[], repository: string): RepositoryRow | undefined {
  const key = repository.toLowerCase();
  return repositoryRows(groups).find((row) => row.repository.toLowerCase() === key);
}

/** One environment in the switcher (concept 6.4). */
export interface RecentEnvironment {
  environmentId: string;
  repository: string;
  /** `undefined` if the model has no row for the environment. */
  state?: EnvironmentState;
  /** The description of the sidebar row: branch, configuration, state, and changes. */
  description: string;
}

/** Environments for the switcher, most recently used first, with the state and description of their sidebar row. */
export function recentEnvironments(groups: readonly OwnerGroup[], environments: readonly Environment[]): RecentEnvironment[] {
  const rowsById = new Map<string, RepositoryRow>();
  for (const row of repositoryRows(groups)) {
    if (row.environment) rowsById.set(row.environment.id, row);
  }
  return [...environments]
    .sort(
      (a, b) =>
        timeValue(b.lastUsedAt) - timeValue(a.lastUsedAt) ||
        compareNames(a.repository, b.repository) ||
        compareNames(a.id, b.id),
    )
    .map((environment) => {
      const row = rowsById.get(environment.id);
      return {
        environmentId: environment.id,
        repository: row?.repository ?? environment.repository,
        state: row?.state,
        description: row?.description ?? '',
      };
    });
}

/** Repositories for the repository picker: most recently pushed first, then by name. */
export function repositoriesForPicker(repositories: readonly RepositoryInfo[]): RepositoryInfo[] {
  return [...repositories].sort(
    (a, b) =>
      timeValue(b.pushedAt ?? undefined) - timeValue(a.pushedAt ?? undefined) ||
      compareNames(a.nameWithOwner, b.nameWithOwner),
  );
}

function environmentRow(
  id: string,
  environment: Environment,
  info: RepositoryInfo | undefined,
  confirmedMissing: boolean,
  input: TreeInput,
): RepositoryRow {
  const repository = info?.nameWithOwner ?? environment.repository;
  const { owner, name } = info ? { owner: info.owner, name: info.name } : splitName(repository);
  const state = environmentState(environment, input);
  const actions = rowActions(state, info, state === 'updating' ? environment.busy?.operation : undefined);
  const liveBranch = containerRuns(state) || state === 'updating' ? input.liveBranches.get(environment.id) : undefined;
  const branch = nonEmpty(liveBranch) ?? nonEmpty(environment.gitSummary?.branch ?? undefined);
  const configuration = actions.multiConfig ? configurationName(environment.configPath) : undefined;
  const notOnGitHub = input.signedIn && input.discovery !== undefined && info === undefined && confirmedMissing;
  // The change counts are recorded at each stop (concept 7.5); while the container runs they are outdated, and with a
  // missing volume the changes are gone.
  const changes =
    (state === 'stopped' || state === 'noContainer') && environment.gitSummary ? formatChanges(environment.gitSummary) : '';

  const left = [branch, configuration !== undefined ? `(${configuration})` : undefined].filter(isText).join(' ');
  const right = [stateText(state), changes, notOnGitHub ? StateTexts.notOnGitHub : undefined].filter(isText).join(' · ');
  const description = [left, right].filter(isText).join('   ');

  const formatTime = input.formatTime ?? defaultFormatTime;
  const tooltip = [
    repository,
    [stateText(state), changes].filter(isText).join(' · '),
    branch !== undefined ? TreeTexts.branch(branch) : undefined,
    configuration !== undefined ? TreeTexts.configuration(configuration) : undefined,
    timeValue(environment.lastUsedAt) > 0 ? TreeTexts.lastUsed(formatTime(environment.lastUsedAt)) : undefined,
    notOnGitHub ? TreeTexts.notListedOnGitHub : undefined,
    info?.isArchived ? TreeTexts.archived : undefined,
  ]
    .filter(isText)
    .join('\n');

  return {
    kind: 'repository',
    id,
    repository,
    owner,
    name,
    info,
    environment,
    state,
    branch,
    configurationName: configuration,
    notOnGitHub,
    actions,
    label: name,
    description,
    tooltip,
    contextValue: contextValue(actions),
  };
}

/** The row of a repository without environment. `locked`: another account has its environment (no Start, D-3). */
function repositoryRow(id: string, info: RepositoryInfo, locked = false): RepositoryRow {
  const actions: RowActions = locked
    ? { ...rowActions(undefined, info), canStart: false, multiConfig: false }
    : rowActions(undefined, info);
  const tooltip = [
    info.nameWithOwner,
    locked ? TreeTexts.otherAccountEnvironmentTooltip : TreeTexts.noEnvironment,
    info.defaultBranch ? TreeTexts.defaultBranch(info.defaultBranch) : undefined,
    info.isArchived ? TreeTexts.archived : undefined,
  ]
    .filter(isText)
    .join('\n');
  return {
    kind: 'repository',
    id,
    repository: info.nameWithOwner,
    owner: info.owner,
    name: info.name,
    info,
    notOnGitHub: false,
    actions,
    label: info.name,
    description: locked ? TreeTexts.otherAccountEnvironment : '',
    tooltip,
    contextValue: contextValue(actions),
  };
}

function splitName(repository: string): { owner: string; name: string } {
  const index = repository.indexOf('/');
  if (index <= 0 || index === repository.length - 1) return { owner: repository, name: repository };
  return { owner: repository.slice(0, index), name: repository.slice(index + 1) };
}

function ownerFilter(owners: readonly unknown[] | undefined): Set<string> {
  return new Set(
    (owners ?? [])
      .filter((owner): owner is string => typeof owner === 'string')
      .map((owner) => owner.trim().toLowerCase())
      .filter((owner) => owner !== ''),
  );
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Case-insensitive, natural order (`repo2` before `repo10`); ties are broken by code points, so the order is stable. */
function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function timeValue(isoTime: string | undefined): number {
  const value = isoTime ? Date.parse(isoTime) : NaN;
  return Number.isNaN(value) ? 0 : value;
}

function defaultFormatTime(isoTime: string): string {
  const date = new Date(isoTime);
  return Number.isNaN(date.getTime()) ? isoTime : date.toLocaleString();
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function isText(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}
