// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C1 (decisions of 2026-10-03 and 2026-10-04): what an attached window reads of its dev container, as a flow
// of the worker over the port of its engine (EngineDocker): the state of the container, whether it may be used as it is
// (containerIsCurrent, as the open decides it), and the branch of its repository. It only reads. No I/O of its own, no
// `vscode`.
import type { WindowStateParams, WindowStateValue } from '../helperChannel/protocol';
import { containerIsCurrent, isUnrestrictedContainer } from '../pipeline/pipelineRules';
import { readBranch } from '../pipeline/refreshStates';
import type { EngineDocker } from './engineDocker';

export interface WindowStateFlowDeps extends WindowStateParams {
  docker: Pick<EngineDocker, 'containerState' | 'findContainer' | 'exec'>;
  signal?: AbortSignal;
}

/** The WindowStateValue of the dev container of `environmentId` (see the module comment). */
export async function windowStateFlow(deps: WindowStateFlowDeps): Promise<WindowStateValue> {
  const state = await deps.docker.containerState(deps.containerName);
  const value: WindowStateValue = { state };
  if (state === 'missing') return value;
  const container = await deps.docker.findContainer(deps.environmentId, deps.containerName);
  if (container !== undefined && !containerIsCurrent(container.labels, true, deps.checks)) {
    // A container made while the host access checks were off, when they are on now, else one of an older version.
    value.outdated = containerIsCurrent(container.labels, true, 'off') && isUnrestrictedContainer(container.labels) ? 'hostAccess' : 'version';
  }
  if (deps.branch !== undefined && state === 'running') {
    const branch = await readBranch(deps.docker, deps.containerName, deps.branch.user, deps.branch.folder, deps.signal);
    if (branch !== undefined) value.branch = branch;
  }
  return value;
}
