// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR C: one Docker engine as a table of answers, for the refresh over the worker's EngineDocker
// (fixtureEngine). Plan step 11I2: the ProcessRunner over refreshFixture (FixtureRunner, for the removed CLI adapter
// ContainerAdapter) is gone. Plan step 11I (PR A): so are its answers to the fake Docker CLI of the server tests (`ps`,
// `container inspect`, `volume ls`, `volume inspect`), whose last user went with OperationContext.docker; the answer of
// the branch of a container (execAnswer) stays, for the exec of fixtureEngine.
import { mapContainerState } from '../docker/dockerObjects';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../names';
import { scriptCommand } from '../worker/containerScripts';
import type { DockerEngine } from '../worker/dockerEngine';
import { unusedEngine } from '../worker/dockerEngine.testkit';
import type { EnvironmentStates, StateEnvironment } from './refreshStates';

export const ENV_API = '11111111-1111-4111-8111-111111111111';
export const ENV_WEB = '22222222-2222-4222-8222-222222222222';
export const ENV_LIB = '33333333-3333-4333-8333-333333333333';
export const ENV_OPS = '44444444-4444-4444-8444-444444444444';
export const ENV_DETACHED = '55555555-5555-4555-8555-555555555555';
export const ENV_GIT_FAILS = '66666666-6666-4666-8666-666666666666';
const ENV_UNKNOWN = '77777777-7777-4777-8777-777777777777';

function env(id: string, name: string, branch: boolean, user?: string): StateEnvironment {
  const value: StateEnvironment = { id, containerName: `devenv-${name}`, volumeName: `devenv-${name}-vol`, folder: `/workspaces/${name}`, branch };
  if (user !== undefined) value.user = user;
  return value;
}

/**
 * api: its dev container and a service of Docker Compose run, labelled volume, branch `feature/x` as `node`; web: dev
 * container stopped, a stopped service, a volume without labels (found by its name); lib: nothing; ops: runs, but its
 * branch is not asked for (another account); detached: runs, detached HEAD; git-fails: runs, Git fails. A container of an
 * environment that is not asked for is ignored.
 */
export const REFRESH_ENVIRONMENTS: StateEnvironment[] = [
  env(ENV_API, 'api', true, 'node'),
  env(ENV_WEB, 'web', true),
  env(ENV_LIB, 'lib', true),
  env(ENV_OPS, 'ops', false),
  env(ENV_DETACHED, 'detached', true),
  env(ENV_GIT_FAILS, 'git-fails', true),
];

export const EXPECTED_STATES: EnvironmentStates = {
  runtime: new Map([
    [ENV_API, { container: 'running', volume: true, servicesRunning: true }],
    [ENV_WEB, { container: 'stopped', volume: true }],
    [ENV_LIB, { container: 'missing', volume: false }],
    [ENV_OPS, { container: 'running', volume: true }],
    [ENV_DETACHED, { container: 'running', volume: true }],
    [ENV_GIT_FAILS, { container: 'running', volume: true }],
  ]),
  branches: new Map([[ENV_API, 'feature/x']]),
};

interface Container {
  id: string;
  name: string;
  status: string;
  labels: Record<string, string>;
}

const CONTAINERS: Container[] = [
  { id: 'a'.repeat(64), name: 'devenv-api', status: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ENV_API } },
  { id: 'b'.repeat(64), name: 'devenv-api-db-1', status: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ENV_API, [LABEL_COMPOSE_SERVICE]: 'db' } },
  { id: 'c'.repeat(64), name: 'devenv-web', status: 'exited', labels: { [LABEL_ENVIRONMENT_ID]: ENV_WEB } },
  { id: 'd'.repeat(64), name: 'devenv-web-db-1', status: 'exited', labels: { [LABEL_ENVIRONMENT_ID]: ENV_WEB, [LABEL_COMPOSE_SERVICE]: 'db' } },
  { id: 'e'.repeat(64), name: 'devenv-ops', status: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ENV_OPS } },
  { id: 'f'.repeat(64), name: 'devenv-detached', status: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ENV_DETACHED } },
  { id: '1'.repeat(64), name: 'devenv-git-fails', status: 'paused', labels: { [LABEL_ENVIRONMENT_ID]: ENV_GIT_FAILS } },
  { id: '2'.repeat(64), name: 'devenv-unknown', status: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ENV_UNKNOWN } },
];

const LABELLED_VOLUMES: Record<string, Record<string, string>> = {
  'devenv-api-vol': { [LABEL_ENVIRONMENT_ID]: ENV_API },
  'devenv-ops-vol': { [LABEL_ENVIRONMENT_ID]: ENV_OPS },
  'devenv-detached-vol': { [LABEL_ENVIRONMENT_ID]: ENV_DETACHED },
  'devenv-git-fails-vol': { [LABEL_ENVIRONMENT_ID]: ENV_GIT_FAILS },
};
/** A volume without the labels, created outside of the extension. */
const UNLABELLED_VOLUMES = new Set(['devenv-web-vol']);

interface FixtureAnswer {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The answer of the engine of the fixture to a process `command` as `user` in `container` (as `docker exec [-u <user>]
 * <container> <command>` answered it): the branch of a running dev container. Anything else fails (exit code 125). Plan
 * step 11I (PR B): changed expectation, the branch is read by the script `branch` of the registry with the folder as its
 * argument (before: `git -c safe.directory=* -C <folder> branch --show-current`).
 */
function execAnswer(container: string, user: string | undefined, command: readonly string[]): FixtureAnswer {
  const ok = (stdout: string): FixtureAnswer => ({ exitCode: 0, stdout, stderr: '' });
  const folder = command[4] ?? '';
  const branchRead = scriptCommand('branch', [folder]);
  if (command.length !== branchRead.length || command.some((arg, index) => arg !== branchRead[index])) {
    return { exitCode: 125, stdout: '', stderr: 'unexpected exec' };
  }
  if (container === 'devenv-api') {
    return user === 'node' && folder === '/workspaces/api' ? ok('feature/x\n') : { exitCode: 125, stdout: '', stderr: 'wrong user' };
  }
  if (container === 'devenv-detached') return ok('\n');
  if (container === 'devenv-git-fails') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' };
  return { exitCode: 125, stdout: '', stderr: `unexpected exec in ${container}` };
}

/**
 * Plan step 11C1, review round 1 (B-R1-2): the same engine as a DockerEngine port (the refresh of the worker over
 * EngineDocker); its exec answers the branch of a container (execAnswer). Records the exec calls with their options.
 */
export function fixtureEngine(): { engine: DockerEngine; execs: { container: string; user?: string; signal?: AbortSignal }[] } {
  const execs: { container: string; user?: string; signal?: AbortSignal }[] = [];
  const info = (container: Container) => ({ id: container.id, name: container.name, state: mapContainerState(container.status), rawState: container.status, labels: container.labels, image: 'img' });
  const engine: DockerEngine = {
    ...unusedEngine(),
    container: async (reference) => {
      const found = CONTAINERS.find((container) => container.name === reference || container.id === reference);
      return found === undefined ? undefined : info(found);
    },
    containers: async (label) =>
      CONTAINERS.filter((container) => {
        const [key, value] = label.split('=');
        return key in container.labels && (value === undefined || container.labels[key] === value);
      }).map(info),
    volumeNames: async (filters) => (filters.label?.includes(LABEL_ENVIRONMENT_ID) ? Object.keys(LABELLED_VOLUMES) : []),
    inspect: async (kind, reference) => {
      if (kind !== 'volume') return undefined;
      if (reference in LABELLED_VOLUMES) return { Name: reference, Labels: LABELLED_VOLUMES[reference] };
      return UNLABELLED_VOLUMES.has(reference) ? { Name: reference, Labels: {} } : undefined;
    },
    exec: async (container, command, options = {}) => {
      execs.push({ container, user: options.user, signal: options.signal });
      return { ...execAnswer(container, options.user, command), timedOut: false };
    },
  };
  return { engine, execs };
}
