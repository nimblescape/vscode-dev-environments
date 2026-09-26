// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Arguments and results of the Dev Container CLI in the workspace helper (implementation notes 8). Pure functions.
import { CommandError } from '../errors';
import type { DevcontainerConfig, DevcontainerResult } from '../types';
import { ATTACHED_SHUTDOWN_ACTION, devContainersSettings, SKIP_POST_ATTACH_ARG } from '../devContainers';
import type { HostAccessChecks } from '../hostAccessChecks';
import { CONTAINER_VERSION_LABEL, HOST_ACCESS_UNRESTRICTED_LABEL, WORKSPACES_ROOT } from '../names';
import { containerEnvironment, remoteEnvironment } from './containerGit';
import { loopbackAppPorts, overrideRunArgs, withoutNameArgs } from './hostAccess';

/**
 * Mount point of the cache volume devenv-helper-cache in the helper, passed as `--user-data-folder`.
 * Assumption (V-10): the CLI keeps data there that is useful across helper runs. CLI 0.89.0 downloads Features into a
 * new folder below os.tmpdir() for each build, so the Features themselves are not cached there.
 */
export const HELPER_CACHE_FOLDER = '/devenv-cache';

/**
 * Arguments of `devcontainer read-configuration`. With `merged` (default), the result also has `mergedConfiguration`:
 * the configuration merged with the metadata of the base image and of the Features (or of the existing container), which
 * the host access policy checks (concept section 9). Without a container, the CLI reads the base image and the Features
 * for it (from the registries, if they are not local).
 */
export function readConfigurationArgs(p: {
  workspaceFolder: string;
  configPath: string;
  idLabel: string;
  merged?: boolean;
  /** `--override-config` (Docker Compose: composeConfigOverride, which names our model). */
  overrideConfigPath?: string;
}): string[] {
  const args = ['read-configuration', '--workspace-folder', p.workspaceFolder, '--config', p.configPath, '--id-label', p.idLabel];
  if (p.overrideConfigPath !== undefined) args.push('--override-config', p.overrideConfigPath);
  if (p.merged !== false) args.push('--include-merged-configuration');
  return args;
}

/**
 * Arguments of `devcontainer build`. `build` has no `--override-config` (CLI 0.89.0, devContainersSpecCLI.js, the
 * handler of `build`: `configFile:v,overrideConfigFile:J` with `J=void 0`), so a Docker Compose configuration is built
 * with `--config` naming our copy of the configuration (composeConfigOverride) in the helper.
 */
export function buildArgs(p: { workspaceFolder: string; configPath: string; imageName: string }): string[] {
  return [
    'build',
    '--workspace-folder',
    p.workspaceFolder,
    '--config',
    p.configPath,
    '--image-name',
    p.imageName,
    '--user-data-folder',
    HELPER_CACHE_FOLDER,
  ];
}

/**
 * Arguments of `devcontainer up` with the override configuration (it replaces the repository configuration; everything
 * else comes from the label devcontainer.metadata of the environment image).
 * `--update-remote-user-uid-default never`: the "local" user of the CLI is root in the helper, so a UID update is
 * meaningless, and it would build an additional image `<name>-uid` at each container creation. The files of the
 * volume get their owner through ownershipFixCommand instead.
 */
export function upArgs(p: {
  workspaceFolder: string;
  overrideConfigPath: string;
  idLabel: string;
  removeExistingContainer: boolean;
}): string[] {
  const args = [
    'up',
    '--workspace-folder',
    p.workspaceFolder,
    '--override-config',
    p.overrideConfigPath,
    '--id-label',
    p.idLabel,
    '--user-data-folder',
    HELPER_CACHE_FOLDER,
    '--update-remote-user-uid-default',
    'never',
    SKIP_POST_ATTACH_ARG,
  ];
  if (p.removeExistingContainer) args.push('--remove-existing-container');
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The result object if `line` is the JSON result of `build` or `up`, otherwise undefined. */
export function tryParseDevcontainerResult(line: string): DevcontainerResult | undefined {
  const text = line.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || (value.outcome !== 'success' && value.outcome !== 'error')) return undefined;
  return value as unknown as DevcontainerResult;
}

/**
 * The JSON result on the last line of standard output of `devcontainer build` and `devcontainer up`: the last non-empty
 * line that parses as JSON with an `outcome` field. Throws if there is none.
 */
export function parseDevcontainerResult(stdout: string): DevcontainerResult {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue;
    const result = tryParseDevcontainerResult(lines[i]);
    if (result) return result;
  }
  throw new Error(`The Dev Container CLI returned no result: ${JSON.stringify(stdout.trim().slice(-300))}`);
}

// `[<name> of ]<command> from <origin> failed.`: <name> is a key of the object form of the command, <origin> is
// `devcontainer.json` or `Feature '<id>'`.
const LIFECYCLE_FAILURE =
  /^(?:.+ of )?(?:onCreateCommand|updateContentCommand|postCreateCommand|postStartCommand|postAttachCommand) from .+ failed\.$/;

/**
 * Whether the result of `devcontainer up` reports a failed lifecycle command of a container that exists.
 * Assumption (V-10): when a lifecycle command exits with a code other than 0, CLI 0.89.0 skips the further commands,
 * ends `up` with exit code 1 and the result `{ outcome: 'error', containerId, description: '… from … failed.' }`, and
 * leaves the container running. initializeCommand runs before the container starts, so it is not one of them.
 */
export function isLifecycleCommandFailure(
  result: DevcontainerResult | undefined,
): result is DevcontainerResult & { containerId: string; description: string } {
  return (
    result?.outcome === 'error' &&
    typeof result.containerId === 'string' &&
    result.containerId.trim() !== '' &&
    typeof result.description === 'string' &&
    LIFECYCLE_FAILURE.test(result.description)
  );
}

/**
 * A `devcontainer build` or `up` that failed. `result` is the JSON result of the CLI, if it printed one.
 * The message names the message of the CLI result when there is one.
 */
export class DevcontainerCommandError extends CommandError {
  constructor(
    command: string,
    exitCode: number | null,
    stdout: string,
    stderr: string,
    readonly result?: DevcontainerResult,
  ) {
    super(command, exitCode, stdout, stderr);
    this.name = 'DevcontainerCommandError';
    if (result?.outcome === 'error' && (result.message || result.description)) {
      const text = [result.message, result.description].filter(Boolean).join(' ');
      this.message = `${command} failed with exit code ${exitCode}: ${text}`;
    }
  }
}

/**
 * Removes `--name <value>` and `--name=<value>` from docker run arguments, read as the host access policy and Docker read
 * them (withoutNameArgs): a `--name` that is the value of another flag stays.
 */
export function stripNameArgs(runArgs: readonly string[]): string[] {
  return withoutNameArgs(runArgs);
}

/**
 * Override configuration for `up` (implementation notes 8, concept 7.6): only image, workspaceMount, workspaceFolder,
 * runArgs (the repository values as the host access policy checks them, overrideRunArgs: without any --name and with
 * 127.0.0.1 for published ports without an address; plus `--label devenv.container-version=<n>` and
 * `--name <container name>`), appPort (if set, on 127.0.0.1), containerEnv, remoteEnv, and the settings of the Dev
 * Containers extension in customizations (container-only Git, concept section 9), and shutdownAction 'none'
 * (ATTACHED_SHUTDOWN_ACTION, ../devContainers.ts).
 * `hostAccessChecks` `off` (the switch of the repository, ../hostAccessChecks.ts): the published ports of runArgs and
 * appPort keep the address that the configuration gives them (appPort as the configuration writes it), and runArgs get
 * `--label devenv.host-access=unrestricted`, so that the container is created again once the checks are on.
 * `initializeCommand` is never passed: the host access policy refuses a configuration with one.
 */
export function buildOverrideConfig(p: {
  environmentImage: string;
  volumeName: string;
  repositoryName: string;
  containerName: string;
  runArgs?: string[];
  appPort?: DevcontainerConfig['appPort'];
  hostAccessChecks?: HostAccessChecks;
}): Record<string, unknown> {
  const checksOn = p.hostAccessChecks !== 'off';
  const labels = checksOn ? ['--label', CONTAINER_VERSION_LABEL] : ['--label', CONTAINER_VERSION_LABEL, '--label', HOST_ACCESS_UNRESTRICTED_LABEL];
  const override: Record<string, unknown> = {
    image: p.environmentImage,
    workspaceMount: `source=${p.volumeName},target=${WORKSPACES_ROOT},type=volume`,
    workspaceFolder: `${WORKSPACES_ROOT}/${p.repositoryName}`,
    runArgs: [...overrideRunArgs(p.runArgs, checksOn), ...labels, '--name', p.containerName],
  };
  const appPort = checksOn ? loopbackAppPorts(p.appPort) : p.appPort;
  if (appPort !== undefined && appPort !== null) override.appPort = appPort;
  // Merged over the containerEnv, remoteEnv, and settings of the image metadata; these values win. The settings only add
  // to the customizations of the image metadata (its extensions and other settings stay).
  override.containerEnv = containerEnvironment();
  override.remoteEnv = remoteEnvironment();
  override.customizations = { vscode: { settings: devContainersSettings() } };
  override.shutdownAction = ATTACHED_SHUTDOWN_ACTION;
  return override;
}

/**
 * The configuration of a Docker Compose configuration for `read-configuration` (`--override-config`) and `build`
 * (`--config`, buildArgs): the repository configuration as written (`raw`, parsed devcontainer.json; the CLI resolves
 * its variables as usual), with `dockerComposeFile` naming only our model (an absolute path: the CLI resolves the paths
 * against the folder of `--config`, CLI 0.89.0 function `sg`), and without `initializeCommand`, which the host access
 * policy refuses anyway (it would run in the helper, which has the Docker socket).
 */
export function composeConfigOverride(raw: Readonly<Record<string, unknown>>, modelPath: string): Record<string, unknown> {
  const config: Record<string, unknown> = { ...raw, dockerComposeFile: [modelPath] };
  delete config.initializeCommand;
  return config;
}

/**
 * Override configuration of `devcontainer up` for a Docker Compose configuration (the counterpart of buildOverrideConfig):
 * `dockerComposeFile` names only our model (composeUpModel, an absolute path), `service`, `runServices` (when the
 * repository names them), `workspaceFolder`, and, as in buildOverrideConfig, containerEnv, remoteEnv, the settings of
 * the Dev Containers extension, and shutdownAction 'none'. No image, runArgs, appPort, or workspaceMount: the CLI
 * ignores them for Compose (CLI 0.89.0: `if("dockerComposeFile"in t)return{workspaceFolder:pp(t),workspaceMount:void 0,…}`;
 * runArgs and appPort are read only for a single container); the model carries the image, the name, the labels, the
 * ports, and the workspace volume. The CLI writes containerEnv as `environment` of the dev service into its last compose
 * file, so these values win. `initializeCommand` is never passed.
 */
export function buildComposeOverrideConfig(p: {
  modelPath: string;
  service: string;
  runServices?: readonly string[];
  repositoryName: string;
}): Record<string, unknown> {
  const override: Record<string, unknown> = {
    dockerComposeFile: [p.modelPath],
    service: p.service,
  };
  if (p.runServices !== undefined) override.runServices = [...p.runServices];
  override.workspaceFolder = `${WORKSPACES_ROOT}/${p.repositoryName}`;
  override.containerEnv = containerEnvironment();
  override.remoteEnv = remoteEnvironment();
  override.customizations = { vscode: { settings: devContainersSettings() } };
  override.shutdownAction = ATTACHED_SHUTDOWN_ACTION;
  return override;
}
