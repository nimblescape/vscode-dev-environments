// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Controller (concept 6, 7.9–7.14): the commands of package.json and the flows of the window roles at activation. It
// connects the UI components (sidebar, status bar, switcher, progress, messages) with the environment service, the
// Session Coordinator, and the Connection Adapter.
import * as path from 'path';
import * as vscode from 'vscode';
import { isBlockingBusyMark } from '../core/busy';
import { attachDiagnostics } from '../core/docker/attachDiagnostics';
import { describeDockerHost, dockerHostOf, environmentsOfHost, isOnDockerHost } from '../core/docker/dockerHost';
import { ensureRemoteContext } from '../core/docker/remoteDocker';
import { operationDockerTarget, outsideOperation, type DockerTargets } from '../core/docker/dockerTargets';
import type { ContainerAdapter } from '../core/docker/containerAdapter';
import type { DiscoveryService } from '../core/discovery/discoveryService';
import { UserFacingError, errorMessage } from '../core/errors';
import { Actions, Messages, formatChanges, lastSeenInUse, listSome, recordedStateNote } from '../core/messages';
import { OP_TOKEN_REMOVE, parseTokenRemoveValue } from '../core/helperChannel/protocol';
import { HOST_ACCESS_CHECKS_OFF_SETTING, hostAccessChecks, withHostAccessChecks, type HostAccessChecks } from '../core/policy/hostAccessChecks';
import { repositoryFolder, splitRepository } from '../core/names';
import { availableEnvironments, isAvailableTo } from '../core/ownership';
import { isoTime, systemClock, type Clock, type ProgressReporter } from '../core/ports';
import { PipelineTexts, type EnvironmentService, type OpenResult } from '../core/pipeline/environmentService';
import { containerIsCurrent, isUnrestrictedContainer, repositoryServiceDataFolders } from '../core/pipeline/pipelineRules';
import type { EnvironmentRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
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
import { isProcessAlive, stopAfterSeconds } from '../core/session/sessionRules';
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
import { hideProgressNotification, runWithProgress, type BusyChange } from './progress';
import type { RemoteDockerCommands } from './remoteDockerCommands';
import type { RepositoryGroupsEditor } from './repositoryGroupsEditor';
import type { SessionCoordinator } from './sessionCoordinator';
import { RowActivationTracker, activatedRow, type ListOpenMode } from './rowActivation';
import { SETTINGS_SECTION, hostAccessChecksOffValue, readListOpenMode } from './settings';
import type { Sidebar } from './sidebar';
import type { EnvironmentStatusBar } from './statusBar';
import { pickRepository, showSwitcher } from './switcher';
import { CoalescingTask, OperationGate } from './tasks';
import {
  configurationChoices,
  parseCommandArgument,
  repositoryKey,
  repositoryTarget,
  type CommandArgument,
} from './targets';
import { TreeTexts, recentEnvironments, stateIcon } from './treeModel';
import { opensNewWindow, type WindowRequest } from './windowChoice';

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
/**
 * The whole token removal in the worker (plan step 11B1): the two tries of the flow (TOKEN_REMOVE_TIMEOUT_MS each) and
 * the requests around them.
 */
const TOKEN_REMOVAL_TIMEOUT_MS = 60_000;
/**
 * The reopen rule (concept 7.10) looks at the other windows. Windows that VS Code restores at the same start write their
 * status files during their own activation; this pause lets them do so first.
 */
const REOPEN_CHECK_DELAY_MS = 3_000;
/** A Delete that waits for the operation of another window reads the registry this often (concept 7.15). */
const BUSY_POLL_MS = 1_000;
/**
 * Unit 7, PR 2: set while this window is connected to an environment (Close and Keep Running in the Command Palette).
 */
export const CONNECTED_CONTEXT_KEY = 'devEnvironments.connected';

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
  /**
   * Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): runs a flow in the worker of the current engine
   * (`tokenRemove` first), with the HostSide of this computer answering its requests. Undefined only in tests that do not
   * exercise a flow.
   */
  flow?: (op: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>;
  service: EnvironmentService;
  discovery: DiscoveryService;
  auth: VsCodeGitHubAuth;
  connection: ConnectionAdapter;
  coordinator: SessionCoordinator;
  sidebar: Sidebar;
  statusBar: EnvironmentStatusBar;
  settings: () => ExtensionSettings;
  /** The Docker setup (concept 6.1 step 2): the commands of the setup in the sidebar. */
  dockerSetup: Pick<DockerSetup, 'install' | 'start' | 'installWsl' | 'show'>;
  /** The editor of the setting repositoryGroups (concept 6.2). */
  repositoryGroupsEditor: Pick<RepositoryGroupsEditor, 'open'>;
  /** True while the sidebar view is visible: only then Docker is asked outside of operations. */
  viewVisible: () => boolean;
  /**
   * Unit 7: the current Docker host, read at the start of each operation (the current Docker context). Default: the
   * local Docker.
   */
  dockerTargets?: Pick<DockerTargets, 'resolve' | 'current' | 'withOperation'>;
  /** Unit 7: "Use a Remote Docker Host…", "Use the Local Docker", and the switch back of a restored window. */
  remoteDocker?: Pick<RemoteDockerCommands, 'useRemoteHost' | 'useLocalDocker' | 'chooseDockerHost' | 'askAgain' | 'offerSwitchBack'>;
  /**
   * Unit 7, PR 2: one heartbeat with the current keep-running flag of an environment to the Session Monitor container of
   * its engine (Close and Keep Running, Keep Running When Closed, Stop When Closed). Plan step 8, PR A: on every engine,
   * through this window's worker (WindowHeartbeats.sendFor; its `seq` is the time before it reads the flags, so it is
   * later than the change in the registry). Without it, Close and Keep Running refuses.
   */
  sessionMonitor?: {
    sendHeartbeat(environmentId: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  };
  /** The VS Code setting `workbench.list.openMode` (double-click on a row, rowActivation.ts). Default: `readListOpenMode`. */
  listOpenMode?: () => ListOpenMode;
  /** True in an Extension Development Host (a debug run of this extension): the reopen rule of concept 7.10 is relaxed. */
  development?: boolean;
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
    /** User decision 2026-09-28: the pause between the checks of the container before the window connects. */
    readyPollMs?: number;
  };
}

/** User decision 2026-09-28: the checks of the container before the window connects (readyForWindow). */
const READY_CHECKS = 5;
const READY_POLL_MS = 1_000;
/** Review round 1 (F3): the longest wait for the log lines of the attach before the window connects. */
const ATTACH_DIAGNOSTICS_WAIT_MS = 3_000;

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
}

interface StartOptions {
  /**
   * The window that connects (concept 6.2): plain Start follows the setting openInNewWindow (default); Start in New
   * Window and Start in Current Window name it. Default: `default`.
   */
  window?: WindowRequest;
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

/** A flow that connects this window (numbered, see `connectingFlow`), or a new window. */
type ConnectRequest = { newWindow: false; number: number } | { newWindow: true };

type HandOffRequest = Pick<PendingOperation, 'operation' | 'reason' | 'configPath' | 'additionalVolumesToRemove'>;

/** What a command without argument asks for: `open` is a repository that the command opens (Start). */
type PickKind = 'open' | 'repository' | 'environment' | 'gitHub';

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
  /** Numbers the flows that connect this window (see `connect`). */
  private connectRequests = 0;
  /** The connecting flows that still run. */
  private readonly activeConnectRequests = new Set<number>();
  /** One check of the disconnect requests at a time; a change during a check runs one more check. */
  private readonly disconnectTask = new CoalescingTask(() => this.checkDisconnectRequest());
  private disconnectWatcher: { dispose(): void } | undefined;
  private disposed = false;
  /** The last value of CONNECTED_CONTEXT_KEY (unit 7, PR 2). */
  private connectedContext: boolean | undefined;
  /** Tells a double-click on a repository row from a single click (rowActivated). */
  private readonly rowActivations: RowActivationTracker;

  constructor(private readonly deps: ControllerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.isAlive = deps.isAlive ?? isProcessAlive;
    this.rowActivations = new RowActivationTracker(this.clock);
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

  /** Registers the 31 commands of package.json. A command never rejects: errors are shown (concept 6.5). */
  registerCommands(): vscode.Disposable[] {
    const handlers: Record<CommandName, (argument: unknown) => Promise<void>> = {
      start: (argument) => this.start(parseCommandArgument(argument)),
      startInNewWindow: (argument) => this.start(parseCommandArgument(argument), 'newWindow'),
      startInCurrentWindow: (argument) => this.start(parseCommandArgument(argument), 'currentWindow'),
      stop: (argument) => this.stop(parseCommandArgument(argument)),
      delete: (argument) => this.delete(parseCommandArgument(argument)),
      selectConfiguration: (argument) => this.selectConfiguration(parseCommandArgument(argument)),
      rebuild: (argument) => this.rebuild(parseCommandArgument(argument)),
      showOnGitHub: (argument) => this.showOnGitHub(parseCommandArgument(argument)),
      switchEnvironment: () => this.switchEnvironment(),
      switchEnvironmentInNewWindow: () => this.switchEnvironment('newWindow'),
      switchEnvironmentInCurrentWindow: () => this.switchEnvironment('currentWindow'),
      refresh: () => this.refresh(),
      search: () => this.search(),
      showLog: async () => this.logger.show(),
      signIn: () => this.signIn(),
      selectOwners: () => this.selectOwners(),
      selectOwnersFiltered: () => this.selectOwners(),
      editRepositoryGroups: () => this.deps.repositoryGroupsEditor.open(),
      turnOffHostAccessChecks: (argument) => this.turnOffHostAccessChecks(parseCommandArgument(argument)),
      turnOnHostAccessChecks: (argument) => this.turnOnHostAccessChecks(parseCommandArgument(argument)),
      keepRunning: (argument) => this.setKeepRunning(parseCommandArgument(argument), true),
      stopWhenClosed: (argument) => this.setKeepRunning(parseCommandArgument(argument), false),
      closeAndKeepRunning: () => this.closeAndKeepRunning(),
      dockerSetupInstall: () => this.deps.dockerSetup.install(),
      dockerSetupStart: () => this.deps.dockerSetup.start(),
      dockerSetupInstallWsl: () => this.deps.dockerSetup.installWsl(),
      dockerSetupShow: () => this.deps.dockerSetup.show(),
      useRemoteDockerHost: async () => this.deps.remoteDocker?.useRemoteHost(),
      useLocalDocker: async () => this.deps.remoteDocker?.useLocalDocker(),
      chooseDockerHost: async () => this.deps.remoteDocker?.chooseDockerHost(),
      askAgainDockerHost: async () => this.deps.remoteDocker?.askAgain(),
      rowActivated: (argument) => this.rowActivated(argument),
      showProgressDetails: async (argument) => {
        this.logger.show();
        hideProgressNotification(argument);
      },
    };
    // Unit 7: each command is one operation on the Docker host that is current when it starts; the two commands that
    // change the host read it themselves. A click on a row is no operation: only the Start of a double-click is one.
    const ownTarget = new Set<CommandName>(['useRemoteDockerHost', 'useLocalDocker', 'chooseDockerHost', 'askAgainDockerHost', 'rowActivated', 'showProgressDetails']);
    const run = async (name: CommandName, argument: unknown): Promise<void> => {
      try {
        if (ownTarget.has(name)) await handlers[name](argument);
        else await this.withDockerTarget(() => handlers[name](argument));
      } catch (error) {
        this.showError(error);
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
    // Unit 7: an environment of another Docker host (for example a window of Open Recent after a switch, or Docker
    // Desktop reset the context) is used only after the user switched back; otherwise the window closes its connection.
    if (!(await this.onWindowHost(environment))) return;
    await this.withDockerTarget(() => this.openAttachedEnvironment(environment, containerName, pending));
  }

  private async openAttachedEnvironment(
    environment: Environment,
    containerName: string,
    pending: PendingConnection | undefined,
  ): Promise<void> {
    this.current = { environment, containerName, lost: false };
    this.updateStatusBar();
    // Unit 7, PR 2: a window connects again, so Close and Keep Running has done its work.
    await this.clearKeepRunningOnce(environment.id);
    // Concept 7.5: an account change while the window checked its environment found no
    // environment of this window yet. Check the account again now that the window has one; the window leaves (and the
    // token file is removed) when the environment is not the account's.
    if (!(await this.stillAvailable(environment))) return;
    const repository = this.displayName({ repository: environment.repository });
    if (pipelineJustRan(pending, environment.id, this.clock.now())) {
      this.logger.info(`The open pipeline of ${repository} has just run for this window.`);
    } else {
      this.logger.info(`This window was restored or reloaded. The open pipeline of ${repository} runs before it connects.`);
      // Assumption (V-2): activation through ATTACHED_CONTAINER_ACTIVATION_EVENT blocks the connection until
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
        // access policy refused the configuration, or the user cancelled). That container lacks the current setup, so
        // the window must not attach to it. A current container stays: it passed the policy when it was made. So does a
        // container that was made while the host access checks were off, when they are on now and the pipeline refused
        // the configuration: it must not be used as it is.
        const outdated = this.current?.environment.id === environment.id ? await this.containerOutdated(environment) : undefined;
        if (outdated) {
          this.logger.info(`${this.outdatedTexts(outdated, repository).log} It was not made again.`);
          await this.leaveEnvironment(this.outdatedTexts(outdated, repository).message, {
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
   *
   * `activatedAt`: the time at which the window's activation began (`activate()` passes it), taken before any await.
   * The age of the reopen record is measured at this time, not at the check: the awaits (the window status, the stale
   * claims, the operations, the GitHub account) and the pause of REOPEN_CHECK_DELAY_MS take several seconds, and a Close
   * Remote Connection whose empty window activates 2 to 3 seconds later must still count as younger than
   * REOPEN_MIN_AGE_MS (review finding F1 of PR #26).
   */
  async runEmptyWindowTasks(activatedAt: number = this.clock.now()): Promise<void> {
    await this.withDockerTarget(() => this.runEmptyWindowTasksNow(activatedAt));
  }

  private async runEmptyWindowTasksNow(activatedAt: number): Promise<void> {
    await this.ready;
    const { sessionFiles, coordinator, registry, connection } = this.deps;
    await sessionFiles
      .cleanupStaleClaims()
      .catch((error: unknown) => this.logger.warn(`Old claimed operations could not be removed: ${errorMessage(error)}`));
    // PR #76 review round 5 (A-R5-1), rule D1: an operation file that cannot be read is not run and not dropped, and the
    // user is told; the operations of the other environments still run (the files are per environment).
    let known: Awaited<ReturnType<typeof sessionFiles.readOperationsKnown>>;
    try {
      known = await sessionFiles.readOperationsKnown();
    } catch (error) {
      this.logger.warn(`The pending operations could not be read: ${errorMessage(error)}`);
      this.warn(ControllerTexts.pendingOperationsUnreadable(errorMessage(error)));
      return;
    }
    for (const { file, error } of known.unreadable) {
      const cause = `${path.basename(file)}: ${errorMessage(error)}`;
      this.logger.warn(`A pending operation could not be read: ${cause}`);
      this.warn(ControllerTexts.pendingOperationsUnreadable(cause));
    }
    const { runnable, stale } = sortPendingOperations(known.operations, this.clock.now());
    for (const operation of stale) {
      this.logger.info(`The pending ${operation.operation} of ${operation.environmentId} is too old and is dropped.`);
      await this.removeOperationQuietly(operation.environmentId);
    }
    const account = await this.readAccount();
    const dockerHost = await this.currentDockerHost();
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
      // Unit 7: nor one of an environment of another Docker host; it expires.
      if (target && !isOnDockerHost(target, dockerHost)) {
        this.logger.info(`The pending ${operation.operation} of ${operation.environmentId} is for another Docker host. It is not run.`);
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
    // Not known whether an operation is pending: the window is not opened again.
    if (runnable.length > 0 || known.unreadable.length > 0) return;

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
      otherConnectedWindows: others.filter((status) => status.environmentId !== null).length,
      pendingOperations: operations.length,
      record,
      // Concept 7.5: only an environment of the signed-in account is opened again; unit 7: of the current Docker host.
      environmentIds: new Set(
        availableEnvironments(environmentsOfHost(environments, dockerHost), account).map((environment) => environment.id),
      ),
      // The age of the record at activation (see `activatedAt`), not after the awaits and the pause.
      now: activatedAt,
      development: this.deps.development,
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
   * Concept 7.5 "registry lost": entries for the volumes with the label nimblescape.devenv.environment-id, when
   * registry.json is missing, not valid, or has invalid entries. Only when Docker runs; Docker is not started for this.
   */
  async reconcileIfRegistryLost(): Promise<void> {
    await this.withDockerTarget(() => this.reconcileIfRegistryLostNow());
  }

  private async reconcileIfRegistryLostNow(): Promise<void> {
    const { docker, service } = this.deps;
    // Also when registry.json exists but its content is lost (not valid, or invalid entries), not only when it is missing.
    if (!(await this.deps.registryNeedsRestore())) return;
    // Review D2: reconcileFromVolumes checks the Docker target first (never an endpoint that is neither local nor SSH),
    // then whether Docker runs; no `docker info` here before that check.
    if (!docker.isInstalled()) return;
    const added = await service.reconcileFromVolumes();
    if (added === 0) return;
    await this.adoptWindowEnvironment();
    await this.deps.sidebar.render();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands

  /**
   * Start (concept 6.2, 6.6, 7.6, 7.11). `window`: Start in New Window or Start in Current Window; plain Start follows the
   * setting openInNewWindow.
   */
  async start(argument: CommandArgument, window: WindowRequest = 'default'): Promise<void> {
    const target = await this.resolveTarget(argument, 'open', ControllerTexts.selectRepositoryToStart);
    if (target) await this.startTarget(target, { window });
  }

  /**
   * The command of a repository row (concept 6.2): VS Code runs it on a click, Enter, or Space in the row. A double-click
   * runs Start with the row, the same as its Start button (rowActivation.ts); a single click only selects the row.
   * Nothing happens where the row shows no Start: this window is connected to the environment, or it is updating.
   */
  async rowActivated(argument: unknown): Promise<void> {
    const row = activatedRow(argument);
    const parsed = parseCommandArgument(argument);
    if (!row || parsed.kind !== 'row') return;
    const openMode = (this.deps.listOpenMode ?? readListOpenMode)();
    if (!this.rowActivations.activate(row.id, openMode) || !row.canStart) return;
    // The row may be older than the connection of this window; a lost connection shows Start (Reconnect).
    if (parsed.environmentId !== undefined && this.current?.environment.id === parsed.environmentId && !this.current.lost) return;
    await this.withDockerTarget(() => this.start(parsed));
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

  /**
   * Keep Running When Closed (`keep`) and Stop When Closed (concept 7.9; user decision 2026-09-26, "go with the proposal
   * for closing"): writes the switch `keepRunning` of the environment into the registry (under its lock) and renders the
   * sidebar. The Session Monitor never stops a kept environment; Stop and Delete still do, and Stop keeps the switch.
   * Nothing is started or stopped here: a kept environment whose container is stopped stays stopped, and one that is not
   * kept any more stops after the waiting time once no window uses it.
   */
  async setKeepRunning(argument: CommandArgument, keep: boolean): Promise<void> {
    const placeholder = keep ? ControllerTexts.selectEnvironmentToKeepRunning : ControllerTexts.selectEnvironmentToStopWhenClosed;
    const target = await this.resolveTarget(argument, 'environment', placeholder);
    const environment = this.requireEnvironment(target);
    if (!target || !environment) return;
    const repository = this.displayName(target);
    const updated = await this.deps.registry.updateEnvironment(environment.id, (current) => {
      if (keep) current.keepRunning = true;
      else delete current.keepRunning;
    });
    if (!updated) {
      this.inform(PipelineTexts.environmentMissing);
      return;
    }
    this.logger.info(keep ? `${repository} keeps running when no window uses it.` : `${repository} stops when no window uses it.`);
    await this.renderQuietly();
    // Plan step 8, PR A: the Session Monitor of the engine learns the choice at once, on every engine (it keeps or stops
    // the container when no window sends heartbeats). The choice stays stored when it fails; a window that uses the
    // environment tells it at its next heartbeat.
    const sent = (await this.deps.sessionMonitor?.sendHeartbeat(environment.id)) ?? { ok: true as const };
    if (!sent.ok) {
      this.logger.warn(`The Session Monitor could not be told that ${repository} ${keep ? 'keeps running' : 'stops'} when closed: ${sent.detail}`);
      this.warn(ControllerTexts.keepRunningNotSent(repository));
      return;
    }
    // With the setting stopOnClose off, every environment keeps running already; say so instead of a promise that the
    // environment stops.
    if (!keep && this.deps.settings().stopOnClose === false) this.inform(ControllerTexts.keepAllRunning);
    else this.inform(keep ? ControllerTexts.keptRunning(repository) : ControllerTexts.stopsWhenClosed(repository));
  }

  /**
   * Close and Keep Running (unit 7, PR 2): closes this window, and the container of its environment keeps running this
   * time. It sets `keepRunningOnce` in the registry (under its lock), which the Session Monitor treats like Keep Running
   * When Closed until a window connects again, or Stop or Delete. One heartbeat with the keep-running flag goes to the
   * Session Monitor container of its engine first (plan step 8, PR A: on every engine), so that it keeps the container
   * also when this computer goes offline; when it fails, the flag is cleared again, an error says so, and the window stays
   * open. The flag stays until the next open or attach of the environment, or Stop or Delete, also when the user
   * cancels the close (the dialog about unsaved files): `workbench.action.closeWindow` resolves when the close starts,
   * not after that dialog, so the window cannot tell (review round 1 of PR #39, F1). A cancelled close leaves the
   * environment kept until then: the safe side.
   */
  async closeAndKeepRunning(): Promise<void> {
    const current = this.current;
    if (!current) {
      this.inform(ControllerTexts.closeAndKeepRunningNotConnected);
      return;
    }
    const environment = current.environment;
    const repository = this.displayName({ repository: environment.repository });
    // Plan step 8, PR A: on every engine (before: only for a remote host); the heartbeat goes to the engine of the
    // environment, so Docker must still be set to it.
    const host = dockerHostOf(environment);
    const currentHost = await this.currentDockerHost();
    if (currentHost !== host) {
      this.warn(Messages.otherDockerHost(repository, host, currentHost));
      return;
    }
    const updated = await this.deps.registry.updateEnvironment(environment.id, (entry) => {
      entry.keepRunningOnce = true;
    });
    if (!updated) {
      this.inform(PipelineTexts.environmentMissing);
      return;
    }
    const sent = (await this.deps.sessionMonitor?.sendHeartbeat(environment.id)) ?? {
      ok: false as const,
      detail: 'The Session Monitor is not available in this window.',
    };
    if (!sent.ok) {
      this.logger.warn(`Close and Keep Running: the heartbeat to the Session Monitor on ${host === '' ? 'the local Docker' : host} failed: ${sent.detail}`);
      await this.clearKeepRunningOnce(environment.id);
      const minutes = Math.round(stopAfterSeconds(this.deps.settings().stopAfterMinutes) / 60);
      vscode.window
        .showErrorMessage(ControllerTexts.closeAndKeepRunningUnreachable(host, minutes))
        .then(undefined, (error: unknown) => this.logger.error('Could not show the message.', error));
      return;
    }
    this.logger.info(`${repository} keeps running this time. The window closes.`);
    await this.deps.connection.closeWindow();
  }

  /** Unit 7, PR 2: removes `keepRunningOnce` (a window connected again, or the heartbeat failed). Never throws. */
  private async clearKeepRunningOnce(environmentId: string): Promise<void> {
    try {
      if ((await this.deps.registry.get(environmentId))?.keepRunningOnce === undefined) return;
      await this.deps.registry.updateEnvironment(environmentId, (entry) => {
        delete entry.keepRunningOnce;
      });
    } catch (error) {
      this.logger.warn(`Close and Keep Running could not be cleared: ${errorMessage(error)}`);
    }
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
        // User decision 2026-10-02 ("No git needs delete. ... we may flag uncommitted changes though, but that does not
        // hinder deletion."): the summary is the recorded Git state (refreshed when the dev container runs); changes in it
        // are named with "Delete anyway". Without a summary (nothing recorded, or the volume is missing), the plain
        // confirmation follows at once. Either way the user can delete.
        const changes = summary ? formatChanges(summary) : '';
        // Review round 1 of PR #87 (A-R1-4): the state is recorded when the dev container runs (here, and when a window
        // releases the environment), but not when that failed or the Session Monitor stopped it by the long limit. When
        // the state is older than the last use of the environment (or none was recorded), the dialog says that later
        // changes are not known. Only a message: Delete runs nothing in the container for it.
        // Review round 2 of PR #87 (A-R2-2): the last use is the last time a window was seen using it (lastSeenInUse: also
        // a reload and the start of a release, not only the open pipeline).
        const used = (await this.deps.registry.get(environment.id).catch(() => undefined)) ?? environment;
        const stateNote = recordedStateNote(summary ?? used.gitSummary, lastSeenInUse(used));
        // Review round 9 (D9-2): the data of services in folders of the repository go with the workspace volume; the
        // confirmation names them, as the question about the data volumes of the services (D-19) names those.
        // Review round 11 (G3, G4): also the paths that the existing containers of the other services mount (for example
        // of an entry that was restored from its volumes, without a record).
        const repositoryData = [
          ...new Set([
            ...repositoryServiceDataFolders((await this.deps.registry.get(environment.id)) ?? environment),
            ...(await this.deps.service.repositoryServiceData(environment.id).catch(() => [])),
          ]),
        ];
        const repositoryDataText = repositoryData.length > 0 ? ` ${Messages.deleteRepositoryServiceData(listSome(repositoryData))}` : '';
        if (changes !== '') {
          const choice = await vscode.window.showWarningMessage(
            `${Messages.deleteUnsaved(repository, changes)}${stateNote}${repositoryDataText}${otherWindow}`,
            { modal: true },
            Actions.openEnvironment,
            Actions.deleteAnyway,
          );
          if (choice === Actions.openEnvironment) openInstead = true;
          if (choice !== Actions.deleteAnyway) return;
        } else {
          const choice = await vscode.window.showWarningMessage(
            `${Messages.deleteConfirm(repository)}${stateNote}${repositoryDataText}${otherWindow}`,
            { modal: true },
            Actions.delete,
          );
          if (choice !== Actions.delete) return;
        }
        const confirmed = (await this.deps.registry.get(environment.id)) ?? environment;
        // Only the volumes that Delete would remove (their labels make them the environment's own); the others are kept
        // anyway, with a line in the log, so the question does not offer them.
        const volumes = (confirmed.additionalVolumes ?? []).length > 0 ? await this.deps.service.removableAdditionalVolumes(confirmed.id) : [];
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
        // D-19: the volumes of a Docker Compose project hold the data of its services (for example a database). They are
        // listed apart, none ticked: only the ticked ones are removed, and Escape cancels the Delete.
        const serviceData = (confirmed.additionalVolumes ?? []).length > 0 ? await this.deps.service.removableServiceDataVolumes(confirmed.id) : [];
        if (serviceData.length > 0) {
          // Review round 3 (P3-4): an environment whose services are not known lists its additional volumes as possible data.
          const possibly = await this.deps.service.possibleServiceDataVolumes(confirmed.id);
          const placeHolder = possibly.length > 0 ? Messages.deleteServiceDataPossiblePlaceholder : Messages.deleteServiceDataPlaceholder;
          const picked = await vscode.window.showQuickPick(
            serviceData.map((name) => ({
              label: name,
              description: possibly.includes(name) ? Messages.deleteServiceDataPossibleItem : Messages.deleteServiceDataItem,
              picked: false,
            })),
            { title: Messages.deleteServiceDataTitle, placeHolder, canPickMany: true, ignoreFocusOut: true },
          );
          if (picked === undefined) return;
          additionalVolumesToRemove = [...additionalVolumesToRemove, ...picked.map((item) => item.label)];
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
    const target = await this.resolveTarget(argument, 'repository', ControllerTexts.selectRepositoryForConfiguration);
    if (!target) return;
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
      await this.startTarget(target, { configPath, window: 'currentWindow' }, async () =>
        this.applyConfiguration(await this.refreshedTarget(target, 'token'), configPath),
      );
      return;
    }
    if (configPath === environment.configPath) {
      this.logger.info(`${this.displayName(target)} uses the configuration ${configPath} already.`);
      return;
    }
    await this.rebuildEnvironment(target, environment, { reason: 'configurationSelected', configPath });
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

  /**
   * Switch Environment… (concept 6.4): the selected environment or repository opens in this window, or in a new window
   * (Switch Environment in New Window…, or the setting openInNewWindow).
   */
  async switchEnvironment(window: WindowRequest = 'default'): Promise<void> {
    const { registry, sidebar } = this.deps;
    // Only the environments and the repositories of the signed-in account (concept 7.5).
    const [environments, repositories] = await Promise.all([sidebar.availableEnvironments(), sidebar.repositoriesForPicker()]);
    if (environments.length === 0 && repositories.length === 0) {
      this.inform(ControllerTexts.noRepositories);
      return;
    }
    await this.renderQuietly();
    const newWindow = this.opensNewWindow(window);
    const choice = await showSwitcher({ groups: sidebar.model(), environments, repositories, newWindow });
    if (!choice) return;
    if (choice.kind === 'environment') {
      const environment = await registry.get(choice.environmentId);
      if (!environment) {
        this.inform(PipelineTexts.environmentMissing);
        return;
      }
      const target = await this.ownTarget(this.environmentTarget(environment));
      if (target) await this.startTarget(target, { window });
      return;
    }
    await this.startTarget(await this.repositoryTargetFor(choice.repository.nameWithOwner, 'token'), { window });
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

  /**
   * Turn Off Host Access Checks… (concept section 9 "Host access", user request 2026-09-26): after a modal warning that
   * names what the configuration of the repository can then use, the repository joins the user setting
   * devEnvLauncher.hostAccessChecksOff. The next open of its environment applies it.
   */
  async turnOffHostAccessChecks(argument: CommandArgument): Promise<void> {
    const names = await this.hostAccessNames(argument);
    if (!names) return;
    const { repository, key } = names;
    const settings = this.deps.settings();
    // The state that the pipeline applies: the switch under its key (review finding R2-1).
    if (hostAccessChecks(key, settings) === 'off') {
      this.inform(Messages.hostAccessChecksTurnedOff(repository));
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      Messages.hostAccessChecksOffConfirm(repository),
      { modal: true, detail: Messages.hostAccessChecksOffDetail },
      Actions.turnOffChecks,
    );
    if (choice !== Actions.turnOffChecks) return;
    await this.writeHostAccessChecks([key], 'off');
    this.logger.warn(`The host access checks were turned off for ${repository}. They apply from the next creation of its container.`);
    this.inform(Messages.hostAccessChecksTurnedOff(repository));
  }

  /**
   * Turn On Host Access Checks: the repository leaves the user setting devEnvLauncher.hostAccessChecksOff (no question),
   * under every name it has here (the name on GitHub and the name in the registry, which differ after a rename or a
   * transfer). At the next open, the checks run again, and a container that was created without them is created again
   * when the configuration passes them (containerIsCurrent).
   */
  async turnOnHostAccessChecks(argument: CommandArgument): Promise<void> {
    const names = await this.hostAccessNames(argument);
    if (!names) return;
    await this.writeHostAccessChecks(names.all, 'on');
    this.logger.info(`The host access checks were turned on again for ${names.repository}. They apply from the next open of its environment.`);
    this.inform(Messages.hostAccessChecksTurnedOn(names.repository));
  }

  /**
   * The names of a row or an environment for the switch of the host access checks (review finding A1): `repository` for
   * the messages (the name the sidebar shows), `key` the name the open pipeline reads the switch under (the registry name
   * of the environment when there is one), and `all` every name involved (after a rename or a transfer on GitHub the
   * registry keeps the old name). None without an argument.
   */
  private async hostAccessNames(
    argument: CommandArgument,
  ): Promise<{ repository: string; key: string; all: string[] } | undefined> {
    if (argument.kind === 'row') {
      const environment = argument.environmentId !== undefined ? await this.deps.registry.get(argument.environmentId) : undefined;
      const key = environment?.repository ?? argument.repository;
      return { repository: argument.repository, key, all: uniqueNames([argument.repository, key]) };
    }
    if (argument.kind === 'environment') {
      const environment = await this.deps.registry.get(argument.environmentId);
      if (!environment) {
        this.inform(PipelineTexts.environmentMissing);
        return undefined;
      }
      const repository = this.displayName({ repository: environment.repository });
      return { repository, key: environment.repository, all: uniqueNames([environment.repository, repository]) };
    }
    this.logger.info('The switch of the host access checks needs a repository row.');
    return undefined;
  }

  /**
   * Writes the switch of `repositories` into the user setting devEnvLauncher.hostAccessChecksOff (ConfigurationTarget.Global:
   * the setting has the scope `application`, so no workspace or folder can turn a check off). The other entries stay.
   */
  private async writeHostAccessChecks(repositories: readonly string[], checks: HostAccessChecks): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    let value: unknown = hostAccessChecksOffValue(configuration);
    for (const repository of repositories) value = withHostAccessChecks(value, repository, checks);
    const entries: unknown[] = Array.isArray(value) ? value : [];
    await configuration.update(HOST_ACCESS_CHECKS_OFF_SETTING, entries.length > 0 ? entries : undefined, vscode.ConfigurationTarget.Global);
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
   * Start flow (concept 6.2, 6.6, 7.6, 7.11): the open pipeline, then the connection of this window or of a new window
   * (`options.window`, windowChoice.ts). The window stays connected to its previous environment while the pipeline runs
   * (a switch is the same flow); with a new window, it keeps its environment afterwards too.
   * An environment that another window uses is never opened a second time: that window is shown instead.
   */
  /** `retry`: Try again after a failure; by default a Start of the target again (a first open of a command sets its own). */
  private async startTarget(target: Target, options: StartOptions = {}, retry?: () => Promise<void>): Promise<void> {
    const { service, connection } = this.deps;
    const environment = target.environment;
    const repository = this.displayName(target);
    let reconnecting = false;
    let otherWindow: WindowStatus | undefined;
    if (environment) {
      if (this.isConnectedHere(environment)) {
        // "Already connected → nothing" only while the container runs; otherwise this is Reconnect (concept 6.3, 7.12).
        const containerName = this.current?.containerName ?? environment.containerName;
        if (await this.containerRuns(containerName)) {
          // Concept section 9: a container of an older version lacks the current setup. The pipeline must not
          // replace it under this window, so the window leaves it; a Start from the empty window makes a new container.
          // The same for a container made while the host access checks were off, when they are on now.
          const outdated = await this.containerOutdated(environment);
          if (outdated) {
            this.logger.info(this.outdatedTexts(outdated, repository).log);
            await this.leaveEnvironment(this.outdatedTexts(outdated, repository).message, {
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
      } else if ((otherWindow = await this.otherWindowOf(environment.id))) {
        if (await this.containerRuns(environment.containerName)) {
          // The pipeline must not replace the container under the other window (an update would disconnect it).
          // Assumption (V-2): VS Code shows the window that has this folder open instead of opening it again (concept 7.11).
          // Also for Start in New Window: never two windows on one environment.
          this.logger.info(`${repository} is open in another window. That window is shown.`);
          const folder = environment.remoteWorkspaceFolder ?? repositoryFolder(environment.repository);
          // A request for a new window never replaces the current window, also if VS Code does not find the other one.
          const args = this.otherWindowArgs(environment, folder, otherWindow);
          if (this.opensNewWindow(options.window ?? 'default', false)) await connection.openInNewWindow(...args);
          else await connection.open(...args);
          return;
        }
        // Concept 6.2 "Stopped: the next Start starts it": the other window has lost its connection, so the container
        // can be started (or replaced) as usual. The connection then shows the other window (V-2), which connects again.
        this.logger.info(
          `The container of ${repository} does not run. The connection of the other window is lost; the environment starts.`,
        );
      }
    }
    const newWindow = this.opensNewWindow(options.window ?? 'default', reconnecting);
    const started = await this.operation(
      repository,
      'Start',
      () =>
        runWithProgress({
          title: Messages.opening(repository),
          repository,
          cancellable: true,
          task: (progress, signal) =>
            this.connectingFlow(newWindow, async (request) => {
              let result: OpenResult;
              if (environment) {
                result = await service.openEnvironment(environment.id, { progress, signal, configPath: options.configPath });
              } else {
                const trusted = await this.firstOpenTrust(repository);
                result = await service.open(repositoryTarget(repository, target.info, trusted), {
                  progress,
                  signal,
                  configPath: options.configPath,
                });
              }
              await this.connect(result, progress, request, signal);
            }),
        }),
      // Try again is a Start: a repository takes the account of a session with a working token, as at the first try; it
      // opens in the same kind of window as the first try.
      { retry: retry ?? (async () => this.startTarget(await this.refreshedTarget(target, 'token'), { window: options.window })) },
    );
    // Reconnect: "Delete environment" for missing files (concept 7.12) removed the environment of this window.
    if (!started && reconnecting && environment) await this.leaveDeletedEnvironment(environment.id);
  }

  /**
   * True if a Start with this request opens a new window (windowChoice.ts): the setting openInNewWindow, and whether this
   * window is empty or reconnects its own environment.
   */
  private opensNewWindow(request: WindowRequest, reconnecting = false): boolean {
    return opensNewWindow({
      request,
      openInNewWindow: this.deps.settings().openInNewWindow === true,
      emptyWindow: this.deps.connection.isEmptyWindow(),
      reconnecting,
    });
  }

  /**
   * Runs a flow that ends by connecting this window, with its number for `connect`. A flow that connects a new window
   * (`newWindow`) leaves this window as it is: it is not one of the connecting flows of this window, so it neither skips
   * nor is skipped by them.
   */
  private async connectingFlow<T>(newWindow: boolean, fn: (request: ConnectRequest) => Promise<T>): Promise<T> {
    if (newWindow) return fn({ newWindow: true });
    const request = ++this.connectRequests;
    this.activeConnectRequests.add(request);
    try {
      return await fn({ newWindow: false, number: request });
    } finally {
      this.activeConnectRequests.delete(request);
    }
  }

  /**
   * Last step of the pipeline (concept 7.6): the pending connection file, then the folder URI in this window.
   * A flow does not connect while a newer connecting flow runs in this window, for example the automatic reopen of
   * concept 7.10 after the user selected another environment: the newest request wins, also when the older pipeline
   * finishes first. The skipped environment's container stops after the long limit of the heartbeats of its open
   * (stopAfterMinutes; review round 1 of PR #87, A-R1-6).
   * Cancel in the progress notification also counts when the pipeline has finished its last step already: the window
   * stays as it is (concept 7.10 #2: "[Cancel] lets the user stay in the empty window").
   *
   * A new window (Start in New Window, concept 6.2, 7.9): the pending connection file (written with the ID of this
   * window, the window that ran the pipeline) keeps the container in use until the new window has written its status
   * file; the new window finds the fresh file at its activation, so it does not run the pipeline again (role A,
   * `pipelineJustRan`), and removes it. This window keeps its own environment, status file, and reopen record.
   */
  private async connect(result: OpenResult, progress: ProgressReporter, request: ConnectRequest, signal: AbortSignal): Promise<void> {
    progress.step('connecting');
    // User decision 2026-09-28: the checks of the container come first, so Cancel, a newer request, and an account
    // change during them still keep the window as it is (review round 1, F1). The log lines of the attach run meanwhile.
    const diagnostics = this.logAttachDiagnostics(result.containerName);
    const notReady = await this.readyForWindow(result.environment, result.containerName, signal);
    const waited = new AbortController();
    // Review round 2 (G2): Cancel also ends this wait.
    await Promise.race([diagnostics, this.delay(ATTACH_DIAGNOSTICS_WAIT_MS, AbortSignal.any([waited.signal, signal]))]);
    waited.abort();
    if (!request.newWindow && [...this.activeConnectRequests].some((other) => other > request.number)) {
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
      // No window connects: the Session Monitor container stops it when the heartbeats of the open end (their long limit,
      // plan step 8 PR C).
      await this.deps.sessionFiles
        .removePending(result.environment.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw account
        ? new UserFacingError('otherAccount', Messages.otherAccount(repository))
        : new UserFacingError('signInRequired', Messages.signInRequired);
    }
    if (notReady) {
      // Review round 1 (F2): without the pending connection file, the container stops as usual: after the long limit of the
      // heartbeats of its open (stopAfterMinutes; review round 1 of PR #87, A-R1-6).
      await this.deps.sessionFiles
        .removePending(result.environment.id)
        .catch((error: unknown) => this.logger.warn(`The pending connection file could not be removed: ${errorMessage(error)}`));
      throw notReady;
    }
    await this.deps.coordinator.writePending(result.environment.id);
    if (request.newWindow) {
      await this.deps.connection.openInNewWindow(...(await this.windowArgs(result.environment, result.containerName, result.remoteWorkspaceFolder)));
      return;
    }
    await this.deps.connection.open(...(await this.windowArgs(result.environment, result.containerName, result.remoteWorkspaceFolder)));
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
    // PR #76 review round 4 (A-R4-1): only this environment's file, so an unreadable file of another environment does
    // not keep this hand-off. When this file cannot be read, its owner is not known (rule D1): it throws, and the hand-off
    // and the busy mark are kept (never removed without knowing whose request it is).
    const operation = await this.deps.sessionFiles.readOperation(environmentId);
    if (operation?.requestedBy !== this.deps.coordinator.windowId) return;
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
        additionalVolumesToRemove: request.operation === 'delete' ? (request.additionalVolumesToRemove ?? []) : undefined,
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
            () => this.deleteWithProgress(this.displayName(target), environment, operation.additionalVolumesToRemove ?? []),
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
            this.connectingFlow(false, async (request) => {
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
    // No pipeline runs here, so a container of an older version is not made again: the window leaves it (section 9), and
    // so it does a container made while the host access checks were off, when they are on now.
    const outdated = await this.containerOutdated(environment);
    if (outdated) {
      const repository = this.displayName({ repository: environment.repository });
      this.logger.info(this.outdatedTexts(outdated, repository).log);
      await this.leaveEnvironment(this.outdatedTexts(outdated, repository).message, {
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
    // Unit 7, PR 2: a window connects again, so Close and Keep Running has done its work.
    await this.clearKeepRunningOnce(environment.id);
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
   * The window leaves its environment: no environment in its status file (plan step 8, PR C: the coordinator sends its
   * short release, and the Session Monitor container stops it after the waiting time unless it is kept), the status bar,
   * then "Close Remote Connection", with `message` for the user.
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
    if (left?.reason === 'account') this.background(this.removeGitToken(left), 'remove the GitHub token');
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
      if (left.reason === 'account') this.background(this.removeGitToken(left), 'remove the GitHub token');
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
    const environment = await this.deps.registry.get(left.environmentId).catch(() => undefined);
    if (this.left !== left || this.current || this.disposed) return false;
    if (!environment || !isAvailableTo(environment, account)) return false;
    this.left = undefined;
    this.logger.info(`The signed-in GitHub account may use ${left.repository} again. The window reloads to open it.`);
    await this.deps.connection.open(...(await this.windowArgs(environment, left.containerName, environment.remoteWorkspaceFolder ?? repositoryFolder(environment.repository))));
    return true;
  }

  /**
   * Concept 7.5: the token of the owner account leaves the environment that the signed-in account may not use, so that
   * Git and the GitHub CLI there cannot work as the owner while a window keeps its connection. Unit 15: the token is only
   * in the memory of the dev container, so it is removed from there when the container runs (plan step 11B1: the
   * operation `tokenRemove`, a flow of the worker, as root, or as the remote user of the entry when root may not); a stopped
   * container holds no token. The credential helper of the container then gives nothing; the next open of the owner
   * writes the token again (section 9). Best effort: the result is logged.
   */
  private async removeGitToken(left: LeftEnvironment): Promise<void> {
    const { containerName } = left;
    if (!this.deps.docker.isInstalled()) return;
    try {
      // Unit 7: never on another Docker host (its container is not on the current engine).
      const known = await this.deps.registry.get(left.environmentId).catch(() => undefined);
      if (known && !isOnDockerHost(known, await this.currentDockerHost())) {
        this.logger.info(`The container ${containerName} is on another Docker host. Its token is not removed from here.`);
        return;
      }
      // Plan step 11B1: the flow runs in the worker of the engine (its log lines come from there).
      if (this.deps.flow === undefined) {
        // Review round 1 of plan step 11B1 (A-R1-9): never silent.
        this.logger.warn(`The GitHub token could not be removed from the container ${containerName}: this window runs no flow in a worker.`);
        return;
      }
      // Review round 1 of plan step 11B1 (A-R1-5): bounded, as the docker exec was before.
      const value = await this.deps.flow(OP_TOKEN_REMOVE, { environmentId: left.environmentId, containerName }, { timeoutMs: TOKEN_REMOVAL_TIMEOUT_MS });
      if (parseTokenRemoveValue(value) === undefined) throw new Error('The worker answered the token removal with an invalid value.');
    } catch (error) {
      this.logger.warn(`The GitHub token could not be removed from the container ${containerName}: ${errorMessage(error)}`);
    }
  }

  /**
   * Concept 7.5, role A and a restored registry: the environment that this window is attached to, when it belongs to the
   * signed-in account (a sign-in is asked for when needed). Otherwise
   * the window runs no pipeline, starts no container, and closes its remote connection with a message; `undefined`.
   * Assumption (V-8): the activation blocks the connection of a restored window (V-2), so the window of another account
   * never connects to a stopped container; a container that still runs is closed right after the connection.
   */
  private async ownWindowEnvironment(environment: Environment, containerName: string): Promise<Environment | undefined> {
    const account = await this.readAccount(true);
    if (account && isAvailableTo(environment, account)) return environment;
    const repository = this.displayName({ repository: environment.repository });
    let message: string;
    if (!account) {
      this.logger.info('Nobody is signed in to GitHub. The window closes its remote connection.');
      message = ControllerTexts.signedOutConnection(repository);
    } else {
      this.logger.info('This window is attached to an environment of another GitHub account. It closes its remote connection.');
      message = Messages.otherAccountConnection(repository);
    }
    await this.leaveEnvironment(message, { environmentId: environment.id, containerName, repository, reason: 'account' });
    return undefined;
  }

  /**
   * Sign-in, sign-out, or account change (concept 7.5): a window connected to an environment that the new account may
   * not use closes its remote connection at once. The Session Monitor container stops it after the waiting time (the
   * release of the window, plan step 8 PR C).
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
      {
        environmentId: environment.id,
        containerName: current.containerName,
        repository,
        reason: 'account',
      },
    );
  }

  /**
   * Why the container of the environment exists but must not be used as it is (concept section 9): `version`, it was
   * made by an older version of the extension (label nimblescape.devenv.container-version); `hostAccess`, it was made
   * while the host access checks of the repository were off, and they are on now (containerIsCurrent). `undefined`
   * otherwise, and when Docker cannot be asked. Never throws.
   */
  private async containerOutdated(environment: Environment): Promise<'version' | 'hostAccess' | undefined> {
    if (!this.deps.docker.isInstalled()) return undefined;
    try {
      const container = await this.deps.docker.findContainer(environment.id, environment.containerName);
      if (container === undefined) return undefined;
      const checks = hostAccessChecks(environment.repository, this.deps.settings());
      if (containerIsCurrent(container.labels, true, checks)) return undefined;
      return containerIsCurrent(container.labels, true, 'off') && isUnrestrictedContainer(container.labels) ? 'hostAccess' : 'version';
    } catch (error) {
      this.logger.info(`The container of the environment ${environment.id} could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** The message and the log line when the window leaves a container for the reason of containerOutdated. */
  private outdatedTexts(reason: 'version' | 'hostAccess', repository: string): { message: string; log: string } {
    return reason === 'hostAccess'
      ? {
          message: ControllerTexts.unrestrictedContainerClosed(repository),
          log: `The container of ${repository} was made while the host access checks were off, and they are on now. The window closes its remote connection.`,
        }
      : {
          message: ControllerTexts.outdatedContainerClosed(repository),
          log: `The container of ${repository} is of an older version. The window closes its remote connection.`,
        };
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

  /** The state of the container as Docker reports it, or why it could not be read. */
  private async containerStateText(containerName: string): Promise<string> {
    if (!this.deps.docker.isInstalled()) return 'Docker is not installed';
    try {
      return String(await this.deps.docker.containerState(containerName));
    } catch (error) {
      return `not readable: ${errorMessage(error)}`;
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
    this.updateConnectedContext(current !== undefined);
    if (!current) {
      statusBar.showNotConnected();
      return;
    }
    const repository = this.displayName({ repository: current.environment.repository });
    if (current.lost) statusBar.showConnectionLost(repository, current.environment.id);
    else statusBar.showConnected(repository, current.branch ?? current.environment.gitSummary?.branch ?? undefined);
  }

  /** Unit 7, PR 2: the context key CONNECTED_CONTEXT_KEY, set when it changes. */
  private updateConnectedContext(connected: boolean): void {
    if (this.connectedContext === connected) return;
    this.connectedContext = connected;
    Promise.resolve(vscode.commands.executeCommand('setContext', CONNECTED_CONTEXT_KEY, connected)).catch((error: unknown) =>
      this.logger.warn(`The context key ${CONNECTED_CONTEXT_KEY} could not be set: ${errorMessage(error)}`),
    );
  }

  private isConnectedHere(environment: Environment): boolean {
    return this.current?.environment.id === environment.id;
  }

  /** The status of another active window that is connected to the environment, if any (see otherActiveWindowsKnown). */
  private async otherWindowOf(environmentId: string): Promise<WindowStatus | undefined> {
    return (await this.otherActiveWindowsKnown()).find((window) => window.environmentId === environmentId);
  }

  /** Whether another active window is connected to the environment (see otherActiveWindowsKnown). */
  private async connectedInOtherWindow(environmentId: string): Promise<boolean> {
    return (await this.otherActiveWindowsKnown()).some((window) => window.environmentId === environmentId);
  }

  /**
   * The other active windows. Plan step 5, PR D (rule D1 of 2026-09-30): when their files cannot be read, it is not known
   * whether another window uses the environment, so the operation is refused (UserFacingError, otherWindowsUnknown) and
   * nothing is stopped, removed, or renamed; never "no other window".
   */
  private async otherActiveWindowsKnown(): Promise<WindowStatus[]> {
    try {
      return await this.deps.coordinator.otherActiveWindows();
    } catch (error) {
      this.logger.warn(`The other windows could not be read, so nothing is changed: ${errorMessage(error)}`);
      throw new UserFacingError('startFailed', ControllerTexts.otherWindowsUnknown, errorMessage(error));
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
   * Concept 7.5: the target, when its environment (if any) belongs to the signed-in account. Asks for a sign-in when the target has an environment and nobody is signed in. Otherwise
   * shows Messages.otherAccount and returns `undefined`: only an environment that the command names can be one of
   * another account (a row or the status bar item from before an account change), never the environment of a repository.
   */
  private async ownTarget(target: Target): Promise<Target | undefined> {
    const environment = target.environment;
    if (!environment) return target;
    const account = await this.readAccount(true);
    if (!account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    if (isAvailableTo(environment, account)) return target;
    this.logger.info(`The environment ${environment.id} belongs to another GitHub account. It is not used.`);
    this.warn(Messages.otherAccount(this.displayName(target)));
    return undefined;
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
    // Show on GitHub needs neither an environment nor a sign-in; Start and Select configuration… need a working token.
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
   * working token: Start, Select configuration…) the account comes from a session with a working token,
   * so that the new sign-in while GitHub rejects the token happens before the environment is chosen: an account change
   * at that sign-in then chooses the environment of the new account.
   */
  private async repositoryTargetFor(repository: string, signIn: boolean | 'token'): Promise<Target> {
    const info = this.deps.sidebar.repositoryInfo(repository);
    const account = signIn === 'token' ? await this.readWorkingAccount() : await this.readAccount(signIn);
    if (signIn && !account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    const environment = account
      ? await this.deps.registry.findForAccount(repository, account.id, await this.currentDockerHost())
      : undefined;
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
      const outcome = await this.gate.run(repositoryKey(repository), label, () => this.withDockerTarget(fn));
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

  /** Unit 7: runs `fn` as one operation on the Docker host that is current now (DockerTargets.withOperation). */
  private withDockerTarget<T>(fn: () => Promise<T>): Promise<T> {
    return this.deps.dockerTargets ? this.deps.dockerTargets.withOperation(fn) : fn();
  }

  /** Unit 7: the Docker host of the operation ('' = the local Docker). */
  private async currentDockerHost(): Promise<string> {
    return this.deps.dockerTargets ? (await this.deps.dockerTargets.current()).host : '';
  }

  /**
   * Unit 7: a restored window whose environment is on another Docker host than the current Docker context asks "Use
   * <host> again?" (RemoteDockerCommands.offerSwitchBack: the same test and modal as the commands). True when Docker uses
   * the environment's host (then the open continues); otherwise the window closes its remote connection with the
   * message, and nothing runs on the other host. The pipeline of this extension runs on the current context; the Dev
   * Containers extension attaches through the context in the window's authority. Assumption (V-2): VS Code waits for
   * activate() before it resolves the authority.
   */
  private async onWindowHost(environment: Environment): Promise<boolean> {
    if (!this.deps.dockerTargets) return true;
    const current = await this.deps.dockerTargets.resolve();
    if (isOnDockerHost(environment, current.host)) return true;
    const environmentHost = dockerHostOf(environment);
    this.logger.info(
      `This window's environment is on ${describeDockerHost(environmentHost)}, and Docker is set to ${describeDockerHost(current.host)}.`,
    );
    const switched = (await this.deps.remoteDocker?.offerSwitchBack(environmentHost, current)) ?? false;
    if (switched) {
      const now = await this.deps.dockerTargets.resolve();
      if (isOnDockerHost(environment, now.host)) return true;
    }
    const repository = this.displayName({ repository: environment.repository });
    this.logger.info('The window closes its remote connection: its environment is on another Docker host.');
    await this.leaveEnvironment(Messages.otherDockerHost(repository, environmentHost, current.host));
    return false;
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

  /**
   * The arguments of ConnectionAdapter.open and openInNewWindow for `environment`: the container, the folder, and for an
   * environment on another Docker host its Docker context (user report 2026-09-28: without it in the authority, the Dev
   * Containers extension asks the local Docker first and reports the container as one that "no longer exists").
   * The context, in this order (review of the attach context, A1):
   * - the one of the running operation, when that is on the environment's host (a context that the user made; none when
   *   DOCKER_HOST decides);
   * - outside an operation, the one in the authority of this window when it shows the same container;
   * - the current context, when that is on the environment's host (read outside any operation);
   * - else the one that "Use a Remote Docker Host…" creates for the host (ensureRemoteContext: created when missing).
   */
  private async windowArgs(
    environment: Environment,
    containerName: string,
    folder: string,
  ): Promise<[containerName: string, folder: string, dockerContext?: string]> {
    const host = dockerHostOf(environment);
    if (host === '') return [containerName, folder];
    const withContext = (context: string | undefined): [string, string, string?] =>
      context === undefined ? [containerName, folder] : [containerName, folder, context];
    const target = operationDockerTarget();
    if (target && isOnDockerHost(environment, target.host)) return withContext(target.context);
    if (this.deps.connection.currentContainerName() === containerName) {
      const own = this.deps.connection.currentDockerContext();
      if (own !== undefined) return withContext(own);
    }
    const targets = this.deps.dockerTargets;
    if (targets) {
      const current = await outsideOperation(() => targets.resolve());
      if (isOnDockerHost(environment, current.host)) return withContext(current.context);
    }
    return withContext(await ensureRemoteContext(this.deps.docker, host));
  }

  /**
   * The arguments that show the other window `other` of `environment` (concept 7.11): exactly the URI of that window,
   * with the context of its status file (none for a window without one), so that VS Code finds it (review of the
   * attach context, A2). The status is the one read for the decision (round 2, B2: no second read).
   */
  private otherWindowArgs(environment: Environment, folder: string, other: WindowStatus): [containerName: string, folder: string, dockerContext?: string] {
    if (dockerHostOf(environment) === '' || other.dockerContext === undefined) return [environment.containerName, folder];
    return [environment.containerName, folder, other.dockerContext];
  }

  /**
   * Logs which Docker the Dev Containers extension will ask when the window switches to `containerName` (user request
   * 2026-09-28, attachDiagnostics.ts), with the context of the running operation (review round 1, F4). Only log lines;
   * never rejects.
   */
  private async logAttachDiagnostics(containerName: string): Promise<void> {
    try {
      if (!this.deps.docker.isInstalled()) return;
      const context = operationDockerTarget()?.context;
      const lines = await attachDiagnostics(this.deps.docker, this.deps.docker.processEnv(), containerName, context);
      for (const line of lines) this.logger.info(`Before the window connects: ${line}`);
    } catch (error) {
      this.logger.warn(`The Docker of the attach could not be logged: ${errorMessage(error)}`);
    }
  }

  /**
   * User decision 2026-09-28: the window connects only to a container that the Docker of the window finds running. The
   * Dev Containers extension of the window attaches through the Docker context in the window's authority (or, without one, the local Docker), and reports a container that it
   * does not find as one that "no longer exists". So right before the window connects: the current Docker context is
   * still on the host of the environment (another window or Docker Desktop may have changed it while the pipeline ran),
   * and the container answers as running (a few checks, 1 s apart, for an engine that answers late). Returns the error
   * of the refusal, or undefined when the window may connect. Stops early when `signal` aborts (the caller then reports
   * the cancel).
   */
  private async readyForWindow(environment: Environment, containerName: string, signal: AbortSignal): Promise<UserFacingError | undefined> {
    const repository = this.displayName({ repository: environment.repository });
    const targets = this.deps.dockerTargets;
    if (targets) {
      // Review round 3 (H1): the current context itself, not the one this operation is pinned to (DOCKER_CONTEXT).
      const current = await outsideOperation(() => targets.resolve());
      if (!isOnDockerHost(environment, current.host)) {
        const environmentHost = dockerHostOf(environment);
        this.logger.warn(
          `${repository} is not connected: Docker is set to ${describeDockerHost(current.host)} now, the container runs on ${describeDockerHost(environmentHost)}.`,
        );
        return new UserFacingError('otherDockerHost', Messages.otherDockerHostAfterStart(repository, environmentHost, current.host));
      }
    }
    // Review round 3 (H3): the last state that Docker reported goes into the log (Show details).
    let state = 'not read';
    for (let attempt = 1; attempt <= READY_CHECKS; attempt++) {
      if (signal.aborted) return undefined;
      state = await this.containerStateText(containerName);
      if (state === 'running') return undefined;
      if (attempt < READY_CHECKS) await this.delay(this.deps.timing?.readyPollMs ?? READY_POLL_MS, signal);
    }
    if (signal.aborted) return undefined;
    this.logger.warn(`${repository} is not connected: the container ${containerName} does not run (state: ${state}).`);
    return new UserFacingError('startFailed', Messages.containerNotReady(repository, containerName));
  }

  /** Waits `ms`; ends early when `signal` aborts, at once when it has aborted already (review round 2, G1). */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.timers.delete(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.timers.add(timer);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

/** The names without repeats (compared without case and surrounding spaces), in their order. */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
