// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run"; the user:
// "the monitor shall do maintenance and pulls of new images, vscode server downloads and extension downloads in the
// background"; live check 3): the part "extensions" of the Session Monitor's background run (BackgroundRun of
// background.ts, after the part of the server) and its share of the daily cleanup of the store. The part takes the union
// of the extension lists that the opens recorded in the last 14 days, asks the Marketplace (one query for the newest
// versions of the entries without a pin; review round 1 of 11H3: queries of at most MARKETPLACE_ALL_VERSIONS_CHUNK IDs
// for all versions of the pinned ones and of those whose newest versions had no compatible release) for the newest
// release of each that the VS Code of the newest stable server of the store runs on the engine's platform, records the
// files it chose, and downloads the `.vsix` files that the store lacks (ensureExtension: under the lock of the file,
// streamed, renamed into place; at most MAX_EXTENSION_BYTES_PER_RUN a run). Each failure is one line and is retried after
// a day. The cleanup removes the files of IDs that no recorded list names, and the files that are not the newest of their
// ID, that no recorded list pins and that no run chose, each under its lock taken without a wait; lock files are never
// removed. The lists, the failures and the chosen files are in the volume of the monitor (`stateDir`). The rules are in
// src/core/vscodeExtensions.ts. No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import type { HttpStreamTransport, HttpTransport } from '../core/http';
import type { VscodePlatform } from '../core/helperChannel/protocol';
import {
  EXTENSION_TEMP_FOLDER,
  STORE_EXTENSION_FOLDER,
  cachedExtensionFiles,
  ensureExtension,
  extensionFile,
  extensionLockFile,
  readExtensionChoices,
  readExtensionFailures,
  readExtensionRecordFiles,
  readExtensionRecords,
  removeStaleExtensionStateFiles,
  writeExtensionChoices,
  writeExtensionFailures,
} from '../core/worker/vscodeExtensionStore';
import {
  EXTENSION_FOLDERS,
  MARKETPLACE_ALL_VERSIONS_CHUNK,
  MARKETPLACE_QUERY_URL,
  MAX_EXTENSION_FALLBACKS,
  MAX_MARKETPLACE_ANSWER_BYTES,
  MAX_MARKETPLACE_SINGLE_QUERIES,
  chooseExtensionVersion,
  compareVersions,
  extensionEntryText,
  extensionFilesToRemove,
  extensionRetryWaits,
  marketplaceQueryBody,
  parseExtensionFailures,
  parseMarketplaceAnswer,
  wantedExtensions,
  type ChosenExtension,
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
/**
 * Review round 1 of 11H3 (A-L4): the most bytes that one run downloads; when they are reached, no further download starts
 * (the rest comes with the next run; one file may pass the bound by at most its own size, MAX_VSIX_BYTES). Review round 2
 * of 11H3 (A-L1): the bytes transferred by every download, also by one that failed afterwards.
 */
export const MAX_EXTENSION_BYTES_PER_RUN = 1024 * 1024 * 1024;

/** Plan step 11H3: what the part "extensions" and its cleanup use (extensionRunDeps of background.ts). */
export interface ExtensionRunDeps {
  /** The store (VSCODE_STORE_DIR in the monitor). */
  root: string;
  /**
   * Review round 1 of 11H3 (A-L5, B-D4): the volume of the monitor (REMOTE_MONITOR_STATE_DIR), with the recorded lists,
   * the failures and the chosen files; no dev container mounts it.
   */
  stateDir: string;
  /** Default MAX_EXTENSION_BYTES_PER_RUN. */
  maxRunBytes?: number;
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
  const { log, root, stateDir } = deps;
  const now = deps.now();
  const wanted = wantedExtensions(await readExtensionRecords(stateDir), now);
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
  const failures = parseExtensionFailures(await readExtensionFailures(stateDir));
  const before = JSON.stringify([...failures]);
  const due = wanted.filter((ref) => !extensionRetryWaits(failures.get(extensionEntryText(ref)), now));
  const waiting = wanted.length - due.length;
  const counts = { downloaded: 0, present: 0, failed: 0 };
  const fail = (ref: ExtensionRef, why: string) => {
    counts.failed++;
    failures.set(extensionEntryText(ref), now);
    log(`The extension ${extensionEntryText(ref)} is not in the shared extension cache (${why}); it is tried again after a day.`);
  };
  const noRelease = (ref: ExtensionRef) => (ref.version !== undefined ? `the Marketplace has no such version for ${platform}` : `the Marketplace has no release for VS Code ${vscodeVersion} on ${platform}`);
  const query = (ids: readonly string[], latestOnly: boolean) => queryMarketplace(deps.transport, ids, latestOnly, AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS));
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const queryFailure = (count: number, error: unknown) => `The Marketplace could not be asked for ${count} extension(s): ${message(error)}`;
  /** The version that each entry gets, in the order of the downloads. */
  const choices: Array<{ ref: ExtensionRef; chosen: ChosenExtension }> = [];
  // The entries without a pin: one query for the newest versions (a failed query records nothing: the next run asks again).
  const unpinned = due.filter((ref) => ref.version === undefined);
  /** The entries whose answers need all versions: the pinned ones, and (A-L8) those without a compatible newest release. */
  const allVersions = due.filter((ref) => ref.version !== undefined);
  if (unpinned.length > 0) {
    let answer: Map<string, MarketplaceVersion[]> | undefined;
    try {
      answer = await query([...new Set(unpinned.map((ref) => ref.id))], true);
    } catch (error) {
      log(queryFailure(unpinned.length, error));
    }
    let fallbacks = 0;
    for (const ref of answer !== undefined ? unpinned : []) {
      const versions = answer!.get(ref.id);
      const chosen = versions !== undefined ? chooseExtensionVersion(ref, versions, vscodeVersion, platform) : undefined;
      if (versions === undefined) fail(ref, 'the Marketplace does not have it');
      else if (chosen !== undefined) choices.push({ ref, chosen });
      // Review round 1 of 11H3 (A-L8): asked once more for all its versions (an older release may fit), a bounded number.
      else if (fallbacks++ < MAX_EXTENSION_FALLBACKS) allVersions.push(ref);
      else fail(ref, noRelease(ref));
    }
  }
  // Review round 1 of 11H3 (A-L7): all versions in queries of at most MARKETPLACE_ALL_VERSIONS_CHUNK IDs; a failed query
  // fails only its own entries (each waits a day). Review round 2 of 11H3 (A-L2, B R2-D2): a failed query of several IDs
  // is asked again one ID at a time (at most MAX_MARKETPLACE_SINGLE_QUERIES a run), so one ID whose answer fails (e.g. a
  // history larger than MAX_MARKETPLACE_ANSWER_BYTES) fails only its own entries, not those of its neighbours.
  const decide = (refs: readonly ExtensionRef[], answer: ReadonlyMap<string, MarketplaceVersion[]>) => {
    for (const ref of refs) {
      const versions = answer.get(ref.id);
      const chosen = versions !== undefined ? chooseExtensionVersion(ref, versions, vscodeVersion, platform) : undefined;
      if (versions === undefined) fail(ref, 'the Marketplace does not have it');
      else if (chosen === undefined) fail(ref, noRelease(ref));
      else choices.push({ ref, chosen });
    }
  };
  const ask = (chunk: readonly string[]) => query(chunk, false).then((answer) => ({ answer }), (error: unknown) => ({ error }));
  let singleQueries = 0;
  const ids = [...new Set(allVersions.map((ref) => ref.id))];
  for (let start = 0; start < ids.length; start += MARKETPLACE_ALL_VERSIONS_CHUNK) {
    const chunk = ids.slice(start, start + MARKETPLACE_ALL_VERSIONS_CHUNK);
    const refs = allVersions.filter((ref) => chunk.includes(ref.id));
    const result = await ask(chunk);
    if ('answer' in result) {
      decide(refs, result.answer);
      continue;
    }
    log(queryFailure(refs.length, result.error));
    for (const id of chunk) {
      const own = refs.filter((ref) => ref.id === id);
      const single = chunk.length > 1 && singleQueries++ < MAX_MARKETPLACE_SINGLE_QUERIES ? await ask([id]) : result;
      if ('answer' in single) decide(own, single.answer);
      else for (const ref of own) fail(ref, `its query failed: ${message(single.error)}`);
    }
  }
  // Review round 1 of 11H3 (A-L3, B-D1): the chosen files, which the cleanup keeps and the seed of an entry without a pin
  // prefers; an entry that this run did not decide keeps its earlier choice while a list wants it. Review round 2 of 11H3
  // (B R2-D1): a new choice is recorded only once its file is in the store (present, or downloaded by this run); until
  // then the entry keeps its earlier choice (a failed or deferred download never names a missing file).
  const kept = new Set(wanted.map(extensionEntryText));
  const previous = await readExtensionChoices(stateDir);
  const chosenFiles = new Map([...previous].filter(([entry]) => kept.has(entry)));
  const inStore = (ref: ExtensionRef, chosen: ChosenExtension) => {
    failures.delete(extensionEntryText(ref));
    chosenFiles.set(extensionEntryText(ref), `${chosen.folder}/${chosen.cacheName}`);
  };
  // Review round 1 of 11H3 (A-L4): at most maxRunBytes downloaded a run; the rest comes with the next run. Review round 2
  // of 11H3 (A-L1): every transferred byte counts, also those of a download that failed.
  const maxRunBytes = deps.maxRunBytes ?? MAX_EXTENSION_BYTES_PER_RUN;
  let downloadedBytes = 0;
  let deferred = 0;
  const signal = new AbortController().signal;
  const storeDeps = { root, transport: deps.transport, lock: locks(deps).lock, logger: { warn: log }, onBytes: (bytes: number) => void (downloadedBytes += bytes) };
  for (const { ref, chosen } of choices) {
    const target = extensionFile(root, chosen.folder, chosen.cacheName);
    if (downloadedBytes >= maxRunBytes) {
      if ((await fs.promises.lstat(target).catch(() => undefined))?.isFile() === true) {
        counts.present++;
        inStore(ref, chosen);
      } else deferred++;
      continue;
    }
    try {
      const outcome = await ensureExtension(storeDeps, chosen, signal);
      counts[outcome]++;
      inStore(ref, chosen);
      if (outcome === 'downloaded') log(`Downloaded the extension ${chosen.cacheName} into the shared extension cache.`);
    } catch (error) {
      fail(ref, error instanceof Error ? error.message : String(error));
    }
  }
  if (deferred > 0) log(`This run downloaded ${downloadedBytes} bytes, its bound; ${deferred} extension(s) are left for the next run.`);
  if (JSON.stringify([...chosenFiles].sort()) !== JSON.stringify([...previous].sort())) {
    await writeExtensionChoices(stateDir, chosenFiles).catch((error: unknown) => {
      log(`The chosen extension files could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  // Only the entries that are still wanted keep their failure.
  for (const entry of [...failures.keys()]) if (!kept.has(entry)) failures.delete(entry);
  if (JSON.stringify([...failures]) !== before) {
    await writeExtensionFailures(stateDir, failures).catch((error: unknown) => {
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
 * recorded in the last 14 days; review round 1 of 11H3: never a file that the runs chose, A-L3/B-D1, and every file of an
 * ID that no such list names, A-L4), each under its lock taken without a wait (`flock -n`; busy: left to the next cleanup),
 * checked again under it and removed; then the leftovers of downloads in `extensions/tmp` (`<cache name>-<random>`),
 * those of a file only while its lock can be taken at once. Lock files are never removed. Never throws. Review round 2 of
 * 11H3: first the records older than RECORDED_LIST_MS and the leftover temporary files of the monitor's volume
 * (removeStaleExtensionStateFiles; A-L3, B R2-D3); a record that is present but cannot be read or parsed keeps the files
 * of the IDs that no list names for this cleanup, with one line (A-L5).
 */
export async function cleanupExtensions(deps: ExtensionRunDeps): Promise<void> {
  const { log, root } = deps;
  const { tryLock } = locks(deps);
  try {
    const now = deps.now();
    // Review round 2 of 11H3 (A-L3, B R2-D3): the records that no longer count and the leftovers of killed writes.
    const stale = await removeStaleExtensionStateFiles(deps.stateDir, now);
    if (stale.length > 0) log(`Removed ${stale.length} old extension list(s) and leftover temporary file(s) from the monitor's volume: ${stale.join(', ')}.`);
    const { records, unreadable } = await readExtensionRecordFiles(deps.stateDir);
    const wanted = wantedExtensions(records, now);
    const pinned = new Set(wanted.filter((ref) => ref.version !== undefined).map(extensionEntryText));
    // Review round 2 of 11H3 (A-L5): a record that is present but cannot be read or parsed may name IDs; this cleanup then
    // keeps the files of the IDs that no list names (the rule of the newest, pinned and chosen files still applies).
    const named = unreadable.length === 0 ? new Set(wanted.map((ref) => ref.id)) : undefined;
    if (unreadable.length > 0) {
      log(`The extension list(s) ${unreadable.join(', ')} could not be read; this cleanup keeps the extension files of the IDs that no list names.`);
    }
    const chosen = new Set((await readExtensionChoices(deps.stateDir)).values());
    const files = await cachedExtensionFiles(root);
    let removed = 0;
    for (const folder of EXTENSION_FOLDERS) {
      for (const name of extensionFilesToRemove(folder, files[folder], pinned, { named, chosen })) {
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
    if (removed > 0) log(`Removed ${removed} extension file(s) that no recent list wants from the shared extension cache.`);
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
