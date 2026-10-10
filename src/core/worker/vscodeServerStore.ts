// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decisions of 2026-10-03, "Shared VS Code server store" and "The VS Code caches are worker
// operations"; the decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run"): the
// server of a VS Code commit in the shared store of the engine (the volume VSCODE_STORE_VOLUME, mounted read-write in the
// worker at VSCODE_STORE_DIR), made present by ensureServer: by the open that needs it (the very first open of a VS Code
// version) and, from plan step 11H2 on, by the Session Monitor in the background. The layout:
//   <store>/server/<quality>/<platform>/<commit>/        the unpacked server (bin/code-server, node, …), readable for all
//   <store>/locks/server-<quality>-<platform>-<commit>.lock  the `flock` of one server version (every worker and the
//                                                          monitor of the engine: one download of a version at a time)
//   <store>/tmp/<quality>-<platform>-<commit>-<random>/  the archive and the unpacked folder of one download, removed on
//                                                          every outcome
//   <store>/used/<quality>-<platform>-<commit>             review round 1 of 11H2 (A-M1): the marker of the last use of
//                                                          a version by an open (markServerOpened; its modification time)
// Plan step 11H2: the cleanup of the monitor takes the lock of a version without a wait (storeTryLock) and reads the
// released commits of the update service (serverCommits); lock files are never removed. Review round 1 of 11H2 (A-M1):
// only an open marks a version as used (never the monitor's own fetch or link), so the monitor's fetches never keep
// themselves (or the fetch of Insiders) going. A present server costs two `lstat` calls: no lock, no network (and the open
// touches its marker). The host of the update service is fixed here
// (VSCODE_UPDATE_SERVICE): the extension sends only the commit and the quality, never a URL. The download goes over the
// worker's HTTPS transport (the proxy of the daemon, decision C1 of 2026-10-05), streamed to a file, its SHA-256 checked
// against the update service, unpacked with `tar` and renamed into place. Every failure is one line in the log and means
// "not ready" (the Dev Containers extension then installs the server into the container, as before). No `vscode`.
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { errorMessage } from '../errors';
import { acquireFlock, flockFailure, openPlainLockFile, startFlockProcess, type FlockAttempt, type FlockProcess } from '../helperChannel/lockFile';
import { type VscodePlatform, type VscodeQuality, type VscodeServerRef } from '../helperChannel/protocol';
import type { HttpStreamTransport, HttpTransport } from '../http';
import type { Logger } from '../ports';

/** Plan step 11H1: the update service of Microsoft; the only host whose server the worker fetches (never a parameter). */
export const VSCODE_UPDATE_SERVICE = 'https://update.code.visualstudio.com';

/** Plan step 11H1: the longest fetch of a server, the wait for the lock of the store included (the brief: 10 minutes). */
export const SERVER_FETCH_TIMEOUT_MS = 10 * 60_000;
/** Plan step 11H1: the largest archive of a server that the worker downloads (a server is about 70 MB). */
export const MAX_SERVER_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** Plan step 11H1: the most redirects of the download (each to an `https:` URL). */
export const MAX_SERVER_REDIRECTS = 5;
/** Review round 1 of 11H1 (reviewer B): the largest answer of the update service (its JSON is a few hundred bytes). */
export const MAX_UPDATE_SERVICE_BYTES = 64 * 1024;
/** Plan step 11H1: the longest unpack of the archive by `tar`. */
export const SERVER_UNPACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Plan step 11H1: the platform of the server for the architecture of the engine (`Architecture` of `GET /info`):
 * x86_64/amd64 → linux-x64, aarch64/arm64 → linux-arm64; anything else has no server in the store.
 */
export function serverPlatform(architecture: string): VscodePlatform | undefined {
  const machine = architecture.trim().toLowerCase();
  if (machine === 'x86_64' || machine === 'amd64') return 'linux-x64';
  if (machine === 'aarch64' || machine === 'arm64') return 'linux-arm64';
  return undefined;
}

/** Plan step 11H1: the request of the update service for the server of `server` on `platform` (JSON: `url`, `sha256hash`). */
export function serverVersionUrl(server: VscodeServerRef, platform: VscodePlatform): string {
  return `${VSCODE_UPDATE_SERVICE}/api/versions/commit:${server.commit}/server-${platform}/${server.quality}`;
}

/** Plan step 11H1: the folder of the server in the store (`root`: the store, VSCODE_STORE_DIR in the worker). */
export function serverFolder(root: string, server: VscodeServerRef, platform: VscodePlatform): string {
  return path.posix.join(root, 'server', server.quality, platform, server.commit);
}

/** Plan step 11H1: the server in `folder` is ready: `bin/code-server` and `node` are plain files (never links). */
export async function isServerReady(folder: string): Promise<boolean> {
  try {
    const [script, node] = await Promise.all([fs.promises.lstat(path.join(folder, 'bin', 'code-server')), fs.promises.lstat(path.join(folder, 'node'))]);
    return script.isFile() && node.isFile();
  } catch {
    return false;
  }
}

/** Plan step 11H1: what ensureServer uses (workerVscodeStore in the worker). */
export interface VscodeStoreDeps {
  /** The store (VSCODE_STORE_DIR in the worker). */
  root: string;
  /** The worker's HTTPS (proxiedHttpsTransport over the proxy of the daemon). */
  transport: HttpTransport & HttpStreamTransport;
  /** The architecture of the engine (`Architecture` of `GET /info`), for ensureEngineServer. */
  architecture: (signal: AbortSignal) => Promise<string>;
  /**
   * Takes the lock of one server version (`name`, serverLockName) in the store `root`, waiting at most `waitSeconds`;
   * resolves with its release (storeLock).
   */
  lock: (root: string, name: string, waitSeconds: number, signal: AbortSignal) => Promise<() => void>;
  /** Unpacks the archive into the folder (unpackServer: `tar`); rejects with the cause. */
  unpack: (archive: string, folder: string, signal: AbortSignal) => Promise<void>;
  logger: Logger;
  /** The time limit of the whole fetch, the wait for the lock included; default SERVER_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** The largest archive; default MAX_SERVER_ARCHIVE_BYTES. */
  maxBytes?: number;
  /**
   * Plan step 11H2: the fetch of the Session Monitor's background run (its log lines name the run, not an open and the
   * fallback of the Dev Containers extension).
   */
  background?: boolean;
}

/** A failure of a fetch, with the text of its log line. */
class FetchError extends Error {}

/** Plan step 11H1: the name of one server version in the store (its lock file and the prefix of its temporary folders). */
export function serverVersionName(server: VscodeServerRef, platform: VscodePlatform): string {
  return `${server.quality}-${platform}-${server.commit}`;
}

/**
 * Plan step 11H1 (the decision of 2026-10-09: "when the check costs nothing, then download can go into open again, but
 * must be concurrency safe, other windows could also open the same thing at the same time"): makes sure that the store
 * has the server of `server` for `platform`; the one function of the store, for the open and (plan step 11H2) the Session
 * Monitor. Present already (isServerReady): ready at once, no lock, no network. Otherwise, under the lock of this server
 * version (storeLock; every worker and the monitor of the engine; bounded wait), it checks again (another window or the
 * monitor may have finished it: ready, nothing downloaded), removes the leftovers of an earlier download of this version
 * that ended without its cleanup, asks the update service for the URL and the SHA-256 of the archive, downloads it into a
 * temporary folder of its own (streamed, at most `maxBytes`, at most MAX_SERVER_REDIRECTS redirects to `https:` URLs),
 * checks its SHA-256, unpacks it there, checks that `bin/code-server` and `node` are there, makes it readable for all
 * (folders 0755, files their mode plus read, and execute for all where any execute bit is set), and renames the folder
 * into place (atomic). The temporary folder goes on every outcome. Resolves true when the server is ready, else false
 * after one line in the log (also for a cancel by `signal` and the time limit of the whole fetch); never rejects.
 */
export async function ensureServer(deps: VscodeStoreDeps, server: VscodeServerRef, platform: VscodePlatform, signal: AbortSignal): Promise<boolean> {
  return ensureServerWithin(deps, server, platform, signal, fetchLimit(deps));
}

/** The time limit of one fetch (deps.timeoutMs, default SERVER_FETCH_TIMEOUT_MS): its length and its signal. */
function fetchLimit(deps: VscodeStoreDeps): { timeoutMs: number; limit: AbortSignal } {
  const timeoutMs = deps.timeoutMs ?? SERVER_FETCH_TIMEOUT_MS;
  return { timeoutMs, limit: AbortSignal.timeout(timeoutMs) };
}

/** ensureServer within the time limit `limit` (started by the caller: ensureEngineServer counts its /info in it). */
async function ensureServerWithin(
  deps: VscodeStoreDeps,
  server: VscodeServerRef,
  platform: VscodePlatform,
  signal: AbortSignal,
  { timeoutMs, limit }: { timeoutMs: number; limit: AbortSignal },
): Promise<boolean> {
  const both = AbortSignal.any([signal, limit]);
  const name = `${server.commit} (${server.quality})`;
  try {
    const folder = serverFolder(deps.root, server, platform);
    if (await isServerReady(folder)) return true;
    deps.logger.info(`Downloading the VS Code server ${name} for ${platform} into the shared store of the engine.`);
    const release = await deps.lock(deps.root, serverVersionName(server, platform), Math.max(1, Math.ceil(timeoutMs / 1000)), both);
    try {
      if (await isServerReady(folder)) {
        deps.logger.info(`The VS Code server ${name} for ${platform} was put into the shared store by another window in the meantime.`);
        return true;
      }
      await fetchServer(deps, server, platform, folder, both);
    } finally {
      release();
    }
    deps.logger.info(`The VS Code server ${name} for ${platform} is in the shared store.`);
    return true;
  } catch (error) {
    const why = signal.aborted
      ? deps.background === true
        ? 'the run was ended'
        : 'the open was cancelled'
      : limit.aborted
        ? `the fetch took longer than ${Math.round(timeoutMs / 1000)} s`
        : error instanceof Error
          ? error.message
          : String(error);
    // Plan step 11H2: the background run of the Session Monitor names no fallback (it fetches ahead of any open).
    const fallback = deps.background === true ? '' : '; the Dev Containers extension installs it in the container';
    deps.logger.warn(`The VS Code server ${name} for ${platform} could not be fetched into the shared store (${why})${fallback}.`);
    return false;
  }
}

/**
 * Plan step 11H1: ensureServer for the platform of the engine's architecture (serverPlatform of deps.architecture); an
 * architecture without a server in the store, or an engine that does not say it, is one line and `undefined`. Resolves
 * with the platform when its server is ready, else `undefined`; never rejects. Review round 1 of 11H1 (A-L1): the read of
 * the architecture counts in the time limit of the fetch (one limit for both), so an engine that does not answer
 * `GET /info` never holds the open beyond it.
 */
export async function ensureEngineServer(deps: VscodeStoreDeps, server: VscodeServerRef, signal: AbortSignal): Promise<VscodePlatform | undefined> {
  const name = `${server.commit} (${server.quality})`;
  const limit = fetchLimit(deps);
  const both = AbortSignal.any([signal, limit.limit]);
  let architecture: string;
  try {
    architecture = await untilAborted(deps.architecture(both), both);
  } catch (error) {
    const why = signal.aborted
      ? 'the open was cancelled'
      : limit.limit.aborted
        ? `no answer within ${Math.round(limit.timeoutMs / 1000)} s`
        : error instanceof Error
          ? error.message
          : String(error);
    deps.logger.warn(`The VS Code server ${name} is not fetched into the shared store: the architecture of the engine could not be read (${why}).`);
    return undefined;
  }
  const platform = serverPlatform(architecture);
  if (platform === undefined) {
    deps.logger.info(`The VS Code server ${name} is not fetched into the shared store: the engine's architecture ${JSON.stringify(architecture)} has no server there.`);
    return undefined;
  }
  // Plan step 11H2, review round 1 (A-M1): the open uses this version now (markServerOpened). Before the check of the
  // store, so that a cleanup that takes the lock of this version after it sees the use (it checks the marker again under
  // the lock).
  await markServerOpened(deps.root, server, platform);
  if (!(await ensureServerWithin(deps, server, platform, signal, limit))) return undefined;
  return platform;
}

/** Review round 1 of 11H2 (A-M1): the folder of the markers of the use of a server version by an open. */
export const STORE_USED_FOLDER = 'used';

/** Review round 1 of 11H2 (A-M1): the marker of the use of the server version `version` (serverVersionName) by an open. */
export function serverUseMarker(root: string, version: string): string {
  return path.posix.join(root, STORE_USED_FOLDER, version);
}

/**
 * Plan step 11H2 (the brief: "used", a cheap marker), review round 1 (A-M1): the open that needs a server version
 * (ensureEngineServer, the worker of the open, before its link) sets the modification time of its marker
 * (`<store>/used/<version>`, an empty file, created when missing) to now; nothing else does: the Session Monitor's own
 * fetch and link never count as a use. The marker decides whether the monitor keeps the newest Insiders server present
 * (an insider version used by an open within 14 days) and which versions its cleanup may remove (not used by an open for
 * 14 days). The file is opened without following a link, in a `used` folder that is no link; the dev containers mount
 * the store read-only, so only the workers set it. Best effort: a failure is ignored.
 */
export async function markServerOpened(root: string, server: VscodeServerRef, platform: VscodePlatform, at: Date = new Date()): Promise<void> {
  try {
    const folder = path.posix.join(root, STORE_USED_FOLDER);
    // Never the store itself (it is the mount of the volume): only its folder `used`, which must be a plain folder.
    await fs.promises.mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await fs.promises.lstat(folder)).isDirectory()) return;
    const handle = await fs.promises.open(serverUseMarker(root, serverVersionName(server, platform)), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      await handle.utimes(at, at);
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: the version then counts as used when it was last marked.
  }
}

/**
 * Review round 1 of 11H2 (A-M1): when an open last used the server version `version` (the modification time of its
 * marker, a regular file), or undefined when no open marked it.
 */
export async function serverOpenedAt(root: string, version: string): Promise<number | undefined> {
  const stat = await fs.promises.lstat(serverUseMarker(root, version)).catch(() => undefined);
  return stat?.isFile() === true ? stat.mtimeMs : undefined;
}

/** Waits for `promise`; rejects when `signal` aborts first (a call that ignores its signal ends at the limit too). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new FetchError('ended'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new FetchError('ended'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Plan step 11H1: the folder of the temporary folders of the downloads in the store. */
export const STORE_TEMP_FOLDER = 'tmp';
/** Plan step 11H2: the folder of the servers in the store (`server/<quality>/<platform>/<commit>`). */
export const STORE_SERVER_FOLDER = 'server';

/**
 * Plan step 11H2: the server version of a temporary folder of the store (`<quality>-<platform>-<commit>-<random>`, as a
 * download of fetchServer or a removal of the cleanup names it), or undefined for any other name.
 */
export function temporaryFolderVersion(name: string): { quality: VscodeQuality; platform: VscodePlatform; commit: string; version: string } | undefined {
  const match = /^(stable|insider)-(linux-x64|linux-arm64)-([0-9a-f]{40})-[0-9a-f]{1,32}$/.exec(name);
  if (match === null) return undefined;
  const [, quality, platform, commit] = match as unknown as [string, VscodeQuality, VscodePlatform, string];
  return { quality, platform, commit, version: serverVersionName({ commit, quality }, platform) };
}

/**
 * Plan step 11H2 (D3 of 2026-10-09): the request of the update service for the released commits of the server of
 * `quality` on `platform`, newest first (a JSON array of commits).
 */
export function serverCommitsUrl(quality: VscodeQuality, platform: VscodePlatform): string {
  return `${VSCODE_UPDATE_SERVICE}/api/commits/${quality}/server-${platform}`;
}

/** Plan step 11H2: the largest answer of the commits of the update service (a commit is 43 bytes of JSON). */
export const MAX_SERVER_COMMITS_BYTES = 1024 * 1024;
/** Plan step 11H2: at most this many commits of an answer are taken. */
export const MAX_SERVER_COMMITS = 20_000;

/**
 * Plan step 11H2: the commits of the update service, newest first, strictly: a JSON array of at least one and at most
 * MAX_SERVER_COMMITS commits, each 40 lower-case hexadecimal characters, none twice; undefined for anything else.
 */
export function parseServerCommits(body: string): string[] | undefined {
  if (Buffer.byteLength(body, 'utf8') > MAX_SERVER_COMMITS_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SERVER_COMMITS) return undefined;
  if (!value.every((commit) => typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit))) return undefined;
  const commits = value as string[];
  return new Set(commits).size === commits.length ? commits : undefined;
}

/**
 * Plan step 11H2 (D3): the released commits of the server of `quality` on `platform`, newest first, from the update
 * service (VSCODE_UPDATE_SERVICE, the host fixed here; at most MAX_SERVER_COMMITS_BYTES; parseServerCommits). Rejects
 * with the reason.
 */
export async function serverCommits(transport: HttpTransport, quality: VscodeQuality, platform: VscodePlatform, signal: AbortSignal): Promise<string[]> {
  const response = await transport.request(
    { method: 'GET', url: serverCommitsUrl(quality, platform), headers: { Accept: 'application/json' }, maxBodyBytes: MAX_SERVER_COMMITS_BYTES },
    signal,
  );
  if (response.status !== 200) throw new FetchError(`the update service answered HTTP ${response.status}`);
  const commits = parseServerCommits(response.body);
  if (commits === undefined) throw new FetchError('the update service answered no list of commits');
  return commits;
}

/** The fetch itself, under the lock of its server version (ensureServer). */
async function fetchServer(deps: VscodeStoreDeps, server: VscodeServerRef, platform: VscodePlatform, folder: string, signal: AbortSignal): Promise<void> {
  const temp = path.posix.join(deps.root, STORE_TEMP_FOLDER);
  const version = serverVersionName(server, platform);
  await fs.promises.mkdir(temp, { recursive: true, mode: 0o700 });
  const tempStat = await fs.promises.lstat(temp);
  if (!tempStat.isDirectory()) throw new FetchError(`${temp} is not a folder`);
  // Under the lock of this version no other download of it runs: a folder of this version there is left over from one
  // that ended without its cleanup (a worker that was killed). The folders of other versions are never touched (their
  // downloads may run now).
  for (const entry of await fs.promises.readdir(temp)) {
    if (entry.startsWith(`${version}-`)) await fs.promises.rm(path.posix.join(temp, entry), { recursive: true, force: true });
  }
  const own = path.posix.join(temp, `${version}-${randomBytes(6).toString('hex')}`);
  await fs.promises.mkdir(own, { mode: 0o700 });
  const archive = path.posix.join(own, 'server.tar.gz');
  const unpacked = path.posix.join(own, 'server');
  try {
    const { url, sha256 } = await serverDownload(deps.transport, server, platform, signal);
    const hash = await downloadToFile(deps.transport, url, archive, deps.maxBytes ?? MAX_SERVER_ARCHIVE_BYTES, signal);
    if (hash !== sha256) throw new FetchError(`the SHA-256 of the download ${hash} is not the ${sha256} of the update service`);
    await fs.promises.mkdir(unpacked, { mode: 0o700 });
    await deps.unpack(archive, unpacked, signal);
    if (!(await isServerReady(unpacked))) throw new FetchError('the archive has no bin/code-server or no node');
    await readableForAll(unpacked);
    // The folders above it, readable for all too (the dev containers read the store as their remote user).
    let parent = deps.root;
    for (const part of ['server', server.quality, platform]) {
      parent = path.posix.join(parent, part);
      await fs.promises.mkdir(parent, { recursive: true, mode: 0o755 });
      const stat = await fs.promises.lstat(parent);
      if (!stat.isDirectory()) throw new FetchError(`${parent} is not a folder`);
      if ((stat.mode & 0o777) !== 0o755) await fs.promises.chmod(parent, 0o755);
    }
    // Review round 2 of 11H1: a folder of the commit that is ready is never moved away or removed (a dev container may run
    // the server from it): it stays, and this download goes with the temporary folder.
    if (await isServerReady(folder)) return;
    // A folder of the commit that is not ready (no download of the worker leaves one; it is not used anyway) goes first.
    const old = await fs.promises.lstat(folder).catch(() => undefined);
    if (old !== undefined) await fs.promises.rename(folder, path.posix.join(own, 'old'));
    await fs.promises.rename(unpacked, folder);
  } finally {
    await fs.promises.rm(own, { recursive: true, force: true }).catch((error: unknown) => {
      deps.logger.warn(`The temporary files of the shared VS Code server store could not be removed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

/** The URL and the SHA-256 of the archive of the server, from the update service (VSCODE_UPDATE_SERVICE). */
async function serverDownload(transport: HttpTransport, server: VscodeServerRef, platform: VscodePlatform, signal: AbortSignal): Promise<{ url: string; sha256: string }> {
  const response = await transport.request(
    { method: 'GET', url: serverVersionUrl(server, platform), headers: { Accept: 'application/json' }, maxBodyBytes: MAX_UPDATE_SERVICE_BYTES },
    signal,
  );
  if (response.status !== 200) throw new FetchError(`the update service answered HTTP ${response.status}`);
  // Review round 1 of 11H1 (reviewer B): at most MAX_UPDATE_SERVICE_BYTES (httpsRequest stops reading there; checked
  // here too, whatever the transport).
  if (Buffer.byteLength(response.body, 'utf8') > MAX_UPDATE_SERVICE_BYTES) throw new FetchError(`the update service answered more than ${MAX_UPDATE_SERVICE_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw new FetchError('the update service answered no JSON');
  }
  const { url, sha256hash } = (typeof value === 'object' && value !== null ? value : {}) as { url?: unknown; sha256hash?: unknown };
  if (typeof sha256hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256hash)) throw new FetchError('the update service answered no SHA-256');
  if (typeof url !== 'string' || !isHttpsUrl(url)) throw new FetchError('the update service answered no https URL');
  return { url, sha256: sha256hash.toLowerCase() };
}

function urlAllowed(text: string, allowedUrl: (url: URL) => boolean): boolean {
  try {
    return allowedUrl(new URL(text));
  } catch {
    return false;
  }
}

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Plan step 11H1: downloads `url` to the new file `file` (0600; an existing one is refused), streamed: at most
 * `maxBytes` (also by its Content-Length), MAX_SERVER_REDIRECTS redirects each to an `https:` URL, status 200 at the
 * end. Resolves with the SHA-256 of the content (lower-case hexadecimal). The caller removes the file on a failure.
 * Review round 1 of 11H3 (A-L6): `allowedUrl`, when given, must accept the first URL and every redirect (the download of
 * a `.vsix` only from the hosts of the Marketplace); 11H1's server download gives none. Review round 2 of 11H3 (A-L1):
 * `onBytes`, when given, is told the length of every chunk of the body as it arrives (also of a download that fails
 * afterwards), so that the monitor's bound of a run counts every transferred byte.
 */
export async function downloadToFile(
  transport: HttpStreamTransport,
  url: string,
  file: string,
  maxBytes: number,
  signal: AbortSignal,
  allowedUrl?: (url: URL) => boolean,
  onBytes?: (bytes: number) => void,
): Promise<string> {
  let current = url;
  for (let redirects = 0; ; redirects++) {
    if (allowedUrl !== undefined && !urlAllowed(current, allowedUrl)) throw new FetchError('the download URL is not on an allowed host');
    const response = await transport.stream(current, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.body.destroy();
      const location = response.headers.location;
      if (redirects >= MAX_SERVER_REDIRECTS) throw new FetchError(`the download was redirected more than ${MAX_SERVER_REDIRECTS} times`);
      let next: URL;
      try {
        next = new URL(location ?? '', current);
      } catch {
        throw new FetchError('the download was redirected to an invalid URL');
      }
      if (location === undefined || next.protocol !== 'https:') throw new FetchError('the download was redirected to a URL that is not https');
      current = next.toString();
      continue;
    }
    if (response.status !== 200) {
      response.body.destroy();
      throw new FetchError(`the download answered HTTP ${response.status}`);
    }
    const length = Number(response.headers['content-length']);
    if (Number.isFinite(length) && length > maxBytes) {
      response.body.destroy();
      throw new FetchError(`the download is larger than ${maxBytes} bytes`);
    }
    const hash = createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        onBytes?.(chunk.length);
        if (size > maxBytes) {
          done(new FetchError(`the download is larger than ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(response.body, counter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    return hash.digest('hex');
  }
}

/**
 * Plan step 11H1: everything in `folder` readable for all: folders 0755, files their mode plus read for all, and execute
 * for all where any execute bit is set (so the remote user of a dev container runs `node` and `bin/code-server`); links
 * stay as they are. Review round 1 of 11H1 (A-L2): the setuid, setgid and sticky bits of the archive are dropped (a
 * setuid file in the store would run as its owner, root, in every dev container of the engine).
 */
export async function readableForAll(folder: string): Promise<void> {
  const stat = await fs.promises.lstat(folder);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(folder, 0o755);
    for (const entry of await fs.promises.readdir(folder)) await readableForAll(path.join(folder, entry));
    return;
  }
  const mode = stat.mode & 0o777;
  const wanted = mode | 0o444 | ((mode & 0o111) !== 0 ? 0o111 : 0);
  if (wanted !== (stat.mode & 0o7777)) await fs.promises.chmod(folder, wanted);
}

/** Plan step 11H1: the folder of the lock files of the server versions in the store. */
export const STORE_LOCK_FOLDER = 'locks';

/** Plan step 11H1: the lock file of the server version `name` (serverVersionName) in the store `root`. */
export function serverLockFile(root: string, name: string): string {
  return path.posix.join(root, STORE_LOCK_FOLDER, `server-${name}.lock`);
}

/**
 * Plan step 11H1: the lock of one server version in the store (serverLockFile), taken as the environment lock is taken
 * (lockFile.ts: the lock file opened without following a link, `flock` on its descriptor with a bounded wait), so it holds
 * across the workers of all windows and the Session Monitor of the engine; resolves with its release. Rejects when the
 * lock stayed held for the whole wait, when `flock` fails, or when `signal` aborts (flock is ended then). Plan step 11H3:
 * `lockFile` names the lock file of another entry of the store (the lock of one extension file, extensionLockFile).
 */
export async function storeLock(
  root: string,
  name: string,
  waitSeconds: number,
  signal: AbortSignal,
  startFlock: (args: readonly string[], fd: number) => FlockProcess = startFlockProcess,
  lockFile: string = serverLockFile(root, name),
): Promise<() => void> {
  const folder = path.posix.join(root, STORE_LOCK_FOLDER);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(folder).isDirectory()) throw new FetchError(`${folder} is not a folder`);
  // Cleanup C5 (plan step 11J, B3): the acquisition of lockFile.ts; the outcomes keep their errors.
  const attempt = await acquireFlock({
    open: () => openPlainLockFile(lockFile, 'The lock file of the shared VS Code server store'),
    close: (fd) => fs.closeSync(fd),
    start: startFlock,
    waitSeconds,
    signal,
  });
  switch (attempt.kind) {
    case 'locked':
      return attempt.release;
    case 'openFailed':
    case 'startThrew':
      throw attempt.error;
    case 'cancelled':
      throw new FetchError('the wait for the lock of the server ended');
    case 'startFailed':
      throw new FetchError(`flock could not be started: ${attempt.detail}`);
    case 'busy':
      throw new FetchError(`the lock of the server stayed held for ${waitSeconds} s`);
    case 'failed':
      throw new FetchError(flockFailure(attempt, false));
    case 'timeout':
      // Never: no time limit is given.
      throw new FetchError('flock did not end in time');
  }
}

/** Plan step 11H2: what an attempt to take the lock of a server version without a wait gave (storeTryLock). */
export type StoreLockAttempt = { kind: 'locked'; release(): void } | { kind: 'busy' } | { kind: 'failed'; detail: string };

/**
 * Plan step 11H2 (the plan's 11H2 row: `flock -n`): the lock of one server version in the store (serverLockFile), taken
 * without a wait, for the cleanup of the Session Monitor: `busy` while a download of that version (an open, another
 * window, the monitor) holds it, so the cleanup never touches a version that is being fetched. Never rejects; the lock
 * file stays (lock files are never removed). Plan step 11H3: `lockFile` as for storeLock.
 */
export async function storeTryLock(
  root: string,
  name: string,
  startFlock: (args: readonly string[], fd: number) => FlockProcess = startFlockProcess,
  lockFile: string = serverLockFile(root, name),
): Promise<StoreLockAttempt> {
  try {
    const folder = path.posix.join(root, STORE_LOCK_FOLDER);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(folder).isDirectory()) return { kind: 'failed', detail: `${folder} is not a folder` };
  } catch (error) {
    return { kind: 'failed', detail: `the lock file could not be opened: ${errorMessage(error)}` };
  }
  // Cleanup C5 (plan step 11J, B3): the acquisition of lockFile.ts (no wait); the outcomes keep their texts.
  let attempt: FlockAttempt;
  try {
    attempt = await acquireFlock({
      open: () => openPlainLockFile(lockFile, 'The lock file of the shared VS Code server store'),
      close: (fd) => fs.closeSync(fd),
      start: startFlock,
    });
  } catch (error) {
    return { kind: 'failed', detail: `flock could not be started: ${errorMessage(error)}` };
  }
  switch (attempt.kind) {
    case 'locked':
      return { kind: 'locked', release: attempt.release };
    case 'busy':
      return { kind: 'busy' };
    case 'openFailed':
      return { kind: 'failed', detail: `the lock file could not be opened: ${errorMessage(attempt.error)}` };
    case 'startThrew':
      return { kind: 'failed', detail: `flock could not be started: ${errorMessage(attempt.error)}` };
    case 'startFailed':
      return { kind: 'failed', detail: `flock could not be started: ${attempt.detail}` };
    case 'failed':
      return { kind: 'failed', detail: flockFailure(attempt, false) };
    case 'cancelled':
    case 'timeout':
      // Never: neither a signal nor a time limit is given.
      return { kind: 'failed', detail: 'flock did not end' };
  }
}

/**
 * Plan step 11H1: unpacks the archive with `tar -xzf <archive> -C <folder> --strip-components 1 --no-same-owner` (the
 * worker runs as root without capabilities, so it cannot give the files another owner), without a shell, within
 * SERVER_UNPACK_TIMEOUT_MS; a cancel ends it. Rejects with the end of its error output.
 */
export function unpackServer(archive: string, folder: string, signal: AbortSignal, timeoutMs = SERVER_UNPACK_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const both = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    if (both.aborted) {
      reject(new FetchError('the unpack was ended'));
      return;
    }
    const child = spawn('tar', ['-xzf', archive, '-C', folder, '--strip-components', '1', '--no-same-owner'], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1_000);
    });
    const end = () => child.kill('SIGKILL');
    both.addEventListener('abort', end, { once: true });
    child.on('error', (error) => {
      both.removeEventListener('abort', end);
      reject(new FetchError(`tar could not be started: ${error.message}`));
    });
    child.on('close', (code) => {
      both.removeEventListener('abort', end);
      if (both.aborted) reject(new FetchError(signal.aborted ? 'the unpack was cancelled' : `the unpack took longer than ${Math.round(timeoutMs / 1000)} s`));
      else if (code === 0) resolve();
      else reject(new FetchError(`tar failed (${code === null ? 'ended by a signal' : `exit code ${code}`})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
    });
  });
}
