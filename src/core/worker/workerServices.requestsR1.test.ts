// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #105 (B, mutation probes): hostOpenRecords passes every field of the end of the open that the
// extension takes (the lifecycle containers and the Git state), and nothing else.
import { describe, expect, it } from 'vitest';
import type { HostSide } from './hostSide';
import { hostOpenRecords } from './workerServices';

describe('review round 1 of PR #105 (B): hostOpenRecords openFinished', () => {
  it('passes the lifecycle containers, the user, the folder and the Git state; not the time or the liveness', async () => {
    const sent: unknown[] = [];
    const host = { records: { openFinished: async (_id: string, finish: unknown) => (sent.push(finish), undefined) } } as unknown as HostSide;
    const gitSummary = { branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T12:00:00.000Z' };
    const finish = { lifecycleMarkRead: 'a'.repeat(12), lifecycleRanFor: 'b'.repeat(12), remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/api', gitSummary };
    await hostOpenRecords(host).openFinished('e1', { ...finish, lastUsedAt: '2030-01-01T00:00:00.000Z', liveness: { now: 0, windowStatuses: [] } });
    expect(sent).toEqual([finish]);
  });
});
