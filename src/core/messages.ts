// All user-visible texts. Where the concept gives a text (section 6.5), the text here is exactly that text.

export const Steps = {
  startingDocker: 'Starting Docker',
  downloadingRepository: 'Downloading repository',
  checkingImage: 'Checking for a newer image',
  downloadingImage: 'Downloading the new image',
  preparing: 'Preparing environment',
  starting: 'Starting environment',
  connecting: 'Connecting',
} as const;

export type ProgressStep = keyof typeof Steps;

export const Messages = {
  dockerNotInstalled: 'Docker Desktop is not installed.',
  dockerStartFailed: 'Docker could not be started.',
  dockerEngineNotRunning: 'Docker is not running. Start the Docker service with this command: sudo systemctl start docker',
  buildFailed: 'The environment could not be prepared.',
  registryUnreachable:
    'No connection to the image registry. The update check was skipped. The environment uses the local image.',
  firstOpenOffline: 'This repository cannot be opened without internet access.',
  registrySignIn: (registry: string) => `The registry ${registry} requires a sign-in.`,
  organizationNotAuthorized: (organization: string) =>
    `Access to the organization ${organization} is not authorized.`,
  newerImage: 'A newer image is available. The environment is updated. Your files are kept.',
  filesMissing: 'The files of this environment are missing.',
  configurationChanged: 'The environment configuration changed.',
  composeNotSupported: 'Docker Compose configurations are not supported yet.',
  noConfiguration: (repository: string) => `The repository ${repository} has no Dev Container configuration.`,
  configurationNotFound: (configPath: string, configurationName: string) =>
    `The configuration ${configPath} does not exist on this branch. The configuration ${configurationName} is used.`,
  computerDependent: (items: string) =>
    `This configuration uses files on your computer (${items}). This does not work, because the repository is stored in a Docker volume.`,
  untrustedRepository: (repository: string) =>
    `${repository} does not belong to you or to one of your organizations. Opening it runs code from the repository (Dockerfile, Features, and commands) on your computer. Open it?`,
  signInRequired: 'Sign in with GitHub to use Dev Environments.',
  gitSwitchFailed: (branch: string, gitMessage: string) => `The branch ${branch} could not be checked out. ${gitMessage}`,
  opening: (repository: string) => `Opening ${repository}…`,
  deleteConfirm: (repository: string) =>
    `Delete the environment of ${repository}? The container and the files in the environment are removed.`,
  deleteUnsaved: (repository: string, changes: string) =>
    `The environment of ${repository} has ${changes}. These changes are lost when you delete the environment.`,
  deleteAdditionalVolumes: (volumes: string) =>
    `The configuration also uses these volumes: ${volumes}. Remove them too?`,
  helperFailed: 'The workspace helper could not be prepared.',
  cloneFailed: 'The repository could not be downloaded.',
  noEnvironment: (repository: string) => `${repository} has no environment.`,
} as const;

export const Actions = {
  openDownloadPage: 'Open download page',
  showDetails: 'Show details',
  tryAgain: 'Try again',
  signIn: 'Sign in',
  authorize: 'Authorize',
  rebuildNow: 'Rebuild now',
  later: 'Later',
  cloneAgain: 'Clone again',
  deleteEnvironment: 'Delete environment',
  openEnvironment: 'Open environment',
  deleteAnyway: 'Delete anyway',
  delete: 'Delete',
  remove: 'Remove',
  keep: 'Keep',
  open: 'Open',
  cancel: 'Cancel',
  continue: 'Continue',
} as const;

export const StateTexts = {
  connected: 'Connected',
  connectedOtherWindow: 'Connected · other window',
  running: 'Running',
  stopped: 'Stopped',
  updating: 'Updating',
  noContainer: 'No container',
  filesMissing: 'Files missing',
  notOnGitHub: 'not on GitHub',
} as const;

export const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/';

/** Formats the change counts of a Git summary, for example `2 uncommitted · 3 unpushed`. Empty when there are no changes. */
export function formatChanges(summary: { uncommittedFiles: number; unpushedCommits: number; stashes?: number }): string {
  const parts: string[] = [];
  if (summary.uncommittedFiles > 0) parts.push(`${summary.uncommittedFiles} uncommitted`);
  if (summary.unpushedCommits > 0) parts.push(`${summary.unpushedCommits} unpushed`);
  if (summary.stashes && summary.stashes > 0) parts.push(`${summary.stashes} stashed`);
  return parts.join(' · ');
}
