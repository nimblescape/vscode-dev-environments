// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { EnvironmentStatusBar } from './statusBar';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

describe('EnvironmentStatusBar (concept 6.3)', () => {
  beforeEach(() => resetFakeVscode());

  function create() {
    const bar = new EnvironmentStatusBar();
    const item = fakeVscode.statusBarItems[0];
    return { bar, item };
  }

  it('is one visible item on the left side, not connected at first', () => {
    const { item } = create();
    expect(fakeVscode.statusBarItems).toHaveLength(1);
    expect(item.alignment).toBe(fakeVscode.StatusBarAlignment.Left);
    expect(item.visible).toBe(true);
    expect(item.text).toBe('$(vm) Open environment…');
    expect(item.command).toBe('devEnvironments.switchEnvironment');
  });

  it('shows the connected environment and its branch; a click opens the switcher', () => {
    const { bar, item } = create();
    bar.showConnected('acme-university/api', 'main');
    expect(item.text).toBe('$(vm) acme-university/api · main');
    expect(item.command).toBe('devEnvironments.switchEnvironment');
    bar.showConnected('acme-university/api', undefined);
    expect(item.text).toBe('$(vm) acme-university/api');
  });

  it('shows Updating over the current state until the operation ends; a click shows the details', () => {
    const { bar, item } = create();
    bar.showConnected('acme-university/api', 'main');
    bar.showBusy('acme-university/web');
    expect(item.text).toBe('$(sync~spin) Updating acme-university/web…');
    expect(item.command).toBe('devEnvironments.showLog');
    bar.showConnected('acme-university/api', 'dev');
    expect(item.text).toBe('$(sync~spin) Updating acme-university/web…');
    bar.clearBusy();
    expect(item.text).toBe('$(vm) acme-university/api · dev');
  });

  it('offers Reconnect when the connection is lost; a click runs Start for the environment', () => {
    const { bar, item } = create();
    bar.showConnectionLost('acme-university/api', 'env-1');
    expect(item.text).toBe('$(warning) Reconnect acme-university/api');
    expect(item.command).toMatchObject({ command: 'devEnvironments.start', arguments: [{ environmentId: 'env-1' }] });
    expect(item.backgroundColor?.id).toBe('statusBarItem.warningBackground');
    bar.showNotConnected();
    expect(item.text).toBe('$(vm) Open environment…');
    expect(item.backgroundColor).toBeUndefined();
  });

  it('removes the item on dispose', () => {
    const { bar, item } = create();
    bar.dispose();
    expect(item.disposed).toBe(true);
  });
});
