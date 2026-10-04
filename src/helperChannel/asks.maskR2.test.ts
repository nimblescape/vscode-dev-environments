// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #102 (B, mutation probes): the port of the engine of an operation (ENGINE_OF in operations.ts)
// masks the output of an exec with OperationContext.maskedValues (every value the operation ever held), read at each
// call, not with the current secrets alone.
import { describe, expect, it, vi } from 'vitest';
import { OP_PULL } from '../core/helperChannel/protocol';
import type { OperationContext } from './server';

const seen = vi.hoisted(() => ({ args: [] as unknown[][] }));

vi.mock('./engineClient', async (original) => {
  const actual = await original<typeof import('./engineClient')>();
  return {
    ...actual,
    dockerEngine: (...args: unknown[]) => {
      seen.args.push(args);
      return { pull: async () => undefined };
    },
  };
});

describe('ENGINE_OF and maskedValues (review round 2 of PR #102, B)', () => {
  it('hands dockerEngine the masked values of the operation, read at each call', async () => {
    const { OPERATIONS } = await import('./operations');
    const values = ['replaced-registry-pw-1'];
    const context = {
      secrets: {},
      hasNoSecret: () => true,
      maskedValues: () => [...values],
      ask: async () => undefined,
      progress: () => {},
      log: () => {},
      output: () => {},
      signal: new AbortController().signal,
    } as unknown as OperationContext;
    await expect(OPERATIONS[OP_PULL]({ reference: 'alpine:3' }, context)).resolves.toEqual({});
    const args = seen.args.at(-1);
    expect(typeof args?.[3]).toBe('function');
    const secrets = args?.[3] as () => Iterable<string>;
    expect([...secrets()]).toEqual(['replaced-registry-pw-1']);
    values.push('later-value-123');
    expect([...secrets()]).toEqual(['replaced-registry-pw-1', 'later-value-123']);
  });
});
