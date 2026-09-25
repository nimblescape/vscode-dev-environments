// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Controller (concept 6, 7.9–7.14): the commands of package.json and the flows of the window roles at activation. It
// connects the UI components (sidebar, status bar, switcher, progress, messages) with the environment service, the
// Session Coordinator, and the Connection Adapter.
import * as vscode from 'vscode';
import { isBlockingBusyMark } from '../core/busy';
import type { ContainerAdapter } from '../core/docker/containerAdapter';
import type { DiscoveryService } from '../core/discovery/discoveryService';
import { UserFacingError, errorMessage, isUserFacingError } from '../core/errors';
import { CONFIG_FOLDER_OWNER_COMMAND, parseOwnerIds } from '../core/helper/containerGit';
import { Actions, Messages, formatChanges } from '../core/messages';
import { GITHUB_TOKEN_FILE, repositoryFolder, splitRepository } from '../core/names';
import { availableEnvironments, isAvailableTo, type ClaimMode, type EnvironmentClaims } from '../core/ownership';
import { isoTime, systemClock, type Clock, type ProgressReporter } from '../core/ports';
import { PipelineTexts, type EnvironmentService, type OpenResult } from '../core/pipeline/environmentService';
import { containerIsCurrent } from '../core/pipeline/pipelineRules';
import type { EnvironmentRegistry } from '../core/storage/registry';
import { pendingVolumesToRemove, type SessionFiles } from '../core/storage/sessionFiles';
import type {
  BusyMark,
  BusyOperation,
  Environment,
  ExtensionSettings,
  GitHubAccount,
  PendingConnection,
  PendingOperation,
  PendingOperationKind,
  RepositoryInfo,
  WindowStatus,
} from '../core/types';
import { isProcessAlive } from '../monitor/lock';
import { decideReopen, pipelineJustRan, sortPendingOperations } from './activationRules';
import type { VsCodeGitHubAuth } from './auth';
import { Commands, type CommandName } from './commands';
import type { ConnectionAdapter } from './connectionAdapter';
import { ControllerTexts } from './controllerTexts';
import {
  DISCONNECT_REQUEST_MAX_AGE_MS,
  isFreshDisconnectRequest,
  type DisconnectRequest,
  type DisconnectRequests,
} from './disconnectRequests';
import type { DockerSetup } from './dockerSetup';
import { showError as presentError } from './errors';
import type { OutputChannelLogger } from './logger';
import { selectOwners } from './ownerSelector';
import type { VsCodePipelineUi } from './pipelineUi';
import { runWithProgress, type BusyChange } from './progress';
import type { SessionCoordinator } from './sessionCoordinator';
import type { Sidebar } from './sidebar';
import type { EnvironmentStatusBar } from './statusBar';
import { pickRepository, showSwitcher } from './switcher';
import { CoalescingTask, OperationGate } from './tasks';
import {
  branchChoices,
  configurationChoices,
  parseCommandArgument,
  repositoryKey,
  repositoryTarget,
  type CommandArgument,
} from './targets';
import { TreeTexts, recentEnvironments, stateIcon } from './treeModel';

/**
 * After "Close Remote Connection", the window reloads and this extension host ends. If it still runs after this time,
 * the user kept the connection (for example Cancel in the dialog about unsaved files): the pending operation is removed.
 * Assumption (V-3): the extension host of the old window ends within this time when the window reloads.
 */
const HANDOFF_CHECK_MS = 30_000;
/**
 * A window that left an environment it must not use (concept 7.5, section 9) checks this long after "Close Remote
 * Connection" that its connection closed; a running extension host means that the user kept the connection.
 */
const LEAVE_CHECK_MS = 10_000;
/** `docker exec` that removes the token of the owner account from a container. */
const TOKEN_REMOVAL_TIMEOUT_MS = 10_000;
/**
 * The reopen rule (concept 7.10) looks at the other windows. Windows that VS Code restores at the same start write their
 * status files during their own activation; this pause lets them do so first.
 */
const REOPEN_CHECK_DELAY_MS = 3_000;
/** A Delete that waits for the operation of another window reads the registry this often (concept 7.15). */
const BUSY_POLL_MS = 1_000;

/** The busy mark that a hand-off sets (concept 7.14 step 1): a stop needs none, it does not change the container. */
const HAND_OFF_BUSY: Record<PendingOperationKind, BusyOperation | undefined> = {
  stop: undefined,
  rebuild: 'rebuild',
  delete: 'delete',
};

export interface ControllerDeps {
  logger: OutputChannelLogger;
  registry: EnvironmentRegistry;
  /** Concept 7.5: true when registry.json is missing or lost content (EnvironmentRegistry.needsRestore). */
  registryNeedsRestore: () => Promise<boolean>;
  sessionFiles: SessionFiles;
  /** Requests of other windows to close this window's connection first (concept 6.2 Stop, 7.14). */
  disconnectRequests: DisconnectRequests;
  docker: ContainerAdapter;
  service: EnvironmentService;
  discovery: DiscoveryService;
  auth: VsCodeGitHubAuth;
  /** Claims of environments of an older version (concept 7.5). */
  claims: EnvironmentClaims;
  ui: VsCodePipelineUi;
  connection: ConnectionAdapter;
  coordinator: SessionCoordinator;
  sidebar: Sidebar;
  statusBar: EnvironmentStatusBar;
  settings: () => ExtensionSettings;
  /** The Docker setup (concept 6.1 step 2): the walkthrough and its commands. */
  dockerSetup: Pick<DockerSetup, 'openWizard' | 'install' | 'start' | 'installWsl'>;
  /** True while the sidebar view is visible: only then Docker is asked outside of operations. */
  viewVisible: () => boolean;
  clock?: Clock;
  /** For tests. Default: `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  /** For tests: HANDOFF_CHECK_MS, LEAVE_CHECK_MS, REOPEN_CHECK_DELAY_MS, DISCONNECT_REQUEST_MAX_AGE_MS, and BUSY_POLL_MS. */
  timing?: {
    handOffCheckMs?: number;
    leaveCheckMs?: number;
    reopenCheckDelayMs?: number;
    disconnectAnswerMs?: number;
    busyPollMs?: number;
  };
}

/** What a command works on. */
interface Target {
  /** `owner/name` as the command received it. */
  repository: string;
  /** GitHub data, if known. */
  info?: RepositoryInfo;
  /**
   * The environment, read from the registry when the command started: the one that the command names (a row, the status
   * bar item, the switcher), or else the environment of the repository of the signed-in account (concept 7.5, D-3).
   */
  environment?: Environment;
  /**
   * The command names `environment` (a row, the status bar item, the switcher, a restored window). Otherwise the
   * environment belongs to the repository for the account that was signed in, and Try again looks it up again for the
   * account that is signed in then (D-3).
   */
  named?: boolean;
  /** The command asked whether the entry of an older version of the repository is assigned (the open does not ask again). */
  olderEnvironmentAsked?: boolean;
}

interface StartOptions {
  /** First open only: the branch to clone (Switch branch… without environment). */
  branch?: string;
  /** First open only: the configuration (Select configuration… without environment). */
  configPath?: string;
}

/** The environment that this window is attached to. A window changes its environment only by reloading. */
interface WindowEnvironment {
  environment: Environment;
  /** Container name from the folder URI of the window. */
  containerName: string;
  /** The container does not run: the status bar shows Reconnect (concept 6.3, 7.12). */
  lost: boolean;
  /** Branch read from the container. */
  branch?: string;
}

/**
 * An environment that this window left because it must not use it, while the window may still be attached to its
 * container: the environment of another account (or of nobody, after a sign-out), or a container of an older version.
 */
interface LeftEnvironment {
  environmentId: string;
  containerName: string;
  repository: string;
  reason: 'account' | 'outdated';
}

type HandOffRequest = Pick<PendingOperation, 'operation' | 'reason' | 'configPath' | 'additionalVolumesToRemove'>;

/** What a command without argument asks for: `open` is a repository that the command opens (Start). */
type PickKind = 'open' | 'repository' | 'environment' | 'gitHub';

interface BranchItem extends vscode.QuickPickItem {
  branch: string;
}

export class Controller implements vscode.Disposable {
  private readonly gate = new OperationGate();
  private readonly clock: Clock;
  private readonly isAlive: (pid: number) => boolean;
  private readonly timers = new Set<NodeJS.Timeout>();
  private current: WindowEnvironment | undefined;
  /** See `LeftEnvironment`; checked until the window has closed its connection (`checkLeftConnection`). */
  private left: LeftEnvironment | undefined;
  private checkingLeft = false;
  private ready: Promise<void> = Promise.resolve();
  private checkingConnection = false;
  private dockerChecked = false;
  /** Numbers the flows that connect this window (see `connect`). */
  private connectRequests = 0;
  /** The connecting flows that still run. */
  private readonly activeConnectRequests = new Set<number>();
  /** One check of the disconnect requests at a time; a change during a check runs one more check. */
  private readonly disconnectTask = new CoalescingTask(() => this.checkDisconnectRequest());
  private disconnectWatcher: { dispose(): void } | undefined;
  private disposed = false;

  constructor(private readonly deps: ControllerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.isAlive = deps.isAlive ?? isProcessAlive;
  }

  private get logger(): OutputChannelLogger {
    return this.deps.logger;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Setup

  /**
   * Operations wait for this promise: the window status file must exist first, so that other windows and the Session
   * Monitor count this window's busy marks as live.
   */
  setReady(ready: Promise<unknown>): void {
    this.ready = ready.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Registers the 18 commands of package.json. A command never rejects: errors are shown (concept 6.5). */
  registerCommands(): vscode.Disposable[] {
    const handlers: Record<CommandName, (argument: unknown) => Promise<void>> = {
      start: (argument) => this.start(parseCommandArgument(argument)),
      stop: (argument) => this.stop(parseCommandArgument(argument)),
      delete: (argument) => this.delete(parseCommandArgument(argument)),
      switchBranch: (argument) => this.switchBranch(parseCommandArgument(argument)),
      selectConfiguration: (argument) => this.selectConfiguration(parseCommandArgument(argument)),
      rebuild: (argument) => this.rebuild(parseCommandArgument(argument)),
      showOnGitHub: (argument) => this.showOnGitHub(parseCommandArgument(argument)),
      switchEnvironment: () => this.switchEnvironment(),
      refresh: () => this.refresh(),
      search: () => this.search(),
      showLog: async () => this.logger.show(),
      signIn: () => this.signIn(),
      selectOwners: () => this.selectOwners(),
      selectOwnersFiltered: () => this.selectOwners(),
      installDocker: () => this.deps.dockerSetup.openWizard(),
      dockerSetupInstall: () => this.deps.dockerSetup.install(),
      dockerSetupStart: () => this.deps.dockerSetup.start(),
      dockerSetupInstallWsl: () => this.deps.dockerSetup.installWsl(),
    };
    const run = async (name: CommandName, argument: unknown): Promise<void> => {
      try {
        await handlers[name](argument);
      } catch (error) {
        // An entry of an older version that a command could not assign yet (for example the account changed during the
        // claim): Try again runs the command again, for the account that is signed in then.
        const again = isUserFacingError(error) && error.code === 'environmentUnassigned' ? () => run(name, argument) : undefined;
        this.showError(error, again);
      }
    };
    return (Object.keys(handlers) as CommandName[]).map((name) =>
      vscode.commands.registerCommand(Commands[name], (argument: unknown) => run(name, argument)),
    );
  }

  /** Status bar "Updating owner/name…" while a pipeline runs (concept 6.3). */
  onBusyChanged(change: BusyChange): void {
    if (change.busy && change.repository) this.deps.statusBar.showBusy(change.repository);
    else this.deps.statusBar.clearBusy();
  }

  /**
   * Every 15 seconds (the window heartbeat): is the container of this window still running, and does another window ask
   * this window to close its connection?
   */
  onHeartbeat(): void {
    this.background(this.checkConnection(), 'check the connection');
    this.onDisconnectRequested();
  }

  /**
   * Watches the disconnect requests of other windows, so that this window answers at once; the heartbeat checks them
   * as well. Call once at activation.
   */
  watchDisconnectRequests(): vscode.Disposable {
    this.disconnectWatcher?.dispose();
    this.disconnectWatcher = this.deps.disconnectRequests.watch(
      () => this.onDisconnectRequested(),
      (error) => this.logger.warn(`The requests of other windows cannot be watched: ${errorMessage(error)}`),
    );
    return {
      dispose: () => {
        this.disconnectWatcher?.dispose();
        this.disconnectWatcher = undefined;
      },
    };
  }

  /** A disconnect request may have changed. Only a window with an environment answers. */
  onDisconnectRequested(): void {
    if (!this.current || this.disposed) return;
    this.background(this.disconnectTask.request(), 'check the requests of other windows');
  }

  /** The branches of the running containers were read: the status bar shows the current one. */
  onStatesRefreshed(): void {
    const current = this.current;
    if (!current) return;
    const branch = this.deps.sidebar.liveBranch(current.environment.id);
    if (branch && branch !== current.branch) {
      current.branch = branch;
      this.updateStatusBar();
    }
  }

  /**
   * Concept 6.1 step 2: when the view shows for the first time in this window, check that Docker is installed. The action
   * Install Docker… opens the walkthrough.
   */
  onViewVisible(): void {
    if (this.dockerChecked) return;
    this.dockerChecked = true;
    if (this.deps.docker.isInstalled()) return;
    this.logger.warn('The Docker CLI was not found.');
    vscode.window
      .showWarningMessage(Messages.dockerNotInstalled, Actions.installDocker)
      .then((choice) => (choice === Actions.installDocker ? vscode.commands.executeCommand(Commands.installDocker) : undefined))
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  dispose(): void {
    this.disposed = true;
    this.disconnectWatcher?.dispose();
    this.disconnectWatcher = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Window roles at activation (concept 7.9, 7.10, 7.14)

  /**
   * Role A: VS Code restored this window, reloaded it, or our own `vscode.openFolder` opened it, attached to the
   * container of `environment`. Unless the open pipeline has just run for it (a fresh pending connection file), the
   * pipeline runs now (FR-11 check before each connection; FR-07/FR-08 Docker start, container start, recreation).
   * activate() awaits this.
   */
  async openAttachedWindow(
    attached: Environment,
    containerName: string,
    pending: PendingConnection | undefined,
  ): Promise<void> {
    // Concept 7.5: the environment of another account runs no pipeline and starts no container; the window closes.
    const environment = await this.ownWindowEnvironment(attached, containerName);
    if (!environment) return;
    this.current = { environment, containerName, lost: false };
    this.updateStatusBar();
    // Concept 7.5: an account change while the window checked its environment (for example during the claim) found no
    // environment of this window yet. Check the account again now that the window has one; the window leaves (and the
    // token file is removed) when the environment is not the account's.
    if (!(await this.stillAvailable(environment))) return;
    const repository = this.displayName({ repository: environment.repository });
    if (pipelineJustRan(pending, environment.id, this.clock.now())) {
      this.logger.info(`The open pipeline of ${repository} has just run for this window.`);
    } else {
      this.logger.info(`This window was restored or reloaded. The open pipeline of ${repository} runs before it connects.`);
      // Assumption (V-2): activation through onResolveRemoteAuthority:attached-container blocks the connection until
      // activate() resolves, also when the pipeline starts Docker or updates the environment for several minutes.
      const succeeded = await this.operation(
        repository,
        'Open',
        () =>
          runWithProgress({
            title: Messages.opening(repository),
            repository,
            cancellable: true,
            task: async (progress, signal) => {
              await this.deps.service.openEnvironment(environment.id, { progress, signal });
            },
          }),
        { retry: () => this.start({ kind: 'environment', environmentId: environment.id }) },
      );
      if (!succeeded) {
        // "Delete environment" for missing files (concept 7.12) removed the environment of this window.
        if (await this.leaveDeletedEnvironment(environment.id)) return;
        // Concept section 9: the pipeline did not make the container of an older version again (for example the host
        // access policy refused the configuration, or the user cancelled). That container uses the Git of the computer,
        // so the window must not attach to it. A current container stays: it passed the policy when it was made.
        if (this.current?.environment.id === environment.id && (await this.containerOutdated(environment.id))) {
          this.logger.info(`The container of ${repository} is of an older version and was not made again. The window closes its remote connection.`);
          await this.leaveEnvironment(ControllerTexts.outdatedContainerClosed(repository), {
            environmentId: environment.id,
            containerName,
            repository,
            reason: 'outdated',
          });
          return;
        }
        // The pipeline refuses an environment that the account signed in now may not use (otherAccount): the window leaves
        // it and its token file, instead of keeping the connection.
        if (this.current?.environment.id === environment.id && !(await this.stillAvailable(environment))) return;
        // The window shows its own connection error; the status bar offers Reconnect.
        if (this.current) {
          this.current.lost = true;
          this.updateStatusBar();
        }
      }
    }
    this.background(this.readWindowBranch(), 'read the branch of the environment');
  }

  /**
   * Role B: an empty window. First the pending operations that a window left when it closed its remote connection
   * (concept 7.14), oldest first; then the reopen rule (concept 7.10 #2, decision D-5 option a).
   */
  async runEmptyWindowTasks(): Promise<void> {
    await this.ready;
    const { sessionFiles, coordinator, registry, connection } = this.deps;
    await sessionFiles
      .cleanupStaleClaims()
      .catch((error: unknown) => this.logger.warn(`Old claimed operations could not be removed: ${errorMessage(error)}`));
    const { runnable, stale } = sortPendingOperations(await sessionFiles.readOperations(), this.clock.now());
    for (const operation of stale) {
      this.logger.info(`The pending ${operation.operation} of ${operation.environmentId} is too old and is dropped.`);
      await this.removeOperationQuietly(operation.environmentId);
    }
    const account = await this.readAccount();
    for (const operation of runnable) {
      if (this.disposed) return;
      // Concept 7.5: an operation of an environment of another account is not run by this window; it expires.
      const target = await registry.get(operation.environmentId);
      if (target && !isAvailableTo(target, account)) {
        this.logger.info(
          `The pending ${operation.operation} of ${operation.environmentId} is for another GitHub account. It is not run.`,
        );
        continue;
      }
      let claimed: PendingOperation | undefined;
      try {
        claimed = await sessionFiles.claimOperation(operation.environmentId, coordinator.windowId);
      } catch (error) {
        this.logger.warn(`The pending operation of ${operation.environmentId} could not be claimed: ${errorMessage(error)}`);
        continue;
      }
      if (claimed) await this.runPendingOperation(claimed);
    }
    if (runnable.length > 0) return;

    await this.delay(this.deps.timing?.reopenCheckDelayMs ?? REOPEN_CHECK_DELAY_MS);
    if (this.disposed) return;
    const [others, operations, record, environments] = await Promise.all([
      coordinator.otherActiveWindows(),
      sessionFiles.readOperations(),
      sessionFiles.readReopen(),
      registry.list(),
    ]);
    const decision = decideReopen({
      settings: this.deps.settings(),
      emptyWindow: connection.isEmptyWindow(),
      otherActiveWindows: others.length,
      pendingOperations: operations.length,
      record,
      // Concept 7.5: only an environment of the signed-in account is opened again.
      environmentIds: new Set(availableEnvironments(environments, account).map((environment) => environment.id)),
      now: this.clock.now(),
    });
    if (!decision.reopen) {
      this.logger.info(`The last environment is not opened: ${decision.reason}.`);
      return;
    }
    const environment = environments.find((candidate) => candidate.id === decision.environmentId);
    if (!environment) return;
    this.logger.info(`Opening the last used environment ${environment.repository}.`);
    // The progress notification "Opening owner/name…" has Cancel: the user can stay in the empty window.
    await this.startTarget(this.environmentTarget(environment));
  }

  /**
   * Concept 7.5 "registry lost": entries for the volumes with the label devenv.environment-id, when registry.json is
   * missing, not valid, or has invalid entries. Only when Docker runs; Docker is not started for this.
   */
  async reconcileIfRegistryLost(): Promise<void> {
    const { docker, service } = this.deps;
    // Also when registry.json exists but its content is lost (not valid, or invalid entries), not only when it is missing.
    if (!(await this.deps.registryNeedsRestore())) return;
    if (!docker.isInstalled() || !(await docker.isRunning())) return;
    const added = await service.reconcileFromVolumes();
    if (added === 0) return;
    await this.adoptWindowEnvironment();
    await this.deps.sidebar.render();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands

  /** Start (concept 6.2, 6.6, 7.6, 7.11). */
  async start(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'open', ControllerTexts.selectRepositoryToStart);
    if (target) await this.startTarget(target);
  }

  /** Stop (concept 6.2): the container stops at once; a connected window closes its connection first. */
  async stop(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'environment', ControllerTexts.selectEnvironmentToStop);
    const environment = this.requireEnvironment(target);
    if (!target || !environment) return;
    if (this.isConnectedHere(environment)) {
      await this.handOff(target, environment, { operation: 'stop', reason: 'manual' });
      return;
    }
    const repository = this.displayName(target);
    if (await this.connectedInOtherWindow(environment.id)) {
      // Concept 6.2: the other window closes its connection first, and its reloaded window stops the container.
      if (!(await this.confirmOtherWindow(repository, ControllerTexts.stop))) return;
      await this.operation(repository, 'Stop', () =>
        this.requestOtherWindowHandOff(repository, environment, { operation: 'stop', reason: 'manual' }),
      );
      return;
    }
    await this.stopNow(target, environment);
  }

  /** Delete (concept 6.2, 7.14): safety check, confirmation, then the removal. */
  async delete(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'environment', ControllerTexts.selectEnvironmentToDelete);
    const environment = this.requireEnvironment(target);
    if (!target || !environment) return;
    const repository = this.displayName(target);
    if ((await this.otherWindowMark(environment.id))?.operation === 'delete') {
      this.inform(ControllerTexts.alreadyDeleting(repository));
      return;
    }
    let openInstead = false;
    await this.operation(
      repository,
      'Delete',
      async () => {
        const summary = await runWithProgress({
          title: ControllerTexts.checkingChanges(repository),
          cancellable: true,
          task: (progress, signal) => this.deps.service.safetyCheck(environment.id, { progress, signal }),
        });
        const otherWindow = (await this.connectedInOtherWindow(environment.id))
          ? ` ${ControllerTexts.otherWindowClosesConnection(repository)}`
          : '';
        // Without a summary (the volume is missing), the confirmation follows at once.
        const changes = summary ? formatChanges(summary) : '';
        if (changes !== '') {
          const choice = await vscode.window.showWarningMessage(
            `${Messages.deleteUnsaved(repository, changes)}${otherWindow}`,
            { modal: true },
            Actions.openEnvironment,
            Actions.deleteAnyway,
          );
          if (choice === Actions.openEnvironment) openInstead = true;
          if (choice !== Actions.deleteAnyway) return;
        } else {
          const choice = await vscode.window.showWarningMessage(
            `${Messages.deleteConfirm(repository)}${otherWindow}`,
            { modal: true },
            Actions.delete,
          );
          if (choice !== Actions.delete) return;
        }
        const confirmed = (await this.deps.registry.get(environment.id)) ?? environment;
        const volumes = confirmed.additionalVolumes ?? [];
        let additionalVolumesToRemove: string[] = [];
        if (volumes.length > 0) {
          const choice = await vscode.window.showWarningMessage(
            Messages.deleteAdditionalVolumes(volumes.join(', ')),
            { modal: true },
            Actions.remove,
            Actions.keep,
          );
          if (choice === undefined) return;
          additionalVolumesToRemove = choice === Actions.remove ? [...volumes] : [];
        }
        // Concept 7.15: Delete is possible in every state; during an operation of another window it runs afterwards.
        if (!(await this.waitForOtherWindowOperation(repository, environment.id))) return;
        const current = await this.deps.registry.get(environment.id);
        if (!current) {
          this.logger.info(`The environment of ${repository} does not exist anymore. Nothing is deleted.`);
          return;
        }
        const request: HandOffRequest = { operation: 'delete', reason: 'manual', additionalVolumesToRemove };
        if (this.isConnectedHere(current)) {
          await this.handOffNow(repository, current, request, 'delete');
          return;
        }
        // Concept 7.14 Delete step 2: a window that is connected closes its connection first.
        if (await this.connectedInOtherWindow(current.id)) {
          await this.requestOtherWindowHandOff(repository, current, request);
          return;
        }
        await this.deleteWithProgress(repository, current, additionalVolumesToRemove);
      },
      { retry: () => this.delete({ kind: 'environment', environmentId: environment.id }) },
    );
    if (openInstead) {
      const fresh = await this.deps.registry.get(environment.id);
      if (fresh) await this.startTarget(this.environmentTarget(fresh));
    }
  }

  /** Rebuild (concept 7.14). */
  async rebuild(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'environment', ControllerTexts.selectEnvironmentToRebuild);
    const environment = this.requireEnvironment(target);
    if (!target || !environment) return;
    await this.rebuildEnvironment(target, environment, { reason: 'manual' });
  }

  /** Select configuration… (concept 6.2, 7.5): changes the configuration of the environment and rebuilds it. */
  async selectConfiguration(argument: CommandArgument): Promise<void> {
    const resolved = await this.resolveTarget(argument, 'repository', ControllerTexts.selectRepositoryForConfiguration);
    if (!resolved) return;
    const target = await this.withOlderEnvironment(resolved);
    const repository = this.displayName(target);
    const environment = target.environment;
    let configPaths = target.info?.configPaths ?? [];
    if (environment) {
      let listed: string[] | undefined;
      await this.operation(repository, 'Select configuration', async () => {
        listed = await runWithProgress({
          title: ControllerTexts.readingConfigurations(repository),
          cancellable: true,
          task: (progress, signal) => this.deps.service.listConfigurations(environment.id, { progress, signal }),
        });
      });
      if (!listed) return;
      configPaths = listed;
    }
    if (configPaths.length === 0) {
      this.inform(Messages.noConfiguration(repository));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      configurationChoices(configPaths, environment?.configPath).map((choice) => ({
        label: choice.label,
        description: choice.description,
        configPath: choice.configPath,
      })),
      {
        title: ControllerTexts.selectConfigurationTitle,
        placeHolder: ControllerTexts.configurationPlaceholder(repository),
        matchOnDescription: true,
      },
    );
    if (!picked) return;
    await this.applyConfiguration(target, picked.configPath);
  }

  /**
   * Select configuration… after the pick. Try again of a first open that failed runs this step again with the same
   * configuration, for the environment of the repository that the account signed in now has then, as the command does.
   */
  private async applyConfiguration(target: Target, configPath: string): Promise<void> {
    const environment = target.environment;
    if (!environment) {
      await this.startTarget(target, { configPath }, async () =>
        this.applyConfiguration(await this.withOlderEnvironment(await this.refreshedTarget(target, 'token')), configPath),
      );
      return;
    }
    if (configPath === environment.configPath) {
      this.logger.info(`${this.displayName(target)} uses the configuration ${configPath} already.`);
      return;
    }
    await this.rebuildEnvironment(target, environment, { reason: 'configurationSelected', configPath });
  }

  /** Switch branch… (concept 6.2, 7.5). */
  async switchBranch(argument: CommandArgument): Promise<void> {
    const resolved = await this.resolveTarget(argument, 'repository', ControllerTexts.selectRepositoryForBranch);
    if (!resolved) return;
    const target = await this.withOlderEnvironment(resolved);
    const token = await this.deps.auth.getToken({ interactive: true });
    if (!token) throw new UserFacingError('signInRequired', Messages.signInRequired);
    const environment = target.environment;
    const current = environment
      ? (this.deps.sidebar.liveBranch(environment.id) ?? environment.gitSummary?.branch ?? undefined)
      : undefined;
    const branch = await this.pickBranch(this.displayName(target), token, current, target.info?.defaultBranch ?? undefined);
    if (!branch) return;
    await this.switchToBranch(target, branch);
  }

  /**
   * Switch branch… after the pick. Try again of a first open that failed runs this step again with the same branch, for
   * the environment of the repository that the account signed in now has then (its own, an older entry that it claims,
   * or none), as the command does.
   */
  private async switchToBranch(target: Target, branch: string): Promise<void> {
    const environment = target.environment;
    if (!environment) {
      // Concept 6.2: without an environment, the first Start creates it on the selected branch.
      await this.startTarget(target, { branch }, async () =>
        this.switchToBranch(await this.withOlderEnvironment(await this.refreshedTarget(target, 'token')), branch),
      );
      return;
    }
    const current = this.deps.sidebar.liveBranch(environment.id) ?? environment.gitSummary?.branch ?? undefined;
    if (branch === current && this.isConnectedHere(environment)) {
      this.logger.info(`${this.displayName(target)} is on the branch ${branch} already.`);
      return;
    }
    await this.switchEnvironmentBranch(target, environment, branch);
  }

  /** Show on GitHub. */
  async showOnGitHub(argument: CommandArgument): Promise<void> {
    const target = await this.resolveTarget(argument, 'gitHub', ControllerTexts.selectRepositoryForGitHub);
    if (!target) return;
    const info = target.info ?? this.deps.sidebar.repositoryInfo(target.repository);
    if (!info) {
      this.inform(TreeTexts.notListedOnGitHub);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(info.url));
  }

  /** Switch Environment… (concept 6.4): the selected environment or repository opens in this window. */
  async switchEnvironment(): Promise<void> {
    const { registry, sidebar } = this.deps;
    // Only the environments and the repositories of the signed-in account (concept 7.5).
    const [environments, repositories] = await Promise.all([sidebar.availableEnvironments(), sidebar.repositoriesForPicker()]);
    if (environments.length === 0 && repositories.length === 0) {
      this.inform(ControllerTexts.noRepositories);
      return;
    }
    await this.renderQuietly();
    const choice = await showSwitcher({ groups: sidebar.model(), environments, repositories });
    if (!choice) return;
    if (choice.kind === 'environment') {
      const environment = await registry.get(choice.environmentId);
      if (!environment) {
        this.inform(PipelineTexts.environmentMissing);
        return;
      }
      const target = await this.ownTarget(this.environmentTarget(environment));
      if (target) await this.startTarget(target);
      return;
    }
    await this.startTarget(await this.repositoryTargetFor(choice.repository.nameWithOwner, 'token'));
  }

  /** Refresh: the repository list (sign-in first when needed), a lost registry, and the states. */
  async refresh(): Promise<void> {
    if (await this.deps.auth.isSignedIn()) await this.deps.sidebar.refreshDiscovery({ again: true });
    else await this.signIn();
    await this.reconcileIfRegistryLost().catch((error: unknown) =>
      this.logger.warn(`The environments could not be restored from the volumes: ${errorMessage(error)}`),
    );
    await this.deps.sidebar.refreshStates();
  }

  /** Search: all repositories with a text search, then Start. */
  async search(): Promise<void> {
    const repositories = await this.deps.sidebar.repositoriesForPicker();
    if (repositories.length === 0) {
      this.inform(ControllerTexts.noRepositories);
      return;
    }
    const info = await pickRepository(repositories, ControllerTexts.selectRepositoryToStart);
    if (!info) return;
    await this.startTarget(await this.repositoryTargetFor(info.nameWithOwner, 'token'));
  }

  /** Select Organizations… (concept 6.2, 8): writes the setting `owners`, the scan scope of the list. */
  async selectOwners(): Promise<void> {
    await selectOwners({
      auth: this.deps.auth,
      discoveryData: () => this.deps.sidebar.discoveryData,
      discovery: this.deps.discovery,
      settings: this.deps.settings,
      signIn: () => this.signIn(),
      logger: this.logger,
    });
  }

  /** Sign in with GitHub (concept 6.1 step 1). */
  async signIn(): Promise<void> {
    const token = await this.deps.auth.getToken({ interactive: true });
    await this.deps.auth
      .updateContextKey()
      .catch((error: unknown) => this.logger.warn(`The sign-in state could not be read: ${errorMessage(error)}`));
    if (!token) {
      this.logger.info('The GitHub sign-in was not completed.');
      return;
    }
    // A new session also fires the session change event, which starts a refresh: reuse it instead of a second one.
    await this.deps.sidebar.onSessionChanged({ again: false });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Flows

  /**
   * Start flow (concept 6.2, 6.6, 7.6, 7.11): the open pipeline, then the connection of this window. The window stays
   * connected to its previous environment while the pipeline runs (a switch is the same flow).
   */
  /** `retry`: Try again after a failure; by default a Start of the target again (a first open of a command sets its own). */
  private async startTarget(target: Target, options: StartOptions = {}, retry?: () => Promise<void>): Promise<void> {
    const { service, connection } = this.deps;
    const environment = target.environment;
    const repository = this.displayName(target);
    let reconnecting = false;
    if (environment) {
      if (this.isConnectedHere(environment)) {
        // "Already connected → nothing" only while the container runs; otherwise this is Reconnect (concept 6.3, 7.12).
        const containerName = this.current?.containerName ?? environment.containerName;
        if (await this.containerRuns(containerName)) {
          // Concept section 9: a container of an older version uses the Git of the computer. The pipeline must not
          // replace it under this window, so the window leaves it; a Start from the empty window makes a new container.
          if (await this.containerOutdated(environment.id)) {
            this.logger.info(`The container of ${repository} is of an older version. The window closes its remote connection.`);
            await this.leaveEnvironment(ControllerTexts.outdatedContainerClosed(repository), {
              environmentId: environment.id,
              containerName,
              repository,
              reason: 'outdated',
            });
            return;
          }
          this.logger.info(`This window is connected to ${repository}.`);
          if (this.current?.lost) {
            this.current.lost = false;
            this.updateStatusBar();
          }
          this.inform(ControllerTexts.alreadyConnected(repository));
          return;
        }
        this.logger.info(`The container of ${repository} does not run. The window connects again.`);
        reconnecting = true;
      } else if (await this.connectedInOtherWindow(environment.id)) {
        if (await this.containerRuns(environment.containerName)) {
          // The pipeline must not replace the container under the other window (an update would disconnect it).
          // Assumption (V-2): VS Code shows the window that has this folder open instead of opening it again (concept 7.11).
          this.logger.info(`${repository} is open in another window. That window is shown.`);
          const folder = environment.remoteWorkspaceFolder ?? repositoryFolder(environment.repository);
          await connection.open(environment.containerName, folder);
          return;
        }
        // Concept 6.2 "Stopped: the next Start starts it": the other window has lost its connection, so the container
        // can be started (or replaced) as usual. The connection then shows the other window (V-2), which connects again.
        this.logger.info(
          `The container of ${repository} does not run. The connection of the other window is lost; the environment starts.`,
        );
      }
    }
    const started = await this.operation(
      repository,
      'Start',
      () =>
        runWithProgress({
          title: Messages.opening(repository),
          repository,
          cancellable: true,
          task: (progress, signal) =>
            this.connectingFlow(async (request) => {
              let result: OpenResult;
              if (environment) {
                result = await service.openEnvironment(environment.id, { progress, signal, configPath: options.configPath });
              } else {
                const trusted = await this.firstOpenTrust(repository);
                result = await service.open(repositoryTarget(repository, target.info, trusted), {
                  progress,
                  signal,
                  branch: options.branch,
                  configPath: options.configPath,
                  olderEnvironmentAsked: target.olderEnvironmentAsked,
                });
              }
              await this.connect(result, progress, request, signal);
            }),
        }),
      // Try again is a Start: a repository takes the account of a session with a working token, as at the first try.
      { retry: retry ?? (async () => this.startTarget(await this.refreshedTarget(target, 'token'))) },
    );
    // Reconnect: "Delete environment" for missing files (concept 7.12) removed the environment of this window.
    if (!started && reconnecting && environment) await this.leaveDeletedEnvironment(environment.id);
  }

  /** Runs a flow that ends by connecting this window, with its number for `connect`. */
  private async connectingFlow<T>(fn: (request: number) => Promise<T>): Promise<T> {
    const request = ++this.connectRequests;
    this.activeConnectRequests.add(request);
    try {
      return await fn(request);
    } finally {
      this.activeConnectRequests.delete(request);
    }
  }

  /**
   * Last step of the pipeline (concept 7.6): the pending connection file, then the folder URI in this window.
   * A flow does not connect while a newer connecting flow runs in this window, for example the automatic reopen of
   * concept 7.10 after the user selected another environment: the newest request wins, also when the older pipeline
   * finishes first. The skipped environment's container stops after the waiting time.
   * Cancel in the progress notification also counts when the pipeline has finished its last step already: the window
   * stays as it is (concept 7.10 #2: "[Cancel] lets the user stay in the empty window").
   */
  private async connect(result: OpenResult, progress: ProgressReporter, request: number, signal: AbortSignal): Promise<void> {
    if ([...this.activeConnectRequests].some((other) => other > request)) {
      this.logger.info(`${result.environment.repository} is not connected: another environment is opening in this window.`);
      return;
    }
    if (signal.aborted) {
      this.logger.info(`${result.environment.repository} is not connected: the user cancelled.`);
      // The pipeline wrote the pending connection file for this connection; without it the container stops as usual.
      await this.deps.sessionFiles
        .removePending(result.environment.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    }
    // Concept 7.5: the session is read at the start of the pipeline; the account may have changed while it ran (a build
    // can take minutes). The window connects only to an environment of the account that is signed in now.
    const account = await this.readAccount();
    const entry = (await this.deps.registry.get(result.environment.id).catch(() => undefined)) ?? result.environment;
    if (!isAvailableTo(entry, account)) {
      const repository = this.displayName({ repository: result.environment.repository });
      this.logger.info(`${repository} is not connected: the GitHub account changed while it opened.`);
      // Without the pending connection file, the Session Monitor stops the container after the waiting time.
      await this.deps.sessionFiles
        .removePending(result.environment.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw account
        ? new UserFacingError('otherAccount', Messages.otherAccount(repository))
        : new UserFacingError('signInRequired', Messages.signInRequired);
    }
    progress.step('connecting');
    await this.deps.coordinator.writePending(result.environment.id);
    await this.deps.connection.open(result.containerName, result.remoteWorkspaceFolder);
  }

  /**
   * Concept section 9: a first open of a repository of another owner needs a confirmation. The trust needs the list of
   * the signed-in account, so the sign-in comes first (the pipeline needs the token anyway).
   */
  private async firstOpenTrust(repository: string): Promise<boolean> {
    const token = await this.deps.auth.getToken({ interactive: true });
    if (!token) throw new UserFacingError('signInRequired', Messages.signInRequired);
    return this.deps.sidebar.trustedOwner(splitRepository(repository).owner);
  }

  /**
   * Stops the container. The reopen record stays: the next start of VS Code without a restored window opens the last
   * used environment again, also after a Stop (concept 7.10 #2, FR-07, decision D-5 option a).
   */
  private async stopNow(target: Target, environment: Environment): Promise<void> {
    const repository = this.displayName(target);
    await this.operation(
      repository,
      'Stop',
      () => runWithProgress({ title: ControllerTexts.stopping(repository), task: () => this.deps.service.stop(environment.id) }),
      { retry: () => this.stopNow(target, environment) },
    );
  }

  private deleteWithProgress(repository: string, environment: Environment, additionalVolumesToRemove: readonly string[]): Promise<void> {
    // Not cancellable: a delete that stops half-way helps nobody.
    return runWithProgress({
      title: ControllerTexts.deleting(repository),
      repository,
      task: (progress, signal) => this.deps.service.delete(environment.id, { progress, signal, additionalVolumesToRemove }),
    });
  }

  /** Rebuild of an environment that this window may be connected to (concept 7.14). */
  private async rebuildEnvironment(
    target: Target,
    environment: Environment,
    request: { reason: PendingOperation['reason']; configPath?: string },
  ): Promise<void> {
    const repository = this.displayName(target);
    if (this.isConnectedHere(environment)) {
      await this.handOff(target, environment, { operation: 'rebuild', ...request }, 'rebuild');
      return;
    }
    if (await this.connectedInOtherWindow(environment.id)) {
      // Concept 7.14 step 3: the other window closes its connection, and its reloaded window rebuilds and connects again.
      if (!(await this.confirmOtherWindow(repository, Actions.rebuildNow))) return;
      await this.operation(repository, 'Rebuild', () =>
        this.requestOtherWindowHandOff(repository, environment, { operation: 'rebuild', ...request }),
      );
      return;
    }
    await this.operation(
      repository,
      'Rebuild',
      () =>
        runWithProgress({
          title: ControllerTexts.rebuilding(repository),
          repository,
          cancellable: true,
          task: async (progress, signal) => {
            // The window is not connected to this environment, so it does not connect (the container runs until the
            // Session Monitor stops it).
            await this.deps.service.openEnvironment(environment.id, {
              progress,
              signal,
              forceRebuild: true,
              configPath: request.configPath,
            });
          },
        }),
      { retry: () => this.rebuildEnvironment(target, environment, request) },
    );
  }

  /** Switch branch… in an existing environment (concept 6.2, 7.5). */
  private async switchEnvironmentBranch(target: Target, environment: Environment, branch: string): Promise<void> {
    const repository = this.displayName(target);
    const connectedHere = this.isConnectedHere(environment);
    let configurationChanged = false;
    const switched = await this.operation(
      repository,
      'Switch branch',
      async () => {
        configurationChanged = await runWithProgress({
          title: ControllerTexts.switchingBranch(repository, branch),
          repository,
          cancellable: true,
          task: async (progress, signal) => {
            await this.deps.service.switchBranch(environment.id, branch, { progress, signal });
            return connectedHere ? this.deps.service.configurationChanged(environment.id, { progress, signal }) : false;
          },
        });
      },
      { retry: () => this.switchEnvironmentBranch(target, environment, branch) },
    );
    if (!switched) return;
    if (connectedHere) {
      if (this.current) {
        this.current.branch = branch;
        this.updateStatusBar();
      }
      // Concept 7.12: a changed configuration offers Rebuild now; Later keeps the window connected.
      if (configurationChanged && (await this.deps.ui.configurationChanged(repository)) === 'rebuildNow') {
        await this.handOff(target, environment, { operation: 'rebuild', reason: 'configChanged' }, 'rebuild');
      }
      return;
    }
    // Concept 6.2: Switch branch… connects the current window; the pipeline applies the rule for a changed configuration.
    // It connects the environment whose branch it switched, also when the target was a repository: after an account
    // change during the switch, the pipeline refuses that environment (otherAccount) instead of opening another one.
    await this.startTarget(await this.refreshedTarget({ ...target, environment, named: true }));
  }

  /**
   * Operation on the environment that this window is connected to (concept 7.14 steps 1–3): busy mark, pending
   * operation, then "Close Remote Connection". The window becomes an empty local window, and the extension there runs
   * the operation (role B).
   */
  private async handOff(target: Target, environment: Environment, request: HandOffRequest, busy?: BusyOperation): Promise<void> {
    const repository = this.displayName(target);
    await this.operation(repository, request.operation, () => this.handOffNow(repository, environment, request, busy));
  }

  private async handOffNow(
    repository: string,
    environment: Environment,
    request: HandOffRequest,
    busy?: BusyOperation,
  ): Promise<void> {
    const { sessionFiles, coordinator, connection } = this.deps;
    await this.prepareHandOff(repository, environment, busy);
    this.logger.info(
      `${request.operation} of ${repository}: this window closes its remote connection, and the empty window continues.`,
    );
    try {
      await sessionFiles.writeOperation({
        environmentId: environment.id,
        operation: request.operation,
        requestedAt: isoTime(this.clock),
        requestedBy: coordinator.windowId,
        reason: request.reason,
        configPath: request.configPath,
        additionalVolumesToRemove: request.additionalVolumesToRemove,
      });
      await connection.closeRemoteConnection();
    } catch (error) {
      await this.cancelHandOff(environment.id);
      throw error;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.background(this.cancelHandOffIfUnclaimed(environment.id), 'check the pending operation');
    }, this.deps.timing?.handOffCheckMs ?? HANDOFF_CHECK_MS);
    this.timers.add(timer);
  }

  /**
   * Before the connection closes: another live window must not be changing the environment (an update, rebuild, or
   * delete). Its mark would otherwise be replaced, and the reloaded window would run a second operation on the same
   * environment. With `operation`, sets this window's busy mark (concept 7.14 step 1), so that the Session Monitor does
   * not stop the container before the reloaded window takes over.
   */
  private async prepareHandOff(
    repository: string,
    environment: Environment,
    operation: BusyOperation | undefined,
  ): Promise<void> {
    const owner = this.owner();
    const blocks = await this.markBlocker();
    const state: { conflict?: BusyMark } = {};
    let found: Environment | undefined;
    if (operation) {
      const mark: BusyMark = { operation, since: isoTime(this.clock), pid: owner.pid, windowId: owner.windowId };
      found = await this.deps.registry.updateEnvironment(environment.id, (entry) => {
        if (entry.busy && blocks(entry.busy)) state.conflict = entry.busy;
        else entry.busy = mark;
      });
    } else {
      found = await this.deps.registry.get(environment.id);
      if (found?.busy && blocks(found.busy)) state.conflict = found.busy;
    }
    if (!found) throw new UserFacingError('startFailed', Messages.noEnvironment(repository));
    const conflict = state.conflict;
    if (conflict) {
      throw new UserFacingError(
        'startFailed',
        PipelineTexts.environmentBusy(repository),
        `Busy mark: ${conflict.operation} since ${conflict.since}, process ${conflict.pid}, window ${conflict.windowId}.`,
      );
    }
  }

  /**
   * The test "a live mark of another window" (concept 7.9 rule 1, `isBlockingBusyMark`), with the window status files
   * read once.
   */
  private async markBlocker(): Promise<(mark: BusyMark) => boolean> {
    const owner = this.owner();
    let windowStatuses: WindowStatus[] | undefined;
    try {
      windowStatuses = await this.deps.sessionFiles.readWindowStatuses();
    } catch (error) {
      this.logger.warn(`The window status files could not be read: ${errorMessage(error)}`);
    }
    const now = this.clock.now();
    return (mark) => isBlockingBusyMark(mark, owner, { now, isAlive: this.isAlive, windowStatuses });
  }

  /** The busy mark of another live window on the environment (an operation that runs there), if any. */
  private async otherWindowMark(environmentId: string): Promise<BusyMark | undefined> {
    const mark = (await this.deps.registry.get(environmentId))?.busy;
    if (!mark) return undefined;
    return (await this.markBlocker())(mark) ? mark : undefined;
  }

  /**
   * Concept 7.15 (Delete is possible in every state): while another window updates, rebuilds, creates, or switches the
   * branch of the environment, the delete waits for the end of that operation, in a progress notification with Cancel.
   * Returns false when the user cancelled, or when the other window deletes the environment itself.
   */
  private async waitForOtherWindowOperation(repository: string, environmentId: string): Promise<boolean> {
    const mark = await this.otherWindowMark(environmentId);
    if (!mark) return true;
    let outcome: 'free' | 'deleting' | 'cancelled' = 'deleting';
    if (mark.operation !== 'delete') {
      this.logger.info(
        `${repository} is busy (${mark.operation}) in another window (process ${mark.pid}). The delete waits for its end.`,
      );
      const pollMs = this.deps.timing?.busyPollMs ?? BUSY_POLL_MS;
      outcome = await runWithProgress({
        title: ControllerTexts.waitingForOtherWindow(repository),
        cancellable: true,
        task: async (_progress, signal): Promise<typeof outcome> => {
          for (;;) {
            await this.delay(pollMs);
            if (signal.aborted || this.disposed) return 'cancelled';
            const next = await this.otherWindowMark(environmentId);
            if (!next) return 'free';
            if (next.operation === 'delete') return 'deleting';
          }
        },
      });
    }
    if (outcome === 'deleting') this.inform(ControllerTexts.alreadyDeleting(repository));
    if (outcome === 'cancelled') this.logger.info(`The delete of ${repository} was cancelled while it waited.`);
    return outcome === 'free';
  }

  /** This extension host still runs long after "Close Remote Connection": the connection was kept. */
  private async cancelHandOffIfUnclaimed(environmentId: string): Promise<void> {
    if (this.disposed) return;
    const operations = await this.deps.sessionFiles.readOperations();
    const own = operations.some(
      (operation) => operation.environmentId === environmentId && operation.requestedBy === this.deps.coordinator.windowId,
    );
    if (!own) return;
    this.logger.info('The remote connection was not closed. The pending operation is cancelled.');
    await this.cancelHandOff(environmentId);
    this.background(this.deps.sidebar.render(), 'update the sidebar');
  }

  private async cancelHandOff(environmentId: string): Promise<void> {
    await this.removeOperationQuietly(environmentId);
    const owner = this.owner();
    await this.deps.registry
      .updateEnvironment(environmentId, (entry) => {
        if (entry.busy && entry.busy.windowId === owner.windowId && entry.busy.pid === owner.pid) delete entry.busy;
      })
      .catch((error: unknown) => this.logger.warn(`The busy mark could not be removed: ${errorMessage(error)}`));
  }

  /**
   * Another window is connected to the environment (concept 6.2 Stop, 7.14 Rebuild step 3 and Delete step 2): that
   * window closes its connection first. This window leaves a disconnect request, which the connected window answers
   * like its own request (`checkDisconnectRequest`): VS Code asks there about unsaved files, and its reloaded empty
   * window runs the operation (role B). A request that no window takes in time is removed, and the user is told.
   */
  private async requestOtherWindowHandOff(
    repository: string,
    environment: Environment,
    request: HandOffRequest,
  ): Promise<void> {
    const sent: DisconnectRequest = {
      environmentId: environment.id,
      operation: request.operation,
      requestedAt: isoTime(this.clock),
      requestedBy: this.deps.coordinator.windowId,
      reason: request.reason,
      configPath: request.configPath,
      additionalVolumesToRemove: request.additionalVolumesToRemove,
    };
    await this.deps.disconnectRequests.write(sent);
    this.logger.info(
      `${request.operation} of ${repository}: the other window is asked to close its remote connection; its empty window continues.`,
    );
    this.inform(ControllerTexts.otherWindowContinues(repository));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.background(this.dropUnansweredRequest(repository, sent), 'check the request to the other window');
    }, this.deps.timing?.disconnectAnswerMs ?? DISCONNECT_REQUEST_MAX_AGE_MS);
    this.timers.add(timer);
  }

  /** The connected window did not take the request in time: nothing was changed. */
  private async dropUnansweredRequest(repository: string, sent: DisconnectRequest): Promise<void> {
    if (this.disposed) return;
    const { disconnectRequests } = this.deps;
    const request = await disconnectRequests.read(sent.environmentId);
    if (!request || request.requestedAt !== sent.requestedAt || request.requestedBy !== sent.requestedBy) return;
    // `take`, so that the connected window cannot take it at the same moment.
    if (!(await disconnectRequests.take(sent.environmentId))) return;
    this.logger.warn(`The other window did not close its connection for the ${sent.operation} of ${repository}.`);
    vscode.window
      .showWarningMessage(ControllerTexts.otherWindowNoAnswer(repository))
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  /**
   * The connected side of a disconnect request: another window stops, rebuilds, or deletes the environment of this
   * window. This window hands off as for its own request (concept 7.14 steps 1–3): busy mark, pending operation, then
   * "Close Remote Connection", where VS Code asks about unsaved files. If the user keeps the connection there, the
   * pending operation is removed again (`cancelHandOffIfUnclaimed`).
   */
  private async checkDisconnectRequest(): Promise<void> {
    const current = this.current;
    if (!current || this.disposed) return;
    const { disconnectRequests, registry } = this.deps;
    const environmentId = current.environment.id;
    const request = await disconnectRequests.read(environmentId);
    if (!request) return;
    const repository = this.displayName({ repository: current.environment.repository });
    if (!isFreshDisconnectRequest(request, this.clock.now())) {
      this.logger.info(`The request of another window to close the connection to ${repository} is too old and is dropped.`);
      await disconnectRequests.remove(environmentId);
      return;
    }
    // An operation of this environment runs in this window (for example Reconnect): a later check answers the request.
    if (this.gate.runningFor(repositoryKey(repository)) !== undefined) return;
    if (!(await disconnectRequests.take(environmentId))) return;
    const environment = await registry.get(environmentId);
    if (!environment || this.current !== current) {
      this.logger.info(`The request of another window for ${repository} is dropped: this window has left the environment.`);
      return;
    }
    if (!isAvailableTo(environment, await this.readAccount())) {
      this.logger.info(`The request of another window for ${repository} is dropped: the environment is of another GitHub account.`);
      return;
    }
    this.logger.info(`Another window asks this window to close its connection for the ${request.operation} of ${repository}.`);
    await this.handOff(
      this.environmentTarget(environment),
      environment,
      {
        operation: request.operation,
        reason: request.reason,
        configPath: request.configPath,
        additionalVolumesToRemove: request.operation === 'delete' ? pendingVolumesToRemove(request, environment) : undefined,
      },
      HAND_OFF_BUSY[request.operation],
    );
  }

  /** Role B: runs a claimed pending operation. The operation file is always removed at the end. */
  private async runPendingOperation(operation: PendingOperation): Promise<void> {
    const { registry } = this.deps;
    try {
      const environment = await registry.get(operation.environmentId);
      if (!environment) {
        this.logger.info(
          `The pending ${operation.operation} is dropped: the environment ${operation.environmentId} does not exist anymore.`,
        );
        return;
      }
      const target = this.environmentTarget(environment);
      this.logger.info(`Running the pending ${operation.operation} of ${this.displayName(target)}.`);
      switch (operation.operation) {
        case 'rebuild':
          // Concept 7.14 steps 4–5: the update order, then this window connects again.
          await this.rebuildAndConnect(target, environment, operation.configPath, () =>
            this.removeOperationQuietly(operation.environmentId),
          );
          return;
        case 'delete':
          await this.operation(
            this.displayName(target),
            'Delete',
            () => this.deleteWithProgress(this.displayName(target), environment, pendingVolumesToRemove(operation, environment)),
            { retry: () => this.delete({ kind: 'environment', environmentId: environment.id }) },
          );
          return;
        case 'stop':
          await this.stopNow(target, environment);
          return;
      }
    } catch (error) {
      this.showError(error);
    } finally {
      await this.removeOperationQuietly(operation.environmentId);
    }
  }

  private async rebuildAndConnect(
    target: Target,
    environment: Environment,
    configPath: string | undefined,
    beforeConnect: () => Promise<void>,
  ): Promise<void> {
    const repository = this.displayName(target);
    await this.operation(
      repository,
      'Rebuild',
      () =>
        runWithProgress({
          title: ControllerTexts.rebuilding(repository),
          repository,
          cancellable: true,
          task: (progress, signal) =>
            this.connectingFlow(async (request) => {
              const result = await this.deps.service.openEnvironment(environment.id, {
                progress,
                signal,
                forceRebuild: true,
                configPath,
              });
              // The window reloads when it connects; nothing after `connect` is sure to run.
              await beforeConnect();
              await this.connect(result, progress, request, signal);
            }),
        }),
      { retry: () => this.rebuildAndConnect(target, environment, configPath, beforeConnect) },
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Connection of this window

  /** Registry restored from the volumes: this window may be attached to one of the restored environments. */
  private async adoptWindowEnvironment(): Promise<void> {
    if (this.current) return;
    const containerName = this.deps.connection.currentContainerName();
    if (!containerName) return;
    const restored = await this.deps.registry.findByContainerName(containerName);
    if (!restored) return;
    const environment = await this.ownWindowEnvironment(restored, containerName);
    if (!environment || this.current) return;
    // No pipeline runs here, so a container of an older version is not made again: the window leaves it (section 9).
    if (await this.containerOutdated(environment.id)) {
      const repository = this.displayName({ repository: environment.repository });
      this.logger.info(`The container of ${repository} is of an older version. The window closes its remote connection.`);
      await this.leaveEnvironment(ControllerTexts.outdatedContainerClosed(repository), {
        environmentId: environment.id,
        containerName,
        repository,
        reason: 'outdated',
      });
      return;
    }
    this.current = { environment, containerName, lost: false };
    await this.deps.coordinator.setEnvironment(environment.id);
    this.updateStatusBar();
    if (!(await this.stillAvailable(environment))) return;
    this.background(this.readWindowBranch(), 'read the branch of the environment');
  }

  /**
   * Checks the account again right after the window took `environment` (the check of `ownWindowEnvironment` ran before
   * awaits, during which the account can change without the window noticing). False when the window left it.
   */
  private async stillAvailable(environment: Environment): Promise<boolean> {
    await this.onSessionChanged();
    return this.current?.environment.id === environment.id;
  }

  /**
   * The environment of this window was deleted, for example with "Delete environment" when its files were missing
   * (concept 7.12): the window leaves it and closes its remote connection (concept 7.14 Delete step 2), instead of
   * offering Reconnect for an environment that does not exist anymore. Returns false when the environment still exists.
   */
  private async leaveDeletedEnvironment(environmentId: string): Promise<boolean> {
    if (this.current?.environment.id !== environmentId) return false;
    try {
      if (await this.deps.registry.get(environmentId)) return false;
    } catch (error) {
      this.logger.warn(`The registry could not be read: ${errorMessage(error)}`);
      return false;
    }
    this.logger.info('The environment of this window was deleted. The window closes its remote connection.');
    await this.leaveEnvironment();
    return true;
  }

  /**
   * The window leaves its environment: no environment in its status file (the Session Monitor stops the container after
   * the waiting time), the status bar, then "Close Remote Connection", with `message` for the user.
   * With `left` (an environment that the window must not use), the window does not rely on the close: VS Code lets the
   * user keep the connection (Cancel in the dialog about unsaved files). The token of the owner account leaves the
   * container at once when the account is the reason, and `checkLeftConnection` closes the connection again.
   */
  private async leaveEnvironment(message?: string, left?: LeftEnvironment): Promise<void> {
    this.current = undefined;
    this.left = left;
    await this.deps.coordinator
      .setEnvironment(null)
      .catch((error: unknown) => this.logger.warn(`The window status could not be written: ${errorMessage(error)}`));
    this.updateStatusBar();
    if (message) this.warn(message);
    if (left?.reason === 'account') this.background(this.removeGitToken(left.containerName), 'remove the GitHub token');
    this.closeConnection(left);
  }

  /**
   * "Close Remote Connection", then (with `left`) the check whether the window has closed it. Not awaited: a restored
   * window's activate() must end first (V-2), and the command reloads the window. `closeFirst: false` only schedules the
   * check.
   */
  private closeConnection(left: LeftEnvironment | undefined, options: { closeFirst?: boolean } = {}): void {
    const close = options.closeFirst ?? true;
    this.background(
      this.delay(0)
        .then(() => (close ? this.deps.connection.closeRemoteConnection() : undefined))
        .finally(() => {
          // The window reloads when the connection closes, and this extension host ends: the check never runs then.
          if (!left || this.left !== left || this.disposed) return;
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.background(this.checkLeftConnection(true), 'check the connection of this window');
          }, this.deps.timing?.leaveCheckMs ?? LEAVE_CHECK_MS);
          this.timers.add(timer);
        }),
      'close the remote connection',
    );
  }

  /**
   * The window left an environment that it must not use (`leaveEnvironment` with `left`), and this extension host still
   * runs, so the window may have kept its connection. When the signed-in account may use the environment again (the
   * user signed in with the owner account), the window reloads: the open pipeline of role A runs and writes the token
   * again. Otherwise, with `retry`, the window says so and closes its connection again.
   */
  private async checkLeftConnection(retry: boolean): Promise<void> {
    const left = this.left;
    if (!left || this.current || this.disposed || this.checkingLeft) return;
    if (this.deps.connection.currentContainerName() !== left.containerName) {
      this.left = undefined;
      return;
    }
    this.checkingLeft = true;
    try {
      if (await this.reopenLeftEnvironment(left)) return;
      if (!retry) return;
      if (this.activeConnectRequests.size > 0) {
        // A Start in this window connects it elsewhere: the close must not end its pipeline. Checked again later.
        this.closeConnection(left, { closeFirst: false });
        return;
      }
      this.logger.warn(`This window is still connected to ${left.repository}, which it must not use. It closes its remote connection again.`);
      if (left.reason === 'account') this.background(this.removeGitToken(left.containerName), 'remove the GitHub token');
      await vscode.window
        .showWarningMessage(ControllerTexts.stillConnected(left.repository), { modal: true })
        .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
      // The owner account may have signed in while the message was open.
      if (await this.reopenLeftEnvironment(left)) return;
      if (this.left !== left || this.current || this.disposed) return;
      this.closeConnection(left);
    } finally {
      this.checkingLeft = false;
    }
  }

  /**
   * The window left the environment because of the account, and the signed-in account may use it now: the window
   * reloads, and the open pipeline of role A runs (it writes the token again). Returns true when the window reloads.
   */
  private async reopenLeftEnvironment(left: LeftEnvironment): Promise<boolean> {
    if (left.reason !== 'account') return false;
    const account = await this.readAccount();
    const found = await this.deps.registry.get(left.environmentId).catch(() => undefined);
    const environment = found && account ? await this.claimIfUnowned(found, account, 'auto') : found;
    if (this.left !== left || this.current || this.disposed) return false;
    if (!environment || !isAvailableTo(environment, account)) return false;
    this.left = undefined;
    this.logger.info(`The signed-in GitHub account may use ${left.repository} again. The window reloads to open it.`);
    await this.deps.connection.open(left.containerName, environment.remoteWorkspaceFolder ?? repositoryFolder(environment.repository));
    return true;
  }

  /**
   * Concept 7.5: the token of the owner account leaves the running container of an environment that the signed-in
   * account may not use, so that Git there cannot push as the owner while a window keeps its connection. The credential
   * helper of the container then gives nothing; the next open of the owner writes the token again (section 9).
   * Best effort: a stopped container needs no removal (its token cannot be used without a start by the owner). When root
   * may not remove it (a configuration that takes rights away, for example `--cap-drop ALL`), the owner of the folder of
   * the token removes it.
   */
  private async removeGitToken(containerName: string): Promise<void> {
    if (!(await this.containerRuns(containerName))) return;
    const run = (command: readonly string[], user: string) =>
      this.deps.docker.exec(containerName, [...command], { user, timeoutMs: TOKEN_REMOVAL_TIMEOUT_MS });
    let result = await run(['rm', '-f', GITHUB_TOKEN_FILE], 'root');
    if (result.exitCode !== 0) {
      const owner = await run(CONFIG_FOLDER_OWNER_COMMAND, 'root');
      const ids = owner.exitCode === 0 ? parseOwnerIds(owner.stdout) : undefined;
      if (ids !== undefined) result = await run(['rm', '-f', GITHUB_TOKEN_FILE], ids);
    }
    if (result.exitCode === 0) this.logger.info(`The GitHub token was removed from the container ${containerName}.`);
    else this.logger.warn(`The GitHub token could not be removed from the container ${containerName}: ${result.stderr.trim()}`);
  }

  /**
   * Concept 7.5, role A and a restored registry: the environment that this window is attached to, when it belongs to the
   * signed-in account (an entry of an older version is claimed first; a sign-in is asked for when needed). Otherwise
   * the window runs no pipeline, starts no container, and closes its remote connection with a message; `undefined`.
   * Assumption (V-8): the activation blocks the connection of a restored window (V-2), so the window of another account
   * never connects to a stopped container; a container that still runs is closed right after the connection.
   */
  private async ownWindowEnvironment(environment: Environment, containerName: string): Promise<Environment | undefined> {
    const account = await this.readAccount(true);
    // Before the connection of a restored window: no question (concept 7.5), only an unambiguous claim.
    const current = account ? await this.claimIfUnowned(environment, account, 'auto') : environment;
    if (account && isAvailableTo(current, account)) return current;
    const repository = this.displayName({ repository: environment.repository });
    let message: string;
    if (!account) {
      this.logger.info('Nobody is signed in to GitHub. The window closes its remote connection.');
      message = ControllerTexts.signedOutConnection(repository);
    } else if (current.owner === undefined) {
      this.logger.info(
        `The environment ${environment.id} of an older version does not belong to an account yet. The window closes its remote connection.`,
      );
      message = ControllerTexts.ownerNotConfirmedConnection(repository);
    } else {
      this.logger.info('This window is attached to an environment of another GitHub account. It closes its remote connection.');
      message = Messages.otherAccountConnection(repository);
    }
    await this.leaveEnvironment(message, { environmentId: environment.id, containerName, repository, reason: 'account' });
    return undefined;
  }

  /**
   * Sign-in, sign-out, or account change (concept 7.5): a window connected to an environment that the new account may
   * not use closes its remote connection at once. The Session Monitor stops the container after the waiting time.
   * A window that has left such an environment but kept its connection reloads when the owner account signs in again.
   */
  async onSessionChanged(): Promise<void> {
    const current = this.current;
    if (this.disposed) return;
    if (!current) {
      await this.checkLeftConnection(false);
      return;
    }
    const account = await this.readAccount();
    const environment = (await this.deps.registry.get(current.environment.id).catch(() => undefined)) ?? current.environment;
    if (isAvailableTo(environment, account) || this.current !== current) return;
    const repository = this.displayName({ repository: environment.repository });
    this.logger.info(
      account
        ? `The GitHub account changed. ${repository} belongs to another account: the window closes its remote connection.`
        : 'Nobody is signed in to GitHub anymore. The window closes its remote connection.',
    );
    await this.leaveEnvironment(
      account ? Messages.otherAccountConnection(repository) : ControllerTexts.signedOutConnection(repository),
      { environmentId: environment.id, containerName: current.containerName, repository, reason: 'account' },
    );
  }

  /**
   * True when the container of the environment exists and was made by an older version of the extension (concept
   * section 9: it uses the Git of the computer). False when Docker cannot be asked. Never throws.
   */
  private async containerOutdated(environmentId: string): Promise<boolean> {
    if (!this.deps.docker.isInstalled()) return false;
    try {
      const container = await this.deps.docker.findContainer(environmentId);
      return container !== undefined && !containerIsCurrent(container.labels);
    } catch (error) {
      this.logger.info(`The container of the environment ${environmentId} could not be read: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Concept 6.3 "Connection lost": the container of this window does not run (for example after a Docker restart). */
  private async checkConnection(): Promise<void> {
    const current = this.current;
    if (!current || this.checkingConnection || this.disposed) return;
    // While an operation of this environment runs in this window (the open pipeline of a restored window, Reconnect),
    // the container is being started or replaced; the operation's end decides the state. Otherwise a check during the
    // pipeline could leave "Reconnect" in the status bar after a successful start.
    const repository = this.displayName({ repository: current.environment.repository });
    if (this.gate.runningFor(repositoryKey(repository)) !== undefined) return;
    this.checkingConnection = true;
    try {
      const lost = !(await this.containerRuns(current.containerName));
      if (lost === current.lost) return;
      current.lost = lost;
      this.logger.info(lost ? `The container of ${repository} does not run.` : `The container of ${repository} runs again.`);
      this.updateStatusBar();
      if (this.deps.viewVisible()) this.background(this.deps.sidebar.refreshStates(), 'update the sidebar');
    } finally {
      this.checkingConnection = false;
    }
  }

  private async readWindowBranch(): Promise<void> {
    const current = this.current;
    if (!current) return;
    await this.checkConnection();
    const branch = await this.deps.service.currentBranch(current.environment.id);
    if (branch && this.current === current) {
      current.branch = branch;
      this.updateStatusBar();
    }
  }

  private async containerRuns(containerName: string): Promise<boolean> {
    if (!this.deps.docker.isInstalled()) return false;
    try {
      return (await this.deps.docker.containerState(containerName)) === 'running';
    } catch (error) {
      this.logger.info(`The state of the container ${containerName} could not be read: ${errorMessage(error)}`);
      return false;
    }
  }

  private updateStatusBar(): void {
    const current = this.current;
    const { statusBar } = this.deps;
    if (!current) {
      statusBar.showNotConnected();
      return;
    }
    const repository = this.displayName({ repository: current.environment.repository });
    if (current.lost) statusBar.showConnectionLost(repository, current.environment.id);
    else statusBar.showConnected(repository, current.branch ?? current.environment.gitSummary?.branch ?? undefined);
  }

  private isConnectedHere(environment: Environment): boolean {
    return this.current?.environment.id === environment.id;
  }

  private async connectedInOtherWindow(environmentId: string): Promise<boolean> {
    try {
      return (await this.deps.coordinator.otherActiveWindows()).some((window) => window.environmentId === environmentId);
    } catch (error) {
      this.logger.warn(`The other windows could not be read: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Another window is connected to the environment: it closes its connection first (concept 6.2, 7.14). */
  private async confirmOtherWindow(repository: string, action: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      ControllerTexts.otherWindowClosesConnection(repository),
      { modal: true },
      action,
    );
    return choice === action;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Targets and pickers

  /**
   * The target of a command: the row of the sidebar, the environment of the status bar item, or (from the Command
   * Palette) a Quick Pick. The environment is read from the registry again: the row may be older than the registry.
   */
  private async resolveTarget(argument: CommandArgument, pick: PickKind, placeholder: string): Promise<Target | undefined> {
    const target = await this.resolveTargetOfAnyAccount(argument, pick, placeholder);
    // Show on GitHub needs no environment; every other command refuses a named environment of another account (concept
    // 7.5). A repository has only the environment of the signed-in account (D-3), so it is never refused.
    if (!target || pick === 'gitHub') return target;
    return this.ownTarget(target);
  }

  /**
   * Concept 7.5: the target, when its environment (if any) belongs to the signed-in account; an entry of an older
   * version is claimed first. Asks for a sign-in when the target has an environment and nobody is signed in. Otherwise
   * shows Messages.otherAccount and returns `undefined`: only an environment that the command names can be one of
   * another account (a row or the status bar item from before an account change), never the environment of a repository.
   */
  private async ownTarget(target: Target): Promise<Target | undefined> {
    const environment = target.environment;
    if (!environment) return target;
    const account = await this.readAccount(true);
    if (!account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    // A command of the user: an entry of an older version is assigned after a question when the claim is not unambiguous.
    const current = await this.claimIfUnowned(environment, account, 'interactive');
    if (isAvailableTo(current, account)) return { ...target, environment: current };
    if (current.owner === undefined) {
      // Not "another account": nobody owns the entry yet (no answer of GitHub, no access, or no confirmation).
      this.logger.info(`The environment ${environment.id} of an older version does not belong to an account yet. It is not used.`);
      this.warn(Messages.olderEnvironmentNotAssigned(this.displayName(target)));
      return undefined;
    }
    this.logger.info(`The environment ${environment.id} belongs to another GitHub account. It is not used.`);
    this.warn(Messages.otherAccount(this.displayName(target)));
    return undefined;
  }

  /**
   * Switch branch… and Select configuration… change the environment of the repository. When the signed-in account has
   * none, an entry of an older version of the repository is claimed first (concept 7.5), so that the branch or the
   * configuration applies to it. Otherwise the target stays without environment, and the open pipeline creates the
   * environment of the account (D-3).
   */
  private async withOlderEnvironment(target: Target): Promise<Target> {
    if (target.environment) return target;
    const account = await this.readAccount();
    const older = account ? await this.deps.registry.findUnowned(target.repository) : undefined;
    if (!account || !older) return target;
    // The command asks also about an entry that the user declined before (like a new Start), so the open need not ask.
    const claimed = await this.claimIfUnowned(older, account, 'interactive', true);
    return isAvailableTo(claimed, account) ? { ...target, environment: claimed } : { ...target, olderEnvironmentAsked: true };
  }

  /**
   * An environment without owner (of an older version) is claimed for `account` (EnvironmentClaims, concept 7.5): in the
   * mode `auto` only when it can belong to no other account, in the mode `interactive` also after a question to the user.
   * The token and the account come from one session: a session that changed since `account` was read claims nothing.
   */
  private async claimIfUnowned(
    environment: Environment,
    account: GitHubAccount,
    mode: ClaimMode,
    askAgain = false,
  ): Promise<Environment> {
    if (environment.owner) return environment;
    let session: { token: string; account: GitHubAccount } | undefined;
    try {
      // The claim asks GitHub, so it needs a working token: a command of the user asks for a new sign-in while GitHub
      // rejects the token of the session (auth.ts); a restored window (`auto`) never asks.
      session = await this.deps.auth.getSession({ interactive: mode === 'interactive' });
    } catch (error) {
      this.logger.warn(`The GitHub session could not be read: ${errorMessage(error)}`);
      return environment;
    }
    // A command whose sign-in the user cancelled ends here: it would ask for the same sign-in again.
    if (!session && mode === 'interactive') throw new UserFacingError('signInRequired', Messages.signInRequired);
    if (!session) return environment;
    if (session.account.id !== account.id) {
      this.logger.info(`The GitHub session changed. The environment ${environment.id} is not claimed.`);
      // A command says so (not "not assigned"): the account that is signed in now was not asked.
      if (mode === 'interactive') {
        throw new UserFacingError('environmentUnassigned', ControllerTexts.accountChangedDuringClaim(this.displayName({ repository: environment.repository })));
      }
      return environment;
    }
    await this.deps.claims.claim(session.account, session.token, { mode, environmentIds: [environment.id], ...(askAgain ? { askAgain } : {}) });
    return (await this.deps.registry.get(environment.id)) ?? environment;
  }

  /**
   * The account of a session with a working token: while GitHub rejects the token of the session, the user signs in
   * again first (auth.ts). `undefined` without a sign-in, or when the session cannot be read.
   */
  private async readWorkingAccount(): Promise<GitHubAccount | undefined> {
    try {
      return (await this.deps.auth.getSession({ interactive: true }))?.account;
    } catch (error) {
      this.logger.warn(`The GitHub session could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** The signed-in account; `undefined` without a sign-in, or when the session cannot be read. */
  private async readAccount(interactive = false): Promise<GitHubAccount | undefined> {
    try {
      return await this.deps.auth.getAccount({ interactive });
    } catch (error) {
      this.logger.warn(`The GitHub account could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async resolveTargetOfAnyAccount(argument: CommandArgument, pick: PickKind, placeholder: string): Promise<Target | undefined> {
    const { registry, sidebar } = this.deps;
    // Show on GitHub needs neither an environment nor a sign-in; Start, Switch branch…, and Select configuration… need a
    // working token.
    const signIn = pick === 'gitHub' ? false : pick === 'open' || pick === 'repository' ? 'token' : true;
    switch (argument.kind) {
      case 'row': {
        const info = sidebar.repositoryInfo(argument.repository) ?? argument.info;
        // The environment of the row while it exists; otherwise (a row without environment, or one deleted meanwhile)
        // the environment of the repository of the signed-in account.
        const named = argument.environmentId !== undefined ? await registry.get(argument.environmentId) : undefined;
        if (named) return { repository: argument.repository, info, environment: named, named: true };
        const target = await this.repositoryTargetFor(argument.repository, signIn);
        return { ...target, info: target.info ?? info };
      }
      case 'environment': {
        const environment = await registry.get(argument.environmentId);
        if (!environment) {
          this.inform(PipelineTexts.environmentMissing);
          return undefined;
        }
        return this.environmentTarget(environment);
      }
      case 'none': {
        if (pick === 'environment') {
          const environment = await this.pickEnvironment(placeholder);
          return environment ? this.environmentTarget(environment) : undefined;
        }
        let repositories = await sidebar.repositoriesForPicker();
        if (pick === 'gitHub') {
          repositories = repositories.filter((info) => sidebar.repositoryInfo(info.nameWithOwner) !== undefined);
        }
        if (repositories.length === 0) {
          this.inform(ControllerTexts.noRepositories);
          return undefined;
        }
        // The title "Open repository…" only where the pick opens the repository.
        const info = await pickRepository(repositories, placeholder, pick === 'open' ? undefined : null);
        return info ? this.repositoryTargetFor(info.nameWithOwner, signIn) : undefined;
      }
    }
  }

  private environmentTarget(environment: Environment): Target {
    return { repository: environment.repository, info: this.deps.sidebar.repositoryInfo(environment.repository), environment, named: true };
  }

  /**
   * The target of a repository, with the environment of the repository of the signed-in account, if it has one (concept
   * 7.5, D-3). The environments of other accounts are not looked at: they neither block nor name anything, and the first
   * Start of an account creates its own. The account decides the environment, so with `signIn` a sign-in is asked for
   * when nobody is signed in; without it, the target has no environment then. With `'token'` (a command that needs a
   * working token: Start, Switch branch…, Select configuration…) the account comes from a session with a working token,
   * so that the new sign-in while GitHub rejects the token happens before the environment is chosen: an account change
   * at that sign-in then chooses the environment of the new account.
   */
  private async repositoryTargetFor(repository: string, signIn: boolean | 'token'): Promise<Target> {
    const info = this.deps.sidebar.repositoryInfo(repository);
    const account = signIn === 'token' ? await this.readWorkingAccount() : await this.readAccount(signIn);
    if (signIn && !account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    const environment = account ? await this.deps.registry.findForAccount(repository, account.id) : undefined;
    return { repository, info, environment };
  }

  /**
   * The target with the current registry entry (for Try again, and after a change of the environment): a named
   * environment while it exists, otherwise the environment of the repository of the account that is signed in now, if
   * any. A repository never carries the environment of the account that was signed in before (D-3). `signIn` as for
   * `repositoryTargetFor`.
   */
  private async refreshedTarget(target: Target, signIn: boolean | 'token' = false): Promise<Target> {
    const current = target.named && target.environment ? await this.deps.registry.get(target.environment.id) : undefined;
    const fresh = current
      ? this.environmentTarget(current)
      : await this.repositoryTargetFor(target.environment?.repository ?? target.repository, signIn);
    return { ...fresh, info: fresh.info ?? target.info };
  }

  private requireEnvironment(target: Target | undefined): Environment | undefined {
    if (target && !target.environment) this.inform(Messages.noEnvironment(this.displayName(target)));
    return target?.environment;
  }

  /** `owner/name` as GitHub writes it, when known. */
  private displayName(target: Target): string {
    return (
      target.info?.nameWithOwner ??
      this.deps.sidebar.repositoryInfo(target.repository)?.nameWithOwner ??
      target.environment?.repository ??
      target.repository
    );
  }

  private async pickEnvironment(placeholder: string): Promise<Environment | undefined> {
    const { sidebar } = this.deps;
    const environments = await sidebar.availableEnvironments();
    if (environments.length === 0) {
      this.inform(ControllerTexts.noEnvironments);
      return undefined;
    }
    await this.renderQuietly();
    const items = recentEnvironments(sidebar.model(), environments).map((entry) => ({
      label: entry.state ? `$(${stateIcon(entry.state).id}) ${entry.repository}` : entry.repository,
      description: entry.description,
      environmentId: entry.environmentId,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true });
    return picked ? environments.find((environment) => environment.id === picked.environmentId) : undefined;
  }

  /**
   * Quick Pick of the branches (concept 6.2): the branches of GitHub load while the list is open; the current branch is
   * marked; a name that is not listed can be typed.
   */
  private pickBranch(
    repository: string,
    token: string,
    current: string | undefined,
    defaultBranch: string | undefined,
  ): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      const quickPick = vscode.window.createQuickPick<BranchItem>();
      let branches: string[] = [];
      let settled = false;
      const finish = (branch: string | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(branch);
        quickPick.hide();
      };
      const update = (): void => {
        if (settled) return;
        quickPick.items = branchChoices(branches, { current, defaultBranch, typed: quickPick.value }).map((choice) => ({
          label: choice.branch,
          description: choice.description,
          branch: choice.branch,
        }));
      };
      const subscriptions: vscode.Disposable[] = [
        quickPick.onDidChangeValue(update),
        quickPick.onDidAccept(() => {
          const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
          if (item) finish(item.branch);
        }),
        quickPick.onDidHide(() => {
          finish(undefined);
          for (const subscription of subscriptions) subscription.dispose();
          quickPick.dispose();
        }),
      ];
      quickPick.title = ControllerTexts.switchBranchTitle;
      quickPick.placeholder = ControllerTexts.branchPlaceholder(repository);
      quickPick.matchOnDescription = true;
      quickPick.busy = true;
      update();
      quickPick.show();
      this.deps.discovery
        .listBranches(repository, token)
        .then(
          (list) => {
            branches = list;
            update();
          },
          (error: unknown) => {
            this.logger.warn(`The branches of ${repository} could not be loaded: ${errorMessage(error)}`);
            if (!settled) quickPick.placeholder = ControllerTexts.branchesUnavailable;
          },
        )
        .finally(() => {
          if (!settled) quickPick.busy = false;
        })
        .catch((error: unknown) => this.logger.error('The branch list could not be shown.', error));
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Helpers

  /**
   * Runs an operation: at most one per environment in this window (a second request is ignored with a log line), errors
   * are shown with the action Try again where the concept offers it, and the sidebar is updated afterwards. Returns true
   * when the operation ran without an error.
   */
  private async operation(
    repository: string,
    label: string,
    fn: () => Promise<void>,
    options: { retry?: () => Promise<void> } = {},
  ): Promise<boolean> {
    await this.ready;
    try {
      const outcome = await this.gate.run(repositoryKey(repository), label, fn);
      if (!outcome.started) {
        this.logger.info(`${label} of ${repository} was not started: ${outcome.running} of ${repository} is still running.`);
        return false;
      }
      return true;
    } catch (error) {
      this.showError(error, options.retry);
      return false;
    } finally {
      if (!this.disposed) this.background(this.deps.sidebar.refreshStates(), 'update the sidebar');
    }
  }

  private showError(error: unknown, retry?: () => Promise<void>): void {
    presentError(error, { logger: this.logger, showLog: () => this.logger.show(), retry });
  }

  /** Renders the sidebar, so that pickers show current states. Never throws. */
  private async renderQuietly(): Promise<void> {
    await this.deps.sidebar
      .render()
      .catch((error: unknown) => this.logger.warn(`The sidebar could not be updated: ${errorMessage(error)}`));
  }

  private inform(message: string): void {
    vscode.window
      .showInformationMessage(message)
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  private warn(message: string): void {
    vscode.window
      .showWarningMessage(message)
      .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
  }

  private background(promise: Promise<unknown>, what: string): void {
    promise.catch((error: unknown) => this.logger.error(`Could not ${what}.`, error));
  }

  private async removeOperationQuietly(environmentId: string): Promise<void> {
    await this.deps.sessionFiles
      .removeOperation(environmentId)
      .catch((error: unknown) => this.logger.warn(`The pending operation could not be removed: ${errorMessage(error)}`));
  }

  private owner(): { windowId: string; pid: number } {
    return { windowId: this.deps.coordinator.windowId, pid: process.pid };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }
}
