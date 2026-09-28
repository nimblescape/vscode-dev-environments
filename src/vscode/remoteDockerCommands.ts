// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Dev Environments: Use a Remote Docker Host…" and "Dev Environments: Use the Local Docker" (unit 7, user decisions
// 2026-09-27). The remote host is the current Docker context: the command tests the host over SSH without questions,
// asks once (modal), remembers the context that was current, then uses the context of that host (`devenv-remote-<hash>`,
// created with `ssh://<alias-or-address>` when missing, never changed afterwards). Nothing else is written: no setting,
// no DOCKER_HOST, no setting of the Dev Containers extension. One Docker host at a time.
import * as vscode from 'vscode';
import {
  describeDockerHost,
  isOwnRemoteContext,
  parseSshAddress,
  type DockerTarget,
  type SshAddressProblem,
} from '../core/docker/dockerHost';
import type { DockerTargets } from '../core/docker/dockerTargets';
import {
  chooseLocalContext,
  dockerVariableOverride,
  recordRootlessSocket,
  testRemoteDockerHost,
  useContext,
  useRemoteContext,
  type RemoteDockerCli,
  type SshLoginCache,
} from '../core/docker/remoteDocker';
import { errorMessage, isUserFacingError } from '../core/errors';
import { Actions, Messages, dockerHostReason } from '../core/messages';
import { isAbortError, type Logger, type ProcessRunner } from '../core/ports';
import type { SshHostEntry } from '../core/sshConfig';
import type { RemoteDockerState } from '../core/storage/remoteDockerState';

/** User-visible texts of the remote Docker host (plain language). No `vscode` in them. */
export const RemoteDockerTexts = {
  pickTitle: 'Use a Remote Docker Host',
  pickPlaceholder: 'Choose a host of your SSH config, or enter an SSH address',
  enterAddress: 'Enter an SSH address…',
  enterAddressDetail: 'user@host or user@host:port',
  addressPrompt: 'The SSH address of the computer with Docker, for example me@build-box or me@192.0.2.10:2222',
  addressProblem: (problem: SshAddressProblem): string => {
    switch (problem) {
      case 'empty':
        return 'Enter an address such as me@build-box.';
      case 'spaces':
        return 'The address must not contain spaces.';
      case 'option':
        return 'The address must not start with "-".';
      case 'path':
        return 'Enter only user@host[:port], without a path or a query.';
      case 'user':
        return 'The user name may contain letters, digits, ".", "_" and "-", and must not start with "-".';
      case 'host':
        return 'The host must be a name such as build-box.example.com or an IPv4 address.';
      case 'ipv6':
        return 'Write an IPv6 address in brackets, for example [2001:db8::1]:22.';
      case 'port':
        return 'The port must be a number from 1 to 65535.';
    }
  },
  testing: (host: string) => `Testing the connection to ${host}…`,
  confirm: (host: string) => `All Docker tools on this computer will use ${host} until you switch back.`,
  confirmDetail:
    'Dev Environments sets a Docker context of this host ("devenv-remote-…"). Docker, Docker Compose, and the Dev Containers extension follow it. Use "Dev Environments: Use the Local Docker" to switch back.',
  confirmLocal: 'All Docker tools on this computer will use the local Docker again.',
  useHost: (host: string) => `Use ${host}`,
  useLocal: 'Use the Local Docker',
  nowRemote: (host: string, rootless: boolean) =>
    `Docker now uses ${host}.${rootless ? ' Its Docker engine runs rootless: ports below 1024 cannot be published there.' : ''}`,
  nowLocal: (context: string) => `Docker now uses the local Docker (context ${context}).`,
  /** Review, C2: the context of the switch back does not point to the local Docker (never claimed as local). */
  notLocal: (context: string, where: string) =>
    `Docker now uses the context ${context}, which points to ${where}, not to the local Docker. Check the context with "docker context ls".`,
  alreadyLocal: 'Docker already uses the local Docker.',
  variableSet: (name: string) =>
    `${name} is set in the environment of VS Code, so Docker ignores the Docker context. Remove ${name} and start VS Code again, then try again.`,
  switchFailed: 'The Docker context could not be changed.',
  /** The mismatch of an environment and the current Docker host (a restored window, for example from Open Recent). */
  /** User request 2026-09-28: the title-bar icon of the view while Docker is set to a remote host. */
  chooseTitle: (host: string) => `Docker host: ${host}`,
  choosePlaceholder: 'Use another remote host, or switch back to the local Docker',
  useAnotherHost: 'Use Another Remote Docker Host…',
  mismatch: (environmentHost: string, currentHost: string) =>
    `This environment is on ${describeDockerHost(environmentHost)}, but Docker is set to ${describeDockerHost(currentHost)}. Use ${describeDockerHost(environmentHost)} again?`,
} as const;

export interface RemoteDockerDeps {
  docker: RemoteDockerCli;
  runner: ProcessRunner;
  targets: Pick<DockerTargets, 'resolve'>;
  state: RemoteDockerState;
  logger: Logger;
  showLog: () => void;
  /** The concrete hosts of the user's SSH config (parseSshConfig). */
  sshHosts: () => SshHostEntry[];
  /** The path of `ssh` on this computer (findExecutable), or undefined. */
  sshPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Review, C3: the successes of the SSH check, shared with the operations. */
  sshLogins?: SshLoginCache;
  /** After a switch: the sidebar shows the environments of the new host. */
  onDidSwitch: () => Promise<void>;
}

interface HostItem extends vscode.QuickPickItem {
  host?: string;
}

export class RemoteDockerCommands {
  constructor(private readonly deps: RemoteDockerDeps) {}

  /** "Use a Remote Docker Host…": pick, test, confirm, switch. Never throws. */
  async useRemoteHost(): Promise<void> {
    try {
      if (this.refuseOverride()) return;
      const host = await this.pickHost();
      if (host === undefined) return;
      await this.switchToRemote(host);
    } catch (error) {
      this.showFailure(error);
    }
  }

  /**
   * The title-bar icon of the view while Docker is set to a remote host (user request 2026-09-28): another remote host
   * ("Use a Remote Docker Host…") or the local Docker ("Use the Local Docker"). Never throws.
   */
  async chooseDockerHost(): Promise<void> {
    try {
      const current = await this.deps.targets.resolve();
      const items: Array<vscode.QuickPickItem & { choice: 'remote' | 'local' }> = [
        { label: `$(remote) ${RemoteDockerTexts.useAnotherHost}`, choice: 'remote' },
        { label: `$(vm) ${RemoteDockerTexts.useLocal}`, choice: 'local' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: RemoteDockerTexts.chooseTitle(describeDockerHost(current.host)),
        placeHolder: RemoteDockerTexts.choosePlaceholder,
      });
      if (!picked) return;
      if (picked.choice === 'remote') await this.useRemoteHost();
      else await this.useLocalDocker();
    } catch (error) {
      this.showFailure(error);
    }
  }

  /** "Use the Local Docker": back to the remembered context (or `default`). Never throws. */
  async useLocalDocker(): Promise<void> {
    try {
      if (this.refuseOverride()) return;
      const current = await this.deps.targets.resolve();
      if (current.kind === 'local') {
        this.inform(RemoteDockerTexts.alreadyLocal);
        return;
      }
      await this.switchToLocal(false);
    } catch (error) {
      this.showFailure(error);
    }
  }

  /**
   * The mismatch of a restored window (the environment is on `environmentHost`, Docker is set to `current`): asks "Use
   * <host> again?", then switches as the commands do (test, modal). True when Docker uses `environmentHost` afterwards.
   * Never throws.
   */
  async offerSwitchBack(environmentHost: string, current: DockerTarget): Promise<boolean> {
    try {
      const button = RemoteDockerTexts.useHost(describeDockerHost(environmentHost));
      const choice = await vscode.window.showWarningMessage(
        RemoteDockerTexts.mismatch(environmentHost, current.host),
        { modal: true },
        button,
      );
      if (choice !== button) return false;
      if (this.refuseOverride()) return false;
      if (environmentHost === '') return await this.switchToLocal(true);
      return await this.switchToRemote(environmentHost);
    } catch (error) {
      this.showFailure(error);
      return false;
    }
  }

  /** Test, rootless socket, modal, remember the context, switch. True when switched. */
  private async switchToRemote(host: string): Promise<boolean> {
    const check = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: RemoteDockerTexts.testing(host), cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          const result = await testRemoteDockerHost(
            this.deps.docker,
            host,
            { runner: this.deps.runner, sshPath: this.deps.sshPath(), env: this.deps.env, sshLogins: this.deps.sshLogins },
            { signal: controller.signal },
          );
          // A rootless engine: its socket is read once (ssh, without questions) and recorded with the host.
          if (result.ok) {
            await recordRootlessSocket(host, result.rootless, {
              runner: this.deps.runner,
              state: this.deps.state,
              logger: this.deps.logger,
              sshPath: this.deps.sshPath(),
              env: this.deps.env,
            }, controller.signal);
          }
          return result;
        } finally {
          subscription.dispose();
        }
      },
    );
    if (!check.ok) {
      this.deps.logger.warn(`The Docker host ${host} cannot be reached: ${check.detail}`);
      this.showError(Messages.dockerHostUnreachable(host, dockerHostReason(check.problem, host)));
      return false;
    }
    this.deps.logger.info(`The Docker host ${host} answers: Docker engine ${check.version}${check.rootless ? ' (rootless)' : ''}.`);
    const button = RemoteDockerTexts.useHost(host);
    const choice = await vscode.window.showWarningMessage(
      RemoteDockerTexts.confirm(host),
      { modal: true, detail: RemoteDockerTexts.confirmDetail },
      button,
    );
    if (choice !== button) return false;
    const current = await this.deps.targets.resolve();
    // The context to go back to; not one of ours (a switch from one remote host to another keeps the first one).
    if (current.context !== undefined && !isOwnRemoteContext(current.context)) {
      await this.deps.state.setPreviousContext(current.context);
    }
    const name = await useRemoteContext(this.deps.docker, host);
    this.deps.logger.info(`The Docker context ${name} (ssh://${host}) is the current context. The previous one was ${current.context ?? 'not known'}.`);
    await this.deps.targets.resolve();
    this.inform(RemoteDockerTexts.nowRemote(host, check.rootless));
    await this.afterSwitch();
    return true;
  }

  /** Back to the remembered context (or `default`). `confirm`: the modal first (the mismatch flow). */
  private async switchToLocal(confirm: boolean): Promise<boolean> {
    if (confirm) {
      const choice = await vscode.window.showWarningMessage(RemoteDockerTexts.confirmLocal, { modal: true }, RemoteDockerTexts.useLocal);
      if (choice !== RemoteDockerTexts.useLocal) return false;
    }
    // Review, C2: the remembered context only when it points to the local Docker, else `default`.
    const name = await chooseLocalContext(this.deps.docker, await this.deps.state.previousContext(), this.deps.logger);
    await useContext(this.deps.docker, name);
    await this.deps.state.setPreviousContext(undefined);
    this.deps.logger.info(`The Docker context ${name} is the current context again.`);
    // The message follows where Docker points now; it never says "local" otherwise.
    const now = await this.deps.targets.resolve();
    if (now.kind === 'local') {
      this.inform(RemoteDockerTexts.nowLocal(name));
    } else {
      const where = now.kind === 'remote' ? now.host : now.endpoint || 'an endpoint that cannot be read';
      this.deps.logger.warn(`The context ${name} does not point to the local Docker: ${now.endpoint}`);
      this.showWarning(RemoteDockerTexts.notLocal(now.context ?? name, where));
    }
    await this.afterSwitch();
    return now.kind === 'local';
  }

  private async pickHost(): Promise<string | undefined> {
    let hosts: SshHostEntry[] = [];
    try {
      hosts = this.deps.sshHosts();
    } catch (error) {
      this.deps.logger.warn(`The SSH config could not be read: ${errorMessage(error)}`);
    }
    const items: HostItem[] = hosts.map((entry) => ({ label: entry.alias, description: describeEntry(entry), host: entry.alias }));
    if (items.length > 0) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: RemoteDockerTexts.enterAddress, description: RemoteDockerTexts.enterAddressDetail });
    const picked = await vscode.window.showQuickPick(items, {
      title: RemoteDockerTexts.pickTitle,
      placeHolder: RemoteDockerTexts.pickPlaceholder,
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    if (picked.host !== undefined) return picked.host;
    const typed = await vscode.window.showInputBox({
      title: RemoteDockerTexts.pickTitle,
      prompt: RemoteDockerTexts.addressPrompt,
      placeHolder: 'me@build-box',
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        const parsed = parseSshAddress(value);
        return parsed.ok ? undefined : RemoteDockerTexts.addressProblem(parsed.problem);
      },
    });
    if (typed === undefined) return undefined;
    const parsed = parseSshAddress(typed);
    if (!parsed.ok) {
      this.showError(RemoteDockerTexts.addressProblem(parsed.problem));
      return undefined;
    }
    return parsed.address;
  }

  /** DOCKER_HOST or DOCKER_CONTEXT set for VS Code: a context switch would not reach it. True when refused. */
  private refuseOverride(): boolean {
    const name = dockerVariableOverride(this.deps.env, this.deps.platform);
    if (name === undefined) return false;
    this.deps.logger.warn(`${name} is set for VS Code; the Docker context is not changed.`);
    this.showError(RemoteDockerTexts.variableSet(name));
    return true;
  }

  private async afterSwitch(): Promise<void> {
    await this.deps.onDidSwitch().catch((error: unknown) => this.deps.logger.error('Could not update the sidebar.', error));
  }

  private showFailure(error: unknown): void {
    if (isAbortError(error)) {
      this.deps.logger.info('The switch of the Docker host was cancelled.');
      return;
    }
    if (isUserFacingError(error)) {
      this.deps.logger.error(error.message, error);
      this.showError(error.message);
      return;
    }
    this.deps.logger.error(RemoteDockerTexts.switchFailed, error);
    this.showError(RemoteDockerTexts.switchFailed);
  }

  private showError(message: string): void {
    vscode.window.showErrorMessage(message, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  private showWarning(message: string): void {
    vscode.window.showWarningMessage(message, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  private inform(message: string): void {
    vscode.window.showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }
}

/** HostName and User of an entry, for the quick pick: `me@build-box.example.com:2222`. */
export function describeEntry(entry: SshHostEntry): string | undefined {
  if (entry.hostName === undefined && entry.user === undefined && entry.port === undefined) return undefined;
  const user = entry.user !== undefined ? `${entry.user}@` : '';
  const port = entry.port !== undefined ? `:${entry.port}` : '';
  return `${user}${entry.hostName ?? entry.alias}${port}`;
}
