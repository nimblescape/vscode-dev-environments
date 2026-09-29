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
// was cut off is replaced too.
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { LABEL_ENVIRONMENT_ID } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { LOADER_EXIT_CODE, PIPE_LOADER, bundleHash } from '../../src/core/loader/pipeLoader';
import {
  LABEL_SESSION_MONITOR,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  heartbeatFileName,
  remoteMonitorLabelValue,
} from '../../src/core/remoteMonitor/protocol';
import { RemoteSessionMonitor } from '../../src/core/remoteMonitor/remoteSessionMonitor';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { HELPER_DOCKERFILE, Timings, dockerTestContext } from './harness';

const SOURCE = crypto.randomBytes(16).toString('hex');
const OTHER_SOURCE = crypto.randomBytes(16).toString('hex');
const TICK_MS = 500;

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
  const monitor = new RemoteSessionMonitor({
    docker,
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
    expect(details.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
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
    const heartbeat = await monitor.heartbeat({ source: SOURCE, limitSeconds: 60, environments: [{ id: ids.fresh, keepRunning: false, seq: Date.now() }] });
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
    const records = await monitor.records(ids.fresh);
    expect(records?.records).toEqual([{ source: SOURCE, at: expect.any(Number), keepRunning: false }]);
    expect(Math.abs(records!.now - records!.records[0].at)).toBeLessThan(5 * 60_000);
    await monitor.forget(SOURCE, ids.fresh);
    expect((await monitor.records(ids.fresh))?.records).toEqual([]);

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
    let records: Awaited<ReturnType<typeof monitor.records>>;
    const deadline = Date.now() + 30_000;
    while ((records = await monitor.records(ids.kept)) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    expect(records?.records.map((record) => record.source)).toEqual([OTHER_SOURCE]);
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
    expect(await monitor.records(ids.kept)).toBeDefined();
  });

  it('exits with 3 after a restart when the stored script was changed, and ensure then creates it again', async () => {
    expect(['created', 'running']).toContain(await monitor.ensure(helperTag, socket));
    await waitUntil(() => running(containerName), 'the monitor');
    const id = cli.container(containerName)!.Id;
    cli.ok(['exec', containerName, 'sh', '-c', `echo '// changed' >> ${REMOTE_MONITOR_SCRIPT_PATH}`]);
    // Review round 1 of PR #69 (A-R1-1): changed expectation (before: `docker update --restart no` first, and a wait for
    // `restarting` or `exited` with 3): the production configuration, unless-stopped, stays. The loader exits 3 at once
    // (the marker of its first start: started before without its bundle), Docker restarts it (RestartCount ≥ 1), and
    // ensure replaces it whether it finds it `restarting` or, between two restarts, `running` (the hash check).
    cli.ok(['restart', containerName]);
    await timings.measure('exit 3 of the loader and a restart by the policy', () =>
      waitUntil(() => (cli.container(containerName)?.RestartCount ?? 0) >= 1, 'a restart by the policy', 90_000),
    );
    expect(cli.container(containerName)!.HostConfig.RestartPolicy?.Name).toBe('unless-stopped');
    expect(cli.run(['logs', containerName]).err).toContain('devenv loader: started before without its bundle');
    expect(LOADER_EXIT_CODE).toBe(3);
    expect(await monitor.ensure(helperTag, socket)).toBe('created');
    const details = cli.container(containerName)!;
    expect(details.Id).not.toBe(id);
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.RestartPolicy?.Name).toBe('unless-stopped');
    expect(cli.run(['exec', containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH]).out.split(' ')[0]).toBe(bundleHash(script));
  });

  // Review round 1 of PR #69 (A-R1-1): the first, attached `docker run` is cut off before it wrote the script (the window
  // reloaded, the SSH connection dropped). The loader reads the end of its input and exits 3; the restart policy starts
  // it again with an input that never ends, and the marker of the first start makes it exit 3 at once, so ensure finds
  // it restarting (or running with RestartCount ≥ 1 and no stored script) and replaces it.
  it('replaces a monitor whose first load was cut off (review round 1 of PR #69, A-R1-1)', { timeout: 240_000 }, async () => {
    cli.run(['rm', '-f', containerName]);
    const label = remoteMonitorLabelValue(script, helperTag, []);
    const client = spawn(run.dockerPath, monitor.runArgs(helperTag, socket, label, script), { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    expect(interrupted.HostConfig.RestartPolicy?.Name).toBe('unless-stopped');
    expect(cli.run(['exec', containerName, 'test', '-f', REMOTE_MONITOR_SCRIPT_PATH]).code).not.toBe(0);
    expect(await monitor.ensure(helperTag, socket)).toBe('created');
    const details = cli.container(containerName)!;
    expect(details.Id).not.toBe(interrupted.Id);
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.RestartPolicy?.Name).toBe('unless-stopped');
    expect(cli.run(['exec', containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH]).out.split(' ')[0]).toBe(bundleHash(script));
  });
});
