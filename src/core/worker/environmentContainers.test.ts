// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (U4, decision of 2026-10-08): the one rule for the dev container of an environment (devContainerOf), and
// the running dev containers in its order (runningDevContainers), which the open, the window state, the refresh, Stop and
// the token removal share.
import { describe, expect, it } from 'vitest';
import type { ListedContainer } from '../docker/dockerObjects';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../names';
import { devContainerOf, runningDevContainers, runningServices } from './environmentContainers';

const ENVIRONMENT_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devenv-acme-api-brave-noether';

function container(id: string, overrides: Partial<ListedContainer> = {}): ListedContainer {
  return { id: id.repeat(64), name: `devenv-${id}`, state: 'running', rawState: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID }, image: 'img:1', ...overrides };
}

const stopped = { state: 'stopped', rawState: 'exited' } as const;

function service(id: string, overrides: Partial<ListedContainer> = {}): ListedContainer {
  return container(id, { labels: { [LABEL_ENVIRONMENT_ID]: ENVIRONMENT_ID, [LABEL_COMPOSE_SERVICE]: 'db' }, created: '2026-10-08T12:00:00Z', ...overrides });
}

describe('the dev container of an environment: one rule (plan step 11I, U4, decision of 2026-10-08)', () => {
  it('takes the container with the recorded name whatever its state, also while another dev container runs', () => {
    const named = container('a', { name: NAME, ...stopped, created: '2026-10-08T08:00:00Z' });
    const other = container('b', { created: '2026-10-08T10:00:00Z' });
    const lines: string[] = [];
    expect(devContainerOf([other, named], NAME, (line) => lines.push(line))).toBe(named);
    expect(lines).toEqual([]);
  });

  it('takes the newest running one when the named one is missing, and the log names it', () => {
    const older = container('a', { created: '2026-10-08T08:00:00Z' });
    const newer = container('b', { created: '2026-10-08T09:00:00Z' });
    const newestStopped = container('c', { ...stopped, created: '2026-10-08T10:00:00Z' });
    const lines: string[] = [];
    expect(devContainerOf([older, newestStopped, newer], NAME, (line) => lines.push(line))).toBe(newer);
    expect(lines).toEqual([`There is no container ${NAME}; the running container devenv-b of the environment is used.`]);
  });

  it('takes the newest one when none runs, and the log names it', () => {
    const older = container('a', { ...stopped, created: '2026-10-08T08:00:00Z' });
    const newer = container('b', { ...stopped, created: '2026-10-08T09:00:00Z' });
    const lines: string[] = [];
    expect(devContainerOf([newer, older], NAME, (line) => lines.push(line))).toBe(newer);
    expect(devContainerOf([older, newer], NAME)).toBe(newer);
    expect(lines).toEqual([`There is no container ${NAME}; the container devenv-b of the environment is used.`]);
  });

  it('takes the newest by the time of the create, never by its text; an unreadable time is the oldest', () => {
    // The engine trims the zeros of a fraction: `.5Z` sorts before `Z` as text, but is half a second later.
    const later = container('a', { ...stopped, created: '2026-10-08T09:00:00.5Z' });
    const earlier = container('b', { ...stopped, created: '2026-10-08T09:00:00Z' });
    expect(devContainerOf([earlier, later], NAME)).toBe(later);
    expect(devContainerOf([later, earlier], NAME)).toBe(later);
    expect(runningDevContainers([{ ...earlier, state: 'running' }, { ...later, state: 'running' }], NAME).map((each) => each.id)).toEqual([later.id, earlier.id]);
    const unknown = container('c', { ...stopped, created: 'not a time' });
    const missing = container('d', stopped);
    expect(devContainerOf([unknown, missing, earlier], NAME)).toBe(earlier);
  });

  it('is never a container of another service of Docker Compose, unless it has the recorded name', () => {
    const db = service('s');
    expect(devContainerOf([db], NAME)).toBeUndefined();
    expect(devContainerOf([db, container('a', stopped)], NAME)?.id).toBe('a'.repeat(64));
    const namedService = service('n', { name: NAME, ...stopped });
    expect(devContainerOf([db, namedService], NAME)).toBe(namedService);
    expect(devContainerOf([], NAME)).toBeUndefined();
  });
});

describe('the running dev containers in the order of the rule (plan step 11I, U4)', () => {
  it('the named one first when it runs, then the others newest first; never a stopped one or a service', () => {
    const named = container('n', { name: NAME, created: '2026-10-08T08:00:00Z' });
    const older = container('a', { created: '2026-10-08T09:00:00Z' });
    const newer = container('b', { created: '2026-10-08T10:00:00Z' });
    const lines: string[] = [];
    const all = [older, service('s'), container('c', stopped), newer, named];
    expect(runningDevContainers(all, NAME, (line) => lines.push(line))).toEqual([named, newer, older]);
    expect(lines).toEqual([]);
  });

  it('without the named one running: the others newest first, and the log names the first', () => {
    const named = container('n', { name: NAME, ...stopped, created: '2026-10-08T11:00:00Z' });
    const older = container('a', { created: '2026-10-08T09:00:00Z' });
    const newer = container('b', { created: '2026-10-08T10:00:00Z' });
    const lines: string[] = [];
    expect(runningDevContainers([older, named, newer], NAME, (line) => lines.push(line))).toEqual([newer, older]);
    expect(lines).toEqual([`The container ${NAME} does not run; the running container devenv-b of the environment is used.`]);
    expect(runningDevContainers([named, service('s')], NAME, (line) => lines.push(line))).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it('the running services are every other running container of the environment, so that both lists hold each running one once', () => {
    const named = container('n', { name: NAME });
    const db = service('s');
    const namedService = service('m', { name: NAME });
    const all = [named, db, service('t', stopped), container('a')];
    expect(runningServices(all, NAME)).toEqual([db]);
    expect([...runningDevContainers(all, NAME), ...runningServices(all, NAME)].map((each) => each.id).sort()).toEqual(all.filter((each) => each.state === 'running').map((each) => each.id).sort());
    // A container of a service with the recorded name is the dev container, never a service.
    expect(runningServices([namedService, db], NAME)).toEqual([db]);
    expect(runningDevContainers([namedService, db], NAME)).toEqual([namedService]);
  });
});
