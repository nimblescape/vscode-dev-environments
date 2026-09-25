// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The commands of package.json (implementation notes 3). No `vscode` import.

export const Commands = {
  start: 'devEnvironments.start',
  stop: 'devEnvironments.stop',
  delete: 'devEnvironments.delete',
  switchBranch: 'devEnvironments.switchBranch',
  selectConfiguration: 'devEnvironments.selectConfiguration',
  rebuild: 'devEnvironments.rebuild',
  showOnGitHub: 'devEnvironments.showOnGitHub',
  switchEnvironment: 'devEnvironments.switchEnvironment',
  refresh: 'devEnvironments.refresh',
  search: 'devEnvironments.search',
  showLog: 'devEnvironments.showLog',
  signIn: 'devEnvironments.signIn',
  selectOwners: 'devEnvironments.selectOwners',
  /** The same command with the filled filter icon, for the view title bar while the setting `owners` is set. */
  selectOwnersFiltered: 'devEnvironments.selectOwnersFiltered',
  installDocker: 'devEnvironments.installDocker',
  // The buttons of the walkthrough "Set up Docker for Dev Environments" (hidden in the Command Palette).
  dockerSetupInstall: 'devEnvironments.dockerSetup.install',
  dockerSetupStart: 'devEnvironments.dockerSetup.start',
  dockerSetupInstallWsl: 'devEnvironments.dockerSetup.installWsl',
} as const;

export type CommandName = keyof typeof Commands;
