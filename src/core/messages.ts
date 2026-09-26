// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

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
  /** The pull of an image needs the GitHub sign-in, and the connection to the Docker engine is neither local nor encrypted. */
  unencryptedDockerConnection:
    'The image of this environment can only be downloaded with your GitHub sign-in. The connection to Docker is not encrypted, so Dev Environments does not send the sign-in. Use a local Docker, or connect to Docker over SSH or TLS.',
  registrySignIn: (registry: string) => `The registry ${registry} requires a sign-in.`,
  organizationNotAuthorized: (organization: string) =>
    `Access to the organization ${organization} is not authorized.`,
  /** Concept 7.4: an owner of the setting `owners` that GitHub does not return (unknown, or no access). */
  organizationNotFound: (organization: string) => `The organization ${organization} was not found or is not accessible.`,
  newerImage: 'A newer image is available. The environment is updated. Your files are kept.',
  filesMissing: 'The files of this environment are missing.',
  configurationChanged: 'The environment configuration changed.',
  composeNotSupported: 'Docker Compose configurations are not supported yet.',
  noConfiguration: (repository: string) => `The repository ${repository} has no Dev Container configuration.`,
  configurationNotFound: (configPath: string, configurationName: string) =>
    `The configuration ${configPath} does not exist on this branch. The configuration ${configurationName} is used.`,
  computerDependent: (items: string) =>
    `This configuration uses files on your computer (${items}). This does not work, because the repository is stored in a Docker volume.`,
  hostAccess: (items: string) =>
    `This configuration needs access to your computer, which Dev Environments does not allow: ${items}. Change the configuration of the repository.`,
  /**
   * Settings that the host access policy does not know, so it cannot tell what they do, and values that work against how
   * the extension runs the container, for example `--restart=always` (concept section 9).
   */
  unsupportedOptions: (items: string) =>
    `This configuration uses options that Dev Environments does not support: ${items}. Change the configuration of the repository.`,
  /** Both: settings that need access to the computer, and settings that the policy does not know. */
  hostAccessAndUnsupported: (items: string, unsupported: string) =>
    `This configuration needs access to your computer, which Dev Environments does not allow: ${items}. It also uses options that Dev Environments does not support: ${unsupported}. Change the configuration of the repository.`,
  /** Concept 7.7: the new environment image of an update was refused by the host access policy; the old one starts. */
  updateRefused: (items: string) =>
    `The newer image of the environment needs access to your computer, which Dev Environments does not allow: ${items}. The environment is started without the update.`,
  /** Concept 7.5, section 9: a container of an older version of the extension is created again. */
  containerRecreated:
    'Dev Environments was updated, so the container of the environment is set up again. Your files in the repository are kept. Files in other folders of the container, for example in the home folder, are removed.',
  /** A container that was created while the configuration could not be read is created again with it. */
  containerConfigApplied:
    'The configuration of the environment can be read again, so the container is set up again with it. Your files in the repository are kept. Files in other folders of the container, for example in the home folder, are removed.',
  /**
   * Concept section 9 "Host access": a container that was created while the host access checks were off for the
   * repository is created again once they are on (and the configuration passes them).
   */
  containerHostAccessChecksOn:
    'The host access checks are on again for this repository, so the container is set up again with them. Your files in the repository are kept. Files in other folders of the container, for example in the home folder, are removed.',
  /**
   * The modal question of Turn Off Host Access Checks… (concept section 9 "Host access", user request 2026-09-26), with
   * what the configuration of the repository can then use (hostAccessChecksOffDetail).
   */
  hostAccessChecksOffConfirm: (repository: string) =>
    `Turn off the host access checks for ${repository}? Only do this for a repository that you trust.`,
  hostAccessChecksOffDetail:
    'The configuration of the repository, its Features, and its base image can then use your computer:\n' +
    '• the files and folders of your computer (bind mounts)\n' +
    '• the Docker socket, which gives full control of Docker and of every other environment, also of other GitHub accounts\n' +
    '• privileged mode, extra capabilities, and security options\n' +
    '• devices and GPUs of your computer\n' +
    '• published ports on all network addresses, so that other computers of the network can reach them\n' +
    '• the volumes of other programs, for example of Docker Compose or of the Dev Containers extension\n\n' +
    'Still checked: the volumes of your other environments and of other GitHub accounts, the GitHub account of the environment, and options that Dev Environments does not support. The change applies when the container of the environment is created next, for example with Rebuild. An existing container keeps its current settings, such as ports that are bound to this computer only.',
  /** After Turn Off Host Access Checks… */
  hostAccessChecksTurnedOff: (repository: string) =>
    `The host access checks are off for ${repository}. They apply again when you turn them on. The change applies when the container of the environment is created next, for example with Rebuild; an existing container keeps its current settings, such as ports that are bound to this computer only.`,
  /** After Turn On Host Access Checks. */
  hostAccessChecksTurnedOn: (repository: string) =>
    `The host access checks are on again for ${repository}. At the next start, a container that was made without them is set up again, if the configuration passes the checks. Your files in the repository are kept. Files in other folders of that container, for example in the home folder, are removed; copy them out before you start it again.`,
  /** The warning in the tooltip of a repository row whose host access checks are off. */
  hostAccessUnrestrictedTooltip:
    'Warning: the host access checks are off for this repository. Its configuration can use the files, devices, and Docker of your computer.',
  /** Entries of the setting devEnvLauncher.hostAccessChecksOff that are no repository name (`owner/name`). */
  hostAccessChecksOffInvalid: (entries: string) =>
    `The setting devEnvLauncher.hostAccessChecksOff has entries that are not a repository name like owner/name. They are ignored: ${entries}`,
  /** Concept section 9: Git before 2.9 does not remove the forwarding credential helper with an empty helper. */
  oldGit: (version: string) =>
    `Git ${version} in the environment is older than version 2.9. It may use the Git credentials of your computer instead of the GitHub account of the environment. Use an image with a newer Git.`,
  // The CLI resolves ${localEnv:NAME} in the workspace helper: a variable that the helper sets (HOME, PATH, HOSTNAME, and
  // the variables of its image, HELPER_ENV_NAMES) gets the value of the helper, any other one is empty or has its default
  // value. `helperNames`: those of `names` that the helper sets, when the caller knows them.
  localEnvNotPassed: (names: string, helperNames?: string) =>
    `The configuration uses variables of your computer: ${names}. Dev Environments does not pass their values to the environment. ` +
    (helperNames
      ? `The workspace helper sets ${helperNames} to its own values (for example, HOME is /root), not to the values of your computer. The others are empty or have their default value.`
      : 'They are empty or have their default value, except variables that the workspace helper sets itself (for example, HOME is /root).'),
  /**
   * Concept 7.5: an environment that a command names belongs to another account, for example a row or the status bar item
   * from before an account change, or an open during which the account changed. Never for a repository: each account
   * has its own environment of it (D-3).
   */
  otherAccount: (repository: string) =>
    `The environment of ${repository} belongs to another GitHub account. Sign in with that account to use it.`,
  /** Concept 7.5: the question before an entry of an older version is assigned to the signed-in account. */
  assignOlderEnvironment: (repository: string, login: string) =>
    `The environment of ${repository} was created before environments were separated by GitHub account. Assign it to ${login}? Afterwards, only ${login} can use it.`,
  /**
   * Concept 7.5: an entry of an older version has no owner, and the claim did not assign it to the signed-in account (no
   * answer of GitHub, no access, or no confirmation). Not "another account": nobody owns it yet.
   */
  olderEnvironmentNotAssigned: (repository: string) =>
    `The environment of ${repository} was created with an older version of Dev Environments and is not assigned to a GitHub account yet. It could not be assigned to the signed-in account: GitHub did not confirm the access to ${repository}, or the assignment was not confirmed. Try again later.`,
  /**
   * Concept 7.5: the entry of an older version of the repository stays without owner, and it uses named volumes of the
   * repository that a new environment would share. Nothing is created; the next Start asks again.
   */
  olderEnvironmentUsesVolumes: (repository: string) =>
    `The environment of ${repository} was created with an older version of Dev Environments and uses named volumes of the repository. A new environment would share them, so none was created. Assign the older environment to your account to use it.`,
  otherAccountConnection: (repository: string) =>
    `The environment of ${repository} does not belong to the GitHub account that is signed in. This window closes its connection.`,
  gitSetupFailed: 'Git in the environment could not be prepared. Pushing to GitHub may not work.',
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
    `The environment also used these volumes: ${volumes}. Remove them too?`,
  helperFailed: 'The workspace helper could not be prepared.',
  cloneFailed: 'The repository could not be downloaded.',
  noEnvironment: (repository: string) => `${repository} has no environment.`,
} as const;

export const Actions = {
  /** Opens the walkthrough "Set up Docker for Dev Environments" (command devEnvironments.installDocker). */
  installDocker: 'Install Docker…',
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
  assign: 'Assign',
  notNow: 'Not now',
  /** The button of the modal question of Turn Off Host Access Checks…. */
  turnOffChecks: 'Turn Off Checks',
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
  /** The marker of a repository whose host access checks are off (concept section 9 "Host access"). */
  hostAccessUnrestricted: 'host access unrestricted',
  /**
   * The suffix of the state text of a kept environment whose container runs, for example `Running · kept` (Keep Running
   * When Closed; user decision 2026-09-26, "go with the proposal for closing").
   */
  kept: 'kept',
} as const;

/** Formats the change counts of a Git summary, for example `2 uncommitted · 3 unpushed`. Empty when there are no changes. */
export function formatChanges(summary: { uncommittedFiles: number; unpushedCommits: number; stashes?: number }): string {
  const parts: string[] = [];
  if (summary.uncommittedFiles > 0) parts.push(`${summary.uncommittedFiles} uncommitted`);
  if (summary.unpushedCommits > 0) parts.push(`${summary.unpushedCommits} unpushed`);
  if (summary.stashes && summary.stashes > 0) parts.push(`${summary.stashes} stashed`);
  return parts.join(' · ');
}
