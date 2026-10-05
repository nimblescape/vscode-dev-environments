// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G1 ("No extra containers"): the numeric user and group IDs of a user of an image, read from the image's
// `/etc/passwd` (EngineDocker.imageUserIds) instead of `id -u` and `id -g` in a container of the image. Pure; no I/O, no
// `vscode`.
import { isNumericId } from '../git/gitSummary';

/** Plan step 11G1: the most lines of `/etc/passwd` that are read; the lines after them are not looked at. */
export const MAX_PASSWD_LINES = 65_536;

/** Plan step 11G1: the numeric IDs of a user (isNumericId, as `id -u` and `id -g` print them). */
export interface UserIds {
  uid: string;
  gid: string;
}

/** One entry of `/etc/passwd`: the name, the user ID and the primary group ID (fields 1, 3 and 4). */
interface PasswdEntry {
  name: string;
  uid: string;
  gid: string;
}

/**
 * The entries of `passwd`, at most MAX_PASSWD_LINES lines. A line that is empty, a comment (`#`), an entry of NIS
 * (`+` or `-`), or that does not have the 7 fields of an entry is left out. The IDs are taken as they are written;
 * passwdUserIds checks them.
 */
function passwdEntries(passwd: string): PasswdEntry[] {
  const entries: PasswdEntry[] = [];
  let start = 0;
  for (let line = 0; line < MAX_PASSWD_LINES && start <= passwd.length; line++) {
    const end = passwd.indexOf('\n', start);
    const text = passwd.slice(start, end === -1 ? passwd.length : end);
    start = end === -1 ? passwd.length + 1 : end + 1;
    if (text === '' || text.startsWith('#') || text.startsWith('+') || text.startsWith('-')) continue;
    const fields = text.split(':');
    if (fields.length !== 7 || fields[0] === '') continue;
    entries.push({ name: fields[0], uid: fields[2], gid: fields[3] });
  }
  return entries;
}

/**
 * Plan step 11G1: the user ID and the primary group ID of `user` in the image whose `/etc/passwd` is `passwd`, as
 * `id -u <user>` and `id -g <user>` give them: the first entry with the name `user`; else, for a user that is a decimal
 * number (isNumericId), the first entry with that user ID. Undefined for anything else: no such entry, an entry whose
 * IDs are not decimal numbers (isNumericId), or an empty user.
 *
 * A user with a colon (`user:group`) is undefined. The pipeline passes the user part only (imageRemoteUser and
 * containerUserName take the part before the colon), and `id` looks the whole text up as a name, which no entry of
 * `/etc/passwd` can have (the colon separates its fields): so `id` fails for it too.
 */
export function passwdUserIds(passwd: string, user: string): UserIds | undefined {
  if (user === '' || user.includes(':') || user.includes('\n')) return undefined;
  const entries = passwdEntries(passwd);
  const found = entries.find((entry) => entry.name === user) ?? (isNumericId(user) ? entries.find((entry) => entry.uid === user) : undefined);
  if (found === undefined || !isNumericId(found.uid) || !isNumericId(found.gid)) return undefined;
  return { uid: found.uid, gid: found.gid };
}
