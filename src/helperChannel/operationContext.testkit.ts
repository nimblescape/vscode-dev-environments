// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11A: the secret part of a fake OperationContext for the tests of the operations (named secrets, and requests
// to the extension, which no test of an operation answers unless it says so).
import type { Secrets } from '../core/helperChannel/protocol';
import { OperationError, type OperationContext } from './server';

/** `secrets`, `hasNoSecret`, `forgetSecret` (plan step 11E3a), `maskedValues` (plan step 11E1), and an `ask` that fails with `unsupported` (or answers with `answer`). */
export function contextSecrets(
  secrets: Secrets = {},
  answer?: OperationContext['ask'],
): Pick<OperationContext, 'secrets' | 'hasNoSecret' | 'forgetSecret' | 'maskedValues' | 'ask'> {
  const values = { ...secrets };
  const masked = Object.values(values);
  return {
    secrets: values,
    hasNoSecret: () => Object.keys(values).length === 0,
    // Plan step 11E3a: forgotten, still masked.
    forgetSecret: (name) => void delete values[name],
    maskedValues: () => [...new Set([...masked, ...Object.values(values)])],
    ask:
      answer ??
      (async () => {
        throw new OperationError('unsupported', 'No extension answers requests in this test.');
      }),
  };
}
