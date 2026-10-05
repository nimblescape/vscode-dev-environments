// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E6 (decision D1 of 2026-10-05): the image list that an open carries for the Session Monitor of its engine.
// User request 2026-09-28 ("all images"): the image repositories of the prefixes on ghcr.io, read with the GitHub session
// (scope read:packages) at most once an hour per engine. Without that scope, a question once per window; the monitor then
// updates only the images that are on the host. Review round 1 of PR #57 (B): the list is read in the background with a
// time limit, so it never delays an open: an open carries the list that a read before it gave; D: a list that the monitor
// did not take goes with the next open again, and a failed read is tried again at the next open. No `vscode` here.
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import { ghcrOwnerOf } from '../core/remoteMonitor/imageRepositories';
import { MAX_IMAGE_REPOSITORIES } from '../core/remoteMonitor/protocol';

/** User requests 2026-09-28: the image list for the monitor of an engine is read at most this often. */
export const IMAGE_LIST_INTERVAL_MS = 60 * 60_000;

/** The name of an engine in the log and the messages: the remote host, or the local Docker (host ''). */
export function engineName(host: string): string {
  return host === '' ? 'the local Docker' : host;
}

export interface ImageListsDeps {
  /** The image prefixes of the setting imageUpdates that are used. */
  prefixes: () => string[];
  /** The password of the GitHub sign-in for packages, without a dialog; `undefined` without that sign-in. */
  packagesToken: () => Promise<string | undefined>;
  /** Reads the image repositories of `prefixes` on ghcr.io (ghcrRepositories, with its time limit). */
  read: (token: string, prefixes: string[]) => Promise<string[]>;
  /** Offers the sign-in for packages (once per window: imageLists asks it once). */
  offerSignIn: (engine: string) => void;
  logger: Logger;
  now?: () => number;
}

/** The list of an engine: when its last read began, the repositories it gave, and whether they still go to the monitor. */
interface EngineList {
  readAt: number;
  repositories?: string[];
  toSend: boolean;
}

/**
 * The image list for an open on the engine `host` (its `repositories` when there is one to give, and `listSent` when the
 * monitor took them); a read in the background when one is due.
 */
export function imageLists(deps: ImageListsDeps): (host: string) => { repositories?: string[]; listSent: () => void } {
  const lists = new Map<string, EngineList>();
  const now = deps.now ?? Date.now;
  let signInOffered = false;
  const read = async (host: string, prefixes: string[], started: EngineList): Promise<void> => {
    const token = await deps.packagesToken().catch(() => undefined);
    if (token === undefined) {
      if (lists.get(host) === started) lists.delete(host);
      deps.logger.info(`The image list for ${engineName(host)} needs the GitHub sign-in for packages; the Session Monitor there updates only the images that it has.`);
      if (!signInOffered) {
        signInOffered = true;
        deps.offerSignIn(engineName(host));
      }
      return;
    }
    let repositories: string[];
    try {
      repositories = await deps.read(token, prefixes);
    } catch (error) {
      if (lists.get(host) === started) lists.delete(host);
      deps.logger.warn(`The image repositories could not be read from GitHub: ${errorMessage(error)}`);
      return;
    }
    if (repositories.length > MAX_IMAGE_REPOSITORIES) {
      deps.logger.warn(`GitHub lists ${repositories.length} image repositories for ${prefixes.join(', ')}; the Session Monitor on ${engineName(host)} gets the first ${MAX_IMAGE_REPOSITORIES}.`);
      repositories = repositories.slice(0, MAX_IMAGE_REPOSITORIES);
    }
    deps.logger.info(`The Session Monitor on ${engineName(host)} keeps ${repositories.length} image repositories up to date (from its next open): ${repositories.join(', ')}.`);
    // Only the latest read of the engine.
    if (lists.get(host) === started) lists.set(host, { readAt: started.readAt, repositories, toSend: true });
  };
  return (host) => {
    const prefixes = deps.prefixes();
    if (!prefixes.some((prefix) => ghcrOwnerOf(prefix) !== undefined)) return { listSent: () => {} };
    const known = lists.get(host);
    const given = known?.toSend === true && known.repositories !== undefined ? known.repositories : undefined;
    const listSent = () => {
      const current = lists.get(host);
      if (current !== undefined && given !== undefined && current.repositories === given) current.toSend = false;
    };
    if (known === undefined || Math.abs(now() - known.readAt) >= IMAGE_LIST_INTERVAL_MS) {
      const started: EngineList = { readAt: now(), ...(known?.repositories !== undefined ? { repositories: known.repositories } : {}), toSend: known?.toSend === true };
      lists.set(host, started);
      void read(host, prefixes, started);
    }
    return { ...(given !== undefined ? { repositories: given } : {}), listSent };
  };
}
