// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11C2b (mutation tests, B-R2): the message and detail of deleteAdditionalVolumes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { Actions, MAX_LISTED_NAMES, Messages, listSome } from '../core/messages';
import { silentLogger } from '../core/ports';
import { VsCodePipelineUi } from './pipelineUi';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

describe('review round 2 of 11C2b (mutation tests): the additional volumes of Delete', () => {
  beforeEach(() => resetFakeVscode());
  const { window } = fakeVscode;
  const ui = () => new VsCodePipelineUi({} as never, silentLogger, () => {});
  const names = (n: number) => Array.from({ length: n }, (_, i) => `api-v${i}`);

  it('P3-P8: up to MAX_LISTED_NAMES no detail; above, a short message and every name in the detail', async () => {
    window.showWarningMessage.mockResolvedValue(Actions.keep);
    await ui().deleteAdditionalVolumes(names(MAX_LISTED_NAMES));
    expect(window.showWarningMessage).toHaveBeenLastCalledWith(Messages.deleteAdditionalVolumes(names(MAX_LISTED_NAMES).join(', ')), { modal: true }, Actions.remove, Actions.keep);
    const many = names(MAX_LISTED_NAMES + 1);
    await ui().deleteAdditionalVolumes(many);
    expect(window.showWarningMessage).toHaveBeenLastCalledWith(Messages.deleteAdditionalVolumes(listSome(many)), { modal: true, detail: many.join('\n') }, Actions.remove, Actions.keep);
    expect(listSome(many)).not.toBe(many.join(', '));
  });
});
