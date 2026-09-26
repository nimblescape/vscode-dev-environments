// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker setup (concept 6.1 step 2, 7.3, section 9): the context keys of the welcome view, the Docker row, and the
// walkthrough "Set up Docker for Dev Environments", and the commands of the walkthrough. Nothing runs hidden: after a
// modal confirmation that lists the exact commands, they run in a visible terminal, or the installer of Docker Desktop is
// downloaded from desktop.docker.com with a progress notification and opened. The rules are pure functions in
// src/core/docker/dockerSetup.ts.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ContainerAdapter } from '../core/docker/containerAdapter';
import { findExecutable } from '../core/docker/dockerCli';
import { downloadFile, type DownloadOptions } from '../core/docker/dockerDownload';
import {
  DockerSetupTexts,
  INITIAL_DOCKER_SETUP_STATE,
  INSTALL_WATCH_INTERVAL_MS,
  LINUX_ENGINE_START_COMMAND,
  MISSING_CLI_CHECK_MS,
  DOCKER_APP_PATH,
  WSL_INSTALL_COMMAND,
  brewCaskroomFolder,
  changedContextValues,
  hardwareArch,
  installConfirmation,
  installPlan,
  keepWatchingInstall,
  needsMissingCliCheck,
  nextDockerSetupState,
  parseOsRelease,
  terminalConfirmation,
  terminalLines,
  type Confirmation,
  type DockerSetupEvent,
  type DockerSetupState,
  type InstallPlan,
  type InstallPlanInput,
  installTerminalOptions,
  namesDockerSource,
  quarantineAttribute,
  zoneIdentifier,
} from '../core/docker/dockerSetup';
import { ensureDockerRunning, launchDetachedProcess } from '../core/docker/dockerStart';
import { errorMessage, isUserFacingError } from '../core/errors';
import { Steps } from '../core/messages';
import { isAbortError, systemClock, type Clock, type Logger, type ProcessRunner } from '../core/ports';

/** The walkthrough of package.json (`contributes.walkthroughs`), with the ID of this extension (publisher.name). */
export const DOCKER_WALKTHROUGH_ID = 'nimblescape.vscode-dev-environments#dockerSetup';
// Internal VS Code command (not extension API): opens a walkthrough of the Welcome page. Arguments: the walkthrough ID
// (`publisher.extension#walkthrough`) and `toSide`.
export const OPEN_WALKTHROUGH_COMMAND = 'workbench.action.openWalkthrough';
/** Command of the walkthrough step "Start Docker" (package.json). */
export const DOCKER_SETUP_START_COMMAND = 'devEnvironments.dockerSetup.start';
/** Name of the terminal of the installation commands. */
export const INSTALL_TERMINAL_NAME = 'Install Docker';
const MAC_OPEN = '/usr/bin/open';
const XATTR = '/usr/bin/xattr';
const WSL_STATUS_TIMEOUT_MS = 15_000;
const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release'];

// User-visible texts that messages.ts lacks; to be moved there.
export const DockerSetupUiTexts = {
  /** A terminal of a remote window runs on the remote computer, not on this one. */
  localWindowNeeded: 'Open a local window to install Docker.',
  downloading: 'Downloading Docker Desktop',
  downloadProgress: (receivedMb: number, totalMb: number | undefined) =>
    totalMb === undefined ? `${receivedMb} MB` : `${receivedMb} of ${totalMb} MB`,
  downloadFailed: 'The installer of Docker Desktop could not be downloaded.',
  openFailed: (file: string) => `The installer could not be opened. Open it yourself: ${file}`,
  manualInstall: 'Dev Environments cannot install Docker on this computer by itself. The installation guide of Docker opens.',
  installedStartNow: 'Docker is installed. Start it now?',
  startDocker: 'Start Docker',
  dockerRunning: 'Docker is running.',
  showDetails: 'Show details',
  alreadyInstalled: 'Docker is already installed on this computer.',
  notMarked: (file: string) =>
    `The installer was downloaded, but it could not be marked as downloaded, so the system would not check its signature. It was not opened: ${file}`,
  wslAlreadyInstalled: 'WSL 2 is already installed on this computer.',
} as const;

export interface DockerSetupDeps {
  docker: ContainerAdapter;
  runner: ProcessRunner;
  logger: Logger;
  /** Opens the log (action Show details). */
  showLog: () => void;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The CLI was found or lost: the sidebar shows or hides the Docker row. */
  onDidChangeInstalled: () => void;
  /** For tests. Default: `readInstallPlanInput` (this computer). */
  planInput?: () => Promise<InstallPlanInput>;
  /** For tests. Default: the folder Downloads of the home folder. */
  downloadFolder?: string;
  /** For tests. Default: `downloadFile`. */
  download?: (options: DownloadOptions) => Promise<void>;
  /** For tests: starts a program without waiting for it (`/usr/bin/open` of the .dmg). Default: launchDetachedProcess. */
  launch?: (file: string, args: readonly string[]) => Promise<void>;
  /** For tests. Default: `ensureDockerRunning`. */
  startDocker?: (signal: AbortSignal, onStarting: () => void) => Promise<void>;
  clock?: Clock;
  /** For tests: MISSING_CLI_CHECK_MS and INSTALL_WATCH_INTERVAL_MS. */
  timing?: { missingCheckMs?: number; watchIntervalMs?: number };
}

/** What the installation plan needs to know about this computer. */
export async function readInstallPlanInput(
  runner: ProcessRunner,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<InstallPlanInput> {
  let translated = false;
  if (platform === 'darwin' && process.arch === 'x64') {
    // VS Code for Intel under Rosetta on a Mac with Apple silicon: Docker Desktop for Apple silicon is the right one.
    const result = await runner.run('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { timeoutMs: 5_000 }).catch(() => undefined);
    translated = result?.exitCode === 0 && result.stdout.trim() === '1';
  }
  let osRelease: Record<string, string> | undefined;
  let existingDockerSource = false;
  if (platform === 'linux') {
    existingDockerSource = await hasDockerAptSource();
    for (const file of OS_RELEASE_FILES) {
      try {
        osRelease = parseOsRelease(await fs.promises.readFile(file, 'utf8'));
        break;
      } catch {
        // The next file.
      }
    }
  }
  const brewPath = platform === 'darwin' ? findExecutable('brew', env, platform) : undefined;
  return {
    platform,
    arch: hardwareArch(platform, process.arch, translated),
    osRelease,
    // findExecutable also searches /opt/homebrew/bin and /usr/local/bin on macOS.
    has: (tool) => findExecutable(tool, env, platform) !== undefined,
    brewPath,
    ...(platform === 'darwin' ? readBrewCaskState(brewPath, fs.existsSync, env.HOMEBREW_CASK_OPTS, os.homedir()) : {}),
    userName: currentUserName(),
    existingDockerSource,
  };
}

/**
 * macOS: whether Homebrew records the cask docker-desktop (in the prefix of the `brew` that was found) and whether
 * Docker.app exists. Without a Homebrew the cask counts as not recorded. Docker.app counts as present in
 * /Applications, in ~/Applications, and in the folder of `--appdir` in HOMEBREW_CASK_OPTS: a cask installed with another
 * appdir must not be uninstalled as "missing" (that would quit Docker Desktop and remove a working app).
 */
export function readBrewCaskState(
  brewPath: string | undefined,
  exists: (file: string) => boolean = fs.existsSync,
  caskOpts?: string,
  home?: string,
): Pick<InstallPlanInput, 'brewCaskRecorded' | 'dockerAppPresent'> {
  return {
    brewCaskRecorded: brewPath !== undefined && exists(brewCaskroomFolder(brewPath)),
    dockerAppPresent: dockerAppLocations(caskOpts, home).some((location) => exists(location)),
  };
}

/** The places where a cask may have put Docker.app (see readBrewCaskState). */
export function dockerAppLocations(caskOpts: string | undefined, home: string | undefined): string[] {
  const expand = (folder: string) => (home && (folder === '~' || folder.startsWith('~/')) ? home + folder.slice(1) : folder);
  const locations = [DOCKER_APP_PATH];
  if (home) locations.push(`${home}/Applications/Docker.app`);
  const match = /(?:^|\s)--appdir(?:=|\s+)(["']?)([^"'\s]+)\1/.exec(caskOpts ?? '');
  if (match) locations.push(`${expand(match[2]).replace(/\/+$/, '')}/Docker.app`);
  return [...new Set(locations)];
}

function currentUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

/** True if a source of apt (sources.list, sources.list.d/*.list and *.sources) names download.docker.com. */
async function hasDockerAptSource(): Promise<boolean> {
  const files = ['/etc/apt/sources.list'];
  const folder = '/etc/apt/sources.list.d';
  try {
    for (const name of await fs.promises.readdir(folder)) {
      if (name.endsWith('.list') || name.endsWith('.sources')) files.push(path.join(folder, name));
    }
  } catch {
    // No folder: only sources.list.
  }
  for (const file of files) {
    try {
      if (namesDockerSource(await fs.promises.readFile(file, 'utf8'))) return true;
    } catch {
      // Not readable: the next file.
    }
  }
  return false;
}

export class DockerSetup implements vscode.Disposable {
  private readonly clock: Clock;
  private state: DockerSetupState = INITIAL_DOCKER_SETUP_STATE;
  /** The state that the context keys show; `undefined` until they were set once. */
  private shown: DockerSetupState | undefined;
  private missingTimer: NodeJS.Timeout | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private watchStartedAt = 0;
  private checkingWsl = false;
  private disposed = false;

  constructor(private readonly deps: DockerSetupDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** True while no Docker CLI is found. */
  get dockerMissing(): boolean {
    return !this.state.cliFound;
  }

  /** Sets the context keys; while the CLI is missing, it is looked up again every 10 seconds. No `docker info`. */
  initialize(): void {
    this.checkCli();
    if (this.dockerMissing) this.checkWslInBackground();
  }

  /** Looks for the CLI (ContainerAdapter looks a missing CLI up again, at most every 10 seconds). */
  checkCli(): boolean {
    return this.lookUp(() => this.deps.docker.isInstalled());
  }

  /** The result of a `docker info` that ran anyway (ContainerAdapter option `onDaemonStatus`). */
  reportDaemonStatus(running: boolean): void {
    this.apply({ kind: 'engine', running });
  }

  /** Command devEnvironments.installDocker: opens the walkthrough (only in a local window). */
  async openWizard(): Promise<void> {
    if (this.refuseInRemoteWindow()) return;
    this.checkWslInBackground();
    await vscode.commands.executeCommand(OPEN_WALKTHROUGH_COMMAND, DOCKER_WALKTHROUGH_ID, false);
  }

  /**
   * Command devEnvironments.dockerSetup.install (walkthrough step "Install Docker"): the installation plan of this
   * computer, after a modal confirmation. Afterwards, the CLI is looked up every 5 seconds for at most 30 minutes.
   */
  async install(): Promise<void> {
    if (this.refuseInRemoteWindow()) return;
    // The walkthrough stays reachable after the installation (Welcome page): an installed Docker is never installed again.
    if (this.dockerAlreadyInstalled()) return;
    const plan = installPlan(await (this.deps.planInput ?? (() => readInstallPlanInput(this.deps.runner, this.deps.platform, this.deps.env)))());
    this.deps.logger.info(`Docker installation: ${describePlan(plan)}`);
    switch (plan.kind) {
      case 'manual':
        void vscode.window.showInformationMessage(DockerSetupUiTexts.manualInstall).then(undefined, () => undefined);
        await vscode.env.openExternal(vscode.Uri.parse(plan.url));
        return;
      case 'terminal': {
        const confirmation = installConfirmation(plan);
        if (!confirmation || !(await this.confirm(confirmation))) return;
        this.runInTerminal(plan.commands);
        this.startInstallWatch();
        return;
      }
      case 'download':
        await this.downloadAndOpen(plan);
        return;
    }
  }

  /**
   * Command devEnvironments.dockerSetup.start (walkthrough step "Start Docker"): starts Docker Desktop with the
   * documented commands and waits until it is ready. Docker Engine on Linux: `sudo systemctl enable --now docker` in the
   * terminal, after a confirmation.
   */
  async start(): Promise<void> {
    if (this.refuseInRemoteWindow()) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: Steps.startingDocker, cancellable: true },
        (_progress, token) => {
          const abort = new AbortController();
          const subscription = token.onCancellationRequested(() => abort.abort());
          const run =
            this.deps.startDocker ??
            ((signal: AbortSignal, onStarting: () => void) =>
              ensureDockerRunning(this.deps.docker, this.deps.runner, this.deps.logger, {
                platform: this.deps.platform,
                env: this.deps.env,
                signal,
                onStarting,
              }));
          return run(abort.signal, () => this.deps.logger.info('Starting Docker from the setup walkthrough.')).finally(() =>
            subscription.dispose(),
          );
        },
      );
    } catch (error) {
      if (isUserFacingError(error) && error.code === 'dockerEngineNotRunning') {
        await this.startEngineInTerminal();
        return;
      }
      throw error;
    }
    void vscode.window.showInformationMessage(DockerSetupUiTexts.dockerRunning).then(undefined, () => undefined);
  }

  /** Command devEnvironments.dockerSetup.installWsl (walkthrough step "WSL 2", Windows): `wsl --install` in the terminal. */
  async installWsl(): Promise<void> {
    if (this.refuseInRemoteWindow()) return;
    if (this.state.wslReady) {
      this.inform(DockerSetupUiTexts.wslAlreadyInstalled);
      return;
    }
    const confirmation = terminalConfirmation(DockerSetupTexts.confirmWsl, [WSL_INSTALL_COMMAND], {
      needsAdmin: false,
      note: DockerSetupTexts.wslRestart,
    });
    if (!(await this.confirm(confirmation))) return;
    this.runInTerminal([WSL_INSTALL_COMMAND]);
    this.startInstallWatch();
  }

  dispose(): void {
    this.disposed = true;
    this.stopMissingTimer();
    this.stopInstallWatch();
  }

  private async startEngineInTerminal(): Promise<void> {
    const confirmation = terminalConfirmation(DockerSetupTexts.confirmStartEngine, [LINUX_ENGINE_START_COMMAND], {
      needsAdmin: true,
      button: DockerSetupTexts.start,
    });
    if (!(await this.confirm(confirmation))) return;
    this.runInTerminal([LINUX_ENGINE_START_COMMAND]);
  }

  private async downloadAndOpen(plan: Extract<InstallPlan, { kind: 'download' }>): Promise<void> {
    const folder = this.deps.downloadFolder ?? path.join(os.homedir(), 'Downloads');
    const target = path.join(folder, plan.fileName);
    const confirmation = installConfirmation(plan, target);
    if (!confirmation || !(await this.confirm(confirmation))) return;
    try {
      await fs.promises.mkdir(folder, { recursive: true });
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: DockerSetupUiTexts.downloading, cancellable: true },
        async (progress, token) => {
          const abort = new AbortController();
          const subscription = token.onCancellationRequested(() => abort.abort());
          let reported = 0;
          try {
            await (this.deps.download ?? downloadFile)({
              url: plan.url,
              target,
              signal: abort.signal,
              onProgress: (received, total) => {
                const mb = Math.floor(received / 1_048_576);
                if (mb === reported) return;
                const increment = total ? ((mb - reported) * 1_048_576 * 100) / total : undefined;
                reported = mb;
                progress.report({
                  message: DockerSetupUiTexts.downloadProgress(mb, total ? Math.ceil(total / 1_048_576) : undefined),
                  increment,
                });
              },
            });
          } finally {
            subscription.dispose();
          }
        },
      );
    } catch (error) {
      if (isAbortError(error)) {
        this.deps.logger.info('The download of Docker Desktop was cancelled.');
        return;
      }
      this.deps.logger.error(DockerSetupUiTexts.downloadFailed, error);
      this.showErrorWithDetails(DockerSetupUiTexts.downloadFailed);
      return;
    }
    this.deps.logger.info(`Docker Desktop was downloaded to ${target}.`);
    if (!(await this.markAsDownloaded(target, plan.url))) {
      // The confirmation said that the system checks the installer; it would not.
      this.showErrorWithDetails(DockerSetupUiTexts.notMarked(target));
      return;
    }
    try {
      if (plan.open === 'dmg') await (this.deps.launch ?? launchDetachedProcess)(MAC_OPEN, [target]);
      // The installer asks for elevation itself; the shell of the system (not a child process) handles that prompt.
      else if (!(await vscode.env.openExternal(vscode.Uri.file(target)))) throw new Error(`VS Code did not open ${target}.`);
    } catch (error) {
      this.deps.logger.error(DockerSetupUiTexts.openFailed(target), error);
      this.showErrorWithDetails(DockerSetupUiTexts.openFailed(target));
    }
    this.startInstallWatch();
  }

  /**
   * Marks the downloaded installer as a file from the internet, as a browser does, so that the system checks its
   * signature (Gatekeeper on macOS, SmartScreen on Windows). False (logged) when that failed: the installer does not open.
   */
  private async markAsDownloaded(file: string, url: string): Promise<boolean> {
    try {
      if (this.deps.platform === 'darwin') {
        const result = await this.deps.runner.run(XATTR, ['-w', 'com.apple.quarantine', quarantineAttribute(this.clock.now()), file], { timeoutMs: 10_000 });
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `xattr ended with ${result.exitCode}`);
      } else if (this.deps.platform === 'win32') {
        await fs.promises.writeFile(`${file}:Zone.Identifier`, zoneIdentifier(url));
      }
      return true;
    } catch (error) {
      this.deps.logger.warn(`The installer could not be marked as downloaded: ${errorMessage(error)}`);
      return false;
    }
  }

  /** True (with a message) when the CLI of Docker is found now. */
  private dockerAlreadyInstalled(): boolean {
    if (!this.lookUp(() => this.deps.docker.lookUpCliNow())) return false;
    this.deps.logger.info('Docker is installed already. Nothing is installed.');
    this.inform(DockerSetupUiTexts.alreadyInstalled);
    return true;
  }

  private inform(message: string): void {
    vscode.window.showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }

  /** Modal confirmation; true only for the confirming button. */
  private async confirm(confirmation: Confirmation): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      confirmation.message,
      { modal: true, detail: confirmation.detail },
      confirmation.button,
    );
    return choice === confirmation.button;
  }

  /** The commands run visibly in a new terminal of VS Code; the user follows them and enters a password there. */
  private runInTerminal(commands: readonly string[]): void {
    // A fixed shell, folder, and environment: no terminal setting of the workspace and no file of the opened folder
    // changes what the listed commands run.
    const options = installTerminalOptions(this.deps.platform, this.deps.env, os.homedir(), currentUserName());
    const terminal = vscode.window.createTerminal({ name: INSTALL_TERMINAL_NAME, ...options });
    terminal.show();
    for (const line of terminalLines(commands, this.deps.platform)) {
      this.deps.logger.info(`Terminal "${INSTALL_TERMINAL_NAME}": ${line}`);
      terminal.sendText(line);
    }
  }

  private showErrorWithDetails(message: string): void {
    vscode.window.showErrorMessage(message, DockerSetupUiTexts.showDetails).then(
      (choice) => {
        if (choice === DockerSetupUiTexts.showDetails) this.deps.showLog();
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  /** In a remote window, a terminal would run on the remote computer: the user is asked to open a local window. */
  private refuseInRemoteWindow(): boolean {
    if (vscode.env.remoteName === undefined) return false;
    this.deps.logger.info(`Docker is installed only from a local window (this window: ${vscode.env.remoteName}).`);
    vscode.window
      .showInformationMessage(DockerSetupUiTexts.localWindowNeeded)
      .then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
    return true;
  }

  /** After an installation started: the CLI every 5 seconds until it is found, for at most 30 minutes. */
  private startInstallWatch(): void {
    if (this.disposed) return;
    this.watchStartedAt = this.clock.now();
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.watchInstall(), this.deps.timing?.watchIntervalMs ?? INSTALL_WATCH_INTERVAL_MS);
  }

  private watchInstall(): void {
    this.lookUp(() => this.deps.docker.lookUpCliNow());
    if (!this.state.wslReady) this.checkWslInBackground();
    if (this.watchTimer && !keepWatchingInstall(this.state, this.watchStartedAt, this.clock.now())) {
      if (!this.state.cliFound) this.deps.logger.info('Docker was not found within 30 minutes after the installation started.');
      this.stopInstallWatch();
    }
  }

  private stopInstallWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  /** Windows: `wsl --status` (exit code 0: WSL is installed). One check at a time; never throws. */
  private checkWslInBackground(): void {
    if (this.deps.platform !== 'win32' || this.checkingWsl || this.disposed) return;
    this.checkingWsl = true;
    // Assumption: `wsl --status` ends with exit code 0 only when WSL is installed and set up.
    this.deps.runner
      .run('wsl.exe', ['--status'], { timeoutMs: WSL_STATUS_TIMEOUT_MS })
      .then(
        (result) => this.apply({ kind: 'wsl', ready: result.exitCode === 0 }),
        (error: unknown) => {
          this.deps.logger.info(`wsl --status could not run: ${errorMessage(error)}`);
          this.apply({ kind: 'wsl', ready: false });
        },
      )
      .finally(() => {
        this.checkingWsl = false;
      });
  }

  private lookUp(find: () => boolean): boolean {
    let found: boolean;
    try {
      found = find();
    } catch (error) {
      this.deps.logger.warn(`The Docker CLI could not be looked up: ${errorMessage(error)}`);
      found = false;
    }
    this.apply({ kind: 'cli', found });
    return found;
  }

  private apply(event: DockerSetupEvent): void {
    if (this.disposed) return;
    const before = this.state;
    const first = this.shown === undefined;
    this.state = nextDockerSetupState(before, event);
    for (const [key, value] of changedContextValues(this.shown, this.state)) {
      vscode.commands.executeCommand('setContext', key, value).then(undefined, (error: unknown) => {
        this.deps.logger.warn(`Could not set the context key ${key}: ${errorMessage(error)}`);
      });
    }
    this.shown = this.state;
    // The first check only sets the keys: the sidebar reads `dockerMissing` when it renders.
    if (!first && before.cliFound !== this.state.cliFound) {
      this.deps.logger.info(this.state.cliFound ? 'The Docker CLI was found.' : 'The Docker CLI was not found.');
      this.deps.onDidChangeInstalled();
      if (this.state.cliFound && this.watchTimer) {
        this.stopInstallWatch();
        this.offerStart();
      }
    }
    this.updateMissingTimer();
  }

  /** Walkthrough step "Start Docker", offered once the installation has put the CLI in place. */
  private offerStart(): void {
    vscode.window.showInformationMessage(DockerSetupUiTexts.installedStartNow, DockerSetupUiTexts.startDocker).then(
      (choice) => {
        if (choice !== DockerSetupUiTexts.startDocker) return;
        vscode.commands
          .executeCommand(DOCKER_SETUP_START_COMMAND)
          .then(undefined, (error: unknown) => this.deps.logger.error('Docker could not be started.', error));
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  private updateMissingTimer(): void {
    if (!needsMissingCliCheck(this.state)) {
      this.stopMissingTimer();
      return;
    }
    if (this.missingTimer) return;
    this.missingTimer = setInterval(() => this.checkCli(), this.deps.timing?.missingCheckMs ?? MISSING_CLI_CHECK_MS);
  }

  private stopMissingTimer(): void {
    if (this.missingTimer) clearInterval(this.missingTimer);
    this.missingTimer = undefined;
  }
}

/** One line for the log. */
function describePlan(plan: InstallPlan): string {
  switch (plan.kind) {
    case 'terminal':
      return `terminal: ${plan.commands.join(' && ')}`;
    case 'download':
      return `download ${plan.url}`;
    case 'manual':
      return `manual: ${plan.url}`;
  }
}
