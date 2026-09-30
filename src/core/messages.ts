// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// All user-visible texts. Where the concept gives a text (section 6.5), the text here is exactly that text.
import { sshCommandLine } from './docker/dockerHost';

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
  dockerEngineNotRunning: 'Docker is not running. Start the Docker service with this command: sudo systemctl enable --now docker',
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
  /**
   * Review round 4 (D4-3): an environment without a build record (restored after a lost registry) whose containers are of
   * another kind than its configuration. Rebuild now switches the kind; Later keeps it (the non-destructive answer). No
   * docker start fallback (user decision 2026-09-29): Later starts no stopped dev container of Docker Compose without a
   * Docker Compose configuration; a running one opens as it is and its stopped services start when no container of the
   * environment must be created again (D-22, review round 19 of PR #64, R19-1; review round 22, A-R22-1; a container created
   * while the host access checks were off only while they are on now, review round 23, A-R23-2).
   */
  configurationKindChanged: (containersUseCompose: boolean, configPath: string) =>
    containersUseCompose
      ? `The containers of this environment use Docker Compose, but the configuration ${configPath} uses a single container. Rebuild now switches the environment to a single container: it removes the containers of the other services and the files outside the volumes; named volumes are kept. Later keeps Docker Compose without a rebuild: if the dev container runs already and no container of the environment must be created again, the dev container opens as it is, and the stopped containers of the other services are started. Otherwise nothing starts: a stopped dev container, or containers that must be created again (for example because an older version created them, or because they were created while the host access checks were off and the checks are on now), start only with a Docker Compose configuration. To use the Docker Compose configuration of the repository, choose Select configuration… in the list of environments.`
      : `The container of this environment is a single container, but the configuration ${configPath} uses Docker Compose. Rebuild now switches the environment to Docker Compose: it removes the container and the files outside the volumes; named volumes are kept. Later keeps the single container. To use the configuration of the single container, choose Select configuration… in the list of environments.`,
  /**
   * Review round 20 of PR #64 (R20-2): configurationKindChanged(true, …) in the window that is connected to the
   * environment (Switch branch…, configurationChanged). Later there only keeps the window connected: nothing is started
   * or removed (the next open starts the stopped services, D-22).
   */
  configurationKindChangedConnected: (configPath: string) =>
    `The containers of this environment use Docker Compose, but the configuration ${configPath} uses a single container. Rebuild now switches the environment to a single container: it removes the containers of the other services and the files outside the volumes; named volumes are kept. Later keeps Docker Compose without a rebuild: this window stays connected, and nothing is started or removed. To use the Docker Compose configuration of the repository, choose Select configuration… in the list of environments.`,
  /**
   * Review round 5 (P5-4): configurationKindChanged when the dev container of Docker Compose is missing: Later starts
   * nothing then (composeDevContainerMissing).
   */
  configurationKindChangedDevContainerMissing: (configPath: string) =>
    `The dev container of this Docker Compose environment is missing, and the configuration ${configPath} uses a single container. Rebuild now switches the environment to a single container: it removes the containers of the other services and the files outside the volumes; named volumes are kept. Later starts nothing and keeps the containers of the other services. To switch later, choose Rebuild; to use the Docker Compose configuration of the repository, choose Select configuration… in the list of environments.`,
  /**
   * Review round 4 (D4-2): Later for an environment whose Docker Compose dev container is missing: nothing can start
   * without the switch, so nothing is removed and nothing starts.
   */
  composeDevContainerMissing: (configPath: string) =>
    `The dev container of this Docker Compose environment is missing, and the configuration ${configPath} uses a single container. The containers of the other services are kept. Rebuild the environment to switch it to a single container, or choose Select configuration… for its Docker Compose configuration.`,
  /** Docker Compose could not read the compose files of a configuration (the details have its message). */
  /**
   * Review round 3 (P3-1): the configuration builds from a Dockerfile or a build context that does not exist in the
   * repository. Not a refusal: the existing environment still starts.
   */
  buildFileMissing: (what: string) => `The configuration names ${what}, which does not exist in the repository. Nothing was built.`,
  composeConfigurationFailed: 'The Docker Compose files of this configuration could not be read. The details show why.',
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
  /**
   * Review round 8: the host access analysis of the configuration failed (its worker ran out of time or memory, or
   * crashed): refused, never allowed. The text is ANALYSIS_FAILED_ITEM of helper/configurationAnalysis.ts.
   */
  configurationTooComplex: (item: string) => `${item}. Change the configuration of the repository.`,
  /**
   * Review round 9 (P9-2): the analysis of the configuration could not run (its worker did not start, or crashed without
   * an answer): no fault of the configuration. The item is analysisInternalItem of helper/configurationAnalysis.ts.
   */
  configurationCheckInternal: (item: string) => `${item}. Try again; if it fails again, reinstall Dev Environments.`,
  /**
   * Review round 12 (P12-1): Docker could not answer the check of the image references (a timeout, a daemon that cannot
   * be reached): no fault of the configuration, nor of the installation. The item is dockerCheckItem of
   * helper/configurationAnalysis.ts.
   */
  configurationCheckDocker: (item: string) => `${item}. Check that Docker is running and try again.`,
  /**
   * Review round 9 (P9-1): the check of the new environment image of an update failed (not a refusal of the policy): the
   * old one starts, and the next open tries the update again. The item says why (ANALYSIS_FAILED_ITEM or
   * analysisInternalItem).
   */
  updateCheckFailed: (item: string) => `The configuration could not be checked. Try again. (${item}.) The environment is started without the update.`,
  /** Both: settings that need access to the computer, and settings that the policy does not know. */
  hostAccessAndUnsupported: (items: string, unsupported: string) =>
    `This configuration needs access to your computer, which Dev Environments does not allow: ${items}. It also uses options that Dev Environments does not support: ${unsupported}. Change the configuration of the repository.`,
  /** Concept 7.7: the new environment image of an update was refused by the host access policy; the old one starts. */
  /**
   * Review round 10 (P10-3): the check of the new environment image of an update failed for a size limit (the item is
   * ANALYSIS_FAILED_ITEM); the old one starts, and the same update is not built again.
   */
  updateTooLarge: (item: string) => `The newer image of the environment is too large or too complex to check (${item}). The environment is started without the update.`,
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
   * The configuration of an environment of a Docker Compose configuration no longer uses Docker Compose: its container
   * is created again as a single container, and the containers of its other services are removed (their volumes stay).
   */
  // Review round 1 (P-1): the containers of the other services go; their named volumes stay, and the data in their
  // volumes without a name is no longer used (Docker keeps those volumes as unused volumes).
  containerComposeReplaced:
    'The configuration of the environment no longer uses Docker Compose, so the container is set up again, and the containers of the other services are removed. Your files in the repository and the data that the services keep in named volumes are kept. Data that the services keep in volumes without a name is no longer used; Docker keeps those volumes as unused volumes. Files in other folders of the container, for example in the home folder, are removed.',
  /**
   * Review round 22 (D22-1): the selected configuration names another service of the same Docker Compose project as its
   * dev container, and the previous dev container could not be renamed out of the way: it is removed (its volumes stay).
   */
  containerComposeDevServiceChanged:
    'The configuration of the environment uses another service of Docker Compose for the dev container, so the previous dev container is removed and the containers are set up again. Your files in the repository and the data in named volumes are kept. Files in other folders of the previous dev container, for example in the home folder, are removed.',
  /** Review round 1 (P-1): a single container is replaced by the containers of a Docker Compose configuration. */
  containerComposeCreated:
    'The configuration of the environment now uses Docker Compose, so the container is set up again with the containers of its services. Your files in the repository are kept. Files in other folders of the container, for example in the home folder, are removed.',
  /**
   * Recreate offer (user request 2026-09-26): the modal question when the existing container of an environment is
   * damaged, so that it cannot be started or used (for example its /etc/passwd lacks the user). `compose`: the containers
   * of a Docker Compose environment. The detail is containerRecreateDetail.
   */
  containerRecreateQuestion: (repository: string, compose: boolean) =>
    compose
      ? `The dev container of ${repository} cannot be started or used. Recreate it?`
      : `The container of ${repository} cannot be started or used. Recreate it?`,
  /**
   * Recreate offer: what stays and what is lost (the volumes are never removed). Review round 2 (V1): `unnamedFolders`
   * are the folders of the damaged container that are volumes without a name (for example `- /workspaces/api/node_modules`
   * in a compose file, `VOLUME /data` in the image): they are not carried over into the new container
   * (unnamedVolumesNotCarried).
   */
  containerRecreateDetail: (compose: boolean, unnamedFolders: readonly string[] = [], withoutConfiguration = false) =>
    (compose
      ? 'Only the dev container is removed and created again from its environment image. The other services, for example a database, keep running with their data. ' +
        'Kept: the repository with its uncommitted changes, unpushed commits, and stashes, the named volumes of the environment, and the containers of the other services. ' +
        'Lost: everything else in the dev container, for example installed packages, changes to the system, and files outside /workspaces and the volumes, such as the home folder. '
      : 'The container of the environment is removed and created again from its environment image. ' +
        'Kept: the repository with its uncommitted changes, unpushed commits, and stashes, and all files in the named volumes of the environment. ' +
        'Lost: everything else in the container, for example installed packages, changes to the system, and files outside /workspaces and the volumes, such as the home folder. ') +
    unnamedVolumesNotCarried(unnamedFolders) +
    // Review round 3: a single container created while the configuration cannot be read.
    (withoutConfiguration
      ? 'The configuration cannot be read now, so the new container starts without the runArgs of the configuration (also their mounts) and without its published ports, until the configuration can be read again; then the container is set up again. '
      : '') +
    'The setup commands of the configuration (onCreateCommand, postCreateCommand) run again. Cancel changes nothing.',
  /**
   * Recreate offer, review round 2 (E1–E3): after Recreate, the direct check before `up` found that Docker Compose would
   * also create the containers of other services again (`services`): nothing is changed.
   */
  composeServicesWouldBeRecreated: (services: string) =>
    `The dev container was not created again: Docker Compose would also create the containers of other services again (${services}), which the question promised to keep. Nothing was changed. Rebuild the environment instead.`,
  /**
   * Recreate offer, review round 1 (D1): after Recreate, the environment was changed meanwhile (for example by another
   * window): nothing is created again.
   */
  containerChangedMeanwhile:
    'The environment was changed in the meantime, for example in another window. The container was not created again, and nothing was changed. Try again.',
  /**
   * Recreate offer: the progress detail after the confirmation, as for the other recreations (concept 6.5), with the
   * folders in volumes without a name (containerRecreateDetail).
   */
  containerRecreatedDamaged: (unnamedFolders: readonly string[] = []) =>
    'The container of the environment could not be started, so it is set up again. Your files in the repository and in the named volumes are kept. Files in other folders of the container, for example in the home folder, are removed. ' +
    unnamedVolumesNotCarried(unnamedFolders).trim(),
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
  /**
   * Review round 9 (D9-2): the paths of the repository that the other services of Docker Compose mount
   * (Environment.serviceFolders): they are in the workspace volume, so Delete removes them with the repository;
   * the confirmation names them, as the question about the data volumes of the services (D-19) names those.
   */
  deleteRepositoryServiceData: (folders: string) => `Service data in the repository will be deleted: ${folders}.`,
  deleteAdditionalVolumes: (volumes: string) =>
    `The environment also used these volumes: ${volumes}. Remove them too?`,
  /**
   * D-19: the title of the question of Delete about the volumes of the Docker Compose project (the data of its services),
   * a list in which the user ticks the volumes to remove; none is ticked, and nothing ticked keeps them all.
   */
  deleteServiceDataTitle: 'Remove the data of the services too?',
  /** D-19: the hint of that list. */
  deleteServiceDataPlaceholder:
    'These volumes hold data of the services of the environment, for example of a database. Tick the ones to remove; the others are kept. Escape cancels the deletion.',
  /** D-19: the description of each volume in that list. */
  deleteServiceDataItem: 'data of the services',
  /**
   * Review round 3 (P3-4): the description of a volume in that list of an environment whose services are not known (for
   * example one restored from its volumes): it may hold data of a service, or be another additional volume.
   */
  deleteServiceDataPossibleItem: 'additional volume (possibly data of services)',
  /** Review round 3 (P3-4): the hint of that list when it holds such a volume. */
  deleteServiceDataPossiblePlaceholder:
    'These volumes may hold data of the services of the environment, for example of a database. Tick the ones to remove; the others are kept. Escape cancels the deletion.',
  helperFailed: 'The workspace helper could not be prepared.',
  /**
   * Review round 4 of PR #64 (R4-4), review round 14 (R14-1): the helper image could not be prepared at Step 5 of a
   * Rebuild or of the switch to a newly selected configuration, and the running container, which is current, opened as
   * it is. `change` names what was not applied; with a selected configuration, `previous` names the configuration that
   * stays selected. (A helperFailed in Step 8 ends the open instead, user decision 2026-09-29.)
   */
  helperFailedOpenedAsItIs: (change: 'rebuild' | 'configuration', previous?: string) =>
    `The workspace helper could not be prepared. The running environment is opened as it is: ${
      change === 'configuration'
        ? `the selected configuration was not applied${previous !== undefined ? `, and ${previous} stays selected` : ''}`
        : 'it was not rebuilt'
    }. Open it again to try again.`,
  /**
   * Review round 4 of PR #68 (B-R4-2): the lifecycle commands of a container could not run (the workspace helper
   * failed), it still runs, and the registry could not record that (Environment.lifecycleIncomplete).
   */
  lifecycleNotRecorded: (repository: string) =>
    `The container of ${repository} runs without its lifecycle commands, and this could not be recorded. Stop or rebuild the environment before working in it.`,
  cloneFailed: 'The repository could not be downloaded.',
  noEnvironment: (repository: string) => `${repository} has no environment.`,
  /**
   * Unit 7: the remote Docker host (the current Docker context, `ssh://…`) did not answer. `reason` is one of
   * dockerHostReason. Shown instead of the start of Docker Desktop and of the Docker setup.
   */
  dockerHostUnreachable: (host: string, reason: string) => `The Docker host ${host} cannot be reached. ${reason}`,
  /** Unit 7: the current Docker context points to another computer without SSH (for example `tcp://`). */
  dockerEndpointUnsupported: (endpoint: string) =>
    `Docker is set to ${endpoint}. Dev Environments uses Docker on another computer only over SSH. Choose "Dev Environments: Use a Remote Docker Host…" or "Dev Environments: Use the Local Docker".`,
  /**
   * User decision 2026-09-28: the window is not connected, because the container did not answer as running on the Docker
   * host that the window uses (checked right before the window connects).
   */
  containerNotReady: (repository: string, container: string) =>
    `The container ${container} of ${repository} does not run. Its state is in the details; start ${repository} again when the cause is fixed.`,
  /**
   * User decision 2026-09-28, review round 3 (H2): the pipeline ran, but the current Docker context changed to another
   * host meanwhile, so the window does not connect. The container stays on its host.
   */
  otherDockerHostAfterStart: (repository: string, environmentHost: string, currentHost: string) =>
    `The environment of ${repository} runs on ${describeHost(environmentHost)}, but Docker is now set to ${describeHost(currentHost)}, so this window does not connect to it. Choose "Dev Environments: Use a Remote Docker Host…" or "Dev Environments: Use the Local Docker" for ${describeHost(environmentHost)}, then start ${repository} again.`,
  /** Unit 7: an environment of another Docker host is never acted on. */
  otherDockerHost: (repository: string, environmentHost: string, currentHost: string) =>
    `The environment of ${repository} is on ${describeHost(environmentHost)}, but Docker is set to ${describeHost(currentHost)}. Nothing was changed.`,
} as const;

/**
 * Recreate offer, review round 2 (V1): the sentence about the folders of the damaged container that are volumes without
 * a name, or '' without such folders. Ends with a space.
 */
function unnamedVolumesNotCarried(folders: readonly string[]): string {
  if (folders.length === 0) return '';
  return `These folders are volumes without a name, which are not carried over: in the new container they start as the image has them (often empty), and their old content stays in a Docker volume without a name: ${listSome(folders)}. `;
}

function describeHost(host: string): string {
  return host === '' ? 'the local Docker' : host;
}

/** Unit 7: the plain reason of a failed connection to the remote Docker host `host` (see dockerHostProblem). */
export function dockerHostReason(
  problem: 'unreachable' | 'closedBeforeLogin' | 'login' | 'hostKey' | 'dockerMissing' | 'dockerNotRunning' | 'dockerPermission' | 'sshMissing' | 'unknown',
  host: string,
): string {
  switch (problem) {
    case 'unreachable':
      return 'The computer does not answer. Check its name and the network connection.';
    case 'closedBeforeLogin':
      return 'Its SSH server closed the connection before the login. It may limit new connections, for example after failed logins or while many open at once. Wait a minute, then try again. Connection sharing in your SSH config (ControlMaster auto with ControlPersist) lets every Docker call use one connection.';
    case 'login':
      return 'SSH could not log in. Add your SSH key to the SSH agent (ssh-add) or name it in your SSH config, then try again.';
    case 'hostKey':
      return `SSH does not know the host key of this computer yet. Run "${sshCommandLine(host)}" once in a terminal, check the key and accept it, then try again.`;
    case 'dockerMissing':
      return 'Docker is not installed on that computer.';
    case 'dockerNotRunning':
      return 'Docker is not running on that computer.';
    case 'dockerPermission':
      return 'Your user on that computer may not use Docker. Add it to the group docker there.';
    case 'sshMissing':
      return 'The SSH client (ssh) was not found on this computer.';
    case 'unknown':
      return 'The details show why.';
  }
}

export const Actions = {
  /** Shows the sidebar view with the steps of the Docker setup (action of the error dockerNotInstalled). */
  installDocker: 'Install Docker…',
  /** Starts Docker Engine on Linux with `sudo systemctl enable --now docker` in a terminal, after a confirmation (action
   *  of the error dockerEngineNotRunning). */
  startDocker: 'Start Docker',
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
  /** The button of the modal question of the recreate offer (Messages.containerRecreateQuestion). */
  recreateContainer: 'Recreate',
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
   * The suffix of the state text of a kept environment whose container runs or is stopped, for example `Running · kept`
   * or `Stopped · kept` (Keep Running When Closed; user decision 2026-09-26, "go with the proposal for closing").
   */
  kept: 'kept',
  /**
   * Review round 7, P7-2: the suffix of the state text of an environment whose dev container does not run while another
   * service of Docker Compose runs, for example `Stopped · services running` (Stop stays offered).
   */
  servicesRunning: 'services running',
} as const;

/** The most names that one message lists (review round 9, S9-1). */
export const MAX_LISTED_NAMES = 20;

/**
 * Review round 9 (S9-1): `items` joined with `, `, at most `max` of them, then `and <n> more`, so that a configuration
 * with thousands of names gives a message of normal length.
 */
export function listSome(items: readonly string[], max = MAX_LISTED_NAMES, separator = ', '): string {
  if (items.length <= max) return items.join(separator);
  return `${items.slice(0, max).join(separator)}${separator}and ${items.length - max} more`;
}

/** Formats the change counts of a Git summary, for example `2 uncommitted · 3 unpushed`. Empty when there are no changes. */
export function formatChanges(summary: { uncommittedFiles: number; unpushedCommits: number; stashes?: number }): string {
  const parts: string[] = [];
  if (summary.uncommittedFiles > 0) parts.push(`${summary.uncommittedFiles} uncommitted`);
  if (summary.unpushedCommits > 0) parts.push(`${summary.unpushedCommits} unpushed`);
  if (summary.stashes && summary.stashes > 0) parts.push(`${summary.stashes} stashed`);
  return parts.join(' · ');
}
