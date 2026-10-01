// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the batch helper of the worker (decision 2026-09-29: the steps that need the volume of an
// environment run in one helper container per operation, never one container per step; Q1 and Q2 of 2026-10-01). The
// worker cannot see the volume (a running container cannot get a volume mounted later), so it starts the helper with
// it: `batch` checks that the volume exists, starts `docker run --rm -i` of the pinned helper image with the volume, the
// cache, the secrets tmpfs and the socket, pipe-loads the same script as itself with the entry BATCH_ENTRY (a second
// ChannelServer with the fixed step table of src/core/helper/batchSteps.ts), reports BATCH_READY_STEP and holds the
// helper until it is cancelled (at most BATCH_HOLD_LIMIT_MS). `batchStep` relays one step to it; `batchChunk` carries an
// input that is longer than one request of the channel, in pieces before the step. Pure functions and constants. No `vscode`.
import { loaderCommand } from '../loader/pipeLoader';
import { HELPER_CACHE_FOLDER, HELPER_CACHE_VOLUME, LABEL_HELPER_RUN, WORKSPACES_ROOT } from '../names';
import { SECRETS_FOLDER } from '../helper/scripts';
import { isBatchStepKind, type BatchStepKind } from '../helper/batchSteps';
import { LOCK_HOLD_LIMIT_MS, MAX_OPERATION_TIMEOUT_MS, channelStepLabel, hasOnlyKeys, isCleanupLabel, isRecord } from './protocol';

/** Starts a batch helper and holds it (BatchParams; the value is `{}`). Long-lived, like `lock`. */
export const OP_BATCH = 'batch';
/** One step in a batch helper (BatchStepParams; the value is BatchStepValue). */
export const OP_BATCH_STEP = 'batchStep';
/** A piece of the input of a later step (BatchChunkParams; the value is `{}`). */
export const OP_BATCH_CHUNK = 'batchChunk';
/** The failure code of a batch whose volume does not exist (it is never created). */
export const BATCH_MISSING_VOLUME_CODE = 'missingVolume';
/** The progress step of `batch` once the helper answered (the detail is the session). */
export const BATCH_READY_STEP = 'ready';
/** Where the loader of the helper stores the script, and its entry (src/helperChannel/main.ts). */
export const BATCH_SCRIPT_PATH = '/opt/devenv/batch.js';
export const BATCH_ENTRY = 'startBatchHelper';
/** The backstop of a held helper: the one of the lock of its operation (6 h). */
export const BATCH_HOLD_LIMIT_MS = LOCK_HOLD_LIMIT_MS;
/**
 * The batch helpers of one worker at the same time. They take none of the MAX_CONCURRENT_OPERATIONS places (a helper
 * is held for the whole operation); their steps and pieces are `reserved` calls (MAX_CONCURRENT_LOCKED_OPERATIONS).
 */
export const MAX_CONCURRENT_BATCHES = 8;
/** A piece of `batchChunk`: at most 6 bytes per character as JSON, so a piece stays far below MAX_CHANNEL_REQUEST_BYTES. */
export const BATCH_CHUNK_CHARACTERS = 32 * 1024;
/** The longest input (JSON of the parameters of a step) that the pieces of one session can hold. */
export const MAX_BATCH_INPUT_CHARACTERS = 3 * 1024 * 1024;
/**
 * Q2 of 2026-10-01: the socket is mounted in a folder that only root can enter (the image creates it 0700; the helper
 * checks it), so the Git user of the helper cannot reach it. The helper links /var/run/docker.sock to it for its root
 * steps (the default of the Docker CLI and the Dev Container CLI; DOCKER_HOST is never set).
 */
export const BATCH_SOCKET_FOLDER = '/run/devenv-docker';
export const BATCH_DOCKER_SOCKET = `${BATCH_SOCKET_FOLDER}/docker.sock`;
/** Q2: the unprivileged user of the Git steps (resources/helper/Dockerfile: devenv-git, no home, no login). */
export const BATCH_GIT_UID = 52741;

export interface BatchParams {
  /** A cleanup label value (newCleanupLabel): the session, and the label of its helper container. */
  session: string;
  volume: string;
  /** The pinned helper image of the operation, by its ID. */
  image: string;
  /** The source of the socket mount on the host of the engine. */
  socket: string;
}

export interface BatchStepParams {
  session: string;
  kind: BatchStepKind;
  /** The inputs of the step (batchStepCommand), or `input`: the ID of the pieces that hold their JSON. */
  params?: unknown;
  input?: string;
  /** The time limit of the step in the helper; it ends the step alone. */
  timeoutMs?: number;
}

export interface BatchChunkParams {
  session: string;
  /** The ID of the input (a cleanup label value). */
  input: string;
  data: string;
}

/** The value of a step: its exit code (null after a signal). */
export interface BatchStepValue {
  exitCode: number | null;
}

/** A volume name that Docker accepts, never an option. */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The strict check of BatchParams (both sides). */
export function parseBatchParams(value: unknown): BatchParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['session', 'volume', 'image', 'socket'])) return undefined;
  const { session, volume, image, socket } = value;
  if (!isCleanupLabel(session) || typeof volume !== 'string' || !VOLUME_NAME.test(volume)) return undefined;
  if (typeof image !== 'string' || !IMAGE_ID.test(image)) return undefined;
  // --mount is CSV: a path with a comma or a quote would change the mount.
  if (typeof socket !== 'string' || !socket.startsWith('/') || socket.length > 4096 || /[",\0\n\r]/.test(socket)) return undefined;
  return { session, volume, image, socket };
}

/** The strict check of BatchStepParams (both sides): either `params` or `input`. */
export function parseBatchStepParams(value: unknown): BatchStepParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['session', 'kind'], ['params', 'input', 'timeoutMs'])) return undefined;
  const { session, kind, params, input, timeoutMs } = value;
  if (!isCleanupLabel(session) || !isBatchStepKind(kind)) return undefined;
  if ((params === undefined) === (input === undefined) || (input !== undefined && !isCleanupLabel(input))) return undefined;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_OPERATION_TIMEOUT_MS)) return undefined;
  const step: BatchStepParams = { session, kind };
  if (params !== undefined) step.params = params;
  if (input !== undefined) step.input = input as string;
  if (timeoutMs !== undefined) step.timeoutMs = timeoutMs as number;
  return step;
}

/** The strict check of BatchChunkParams (both sides): a piece of 1..BATCH_CHUNK_CHARACTERS characters. */
export function parseBatchChunkParams(value: unknown): BatchChunkParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['session', 'input', 'data'])) return undefined;
  const { session, input, data } = value;
  if (!isCleanupLabel(session) || !isCleanupLabel(input) || typeof data !== 'string' || data === '' || data.length > BATCH_CHUNK_CHARACTERS) return undefined;
  return { session, input, data };
}

/** The check of BatchStepValue (the extension). */
export function parseBatchStepValue(value: unknown): BatchStepValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['exitCode'])) return undefined;
  const { exitCode } = value;
  return exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode)) ? { exitCode } : undefined;
}

/** `volume inspect` of the volume of a batch: it must exist (a `--mount` of a missing volume would create an empty one). */
export function batchVolumeArgs(volume: string): string[] {
  return ['volume', 'inspect', '--format', '{{.Name}}', volume];
}

/**
 * `docker run` arguments of a batch helper: `--rm -i`, never a pull, the label of the helper runs and the session label
 * (channelStepLabel: the cleanup of the worker removes it by that label, never by a name), no log of the engine, no new
 * privileges, the volume at /workspaces, the cache volume, the socket in BATCH_SOCKET_FOLDER, the secrets tmpfs (0700,
 * in memory), the pinned image, and the pipe loader with BATCH_SCRIPT_PATH, the hash of the script and BATCH_ENTRY. No
 * variable (`-e`) and no part of the script or of a secret.
 */
export function batchRunArgs(p: BatchParams & { scriptHash: string }): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    `devenv-batch-${p.session}`,
    '--label',
    `${LABEL_HELPER_RUN}=true`,
    '--label',
    channelStepLabel(p.session),
    '--log-driver',
    'none',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=volume,source=${p.volume},target=${WORKSPACES_ROOT}`,
    '--mount',
    `type=volume,source=${HELPER_CACHE_VOLUME},target=${HELPER_CACHE_FOLDER}`,
    '--mount',
    `type=bind,source=${p.socket},target=${BATCH_DOCKER_SOCKET}`,
    '--tmpfs',
    `${SECRETS_FOLDER}:rw,noexec,nosuid,nodev,size=1m,mode=0700`,
    p.image,
    ...loaderCommand({ path: BATCH_SCRIPT_PATH, hash: p.scriptHash, entry: BATCH_ENTRY }),
  ];
}
