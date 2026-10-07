// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G3, review B (mutation testing): output that an operation reads from the engine itself
// (OperationContext.pausable) and that is paused when its operation ends is resumed then: it is never left paused
// (the end of the run drops it from the targets that a later drain resumes).
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../core/helperChannel/protocol';
import { OPERATIONS } from './operations';
import { ChannelServer, type OperationHandler, type ServerChild } from './server';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the pausable output of an operation (plan step 11G3, review B)', () => {
  it('resumes a target that is still paused when its operation ends without removing it', async () => {
    let congested = false;
    const outputs: Array<(text: string) => void> = [];
    const spawnDocker = (_args: readonly string[], onStdout: (text: string) => void): ServerChild => {
      outputs.push(onStdout);
      return { end: () => {}, kill: () => {}, exited: new Promise(() => {}) } as unknown as ServerChild;
    };
    const events: string[] = [];
    let endHolder: (() => void) | undefined;
    const holder: OperationHandler = (_params, context) => {
      // The operation never calls the function that removes it.
      context.pausable?.({ pause: () => events.push('pause'), resume: () => events.push('resume') });
      return new Promise((resolve) => (endHolder = () => resolve({})));
    };
    const server = new ChannelServer({
      write: () => true,
      spawnDocker,
      operations: { ...OPERATIONS, holder },
      exit: () => {},
      congested: () => congested,
      onDrain: () => {},
    });
    server.start();
    server.input(encodeMessage({ t: 'op', id: 1, op: 'holder', params: null }));
    server.input(encodeMessage({ t: 'op', id: 2, op: 'docker', params: { args: ['logs', 'c'] } }));
    await tick();
    expect(outputs).toHaveLength(1);
    congested = true;
    outputs[0]('lots of output');
    expect(events).toEqual(['pause']);
    // Its operation ends while the output is still paused (no drain yet).
    endHolder?.();
    for (let i = 0; i < 20 && events.length < 2; i++) await tick();
    expect(events).toEqual(['pause', 'resume']);
    server.shutdown();
  });
});
