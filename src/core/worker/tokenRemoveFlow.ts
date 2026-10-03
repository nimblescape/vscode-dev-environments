// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): the first flow that runs in the worker. When a
// window leaves an environment, or the account changes, the memory of its dev container must hold no GitHub token any
// more (concept section 9). Before, the extension ran this directly on the user's computer, outside any operation (two
// to four SSH sessions on a remote host); now it is one operation whose steps run next to the engine. Pure over the port
// and the seams; no I/O of its own, no `vscode`.
import { LABEL_ENVIRONMENT_ID } from '../names';
import { runScript } from './containerScripts';
import { EngineError, isDevContainer, type DockerEngine, type EngineContainer, type EngineExecResult } from './dockerEngine';
import type { HostRecords } from './hostSide';

/** The time limit of each try in the container (the script only empties a folder in memory). */
export const TOKEN_REMOVE_TIMEOUT_MS = 20_000;

/** What the flow reports back: whether a token could be there at all, and what it did. */
export interface TokenRemoveResult {
  /** `removed`: the folder is empty now. `notRunning`: no container of the environment runs, so its memory holds none. */
  outcome: 'removed' | 'notRunning';
  /** The container that it emptied (its short ID), for the log line of the extension. */
  container?: string;
}

export interface TokenRemoveFlow {
  environmentId: string;
  containerName: string;
  engine: DockerEngine;
  records: Pick<HostRecords, 'get'>;
  /** A line for the log of the operation (each try that failed, and a container that is not the named one). */
  log?: (line: string) => void;
  signal?: AbortSignal;
}

/** The most text of a failed try that goes into the message of the flow. */
const MAX_REASON_CHARACTERS = 1000;

/**
 * Plan step 11B1: empties the token folder of the dev container of `environmentId` (the script `tokenRemove` of the
 * registry): as root, and when that fails (a configuration that takes the rights of root away) as the remote user of
 * the environment. Throws with the reason when the token could still be there; a container that does not run is no
 * failure (its memory is gone with it).
 */
export async function removeTokenFlow(p: TokenRemoveFlow): Promise<TokenRemoveResult> {
  const container = await devContainer(p);
  if (container === undefined) return { outcome: 'notRunning' };
  const attempt = (user: string) => tryRemoval(p, container.id, user);
  const asRoot = await attempt('root');
  if (asRoot === 'notRunning') return { outcome: 'notRunning' };
  if (asRoot.exitCode === 0) return { outcome: 'removed', container: container.id.slice(0, 12) };
  p.log?.(`The removal as root failed in the container ${container.name}: ${reason(asRoot)}`);
  // Review round 1 of plan step 11B1 (A-R1-7): the record only names the user of the second try; a record that cannot be
  // read never stops the first one, and leaves the second one out.
  const record = await p.records.get(p.environmentId).catch(() => undefined);
  const user = record?.remoteUser;
  if (user === undefined || user === '' || user === 'root' || user === '0') throw new Error(reason(asRoot));
  const asUser = await attempt(user);
  if (asUser === 'notRunning') return { outcome: 'notRunning' };
  if (asUser.exitCode !== 0) throw new Error(`${reason(asRoot)} As ${user}: ${reason(asUser)}`);
  return { outcome: 'removed', container: container.id.slice(0, 12) };
}

/**
 * One try of the script as `user`. Review round 2 of plan step 11B1 (A-R2-5): a failure of the engine is a failed try
 * (its message the reason), as a failed `docker exec` was, so the second try still runs; a container that stopped since
 * the lookup (409) holds no token any more. A cancel ends the flow.
 */
async function tryRemoval(p: TokenRemoveFlow, container: string, user: string): Promise<EngineExecResult | 'notRunning'> {
  try {
    return await runScript(p.engine, container, 'tokenRemove', [], { signal: p.signal, timeoutMs: TOKEN_REMOVE_TIMEOUT_MS, user });
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    if (error.status === 409 && /is not running/i.test(error.message)) return 'notRunning';
    return { exitCode: null, stdout: '', stderr: error.message, timedOut: false };
  }
}

/**
 * The running dev container of the environment, found by the label of the environment (as ContainerAdapter.findContainer
 * found it): the side services of a Docker Compose configuration are not it, the named one comes first, and else the
 * newest one. Review round 1 of plan step 11B1 (A-R1-6): the recorded name is a preference, not a condition, so a dev
 * container that was created again under another name is still found.
 */
async function devContainer(p: TokenRemoveFlow): Promise<EngineContainer | undefined> {
  const labelled = await p.engine.containers(`${LABEL_ENVIRONMENT_ID}=${p.environmentId}`, p.signal);
  const running = labelled.filter((container) => container.state === 'running' && isDevContainer(container, p.containerName));
  const named = running.find((container) => container.name === p.containerName);
  if (named !== undefined) return named;
  // Review round 2 of plan step 11B1 (A-R2-7): by the time, not the text (the engine trims the zeros of a fraction).
  const time = (container: EngineContainer) => Date.parse(container.created ?? '') || 0;
  const newest = [...running].sort((a, b) => time(b) - time(a))[0];
  if (newest !== undefined) p.log?.(`The container ${p.containerName} does not run; the running container ${newest.name} of the environment is used.`);
  return newest;
}

/** The reason of a try that failed, for the message of the flow (the output of the script, or its exit code). */
function reason(result: { exitCode: number | null; stderr: string; stdout: string; timedOut: boolean }): string {
  if (result.timedOut) return 'the script did not end in time.';
  // Review round 1 of plan step 11B1 (A-R1-11): the whole output (the line that names the token comes first), clipped.
  const text = (result.stderr || result.stdout).trim().split('\n').join(' ');
  if (text === '') return `exit code ${result.exitCode ?? 'none'}.`;
  return text.length > MAX_REASON_CHARACTERS ? `${text.slice(0, MAX_REASON_CHARACTERS)}…` : text;
}
