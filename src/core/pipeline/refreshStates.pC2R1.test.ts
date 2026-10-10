// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR #138 (reviewer B, probes): readGitSummary names a failed script without an exit code (the
// engine gave none) and without output as "exit code none.", as Stop's copy did before the PR.
import { describe, expect, it } from 'vitest';
import type { ScriptExec } from '../worker/containerScripts';
import { readGitSummary } from './refreshStates';

describe('readGitSummary (PR #138, B1, review round 1)', () => {
  it('a failed script without an exit code and without output: "exit code none."', async () => {
    const docker: ScriptExec = { exec: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: false }) };
    const lines: string[] = [];
    const summary = await readGitSummary(docker, { id: 'c'.repeat(64), name: 'devenv-acme-api-brave-noether' }, 'vscode', '/workspaces/api', {
      now: () => '2026-10-10T12:00:00.000Z',
      log: (line) => lines.push(line),
      cancel: 'throw',
    });
    expect(summary).toBeUndefined();
    expect(lines).toEqual(['The Git state in devenv-acme-api-brave-noether could not be read: exit code none.']);
  });
});
