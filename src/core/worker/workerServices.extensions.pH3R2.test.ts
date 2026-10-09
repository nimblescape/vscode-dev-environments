// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Reviewer B, review round 2 of 11H3 (mutation testing): the worker's seed with the store and the monitor's volume in
// two separate temporary folders (the adopted tests give one folder for both): the files come from the store, the
// monitor's choices from its volume, and a choice keeps a newer pinned file from being seeded for an entry without a pin.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { workerExtensionCache } from './workerServices';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devenv-ext-worker-pH3R2-${name}-`));
  temps.push(dir);
  return dir;
}

describe('the seed of the worker reads the store and the monitor\'s choices from their own places (reviewer B, round 2 of 11H3)', () => {
  it('the chosen release from the volume, the files from the store', async () => {
    const store = folder('store');
    const state = folder('state');
    fs.mkdirSync(path.join(store, 'extensions', 'universal'), { recursive: true });
    for (const name of ['a.b-1.0.0', 'a.b-2.0.0', 'c.d-3.0.0']) fs.writeFileSync(path.join(store, 'extensions', 'universal', name), 'zip');
    fs.mkdirSync(path.join(state, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(state, 'extensions', 'chosen.json'), JSON.stringify({ 'a.b': 'universal/a.b-1.0.0' }));
    // A store that holds chosen.json too (where the volume is not): never read.
    fs.writeFileSync(path.join(store, 'extensions', 'chosen.json'), JSON.stringify({ 'c.d': 'universal/c.d-0.0.1' }));
    const cache = workerExtensionCache([], { store, state }, () => 1);
    expect(await cache.seedFiles([{ id: 'a.b' }, { id: 'c.d' }], 'linux-x64')).toEqual(['universal/a.b-1.0.0', 'universal/c.d-3.0.0']);
    // The record goes to the volume, not the store.
    await cache.record('a1b2c3d4e5', [{ id: 'a.b' }]);
    expect(fs.existsSync(path.join(state, 'extensions', 'wanted', 'a1b2c3d4e5.json'))).toBe(true);
    expect(fs.existsSync(path.join(store, 'extensions', 'wanted'))).toBe(false);
  });
});
