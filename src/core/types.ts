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
  /** Highest build number used so far for this environment. */
  lastBuildNumber?: number;
  /**
   * The GitHub account that created the environment. Only this account can use it. Entries of an older version have
   * none until an account claims them: without a question only when the entry can belong to no other account, otherwise
   * after a confirmation of the user (concept 7.5).
   */
  owner?: GitHubAccount;
  /**
   * An update whose new environment image the host access policy refused (concept 7.7): the same update is not built
   * again until a digest or the configuration changes.
   */
  refusedUpdate?: RefusedUpdate;
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
}

/**
 * An additional volume that a Delete kept (concept 7.14 step 4), with the account whose environment used it: it stays
 * foreign for the environments of other accounts while it exists (concept section 9 "Host access").
 */
export interface KeptVolume {
  name: string;
  /** Missing for a volume of an entry of an older version without owner. */
  owner?: GitHubAccount;
  keptAt: string;
}

export interface RegistryFile {
  version: 1;
  environments: Environment[];
  /** Additional volumes that a Delete kept. Missing in files of earlier versions. */
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
  /**
   * The permission of the account on GitHub (`viewerPermission`: ADMIN, MAINTAIN, WRITE, TRIAGE, or READ). Missing when
   * GitHub does not return it, and in lists of older versions.
   */
  viewerPermission?: string;
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
   * The scan scope that the list was built with (lower-case logins, sorted; `normalizeScope`). Missing or empty: all
   * repositories that the account can access (lists of older versions have none).
   */
  scope?: string[];
  /**
   * The repositories of the scan that have no configuration, so that a later refresh reads the configurations only of
   * new and changed repositories. Missing in lists of older versions.
   */
  withoutConfiguration?: CheckedRepository[];
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
  /**
   * For `delete`, written by an earlier version: also remove the additional volumes. That version's question listed the
   * recorded additional volumes, so they are removed (pendingVolumesToRemove).
   */
  removeAdditionalVolumes?: boolean;
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
   * section 9 "Host access"; hostAccessChecks in hostAccessChecks.ts). Only the user setting counts.
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
