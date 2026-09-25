// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { helperImageTag } from './helperImage';
import { emptyHelperState, isHelperImageTag, parseHelperState, readHelperState, updateHelperState } from './helperState';

const TAG = 'devenv-helper:0123456789ab';
const TIME = '2026-09-24T12:00:00.000Z';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  file = path.join(dir, 'helper.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isHelperImageTag', () => {
  it('accepts the tags of helperImageTag only', () => {
    expect(isHelperImageTag(helperImageTag('FROM x\n'))).toBe(true);
    expect(isHelperImageTag(TAG)).toBe(true);
    for (const tag of ['devenv-helper:latest', 'devenv-helper:0123456789AB', 'devenv-helper:0123456789a', 'mine:1', '__proto__', '']) {
      expect(isHelperImageTag(tag)).toBe(false);
    }
  });
});

describe('parseHelperState', () => {
  it('keeps valid records', () => {
    const state = {
      version: 1,
      images: {
        [TAG]: { baseImage: 'node:24-trixie-slim', baseDigest: 'sha256:abc', builtAt: TIME, checkedAt: TIME, lastUsedAt: TIME },
      },
      lastCleanupAt: TIME,
    };
    expect(parseHelperState(state)).toEqual(state);
  });

  it('keeps the marks of a build without --pull, of a check, and of the cleanup', () => {
    const state = {
      version: 1,
      images: {
        [TAG]: { builtAt: TIME, builtWithoutPull: TIME, attemptedAt: TIME, latestBaseDigest: 'sha256:def', lastUsedAt: TIME },
        'devenv-helper:0123456789ac': { foreignSince: TIME, lastUsedAt: TIME },
        'devenv-helper:0123456789ad': { removedAt: TIME },
      },
    };
    expect(parseHelperState(state)).toEqual(state);
    const invalid = { version: 1, images: { [TAG]: { builtWithoutPull: 'true', attemptedAt: 'x', foreignSince: 1, removedAt: 'soon' } } };
    expect(parseHelperState(invalid)).toEqual({ version: 1, images: { [TAG]: {} } });
  });

  it('gives an empty state for another version or a value that is not an object', () => {
    for (const value of [undefined, null, 'x', [], { version: 2, images: { [TAG]: {} } }, { images: { [TAG]: {} } }]) {
      expect(parseHelperState(value)).toEqual(emptyHelperState());
    }
  });

  it('drops invalid tags, records, and fields', () => {
    const value = JSON.parse(
      JSON.stringify({
        version: 1,
        images: {
          [TAG]: { baseImage: 7, baseDigest: '', builtAt: 'yesterday', checkedAt: TIME, lastUsedAt: null, extra: 'x' },
          'devenv-helper:0123456789ac': 'not a record',
          'mine:1': { lastUsedAt: TIME },
        },
        lastCleanupAt: 'soon',
      }).replace('"mine:1"', '"__proto__"'),
    );
    const state = parseHelperState(value);
    expect(state).toEqual({ version: 1, images: { [TAG]: { checkedAt: TIME } } });
    expect(Object.getPrototypeOf(state.images)).toBe(Object.prototype);
  });
});

describe('readHelperState / updateHelperState', () => {
  it('reads a missing or invalid file as an empty state', async () => {
    expect(await readHelperState(file)).toEqual(emptyHelperState());
    fs.writeFileSync(file, '{ not json');
    expect(await readHelperState(file)).toEqual(emptyHelperState());
  });

  it('reads the file again before it writes, so changes of another window are kept', async () => {
    await updateHelperState(file, (state) => {
      state.images[TAG] = { lastUsedAt: TIME };
    });
    // Another window writes in between.
    const other = { version: 1, images: { [TAG]: { lastUsedAt: TIME }, 'devenv-helper:0123456789ac': { lastUsedAt: TIME } } };
    fs.writeFileSync(file, JSON.stringify(other));
    const written = await updateHelperState(file, (state) => {
      state.lastCleanupAt = TIME;
    });
    expect(written).toEqual({ ...other, lastCleanupAt: TIME });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(written);
    // Atomic write: no temporary file stays.
    expect(fs.readdirSync(dir)).toEqual(['helper.json']);
  });

  it('creates the folder, and throws when the file cannot be written', async () => {
    const nested = path.join(dir, 'storage', 'helper.json');
    await updateHelperState(nested, (state) => {
      state.lastCleanupAt = TIME;
    });
    expect(JSON.parse(fs.readFileSync(nested, 'utf8'))).toEqual({ version: 1, images: {}, lastCleanupAt: TIME });

    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, '');
    await expect(updateHelperState(path.join(blocker, 'helper.json'), () => {})).rejects.toThrow();
  });
});
