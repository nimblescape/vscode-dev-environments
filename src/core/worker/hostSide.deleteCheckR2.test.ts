// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11C2b (mutation tests, B-R2): hostSideHandler, the questions of Delete and recordGitSummary.
import { describe, expect, it } from 'vitest';
import { OP_DELETE_CHECK } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import { FLOW_REQUESTS, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';

const CONFIRMATION = { changes: { uncommittedFiles: 2, unpushedCommits: 0 }, repositoryData: ['data/db'], otherWindow: false };
const SUMMARY = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T10:00:00.000Z' };

function handlerOf(confirmAnswer: unknown = 'open') {
  const calls: unknown[][] = [];
  const observed: unknown[][] = [];
  const questions = { confirmDelete: async (...args: unknown[]) => (calls.push(['confirmDelete', ...args]), confirmAnswer) };
  const records = { recordGitSummary: async (...args: unknown[]) => void calls.push(['recordGitSummary', ...args]) };
  const host = { questions, records, state: {}, secrets: {}, connect: {} } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_DELETE_CHECK], { environmentId: 'e1', onAnswer: (call, _args, value) => observed.push([call, value]) });
  const signal = new AbortController().signal;
  return {
    ask: (call: string, args: unknown[]) => handler('question', { call, args }, signal),
    record: (call: string, args: unknown[]) => handler('record', { call, args }, signal),
    calls,
    observed,
  };
}

describe('review round 2 of 11C2b (mutation tests): the questions of Delete and the Git state', () => {
  it('H8: the observer gets the answer of the user, not another one', async () => {
    const { ask, observed } = handlerOf('open');
    await ask('confirmDelete', ['acme/api', CONFIRMATION]);
    expect(observed).toEqual([['confirmDelete', 'open']]);
  });

  it('H13/H18/H23/H19/H28: refuses a long repository, null changes, bad stashes and `..` folders', async () => {
    const { ask, calls } = handlerOf();
    for (const args of [
      ['r'.repeat(257), CONFIRMATION],
      ['r', { ...CONFIRMATION, changes: null }],
      ['r', { ...CONFIRMATION, changes: { uncommittedFiles: 0, unpushedCommits: 0, stashes: -1 } }],
      ['r', { ...CONFIRMATION, changes: { uncommittedFiles: 0, unpushedCommits: 0, stashes: '3 stashed' } }],
      ['r', { ...CONFIRMATION, repositoryData: ['..'] }],
      ['r', { ...CONFIRMATION, repositoryData: ['data/..'] }],
    ]) {
      await expect(ask('confirmDelete', args), JSON.stringify(args).slice(0, 60)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(calls).toEqual([]);
    await ask('confirmDelete', ['r'.repeat(256), CONFIRMATION]);
    expect(calls).toHaveLength(1);
  });

  it('H20: passes only the counts of the changes', async () => {
    const { ask, calls } = handlerOf();
    await ask('confirmDelete', ['r', { ...CONFIRMATION, changes: { uncommittedFiles: 1, unpushedCommits: 2, stashes: 3, text: 'x' } }]);
    expect(calls).toEqual([['confirmDelete', 'r', { ...CONFIRMATION, changes: { uncommittedFiles: 1, unpushedCommits: 2, stashes: 3 } }]]);
  });

  it('H31/H32/H33/H34/H36/H35: refuses a long or not plain branch and a recordedAt that is no time or too long; records the five fields only', async () => {
    const { record, calls } = handlerOf();
    for (const summary of [
      { ...SUMMARY, branch: 'b'.repeat(256) },
      { ...SUMMARY, branch: 'a\nb' },
      { ...SUMMARY, recordedAt: 'yesterday' },
      { ...SUMMARY, recordedAt: `Oct 4 2026 (${'x'.repeat(80)})` },
    ]) {
      await expect(record('recordGitSummary', ['e1', summary]), JSON.stringify(summary).slice(0, 80)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(calls).toEqual([]);
    await record('recordGitSummary', ['e1', { ...SUMMARY, branch: 'b'.repeat(255), note: 'extra' }]);
    expect(calls).toEqual([['recordGitSummary', 'e1', { ...SUMMARY, branch: 'b'.repeat(255) }]]);
  });
});
