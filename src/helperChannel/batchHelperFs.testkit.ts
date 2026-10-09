// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Follow-up of plan step 11I (the links of the owner): the batch helper changes CONFIG_FOLDER only through a descriptor
// (openConfigFolder in ./batchHelper.ts). The tests fake its file system by paths; this adds the descriptor calls to such
// a fake: a descriptor names the path that was opened, and its stat, mode and owner calls are the fake's calls of that
// path, looked up at each call (a test that replaces `lstatSync` or `chownSync` of the fake later sees them too). So the
// records of the fakes (`chmod <path> <mode>`) stay as they were.
import type { BatchHelperDeps } from './batchHelper';

type PathCalls = {
  lstatSync: (path: string) => { isDirectory(): boolean; isSymbolicLink?: () => boolean };
  chmodSync: (path: string, mode: number) => void;
  chownSync: (path: string, uid: number, gid: number) => void;
};

/** `files` (a fake of BatchHelperDeps['fs'] by paths) with openSync, fstatSync, fchmodSync, fchownSync and closeSync. */
export function withDescriptors(files: Partial<Record<keyof BatchHelperDeps['fs'], unknown>>): BatchHelperDeps['fs'] {
  const self = files as unknown as PathCalls;
  const opened = new Map<number, string>();
  let next = 1000;
  const pathOf = (descriptor: number): string => {
    const path = opened.get(descriptor);
    if (path === undefined) throw Object.assign(new Error(`EBADF: ${descriptor}`), { code: 'EBADF' });
    return path;
  };
  return Object.assign(files, {
    openSync: (path: string) => {
      const stat = self.lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink?.() === true) throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: 'ENOTDIR' });
      opened.set(++next, path);
      return next;
    },
    fstatSync: (descriptor: number) => self.lstatSync(pathOf(descriptor)),
    fchmodSync: (descriptor: number, mode: number) => self.chmodSync(pathOf(descriptor), mode),
    fchownSync: (descriptor: number, uid: number, gid: number) => self.chownSync(pathOf(descriptor), uid, gid),
    closeSync: (descriptor: number) => {
      pathOf(descriptor);
      opened.delete(descriptor);
    },
  }) as never;
}
