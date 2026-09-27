// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What Dev Environments remembers about remote Docker hosts (unit 7), in `remote-docker.json` of the global storage
// folder: the Docker context that was current before "Use a Remote Docker Host…" (for "Use the Local Docker"), and per
// host the socket of a rootless engine there (the source of the helper's socket mount on that computer).
import { readJson, writeJsonAtomic } from './atomicJson';

export interface RemoteDockerHostRecord {
  host: string;
  /** The Docker socket of a rootless engine on that computer, for example `/run/user/1000/docker.sock`. */
  rootlessSocket?: string;
}

export interface RemoteDockerStateFile {
  /** The context that was current before the switch to a remote host. */
  previousContext?: string;
  hosts?: RemoteDockerHostRecord[];
}

export class RemoteDockerState {
  constructor(readonly file: string) {}

  async read(): Promise<RemoteDockerStateFile> {
    return normalize(await readJson<unknown>(this.file));
  }

  async previousContext(): Promise<string | undefined> {
    return (await this.read()).previousContext;
  }

  async setPreviousContext(context: string | undefined): Promise<void> {
    const state = await this.read();
    if (context === undefined) delete state.previousContext;
    else state.previousContext = context;
    await writeJsonAtomic(this.file, state);
  }

  /** The socket of the rootless engine on `host`, or undefined for a rootful engine (the default socket). */
  async rootlessSocket(host: string): Promise<string | undefined> {
    return (await this.read()).hosts?.find((record) => record.host === host)?.rootlessSocket;
  }

  /** Records (or with `undefined` forgets) the rootless socket of `host`. Writes only when it changes. */
  async setRootlessSocket(host: string, socket: string | undefined): Promise<void> {
    const state = await this.read();
    const hosts = state.hosts ?? [];
    const record = hosts.find((entry) => entry.host === host);
    if (record?.rootlessSocket === socket) return;
    if (socket === undefined) {
      if (!record) return;
      state.hosts = hosts.filter((entry) => entry !== record);
    } else if (record) {
      record.rootlessSocket = socket;
    } else {
      state.hosts = [...hosts, { host, rootlessSocket: socket }];
    }
    await writeJsonAtomic(this.file, state);
  }
}

function normalize(value: unknown): RemoteDockerStateFile {
  const result: RemoteDockerStateFile = {};
  if (typeof value !== 'object' || value === null) return result;
  const record = value as Record<string, unknown>;
  if (typeof record.previousContext === 'string' && record.previousContext !== '') result.previousContext = record.previousContext;
  if (Array.isArray(record.hosts)) {
    result.hosts = record.hosts.flatMap((entry): RemoteDockerHostRecord[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { host, rootlessSocket } = entry as Record<string, unknown>;
      if (typeof host !== 'string' || host === '') return [];
      return [typeof rootlessSocket === 'string' && rootlessSocket.startsWith('/') ? { host, rootlessSocket } : { host }];
    });
  }
  return result;
}
