// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 2 of PR #111 (mutation probes): `record forgetKeptVolumes` refuses a list in which any one name is no
// volume name, even next to valid ones (B2-19).
import { describe, expect, it } from 'vitest';
import { OP_OPEN } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import { FLOW_REQUESTS, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';

describe('the kept volumes that an open forgets (review B, round 2 of PR #111)', () => {
  it('B2-19: every name must be a volume name', async () => {
    const forgotten: string[][] = [];
    const host = { questions: {}, state: {}, records: { forgetKeptVolumes: async (names: string[]) => void forgotten.push(names) }, secrets: {} } as unknown as HostSide;
    const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_OPEN], { environmentId: 'e1', repository: 'acme/app', dockerHost: 'ssh://box' });
    const ask = (names: unknown) => handler('record', { call: 'forgetKeptVolumes', args: [names] }, new AbortController().signal);
    for (const odd of [['acme-cache', '../x'], ['acme-cache', ''], ['acme-cache', 7]]) {
      await expect(ask(odd)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(forgotten).toEqual([]);
  });
});
