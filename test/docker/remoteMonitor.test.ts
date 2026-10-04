// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 7, PR 2: the Session Monitor container of a remote Docker host, against the real Docker engine of the runner
// (the same code path as on a remote host: RemoteSessionMonitor.ensure with the workspace helper image and the socket
// of the engine). The script is bundled from src/remoteMonitor/main.ts like dist/remoteMonitor.js. The container, its
// volume, and the test containers have names of this run; the test containers carry the label
// nimblescape.devenv.environment-id with new ids, so the monitor acts on them. The tick of the monitor is shortened
// with DEVENV_MONITOR_TICK_MS (read only by main.ts). Checked: a labeled container with a stale record is stopped; one
// whose record keeps it running is not; one with a fresh heartbeat is not; one without any record is never touched;
// ensure on a running, a stopped, and a missing container; the records and forget subcommands; an invalid heartbeat
// writes nothing. Plan step 3 (pipe loading): the container runs the pipe loader and gets the script on its input only;
// `docker restart` resumes from the stored script; a changed stored script makes the loader exit with 3, and ensure then
// replaces the container (review round 1 of PR #69, A-R1-1: with the restart policy kept); a monitor whose first load
// was cut off is replaced too. Plan step 8, PR A: a heartbeat of the window (WindowHeartbeats, also sendFor of Close and
// Keep Running); plan step 11D1: with the image settings, the image list and Delete's forget, as the worker sends them
// over the Engine API (monitorFlow), to the monitor of this run. Plan step 8,
// PR B: the restart policy `on-failure` (Q5); an automatic stop waits for the environment lock that a worker holds, and
// a monitor killed during its stop under the lock leaves no lock held (D2); the monitor exits with 0 when idle and stays
// exited until ensure starts it (Q5). Plan step 8, PR C (Q1, Q2): a window that closes records the Git state and sends
// its short release; the monitor stops the environment after the short limit,
// and keeps one whose window reloaded within the waiting time.
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { LABEL_ENVIRONMENT_ID } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { LOADER_EXIT_CODE, PIPE_LOADER, bundleHash } from '../../src/core/loader/pipeLoader';
import {
  LABEL_SESSION_MONITOR,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  heartbeatFileName,
  parseRecordsOutput,
  recordsCommand,
  remoteMonitorLabelValue,
  type RecordsOutput,
} from '../../src/core/remoteMonitor/protocol';
import { forgetRecord, sendHeartbeat, sendMonitorSettings } from '../../src/core/worker/monitorFlow';
import { engineMonitor } from '../../src/core/worker/engineMonitor';
import { cliRunArgs } from '../../src/core/remoteMonitor/cliMonitorEngine.testkit';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { RemoteSessionMonitor } from '../../src/core/remoteMonitor/remoteSessionMonitor';
import { WindowHeartbeats } from '../../src/core/session/windowHeartbeats';
import { SWITCH_RELEASE_BOUNDS, releaseEnvironment, releaseLimitSeconds } from '../../src/core/session/windowRelease';
import type { Environment } from '../../src/core/types';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { HELPER_DOCKERFILE, Timings, dockerTestContext, testStateVolume } from './harness';
import { workerLocks } from './workerLocks';

const SOURCE = crypto.randomBytes(16).toString('hex');
const OTHER_SOURCE = crypto.randomBytes(16).toString('hex');
const TICK_MS = 500;
/**
 * Plan step 8, PR C: the waiting time of the release test, and the release limit it gives (review round 1 of PR #87,
 * A-R1-1 (release margin): max(60 s, waiting time) plus RELEASE_MARGIN_SECONDS, computed by releaseLimitSeconds, not
 * hard-coded).
 */
const RELEASE_WAITING_TIME_SECONDS = 30;
const RELEASE_LIMIT_MS = releaseLimitSeconds(RELEASE_WAITING_TIME_SECONDS) * 1000;
/** The wait for the stop: the limit, then some ticks of the monitor, the stop itself, and slack for a loaded runner. */
const RELEASE_STOP_WAIT_MS = RELEASE_LIMIT_MS + 60_000;

/** Bundles the script of the remote monitor as esbuild.mjs does (minified, one file). */
async function bundleScript(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../../src/remoteMonitor/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: true,
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('the Session Monitor container of a remote Docker host', () => {
  const { run, env, cli, log } = dockerTestContext('remoteMonitor');
  const docker = new ContainerAdapter(new NodeProcessRunner(), run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const containerName = `devenv-test-monitor-${run.runId}`;
  const volumeName = `devenv-test-monitor-${run.runId}`;
  const timings = new Timings();
  let script = '';
  let helperTag = '';
  // Plan step 11D2: the ensure as the worker runs it, over the Engine API of the local engine (engineMonitor).
  const monitor = new RemoteSessionMonitor({
    engine: engineMonitor(dockerEngine(engineApi(helperDockerSocket(env, process.platform)), engineHijack(helperDockerSocket(env, process.platform)))),
    logger: log,
    script: async () => script,
    containerName,
    volumeName,
    labels: { [TEST_RUN_LABEL]: run.runId },
    containerEnv: { DEVENV_MONITOR_TICK_MS: String(TICK_MS) },
  });
  const socket = helperDockerSocket(env, process.platform, run.dockerHost);
  const ids = { stale: crypto.randomUUID(), kept: crypto.randomUUID(), fresh: crypto.randomUUID(), unrecorded: crypto.randomUUID() };
  const names = {
    stale: `devenv-test-monitor-stale-${run.runId}`,
    kept: `devenv-test-monitor-kept-${run.runId}`,
    fresh: `devenv-test-monitor-fresh-${run.runId}`,
    unrecorded: `devenv-test-monitor-unrecorded-${run.runId}`,
  };

  /** A labeled container of an environment that ends at once on SIGTERM (--init). */
  function startEnvironmentContainer(name: string, environmentId: string): void {
    cli.ok([
      'run', '-d', '--init', '--name', name,
      '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`,
      '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
  }

  /** Writes a record into the volume of the monitor as a heartbeat of long ago would have left it. */
  function writeRecord(source: string, environmentId: string, record: { at: number; keepRunning: boolean; limitSeconds: number; seq: number }): void {
    const file = `/state/heartbeats/${heartbeatFileName(source, environmentId)}`;
    cli.ok(['exec', '-i', containerName, 'sh', '-c', `mkdir -p /state/heartbeats && cat > ${file}`], JSON.stringify(record));
  }

  const running = (name: string): boolean => cli.container(name)?.State.Running === true;
  // Plan step 11D1: the commands of the monitor as the worker sends them (monitorFlow over the Engine API of the local
  // engine), to the monitor container of this run; the operations of the worker name the real one.
  const engine = dockerEngine(engineApi(helperDockerSocket(env, process.platform)), engineHijack(helperDockerSocket(env, process.platform)));
  const records = async (environmentId: string): Promise<RecordsOutput | undefined> => {
    const result = await docker.run(['exec', containerName, ...recordsCommand(environmentId)]);
    return result.exitCode === 0 ? parseRecordsOutput(result.stdout) : undefined;
  };

  beforeAll(async () => {
    script = await timings.measure('bundle the script', bundleScript);
    helperTag = await timings.measure('workspace helper image ready', () => helper.ensureImage());
  });

  afterAll(() => {
    timings.print('Timings of the remote Session Monitor:');
    log.output(`docker logs ${containerName}:\n${cli.run(['logs', containerName]).out}\n`);
    removeRunObjects(cli, run.runId);
    // The volume of the records was created by `docker run -v` without the label of the run.
    cli.run(['rm', '-f', containerName]);
    cli.run(['volume', 'rm', volumeName]);
    expect(cli.container(containerName)).toBeUndefined();
    expect(cli.volume(volumeName)).toBeUndefined();
  });

  it('creates the container: its label, the restart policy, no network, the socket, and the volume', async () => {
    expect(await timings.measure('ensure (create)', () => monitor.ensure(helperTag, socket))).toBe('created');
    const details = cli.container(containerName) as unknown as {
      State: { Running: boolean };
      Config: { Labels: Record<string, string>; Image: string; Cmd: string[]; OpenStdin: boolean };
      HostConfig: { NetworkMode: string; RestartPolicy: { Name: string }; CapDrop: string[] | null; PortBindings: unknown };
    };
    expect(details.State.Running).toBe(true);
    expect(details.Config.Image).toBe(helperTag);
    expect(details.Config.Labels[LABEL_SESSION_MONITOR]).toMatch(/^[0-9a-f]{12}$/);
    expect(details.Config.Labels[LABEL_ENVIRONMENT_ID]).toBeUndefined();
    expect(details.HostConfig.NetworkMode).toBe('none');
    // Changed expectation, plan step 8 PR B (Q5): was `unless-stopped`; the monitor exits when idle and stays exited.
    expect(details.HostConfig.RestartPolicy.Name).toBe('on-failure');
    expect(details.HostConfig.CapDrop).toEqual(['ALL']);
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: `sh -c <bootstrap> sh <script>`):
    // the command is the pipe loader with the path, the hash and the entry; the script came over stdin and is nowhere in
    // the configuration of the container.
    expect(details.Config.Cmd).toEqual(['node', '-e', PIPE_LOADER, REMOTE_MONITOR_SCRIPT_PATH, bundleHash(script), 'startMonitor']);
    expect(details.Config.OpenStdin).toBe(true);
    // Review round 1 of PR #69 (B-R1-8): changed expectation (before: script.slice(0, 200), which JSON.stringify escapes, so
    // the check could never fail): the piece as it appears in the JSON of the details.
    expect(JSON.stringify(details)).not.toContain(JSON.stringify(script).slice(1, 201));
    // The stored script is the one that was sent.
    expect(cli.run(['exec', containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH]).out.split(' ')[0]).toBe(bundleHash(script));
    await waitUntil(() => cli.run(['logs', containerName]).out.includes(REMOTE_MONITOR_READY_TEXT), 'the start of the monitor', 30_000);
    // A second ensure finds it running.
    expect(await monitor.ensure(helperTag, socket)).toBe('running');
  });

  it('stops a container with a stale record, keeps one whose record keeps it running, one with a fresh heartbeat, and one without any record', async () => {
    startEnvironmentContainer(names.unrecorded, ids.unrecorded);
    startEnvironmentContainer(names.stale, ids.stale);
    startEnvironmentContainer(names.kept, ids.kept);
    startEnvironmentContainer(names.fresh, ids.fresh);
    const longAgo = Date.now() - 30 * 60_000;
    writeRecord(SOURCE, ids.stale, { at: longAgo, keepRunning: false, limitSeconds: 60, seq: longAgo });
    writeRecord(OTHER_SOURCE, ids.kept, { at: longAgo, keepRunning: true, limitSeconds: 60, seq: longAgo });
    // Plan step 11D1: changed, the heartbeat of the worker (monitorFlow.sendHeartbeat; before: RemoteSessionMonitor.heartbeat).
    const heartbeat = await sendHeartbeat(engine, { source: SOURCE, limitSeconds: 60, environments: [{ id: ids.fresh, keepRunning: false, seq: Date.now() }] }, undefined, containerName);
    expect(heartbeat.ok).toBe(true);

    await timings.measure('stop of the stale container', () => waitUntil(() => !running(names.stale), 'the stop of the stale container'));
    // Some more ticks: the others keep running.
    await new Promise((resolve) => setTimeout(resolve, 20 * TICK_MS));
    expect(running(names.kept)).toBe(true);
    expect(running(names.fresh)).toBe(true);
    // No computer sent a heartbeat for it (for example of the host's own local Docker): never acted on.
    expect(running(names.unrecorded)).toBe(true);
    const logs = cli.run(['logs', containerName]).out;
    expect(logs).toContain(`Stopping the container ${names.stale} of ${ids.stale}: no computer sent a heartbeat for 30 minutes`);
    expect(logs).toContain(`${ids.kept} keeps running`);
    expect(logs).not.toContain(names.fresh);
    expect(logs).not.toContain(ids.unrecorded);
  });

  it('prints the records of an environment, forgets one, and writes nothing for an invalid heartbeat', async () => {
    // Plan step 11D1: changed, the records read by the test itself (RemoteSessionMonitor.records is removed: no caller).
    const recorded = await records(ids.fresh);
    expect(recorded?.records).toEqual([{ source: SOURCE, at: expect.any(Number), keepRunning: false }]);
    expect(Math.abs(recorded!.now - recorded!.records[0].at)).toBeLessThan(5 * 60_000);
    // Plan step 11C2a: Delete's `forget` is the worker's. Plan step 11D1: changed, as the worker sends it (monitorFlow).
    expect(await forgetRecord(engine, SOURCE, ids.fresh, containerName)).toEqual({ ok: true });
    expect((await records(ids.fresh))?.records).toEqual([]);

    const invalid = await docker.run(['exec', containerName, 'node', '/opt/devenv/monitor.js', 'heartbeat', '{"source":"../x"}']);
    expect(invalid.exitCode).toBe(2);
    const files = cli.run(['exec', containerName, 'ls', '-A', '/state/heartbeats']).out.split('\n').filter((name) => name !== '');
    expect(files.every((name) => /^[0-9a-f]{32}\.[0-9a-f-]{36}\.json$/.test(name))).toBe(true);
  });

  it('starts a stopped container again, and replaces one of another version', async () => {
    cli.ok(['stop', containerName]);
    expect(await monitor.ensure(helperTag, socket)).toBe('started');
    expect(running(containerName)).toBe(true);
    const before = cli.container(containerName)!.Id;
    // Another script: another label, so the container is replaced; the volume with the records stays.
    const previous = script;
    script = `${previous}\n// another version`;
    try {
      expect(await monitor.ensure(helperTag, socket)).toBe('created');
    } finally {
      script = previous;
    }
    expect(cli.container(containerName)!.Id).not.toBe(before);
    // The new container writes its script at its start; the records of the volume stay.
    let kept: RecordsOutput | undefined;
    const deadline = Date.now() + 30_000;
    while ((kept = await records(ids.kept)) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    expect(kept?.records.map((record) => record.source)).toEqual([OTHER_SOURCE]);
  });

  // Plan step 3 (pipe loading, user decisions 2026-09-29): a restart starts the stored script without new input.
  it('resumes from the stored script after docker restart', async () => {
    expect(['created', 'running']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const starts = () => cli.run(['logs', containerName]).out.split(REMOTE_MONITOR_READY_TEXT).length - 1;
    await waitUntil(() => starts() >= 1, 'the start of the monitor', 30_000);
    const before = starts();
    const id = cli.container(containerName)!.Id;
    cli.ok(['restart', containerName]);
    await timings.measure('start after docker restart', () => waitUntil(() => starts() > before, 'the start after the restart', 30_000));
    expect(running(containerName)).toBe(true);
    expect(cli.container(containerName)!.Id).toBe(id);
    expect(cli.run(['logs', containerName]).err).not.toContain('devenv loader:');
    expect(await monitor.ensure(helperTag, socket)).toBe('running');
    // It still answers the subcommands of `docker exec` from the stored script.
    expect(await records(ids.kept)).toBeDefined();
  });

  it('exits with 3 after a restart when the stored script was changed, and ensure then creates it again', async () => {
    expect(['created', 'running']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const id = cli.container(containerName)!.Id;
    cli.ok(['exec', containerName, 'sh', '-c', `echo '// changed' >> ${REMOTE_MONITOR_SCRIPT_PATH}`]);
    // Review round 1 of PR #69 (A-R1-1): changed expectation (before: `docker update --restart no` first, and a wait for
    // `restarting` or `exited` with 3): the production configuration (its restart policy) stays. The loader exits 3 at once
    // (the marker of its first start: started before without its bundle), Docker restarts it (RestartCount ≥ 1), and
    // ensure replaces it whether it finds it `restarting` or, between two restarts, `running` (the hash check). Changed
    // expectation, plan step 8 PR B (Q5): the policy is `on-failure` (was `unless-stopped`), which restarts the exit 3 too.
    cli.ok(['restart', containerName]);
    await timings.measure('exit 3 of the loader and a restart by the policy', () =>
      waitUntil(() => (cli.container(containerName)?.RestartCount ?? 0) >= 1, 'a restart by the policy', 90_000),
    );
    expect(cli.container(containerName)!.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    expect(cli.run(['logs', containerName]).err).toContain('devenv loader: started before without its bundle');
    expect(LOADER_EXIT_CODE).toBe(3);
    expect(await monitor.ensure(helperTag, socket)).toBe('created');
    const details = cli.container(containerName)!;
    expect(details.Id).not.toBe(id);
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    expect(cli.run(['exec', containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH]).out.split(' ')[0]).toBe(bundleHash(script));
  });

  // Review round 1 of PR #69 (A-R1-1): the first, attached `docker run` is cut off before it wrote the script (the window
  // reloaded, the SSH connection dropped). The loader reads the end of its input and exits 3; the restart policy starts
  // it again with an input that never ends, and the marker of the first start makes it exit 3 at once, so ensure finds
  // it restarting (or running with RestartCount ≥ 1 and no stored script) and replaces it.
  it('replaces a monitor whose first load was cut off (review round 1 of PR #69, A-R1-1)', { timeout: 240_000 }, async () => {
    cli.run(['rm', '-f', containerName]);
    const label = remoteMonitorLabelValue(script, helperTag, []);
    // Plan step 11D2: changed, the attached `docker run` of the container of runSpec, as the extension ran it before (a
    // client that a test can kill before it wrote the script).
    const client = spawn(run.dockerPath, cliRunArgs(monitor.runSpec(helperTag, socket, label, script)), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    client.stdin.on('error', () => {});
    client.stdout.resume();
    client.stderr.resume();
    const clientEnded = new Promise<void>((resolve) => client.on('close', () => resolve()));
    try {
      await waitUntil(() => running(containerName), 'the start of the interrupted monitor', 60_000);
      // Before any write: the client is killed as a closed window or a lost connection would end it.
      client.kill('SIGKILL');
      await clientEnded;
      await timings.measure('restart of the interrupted monitor by the policy', () =>
        waitUntil(() => (cli.container(containerName)?.RestartCount ?? 0) >= 1, 'a restart by the policy', 90_000),
      );
    } finally {
      if (client.exitCode === null && client.signalCode === null) client.kill('SIGKILL');
    }
    const interrupted = cli.container(containerName)!;
    // Changed expectation, plan step 8 PR B (Q5): `on-failure` (was `unless-stopped`); the loader's exit 3 is restarted.
    expect(interrupted.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    // Review round 2 of PR #69 (A-R2-5): changed expectation (before: `docker exec … test -f` not 0, which a restarting
    // container fails anyway, as Docker refuses the exec): `docker cp` reads the file system of a container in any state.
    const copied = cli.run(['cp', `${containerName}:${REMOTE_MONITOR_SCRIPT_PATH}`, '-']);
    expect(copied.code).not.toBe(0);
    expect(copied.err).toMatch(/Could not find the file/);
    expect(await monitor.ensure(helperTag, socket)).toBe('created');
    expect(cli.run(['cp', `${containerName}:${REMOTE_MONITOR_SCRIPT_PATH}`, '-']).code).toBe(0);
    const details = cli.container(containerName)!;
    expect(details.Id).not.toBe(interrupted.Id);
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    expect(cli.run(['exec', containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH]).out.split(' ')[0]).toBe(bundleHash(script));
  });
  // Plan step 8, PR A (user decisions Q1 and Q4 of 2026-10-02): the heartbeats of a window, on the local engine too. Plan
  // step 11D1: changed, they are the operation `heartbeat` of the worker of the engine (its unit tests cover the channel);
  // here WindowHeartbeats sends them as that operation does (monitorFlow over the Engine API), to the monitor of this run.
  // Before: a routed `docker exec` through a real worker, checked here for its arguments. The image settings and list go
  // on the input of their command (`docker exec -i` before, run directly by the extension).
  it('takes the heartbeats of a window, and the image settings and list, as the worker sends them (plan step 8, PR A; 11D1)', async () => {
    expect(['created', 'running', 'started']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const windowSource = crypto.randomBytes(16).toString('hex');
    const environment = {
      id: crypto.randomUUID(),
      repository: 'devenv-test/window-heartbeat',
      configPath: '.devcontainer/devcontainer.json',
      volumeName: 'unused',
      containerName: 'unused',
      owner: { id: '1', login: 'devenv-test' },
      createdAt: new Date().toISOString(),
    } as Environment;
    const warnings: string[] = [];
    const heartbeats = new WindowHeartbeats({
      owner: () => ({ windowId: 'docker-test-window', pid: process.pid }),
      connected: () => environment.id,
      registry: { list: async () => [{ ...environment }] },
      settings: () => ({ stopOnClose: true, respectShutdownActionNone: false, stopAfterMinutes: 10 }),
      sourceId: () => windowSource,
      engineFor: async () => ({ kind: 'local', host: '', endpoint: '', context: 'default' }) as never,
      send: (_engine, input, signal) => sendHeartbeat(engine, input, signal, containerName),
      repair: async () => {
        throw new Error('the monitor runs; no repair is expected');
      },
      // Review round 2 of PR #85, A-R2-1: the environment of this test has no container; the check of the engine is
      // covered by the unit tests (windowHeartbeats.test.ts).
      containerExists: async () => true,
      warn: (message) => warnings.push(message),
      logger: log,
    });
    try {
      await timings.measure('a heartbeat of the window', () => heartbeats.tick());
      expect((await records(environment.id))?.records).toEqual([{ source: windowSource, at: expect.any(Number), keepRunning: false }]);
      // Close and Keep Running: one heartbeat with the flag at once.
      environment.keepRunningOnce = true;
      expect(await heartbeats.sendFor(environment.id)).toEqual({ ok: true });
      expect((await records(environment.id))?.records).toEqual([{ source: windowSource, at: expect.any(Number), keepRunning: true }]);
      expect(warnings).toEqual([]);
    } finally {
      heartbeats.dispose();
    }
    // The image settings and the image list, on the input of their commands (the monitor stores them in its volume).
    const settings = { prefixes: ['ghcr.io/devenv-test'], schedule: '0 3 * * *', timeZone: 'UTC' };
    expect(await sendMonitorSettings(engine, { settings }, undefined, containerName)).toEqual({ ok: true });
    expect(await sendMonitorSettings(engine, { repositories: ['ghcr.io/devenv-test/app'] }, undefined, containerName)).toEqual({ ok: true });
    expect(JSON.parse(cli.run(['exec', containerName, 'cat', '/state/image-settings.json']).out)).toMatchObject(settings);
    // A monitor container that does not exist: `missing` (the window starts it again).
    expect(await sendHeartbeat(engine, { source: windowSource, limitSeconds: 60, environments: [] }, undefined, `${containerName}-none`)).toMatchObject({ ok: false, missing: true });
    // Review round 1 of 11D1 (A-R1, missing test): a stopped monitor (it exits when idle), as the engine answers it (409
    // "is not running"): `missing` too; ensure starts it again.
    cli.ok(['stop', containerName]);
    expect(await sendHeartbeat(engine, { source: windowSource, limitSeconds: 60, environments: [] }, undefined, containerName)).toMatchObject({ ok: false, missing: true });
    expect(['started', 'created']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
  });

  // Plan step 8, PR C (user decisions Q1 and Q2 of 2026-10-02): a window that closes records the Git state, sends its
  // short release (max(waitingTimeSeconds, 60 s)) through its worker, and its worker's input ends; the monitor stops the
  // environment after the short limit, not after the long one. A window that reloads within the waiting time sends its
  // long heartbeats again, so its environment keeps running.
  it('stops a closed window\'s environment after the short release, and keeps one whose window reloaded in time (plan step 8, PR C)', { timeout: RELEASE_STOP_WAIT_MS + 180_000 }, async () => {
    // Changed expectations, review round 1 of PR #87, A-R1-1 (release margin): the release limit is
    // releaseLimitSeconds(waiting time) (210 s by default) instead of 60 s; the test waits for it, and its own timeout
    // covers the setup, that wait, and the checks after it.
    expect(['created', 'running', 'started']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const closedId = crypto.randomUUID();
    const reloadedId = crypto.randomUUID();
    const closedName = `devenv-test-monitor-closed-${run.runId}`;
    const reloadedName = `devenv-test-monitor-reloaded-${run.runId}`;
    startEnvironmentContainer(closedName, closedId);
    startEnvironmentContainer(reloadedName, reloadedId);
    // Plan step 11D1: changed, the heartbeats and the release as the worker sends them (monitorFlow; before: a routed
    // `docker exec` through real workers, whose end the test awaited).
    const windowSource = crypto.randomBytes(16).toString('hex');
    const environmentOf = (id: string, name: string): Environment =>
      ({
        id,
        repository: `devenv-test/${name}`,
        configPath: '.devcontainer/devcontainer.json',
        volumeName: 'unused',
        containerName: name,
        owner: { id: '1', login: 'devenv-test' },
        createdAt: new Date().toISOString(),
      }) as Environment;
    const environments = [environmentOf(closedId, closedName), environmentOf(reloadedId, reloadedName)];
    const settings = { stopOnClose: true, respectShutdownActionNone: false, stopAfterMinutes: 10, waitingTimeSeconds: RELEASE_WAITING_TIME_SECONDS };
    const windowOf = (connected: string): WindowHeartbeats =>
      new WindowHeartbeats({
        owner: () => ({ windowId: `docker-test-${connected}`, pid: process.pid }),
        connected: () => connected,
        registry: { list: async () => environments.map((item) => ({ ...item })) },
        settings: () => settings,
        sourceId: () => windowSource,
        engineFor: async () => ({ kind: 'local', host: '', endpoint: '', context: 'default' }) as never,
        send: (_engine, input, signal) => sendHeartbeat(engine, input, signal, containerName),
        repair: async () => {
          throw new Error('the monitor runs; no repair is expected');
        },
        containerExists: async () => true,
        warn: (message) => log.warn(message),
        logger: log,
      });
    const events: string[] = [];
    const release = (heartbeats: WindowHeartbeats, id: string) =>
      releaseEnvironment(
        {
          registry: { list: async () => environments.map((item) => ({ ...item })) },
          settings: () => settings,
          otherWindowUses: async () => false,
          recordGitState: async (environment) => {
            events.push(`git ${environment.id}`);
          },
          send: async (environmentId, limitSeconds, signal) => {
            events.push(`release ${environmentId}`);
            return heartbeats.release(environmentId, limitSeconds, signal);
          },
          logger: log,
        },
        id,
        SWITCH_RELEASE_BOUNDS,
      );
    const closedWindow = windowOf(closedId);
    const reloadingWindow = windowOf(reloadedId);
    try {
      // Both windows use their environments: the long limit.
      await closedWindow.tick();
      await reloadingWindow.tick();
      // Both close: the Git state, then the release, each; their heartbeats end.
      // Taken before the release is sent: the monitor writes the record (its `at`) after this time.
      const releaseSentAt = Date.now();
      expect(await release(closedWindow, closedId)).toBe('released');
      expect(await release(reloadingWindow, reloadedId)).toBe('released');
      expect(events).toEqual([`git ${closedId}`, `release ${closedId}`, `git ${reloadedId}`, `release ${reloadedId}`]);
      closedWindow.dispose();
      reloadingWindow.dispose();
      // The reload: a new window of the same computer within the waiting time sends the long limit again.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const reloadedWindow = windowOf(reloadedId);
      await reloadedWindow.tick();
      reloadedWindow.dispose();
      // Not before the release limit (review round 1 of PR #87, A-R1-1: with the release margin), and long before the long
      // one (stopAfterMinutes: 10).
      await timings.measure('stop after the release', () => waitUntil(() => !running(closedName), 'the stop after the release', RELEASE_STOP_WAIT_MS));
      expect(Date.now() - releaseSentAt).toBeGreaterThanOrEqual(RELEASE_LIMIT_MS - 1_000);
      expect(RELEASE_LIMIT_MS).toBeLessThan(settings.stopAfterMinutes * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 20 * TICK_MS));
      expect(running(reloadedName)).toBe(true);
      const logs = cli.run(['logs', containerName]).out;
      expect(logs).toContain(`Stopping the container ${closedName} of ${closedId}`);
      expect(logs).not.toContain(`Stopping the container ${reloadedName}`);
    } finally {
      closedWindow.dispose();
      reloadingWindow.dispose();
      cli.run(['rm', '-f', closedName, reloadedName]);
    }
  });

  // Plan step 11D3 (option B of 2026-10-03): the monitor runs from a second tag of the pinned helper image, and its create
  // checks the image ID before the start. A tag of this run, so that the monitor tag of a real installation stays.
  it('runs from a tag of the pinned image, and a create from another image is removed before its start (plan step 11D3)', async () => {
    const imageId = cli.ok(['image', 'inspect', '-f', '{{.Id}}', helperTag]);
    const tag = `devenv-test-monitor-${run.runId}:0123456789ab`.toLowerCase();
    try {
      await engine.tagImage(imageId, tag);
      expect(cli.ok(['image', 'inspect', '-f', '{{.Id}}', tag])).toBe(imageId);
      cli.ok(['rm', '-f', containerName]);
      expect(await monitor.ensure(helperTag, socket, undefined, tag, imageId)).toBe('created');
      const details = cli.container(containerName) as unknown as { Image: string; Config: { Image: string; Labels: Record<string, string> }; State: { Running: boolean } };
      expect(details.Config.Image).toBe(tag);
      expect(details.Image).toBe(imageId);
      expect(details.State.Running).toBe(true);
      // The label still names the helper tag: an ensure by the image ID finds it running.
      expect(await monitor.ensure(helperTag, socket, undefined, imageId)).toBe('running');

      // The tag moved to another image (another window between its tag and this create): the create fails and leaves nothing.
      cli.ok(['rm', '-f', containerName]);
      const otherId = cli.ok(['image', 'inspect', '-f', '{{.Id}}', TEST_BASE_IMAGE]);
      await engine.tagImage(otherId, tag);
      await expect(monitor.ensureOrThrow(helperTag, socket, undefined, tag, imageId)).rejects.toThrow(`not from ${imageId}`);
      expect(cli.container(containerName)).toBeUndefined();
    } finally {
      cli.run(['image', 'rm', tag]);
      expect(await monitor.ensure(helperTag, socket)).not.toBe('failed');
    }
  });
});

// Plan step 8, PR B (user decisions D2 of 2026-09-30 and Q5 of 2026-10-02): the automatic stops of the monitor take the
// environment lock, which the workers of the windows hold during their operations (the same lock file in the same
// volume); a monitor killed while it holds the lock leaves none behind (the kernel frees it); the monitor exits with 0
// when it is idle and stays exited under its restart policy, until ensure starts it again.
describe('the Session Monitor container: the environment lock of its stops and its exit when idle (plan step 8 PR B)', () => {
  const { run, env, cli, log } = dockerTestContext('remoteMonitor');
  const docker = new ContainerAdapter(new NodeProcessRunner(), run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const containerName = `devenv-test-monitor-lock-${run.runId}`;
  const socket = helperDockerSocket(env, process.platform, run.dockerHost);
  let script = '';
  let helperTag = '';
  let volumeName = '';
  let monitor: RemoteSessionMonitor;
  let locks: ReturnType<typeof workerLocks>;
  const timings = new Timings();

  const running = (name: string): boolean => cli.container(name)?.State.Running === true;
  const logs = (): string => cli.run(['logs', containerName]).out;

  /** A labeled container of an environment; without --init, `sleep` as PID 1 ignores SIGTERM, so a stop takes 10 s. */
  function startEnvironmentContainer(name: string, environmentId: string, init: boolean): void {
    cli.ok([
      'run', '-d', ...(init ? ['--init'] : []), '--name', name,
      '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`,
      '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
  }

  function writeStaleRecord(environmentId: string): void {
    const longAgo = Date.now() - 30 * 60_000;
    const file = `/state/heartbeats/${heartbeatFileName(SOURCE, environmentId)}`;
    cli.ok(['exec', '-i', containerName, 'sh', '-c', `mkdir -p /state/heartbeats && cat > ${file}`], JSON.stringify({ at: longAgo, keepRunning: false, limitSeconds: 60, seq: longAgo }));
  }

  function newMonitor(idleMs: number): RemoteSessionMonitor {
    return new RemoteSessionMonitor({
      // Plan step 11D2: over the Engine API, as the worker runs it.
      engine: engineMonitor(dockerEngine(engineApi(helperDockerSocket(env, process.platform)), engineHijack(helperDockerSocket(env, process.platform)))),
      logger: log,
      script: async () => script,
      containerName,
      volumeName,
      labels: { [TEST_RUN_LABEL]: run.runId },
      containerEnv: { DEVENV_MONITOR_TICK_MS: String(TICK_MS), DEVENV_MONITOR_IDLE_MS: String(idleMs) },
    });
  }

  beforeAll(async () => {
    script = await bundleScript();
    helperTag = await helper.ensureImage();
    // The volume of the workers' lock files is the volume of this monitor, as on an engine.
    volumeName = testStateVolume({ run, cli }, 'remoteMonitor-locks');
    const targets = new DockerTargets(docker, env, log);
    await targets.resolve();
    locks = workerLocks({ run, cli, log }, docker, targets, 'remoteMonitor-locks', async (target) => helperDockerSocket(env, process.platform, target.endpoint));
    // Long idle time: these tests do not wait for the exit.
    monitor = newMonitor(3_600_000);
  });

  afterAll(async () => {
    timings.print('Timings of the environment lock and the idle exit of the Session Monitor:');
    log.output(`docker logs ${containerName}:\n${cli.run(['logs', containerName]).out}\n`);
    const left = await locks.dispose();
    removeRunObjects(cli, run.runId);
    expect(left).toEqual([]);
    expect(cli.container(containerName)).toBeUndefined();
  });

  it('does not stop an environment while a worker holds its lock, and stops it after the release (D2)', async () => {
    const id = crypto.randomUUID();
    const name = `devenv-test-monitor-locked-${run.runId}`;
    const lock = await locks.take(id, 10, undefined);
    let released = false;
    try {
      expect(await monitor.ensure(helperTag, socket)).toBe('created');
      startEnvironmentContainer(name, id, true);
      writeStaleRecord(id);
      // The grace of the start (8 ticks), then some ticks that want to stop it.
      await waitUntil(() => logs().includes(`${id} is busy with an operation`), 'the busy lock in the log', 30_000);
      await new Promise((resolve) => setTimeout(resolve, 10 * TICK_MS));
      expect(running(name)).toBe(true);
      // Logged once per busy streak.
      expect(logs().split(`${id} is busy with an operation`).length - 1).toBe(1);
      await lock.release();
      released = true;
      await timings.measure('stop after the release of the lock', () => waitUntil(() => !running(name), 'the stop after the release', 30_000));
      expect(logs()).toContain(`Stopping the container ${name} of ${id}`);
      // The monitor released the lock after its stop: a worker takes it at once.
      const again = await locks.take(id, 1, undefined);
      await again.release();
    } finally {
      if (!released) await lock.release();
    }
  });

  it('holds the lock during its stop, and a monitor killed while it holds the lock leaves no lock held (D2)', async () => {
    expect(['created', 'running', 'started']).toContain(await monitor.ensure(helperTag, socket));
    const id = crypto.randomUUID();
    const name = `devenv-test-monitor-slow-${run.runId}`;
    // `sleep` as PID 1 ignores SIGTERM: the `docker stop` of the monitor takes 10 s, under the lock.
    startEnvironmentContainer(name, id, false);
    writeStaleRecord(id);
    await waitUntil(() => logs().includes(`Stopping the container ${name} of ${id}`), 'the start of the slow stop', 60_000);
    // During the stop, the lock is held by the monitor: a worker is refused after its wait.
    await expect(locks.take(id, 1, undefined)).rejects.toMatchObject({ kind: 'busy' });
    cli.ok(['kill', containerName]);
    await waitUntil(() => !running(containerName), 'the end of the killed monitor', 30_000);
    // The kernel freed the lock with the process: a worker takes it at once.
    const lock = await locks.take(id, 1, undefined);
    await lock.release();
    cli.run(['rm', '-f', name]);
  });

  it('exits with 0 when no environment container runs and image updates are off, stays exited, and ensure starts it again (Q5)', async (context) => {
    // The idle exit needs a quiet engine: no running container with the environment label (of this run or another).
    if (cli.lines(['ps', '-q', '--filter', `label=${LABEL_ENVIRONMENT_ID}`]).length > 0) {
      log.info('A container with the environment label runs on this engine; the idle exit is not checked.');
      context.skip();
    }
    cli.run(['rm', '-f', containerName]);
    const idle = newMonitor(3_000);
    expect(await idle.ensure(helperTag, socket)).toBe('created');
    expect(cli.container(containerName)!.HostConfig.RestartPolicy?.Name).toBe('on-failure');
    await timings.measure('exit when idle', () => waitUntil(() => !running(containerName), 'the exit when idle', 60_000));
    const exited = cli.container(containerName) as unknown as { State: { Status: string; ExitCode: number }; RestartCount: number };
    expect(exited.State.Status).toBe('exited');
    expect(exited.State.ExitCode).toBe(0);
    expect(logs()).toContain('image updates are off; the Session Monitor exits.');
    // The restart policy leaves it exited.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(running(containerName)).toBe(false);
    expect(cli.container(containerName)!.RestartCount).toBe(0);
    expect(await idle.ensure(helperTag, socket)).toBe('started');
    expect(running(containerName)).toBe(true);
  });
});
