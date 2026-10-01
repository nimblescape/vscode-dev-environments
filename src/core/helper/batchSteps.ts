// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the fixed table of the step kinds of the batch helper (src/helperChannel/batchHelper.ts, decision
// 2026-09-29: the volume steps of an operation run in one helper per operation). The extension sends a kind and the
// inputs of its builder; the helper checks them strictly here and builds the command itself with the same builders as
// WorkspaceHelper (scripts.ts, devcontainerCli.ts, stepInputs.ts, gitSummary.ts). It never runs a command line that it was
// sent. Plan step 7 (user decision of 2026-10-01): the per-step runs of WorkspaceHelper are removed; every volume step is
// a kind of this table and runs only in the batch helper of an operation. Pure functions. No `vscode`.
import { GIT_SUMMARY_NO_FOLDER_EXIT, GIT_SUMMARY_UNREACHABLE_EXIT, configOwnershipFixCommand, gitSummaryCommand } from '../git/gitSummary';
import { CONFIG_FOLDER, WORKSPACES_ROOT, environmentIdLabel } from '../names';
import { isStorageId } from '../storage/paths';
import { COMPOSE_MODEL_PATH } from './compose';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { buildArgs, readConfigurationArgs, runUserCommandsArgs, upArgs } from './devcontainerCli';
import {
  OVERRIDE_CONFIG_PATH,
  buildCommand,
  cloneCommand,
  composeHashCommand,
  composeModelCommand,
  createFoldersCommand,
  gitFilesCommand,
  listConfigsCommand,
  readFilesCommand,
  writeAndRunCommand,
} from './scripts';
import { checkConfigPath, checkRepository, isPassableEnvName, overrideCommand, overrideInput, writeAndRunInput, type HelperFiles } from './stepInputs';

/** The step kinds of the batch helper (each one is an operation of its ChannelServer). */
export const BATCH_STEP_KINDS = [
  'clone',
  'readFiles',
  'listConfigs',
  'readConfiguration',
  'build',
  'composeModel',
  'composeHash',
  'createFolders',
  'up',
  'runUserCommands',
  'gitFiles',
  'ownershipFix',
  'gitSummary',
] as const;
export type BatchStepKind = (typeof BATCH_STEP_KINDS)[number];

export function isBatchStepKind(value: unknown): value is BatchStepKind {
  return typeof value === 'string' && (BATCH_STEP_KINDS as readonly string[]).includes(value);
}

/**
 * Decision 2026-10-01, Q2: Docker Compose fetches no remote `include` (Git or OCI) in the helper: these variables are set
 * on the process of every step, after the variables of the request, so a request cannot turn them on again.
 */
export const COMPOSE_REMOTE_OFF: Readonly<Record<string, string>> = {
  COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false',
  COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false',
};

/** A step as the batch helper runs it: always built here, never sent. */
export interface BatchStepCommand {
  command: string[];
  /** The standard input (then closed). For a step with `secret: 'stdin'`, the secret of the request instead. */
  input?: string;
  /** Variables of the step process only (checked names), never of the container. */
  env: Record<string, string>;
  /** Q2: Git runs as the unprivileged user of the helper (BATCH_GIT_UID), without the socket and CONFIG_FOLDER. */
  git: boolean;
  /**
   * User decision of 2026-10-01 ("we shall run as the repo owner user. that is what a real user would do as well."; it
   * replaces option A, the Git user): the repository folder whose owner (uid:gid, read with lstat at step time) runs the
   * step, as root when root owns it. The Docker Compose read steps (composeModel, composeHash): Compose follows `env_file`
   * and `include` of the repository, so it reads as that user, with CONFIG_FOLDER root's and 0700 during the step
   * (closeConfigFolder). By the
   * agreed extension of the same day, readFiles, listConfigs and createFolders too; plan step 7 (user decision of
   * 2026-10-01, "step 7 proposal accepted"): gitSummary, Delete's check, too. The steps that need the Docker
   * socket (readConfiguration, build, up, runUserCommands) and gitFiles and ownershipFix stay root; the clone stays Git's.
   */
  owner?: string;
  /**
   * Review round 1 of PR #84, A-R1-1: for an `owner` step, CONFIG_FOLDER is root's and 0700 during the step. Only the
   * steps that follow references in repository files (Docker Compose: `env_file`, `include`): composeModel and
   * composeHash. The other owner steps (readFiles, listConfigs, createFolders, gitSummary) leave its owner and mode as
   * they are, so that Git in a running dev container keeps reading its configuration there during the step (the
   * command-line `include.path` of credentials.gitconfig fails with EACCES otherwise); they still repair the root:root
   * 0700 that a killed step left.
   */
  closeConfigFolder?: boolean;
  /**
   * Review round 2 of PR #84, A-R2-2: for an `owner` step whose script tests the folder as its user (`[ -d ]`, false on
   * EACCES too): its exit code `missing` stands only when root finds no folder at `owner` either (following a link);
   * otherwise the batch helper returns `unreachable` (the folder exists, but the step's user cannot reach it).
   */
  folderExits?: { missing: number; unreachable: number };
  /**
   * The secret of the request (the GitHub token): `stdin`: required, the standard input of the step (TOKEN_PRELUDE writes
   * it to the tmpfs and removes it); `mask`: optional, only masked in the output; undefined: refused.
   */
  secret?: 'stdin' | 'mask';
}

/** The inputs of a step are invalid. */
export class BatchStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchStepError';
  }
}

const MAX_TEXT = 64 * 1024;
const MAX_LIST = 1_000;

function fail(kind: string): never {
  throw new BatchStepError(`The parameters of the step ${kind} are invalid.`);
}

/** The record `value` with exactly the keys `required` and some of `optional`, or a failure. */
function fields(kind: string, value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(kind);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!required.every((key) => key in record) || !keys.every((key) => required.includes(key) || optional.includes(key))) fail(kind);
  return record;
}

function text(kind: string, value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(kind);
  return value;
}

function optionalText(kind: string, value: unknown): string | undefined {
  return value === undefined ? undefined : text(kind, value);
}

function texts(kind: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) fail(kind);
  return value.map((item) => text(kind, item));
}

function jsonObject(kind: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(kind);
  return value as Record<string, unknown>;
}

function helperFiles(kind: string, value: unknown): HelperFiles | undefined {
  if (value === undefined) return undefined;
  const record = jsonObject(kind, value);
  for (const item of Object.values(record)) if (typeof item !== 'string') fail(kind);
  return record as HelperFiles;
}

/** The variables of a step: names that isPassableEnvName accepts (never DOCKER_HOST, REMOTE_CONTAINERS*, VSCODE_*, …). */
function stepEnv(kind: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const record = jsonObject(kind, value);
  const env: Record<string, string> = {};
  for (const [name, item] of Object.entries(record)) {
    if (!isPassableEnvName(name) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new BatchStepError(`The variable ${name} is not passed to a step.`);
    env[name] = text(kind, item);
  }
  return env;
}

/** Runs `check` and turns its Error (the checks of stepInputs.ts, which WorkspaceHelper runs too) into a BatchStepError. */
function checked<T>(kind: string, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof BatchStepError) throw error;
    throw new BatchStepError(`The parameters of the step ${kind} are invalid: ${(error as Error).message}`);
  }
}

function folderOf(kind: string, repository: unknown): { folder: string; name: string } {
  const name = checked(kind, () => checkRepository(text(kind, repository, 256)).name);
  return { folder: `${WORKSPACES_ROOT}/${name}`, name };
}

function environmentId(kind: string, value: unknown): string {
  if (!isStorageId(value)) fail(kind);
  return value;
}

/** A Compose project name (lower case letters, digits, `_`, `-`). */
function project(kind: string, value: unknown): string {
  const name = text(kind, value, 255);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) fail(kind);
  return name;
}

/** Absolute paths below `folder`, without `.`, `..` and empty parts (the checks of composeModel and createRepositoryFolders). */
function pathsBelow(kind: string, value: unknown, folder: string): string[] {
  const list = texts(kind, value);
  if (list.some((entry) => !entry.startsWith(`${folder}/`) || entry.slice(folder.length + 1).split('/').some((part) => part === '..' || part === '.' || part === ''))) fail(kind);
  return list;
}

/**
 * The command of the step `kind` with the inputs `params` (the inputs of the methods of WorkspaceHelper with the same
 * builders). Throws BatchStepError for an unknown kind and for inputs beyond the checks.
 */
export function batchStepCommand(kind: string, params: unknown): BatchStepCommand {
  switch (kind) {
    case 'clone': {
      const p = fields(kind, params, ['repository'], ['branch']);
      const { name } = folderOf(kind, p.repository);
      const branch = optionalText(kind, p.branch);
      return { command: cloneCommand(p.repository as string, name, branch || undefined), env: {}, git: true, secret: 'stdin' };
    }
    case 'readFiles': {
      const p = fields(kind, params, ['repository', 'configPath'], ['dockerfile']);
      const { folder } = folderOf(kind, p.repository);
      const configPath = checked(kind, () => checkConfigPath(text(kind, p.configPath)));
      // User decision of 2026-10-01 (agreed extension of "Compose reads as the repository owner"): as the owner of the
      // repository. READ_FILES_SCRIPT reads below the repository folder only, as before.
      return { command: readFilesCommand(folder, configPath, optionalText(kind, p.dockerfile)), env: {}, git: false, owner: folder };
    }
    case 'listConfigs': {
      const p = fields(kind, params, ['repository']);
      const { folder } = folderOf(kind, p.repository);
      // User decision of 2026-10-01 (agreed extension): as the owner of the repository.
      return { command: listConfigsCommand(folder), env: {}, git: false, owner: folder };
    }
    case 'readConfiguration': {
      const p = fields(kind, params, ['repository', 'configPath', 'environmentId', 'merged'], ['override', 'files', 'env']);
      const { folder } = folderOf(kind, p.repository);
      if (typeof p.merged !== 'boolean') fail(kind);
      const override = p.override === undefined ? undefined : jsonObject(kind, p.override);
      const files = helperFiles(kind, p.files);
      const withFiles = override !== undefined || files !== undefined;
      const args = readConfigurationArgs({
        workspaceFolder: folder,
        configPath: `${folder}/${checked(kind, () => checkConfigPath(text(kind, p.configPath)))}`,
        idLabel: environmentIdLabel(environmentId(kind, p.environmentId)),
        merged: p.merged,
        overrideConfigPath: override !== undefined ? OVERRIDE_CONFIG_PATH : undefined,
      });
      return {
        command: withFiles ? writeAndRunCommand({}, args) : ['devcontainer', ...args],
        input: withFiles ? checked(kind, () => writeAndRunInput(files, override)) : undefined,
        env: stepEnv(kind, p.env),
        git: false,
      };
    }
    case 'build': {
      const p = fields(kind, params, ['repository', 'configPath', 'imageName'], ['override', 'files', 'env']);
      const { folder } = folderOf(kind, p.repository);
      const configFile = `${folder}/${checked(kind, () => checkConfigPath(text(kind, p.configPath)))}`;
      const imageName = text(kind, p.imageName, 255);
      if (!/^[a-z0-9][^\s]*$/i.test(imageName)) fail(kind);
      const env = stepEnv(kind, p.env);
      if (p.override === undefined && p.files === undefined) {
        return { command: buildCommand(configFile, buildArgs({ workspaceFolder: folder, configPath: configFile, imageName })), env, git: false };
      }
      const override = p.override === undefined ? undefined : jsonObject(kind, p.override);
      const files = helperFiles(kind, p.files);
      const config = override !== undefined ? OVERRIDE_CONFIG_PATH : configFile;
      const args = buildArgs({ workspaceFolder: folder, configPath: config, imageName });
      return {
        command: writeAndRunCommand({ repositoryConfig: configFile, config: override !== undefined ? OVERRIDE_CONFIG_PATH : undefined }, args),
        input: checked(kind, () => writeAndRunInput(files, override)),
        env,
        git: false,
      };
    }
    case 'composeModel': {
      const p = fields(kind, params, ['repository', 'files', 'project']);
      const { folder } = folderOf(kind, p.repository);
      const files = pathsBelow(kind, p.files, folder);
      if (files.length === 0) fail(kind);
      // User decision of 2026-10-01: Compose reads as the repository owner (CONFIG_FOLDER closed during the step).
      return { command: composeModelCommand(folder, files), env: { COMPOSE_PROJECT_NAME: project(kind, p.project) }, git: false, owner: folder, closeConfigFolder: true };
    }
    case 'composeHash': {
      // User decision of 2026-10-01: Compose reads as the repository owner, so the step names its repository. It writes
      // the model below OVERRIDE_FOLDER only (in /tmp; the helper makes that folder the owner's for the step).
      const p = fields(kind, params, ['repository', 'model', 'project']);
      const { folder } = folderOf(kind, p.repository);
      const name = project(kind, p.project);
      return { command: composeHashCommand(COMPOSE_MODEL_PATH, name), input: text(kind, p.model, 4 * 1024 * 1024), env: { COMPOSE_PROJECT_NAME: name }, git: false, owner: folder, closeConfigFolder: true };
    }
    case 'createFolders': {
      // User decision of 2026-10-01 (agreed extension of "Compose reads as the repository owner"): as the owner of the
      // repository, so the folders it creates are the owner's. It never needs root: pathsBelow and CREATE_FOLDERS_SCRIPT
      // refuse every folder outside the repository (and a link out of it); a folder of the repository that the owner
      // cannot write (one of root) is refused by the script (`Cannot create`, exit 2), never created as root.
      const p = fields(kind, params, ['repository', 'folders']);
      const { folder } = folderOf(kind, p.repository);
      return { command: createFoldersCommand(folder, pathsBelow(kind, p.folders, folder)), env: {}, git: false, owner: folder };
    }
    case 'up': {
      const p = fields(kind, params, ['repository', 'override', 'environmentId', 'removeExistingContainer'], ['files', 'env']);
      const { folder } = folderOf(kind, p.repository);
      if (typeof p.removeExistingContainer !== 'boolean') fail(kind);
      const files = helperFiles(kind, p.files);
      const args = upArgs({
        workspaceFolder: folder,
        overrideConfigPath: OVERRIDE_CONFIG_PATH,
        idLabel: environmentIdLabel(environmentId(kind, p.environmentId)),
        removeExistingContainer: p.removeExistingContainer,
      });
      const input = checked(kind, () => overrideInput(files, jsonObject(kind, p.override)));
      return { command: overrideCommand(args, files), input, env: stepEnv(kind, p.env), git: false, secret: 'mask' };
    }
    case 'runUserCommands': {
      const p = fields(kind, params, ['repository', 'override', 'environmentId', 'containerId'], ['files', 'env']);
      const { folder } = folderOf(kind, p.repository);
      const containerId = text(kind, p.containerId, 64);
      if (!/^[0-9a-f]{12,64}$/.test(containerId)) fail(kind);
      const files = helperFiles(kind, p.files);
      const args = runUserCommandsArgs({
        workspaceFolder: folder,
        overrideConfigPath: OVERRIDE_CONFIG_PATH,
        idLabel: environmentIdLabel(environmentId(kind, p.environmentId)),
        containerId,
      });
      const input = checked(kind, () => overrideInput(files, jsonObject(kind, p.override)));
      return { command: overrideCommand(args, files), input, env: stepEnv(kind, p.env), git: false, secret: 'mask' };
    }
    case 'gitFiles': {
      // GIT_FILES_SCRIPT writes CONFIG_FOLDER and gives it the owner of the repository (chown): it runs as root. Its Git
      // only edits files of that folder (`git config --file`) and runs no program that a repository names.
      const p = fields(kind, params, ['repository', 'identity']);
      const { name } = folderOf(kind, p.repository);
      const identity = fields(kind, p.identity, ['name', 'email']);
      return {
        command: gitFilesCommand(name, { name: text(kind, identity.name, 1024), email: text(kind, identity.email, 1024) }, CONTAINER_CREDENTIAL_HELPER),
        env: {},
        git: false,
      };
    }
    case 'ownershipFix': {
      const p = fields(kind, params, ['folder', 'uid', 'gid']);
      if (p.folder !== CONFIG_FOLDER) fail(kind);
      return { command: checked(kind, () => configOwnershipFixCommand(CONFIG_FOLDER, text(kind, p.uid, 16), text(kind, p.gid, 16))), env: {}, git: false };
    }
    case 'gitSummary': {
      // Plan step 7 (user decision of 2026-10-01, "step 7 proposal accepted"): Delete's Git summary (GIT_SUMMARY_SCRIPT,
      // built as WorkspaceHelper.gitSummary builds it) runs as the owner of the repository, like the other read steps: so
      // Git meets no "dubious ownership", and a program that the repository configuration names (a filter driver) runs as
      // that user, without the socket and with CONFIG_FOLDER closed. A folder that is missing (or a link) runs as nobody,
      // so its `cd` fails and the check reports it as before. No secret.
      const p = fields(kind, params, ['repository']);
      const { folder } = folderOf(kind, p.repository);
      // Review round 2 of PR #84: the check that every file can be read (A-R2-1), and "missing" decided by root (A-R2-2).
      return {
        command: gitSummaryCommand(folder, true),
        env: {},
        git: false,
        owner: folder,
        folderExits: { missing: GIT_SUMMARY_NO_FOLDER_EXIT, unreachable: GIT_SUMMARY_UNREACHABLE_EXIT },
      };
    }
    default:
      throw new BatchStepError(`The batch helper does not know the step ${String(kind).slice(0, 64)}.`);
  }
}
