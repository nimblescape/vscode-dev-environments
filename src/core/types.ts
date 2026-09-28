// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared data types. Stored files (registry.json, repositories-<account ID>.json, session files) use these shapes.
// All times are ISO 8601 strings in UTC, unless a field says otherwise.

/** Last known Git state of the workspace volume (concept 7.5). */
export interface GitSummary {
  /** Checked-out branch. `null` for a detached HEAD or when unknown. */
  branch: string | null;
  uncommittedFiles: number;
  unpushedCommits: number;
  stashes: number;
  recordedAt: string;
}

/** Name of the current environment image and the digests it was built from (concept 7.5, 7.7). */
export interface BuildRecord {
  builtAt: string;
  /** For example `devenv-3f2a9c1e:2`. */
  environmentImage: string;
  buildNumber: number;
  /** Configuration that this build used. */
  configPath: string;
  /** `sha256:<hex>` of the devcontainer.json text plus the Dockerfile text, if any. */
  configHash: string;
  /** Image reference as written in the configuration → digest read right before the build. */
  images: Record<string, string>;
  /** Feature reference as written in the configuration → digest read right before the build. */
  features: Record<string, string>;
  /**
   * A Docker Compose configuration (implementation notes, section "Docker Compose"): the dev service, and the images
   * that Compose and the Dev Container CLI built for the project (builtServiceImages), which Delete removes. The
   * environment image is the image of the dev service.
   */
  compose?: ComposeBuildRecord;
}

/** BuildRecord.compose. */
export interface ComposeBuildRecord {
  /** `service` of devcontainer.json: the dev service. */
  service: string;
  /** `devenv-<short id>-<service>` of each service that Compose builds. */
  images: string[];
  /**
   * The `image` references of the other services that are not built (for example `postgres:16`), as the image check
   * names them in `images` of the build record (review round 1, D5). They are images of the user, pulled for the
   * services, not base images of the environment image: removeUnusedBaseImages never removes them.
   */
  serviceImages: string[];
  /**
   * Review round 1 (P-4): the version of the Compose plugin that printed the model of `configHash`, and composeInputsHash
   * of the files as written. A new Compose version can print the same files as another model: with equal files, a
   * different model counts as a change only with the same version (composeConfigurationChange).
   */
  version: string;
  inputsHash: string;
}

export type BusyOperation = 'create' | 'update' | 'rebuild' | 'delete' | 'switchBranch';

/** Marks an environment as busy, so the Session Monitor does not stop it (concept 7.9 rule 1). */
export interface BusyMark {
  operation: BusyOperation;
  since: string;
  /** Process ID of the extension host that set the mark. A mark of an ended process is ignored. */
  pid: number;
  windowId: string;
}

/** A GitHub account of the VS Code GitHub sign-in (concept section 9 "Accounts"). */
export interface GitHubAccount {
  /** Numeric GitHub user ID as a string (`session.account.id`; the `databaseId` of the GraphQL API). */
  id: string;
  /** Login (`session.account.label`). Empty for an owner that was restored from a volume label, until the next open. */
  login: string;
}

/** One entry of the Environment Registry (concept 7.5). */
export interface Environment {
  /** `crypto.randomUUID()`. */
  id: string;
  /** `owner/name` with the case that GitHub uses. */
  repository: string;
  /** For example `.devcontainer/python/devcontainer.json`. */
  configPath: string;
  volumeName: string;
  containerName: string;
  createdAt: string;
  lastUsedAt: string;
  gitSummary?: GitSummary;
  buildRecord?: BuildRecord;
  busy?: BusyMark;
  /** From the result of `devcontainer up`. */
  remoteUser?: string;
  /** From the result of `devcontainer up`. For example `/workspaces/api`. */
  remoteWorkspaceFolder?: string;
  /** The repository configuration sets `"shutdownAction": "none"`. */
  shutdownActionNone?: boolean;
  /** Named volumes of the configuration (`mounts` with `type=volume`), without the workspace volume. */
  additionalVolumes?: string[];
  /**
   * Docker Compose (review round 1, D1): the named volumes that services other than the dev service mounted, recorded
   * at each open from the checked model (composeServiceVolumeNames) and kept once recorded. Delete lists these volumes
   * as data of the services (none ticked), whatever their label nimblescape.devenv.volume, also when the configuration
   * cannot be read.
   */
  serviceVolumes?: string[];
  /**
   * Review round 10 (D10-1): the paths of the repository (absolute, for example `/workspaces/api/data/postgres`) that the
   * containers of the other services of Docker Compose may mount from the workspace volume (composeUpModel's
   * `serviceFolders`), written before each `up`, also before the first build record. The list does not shrink while such
   * a container may still mount a path of it: an `up` adds the paths of its model; only an `up` before which no
   * container of another service exists (all of them were removed) replaces it. The ownership fixes after `up` and of
   * Switch branch… leave the data of the services there alone, and the question of Delete names them.
   * Review round 11 (G3, G4, G5): the record of the list that the pipeline computes from facts at each `up`
   * (boundServiceFolders): the paths of the model, the paths that the existing containers of the other services mount
   * (their volume subpaths), and the recorded paths of earlier models while they still exist in the volume; at most
   * MAX_SERVICE_FOLDERS. Before an `up` it only grows (a failed `up` leaves the containers of the earlier models); after
   * it, a path that no model, no container, and no file names any more is dropped. reconcileFromVolumes fills it from
   * the mounts of the containers that it finds.
   */
  serviceFolders?: string[];
  /**
   * Review round 11 (G5): the list had more than MAX_SERVICE_FOLDERS paths, so not all are recorded: the ownership fixes
   * leave the whole repository to the services (only the files of root get their owner). It stays set.
   */
  serviceFoldersOverflow?: boolean;
  /** Highest build number used so far for this environment. */
  lastBuildNumber?: number;
  /** The GitHub account that created the environment. Only this account can use it (concept 7.5). */
  owner: GitHubAccount;
  /**
   * An update whose new environment image the host access policy refused (concept 7.7): the same update is not built
   * again until a digest or the configuration changes.
   */
  refusedUpdate?: RefusedUpdate;
  /**
   * Keep Running When Closed (concept 7.9; user decision 2026-09-26, "go with the proposal for closing"): the Session
   * Monitor never stops this environment when no window uses it; only the user's Stop or Delete does. Missing or false: the container stops after the waiting time, as the setting stopOnClose says.
   */
  keepRunning?: boolean;
  /**
   * Close and Keep Running (unit 7, PR 2): the window was closed with this command, so the container keeps running this
   * time, as with `keepRunning`. Cleared when a window connects to the environment again, and by Stop (Delete removes the
   * entry). Missing or false: as `keepRunning` says.
   */
  keepRunningOnce?: boolean;
  /**
   * Unit 7: the Docker host of the environment, the part after `ssh://` of the Docker context in which it was created
   * (an SSH alias or `user@host[:port]`). Missing: the local Docker. The view, the switcher, the status bar, and every
   * command show and act on the environments of the current Docker host only.
   */
  dockerHost?: string;
}

/**
 * An update whose new environment image the host access policy refused (concept 7.7, section 9 "Host access"): the
 * configuration and the digests of the image check that led to it. The same update is not built again; a changed digest
 * or configuration, or a manual rebuild, tries again.
 */
export interface RefusedUpdate {
  configPath: string;
  configHash: string;
  /** Image reference → digest, as recordDigests gives it for the build record. */
  images: Record<string, string>;
  /** Feature reference → digest. */
  features: Record<string, string>;
  /** What the new image needed, for the message (Messages.updateRefused). */
  items: string;
  /**
   * `off` when the host access checks were off for the repository at the refusal (only settings that stay refused then,
   * for example a variable of the GitHub CLI); absent when they were on. An update refused with one state of the switch
   * is tried again with the other.
   */
  hostAccessChecks?: 'off';
  /**
   * Review round 10 (P10-3): `size` when the check of the new image failed for a size limit (AnalysisFailure `size`, for
   * example an oversized devcontainer.metadata label), not for the policy (Messages.updateTooLarge); absent otherwise.
   */
  reason?: 'size';
}

/**
 * An additional volume that a Delete kept (concept 7.14 step 4), with the account whose environment used it: it stays
 * foreign for the environments of other accounts while it exists (concept section 9 "Host access").
 */
export interface KeptVolume {
  name: string;
  owner: GitHubAccount;
  keptAt: string;
}

export interface RegistryFile {
  version: 1;
  environments: Environment[];
  /** Additional volumes that a Delete kept. Missing when there are none. */
  keptVolumes?: KeptVolume[];
}

/** A repository found by the discovery (concept 7.4). */
export interface RepositoryInfo {
  /** `owner/name`. */
  nameWithOwner: string;
  owner: string;
  name: string;
  /** `https://github.com/owner/name`. */
  url: string;
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  pushedAt: string | null;
  defaultBranch: string | null;
  /** Configuration paths in the order of precedence. The first one is the default. */
  configPaths: string[];
}

/**
 * `saml`, `oauthRestricted`, `other`: GitHub refuses the access. `notFound`: an organization or account of the scan scope
 * (setting `owners`) does not exist, or the account cannot see it.
 */
export type OrganizationHintKind = 'saml' | 'oauthRestricted' | 'other' | 'notFound';

/** Hint for an organization whose repositories the API did not return (concept 7.4). */
export interface OrganizationHint {
  organization: string;
  kind: OrganizationHintKind;
  /** URL where the user can authorize the access. */
  url: string;
}

/**
 * A repository of the last discovery without a Dev Container configuration, with the state of GitHub its detection was
 * read from (incremental detection, concept 7.4).
 */
export interface CheckedRepository {
  nameWithOwner: string;
  pushedAt: string | null;
  defaultBranch: string | null;
}

/** Content of repositories-<account ID>.json. */
export interface DiscoveryData {
  version: 1;
  fetchedAt: string;
  viewerLogin: string;
  /** Logins of the organizations where the user is a member. */
  organizations: string[];
  repositories: RepositoryInfo[];
  hints: OrganizationHint[];
  /**
   * The scan scope that the list was built with (lower-case logins, sorted; `normalizeScope`). Empty: all repositories
   * that the account can access.
   */
  scope: string[];
  /**
   * The repositories of the scan that have no configuration, so that a later refresh reads the configurations only of
   * new and changed repositories.
   */
  withoutConfiguration: CheckedRepository[];
  /**
   * Repositories with a configuration whose lookup was not complete (a GraphQL error in its part of the answer), by
   * `owner/name`: the next refresh reads their configurations again (concept 7.4). Missing when there are none.
   */
  uncertain?: string[];
}

/** Content of sessions/<window-id>.json (concept 7.9). */
export interface WindowStatus {
  windowId: string;
  /** Process ID of the local extension host of the window. */
  pid: number;
  environmentId: string | null;
  state: 'active' | 'closing';
  updatedAt: string;
  /**
   * The Docker context named in the authority of the window (review of the attach context, A2): another window that
   * wants to show this one opens exactly its URI. Missing for a window without one (and in files of earlier versions).
   */
  dockerContext?: string;
}

/** Content of pending/<environment-id>.json (concept 7.9). */
export interface PendingConnection {
  environmentId: string;
  windowId: string;
  createdAt: string;
}

/**
 * `stop` exists because Stop of the environment that the window is connected to closes the remote connection first
 * (concept 6.2), which reloads the window; the reloaded window finishes the stop.
 */
export type PendingOperationKind = 'rebuild' | 'delete' | 'stop';

/** Content of operations/<environment-id>.json (concept 7.14). */
export interface PendingOperation {
  environmentId: string;
  operation: PendingOperationKind;
  requestedAt: string;
  /** Window ID of the window that requested the operation. */
  requestedBy: string;
  reason: 'manual' | 'update' | 'configChanged' | 'configurationSelected';
  /** New configuration path, for `configurationSelected`. */
  configPath?: string;
  /**
   * For `delete`: the additional named volumes that the user confirmed for removal, as the question listed them. A volume
   * that the environment recorded after the question is kept.
   */
  additionalVolumesToRemove?: string[];
}

/** Content of reopen.json (concept 7.10). */
export interface ReopenRecord {
  environmentId: string;
  closedAt: string;
}

/** Content of monitor.json. */
export interface MonitorSettings {
  waitingTimeSeconds: number;
  stopOnClose: boolean;
  respectShutdownActionNone: boolean;
  /**
   * Unit 7, PR 2: the time limit that the heartbeats give the Session Monitor on a remote Docker host (the setting
   * remoteStopAfterMinutes in seconds). Missing (a file of an older window): DEFAULT_REMOTE_STOP_AFTER_SECONDS.
   */
  remoteStopAfterSeconds?: number;
  updatedAt: string;
}

/** Settings of concept section 8. */
export interface ExtensionSettings {
  reopenLastOnStartup: boolean;
  stopOnClose: boolean;
  waitingTimeSeconds: number;
  updateImagesOnConnect: boolean;
  respectShutdownActionNone: boolean;
  owners: string[];
  includeArchived: boolean;
  includeForks: boolean;
  refreshIntervalMinutes: number;
  /**
   * Repositories (`owner/name`, valid entries only, trimmed) whose host access checks are off (concept section 8 and
   * section 9 "Host access"; hostAccessChecks in policy/hostAccessChecks.ts). Only the user setting counts.
   */
  hostAccessChecksOff: string[];
  /**
   * Raw entries of `repositoryGroups` (concept 6.2, 8): regular expressions that filter and group the repositories of the
   * sidebar. The sidebar checks each entry (src/vscode/repositoryGroups.ts). Missing: the same as an empty list.
   */
  repositoryGroups?: unknown[];
  /**
   * `openInNewWindow` (concept 6.2, 8): Start opens the environment in a new window, and the current window keeps its
   * environment. Only the user setting counts (scope `application`). Missing: false (Start uses the current window).
   */
  openInNewWindow?: boolean;
  /**
   * `remoteStopAfterMinutes` (unit 7, PR 2): a container on a remote Docker host stops after this many minutes without
   * contact from this computer, unless it keeps running when closed. 5 to 1440. Missing: 10.
   */
  remoteStopAfterMinutes?: number;
}

/** State of a container as Docker reports it, simplified. */
export type ContainerState = 'running' | 'stopped' | 'missing';

/** State of an environment as the sidebar shows it (concept 6.2, 7.15). */
export type EnvironmentState =
  | 'connected'
  | 'connectedOtherWindow'
  | 'running'
  | 'stopped'
  | 'updating'
  | 'noContainer'
  | 'filesMissing';

/** JSON result on the last line of standard output of `devcontainer build` and `devcontainer up`. */
export interface DevcontainerResult {
  outcome: 'success' | 'error';
  message?: string;
  description?: string;
  containerId?: string;
  /** `devcontainer up` of a Docker Compose configuration: the project name that the CLI used. */
  composeProjectName?: string;
  imageName?: string | string[];
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
}

/**
 * The part of a (resolved) devcontainer.json configuration that the extension reads.
 * Other properties may exist.
 */
export interface DevcontainerConfig {
  name?: string;
  image?: string;
  build?: {
    dockerfile?: string;
    context?: string;
    args?: Record<string, string>;
    target?: string;
    /** Options of `docker build`. */
    options?: string[];
  };
  /** Deprecated form of `build.dockerfile`. */
  dockerFile?: string;
  dockerComposeFile?: string | string[];
  /** Docker Compose: the dev service. */
  service?: string;
  /** Docker Compose: the services that `up` starts besides the dev service (default: all). */
  runServices?: string[];
  features?: Record<string, unknown>;
  runArgs?: string[];
  appPort?: number | string | Array<number | string>;
  mounts?: Array<string | { source?: string; target?: string; type?: string }>;
  workspaceMount?: string;
  workspaceFolder?: string;
  shutdownAction?: 'none' | 'stopContainer' | 'stopCompose';
  initializeCommand?: unknown;
  privileged?: boolean;
  capAdd?: string[];
  securityOpt?: string[];
  remoteUser?: string;
  containerUser?: string;
  [key: string]: unknown;
}
