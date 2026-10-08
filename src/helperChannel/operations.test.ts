// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR A: the probe names the engine behind the socket of the worker. Plan step 11I (PR A): the probe and the
// sweep over the port of the engine (DockerEngine), no Docker CLI of the worker.
import { describe, expect, it } from 'vitest';
import { LABEL_HELPER_CHANNEL, parseProbeValue, parseRefreshValue, parseSweepValue, parseWindowStateValue, type EngineIdentity } from '../core/helperChannel/protocol';
import { LABEL_HELPER_RUN } from '../core/names';
import { LABEL_SESSION_MONITOR } from '../core/remoteMonitor/protocol';
import { ENV_API, EXPECTED_STATES, REFRESH_ENVIRONMENTS, fixtureContainerId, fixtureEngine } from '../core/pipeline/refreshStates.testkit';
import { EngineError, type DockerEngine, type EngineFilters } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { abortError } from '../core/ports';
import { windowStateOperation } from './flowOperations';
import { MAX_PROBE_DETAIL_LENGTH, probeOperation, refreshOperation, sweepOperation } from './operations';
import { OperationError, type OperationContext } from './server';
import { contextSecrets } from './operationContext.testkit';

const IDENTITY: EngineIdentity = { id: '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11', rootDir: '/var/lib/docker' };

/**
 * Plan step 11I (PR A): the context of an operation of the probe or the sweep, with its progress and log lines (before:
 * with the calls of OperationContext.docker, which is removed).
 */
function context(secrets: Record<string, string> = {}): { context: OperationContext; progress: string[]; logs: string[]; controller: AbortController } {
  const progress: string[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const value: OperationContext = {
    signal: controller.signal,
    ...contextSecrets(secrets),
    progress: (step) => progress.push(step),
    log: (text, level = 'info') => logs.push(`${level} ${text}`),
    output: () => {},
  };
  return { context: value, progress, logs, controller };
}

/** Plan step 11I (PR A): an engine of the probe: its version and identity as given, and the requests with their signals. */
function probeEngine(answers: { version?: () => Promise<{ apiVersion: string; version: string }>; identity?: () => Promise<EngineIdentity> } = {}) {
  const requests: Array<{ request: string; signal?: AbortSignal }> = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async (signal) => (requests.push({ request: 'version', signal }), (answers.version ?? (async () => ({ apiVersion: '1.47', version: '27.1.0' })))()),
    identity: async (signal) => (requests.push({ request: 'identity', signal }), (answers.identity ?? (async () => IDENTITY))()),
  };
  return { engine, requests };
}

describe('the probe operation (plan step 5, PR A)', () => {
  // Plan step 11I (PR A): changed test (before: `docker version` and `docker info --format …` through
  // OperationContext.docker): the version and the identity of the port, each with the signal of the operation; the
  // identity as its values.
  it('names the engine identity after the server version', async () => {
    const { engine, requests } = probeEngine();
    const { context: ctx, progress } = context();
    const value = parseProbeValue(await probeOperation(() => engine)({}, ctx));
    expect(value).toEqual({ serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: IDENTITY });
    expect(requests).toEqual([
      { request: 'version', signal: ctx.signal },
      { request: 'identity', signal: ctx.signal },
    ]);
    expect(progress).toEqual(['probe']);
  });

  // Plan step 11I (PR A): changed test (before: `docker info` that failed or printed something else): an identity that
  // the port cannot read (it rejects for an answer without one, engineClient.ts); the log says why.
  it('names no engine when its identity cannot be read, and logs why', async () => {
    const { engine } = probeEngine({ identity: async () => Promise.reject(new EngineError('The engine answered /info without its ID and root folder.', 200)) });
    const { context: ctx, logs } = context();
    expect(parseProbeValue(await probeOperation(() => engine)({}, ctx))).toEqual({ serverVersion: '27.1.0', detail: 'Docker 27.1.0' });
    expect(logs).toEqual(['warn The identity of the Docker engine could not be read: The engine answered /info without its ID and root folder.']);
  });

  // Plan step 11I (PR A): changed test (before: `docker version` that failed, with its error output as the detail): the
  // reason of the port as the detail, its end within MAX_PROBE_DETAIL_LENGTH; an empty version is no version.
  it('does not ask for the engine when the version cannot be read', async () => {
    const failing = probeEngine({ version: async () => Promise.reject(new Error('connect ENOENT /var/run/docker.sock')) });
    expect(parseProbeValue(await probeOperation(() => failing.engine)({}, context().context))).toEqual({ detail: 'connect ENOENT /var/run/docker.sock' });
    expect(failing.requests.map((entry) => entry.request)).toEqual(['version']);
    const long = probeEngine({ version: async () => Promise.reject(new Error(`${'x'.repeat(MAX_PROBE_DETAIL_LENGTH)} the end`)) });
    const detail = parseProbeValue(await probeOperation(() => long.engine)({}, context().context))?.detail;
    expect(detail).toHaveLength(MAX_PROBE_DETAIL_LENGTH);
    expect(detail?.endsWith(' the end')).toBe(true);
    const empty = probeEngine({ version: async () => ({ apiVersion: '1.47', version: '' }) });
    expect(parseProbeValue(await probeOperation(() => empty.engine)({}, context().context))).toEqual({ detail: 'The Docker engine did not name its version.' });
    expect(empty.requests.map((entry) => entry.request)).toEqual(['version']);
  });

  // Plan step 11I (PR A, O1): the parameters by the schema of both sides (parseProbeParams): none, as before; an empty
  // list is refused too (before: taken by the inline check). And no secret, as every operation that takes none.
  it('refuses parameters and a secret before it asks the engine; the secret is not echoed', async () => {
    let asked = 0;
    const engineOf = () => (asked++, probeEngine().engine);
    for (const params of [{ x: 1 }, [], 'probe', 0]) {
      await expect(probeOperation(engineOf)(params, context().context)).rejects.toMatchObject({ name: 'OperationError', code: 'invalid', message: 'The probe operation takes no parameters.' });
    }
    const error = await probeOperation(engineOf)({}, context({ token: 'ghs_secretvalue' }).context).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: 'OperationError', code: 'invalid', message: 'The probe operation takes no secret.' });
    expect(String((error as Error).message)).not.toContain('ghs_secretvalue');
    expect(asked).toBe(0);
    for (const params of [null, undefined, {}]) expect(parseProbeValue(await probeOperation(engineOf)(params, context().context))).toMatchObject({ serverVersion: '27.1.0' });
  });

  it('a cancel is `cancelled`, never a detail or an engine', async () => {
    const { context: ctx, controller } = context();
    const cancelledVersion = probeEngine({ version: async () => (controller.abort(), Promise.reject(abortError())) });
    await expect(probeOperation(() => cancelledVersion.engine)({}, ctx)).rejects.toMatchObject({ name: 'OperationError', code: 'cancelled' });
    const second = context();
    const cancelledIdentity = probeEngine({ identity: async () => (second.controller.abort(), Promise.reject(abortError())) });
    await expect(probeOperation(() => cancelledIdentity.engine)({}, second.context)).rejects.toMatchObject({ name: 'OperationError', code: 'cancelled' });
  });
});

// Plan step 11I (PR A): the sweep over the port (before: `docker container prune -f` through OperationContext.docker,
// checked in server.test.ts).
describe('the sweep operation (review round 4, M1; plan step 11I, PR A)', () => {
  function sweepEngine(prune: (filters: EngineFilters) => Promise<string[]>) {
    const requests: Array<{ filters: EngineFilters; signal?: AbortSignal }> = [];
    const engine: DockerEngine = { ...unusedEngine(), pruneContainers: async (filters, signal) => (requests.push({ filters, signal }), prune(filters)) };
    return { engine, requests };
  }

  // Moved from server.test.ts ('sweep prunes only stopped channel containers older than 10 minutes', before: the arguments
  // of `docker container prune -f`): exactly the label and age of before (no wider filter), and the number removed.
  // Plan step 11I (U5, decision of 2026-10-08): renamed (before: 'prunes only the stopped channel containers older than 10
  // minutes, and answers how many it removed').
  it('prunes only the stopped helper containers older than 10 minutes, never the Session Monitor, and answers how many it removed', async () => {
    const { engine, requests } = sweepEngine(async () => ['a'.repeat(64), 'b'.repeat(64)]);
    const { context: ctx, logs } = context();
    const value = await sweepOperation(() => engine)({}, ctx);
    expect(parseSweepValue(value)).toEqual({ removed: 2 });
    // Plan step 11I (U5, decision of 2026-10-08): changed expectation, every stopped helper container (the label of the
    // helper runs, which the channels carry too; before: the label of the channels), never the Session Monitor.
    expect(requests).toEqual([{ filters: { label: [LABEL_HELPER_RUN], 'label!': [LABEL_SESSION_MONITOR], until: ['10m'] }, signal: ctx.signal }]);
    expect(LABEL_HELPER_RUN).toBe('nimblescape.devenv.helper-run');
    expect(LABEL_SESSION_MONITOR).toBe('nimblescape.devenv.session-monitor');
    expect(LABEL_HELPER_CHANNEL).toBe('nimblescape.devenv.helper-channel');
    // Plan step 11I (U5): the log line names the helper containers (before: the channel containers).
    expect(logs).toContain('info The sweep removed 2 stopped helper container(s) older than 10 minutes.');
    const none = sweepEngine(async () => []);
    expect(parseSweepValue(await sweepOperation(() => none.engine)(null, context().context))).toEqual({ removed: 0 });
  });

  it('fails with the reason of the engine; a cancel is `cancelled`', async () => {
    const busy = sweepEngine(async () => Promise.reject(new EngineError('a prune operation is already running', 409)));
    await expect(sweepOperation(() => busy.engine)({}, context().context)).rejects.toMatchObject({ name: 'OperationError', code: 'failed', message: 'a prune operation is already running' });
    const { context: ctx, controller } = context();
    const cancelled = sweepEngine(async () => (controller.abort(), Promise.reject(abortError())));
    await expect(sweepOperation(() => cancelled.engine)({}, ctx)).rejects.toMatchObject({ name: 'OperationError', code: 'cancelled' });
  });

  // Plan step 11I (PR A, O1): the parameters by the schema of both sides (parseSweepParams), and no secret.
  it('refuses parameters and a secret before it asks the engine', async () => {
    let asked = 0;
    const engineOf = () => (asked++, sweepEngine(async () => []).engine);
    for (const params of [{ all: true }, [], 'sweep']) {
      await expect(sweepOperation(engineOf)(params, context().context)).rejects.toMatchObject({ name: 'OperationError', code: 'invalid', message: 'The sweep operation takes no parameters.' });
    }
    await expect(sweepOperation(engineOf)({}, context({ token: 'ghs_secretvalue' }).context)).rejects.toMatchObject({ code: 'invalid', message: 'The sweep operation takes no secret.' });
    expect(asked).toBe(0);
  });
});

// Plan step 11C1, review round 1 (B-R1-1, B-R1-2): the operations of the window reads and of the refresh, over the port of
// the engine (EngineDocker).
describe('the operations windowState and refresh over the port of the engine (plan step 11C1)', () => {
  function engineContext(secrets: Record<string, string> = {}): { context: OperationContext; progress: string[]; controller: AbortController } {
    const progress: string[] = [];
    const controller = new AbortController();
    const value: OperationContext = {
      signal: controller.signal,
      ...contextSecrets(secrets),
      progress: (step) => progress.push(step),
      log: () => {},
      output: () => {},
    };
    return { context: value, progress, controller };
  }

  const PARAMS = { environmentId: ENV_API, containerName: 'devenv-api', checks: 'on', branch: { folder: '/workspaces/api', user: 'node' } };

  it('refresh: the states and branches of the fixture, with its progress', async () => {
    const { engine } = fixtureEngine();
    const { context: ctx, progress } = engineContext();
    const value = parseRefreshValue(await refreshOperation(() => engine)({ environments: REFRESH_ENVIRONMENTS }, ctx), { environments: REFRESH_ENVIRONMENTS });
    expect(value).toEqual(EXPECTED_STATES);
    expect(progress).toEqual(['refresh']);
  });

  it('windowState: the state and branch of the container, the signal of the operation passed to the read of the branch', async () => {
    const { engine, execs } = fixtureEngine();
    const { context: ctx } = engineContext();
    expect(parseWindowStateValue(await windowStateOperation(() => engine)(PARAMS, ctx))).toEqual({ state: 'running', outdated: 'version', branch: 'feature/x' });
    // Plan step 11I (U4, decision of 2026-10-08): changed expectation, the branch is read from the dev container of the
    // rule by its ID (before: by the name of the request).
    expect(execs).toEqual([{ container: fixtureContainerId('devenv-api'), user: 'node', signal: ctx.signal }]);
  });

  it('windowState: invalid parameters or a secret are invalid, before the engine is asked; the secret is not echoed', async () => {
    let asked = 0;
    const engineOf = () => {
      asked++;
      return fixtureEngine().engine;
    };
    for (const [params, secrets] of [
      [{ ...PARAMS, containerName: '-x' }, {}],
      [PARAMS, { token: 'ghs_secretvalue' }],
    ] as const) {
      const error = await windowStateOperation(engineOf)(params, engineContext(secrets).context).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(OperationError);
      expect(error).toMatchObject({ code: 'invalid' });
      expect(String((error as Error).message)).not.toContain('ghs_secretvalue');
    }
    expect(asked).toBe(0);
  });

  it('windowState: an engine that fails is `failed` (never a state), a cancel is `cancelled`', async () => {
    const failing = { ...fixtureEngine().engine, container: async () => Promise.reject(new Error('socket closed')), containers: async () => Promise.reject(new Error('socket closed')) };
    const { context: ctx, controller } = engineContext();
    await expect(windowStateOperation(() => failing)(PARAMS, ctx)).rejects.toMatchObject({ code: 'failed' });
    controller.abort();
    await expect(windowStateOperation(() => failing)(PARAMS, ctx)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
