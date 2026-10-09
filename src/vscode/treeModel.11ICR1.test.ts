// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #127 (reviewer B): mutation tests of the sidebar texts of `servicesRunning` (plan step 11I, U4,
// decision of 2026-10-08). The other tests compare the row with the constants (StateTexts, TreeTexts), so a text that
// went back to "services of Docker Compose" passed them; these name the words that the sidebar shows.
// Kills X01 (src/core/messages.ts StateTexts.servicesRunning back to 'services running') and X02
// (src/vscode/treeModel.ts TreeTexts.servicesRunning back to 'Other services of Docker Compose run. Stop stops them.').
import { describe, expect, it } from 'vitest';
import type { Environment } from '../core/types';
import { buildTreeModel, repositoryRows, type EnvironmentRuntime, type TreeInput } from './treeModel';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');

const ENVIRONMENT: Environment = {
  id: 'e1',
  repository: 'acme-university/api',
  configPath: '.devcontainer/devcontainer.json',
  volumeName: 'devenv-e1',
  containerName: 'devenv-e1',
  createdAt: new Date(T0 - 3_600_000).toISOString(),
  lastUsedAt: new Date(T0).toISOString(),
  owner: { id: '1001', login: 'me' },
};

function rowOf(entry: EnvironmentRuntime) {
  const input: TreeInput = {
    discovery: undefined,
    settings: { owners: [], includeArchived: false, includeForks: true },
    environments: [ENVIRONMENT],
    runtime: new Map([[ENVIRONMENT.id, entry]]),
    currentEnvironmentId: null,
    otherWindowEnvironmentIds: new Set(),
    busyEnvironmentIds: new Set(),
    liveBranches: new Map(),
    signedIn: true,
    formatTime: (value) => `T(${value})`,
  };
  const row = repositoryRows(buildTreeModel(input)).find((each) => each.environment?.id === ENVIRONMENT.id);
  if (row === undefined) throw new Error('No row of the environment');
  return row;
}

describe('review round 1 of PR #127 (reviewer B): the sidebar names the other running containers of the environment', () => {
  // Kills X01 and X02: the words of the state text and of the tooltip line (another dev container may be what runs, so
  // they must not say "services of Docker Compose").
  it('a stopped dev container while another container of the environment runs: `Stopped · containers running`, and the tooltip line', () => {
    const row = rowOf({ container: 'stopped', volume: true, servicesRunning: true });
    expect(row.description).toContain('Stopped · containers running');
    expect(row.tooltip).toContain('Other containers of the environment run. Stop stops them.');
    expect(`${row.description}\n${row.tooltip}`).not.toMatch(/services of Docker Compose|services running/);
  });
});
