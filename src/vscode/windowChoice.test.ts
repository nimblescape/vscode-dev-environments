// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { opensNewWindow, type WindowChoiceInput, type WindowRequest } from './windowChoice';

const input = (overrides: Partial<WindowChoiceInput> = {}): WindowChoiceInput => ({
  request: 'default',
  openInNewWindow: false,
  emptyWindow: false,
  reconnecting: false,
  ...overrides,
});

describe('opensNewWindow (unit 14, concept 6.2, 8)', () => {
  it('plain Start uses the current window by default', () => {
    expect(opensNewWindow(input())).toBe(false);
    expect(opensNewWindow(input({ emptyWindow: true }))).toBe(false);
  });

  it('plain Start opens a new window with the setting openInNewWindow, except from an empty window', () => {
    expect(opensNewWindow(input({ openInNewWindow: true }))).toBe(true);
    expect(opensNewWindow(input({ openInNewWindow: true, emptyWindow: true }))).toBe(false);
  });

  it('Start in New Window always opens a new window, also from an empty window', () => {
    for (const openInNewWindow of [false, true]) {
      for (const emptyWindow of [false, true]) {
        expect(opensNewWindow(input({ request: 'newWindow', openInNewWindow, emptyWindow }))).toBe(true);
      }
    }
  });

  it('Start in Current Window always uses the current window', () => {
    for (const openInNewWindow of [false, true]) {
      for (const emptyWindow of [false, true]) {
        expect(opensNewWindow(input({ request: 'currentWindow', openInNewWindow, emptyWindow }))).toBe(false);
      }
    }
  });

  it('a Reconnect of the environment of this window always uses this window', () => {
    const requests: WindowRequest[] = ['default', 'newWindow', 'currentWindow'];
    for (const request of requests) {
      expect(opensNewWindow(input({ request, openInNewWindow: true, reconnecting: true }))).toBe(false);
    }
  });
});
