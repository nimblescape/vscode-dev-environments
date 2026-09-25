// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Data of the sidebar (concept 6.2, 7.4): the repository list of the discovery, the environments of the registry, and
// their states. Docker is asked only on request (view visible, after an operation), never in the background, so that
// Docker Desktop's Resource Saver can work; the 15-second heartbeat only reads the coordination files.
// Accounts (concept 7.5): the view shows the list and the environments of the signed-in GitHub account only; without a
// sign-in, it shows nothing but the sign-in.
import * as vscode from 'vscode';
import type { ContainerAdapter } from '../core/docker/containerAdapter';
import type { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApiError } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage } from '../core/errors';
import { Actions } from '../core/messages';
import { availableEnvironments, type EnvironmentClaims } from '../core/ownership';
import { systemClock, type Clock, type Logger } from '../core/ports';
import type { EnvironmentService } from '../core/pipeline/environmentService';
import type { EnvironmentRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type { DiscoveryData, Environment, ExtensionSettings, GitHubAccount, RepositoryInfo, WindowStatus } from '../core/types';
import { isProcessAlive } from '../monitor/lock';
import { SIGN_IN_AGAIN_DETAIL, type VsCodeGitHubAuth } from './auth';
import type { SessionCoordinator } from './sessionCoordinator';
import { dockerStoppedRuntime, environmentIdsOf, liveBusyEnvironmentIds } from './sidebarData';
import { CoalescingTask, mapLimit } from './tasks';
import { findRepositoryInfo, ownerTrust, pickerRepositories, repositoriesToLookUp, repositoryKey } from './targets';
import { buildTreeModel, type EnvironmentRuntime, type OwnerGroup } from './treeModel';
import { REPOSITORIES_VIEW_ID, type RepositoriesTreeProvider } from './treeView';

/** Context key of the welcome views (package.json): a list was loaded, or the first refresh failed. */
export const LOADED_CONTEXT_KEY = 'devEnvironments.loaded';
/**
 * Context key of the welcome views (package.json): the last refresh failed and no list is stored, so the view is empty
 * because the list could not be loaded, not because no repository has a configuration.
 */
export const LOAD_FAILED_CONTEXT_KEY = 'devEnvironments.loadFailed';
/** Branches of running containers are read with at most this many `docker exec` calls at a time. */
const BRANCH_READ_CONCURRENCY = 4;

export interface SidebarDeps {
  logger: Logger;
  registry: EnvironmentRegistry;
  sessionFiles: SessionFiles;
  coordinator: SessionCoordinator;
  service: EnvironmentService;
  docker: ContainerAdapter;
  discovery: DiscoveryService;
  auth: VsCodeGitHubAuth;
  /** Claims of environments of an older version, after each successful refresh (concept 7.5). */
  claims: EnvironmentClaims;
  tree: RepositoriesTreeProvider;
  settings: () => ExtensionSettings;
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
}

export class Sidebar implements vscode.Disposable {
  private readonly clock: Clock;
  private readonly isAlive: (pid: number) => boolean;
  private data: DiscoveryData | undefined;
  /** The signed-in account whose list and environments the view shows. */
  private account: GitHubAccount | undefined;
  private signedIn = false;
  private loaded = false;
  private loadFailed = false;
  /** `undefined`: Docker was not asked yet, or its answer was not usable. */
  private runtime: ReadonlyMap<string, EnvironmentRuntime> | undefined;
  private liveBranches: ReadonlyMap<string, string> = new Map();
  private lookups: ReadonlyMap<string, RepositoryInfo | null> = new Map();
  private timer: NodeJS.Timeout | undefined;
  private signInOffered = false;
  /** Counts the account changes of onSessionChanged: a refresh that read an older session does not use it. */
  private accountChanges = 0;
  private disposed = false;
  private readonly renderTask = new CoalescingTask(() => this.renderNow());
  private readonly statesTask = new CoalescingTask(() => this.refreshStatesNow());
  private readonly discoveryTask = new CoalescingTask(() => this.refreshDiscoveryNow());
  private readonly statesEmitter = new vscode.EventEmitter<void>();

  /** Fires after the container states and the branches of running containers were read. */
  readonly onDidRefreshStates: vscode.Event<void> = this.statesEmitter.event;

  constructor(private readonly deps: SidebarDeps) {
    this.clock = deps.clock ?? systemClock;
    this.isAlive = deps.isAlive ?? isProcessAlive;
  }

  /** Stored or fresh discovery data. */
  get discoveryData(): DiscoveryData | undefined {
    return this.data;
  }

  get isSignedIn(): boolean {
    return this.signedIn;
  }

  /** The account whose list and environments the view shows; `undefined` without a sign-in. */
  get currentAccount(): GitHubAccount | undefined {
    return this.account;
  }

  /** The current model of the view (for the switcher). */
  model(): readonly OwnerGroup[] {
    return this.deps.tree.getModel();
  }

  /**
   * Concept 6.1 step 3: shows the stored list at once, then updates it in the background when the user is signed in.
   * Never throws.
   */
  async initialize(): Promise<void> {
    const [account, signedIn] = await Promise.all([
      this.readAccount(),
      this.deps.auth.updateContextKey().catch((error: unknown) => {
        this.deps.logger.warn(`The sign-in state could not be read: ${errorMessage(error)}`);
        return false;
      }),
    ]);
    if (this.disposed) return;
    this.signedIn = signedIn && account !== undefined;
    if (this.account?.id !== account?.id || this.data === undefined) await this.useAccount(account);
    if (this.disposed) return;
    await this.render().catch((error: unknown) => this.deps.logger.error('The sidebar could not be shown.', error));
    this.restartTimer();
    if (this.signedIn) void this.refreshDiscovery();
  }

  /** Builds the view from the registry, the coordination files, and the last known states. No Docker call. */
  render(): Promise<void> {
    return this.renderTask.request();
  }

  /**
   * Reads the container and volume states from Docker (without starting it) and the branches of the running containers,
   * then renders. Call only when the view is visible or after an operation.
   */
  refreshStates(): Promise<void> {
    return this.statesTask.request();
  }

  /**
   * Updates the repository list from GitHub (concept 7.4), one refresh at a time: `again` starts one more refresh after a
   * running one (for example after an account change); otherwise a running refresh is reused. Never rejects: a failed
   * refresh keeps the stored list. Resolves with the current data.
   */
  refreshDiscovery(options: { again?: boolean } = {}): Promise<DiscoveryData | undefined> {
    const task = options.again ? this.discoveryTask.request() : this.discoveryTask.join();
    return task.catch((error: unknown) => {
      this.deps.logger.error('The repository list could not be updated.', error);
      return this.data;
    });
  }

  /**
   * The setting `owners` (the scan scope, concept 7.4) changed: a list of another scope is not shown anymore, because it
   * may contain repositories outside the new scope, and a refresh with the new scope starts at once. Never rejects.
   */
  async onScopeChanged(): Promise<void> {
    if (this.data && !this.isOfCurrentScope(this.data)) {
      this.data = undefined;
      this.lookups = new Map();
      this.setLoaded(false);
      this.setLoadFailed(false);
    }
    this.renderInBackground();
    if (this.signedIn) await this.refreshDiscovery({ again: true });
  }

  /**
   * Sign-in, sign-out, or account change: new state, then a new list. `again` (default true) starts one more refresh
   * after a running one, because the account may have changed; `again: false` reuses a running refresh.
   * Never rejects.
   */
  async onSessionChanged(options: { again?: boolean } = {}): Promise<void> {
    const account = await this.readAccount();
    // Another account: its own stored list at once, never the list of the previous one (concept 6.2).
    if (account?.id !== this.account?.id) {
      this.accountChanges++;
      await this.useAccount(account);
    }
    this.setSignedIn(account !== undefined && (await this.authSignedIn()));
    this.renderInBackground();
    if (this.signedIn) await this.refreshDiscovery({ again: options.again ?? true });
  }

  /** Starts the background refresh again with the interval of the settings. */
  restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    const minutes = this.deps.settings().refreshIntervalMinutes;
    this.timer = setInterval(() => void this.refreshDiscovery(), minutes * 60_000);
  }

  /** GitHub data of a repository: from the discovery, or from a single lookup. */
  repositoryInfo(repository: string): RepositoryInfo | undefined {
    return findRepositoryInfo(repository, this.data, this.lookups);
  }

  /** Branch read from the running container at the last state refresh. */
  liveBranch(environmentId: string): string | undefined {
    return this.liveBranches.get(environmentId);
  }

  /** The environments of the signed-in account, in the order of the registry (concept 7.5). */
  async availableEnvironments(): Promise<Environment[]> {
    return availableEnvironments(await this.deps.registry.list(), this.account);
  }

  /**
   * Repositories for Search and the switcher: the list of the view plus the repository of every environment of the
   * signed-in account.
   */
  async repositoriesForPicker(): Promise<RepositoryInfo[]> {
    const environments = await this.availableEnvironments();
    return pickerRepositories({
      data: this.signedIn ? this.data : undefined,
      settings: this.deps.settings(),
      environments,
      lookups: this.lookups,
    });
  }

  /**
   * Security (concept section 9): the owner is the signed-in account or one of its organizations. The list belongs to
   * the account that loaded it; after an account change (or without a list), the owner counts as trusted only after a
   * refresh with the current account.
   */
  async trustedOwner(owner: string): Promise<boolean> {
    const account = (await this.readAccount())?.login;
    let trust = ownerTrust(this.data, account, owner);
    if (trust === 'unknown' && account !== undefined) {
      await this.refreshDiscovery();
      trust = ownerTrust(this.data, account, owner);
    }
    return trust === 'trusted';
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.statesEmitter.dispose();
  }

  private renderInBackground(): void {
    this.render().catch((error: unknown) => this.deps.logger.error('The sidebar could not be updated.', error));
  }

  private async renderNow(): Promise<void> {
    if (this.disposed) return;
    const { registry, sessionFiles, coordinator } = this.deps;
    const [entries, statuses, others] = await Promise.all([
      registry.list(),
      sessionFiles.readWindowStatuses().catch((error: unknown): WindowStatus[] | undefined => {
        this.deps.logger.warn(`The window status files could not be read: ${errorMessage(error)}`);
        return undefined;
      }),
      coordinator.otherActiveWindows().catch((): WindowStatus[] => []),
    ]);
    if (this.disposed) return;
    const account = this.account;
    // Only the environments of the signed-in account; hidden ones are not counted or named anywhere (concept 7.5).
    const environments = availableEnvironments(entries, account);
    const groups = buildTreeModel({
      discovery: this.data,
      settings: this.deps.settings(),
      environments,
      runtime: this.runtime,
      currentEnvironmentId: coordinator.environmentId,
      otherWindowEnvironmentIds: environmentIdsOf(others),
      busyEnvironmentIds: liveBusyEnvironmentIds(environments, {
        now: this.clock.now(),
        isAlive: this.isAlive,
        windowStatuses: statuses,
      }),
      liveBranches: this.liveBranches,
      signedIn: this.signedIn,
      repositoryLookups: this.lookups,
      formatTime,
    });
    this.deps.tree.setModel(groups, { signedIn: this.signedIn });
  }

  private async refreshStatesNow(): Promise<void> {
    if (this.disposed) return;
    const { service, docker, registry } = this.deps;
    let runtime: ReadonlyMap<string, EnvironmentRuntime> | undefined = await service.inspectStates();
    if (!runtime) {
      // inspectStates gives `undefined` both when Docker does not run and when Docker failed. Only the first means
      // "nothing runs" (a connection that was lost must not keep showing Connected).
      const running = docker.isInstalled() && (await docker.isRunning());
      if (!running) runtime = dockerStoppedRuntime(await registry.list());
    }
    this.runtime = runtime;

    const available = new Set((await this.availableEnvironments()).map((environment) => environment.id));
    const runningIds = runtime
      ? [...runtime].filter(([id, state]) => state.container === 'running' && available.has(id)).map(([id]) => id)
      : [];
    const branches = new Map<string, string>();
    await mapLimit(runningIds, BRANCH_READ_CONCURRENCY, async (id) => {
      const branch = await service.currentBranch(id).catch(() => undefined);
      if (branch) branches.set(id, branch);
    });
    this.liveBranches = branches;
    await this.render();
    if (!this.disposed) this.statesEmitter.fire();
  }

  private async refreshDiscoveryNow(): Promise<DiscoveryData | undefined> {
    if (this.disposed) return this.data;
    // Token and account of one session: the list is stored for the account, and the claims give entries to it.
    const changes = this.accountChanges;
    const session = await this.readSession();
    // The account changed while the session was read: the refresh of that change uses the new session.
    if (changes !== this.accountChanges) return this.data;
    const token = session?.token;
    const account = session?.account;
    if (account?.id !== this.account?.id) await this.useAccount(account);
    // A session whose token GitHub rejected does not count as signed in (auth.ts): no refresh, which would fail again,
    // until Sign in with GitHub replaces the token.
    this.setSignedIn(account !== undefined && (await this.authSignedIn()));
    if (token === undefined || account === undefined || !this.signedIn) {
      this.renderInBackground();
      return this.data;
    }
    try {
      const data = await vscode.window.withProgress({ location: { viewId: REPOSITORIES_VIEW_ID } }, () =>
        this.deps.discovery.refresh(token, account.id),
      );
      // The account changed while the list loaded: the list is not shown (the next refresh loads the new one).
      if (this.account?.id !== account.id) return this.data;
      // The scope changed while the list loaded: the refresh that the change requested loads the list of the new scope.
      if (!this.isOfCurrentScope(data)) return this.data;
      this.data = data;
      this.setLoadFailed(false);
      // Concept 7.5: environments of an older version become available when this account can access the repository.
      await this.deps.claims.claim(account, token);
      this.lookups = await this.lookUpUnlisted(data, token);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 401) this.offerSignInAgain();
      // Concept 7.4: without internet access, the view shows the stored list and skips the update. Without a stored
      // list, the view says that the list could not be loaded (not that no repository was found).
      const shown = this.data ? 'The stored list is shown.' : 'No stored list exists.';
      this.deps.logger.warn(`The repository list could not be updated. ${shown} ${errorMessage(error)}`);
      this.setLoadFailed(this.data === undefined);
    }
    this.setLoaded();
    this.renderInBackground();
    return this.data;
  }

  /**
   * The discovery stores only repositories with a configuration on the default branch. The repositories of the other
   * environments are asked one by one, so the view shows `not on GitHub` only for repositories that GitHub does not
   * return. A failed question leaves the repository unknown.
   */
  private async lookUpUnlisted(data: DiscoveryData, token: string): Promise<Map<string, RepositoryInfo | null>> {
    const result = new Map<string, RepositoryInfo | null>();
    const environments = await this.availableEnvironments();
    // Concept 7.4: GitHub is not asked about repositories outside the scan scope; their rows get no `not on GitHub`.
    for (const repository of repositoriesToLookUp(environments, data.repositories, this.deps.settings().owners)) {
      if (this.disposed) break;
      try {
        const info = await this.deps.discovery.getRepository(repository, token);
        result.set(repositoryKey(repository), info ?? null);
      } catch (error) {
        this.deps.logger.info(`GitHub could not be asked for ${repository}: ${errorMessage(error)}`);
      }
    }
    return result;
  }

  /** GitHub rejected the token (HTTP 401): offer a new sign-in, once per window. */
  private offerSignInAgain(): void {
    if (this.signInOffered) return;
    this.signInOffered = true;
    vscode.window
      .showWarningMessage(SIGN_IN_AGAIN_DETAIL, Actions.signIn)
      .then(async (choice) => {
        if (choice !== Actions.signIn) return;
        const token = await this.deps.auth.renewToken();
        if (token) await this.refreshDiscovery({ again: true });
      })
      .then(undefined, (error: unknown) => this.deps.logger.error('The new GitHub sign-in failed.', error));
  }

  /** The sign-in state of auth.ts, which alone sets the context key `devEnvironments.signedIn`. */
  private setSignedIn(signedIn: boolean): void {
    this.signedIn = signedIn;
  }

  private async authSignedIn(): Promise<boolean> {
    try {
      return await this.deps.auth.isSignedIn();
    } catch (error) {
      this.deps.logger.warn(`The sign-in state could not be read: ${errorMessage(error)}`);
      return false;
    }
  }

  private setLoaded(loaded = true): void {
    if (this.loaded === loaded) return;
    this.loaded = loaded;
    setContext(LOADED_CONTEXT_KEY, loaded, this.deps.logger);
  }

  /**
   * Shows the list of `account`: its stored list at once (or none, until the refresh), and no single lookups of the
   * previous account. Without an account, no list.
   */
  private async useAccount(account: GitHubAccount | undefined): Promise<void> {
    this.account = account;
    this.data = undefined;
    this.lookups = new Map();
    this.setLoadFailed(false);
    if (!account) return;
    const stored = await this.deps.discovery.loadStored(account.id).catch((error: unknown) => {
      this.deps.logger.warn(`The stored repository list could not be read: ${errorMessage(error)}`);
      return undefined;
    });
    // Another change of the account meanwhile wins.
    if (this.account?.id !== account.id) return;
    // A list of another scan scope may contain repositories outside the current one: the view waits for the refresh.
    if (stored && !this.isOfCurrentScope(stored)) {
      this.deps.logger.info('The stored repository list was loaded for other organizations. It is loaded again.');
      return;
    }
    this.data = stored;
    this.setLoaded(stored !== undefined);
  }

  /** Token and account of the GitHub session, without a dialog; undefined when it cannot be read. */
  private async readSession(): Promise<{ token: string; account: GitHubAccount } | undefined> {
    try {
      return await this.deps.auth.getSession({ interactive: false });
    } catch (error) {
      this.deps.logger.warn(`The GitHub session could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** True if the list was built with the scan scope of the current settings (a list without scope: all repositories). */
  private isOfCurrentScope(data: DiscoveryData): boolean {
    return sameScope(data.scope, this.deps.settings().owners);
  }

  /** The account of the GitHub session, without a dialog. */
  private async readAccount(): Promise<GitHubAccount | undefined> {
    try {
      return await this.deps.auth.getAccount({ interactive: false });
    } catch (error) {
      this.deps.logger.warn(`The GitHub account could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private setLoadFailed(loadFailed: boolean): void {
    if (this.loadFailed === loadFailed) return;
    this.loadFailed = loadFailed;
    setContext(LOAD_FAILED_CONTEXT_KEY, loadFailed, this.deps.logger);
  }
}

function setContext(key: string, value: boolean, logger: Logger): void {
  vscode.commands.executeCommand('setContext', key, value).then(undefined, (error: unknown) => {
    logger.warn(`Could not set the context key ${key}: ${errorMessage(error)}`);
  });
}

/** Time of the last use in the tooltip, in the language of VS Code. */
function formatTime(isoTime: string): string {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return isoTime;
  try {
    return date.toLocaleString(vscode.env.language);
  } catch {
    return date.toLocaleString();
  }
}
