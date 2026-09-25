// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User-visible texts of the controller that messages.ts lacks (plain language, NFR-02); to be moved there.
// No `vscode` import.

export const ControllerTexts = {
  // Progress titles (concept 6.5: one notification per operation).
  stopping: (repository: string) => `Stopping ${repository}…`,
  deleting: (repository: string) => `Deleting the environment of ${repository}…`,
  rebuilding: (repository: string) => `Rebuilding ${repository}…`,
  checkingChanges: (repository: string) => `Checking ${repository} for changes…`,
  switchingBranch: (repository: string, branch: string) => `Switching ${repository} to the branch ${branch}…`,
  readingConfigurations: (repository: string) => `Reading the configurations of ${repository}…`,
  waitingForOtherWindow: (repository: string) => `Waiting until another window has finished changing ${repository}…`,
  // Messages.
  alreadyConnected: (repository: string) => `This window is connected to ${repository}.`,
  // Stop, Rebuild, and Delete of an environment that another window uses: that window closes its connection first
  // (concept 6.2 Stop, 7.14).
  otherWindowClosesConnection: (repository: string) =>
    `${repository} is open in another window. That window closes its connection first.`,
  otherWindowContinues: (repository: string) =>
    `The other window of ${repository} closes its connection. The operation continues in that window.`,
  otherWindowNoAnswer: (repository: string) =>
    `The other window of ${repository} did not close its connection. Nothing was changed.`,
  alreadyDeleting: (repository: string) => `The environment of ${repository} is being deleted in another window.`,
  // Accounts (concept 7.5). A named environment of another account: Messages.otherAccount.
  /**
   * A restored window of an environment of an older version that has no owner yet (Messages.olderEnvironmentNotAssigned
   * for a command). Not "another account": nobody owns it.
   */
  /**
   * Concept 7.5: the GitHub session changed during a command on an entry of an older version (for example another account
   * signed in at the sign-in of the claim). Nothing was assigned; Try again runs the command for the new account.
   */
  accountChangedDuringClaim: (repository: string) =>
    `The GitHub account changed while the environment of ${repository} was being assigned. Nothing was assigned. Try again.`,
  ownerNotConfirmedConnection: (repository: string) =>
    `The environment of ${repository} was made by an older version of Dev Environments and does not belong to a GitHub account yet. This window closes its connection. Start ${repository} to give the environment to the signed-in account.`,
  signedOutConnection: (repository: string) =>
    `Nobody is signed in to GitHub. This window closes its connection to the environment of ${repository}. Sign in with GitHub to use it again.`,
  /** The window kept its connection after it left an environment that it must not use (for example Cancel on unsaved files). */
  stillConnected: (repository: string) =>
    `This window is still connected to the environment of ${repository}, which it must not use. Save your files: the window closes its connection again.`,
  /** Concept section 9: a container of an older version uses the Git of the computer. */
  outdatedContainerClosed: (repository: string) =>
    `The container of ${repository} was made by an older version of Dev Environments and cannot be used. This window closes its connection. Start ${repository} again to make a new container.`,
  noEnvironments: 'There is no environment yet. Start a repository to create one.',
  noRepositories: 'No repository is available. Sign in with GitHub, or refresh the list.',
  branchesUnavailable: 'The branches could not be loaded. Type the name of a branch.',
  // Buttons.
  stop: 'Stop',
  // Quick Picks.
  selectRepositoryToStart: 'Select a repository to open in this window',
  selectEnvironmentToStop: 'Select an environment to stop',
  selectEnvironmentToDelete: 'Select an environment to delete',
  selectEnvironmentToRebuild: 'Select an environment to rebuild',
  selectRepositoryForBranch: 'Select a repository to switch its branch',
  selectRepositoryForConfiguration: 'Select a repository to select its configuration',
  selectRepositoryForGitHub: 'Select a repository to show on GitHub',
  switchBranchTitle: 'Switch Branch',
  branchPlaceholder: (repository: string) => `Select or type a branch of ${repository}`,
  selectConfigurationTitle: 'Select Configuration',
  configurationPlaceholder: (repository: string) => `Select a configuration of ${repository}`,
  current: 'current',
  defaultBranch: 'default branch',
  typedBranch: 'other branch',
} as const;
