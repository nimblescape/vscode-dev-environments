// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run"; the user:
// "the monitor shall do maintenance and pulls of new images, vscode server downloads and extension downloads in the
// background"; live check 3): the part "extensions" of the Session Monitor's background run (BackgroundRun of
// background.ts, after the part of the server) and its share of the daily cleanup of the store. The part takes the union
// of the extension lists that the opens recorded in the last 14 days, asks the Marketplace once (one query for the
// entries without a pin, one for the pinned ones) for the newest release of each that the VS Code of the newest stable
// server of the store runs on the engine's platform, and downloads the `.vsix` files that the store lacks (ensureExtension:
// under the lock of the file, streamed, renamed into place). Each failure is one line and is retried after a day. The
// cleanup removes the files that are not the newest of their ID and that no recorded list pins, each under its lock taken
// without a wait; lock files are never removed. The rules are in src/core/worker/vscodeExtensions.ts. No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import type { HttpStreamTransport, HttpTransport } from '../core/http';
import type { VscodePlatform } from '../core/helperChannel/protocol';
import {
  EXTENSION_TEMP_FOLDER,
  STORE_EXTENSION_FOLDER,
  cachedExtensionFiles,
  ensureExtension,
  extensionLockFile,
  readExtensionFailures,
  readExtensionRecords,
  writeExtensionFailures,
} from '../core/worker/vscodeExtensionStore';
import {
  EXTENSION_FOLDERS,
  MARKETPLACE_QUERY_URL,
  MAX_MARKETPLACE_ANSWER_BYTES,
  chooseExtensionVersion,
  compareVersions,
  extensionEntryText,
  extensionFilesToRemove,
  extensionRetryWaits,
  marketplaceQueryBody,
  parseExtensionFailures,
  parseMarketplaceAnswer,
  wantedExtensions,
  type ExtensionRef,
  type MarketplaceVersion,
} from '../core/vscodeExtensions';
import { STORE_SERVER_FOLDER, isServerReady, serverPlatform, storeLock, storeTryLock, type StoreLockAttempt } from '../core/worker/vscodeServerStore';
import { engineFailure } from './engine';

/** Plan step 11H3: the time limit of one query of the Marketplace. */
export const MARKETPLACE_TIMEOUT_MS = 60_000;
/** Plan step 11H3: the time limit of the read of the engine's architecture. */
const ARCHITECTURE_TIMEOUT_MS = 60_000;
/** Plan step 11H3: the largest `product.json` of a server that is read for its version. */
const MAX_PRODUCT_JSON_BYTES = 1024 * 1024;

/** Plan step 11H3: what the part "extensions" and its cleanup use (extensionRunDeps of background.ts). */
export interface ExtensionRunDeps {
  /** The store (VSCODE_STORE_DIR in the monitor). */
  root: string;
  /** The HTTPS of the proxy of the daemon (decision C1 of 2026-10-05). */
  transport: HttpTransport & HttpStreamTransport;
  /** The architecture of the engine (`GET /info`). */
  architecture: (signal: AbortSignal) => Promise<string>;
  /** The lock of one file of the cache with a bounded wait (default: storeLock on extensionLockFile). */
  lock?: (cacheName: string, waitSeconds: number, signal: AbortSignal) => Promise<() => void>;
  /** The lock of one file of the cache without a wait (default: storeTryLock on extensionLockFile). */
  tryLock?: (cacheName: string) => Promise<StoreLockAttempt>;
  log: (message: string) => void;
  now: () => number;
}

/** The locks of the store for the files of the cache (extensionLockFile; lock files are never removed). */
function locks(deps: ExtensionRunDeps): Required<Pick<ExtensionRunDeps, 'lock' | 'tryLock'>> {
  return {
    lock: deps.lock ?? ((cacheName, waitSeconds, signal) => storeLock(deps.root, cacheName, waitSeconds, signal, undefined, extensionLockFile(deps.root, cacheName))),
    tryLock: deps.tryLock ?? ((cacheName) => storeTryLock(deps.root, cacheName, undefined, extensionLockFile(deps.root, cacheName))),
  };
}

/**
 * Plan step 11H3 (the brief: "compatible with the VS Code version of the newest stable server in the store"): the
 * `version` of the `product.json` of the ready stable servers of `platform` in the store, the newest (`x.y.z`); undefined
 * when there is none.
 */
export async function newestStableServerVersion(root: string, platform: VscodePlatform): Promise<string | undefined> {
  const folder = path.posix.join(root, STORE_SERVER_FOLDER, 'stable', platform);
  let newest: string | undefined;
  for (const entry of await fs.promises.readdir(folder).catch(() => [] as string[])) {
    const server = path.posix.join(folder, entry);
    if (!/^[0-9a-f]{40}$/.test(entry) || !(await isServerReady(server))) continue;
    const file = path.posix.join(server, 'product.json');
    const stat = await fs.promises.lstat(file).catch(() => undefined);
    if (stat === undefined || !stat.isFile() || stat.size > MAX_PRODUCT_JSON_BYTES) continue;
    let version: unknown;
    try {
      version = (JSON.parse(await fs.promises.readFile(file, 'utf8')) as { version?: unknown }).version;
    } catch {
      continue;
    }
    if (typeof version !== 'string' || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)) continue;
    if (newest === undefined || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

/**
 * Plan step 11H3: one query of the Marketplace (MARKETPLACE_QUERY_URL, the host fixed here) for `ids`; resolves with the
 * versions by ID (parseMarketplaceAnswer), rejects with the reason.
 */
export async function queryMarketplace(transport: HttpTransport, ids: readonly string[], latestOnly: boolean, signal: AbortSignal): Promise<Map<string, MarketplaceVersion[]>> {
  const response = await transport.request(
    {
      method: 'POST',
      url: MARKETPLACE_QUERY_URL,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
      body: marketplaceQueryBody(ids, latestOnly),
      maxBodyBytes: MAX_MARKETPLACE_ANSWER_BYTES,
    },
    signal,
  );
  if (response.status !== 200) throw new Error(`the Marketplace answered HTTP ${response.status}`);
  const answer = parseMarketplaceAnswer(response.body);
  if (answer === undefined) throw new Error('the Marketplace answered no list of extensions');
  return answer;
}

/**
 * Plan step 11H3 (the brief, item 3): the part "extensions" of the background run (see the module comment). Throws only
 * for a failure of the whole part (the run logs it); each entry fails on its own.
 */
export async function downloadExtensions(deps: ExtensionRunDeps): Promise<void> {
  const { log, root } = deps;
  const now = deps.now();
  const wanted = wantedExtensions(await readExtensionRecords(root), now);
  if (wanted.length === 0) {
    log('No open recorded an extension list in the last 14 days; no extension is fetched.');
    return;
  }
  let architecture: string;
  try {
    architecture = await deps.architecture(AbortSignal.timeout(ARCHITECTURE_TIMEOUT_MS));
  } catch (error) {
    log(`The architecture of the engine could not be read, so no extension is fetched: ${engineFailure(error, ARCHITECTURE_TIMEOUT_MS)}`);
    return;
  }
  const platform = serverPlatform(architecture);
  if (platform === undefined) {
    log(`The engine's architecture ${JSON.stringify(architecture)} has no VS Code server in the shared store; no extension is fetched.`);
    return;
  }
  const vscodeVersion = await newestStableServerVersion(root, platform);
  if (vscodeVersion === undefined) {
    log(`The shared store has no stable VS Code server for ${platform}, so the compatible extension versions are not known; no extension is fetched.`);
    return;
  }
  const failures = parseExtensionFailures(await readExtensionFailures(root));
  const before = JSON.stringify([...failures]);
  const due = wanted.filter((ref) => !extensionRetryWaits(failures.get(extensionEntryText(ref)), now));
  const waiting = wanted.length - due.length;
  const counts = { downloaded: 0, present: 0, failed: 0 };
  const fail = (ref: ExtensionRef, why: string) => {
    counts.failed++;
    failures.set(extensionEntryText(ref), now);
    log(`The extension ${extensionEntryText(ref)} is not in the shared extension cache (${why}); it is tried again after a day.`);
  };
  const signal = new AbortController().signal;
  // One query for the entries without a pin (only the newest versions), one for the pinned ones (all versions).
  for (const pinned of [false, true]) {
    const group = due.filter((ref) => (ref.version !== undefined) === pinned);
    if (group.length === 0) continue;
    let answer: Map<string, MarketplaceVersion[]>;
    try {
      answer = await queryMarketplace(deps.transport, [...new Set(group.map((ref) => ref.id))], !pinned, AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS));
    } catch (error) {
      log(`The Marketplace could not be asked for ${group.length} extension(s): ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const ref of group) {
      const versions = answer.get(ref.id);
      if (versions === undefined) {
        fail(ref, 'the Marketplace does not have it');
        continue;
      }
      const chosen = chooseExtensionVersion(ref, versions, vscodeVersion, platform);
      if (chosen === undefined) {
        fail(ref, ref.version !== undefined ? `the Marketplace has no such version for ${platform}` : `the Marketplace has no release for VS Code ${vscodeVersion} on ${platform}`);
        continue;
      }
      try {
        const outcome = await ensureExtension({ root, transport: deps.transport, lock: locks(deps).lock, logger: { warn: log } }, chosen, signal);
        counts[outcome]++;
        failures.delete(extensionEntryText(ref));
        if (outcome === 'downloaded') log(`Downloaded the extension ${chosen.cacheName} into the shared extension cache.`);
      } catch (error) {
        fail(ref, error instanceof Error ? error.message : String(error));
      }
    }
  }
  // Only the entries that are still wanted keep their failure.
  const kept = new Set(wanted.map(extensionEntryText));
  for (const entry of [...failures.keys()]) if (!kept.has(entry)) failures.delete(entry);
  if (JSON.stringify([...failures]) !== before) {
    await writeExtensionFailures(root, failures).catch((error: unknown) => {
      log(`The failed extensions could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  log(
    `The extensions for VS Code ${vscodeVersion} (${platform}): ${wanted.length} wanted, ${counts.downloaded} downloaded, ${counts.present} in the cache, ${counts.failed} failed, ${waiting} waiting for their retry.`,
  );
}

/**
 * Plan step 11H3 (the brief, item 4): the share of the daily cleanup of the store (cleanupWhenDue of background.ts): the
 * files of each folder of the cache that extensionFilesToRemove names (not the newest of their ID, and pinned by no list
 * recorded in the last 14 days), each under its lock taken without a wait (`flock -n`; busy: left to the next cleanup),
 * checked again under it and removed; then the leftovers of downloads in `extensions/tmp` (`<cache name>-<random>`),
 * those of a file only while its lock can be taken at once. Lock files are never removed. Never throws.
 */
export async function cleanupExtensions(deps: ExtensionRunDeps): Promise<void> {
  const { log, root } = deps;
  const { tryLock } = locks(deps);
  try {
    const pinned = new Set(
      wantedExtensions(await readExtensionRecords(root), deps.now())
        .filter((ref) => ref.version !== undefined)
        .map(extensionEntryText),
    );
    const files = await cachedExtensionFiles(root);
    let removed = 0;
    for (const folder of EXTENSION_FOLDERS) {
      for (const name of extensionFilesToRemove(folder, files[folder], pinned)) {
        const attempt = await tryLock(name);
        if (attempt.kind !== 'locked') {
          log(`The extension ${name} is not removed from the shared extension cache now: ${attempt.kind === 'busy' ? 'its lock is held (a download of it runs)' : `its lock could not be taken (${attempt.detail})`}.`);
          continue;
        }
        try {
          const file = path.posix.join(root, STORE_EXTENSION_FOLDER, folder, name);
          if ((await fs.promises.lstat(file).catch(() => undefined))?.isFile() !== true) continue;
          await fs.promises.rm(file, { force: true });
          removed++;
        } catch (error) {
          log(`The extension ${name} could not be removed from the shared extension cache: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          attempt.release();
        }
      }
    }
    if (removed > 0) log(`Removed ${removed} older extension version(s) from the shared extension cache.`);
    const temp = path.posix.join(root, STORE_EXTENSION_FOLDER, EXTENSION_TEMP_FOLDER);
    for (const entry of await fs.promises.readdir(temp).catch(() => [] as string[])) {
      const cacheName = /^([a-z0-9][a-z0-9.-]*)-[0-9a-f]{12}$/.exec(entry)?.[1];
      if (cacheName === undefined) continue;
      const attempt = await tryLock(cacheName);
      if (attempt.kind !== 'locked') continue;
      try {
        await fs.promises.rm(path.posix.join(temp, entry), { force: true, recursive: true });
        log(`Removed the leftover download ${entry} from the shared extension cache.`);
      } catch (error) {
        log(`The leftover download ${entry} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        attempt.release();
      }
    }
  } catch (error) {
    log(`The shared extension cache could not be cleaned up: ${error instanceof Error ? error.message : String(error)}`);
  }
}
