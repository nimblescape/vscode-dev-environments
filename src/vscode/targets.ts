// Targets of the commands and the choices of their Quick Picks (concept 6.2, 6.4). No `vscode` import, so the rules are
// unit-tested.
import { filterRepositories, isTrustedOwner } from '../core/discovery/discoveryService';
import { configurationName } from '../core/names';
import type { RepositoryTarget } from '../core/pipeline/environmentService';
import type { DiscoveryData, Environment, ExtensionSettings, RepositoryInfo } from '../core/types';
import { ControllerTexts } from './controllerTexts';

/** Key of a repository in maps and in the operation gate: lower-case `owner/name` (GitHub names ignore case). */
export function repositoryKey(repository: string): string {
  return repository.toLowerCase();
}

/**
 * The argument of a command:
 * - a row of the sidebar (`RepositoryRow`, from the menus of the view),
 * - `{ environmentId }` (the status bar item "Reconnect", concept 6.3),
 * - nothing (Command Palette, keyboard shortcut): the command asks with a Quick Pick.
 */
export type CommandArgument =
  | { kind: 'row'; repository: string; info?: RepositoryInfo; environmentId?: string }
  | { kind: 'environment'; environmentId: string }
  | { kind: 'none' };

export function parseCommandArgument(argument: unknown): CommandArgument {
  if (!isRecord(argument)) return { kind: 'none' };
  if (argument.kind === 'repository' && typeof argument.repository === 'string' && argument.repository.includes('/')) {
    const info = isRepositoryInfo(argument.info) ? argument.info : undefined;
    const environment = isRecord(argument.environment) ? argument.environment : undefined;
    const environmentId = typeof environment?.id === 'string' && environment.id !== '' ? environment.id : undefined;
    return { kind: 'row', repository: argument.repository, info, environmentId };
  }
  if (argument.kind === undefined && typeof argument.environmentId === 'string' && argument.environmentId !== '') {
    return { kind: 'environment', environmentId: argument.environmentId };
  }
  return { kind: 'none' };
}

/** Target of the open pipeline for a repository (first open, concept 7.6). */
export function repositoryTarget(repository: string, info: RepositoryInfo | undefined, trusted: boolean): RepositoryTarget {
  return {
    repository: info?.nameWithOwner ?? repository,
    defaultBranch: info?.defaultBranch ?? null,
    configPaths: info ? [...info.configPaths] : [],
    trusted,
  };
}

/**
 * Trust of an owner for a first open (concept section 9). The discovery data belongs to `data.viewerLogin`: after a
 * change of the GitHub account it says nothing about the new account until a refresh finished (`unknown`).
 */
export function ownerTrust(
  data: DiscoveryData | undefined,
  accountLogin: string | undefined,
  owner: string,
): 'trusted' | 'untrusted' | 'unknown' {
  if (!data || !accountLogin || data.viewerLogin.toLowerCase() !== accountLogin.toLowerCase()) return 'unknown';
  return isTrustedOwner(data, owner) ? 'trusted' : 'untrusted';
}

/** A repository that only the registry knows, for the pickers. It has no URL of its own and no configurations. */
export function placeholderRepositoryInfo(repository: string): RepositoryInfo {
  const index = repository.indexOf('/');
  const owner = index > 0 ? repository.slice(0, index) : repository;
  const name = index > 0 ? repository.slice(index + 1) : repository;
  return {
    nameWithOwner: repository,
    owner,
    name,
    url: gitHubUrl(repository),
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: null,
    defaultBranch: null,
    configPaths: [],
  };
}

/** `https://github.com/owner/name`. */
export function gitHubUrl(repository: string): string {
  return `https://github.com/${repository.split('/').map(encodeURIComponent).join('/')}`;
}

/** The discovery data or a single lookup (`null`: GitHub does not list it) of a repository. */
export function findRepositoryInfo(
  repository: string,
  data: DiscoveryData | undefined,
  lookups: ReadonlyMap<string, RepositoryInfo | null>,
): RepositoryInfo | undefined {
  const key = repositoryKey(repository);
  return data?.repositories.find((info) => repositoryKey(info.nameWithOwner) === key) ?? lookups.get(key) ?? undefined;
}

/**
 * Repositories of the pickers (Search, "Open repository…" of the switcher): the discovered repositories that the
 * settings show, plus the repository of every environment (like the sidebar, concept 6.2), with the GitHub data when it
 * is known.
 */
export function pickerRepositories(input: {
  data: DiscoveryData | undefined;
  settings: Pick<ExtensionSettings, 'owners' | 'includeArchived' | 'includeForks'>;
  environments: readonly Environment[];
  lookups: ReadonlyMap<string, RepositoryInfo | null>;
}): RepositoryInfo[] {
  const result: RepositoryInfo[] = [];
  const seen = new Set<string>();
  const add = (info: RepositoryInfo): void => {
    const key = repositoryKey(info.nameWithOwner);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(info);
  };
  for (const info of filterRepositories(input.data?.repositories ?? [], input.settings)) add(info);
  for (const environment of input.environments) {
    add(findRepositoryInfo(environment.repository, input.data, input.lookups) ?? placeholderRepositoryInfo(environment.repository));
  }
  return result;
}

/**
 * Repositories of environments that the discovery does not list (it stores only repositories with a configuration on
 * the default branch): they are looked up one by one after a refresh, so that the sidebar does not show `not on GitHub`
 * for a repository that exists. Each repository once, in the order of the registry.
 */
export function repositoriesToLookUp(environments: readonly Environment[], listed: readonly RepositoryInfo[]): string[] {
  const known = new Set(listed.map((info) => repositoryKey(info.nameWithOwner)));
  const result: string[] = [];
  for (const environment of environments) {
    const key = repositoryKey(environment.repository);
    if (known.has(key)) continue;
    known.add(key);
    result.push(environment.repository);
  }
  return result;
}

export interface ConfigurationChoice {
  configPath: string;
  /** Concept 6.2: the name of the configuration, for example `python` or `default`. */
  label: string;
  description: string;
  current: boolean;
}

/** Choices of "Select configuration…" (concept 6.2): name as label, path as description; the current one is marked. */
export function configurationChoices(configPaths: readonly string[], current: string | undefined): ConfigurationChoice[] {
  const unique = [...new Set(configPaths)];
  return unique.map((configPath) => {
    const isCurrent = configPath === current;
    return {
      configPath,
      label: configurationName(configPath),
      description: isCurrent ? `${configPath} · ${ControllerTexts.current}` : configPath,
      current: isCurrent,
    };
  });
}

export interface BranchChoice {
  branch: string;
  description: string;
}

/**
 * Choices of "Switch branch…" (concept 6.2): the branches of GitHub (default branch first), the current branch marked
 * (and added when GitHub does not list it, for example a local branch), and a typed name that is not listed first.
 */
export function branchChoices(
  branches: readonly string[],
  options: { current?: string; defaultBranch?: string; typed?: string } = {},
): BranchChoice[] {
  const names = [...new Set(branches.filter((branch) => branch !== ''))];
  if (options.current && !names.includes(options.current)) names.unshift(options.current);
  const choices = names.map((branch) => ({
    branch,
    description: [
      branch === options.current ? ControllerTexts.current : '',
      branch === options.defaultBranch ? ControllerTexts.defaultBranch : '',
    ]
      .filter((text) => text !== '')
      .join(' · '),
  }));
  const typed = options.typed?.trim();
  if (typed && !names.includes(typed) && isPlausibleBranchName(typed)) {
    choices.unshift({ branch: typed, description: ControllerTexts.typedBranch });
  }
  return choices;
}

/**
 * A loose form of `git check-ref-format --branch`: rejects names that Git certainly refuses, and names that look like an
 * option. Git checks the rest (its message is shown, concept 7.5).
 */
export function isPlausibleBranchName(name: string): boolean {
  if (name === '' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.endsWith('.lock') || name.includes('..') || name.includes('//') || name.includes('@{') || name === '@') return false;
  // Control characters, space, and ~ ^ : ? * [ \ are not allowed in Git reference names.
  return !/[\u0000- \u007f~^:?*[\\]/.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepositoryInfo(value: unknown): value is RepositoryInfo {
  return (
    isRecord(value) &&
    typeof value.nameWithOwner === 'string' &&
    typeof value.url === 'string' &&
    Array.isArray(value.configPaths)
  );
}
