// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteDockerState } from './remoteDockerState';

let dir: string;
let state: RemoteDockerState;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-state-'));
  state = new RemoteDockerState(path.join(dir, 'remote-docker.json'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// User decision 2026-09-28: "Don't Ask Again" for every Docker host question.
describe('RemoteDockerState: questions not to ask again', () => {
  it('remembers each question once, keeps the other fields, and forgets all of them on clear', async () => {
    await state.setPreviousContext('desktop-linux');
    expect(await state.dontAsk('switchToRemote')).toBe(false);
    await state.setDontAsk('switchToRemote');
    await state.setDontAsk('switchToRemote');
    await state.setDontAsk('switchBack');
    expect((await state.read()).dontAsk).toEqual(['switchToRemote', 'switchBack']);
    expect(await state.dontAsk('switchToLocal')).toBe(false);
    expect(await state.previousContext()).toBe('desktop-linux');
    await expect(state.clearDontAsk()).resolves.toBe(true);
    await expect(state.clearDontAsk()).resolves.toBe(false);
    expect(await state.dontAsk('switchToRemote')).toBe(false);
    expect(await state.previousContext()).toBe('desktop-linux');
  });

  it('ignores unknown or malformed entries of the file', async () => {
    fs.writeFileSync(state.file, JSON.stringify({ dontAsk: ['switchBack', 'deleteEverything', 3] }));
    expect((await state.read()).dontAsk).toEqual(['switchBack']);
    fs.writeFileSync(state.file, JSON.stringify({ dontAsk: 'switchBack' }));
    expect(await state.dontAsk('switchBack')).toBe(false);
  });
});
