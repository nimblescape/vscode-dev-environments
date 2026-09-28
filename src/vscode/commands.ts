// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The commands of package.json (implementation notes 3). No `vscode` import.

export const Commands = {
  start: 'devEnvironments.start',
  // Start in a new window, or (while the setting openInNewWindow is on) in the current window (concept 6.2, 8).
  startInNewWindow: 'devEnvironments.startInNewWindow',
  startInCurrentWindow: 'devEnvironments.startInCurrentWindow',
  stop: 'devEnvironments.stop',
  delete: 'devEnvironments.delete',
  switchBranch: 'devEnvironments.switchBranch',
  selectConfiguration: 'devEnvironments.selectConfiguration',
  rebuild: 'devEnvironments.rebuild',
  showOnGitHub: 'devEnvironments.showOnGitHub',
  switchEnvironment: 'devEnvironments.switchEnvironment',
  // The switcher for a new window, or (while the setting openInNewWindow is on) for the current window (concept 6.4).
  switchEnvironmentInNewWindow: 'devEnvironments.switchEnvironmentInNewWindow',
  switchEnvironmentInCurrentWindow: 'devEnvironments.switchEnvironmentInCurrentWindow',
  refresh: 'devEnvironments.refresh',
  search: 'devEnvironments.search',
  showLog: 'devEnvironments.showLog',
  signIn: 'devEnvironments.signIn',
  selectOwners: 'devEnvironments.selectOwners',
  /** The same command with the filled filter icon, for the view title bar while the setting `owners` is set. */
  selectOwnersFiltered: 'devEnvironments.selectOwnersFiltered',
  // The editor of the setting repositoryGroups (Command Palette, view title "…" menu, link in the setting).
  editRepositoryGroups: 'devEnvironments.editRepositoryGroups',
  // The switch of the host access checks of a repository (row context menu only, hidden in the Command Palette).
  turnOffHostAccessChecks: 'devEnvironments.turnOffHostAccessChecks',
  turnOnHostAccessChecks: 'devEnvironments.turnOnHostAccessChecks',
  // The switch Keep Running When Closed of an environment (user decision 2026-09-26, "go with the proposal for closing").
  // The row context menu shows one of the two; the Command Palette offers both with a picker of the environments, as Stop.
  keepRunning: 'devEnvironments.keepRunning',
  stopWhenClosed: 'devEnvironments.stopWhenClosed',
  // Close and Keep Running (unit 7, PR 2): closes the window of an environment; its container keeps running this time.
  // Only in a window connected to an environment (context key devEnvironments.connected) and in its row.
  closeAndKeepRunning: 'devEnvironments.closeAndKeepRunning',
  // The buttons of the Docker setup in the sidebar (welcome view), Start Docker after an installation and of the error
  // "Docker is not running." (Docker Engine on Linux), and Show Docker Setup, the action Install Docker… of the error
  // "Docker Desktop is not installed." (all hidden in the Command Palette).
  dockerSetupInstall: 'devEnvironments.dockerSetup.install',
  dockerSetupStart: 'devEnvironments.dockerSetup.start',
  dockerSetupInstallWsl: 'devEnvironments.dockerSetup.installWsl',
  dockerSetupShow: 'devEnvironments.dockerSetup.show',
  // Unit 7 (user decisions 2026-09-27): Docker on another computer through the Docker context, and back.
  useRemoteDockerHost: 'devEnvironments.useRemoteDockerHost',
  useLocalDocker: 'devEnvironments.useLocalDocker',
  // The command of a repository row (TreeItem.command, hidden in the Command Palette): a double-click runs Start (user
  // request 2026-09-27, "double-clicking a repo shall start the machine"; rowActivation.ts).
  rowActivated: 'devEnvironments.rowActivated',
  // User decision 2026-09-28: the link "Show details" of a progress notification (hidden from the Command Palette).
  showProgressDetails: 'devEnvironments.showProgressDetails',
} as const;

export type CommandName = keyof typeof Commands;
