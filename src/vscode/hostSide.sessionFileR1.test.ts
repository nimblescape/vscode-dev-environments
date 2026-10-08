// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR #125 review round 1 (A L-3): a session file request that the extension does not know is refused, never taken as
// the removal of the disconnect request.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import { extensionHostSide, type HostSideDeps } from './hostSide';

function host() {
  const sessionFiles = { removeDisconnectRequest: vi.fn(async () => undefined), removeReopenOf: vi.fn(async () => undefined) };
  const deps = { registry: {}, sessionFiles, windowId: 'w1', pid: 1, clock: { now: () => 0 }, isProcessAlive: () => true, logger: silentLogger };
  return { sessionFiles, host: extensionHostSide(deps as unknown as HostSideDeps) };
}

describe('the session file requests of a flow (PR #125 review round 1, A L-3)', () => {
  it('removes the disconnect request only for its own kind', async () => {
    const { sessionFiles, host: side } = host();
    await side.records.sessionFile('removeDisconnectRequest', 'e1');
    expect(sessionFiles.removeDisconnectRequest).toHaveBeenCalledWith('e1');
    for (const kind of ['removeReopen', 'writeEverything', '']) {
      await expect(side.records.sessionFile(kind as never, 'e2')).rejects.toThrow(/is not known/);
    }
    expect(sessionFiles.removeDisconnectRequest).toHaveBeenCalledTimes(1);
    expect(sessionFiles.removeReopenOf).not.toHaveBeenCalled();
  });
});
