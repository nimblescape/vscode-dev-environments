// Arguments and results of the Dev Container CLI in the workspace helper (implementation notes 8). Pure functions.
import { CommandError } from '../errors';
import type { DevcontainerConfig, DevcontainerResult } from '../types';
import { WORKSPACES_ROOT } from '../names';

/**
 * Mount point of the cache volume devenv-helper-cache in the helper, passed as `--user-data-folder`.
 * Assumption (V-10): the CLI keeps data there that is useful across helper runs. CLI 0.89.0 downloads Features into a
 * new folder below os.tmpdir() for each build, so the Features themselves are not cached there.
 */
export const HELPER_CACHE_FOLDER = '/devenv-cache';

export function readConfigurationArgs(p: { workspaceFolder: string; configPath: string; idLabel: string }): string[] {
  return [
    'read-configuration',
    '--workspace-folder',
    p.workspaceFolder,
    '--config',
    p.configPath,
    '--id-label',
    p.idLabel,
  ];
}

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
    // Assumption (V-1): the Dev Containers extension runs postAttachCommand when it attaches.
    '--skip-post-attach',
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

/** Removes `--name <value>` and `--name=<value>` from docker run arguments. */
export function stripNameArgs(runArgs: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < runArgs.length; i++) {
    const arg = runArgs[i];
    if (arg === '--name') {
      i++;
      continue;
    }
    if (arg.startsWith('--name=')) continue;
    result.push(arg);
  }
  return result;
}

/**
 * Override configuration for `up` (implementation notes 8, concept 7.6): only image, workspaceMount, workspaceFolder,
 * runArgs (repository values without any --name, plus `--name <container name>`), appPort (if set), and
 * shutdownAction 'none'. `initializeCommand` (if set) is added too: it is not part of the image metadata, and without
 * it the command of the repository would never run (concept section 5: it runs in the workspace helper).
 */
export function buildOverrideConfig(p: {
  environmentImage: string;
  volumeName: string;
  repositoryName: string;
  containerName: string;
  runArgs?: string[];
  appPort?: DevcontainerConfig['appPort'];
  initializeCommand?: DevcontainerConfig['initializeCommand'];
}): Record<string, unknown> {
  const override: Record<string, unknown> = {
    image: p.environmentImage,
    workspaceMount: `source=${p.volumeName},target=${WORKSPACES_ROOT},type=volume`,
    workspaceFolder: `${WORKSPACES_ROOT}/${p.repositoryName}`,
    runArgs: [...stripNameArgs(p.runArgs ?? []), '--name', p.containerName],
  };
  if (p.appPort !== undefined) override.appPort = p.appPort;
  if (p.initializeCommand !== undefined && p.initializeCommand !== null) override.initializeCommand = p.initializeCommand;
  // Assumption (V-4): this value replaces shutdownAction of the image metadata, so the Dev Containers extension never
  // stops the container.
  override.shutdownAction = 'none';
  return override;
}
