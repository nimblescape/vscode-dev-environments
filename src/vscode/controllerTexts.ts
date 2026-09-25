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
