// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #127 (reviewer B): mutation tests of the token removal in every running dev container (plan
// step 11I, U4, decision of 2026-10-08). Each test names the mutant of tokenRemoveFlow.ts that it kills.
import { describe, expect, it } from 'vitest';
import { LABEL_ENVIRONMENT_ID } from '../names';
import type { DockerEngine, EngineContainer, EngineExecResult } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { removeTokenFlow } from './tokenRemoveFlow';

const ENVIRONMENT_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const CONTAINER = 'devenv-acme-api-brave-noether';

function container(id: string, name: string, state: 'running' | 'stopped', created: string): EngineContainer {
  return { id: id.repeat(64), name, state, rawState: state === 'running' ? 'running' : 'exited', labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID }, image: 'img:1', created };
}

function engine(listed: EngineContainer[], exec: (container: string) => EngineExecResult): { engine: DockerEngine; execs: string[] } {
  const execs: string[] = [];
  return {
    engine: {
      ...unusedEngine(),
      containers: async (label) => (label === `${LABEL_ENVIRONMENT_ID}=${ENVIRONMENT_ID}` ? listed : []),
      exec: async (name) => (execs.push(name), exec(name)),
    },
    execs,
  };
}

const failed = (stderr: string): EngineExecResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false });
const ok: EngineExecResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };

describe('review round 1 of PR #127 (reviewer B): the message names each container that may keep the token', () => {
  // Kills T16 (tokenRemoveFlow.ts:75, `container.name === p.containerName` → `container === running[0]`): the container
  // of the request is stopped, so the first running dev container of the rule is another one; the extension's message
  // names the container of the request ("... from the container <request>: <reason>"), so the reason must name the
  // container that keeps the token, or the user is told that the stopped one does.
  it('the container of the request is stopped and the newest other running dev container keeps the token: the reason names it', async () => {
    const named = container('a', CONTAINER, 'stopped', '2026-10-08T11:00:00Z');
    const newer = container('b', 'newer', 'running', '2026-10-08T10:00:00Z');
    const older = container('c', 'older', 'running', '2026-10-08T09:00:00Z');
    const { engine: port, execs } = engine([named, older, newer], (name) => (name === newer.id ? failed('root may not') : ok));
    const error = (await removeTokenFlow({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER, engine: port, records: { get: async () => undefined } }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('In the container newer: root may not');
    // Both running ones were tried, the newest first; the stopped one of the request never.
    expect(execs).toEqual([newer.id, older.id]);
  });
});
