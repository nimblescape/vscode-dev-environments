// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the batch helper of the worker (decision 2026-09-29: the steps that need the volume of an
// environment run in one helper container per operation, never one container per step; Q1 and Q2 of 2026-10-01). The
// worker cannot see the volume (a running container cannot get a volume mounted later), so it starts the helper with
// it (src/helperChannel/batch.ts): it checks that the volume exists, starts the pinned helper image with the volume, the
// cache, the secrets tmpfs and the socket (plan step 11G3: over the Engine API, as `docker run --rm -i` did;
// batchRunSpec), pipe-loads the same script as itself with the entry BATCH_ENTRY (a second ChannelServer with the fixed
// step table of src/core/helper/batchSteps.ts), and sends the steps of its flow to it (BatchStepParams). Plan step 11I1,
// PR B1: the operations `batch`, `batchStep` and `batchChunk` (the batch helper relayed for the extension) are gone.
// Pure functions and constants. No `vscode`.
import { loaderCommand } from '../loader/pipeLoader';
import { BATCH_SOCKET_FOLDER, HELPER_CACHE_FOLDER, HELPER_CACHE_VOLUME, LABEL_CHANNEL_STEP, LABEL_HELPER_RUN, SECRETS_FOLDER, WORKSPACES_ROOT } from '../names';
import { isBatchStepKind, type BatchStepKind } from '../helper/batchStepKinds';
import type { EngineAttachedSpec } from '../worker/dockerEngine';
import { LOCK_HOLD_LIMIT_MS, MAX_OPERATION_TIMEOUT_MS, hasOnlyKeys, isCleanupLabel, isRecord } from './protocol';

/** The failure code of a batch whose volume does not exist (it is never created). */
export const BATCH_MISSING_VOLUME_CODE = 'missingVolume';
/** Where the loader of the helper stores the script, and its entry (src/helperChannel/main.ts). */
export const BATCH_SCRIPT_PATH = '/opt/devenv/batch.js';
export const BATCH_ENTRY = 'startBatchHelper';
/**
 * The longest silence of a batch helper before the worker's client takes it as lost (its pong time limit): the backstop
 * of the lock of its operation (6 h). The worker reads none of its answers (its pongs too) while the connection of the
 * extension is congested.
 */
export const BATCH_HOLD_LIMIT_MS = LOCK_HOLD_LIMIT_MS;
/** The longest input (JSON of the parameters of a step) that one step of a session can carry. */
export const MAX_BATCH_INPUT_CHARACTERS = 3 * 1024 * 1024;
// Follow-up of plan step 11I (the links of the owner): BATCH_SOCKET_FOLDER moved to ../names (the host access policy names
// it too).
export { BATCH_SOCKET_FOLDER };
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
  /**
   * The inputs of the step (batchStepCommand). Plan step 11I1, PR B1: always in the step; the alternative `input` (the
   * ID of the pieces of `batchChunk` that held their JSON) is gone with that operation.
   */
  params: unknown;
  /** The time limit of the step in the helper; it ends the step alone. */
  timeoutMs?: number;
}

/** The value of a step: its exit code (null after a signal). */
export interface BatchStepValue {
  exitCode: number | null;
}

/** A volume name that Docker accepts, never an option. */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The strict check of BatchParams. */
export function parseBatchParams(value: unknown): BatchParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['session', 'volume', 'image', 'socket'])) return undefined;
  const { session, volume, image, socket } = value;
  if (!isCleanupLabel(session) || typeof volume !== 'string' || !VOLUME_NAME.test(volume)) return undefined;
  if (typeof image !== 'string' || !IMAGE_ID.test(image)) return undefined;
  // --mount is CSV: a path with a comma or a quote would change the mount. Plan step 11G3: the API takes the path as it
  // is, and the check stays as strict.
  if (typeof socket !== 'string' || !socket.startsWith('/') || socket.length > 4096 || /[",\0\n\r]/.test(socket)) return undefined;
  return { session, volume, image, socket };
}

/** The strict check of BatchStepParams: the session, a step kind, its `params`, and an optional time limit. */
export function parseBatchStepParams(value: unknown): BatchStepParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['session', 'kind', 'params'], ['timeoutMs'])) return undefined;
  const { session, kind, params, timeoutMs } = value;
  if (!isCleanupLabel(session) || !isBatchStepKind(kind) || params === undefined) return undefined;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_OPERATION_TIMEOUT_MS)) return undefined;
  const step: BatchStepParams = { session, kind, params };
  if (timeoutMs !== undefined) step.timeoutMs = timeoutMs as number;
  return step;
}

/** The check of BatchStepValue (the value of a step of the helper). */
export function parseBatchStepValue(value: unknown): BatchStepValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['exitCode'])) return undefined;
  const { exitCode } = value;
  return exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode)) ? { exitCode } : undefined;
}

/** Plan step 11G3: the name of the container of a batch helper (never used to find or remove it: the session label is). */
export function batchContainerName(session: string): string {
  return `devenv-batch-${session}`;
}

/**
 * The batch helper as the worker runs it over the Engine API (plan step 11G3, DockerEngine.runAttached; before: the
 * arguments of its own `docker run --rm -i --pull never`): never a pull, the label of the helper runs and the session
 * label (channelStepLabel: the worker removes it by that label, never by a name), no log of the engine (runAttached), no
 * new privileges, the volume at /workspaces, the cache volume, the socket in BATCH_SOCKET_FOLDER, the secrets tmpfs
 * (0700, in memory), the pinned image, and the pipe loader with BATCH_SCRIPT_PATH, the hash of the script and
 * BATCH_ENTRY as its command (the entrypoint of the image, tini, stays). No variable and no part of the script or of a
 * secret.
 */
export function batchRunSpec(p: BatchParams & { scriptHash: string }): EngineAttachedSpec {
  return {
    name: batchContainerName(p.session),
    image: p.image,
    command: loaderCommand({ path: BATCH_SCRIPT_PATH, hash: p.scriptHash, entry: BATCH_ENTRY }),
    labels: { [LABEL_HELPER_RUN]: 'true', [LABEL_CHANNEL_STEP]: p.session },
    mounts: [
      { type: 'volume', source: p.volume, target: WORKSPACES_ROOT },
      { type: 'volume', source: HELPER_CACHE_VOLUME, target: HELPER_CACHE_FOLDER },
      { type: 'bind', source: p.socket, target: BATCH_DOCKER_SOCKET },
    ],
    tmpfs: { [SECRETS_FOLDER]: 'rw,noexec,nosuid,nodev,size=1m,mode=0700' },
    securityOpt: ['no-new-privileges'],
  };
}
