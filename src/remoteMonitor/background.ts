// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run"; the user:
// "the monitor shall do maintenance and pulls of new images, vscode server downloads and extension downloads in the
// background"): one background run of the Session Monitor, started by its schedule (the setting cacheUpdateSchedule,
// CacheSchedule of main.ts). Its parts run one after the other, each logged, and each failing on its own (a failure
// never stops the monitor or the next part):
//   a. the image checks and pulls of the prefixes of imageUpdates (ImageMaintenance; D5: only they follow that setting);
//   b. the newest released VS Code server (D3): for each quality (stable always, insider while an open used an insider
//      version within 14 days; review round 1, A-M1) and the platform of the engine, the newest commit of the update
//      service, made present by ensureServer of the open (the same lock of the version, so an open that needs it waits,
//      and nothing is downloaded twice); a version whose fetch failed is tried again after a day (A-L4);
//   c. a server that became ready in this run is linked into the running dev containers of the engine that mount the
//      store (D4), as the remote user of each (its label devcontainer.metadata, as the Dev Containers extension attaches;
//      containerMetadataUser), by the link script of the open (`vscodeServerLink` of the registry of the container
//      scripts), so the windows that VS Code restores after its update find their server;
//   d. the cleanup of the store, at most once a day: the server versions that no open used for 14 days, that are not among
//      the two newest of their quality and platform, and that no running container that mounts the store runs (its
//      processes; review round 1, A-M2), each under its lock taken without a wait (`flock -n`), and the temporary folders
//      of a version only while its lock can be taken at once; lock files are never removed.
// The pure rules are in backgroundRules.ts. No `vscode`.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VSCODE_QUALITIES, type VscodePlatform, type VscodeQuality, type VscodeServerRef } from '../core/helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import { containerMetadataUser } from '../core/pipeline/pipelineRules';
import { runScript } from '../core/worker/containerScripts';
import { mountsVscodeStore, vscodeServerLinkOutcome } from '../core/worker/vscodeServerLink';
import {
  STORE_SERVER_FOLDER,
  STORE_TEMP_FOLDER,
  ensureServer,
  STORE_USED_FOLDER,
  isServerReady,
  serverCommits,
  serverFolder,
  serverOpenedAt,
  serverPlatform,
  serverVersionName,
  temporaryFolderVersion,
  type StoreLockAttempt,
  type VscodeStoreDeps,
} from '../core/worker/vscodeServerStore';
import {
  FETCH_RETRY_MS,
  MAX_FAILED_FETCHES,
  cleanupDue,
  commitsInProcesses,
  fetchRetryDue,
  qualitiesToFetch,
  serverUnused,
  serversToRemove,
  type CacheRunState,
  type StoredServer,
} from './backgroundRules';
import { engineFailure, type VscodeEngine } from './engine';

/** Plan step 11H2: the time limit of a request to the engine of the VS Code part (the architecture, a list, an inspect). */
export const BACKGROUND_ENGINE_TIMEOUT_MS = 60_000;
/** Plan step 11H2: the time limit of the request of the commits to the update service. */
export const UPDATE_SERVICE_TIMEOUT_MS = 30_000;
/** Plan step 11H2: the time limit of the link script in one dev container (as the open's link). */
export const BACKGROUND_LINK_TIMEOUT_MS = 30_000;

/** Plan step 11H2: the state of the background run in the volume (CACHE_RUN_FILE of the monitor). */
export interface CacheRunStore {
  read(): Promise<CacheRunState>;
  /** Writes the fields of `change` over the stored state. */
  update(change: CacheRunState): Promise<void>;
}

/** Plan step 11H2: what the VS Code part of the run uses (vscodeBackgroundDeps of main.ts; none without a store). */
export interface VscodeBackgroundDeps {
  /** The fetch of the store (ensureServer): the store at VSCODE_STORE_DIR, the HTTPS of the proxy of the daemon, `tar`. */
  store: VscodeStoreDeps;
  /** The name of the store volume, which the dev containers mount read-only (mountsVscodeStore). */
  storeVolume: string;
  engine: VscodeEngine;
  /** The lock of a server version without a wait (storeTryLock). */
  tryLock: (name: string) => Promise<StoreLockAttempt>;
  /** The fetch of a server into the store: ensureServer of the open (the default; the tests give their own). */
  ensure?: typeof ensureServer;
}

export interface BackgroundRunDeps {
  log: (message: string) => void;
  now: () => number;
  /** Part a: one pass of the image maintenance (ImageMaintenance.pass: nothing without prefixes). */
  images: () => Promise<void>;
  /**
   * Parts b to d, made afresh for each run (its HTTPS reads the proxy of the daemon once, so a failed read or a changed
   * proxy counts only for that run); undefined when the monitor mounts no store (the run then leaves them out, logged).
   */
  vscode: () => VscodeBackgroundDeps | undefined;
  state: CacheRunStore;
}

/**
 * Plan step 11H2: what part b found, for the cleanup: the platform of the engine and the released commits by quality
 * (review round 1: and the qualities that it asked for, so that the cleanup asks only for the others).
 */
interface ServerFindings {
  platform: VscodePlatform;
  released: Map<VscodeQuality, string[]>;
  asked: Set<VscodeQuality>;
}

/** Plan step 11H2: one background run (see the module comment). */
export class BackgroundRun {
  /** The run never ends; a fetch has its own time limit (ensureServer). */
  private readonly signal = new AbortController().signal;

  constructor(private readonly deps: BackgroundRunDeps) {}

  /** Parts a to d, each on its own. Never throws. */
  async run(): Promise<void> {
    const { log } = this.deps;
    log('The background run starts.');
    await this.part('the images', () => this.deps.images());
    const vscode = this.deps.vscode();
    if (vscode === undefined) {
      log('The Session Monitor mounts no shared VS Code server store; the background run leaves the VS Code server out.');
    } else {
      let found: ServerFindings | undefined;
      await this.part('the VS Code server', async () => {
        found = await this.newestServers(vscode);
      });
      await this.part('the cleanup of the VS Code server store', () => this.cleanupWhenDue(vscode, found));
    }
    log('The background run ended.');
  }

  /** One part: a failure is one line of the log, and the run goes on. */
  private async part(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.deps.log(`The background run could not do ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Part b (and c): the newest released server of each quality of the store for the platform of the engine; a server
   * that was not ready before and is ready now is linked into the running dev containers (linkIntoContainers).
   */
  private async newestServers(vscode: VscodeBackgroundDeps): Promise<ServerFindings | undefined> {
    const { log } = this.deps;
    let architecture: string;
    try {
      architecture = await vscode.engine.architecture(AbortSignal.timeout(BACKGROUND_ENGINE_TIMEOUT_MS));
    } catch (error) {
      log(`The architecture of the engine could not be read, so no VS Code server is fetched: ${engineFailure(error, BACKGROUND_ENGINE_TIMEOUT_MS)}`);
      return undefined;
    }
    const platform = serverPlatform(architecture);
    if (platform === undefined) {
      log(`The engine's architecture ${JSON.stringify(architecture)} has no VS Code server in the shared store; none is fetched.`);
      return undefined;
    }
    const released = new Map<VscodeQuality, string[]>();
    const asked = new Set<VscodeQuality>();
    // Review round 1 of 11H2 (A-L4): the versions whose fetch by the run failed, each tried again after FETCH_RETRY_MS.
    const stored = (await this.deps.state.read()).failedFetches ?? {};
    const failed: Record<string, number> = { ...stored };
    for (const quality of qualitiesToFetch(await this.openedVersions(vscode.store.root, platform), this.deps.now())) {
      asked.add(quality);
      const commits = await this.releasedCommits(vscode, quality, platform);
      if (commits === undefined) continue;
      released.set(quality, commits);
      const server: VscodeServerRef = { commit: commits[0], quality };
      const version = serverVersionName(server, platform);
      if (await isServerReady(serverFolder(vscode.store.root, server, platform))) {
        delete failed[version];
        continue;
      }
      const failedAt = failed[version];
      if (!fetchRetryDue(failedAt, this.deps.now())) {
        log(`The newest VS Code server ${server.commit} (${quality}) is not fetched again before ${new Date(failedAt! + FETCH_RETRY_MS).toISOString()}: its last fetch by the background run failed.`);
        continue;
      }
      log(`The newest VS Code server ${server.commit} (${quality}) is not in the shared store yet.`);
      // A success needs no entry removed: a version is fetched only once its failure no longer waits, and such entries
      // are not kept (storeFailedFetches).
      if (await (vscode.ensure ?? ensureServer)(vscode.store, server, platform, this.signal)) await this.linkIntoContainers(vscode, server, platform);
      else failed[version] = this.deps.now();
    }
    await this.storeFailedFetches(stored, failed);
    return { platform, released, asked };
  }

  /** The released commits of `quality` on `platform`, newest first (serverCommits), or undefined after one line. */
  private async releasedCommits(vscode: VscodeBackgroundDeps, quality: VscodeQuality, platform: VscodePlatform): Promise<string[] | undefined> {
    try {
      return await serverCommits(vscode.store.transport, quality, platform, AbortSignal.timeout(UPDATE_SERVICE_TIMEOUT_MS));
    } catch (error) {
      this.deps.log(`The newest VS Code server (${quality}, ${platform}) could not be read from the update service: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Review round 1 of 11H2 (A-L4): keeps the failed fetches that still wait (fetchRetryDue false; the newest
   * MAX_FAILED_FETCHES), when they changed.
   */
  private async storeFailedFetches(before: Record<string, number>, after: Record<string, number>): Promise<void> {
    const now = this.deps.now();
    const waiting = Object.entries(after)
      .filter(([, at]) => !fetchRetryDue(at, now))
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_FAILED_FETCHES);
    const next = Object.fromEntries(waiting);
    if (JSON.stringify(next) !== JSON.stringify(before)) await this.deps.state.update({ failedFetches: next });
  }

  /**
   * Review round 1 of 11H2 (A-M1): the versions for `platform` that an open used (the markers of markServerOpened in
   * `used/`), with the time of their last use.
   */
  private async openedVersions(root: string, platform: VscodePlatform): Promise<Array<{ quality: VscodeQuality; at: number }>> {
    const opened: Array<{ quality: VscodeQuality; at: number }> = [];
    for (const entry of await fs.promises.readdir(path.posix.join(root, STORE_USED_FOLDER)).catch(() => [] as string[])) {
      const match = /^(stable|insider)-(linux-x64|linux-arm64)-[0-9a-f]{40}$/.exec(entry);
      if (match === null || match[2] !== platform) continue;
      const at = await serverOpenedAt(root, entry);
      if (at !== undefined) opened.push({ quality: match[1] as VscodeQuality, at });
    }
    return opened;
  }

  /**
   * Part c (D4): links `server` into each running dev container of the engine (the label of an environment) that mounts
   * the store read-only (mountsVscodeStore), as its remote user (containerMetadataUser of its label
   * devcontainer.metadata; a container whose label names none, or a user that holds a variable, is skipped), by the
   * script `vscodeServerLink`. One line of the log per container. Review round 1 of 11H2 (A-M1): the link does not
   * count as a use of the version (only an open's marker does).
   */
  private async linkIntoContainers(vscode: VscodeBackgroundDeps, server: VscodeServerRef, platform: VscodePlatform): Promise<void> {
    const { log } = this.deps;
    const name = `${server.commit} (${server.quality})`;
    let listed;
    try {
      listed = await vscode.engine.containerSummaries(LABEL_ENVIRONMENT_ID, AbortSignal.timeout(BACKGROUND_ENGINE_TIMEOUT_MS));
    } catch (error) {
      log(`The VS Code server ${name} is not linked into the running containers: they could not be listed. ${engineFailure(error, BACKGROUND_ENGINE_TIMEOUT_MS)}`);
      return;
    }
    for (const summary of listed.filter((entry) => entry.state === 'running')) {
      const label = summary.name !== '' ? summary.name : summary.id.slice(0, 12);
      try {
        const container = await vscode.engine.container(summary.id, AbortSignal.timeout(BACKGROUND_ENGINE_TIMEOUT_MS));
        if (container === undefined || container.rawState !== 'running') continue;
        if (!mountsVscodeStore(container.mountTargets, vscode.storeVolume)) {
          log(`The VS Code server ${name} is not linked into ${label}: it does not mount the shared store.`);
          continue;
        }
        const user = containerMetadataUser(container.labels);
        if (user === undefined) {
          log(`The VS Code server ${name} is not linked into ${label}: its label devcontainer.metadata names no remote user.`);
          continue;
        }
        const result = await runScript(vscode.engine, container.id, 'vscodeServerLink', [server.commit, server.quality, platform], {
          user,
          timeoutMs: BACKGROUND_LINK_TIMEOUT_MS,
        });
        const outcome = vscodeServerLinkOutcome(result);
        if (outcome.kind === 'linked') {
          log(`The VS Code server ${name} is linked into ${label} (as ${user}).`);
        } else if (outcome.kind === 'present') {
          log(`The VS Code server ${name} is in ${label} already.`);
        } else {
          log(`The VS Code server ${name} is not linked into ${label} (${outcome.kind}: ${outcome.reason}).`);
        }
      } catch (error) {
        log(`The VS Code server ${name} could not be linked into ${label}: ${engineFailure(error, BACKGROUND_LINK_TIMEOUT_MS)}`);
      }
    }
  }

  /** Part d: the cleanup of the store when it is due (cleanupDue), then its time in the state. */
  private async cleanupWhenDue(vscode: VscodeBackgroundDeps, found: ServerFindings | undefined): Promise<void> {
    const state = await this.deps.state.read();
    const now = this.deps.now();
    if (!cleanupDue(state.lastCleanupAt, now)) return;
    if (found === undefined) {
      this.deps.log('The shared VS Code server store is not cleaned up: the platform of the engine is not known.');
    } else {
      await this.removeOldServers(vscode, found);
    }
    await this.removeTemporaryFolders(vscode);
    await this.deps.state.update({ lastCleanupAt: now });
  }

  /**
   * Part d: the server versions of each quality for the platform of the engine that serversToRemove names (by the
   * released commits of part b; a quality whose commits are not known is left as it is; review round 1 of 11H2: the last
   * use by an open, and the versions that running containers run), each under its lock without a wait: busy (a download
   * of it runs) or a lock that fails leaves it to the next cleanup; with the lock, its folder and its marker are checked
   * again (a use since the list keeps it), and it is renamed into a temporary folder and removed there.
   */
  private async removeOldServers(vscode: VscodeBackgroundDeps, { platform, released, asked }: ServerFindings): Promise<void> {
    const { log } = this.deps;
    const root = vscode.store.root;
    // Review round 1 of 11H2 (A-M2): read once, and only when a version would be removed.
    let inUse: Set<string> | undefined | 'unread' = 'unread';
    for (const quality of VSCODE_QUALITIES) {
      const folder = path.posix.join(root, STORE_SERVER_FOLDER, quality, platform);
      const stored: StoredServer[] = [];
      for (const entry of await fs.promises.readdir(folder).catch(() => [] as string[])) {
        if (!/^[0-9a-f]{40}$/.test(entry)) continue;
        const stat = await fs.promises.lstat(path.posix.join(folder, entry)).catch(() => undefined);
        if (stat?.isDirectory() === true) stored.push({ commit: entry, usedAt: await serverOpenedAt(root, serverVersionName({ commit: entry, quality }, platform)) });
      }
      if (stored.length === 0) continue;
      // Review round 1 of 11H2 (A-M1): a quality that part b did not ask for (Insiders that no open used for 14 days) is
      // asked for here, once a day, so that its old versions go too.
      const commits = released.get(quality) ?? (asked.has(quality) ? undefined : await this.releasedCommits(vscode, quality, platform));
      if (commits === undefined) {
        log(`The VS Code servers (${quality}, ${platform}) of the shared store are not cleaned up: the update service did not name its releases.`);
        continue;
      }
      const candidates = serversToRemove(stored, commits, this.deps.now());
      if (candidates.length === 0) continue;
      if (inUse === 'unread') inUse = await this.serversInUse(vscode);
      // Review round 1 of 11H2 (A-M2): the processes of a container could not be read: no version is removed in this run.
      if (inUse === undefined) return;
      for (const commit of serversToRemove(stored, commits, this.deps.now(), inUse)) {
        const version = serverVersionName({ commit, quality }, platform);
        const attempt = await vscode.tryLock(version);
        if (attempt.kind === 'busy') {
          log(`The VS Code server ${commit} (${quality}) is not removed now: its lock is held (a download of it runs).`);
          continue;
        }
        if (attempt.kind === 'failed') {
          log(`The VS Code server ${commit} (${quality}) is not removed: its lock could not be taken (${attempt.detail}).`);
          continue;
        }
        try {
          const server = path.posix.join(folder, commit);
          const stat = await fs.promises.lstat(server);
          // Checked again under the lock: an open that marked the version since the list keeps it.
          if (!stat.isDirectory() || !serverUnused(await serverOpenedAt(root, version), this.deps.now())) continue;
          const temp = path.posix.join(root, STORE_TEMP_FOLDER);
          await fs.promises.mkdir(temp, { recursive: true, mode: 0o700 });
          const moved = path.posix.join(temp, `${version}-${randomBytes(6).toString('hex')}`);
          await fs.promises.rename(server, moved);
          await fs.promises.rm(moved, { recursive: true, force: true });
          log(`Removed the VS Code server ${commit} (${quality}, ${platform}) from the shared store: no open used it for 14 days, it is not among the two newest, and no running container runs it.`);
        } catch (error) {
          log(`The VS Code server ${commit} (${quality}) could not be removed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          attempt.release();
        }
      }
    }
  }

  /**
   * Review round 1 of 11H2 (A-M2): the server commits that the running (or paused) containers that mount the store run
   * (the store volume, `GET /containers/<id>/top` of each, nothing run in them; commitsInProcesses), so that the cleanup
   * never removes the server of a window that VS Code restored without an open. Undefined (after one line) when the list
   * or the processes of one of them cannot be read; a container that ended meanwhile has none.
   */
  private async serversInUse(vscode: VscodeBackgroundDeps): Promise<Set<string> | undefined> {
    const { log } = this.deps;
    let ids: string[];
    try {
      ids = await vscode.engine.containerIds({ volume: [vscode.storeVolume], status: ['running', 'paused'] }, AbortSignal.timeout(BACKGROUND_ENGINE_TIMEOUT_MS));
    } catch (error) {
      log(`No VS Code server is removed from the shared store now: the containers that mount it could not be listed. ${engineFailure(error, BACKGROUND_ENGINE_TIMEOUT_MS)}`);
      return undefined;
    }
    const inUse = new Set<string>();
    for (const id of ids) {
      try {
        const processes = await vscode.engine.processes(id, AbortSignal.timeout(BACKGROUND_ENGINE_TIMEOUT_MS));
        for (const commit of commitsInProcesses(processes ?? [])) inUse.add(commit);
      } catch (error) {
        log(`No VS Code server is removed from the shared store now: the processes of the container ${id.slice(0, 12)} could not be read. ${engineFailure(error, BACKGROUND_ENGINE_TIMEOUT_MS)}`);
        return undefined;
      }
    }
    return inUse;
  }

  /**
   * Part d (the plan's 11H2 row): the temporary folders under `tmp/` that downloads (or removals) left: those of a version
   * only while its lock can be taken at once (`flock -n`: no download of it runs); a name of no version is left alone.
   */
  private async removeTemporaryFolders(vscode: VscodeBackgroundDeps): Promise<void> {
    const { log } = this.deps;
    const temp = path.posix.join(vscode.store.root, STORE_TEMP_FOLDER);
    const byVersion = new Map<string, string[]>();
    for (const entry of await fs.promises.readdir(temp).catch(() => [] as string[])) {
      const version = temporaryFolderVersion(entry)?.version;
      if (version !== undefined) byVersion.set(version, [...(byVersion.get(version) ?? []), entry]);
    }
    for (const [version, entries] of byVersion) {
      const attempt = await vscode.tryLock(version);
      if (attempt.kind !== 'locked') {
        if (attempt.kind === 'failed') log(`The temporary folders of ${version} are not removed: its lock could not be taken (${attempt.detail}).`);
        continue;
      }
      try {
        for (const entry of entries) await fs.promises.rm(path.posix.join(temp, entry), { recursive: true, force: true });
        log(`Removed ${entries.length} leftover temporary folder(s) of the VS Code server ${version} from the shared store.`);
      } catch (error) {
        log(`The temporary folders of ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        attempt.release();
      }
    }
  }
}
