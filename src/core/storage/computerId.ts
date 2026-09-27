// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The id of this installation (`computer.id` in the global storage folder; unit 7, PR 2): 128 random bits as 32 hex
// digits. The heartbeats to the Session Monitor on a remote Docker host name their source with it, so that a shared
// engine tells the computers apart. It is no secret and not tied to the user. The windows and the local Session Monitor
// read it; the first reader creates it (`wx`: when two create it at once, both use the file that won).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isSourceId } from '../remoteMonitor/protocol';
import { errorCode, readTextFileSync, retryTransientSync } from './paths';

/** A file with invalid content is read again this often (its creator may still be writing it), then replaced. */
const INVALID_READS = 5;
const INVALID_READ_DELAY_MS = 20;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Reads `computer.id`, or creates it. Throws only when the file can neither be read nor written. */
export function readOrCreateComputerId(file: string): string {
  for (let attempt = 1; ; attempt++) {
    const text = readTextFileSync(file);
    if (text !== undefined) {
      const id = text.trim();
      if (isSourceId(id)) return id;
      if (attempt < INVALID_READS) {
        sleepSync(INVALID_READ_DELAY_MS);
        continue;
      }
      // Invalid content (for example a manual edit): a new id, written atomically.
      const replacement = newComputerId();
      const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.writeFileSync(temp, replacement, 'utf8');
      retryTransientSync(() => fs.renameSync(temp, file));
      return replacement;
    }
    const id = newComputerId();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, id, { encoding: 'utf8', flag: 'wx' });
      return id;
    } catch (error) {
      // Another process created it first: read its id.
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
}

/** A new id: 128 random bits as 32 lower-case hex digits. */
export function newComputerId(): string {
  return crypto.randomBytes(16).toString('hex');
}
