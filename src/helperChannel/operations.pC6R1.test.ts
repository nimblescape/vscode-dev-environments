// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR #142 (B11): the order of the shared start of every operation (checkedOperation) as before
// the cleanup: parameters outside the schema are refused with their own text even when a secret came too, before the
// check for a secret.
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from './operations';
import type { OperationContext } from './server';
import { contextSecrets } from './operationContext.testkit';

function contextWithSecret(): { context: OperationContext; progress: string[] } {
  const progress: string[] = [];
  const context: OperationContext = { signal: new AbortController().signal, ...contextSecrets({ token: 'ghs_secretvalue' }), progress: (step) => progress.push(step), log: () => {}, output: () => {} };
  return { context, progress };
}

describe('checkedOperation: the parameters first, then the secret (review round 1 of cleanup PR #142)', () => {
  for (const name of Object.keys(OPERATIONS)) {
    it(`${name}: refused parameters with a secret are refused as parameters`, async () => {
      const invalid = name === 'probe' || name === 'sweep' ? `The ${name} operation takes no parameters.` : `The parameters of the ${name} operation are invalid.`;
      const { context, progress } = contextWithSecret();
      await expect(OPERATIONS[name]!({ unknown: 1 }, context)).rejects.toMatchObject({ name: 'OperationError', code: 'invalid', message: invalid });
      expect(progress).toEqual([]);
    });
  }
});
