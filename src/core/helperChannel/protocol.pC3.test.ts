// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR #139, B2): the one check of a GitHub token (isValidToken), which WorkspaceHelper.clone,
// EngineDocker.exec and EnvironmentService.writeGitToken use (before: three copies of the same rule). Their own tests
// (workspaceHelper.test.ts, engineDocker.test.ts, environmentService.11IBR1.test.ts) pin each use.
import { describe, expect, it } from 'vitest';
import { isValidToken } from './protocol';

describe('isValidToken (PR #139, B2)', () => {
  it('takes a token that is not empty and has no white space', () => {
    expect(isValidToken('gho_0123456789abcdef')).toBe(true);
    expect(isValidToken('x')).toBe(true);
  });

  it('refuses no token, an empty one, and one with white space anywhere', () => {
    for (const token of [undefined, '', ' ', 'gho_a b', 'gho_tab\there', 'gho_line\nbreak', 'gho_cr\r', ' gho_nbsp', ' gho_lead', 'gho_trail ']) {
      expect(isValidToken(token), JSON.stringify(token)).toBe(false);
    }
  });
});
