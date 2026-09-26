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
  installDocker: 'devEnvironments.installDocker',
  // The editor of the setting repositoryGroups (Command Palette, view title "…" menu, link in the setting).
  editRepositoryGroups: 'devEnvironments.editRepositoryGroups',
  // The switch of the host access checks of a repository (row context menu only, hidden in the Command Palette).
  turnOffHostAccessChecks: 'devEnvironments.turnOffHostAccessChecks',
  turnOnHostAccessChecks: 'devEnvironments.turnOnHostAccessChecks',
  // The switch Keep Running When Closed of an environment (user decision 2026-09-26, "go with the proposal for closing").
  // The row context menu shows one of the two; the Command Palette offers both with a picker of the environments, as Stop.
  keepRunning: 'devEnvironments.keepRunning',
  stopWhenClosed: 'devEnvironments.stopWhenClosed',
  // The buttons of the walkthrough "Set up Docker for Dev Environments" (hidden in the Command Palette).
  dockerSetupInstall: 'devEnvironments.dockerSetup.install',
  dockerSetupStart: 'devEnvironments.dockerSetup.start',
  dockerSetupInstallWsl: 'devEnvironments.dockerSetup.installWsl',
} as const;

export type CommandName = keyof typeof Commands;
