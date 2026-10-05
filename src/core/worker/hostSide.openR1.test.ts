// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of PR #111 (mutation probes): the requests that the operation `open` may send are exactly the ones
// its pipeline needs (B1-26: an added request, such as the question of Delete or `local settings`, would pass every
// other test). Least privilege of the worker: any change here is deliberate.
import { describe, expect, it } from 'vitest';
import { OP_OPEN } from '../helperChannel/protocol';
import { FLOW_REQUESTS } from './hostSide';

describe('FLOW_REQUESTS of open (review B, round 1 of PR #111)', () => {
  it('B1-26: exactly the requests of the open', () => {
    expect([...FLOW_REQUESTS[OP_OPEN]].sort()).toEqual(
      [
        'record get',
        'record list',
        'record read',
        'record findForAccount',
        'record restore',
        'local account',
        'local viewer',
        'local windowStatuses',
        'local pendings',
        'local processAlive',
        'local unrecordedLifecycle',
        'record rememberLifecycle',
        'record forgetLifecycle',
        'record sessionFile.writePending',
        'record sessionFile.removePending',
        'record markBusy.create',
        'record markBusy.update',
        'record markBusy.rebuild',
        'record markBusy.delete',
        'record clearBusy',
        'record createMark',
        'record stepMark',
        'record ownerLogin',
        'record lifecycleMark',
        'record openFinished',
        'record createEnvironment',
        'record dropCreated',
        'record configuration',
        'record build',
        'record forgetKeptVolumes',
        'record remove',
        'record sessionFile.removeOperation',
        'record sessionFile.removeDisconnectRequest',
        'record sessionFile.removeReopenOf',
        'question confirmUntrustedRepository',
        'question configurationChanged',
        'question configurationKindChanged',
        'question filesMissing',
        'question recreateContainer',
        'question message',
        'secret token',
        'secret registry',
      ].sort(),
    );
    expect(FLOW_REQUESTS[OP_OPEN]).not.toContain('local settings');
    expect(FLOW_REQUESTS[OP_OPEN]).not.toContain('question confirmDelete');
  });
});
