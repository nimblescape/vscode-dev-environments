// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G1 ("No extra containers"): a minimal reader of the first entry of a tar archive, for the answer of
// `GET /containers/<id>/archive?path=<file>` of the Engine API (the engine archives the one file at that path, under its
// base name). Only a regular file counts; a link, a folder, an extended header (PAX or GNU), or anything malformed is
// refused, so that the caller treats the file as unknown. Pure; no I/O, no `vscode`.

/** The size of a tar header block (and of the blocks that the data is padded to). */
export const TAR_BLOCK_BYTES = 512;

/** The checks of firstTarFile. */
export interface TarFileOptions {
  /** The name that the entry must have (the base name of the archived path; the engine names the entry so). */
  name: string;
  /** The most bytes of the file; a larger one is refused. */
  maxBytes: number;
}

/** The text of a header field: up to its first NUL, as bytes read as Latin-1 (one character per byte). */
function field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('latin1');
}

/**
 * A numeric header field: octal digits, optionally led by spaces and ended by NUL or spaces. Undefined for anything
 * else, also for the base-256 form of GNU tar (a first byte with its high bit set), which no file of the bounded size
 * needs.
 */
function octal(header: Buffer, start: number, length: number): number | undefined {
  const text = header.subarray(start, start + length).toString('latin1');
  const match = /^ *([0-7]{1,12})[ \0]*$/.exec(text);
  if (match === null) return undefined;
  const value = parseInt(match[1], 8);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Plan step 11G1: the content of the first entry of the tar archive `archive` (its bytes), when that entry is a regular
 * file (typeflag `0` or NUL) with the name `options.name` and at most `options.maxBytes` bytes, and the archive holds all
 * of its data. Undefined for anything else: a link (typeflag `1` or `2`), a folder, an extended header, a header whose
 * checksum does not match, an invalid size, a name with a prefix, or an archive that ends early.
 */
export function firstTarFile(archive: Buffer, options: TarFileOptions): Buffer | undefined {
  if (archive.length < TAR_BLOCK_BYTES) return undefined;
  const header = archive.subarray(0, TAR_BLOCK_BYTES);
  // The checksum: the sum of the bytes of the header with the checksum field itself counted as spaces.
  const recorded = octal(header, 148, 8);
  if (recorded === undefined) return undefined;
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_BYTES; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (sum !== recorded) return undefined;
  const typeflag = header[156];
  if (typeflag !== 0x30 && typeflag !== 0) return undefined;
  // The name, without a ustar prefix (the engine names the entry with the base name of the path).
  const magic = header.subarray(257, 262).toString('latin1');
  if (magic === 'ustar' && field(header, 345, 155) !== '') return undefined;
  if (field(header, 0, 100) !== options.name) return undefined;
  const size = octal(header, 124, 12);
  if (size === undefined || size > options.maxBytes) return undefined;
  if (archive.length < TAR_BLOCK_BYTES + size) return undefined;
  return archive.subarray(TAR_BLOCK_BYTES, TAR_BLOCK_BYTES + size);
}
