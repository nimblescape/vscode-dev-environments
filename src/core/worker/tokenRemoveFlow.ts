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
import type { DockerEngine } from './dockerEngine';
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
  signal?: AbortSignal;
}

/**
 * Plan step 11B1: empties the token folder of the dev container of `environmentId` (the script `tokenRemove` of the
 * registry): as root, and when that fails (a configuration that takes the rights of root away) as the remote user of
 * the environment. Throws with the reason when the token could still be there; a container that does not run is no
 * failure (its memory is gone with it).
 */
export async function removeTokenFlow(p: TokenRemoveFlow): Promise<TokenRemoveResult> {
  const container = await devContainer(p);
  if (container === undefined) return { outcome: 'notRunning' };
  const record = await p.records.get(p.environmentId);
  const user = record?.remoteUser;
  const options = { signal: p.signal, timeoutMs: TOKEN_REMOVE_TIMEOUT_MS };
  const asRoot = await runScript(p.engine, container.id, 'tokenRemove', [], { ...options, user: 'root' });
  if (asRoot.exitCode === 0) return { outcome: 'removed', container: container.id.slice(0, 12) };
  if (user === undefined || user === '' || user === 'root' || user === '0') throw new Error(reason(asRoot));
  const asUser = await runScript(p.engine, container.id, 'tokenRemove', [], { ...options, user });
  if (asUser.exitCode !== 0) throw new Error(`${reason(asRoot)} As ${user}: ${reason(asUser)}`);
  return { outcome: 'removed', container: container.id.slice(0, 12) };
}

/** The running dev container of the environment, by its name first and then by the label of the environment. */
async function devContainer(p: TokenRemoveFlow): Promise<{ id: string } | undefined> {
  const named = await p.engine.container(p.containerName, p.signal);
  if (named?.state === 'running' && named.labels[LABEL_ENVIRONMENT_ID] === p.environmentId) return named;
  const labelled = await p.engine.containers(`${LABEL_ENVIRONMENT_ID}=${p.environmentId}`, p.signal);
  return labelled.find((container) => container.state === 'running' && container.name === p.containerName);
}

/** The reason of a try that failed, for the message of the flow (the output of the script, or its exit code). */
function reason(result: { exitCode: number | null; stderr: string; stdout: string; timedOut: boolean }): string {
  if (result.timedOut) return 'the script did not end in time.';
  const text = (result.stderr || result.stdout).trim().split('\n').at(-1) ?? '';
  return text === '' ? `exit code ${result.exitCode ?? 'none'}.` : text;
}
