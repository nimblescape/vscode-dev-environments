// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the fixed table of the step kinds of the batch helper (src/helperChannel/batchHelper.ts, decision
// 2026-09-29: the volume steps of an operation run in one helper per operation). The extension sends a kind and the
// inputs of its builder; the helper checks them strictly here and builds the command itself with the builders of the
// per-step runs (scripts.ts, devcontainerCli.ts, stepInputs.ts, gitSummary.ts), as WorkspaceHelper does. It never runs a
// command line that it was sent. Pure functions. No `vscode`.
import { configOwnershipFixCommand } from '../git/gitSummary';
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

/** Runs `check` and turns its Error (the checks of the per-step runs) into a BatchStepError. */
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
      return { command: readFilesCommand(folder, configPath, optionalText(kind, p.dockerfile)), env: {}, git: false };
    }
    case 'listConfigs': {
      const p = fields(kind, params, ['repository']);
      return { command: listConfigsCommand(folderOf(kind, p.repository).folder), env: {}, git: false };
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
      return { command: composeModelCommand(folder, files), env: { COMPOSE_PROJECT_NAME: project(kind, p.project) }, git: false };
    }
    case 'composeHash': {
      const p = fields(kind, params, ['model', 'project']);
      const name = project(kind, p.project);
      return { command: composeHashCommand(COMPOSE_MODEL_PATH, name), input: text(kind, p.model, 4 * 1024 * 1024), env: { COMPOSE_PROJECT_NAME: name }, git: false };
    }
    case 'createFolders': {
      const p = fields(kind, params, ['repository', 'folders']);
      const { folder } = folderOf(kind, p.repository);
      return { command: createFoldersCommand(folder, pathsBelow(kind, p.folders, folder)), env: {}, git: false };
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
    default:
      throw new BatchStepError(`The batch helper does not know the step ${String(kind).slice(0, 64)}.`);
  }
}
