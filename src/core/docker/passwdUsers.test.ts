// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G1: the IDs of a user from the /etc/passwd of an image, as `id -u` and `id -g` give them.
import { describe, expect, it } from 'vitest';
import { MAX_PASSWD_LINES, passwdUserIds } from './passwdUsers';

const PASSWD = [
  '# The users of the image.',
  'root:x:0:0:root:/root:/bin/sh',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'vscode:x:1000:1001:VS Code,,,:/home/vscode:/bin/bash',
  'node:x:1001:1001::/home/node:/bin/sh',
  // A name that is a number of another user: `id 1001` takes the name first.
  '1001:x:2000:2000::/home/numbered:/bin/sh',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
  '',
].join('\n');

describe('passwdUserIds (plan step 11G1)', () => {
  it('gives the user ID and the primary group ID of a name (fields 3 and 4)', () => {
    expect(passwdUserIds(PASSWD, 'vscode')).toEqual({ uid: '1000', gid: '1001' });
    expect(passwdUserIds(PASSWD, 'root')).toEqual({ uid: '0', gid: '0' });
    expect(passwdUserIds(PASSWD, 'nobody')).toEqual({ uid: '65534', gid: '65534' });
  });

  it('gives the entry of a numeric user by its user ID, a name first, as `id` does', () => {
    expect(passwdUserIds(PASSWD, '1000')).toEqual({ uid: '1000', gid: '1001' });
    expect(passwdUserIds(PASSWD, '0')).toEqual({ uid: '0', gid: '0' });
    // `1001` is the name of an entry: that entry, not node (uid 1001).
    expect(passwdUserIds(PASSWD, '1001')).toEqual({ uid: '2000', gid: '2000' });
    // A number that no entry has, and one that is no decimal ID.
    expect(passwdUserIds(PASSWD, '4242')).toBeUndefined();
    expect(passwdUserIds(PASSWD, '01000')).toBeUndefined();
  });

  it('the first entry of a name counts', () => {
    expect(passwdUserIds('dup:x:1:2::/:/bin/sh\ndup:x:3:4::/:/bin/sh\n', 'dup')).toEqual({ uid: '1', gid: '2' });
    expect(passwdUserIds('a:x:7:8::/:/bin/sh\nb:x:7:9::/:/bin/sh\n', '7')).toEqual({ uid: '7', gid: '8' });
  });

  it('a missing user, an empty user, or an empty file is undefined', () => {
    expect(passwdUserIds(PASSWD, 'postgres')).toBeUndefined();
    expect(passwdUserIds(PASSWD, '')).toBeUndefined();
    expect(passwdUserIds('', 'root')).toBeUndefined();
  });

  it('a `user:group` form is undefined, never the user part or another field (documented choice)', () => {
    expect(passwdUserIds(PASSWD, 'vscode:vscode')).toBeUndefined();
    expect(passwdUserIds(PASSWD, 'vscode:1001')).toBeUndefined();
    expect(passwdUserIds(PASSWD, '1000:1000')).toBeUndefined();
    expect(passwdUserIds(PASSWD, 'vscode:x')).toBeUndefined();
    expect(passwdUserIds(PASSWD, 'vscode\nroot')).toBeUndefined();
  });

  it('leaves out comments, NIS entries, and malformed lines; an entry with IDs that are no decimal numbers is undefined', () => {
    const text = [
      '#vscode:x:1:1::/:/bin/sh',
      '+vscode:x:2:2::/:/bin/sh',
      '-vscode',
      'vscode:x:3:3',
      'vscode:x:4:4::/:/bin/sh:extra',
      ':x:5:5::/:/bin/sh',
      'vscode:x:6:6::/home/vscode:/bin/sh',
    ].join('\n');
    expect(passwdUserIds(text, 'vscode')).toEqual({ uid: '6', gid: '6' });
    expect(passwdUserIds(text, '5')).toBeUndefined();
    for (const entry of ['bad:x:-1:0::/:/bin/sh', 'bad:x:1000:abc::/:/bin/sh', 'bad:x::1000::/:/bin/sh', 'bad:x:4294967295:0::/:/bin/sh', 'bad:x:0x10:0::/:/bin/sh']) {
      expect(passwdUserIds(entry, 'bad'), entry).toBeUndefined();
    }
    // A carriage return ends the shell field, not the IDs.
    expect(passwdUserIds('win:x:10:20::/:/bin/sh\r\n', 'win')).toEqual({ uid: '10', gid: '20' });
  });

  it('reads at most MAX_PASSWD_LINES lines, and a long line does no harm', () => {
    const filler = Array.from({ length: MAX_PASSWD_LINES }, (_, i) => `user${i}:x:${10_000 + i}:100::/:/bin/sh`).join('\n');
    expect(passwdUserIds(`${filler}\nlate:x:42:42::/:/bin/sh\n`, 'late')).toBeUndefined();
    expect(passwdUserIds(`${filler}\nlate:x:42:42::/:/bin/sh\n`, `user${MAX_PASSWD_LINES - 1}`)).toEqual({ uid: String(10_000 + MAX_PASSWD_LINES - 1), gid: '100' });
    expect(passwdUserIds(`${'x'.repeat(512 * 1024)}\nvscode:x:1000:1000::/:/bin/sh\n`, 'vscode')).toEqual({ uid: '1000', gid: '1000' });
  });
});
