// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR #139 (B, mutation probes): tokenRunMessage on the protocol's `redact` keeps its rule: the
// text is stderr when there is any, else stdout, trimmed, else the exit code; the token is masked in it.
import { describe, expect, it } from 'vitest';
import { tokenRunMessage } from './containerToken';

const TOKEN = 'gho_0123456789abcdefPROBE';

describe('tokenRunMessage (review round 1 of PR #139, B)', () => {
  it('takes stderr before stdout, and masks the token in it', () => {
    expect(tokenRunMessage({ exitCode: 1, timedOut: false, stdout: `out ${TOKEN}\n`, stderr: `  err ${TOKEN}\n` }, TOKEN)).toBe('err ***');
  });

  it('takes stdout when stderr is empty, and the exit code when both are', () => {
    expect(tokenRunMessage({ exitCode: 1, timedOut: false, stdout: `out ${TOKEN}\n`, stderr: '' }, TOKEN)).toBe('out ***');
    expect(tokenRunMessage({ exitCode: 3, timedOut: false, stdout: '', stderr: '' }, TOKEN)).toBe('exit code 3');
  });

  it('masks no value shorter than four characters (the protocol rule)', () => {
    expect(tokenRunMessage({ exitCode: 1, timedOut: false, stdout: '', stderr: 'abc abc' }, 'abc')).toBe('abc abc');
  });
});
