// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker host in the sidebar (user request 2026-09-28: "an icon in the top line of the sidebar that allows us to
// connect to a remote host, and it shall be indicated that we are on a remote host in the sidebar"). While Docker is
// set to a remote host, the view's title is "<host> (remote)": the sidebar has one view, so VS Code merges its header
// with the sidebar title and shows "Dev Environments: <host> (remote)" (user screenshot 2026-09-28: the description of
// a merged view is not shown; it is set too, for a layout with more views). The context key
// devEnvironments.remoteDockerHost switches the icon of the title bar (package.json) from "Use a Remote Docker Host…"
// to the choice of the Docker host.
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { DockerTarget } from '../core/docker/dockerHost';
import type { Logger } from '../core/ports';

/** Context key of the view title bar (package.json): Docker is set to a remote host. */
export const REMOTE_DOCKER_HOST_CONTEXT_KEY = 'devEnvironments.remoteDockerHost';

export const DockerHostTexts = {
  /** The description next to the view's name (shown when VS Code does not merge the view with the sidebar title). */
  remote: (host: string) => `Remote: ${host}`,
  /** The view's title on a remote host; in the merged header "Dev Environments: <host> (remote)". */
  remoteTitle: (host: string) => `${host} (remote)`,
  /** The view's name of package.json (views.devEnvironments[0].name): the title on the local Docker. */
  localTitle: 'Dev Environments',
} as const;

/** The part of the TreeView that the indicator sets. */
export interface DescribedView {
  description?: string;
  title?: string;
}

export class DockerHostIndicator {
  private shown: { remote: boolean; description: string | undefined } | undefined;

  constructor(
    private readonly view: DescribedView,
    private readonly logger: Logger,
  ) {}

  /** Shows `target`: the host of a remote target, nothing for the local Docker (or an endpoint that is not supported). */
  update(target: DockerTarget): void {
    const remote = target.kind === 'remote';
    const description = remote ? DockerHostTexts.remote(target.host) : undefined;
    if (this.shown && this.shown.remote === remote && this.shown.description === description) return;
    this.shown = { remote, description };
    this.view.description = description;
    this.view.title = remote ? DockerHostTexts.remoteTitle(target.host) : DockerHostTexts.localTitle;
    vscode.commands.executeCommand('setContext', REMOTE_DOCKER_HOST_CONTEXT_KEY, remote).then(undefined, (error: unknown) => {
      this.logger.warn(`The context key ${REMOTE_DOCKER_HOST_CONTEXT_KEY} could not be set: ${errorMessage(error)}`);
    });
  }
}
