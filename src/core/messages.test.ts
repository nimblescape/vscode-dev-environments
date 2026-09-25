// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { Messages } from './messages';

describe('Messages.localEnvNotPassed', () => {
  // The CLI resolves ${localEnv:NAME} in the workspace helper: HOME is /root there, not empty.
  it('does not say that every variable is empty', () => {
    const text = Messages.localEnvNotPassed('HOME, FOO');
    expect(text).toContain('HOME, FOO');
    expect(text).toContain('HOME is /root');
    expect(text).not.toMatch(/so they are empty/);
  });

  it('names the variables that get the values of the workspace helper', () => {
    const text = Messages.localEnvNotPassed('HOME, FOO', 'HOME');
    expect(text).toContain('The workspace helper sets HOME to its own values');
    expect(text).toContain('The others are empty or have their default value');
  });
});

describe('Messages.olderEnvironmentNotAssigned', () => {
  // Concept 7.5: nobody owns such an entry yet, so the text must not say "another account".
  it('does not name another account', () => {
    const text = Messages.olderEnvironmentNotAssigned('acme/api');
    expect(text).toContain('acme/api');
    expect(text).not.toMatch(/another/i);
  });
});
