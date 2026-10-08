// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): the first flow that runs in the worker. When a
// window leaves an environment, or the account changes, the memory of its dev container must hold no GitHub token any
// more (concept section 9). Before, the extension ran this directly on the user's computer, outside any operation (two
// to four SSH sessions on a remote host); now it is one operation whose steps run next to the engine. Plan step 11I (U4,
// decision of 2026-10-08): in every running dev container of the environment, because the rule of the dev container
// picks the named one even when it is stopped, and a running other dev container must not keep a token. Pure over the
// port and the seams; no I/O of its own, no `vscode`.
import { runScript } from './containerScripts';
import { EngineError, type DockerEngine, type EngineContainer, type EngineExecResult } from './dockerEngine';
import { environmentContainers, runningDevContainers } from './environmentContainers';
import type { HostRecords } from './hostSide';

/** The time limit of each try in the container (the script only empties a folder in memory). */
export const TOKEN_REMOVE_TIMEOUT_MS = 20_000;

/** What the flow reports back: whether a token could be there at all, and what it did. */
export interface TokenRemoveResult {
  /**
   * `removed`: the folder is empty now (plan step 11I, U4: in every running dev container). `notRunning`: no dev container
   * of the environment runs, so their memory holds none.
   */
  outcome: 'removed' | 'notRunning';
  /** The container that it emptied first (its short ID), for the log line of the extension; the others are in the log. */
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

/** The exit code of TOKEN_REMOVE_SCRIPT where the folder is not the tmpfs of the extension (the scripts never wrote there). */
const TOKEN_REMOVE_NO_TMPFS_EXIT = 3;

/** The most text of a failed try that goes into the message of the flow. */
const MAX_REASON_CHARACTERS = 1000;

/**
 * Plan step 11B1: empties the token folder of the dev container of `environmentId` (the script `tokenRemove` of the
 * registry): as root, and when that fails (a configuration that takes the rights of root away) as the remote user of
 * the environment. Throws with the reason when the token could still be there; a container that does not run is no
 * failure (its memory is gone with it). Plan step 11I (U4, decision of 2026-10-08): in every running dev container, in the
 * order of the rule (runningDevContainers), each with the two tries; `removed` when one ran and each is empty now,
 * `notRunning` when none runs (or each turned out not running). After it tried them all, it throws when the token could
 * still be in one: the reason of each such container, named when it is not the container of the request (the extension
 * names that one).
 */
export async function removeTokenFlow(p: TokenRemoveFlow): Promise<TokenRemoveResult> {
  const running = runningDevContainers(await environmentContainers(p.engine, p.environmentId, p.signal), p.containerName, p.log);
  // Review round 1 of plan step 11B1 (A-R1-7): the record only names the user of the second try; a record that cannot be
  // read never stops the first one, and leaves the second one out. Plan step 11I (U4): read at most once.
  let remoteUser: Promise<string | undefined> | undefined;
  const userOfRecord = (): Promise<string | undefined> =>
    (remoteUser ??= p.records.get(p.environmentId).then(
      (record) => record?.remoteUser,
      () => undefined,
    ));
  let emptied: EngineContainer | undefined;
  const kept: string[] = [];
  // PR #127 review round 1 (A, L3): the time limit of the extension (TOKEN_REMOVAL_TIMEOUT_MS of src/vscode/controller.ts)
  // covers the two tries of one container; the container of the request comes first (runningDevContainers: the named one
  // first), so a later one may not be tried before that limit ends the operation.
  for (const container of running) {
    const outcome = await emptyTokenFolder(p, container, container.name === p.containerName, userOfRecord);
    if (outcome === 'notRunning') continue;
    if (outcome === 'noTokenFolder') {
      p.log?.(`The container ${container.name} has no token folder of the extension; nothing to remove there.`);
      continue;
    }
    if (outcome === 'removed') {
      emptied ??= container;
      // Plan step 11I (U4): with more than one running dev container, the log names each one that was emptied.
      if (running.length > 1) p.log?.(`The GitHub token was removed from the container ${container.name}.`);
      continue;
    }
    kept.push(container.name === p.containerName ? outcome.reason : `In the container ${container.name}: ${outcome.reason}`);
  }
  if (kept.length > 0) throw new Error(kept.join(' '));
  return emptied === undefined ? { outcome: 'notRunning' } : { outcome: 'removed', container: emptied.id.slice(0, 12) };
}

/**
 * Plan step 11I (U4): the two tries of plan step 11B1 in one running dev container: `removed` when its token folder is
 * empty now, `notRunning` when it stopped or was removed since the list, else why the token could still be there.
 * PR #127 review round 1 (A, L2): for a container other than the one of the request (`requested`), the exit code 3 of the
 * try as root (TOKEN_REMOVE_SCRIPT: the folder is not the tmpfs of the extension, so the scripts never wrote there) is
 * `noTokenFolder`, nothing to remove (for example a container that the user started from the environment image); for the
 * container of the request it stays a failure, as before.
 */
async function emptyTokenFolder(
  p: TokenRemoveFlow,
  container: EngineContainer,
  requested: boolean,
  userOfRecord: () => Promise<string | undefined>,
): Promise<'removed' | 'notRunning' | 'noTokenFolder' | { reason: string }> {
  const asRoot = await tryRemoval(p, container.id, 'root');
  if (asRoot === 'notRunning') return 'notRunning';
  if (asRoot.exitCode === 0) return 'removed';
  if (!requested && asRoot.exitCode === TOKEN_REMOVE_NO_TMPFS_EXIT) return 'noTokenFolder';
  p.log?.(`The removal as root failed in the container ${container.name}: ${reason(asRoot)}`);
  const user = await userOfRecord();
  if (user === undefined || user === '' || user === 'root' || user === '0') return { reason: reason(asRoot) };
  const asUser = await tryRemoval(p, container.id, user);
  if (asUser === 'notRunning') return 'notRunning';
  if (asUser.exitCode !== 0) return { reason: `${reason(asRoot)} As ${user}: ${reason(asUser)}` };
  return 'removed';
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
    // Review round 3 of plan step 11B1 (A-R3-2): any failure but a cancel is a failed try, as with `docker exec`.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    // A container that stopped (409) or was removed (404, A-R3-3) since the lookup holds no token any more.
    if (error instanceof EngineError && ((error.status === 409 && /is not running/i.test(error.message)) || (error.status === 404 && /no such container/i.test(error.message)))) {
      return 'notRunning';
    }
    return { exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false };
  }
}

/** The reason of a try that failed, for the message of the flow (the output of the script, or its exit code). */
function reason(result: { exitCode: number | null; stderr: string; stdout: string; timedOut: boolean }): string {
  if (result.timedOut) return 'the script did not end in time.';
  // Review round 1 of plan step 11B1 (A-R1-11): the whole output (the line that names the token comes first), clipped.
  const text = (result.stderr || result.stdout).trim().split('\n').join(' ');
  if (text === '') return `exit code ${result.exitCode ?? 'none'}.`;
  return text.length > MAX_REASON_CHARACTERS ? `${text.slice(0, MAX_REASON_CHARACTERS)}…` : text;
}
