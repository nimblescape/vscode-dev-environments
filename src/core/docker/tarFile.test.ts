// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G1: the reader of the first entry of the tar archive of the archive endpoint of the Engine API.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { TAR_BLOCK_BYTES, firstTarFile } from './tarFile';

/** A ustar header for `name` with `size` and `typeflag`, its checksum computed (`checksum` overrides it). */
function header(name: string, size: number | string, typeflag = '0', more: { checksum?: string; prefix?: string; magic?: string } = {}): Buffer {
  const block = Buffer.alloc(TAR_BLOCK_BYTES);
  block.write(name, 0, 'utf8');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(typeof size === 'number' ? `${size.toString(8).padStart(11, '0')}\0` : size, 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.write(typeflag, 156, 'latin1');
  block.write(more.magic ?? 'ustar\u000000', 257, 'latin1');
  if (more.prefix !== undefined) block.write(more.prefix, 345, 'latin1');
  block.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(more.checksum ?? `${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function archive(name: string, data: Buffer, typeflag = '0'): Buffer {
  return Buffer.concat([header(name, data.length, typeflag), data, Buffer.alloc((TAR_BLOCK_BYTES - (data.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES), Buffer.alloc(1024)]);
}

const DATA = Buffer.from('root:x:0:0:root:/root:/bin/sh\nmüller:x:1000:1000::/home/müller:/bin/sh\n', 'utf8');
const OPTIONS = { name: 'passwd', maxBytes: 1024 };

describe('firstTarFile (plan step 11G1)', () => {
  it('gives the bytes of a regular file (typeflag 0 or NUL) with the name, also with UTF-8 in its content', () => {
    expect(firstTarFile(archive('passwd', DATA), OPTIONS)?.toString('utf8')).toBe(DATA.toString('utf8'));
    expect(firstTarFile(archive('passwd', DATA, '\0'), OPTIONS)?.equals(DATA)).toBe(true);
    // An empty file, and one of exactly the bound.
    expect(firstTarFile(archive('passwd', Buffer.alloc(0)), OPTIONS)?.length).toBe(0);
    expect(firstTarFile(archive('passwd', Buffer.alloc(1024, 0x61)), OPTIONS)?.length).toBe(1024);
    // An archive without the end blocks still holds all of the data.
    expect(firstTarFile(Buffer.concat([header('passwd', DATA.length), DATA]), OPTIONS)?.equals(DATA)).toBe(true);
    // The size with spaces around it, as some writers put it.
    const spaced = Buffer.concat([header('passwd', ` ${DATA.length.toString(8)} \0`), DATA]);
    expect(firstTarFile(spaced, OPTIONS)?.equals(DATA)).toBe(true);
  });

  it('refuses a link, a hard link, a folder, an extended header and any other type', () => {
    for (const typeflag of ['1', '2', '3', '4', '5', '6', '7', 'x', 'g', 'L', 'K']) {
      expect(firstTarFile(archive('passwd', DATA, typeflag), OPTIONS), typeflag).toBeUndefined();
    }
  });

  it('refuses another name, a name with a prefix, and a file over the bound', () => {
    expect(firstTarFile(archive('group', DATA), OPTIONS)).toBeUndefined();
    expect(firstTarFile(archive('passwd/', DATA), OPTIONS)).toBeUndefined();
    expect(firstTarFile(archive('etc/passwd', DATA), OPTIONS)).toBeUndefined();
    expect(firstTarFile(Buffer.concat([header('passwd', DATA.length, '0', { prefix: 'etc' }), DATA]), OPTIONS)).toBeUndefined();
    expect(firstTarFile(archive('passwd', Buffer.alloc(1025, 0x61)), OPTIONS)).toBeUndefined();
  });

  it('refuses a malformed archive: too short, cut data, a wrong checksum, an invalid size or checksum field', () => {
    expect(firstTarFile(Buffer.alloc(0), OPTIONS)).toBeUndefined();
    expect(firstTarFile(Buffer.alloc(511), OPTIONS)).toBeUndefined();
    // Only zeros (the end of an empty archive): no checksum.
    expect(firstTarFile(Buffer.alloc(1024), OPTIONS)).toBeUndefined();
    expect(firstTarFile(archive('passwd', DATA).subarray(0, TAR_BLOCK_BYTES + DATA.length - 1), OPTIONS)).toBeUndefined();
    expect(firstTarFile(Buffer.concat([header('passwd', DATA.length, '0', { checksum: '000001\0 ' }), DATA]), OPTIONS)).toBeUndefined();
    expect(firstTarFile(Buffer.concat([header('passwd', DATA.length, '0', { checksum: 'garbage!' }), DATA]), OPTIONS)).toBeUndefined();
    for (const size of ['0000000008\0\0', '-0000000001\0', 'abc\0\0\0\0\0\0\0\0\0', '\0\0\0\0\0\0\0\0\0\0\0\0', '\u0080\0\0\0\0\0\0\0\0\0\u0001\u0000']) {
      expect(firstTarFile(Buffer.concat([header('passwd', size), DATA, Buffer.alloc(1024)]), OPTIONS), JSON.stringify(size)).toBeUndefined();
    }
    // Text that is no archive.
    expect(firstTarFile(Buffer.from('x'.repeat(2048)), OPTIONS)).toBeUndefined();
  });

  it.skipIf(spawnSync('tar', ['--version'], { stdio: 'ignore' }).error !== undefined)('reads an archive that the tar program wrote', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-tar-'));
    try {
      fs.writeFileSync(path.join(dir, 'passwd'), DATA);
      const written = spawnSync('tar', ['--format=ustar', '-cf', '-', '-C', dir, 'passwd']);
      expect(written.status).toBe(0);
      expect(firstTarFile(written.stdout, OPTIONS)?.equals(DATA)).toBe(true);
      fs.symlinkSync('passwd', path.join(dir, 'link'));
      const link = spawnSync('tar', ['--format=ustar', '-cf', '-', '-C', dir, 'link']);
      expect(firstTarFile(link.stdout, { ...OPTIONS, name: 'link' })).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
