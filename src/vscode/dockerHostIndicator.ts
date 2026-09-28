// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker host in the sidebar (user request 2026-09-28: "it shall be indicated that we are on a remote host in the
// sidebar"; later: "the headline shall be shown also in local mode"). The view's title names the Docker host: "<host>
// (remote)", "Local Docker", or "<endpoint> (not supported)"; the sidebar has one view, so VS Code merges its header with
// the sidebar title and shows "Dev Environments: <title>" (user screenshot 2026-09-28: the description of a merged view
// is not shown; it is set too, for a layout with more views). The merged header does not show it in every window, so the
// first row of the list names the host too (treeView.ts, DockerHostRow); a click on it chooses the Docker host (user
// request 2026-09-28: "the icon can then go away", the icons of the title bar were removed).
import type { DockerTarget } from '../core/docker/dockerHost';
import type { Logger } from '../core/ports';
import type { ShownDockerHost } from './treeView';

export const DockerHostTexts = {
  /** The description next to the view's name (shown when VS Code does not merge the view with the sidebar title). */
  remote: (host: string) => `Remote: ${host}`,
  /** The view's title on a remote host; in the merged header "Dev Environments: <host> (remote)". */
  remoteTitle: (host: string) => `${host} (remote)`,
  /** The view's title on the local Docker; in the merged header "Dev Environments: Local Docker". */
  localTitle: 'Local Docker',
  /** The view's title for an endpoint that is not supported. */
  unsupportedTitle: (endpoint: string) => `${endpoint} (not supported)`,
} as const;

/** The part of the TreeView that the indicator sets. */
export interface DescribedView {
  description?: string;
  title?: string;
}

export class DockerHostIndicator {
  private shown: ShownDockerHost | undefined;

  constructor(
    private readonly view: DescribedView,
    private readonly logger: Logger,
    /** User report 2026-09-28: the first row of the list names the Docker host (treeView.ts, DockerHostRow). */
    private readonly showHostRow: (host: ShownDockerHost) => void = () => {},
  ) {}

  /** Shows `target`: the local Docker, a remote host, or an endpoint that is not supported. */
  update(target: DockerTarget): void {
    const shown: ShownDockerHost = { kind: target.kind, host: target.kind === 'local' ? '' : target.host };
    if (this.shown && this.shown.kind === shown.kind && this.shown.host === shown.host) return;
    this.shown = shown;
    this.view.description = shown.kind === 'remote' ? DockerHostTexts.remote(shown.host) : undefined;
    this.view.title =
      shown.kind === 'remote'
        ? DockerHostTexts.remoteTitle(shown.host)
        : shown.kind === 'local'
          ? DockerHostTexts.localTitle
          : DockerHostTexts.unsupportedTitle(shown.host);
    this.showHostRow(shown);
    this.logger.info(`Docker host of the sidebar: ${shown.kind === 'local' ? 'the local Docker' : shown.kind === 'remote' ? shown.host : `${shown.host} (not supported)`}.`);
  }
}
