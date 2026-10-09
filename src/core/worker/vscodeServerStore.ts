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
// A present server costs two `lstat` calls: no lock, no network. The host of the update service is fixed here
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
import { FLOCK_FD, openPlainLockFile, startFlockProcess, type FlockProcess } from '../helperChannel/lockFile';
import { LOCK_BUSY_EXIT, flockArgs, type VscodePlatform, type VscodeServerRef } from '../helperChannel/protocol';
import type { HttpStreamTransport, HttpTransport } from '../http';
import type { Logger } from '../ports';

export type { VscodePlatform };

/** Plan step 11H1: the update service of Microsoft; the only host whose server the worker fetches (never a parameter). */
export const VSCODE_UPDATE_SERVICE = 'https://update.code.visualstudio.com';

/** Plan step 11H1: the longest fetch of a server, the wait for the lock of the store included (the brief: 10 minutes). */
export const SERVER_FETCH_TIMEOUT_MS = 10 * 60_000;
/** Plan step 11H1: the largest archive of a server that the worker downloads (a server is about 70 MB). */
export const MAX_SERVER_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** Plan step 11H1: the most redirects of the download (each to an `https:` URL). */
export const MAX_SERVER_REDIRECTS = 5;
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
  const timeoutMs = deps.timeoutMs ?? SERVER_FETCH_TIMEOUT_MS;
  const limit = AbortSignal.timeout(timeoutMs);
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
      ? 'the open was cancelled'
      : limit.aborted
        ? `the fetch took longer than ${Math.round(timeoutMs / 1000)} s`
        : error instanceof Error
          ? error.message
          : String(error);
    deps.logger.warn(`The VS Code server ${name} for ${platform} could not be fetched into the shared store (${why}); the Dev Containers extension installs it in the container.`);
    return false;
  }
}

/**
 * Plan step 11H1: ensureServer for the platform of the engine's architecture (serverPlatform of deps.architecture); an
 * architecture without a server in the store, or an engine that does not say it, is one line and `undefined`. Resolves
 * with the platform when its server is ready, else `undefined`; never rejects.
 */
export async function ensureEngineServer(deps: VscodeStoreDeps, server: VscodeServerRef, signal: AbortSignal): Promise<VscodePlatform | undefined> {
  const name = `${server.commit} (${server.quality})`;
  let architecture: string;
  try {
    architecture = await deps.architecture(signal);
  } catch (error) {
    deps.logger.warn(`The VS Code server ${name} is not fetched into the shared store: the architecture of the engine could not be read (${signal.aborted ? 'the open was cancelled' : error instanceof Error ? error.message : String(error)}).`);
    return undefined;
  }
  const platform = serverPlatform(architecture);
  if (platform === undefined) {
    deps.logger.info(`The VS Code server ${name} is not fetched into the shared store: the engine's architecture ${JSON.stringify(architecture)} has no server there.`);
    return undefined;
  }
  return (await ensureServer(deps, server, platform, signal)) ? platform : undefined;
}

/** Plan step 11H1: the folder of the temporary folders of the downloads in the store. */
export const STORE_TEMP_FOLDER = 'tmp';

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
  const response = await transport.request({ method: 'GET', url: serverVersionUrl(server, platform), headers: { Accept: 'application/json' } }, signal);
  if (response.status !== 200) throw new FetchError(`the update service answered HTTP ${response.status}`);
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
 */
export async function downloadToFile(transport: HttpStreamTransport, url: string, file: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  let current = url;
  for (let redirects = 0; ; redirects++) {
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
 * stay as they are.
 */
export async function readableForAll(folder: string): Promise<void> {
  const stat = await fs.promises.lstat(folder);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(folder, 0o755);
    for (const entry of await fs.promises.readdir(folder)) await readableForAll(path.join(folder, entry));
    return;
  }
  const mode = stat.mode & 0o7777;
  const wanted = mode | 0o444 | ((mode & 0o111) !== 0 ? 0o111 : 0);
  if (wanted !== mode) await fs.promises.chmod(folder, wanted);
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
 * lock stayed held for the whole wait, when `flock` fails, or when `signal` aborts (flock is ended then).
 */
export async function storeLock(
  root: string,
  name: string,
  waitSeconds: number,
  signal: AbortSignal,
  startFlock: (args: readonly string[], fd: number) => FlockProcess = startFlockProcess,
): Promise<() => void> {
  const folder = path.posix.join(root, STORE_LOCK_FOLDER);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(folder).isDirectory()) throw new FetchError(`${folder} is not a folder`);
  const fd = openPlainLockFile(serverLockFile(root, name), 'The lock file of the shared VS Code server store');
  const release = () => {
    try {
      fs.closeSync(fd);
    } catch {
      // Closed already.
    }
  };
  try {
    if (signal.aborted) throw new FetchError('the wait for the lock of the server ended');
    const flock = startFlock(flockArgs(waitSeconds, FLOCK_FD), fd);
    const end = () => flock.kill('SIGKILL');
    signal.addEventListener('abort', end, { once: true });
    if (signal.aborted) end();
    let outcome: Awaited<FlockProcess['exited']>;
    try {
      outcome = await flock.exited;
    } finally {
      signal.removeEventListener('abort', end);
    }
    if (signal.aborted) throw new FetchError('the wait for the lock of the server ended');
    if (outcome.error !== undefined) throw new FetchError(`flock could not be started: ${outcome.error}`);
    if (outcome.exitCode === LOCK_BUSY_EXIT) throw new FetchError(`the lock of the server stayed held for ${waitSeconds} s`);
    if (outcome.exitCode !== 0) throw new FetchError(`flock failed (${outcome.exitCode === null ? 'ended by a signal' : `exit code ${outcome.exitCode}`})`);
    return release;
  } catch (error) {
    release();
    throw error;
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
