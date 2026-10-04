// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11C2b (mutation tests, B-R1) (VsCodePipelineUi: the questions of Delete).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Actions, Messages, listSome } from '../core/messages';
import { silentLogger } from '../core/ports';
import { ControllerTexts } from './controllerTexts';
import { VsCodePipelineUi } from './pipelineUi';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

describe('review round 1 of 11C2b (mutation tests): the questions of Delete in VS Code', () => {
  beforeEach(() => resetFakeVscode());
  const { window } = fakeVscode;
  const ui = () => new VsCodePipelineUi({} as never, silentLogger, () => {});

  it('PU9/PU4: the warning about changes names the other window and lists many folders as listSome does', async () => {
    const folders = Array.from({ length: 30 }, (_, i) => `data/f${i}`);
    window.showWarningMessage.mockResolvedValueOnce(Actions.deleteAnyway);
    await expect(ui().confirmDelete('acme/api', { changes: { uncommittedFiles: 1, unpushedCommits: 0 }, repositoryData: folders, otherWindow: true })).resolves.toBe('delete');
    expect(window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteUnsaved('acme/api', '1 uncommitted')} ${Messages.deleteRepositoryServiceData(listSome(folders))} ${ControllerTexts.otherWindowClosesConnection('acme/api')}`,
    );
  });

  it('PU21/PU22: the additional volumes: listed with commas; a dismissed question is cancel, not Keep', async () => {
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(ui().deleteAdditionalVolumes(['api-a', 'api-b'])).resolves.toBeUndefined();
    expect(window.showWarningMessage).toHaveBeenCalledWith(Messages.deleteAdditionalVolumes('api-a, api-b'), { modal: true }, Actions.remove, Actions.keep);
    window.showWarningMessage.mockResolvedValueOnce(Actions.keep);
    await expect(ui().deleteAdditionalVolumes(['api-a'])).resolves.toBe('keep');
  });

  it('PU29: the data of the services stays open when the focus moves away', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await expect(ui().deleteServiceData(['api-db'], [])).resolves.toBeUndefined();
    expect(window.showQuickPick.mock.calls[0][1]).toMatchObject({ canPickMany: true, ignoreFocusOut: true, title: Messages.deleteServiceDataTitle });
  });
});
