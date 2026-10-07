// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #115 (A-L1): a paused output (the extension's connection congested) is read again when the process
// ended, so its end is delivered at once and not after ATTACHED_DRAIN_MS.
import { describe, expect, it, vi } from 'vitest';
import { batchRunSpec } from '../core/helperChannel/batch';
import type { EngineAnswer, EngineHijackRequest, EngineRequest, EngineStream } from './engineApi';
import { dockerEngine } from './engineClient';

const SESSION = '0a1b2c3d4e5f60718293a4b5';
const ID = 'c0ffee'.repeat(10) + 'c0ff';
const SPEC = batchRunSpec({ session: SESSION, volume: 'devenv-v', image: `sha256:${'a'.repeat(64)}`, socket: '/run/docker.sock', scriptHash: 'f'.repeat(64) });

describe('the attached run with a paused output (review round 1 of PR #115, A-L1)', () => {
  it('resumes the output when the process ended, so its last output comes at once', async () => {
    let waitResolve!: (answer: EngineAnswer) => void;
    const api = (request: EngineRequest): Promise<EngineAnswer> => {
      const path = request.path.split('?')[0];
      if (path.endsWith('/wait')) return new Promise((resolve) => (waitResolve = resolve));
      if (path === '/containers/create') return Promise.resolve({ status: 201, body: JSON.stringify({ Id: ID }), truncated: false });
      return Promise.resolve({ status: 204, body: '', truncated: false });
    };
    let request!: EngineHijackRequest;
    let paused = false;
    let settle!: () => void;
    const hijack = async (given: EngineHijackRequest): Promise<EngineStream> => {
      request = given;
      const ended = new Promise<void>((resolve) => (settle = resolve));
      return {
        write: () => true,
        end: () => {},
        ended,
        destroy: () => settle(),
        // While paused, nothing arrives; the end of the output comes once it is read again.
        pause: () => void (paused = true),
        resume: () => {
          paused = false;
          request.onFrame(2, Buffer.from('why it ended\n'));
          settle();
        },
      };
    };
    const run = await dockerEngine(api, hijack).runAttached(SPEC);
    const stderr: string[] = [];
    run.process.onStderr((text) => stderr.push(text));
    run.pause();
    expect(paused).toBe(true);
    const started = Date.now();
    waitResolve({ status: 200, body: JSON.stringify({ StatusCode: 1 }), truncated: false });
    expect(await run.process.exited).toEqual({ exitCode: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stderr.join('')).toBe('why it ended\n');
    expect(paused).toBe(false);
    vi.useRealTimers();
  });
});
