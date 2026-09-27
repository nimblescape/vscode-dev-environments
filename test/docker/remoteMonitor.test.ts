// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 7, PR 2: the Session Monitor container of a remote Docker host, against the real Docker engine of the runner (the
// same code path as on a remote host: RemoteSessionMonitor.ensure with the workspace helper image and the socket of the
// engine). The script is bundled from src/remoteMonitor/main.ts like dist/remoteMonitor.js. The container, its volume, and
// the test containers have names of this run; the test containers carry the label devenv.environment-id with new ids,
// so the monitor acts on them. The tick of the monitor is shortened with DEVENV_MONITOR_TICK_MS (read only by main.ts).
// Checked: a labeled container with a stale record is stopped; one whose record keeps it running is not; one with a
// fresh heartbeat is not; one without any record is never touched; ensure on a running, a stopped, and a missing container; the records and forget subcommands;
// an invalid heartbeat writes nothing.
import * as crypto from 'crypto';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { LABEL_ENVIRONMENT_ID } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { LABEL_SESSION_MONITOR, heartbeatFileName } from '../../src/core/remoteMonitor/protocol';
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
  function writeRecord(source: string, environmentId: string, record: { at: number; keepRunning: boolean; limitSeconds: number }): void {
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
      Config: { Labels: Record<string, string>; Image: string };
      HostConfig: { NetworkMode: string; RestartPolicy: { Name: string }; CapDrop: string[] | null; PortBindings: unknown };
    };
    expect(details.State.Running).toBe(true);
    expect(details.Config.Image).toBe(helperTag);
    expect(details.Config.Labels[LABEL_SESSION_MONITOR]).toMatch(/^[0-9a-f]{12}$/);
    expect(details.Config.Labels[LABEL_ENVIRONMENT_ID]).toBeUndefined();
    expect(details.HostConfig.NetworkMode).toBe('none');
    expect(details.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
    expect(details.HostConfig.CapDrop).toEqual(['ALL']);
    await waitUntil(() => cli.run(['logs', containerName]).out.includes('Session Monitor started'), 'the start of the monitor', 30_000);
    // A second ensure finds it running.
    expect(await monitor.ensure(helperTag, socket)).toBe('running');
  });

  it('stops a container with a stale record, keeps one whose record keeps it running, one with a fresh heartbeat, and one without any record', async () => {
    startEnvironmentContainer(names.unrecorded, ids.unrecorded);
    startEnvironmentContainer(names.stale, ids.stale);
    startEnvironmentContainer(names.kept, ids.kept);
    startEnvironmentContainer(names.fresh, ids.fresh);
    const longAgo = Date.now() - 30 * 60_000;
    writeRecord(SOURCE, ids.stale, { at: longAgo, keepRunning: false, limitSeconds: 60 });
    writeRecord(OTHER_SOURCE, ids.kept, { at: longAgo, keepRunning: true, limitSeconds: 60 });
    const heartbeat = await monitor.heartbeat({ source: SOURCE, limitSeconds: 60, environments: [{ id: ids.fresh, keepRunning: false }] });
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
});
