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
  docker: Pick<EngineDocker, 'findContainer' | 'exec'>;
  signal?: AbortSignal;
}

/**
 * The WindowStateValue of the dev container of `environmentId` that the window is attached to (`containerName`, the name
 * that it sends; see the module comment). Plan step 11I (U4, decision of 2026-10-08): one findContainer, the rule of the
 * dev container by which the open connects (devContainerOf), for all three reads: its state, whether it is current, and
 * the branch, read from it by its ID when it runs. A window reads only the container that it is attached to: when the
 * rule gives another one (the window's container is gone), the state is 'missing' as before, so that the window
 * reconnects through the open, which connects to the container of the rule. The state of the list maps the engine state
 * as containerState did (both mapContainerState of the inspect).
 */
export async function windowStateFlow(deps: WindowStateFlowDeps): Promise<WindowStateValue> {
  const found = await deps.docker.findContainer(deps.environmentId, deps.containerName);
  const container = found?.name === deps.containerName ? found : undefined;
  if (container === undefined) return { state: 'missing' };
  const value: WindowStateValue = { state: container.state };
  if (!containerIsCurrent(container.labels, true, deps.checks)) {
    // A container made while the host access checks were off, when they are on now, else one of an older version.
    value.outdated = containerIsCurrent(container.labels, true, 'off') && isUnrestrictedContainer(container.labels) ? 'hostAccess' : 'version';
  }
  if (deps.branch !== undefined && container.state === 'running') {
    const branch = await readBranch(deps.docker, container.id, deps.branch.user, deps.branch.folder, deps.signal);
    if (branch !== undefined) value.branch = branch;
  }
  return value;
}
