// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; live check 3 of the user): the user's `dev.containers.defaultExtensions` as the
// entries that an open carries: the valid ones in their canonical text, each ID once, bounded; one line for the others.
import { describe, expect, it } from 'vitest';
import { defaultExtensionEntries } from './vscodeServer';

describe('the default extensions of the window (plan step 11H3)', () => {
  it('takes the valid entries and says once that it left others out', () => {
    const lines: string[] = [];
    expect(defaultExtensionEntries(['RedHat.vscode-yaml', 'bad', 'redhat.vscode-yaml@1.0.0', 'ms-python.python@2024.2.1'], (line) => lines.push(line))).toEqual([
      'redhat.vscode-yaml',
      'ms-python.python@2024.2.1',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^2 value\(s\) of dev.containers.defaultExtensions/);
  });

  it('a setting that is not set: none, and no line', () => {
    const lines: string[] = [];
    expect(defaultExtensionEntries(undefined, (line) => lines.push(line))).toEqual([]);
    expect(lines).toEqual([]);
  });
});
