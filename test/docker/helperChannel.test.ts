// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channel against the real Docker engine of the runner (user request 2026-09-28): the container of a channel
// with the workspace helper image, as openHelperChannel starts it on a remote host (here without a Docker context, so
// on the engine of the runner). The script is bundled from src/helperChannel/main.ts like dist/helperChannel.js.
// Checked above all: the container ends and is removed by itself when its connection is lost (the extension closes it,
// the `docker run` process of the computer is killed, or the connection stays silent). Review round 1 (P7): afterAll
// fails when a channel container is left over. Plan step 11I1, PR B1: the operation `docker` and the removal of the
// containers of its cleanup label are gone, so the cases of a step container started through the channel are gone too
// (the end of a batch helper with its worker is tested in src/helperChannel/batch.e2e.test.ts, decision D5). Plan step
// 11I (PR A): the probe and the sweep of the worker go over the Engine API of its socket (no Docker CLI of the worker), so
// their answers are checked against what the Docker CLI of the runner reports.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { workerScriptsPlugin } from '../../scripts/workerScripts.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { dockerTargetOf } from '../../src/core/docker/dockerHost';
import { HelperChannel } from '../../src/core/helperChannel/helperChannel';
import { channelRunArgs, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import {
  CHANNEL_PROTOCOL_VERSION,
  ENGINE_IDENTITY_ARGS,
  LABEL_HELPER_CHANNEL,
  OP_PROBE,
  OP_SWEEP,
  channelLabelValue,
  encodeMessage,
  engineIdentity,
  parseProbeParams,
  parseProbeValue,
  parseSweepParams,
  parseSweepValue,
} from '../../src/core/helperChannel/protocol';
import { PIPE_LOADER, bundleHash, encodeBundle } from '../../src/core/loader/pipeLoader';
import { LABEL_HELPER_RUN } from '../../src/core/names';
import { WorkspaceHelper } from '../../src/core/helper/workspaceHelper';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import type { StartedProcess } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { HELPER_DOCKERFILE, Timings, dockerTestContext, testStateVolume } from './harness';

async function bundleScript(): Promise<string> {
  const result = await esbuild.build({
    // Plan step 11B3b: the compile-time constants of esbuild.mjs (the worker now bundles the workspace helper).
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) },
    // Plan step 11D2: the script of the Session Monitor in the worker, as esbuild.mjs bundles it.
    plugins: [workerScriptsPlugin(path.resolve(__dirname, '../..'), { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) })],
    entryPoints: [path.resolve(__dirname, '../../src/helperChannel/main.ts')],
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

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 60_000, pollMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Plan step 11I (PR A): the operation `sweep` through `channel`. The engine runs one prune at a time and refuses another
 * meanwhile (409, "a prune operation is already running"), and the open of the channel sends its own sweep in the
 * background, so a refusal for that reason alone is tried again, a few times.
 */
async function sweepThrough(channel: HelperChannel): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await channel.operation(OP_SWEEP, parseSweepParams({}), { timeoutMs: 30_000 });
    } catch (error) {
      if (attempt >= 5 || !(error instanceof Error) || !error.message.includes('a prune operation is already running')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

describe('the helper channel with the real Docker engine', () => {
  const { run, env, cli, log } = dockerTestContext('helperChannel');
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const timings = new Timings();
  const socket = helperDockerSocket(env, process.platform, run.dockerHost);
  // A remote target without a context name: the calls go to the engine of the runner.
  const target = dockerTargetOf('ssh://runner-engine', undefined);
  let script = '';
  let helperTag = '';

  /**
   * The channel containers of this run. Review round 3 (K3): only those with the label of the run, so that the channel
   * of another run or of a real window on the same engine is never listed or removed.
   */
  const channelContainers = () =>
    cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--format', '{{.Names}}']);
  /** The label of the run, on every channel container of this file. */
  const runLabelArgs = ['--label', `${TEST_RUN_LABEL}=${run.runId}`];

  /** Opens a channel as the extension does; `extraArgs` go before the image (for example `-e`), `process` is kept. */
  async function open(extraArgs: string[] = []): Promise<{ channel: HelperChannel; process: StartedProcess; name: string }> {
    let started: StartedProcess | undefined;
    let name = '';
    const channel = await openHelperChannel(
      {
        start: (args) => {
          const all = [...args];
          all.splice(all.indexOf(helperTag), 0, ...runLabelArgs, ...extraArgs);
          name = all[all.indexOf('--name') + 1];
          started = docker.start(all);
          return started;
        },
        // Plan step 5, PR A: the engine identity of the open is compared with one call without the worker.
        runDirect: (args, options) => docker.run(args, options),
        logger: log,
        script: async () => script,
        helperTag: async () => helperTag,
        socketPath: async () => socket,
        // Plan step 5, PR B: the lock files in a volume of the test, never the one of the Session Monitor.
        stateVolume: testStateVolume({ run, cli }, 'helperChannel'),
      },
      target,
    );
    return { channel, process: started!, name };
  }

  beforeAll(async () => {
    script = await timings.measure('bundle the script', bundleScript);
    helperTag = await timings.measure('workspace helper image ready', () => helper.ensureImage());
  });

  afterAll(() => {
    timings.print('Timings of the helper channel:');
    const leftovers = channelContainers();
    removeRunObjects(cli, run.runId);
    for (const name of leftovers) cli.run(['rm', '-f', name]);
    // Review round 1 (P7): every channel container must have ended by itself.
    expect(leftovers).toEqual([]);
  });

  it('opens: the container has outbound network only, no capability, --rm, and the labels; an operation and its value come back', async () => {
    const { channel, name } = await timings.measure('open a channel', () => open());
    const details = cli.container(name)!;
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.AutoRemove).toBe(true);
    expect(details.HostConfig.CapDrop).toEqual(['ALL']);
    expect(details.HostConfig.RestartPolicy?.Name ?? 'no').toMatch(/^(no|)$/);
    expect(details.Config.Labels?.[LABEL_HELPER_CHANNEL]).toBe(channelLabelValue(script));
    // Plan step 11E3a (decision of 2026-10-03): changed expectation, outbound network on the default bridge and no published
    // port (before: 'none').
    const host = (details as unknown as { HostConfig: { NetworkMode: string; PortBindings?: Record<string, unknown> | null } }).HostConfig;
    expect(host.NetworkMode).toBe('bridge');
    expect(host.PortBindings ?? {}).toEqual({});
    // Plan step 3 (pipe loading, user decision 2026-09-29): the command is the pipe loader with the path, the hash and the
    // entry; the script came over stdin and is nowhere in the configuration of the container.
    expect(details.Config.Cmd).toEqual(['node', '-e', PIPE_LOADER, '/opt/devenv/channel.js', bundleHash(script), 'startChannel']);
    expect(details.Config.OpenStdin).toBe(true);
    // Review round 1 of PR #69 (B-R1-8): changed expectation (before: script.slice(0, 200), which JSON.stringify escapes, so
    // the check could never fail): the piece as it appears in the JSON of the details.
    expect(JSON.stringify(details)).not.toContain(JSON.stringify(script).slice(1, 201));

    // Plan step 11I1, PR B1: changed call (before: `docker version` through the operation `docker`, removed): the
    // operation `probe`, which runs the same call in the worker; the check of the input of a Docker call is gone with the
    // operation `docker`. Plan step 11I (PR A): the probe reads the Engine API (`GET /version`, `GET /info`) instead of
    // the worker's Docker CLI: the same version as the Docker CLI of the runner, and the same identity, compared as values
    // (as the open compared them already).
    const probe = parseProbeValue(await timings.measure('probe through the channel', () => channel.operation(OP_PROBE, parseProbeParams({}), { timeoutMs: 30_000 })));
    expect(probe?.serverVersion).toBe(cli.ok(['version', '--format', '{{.Server.Version}}']));
    expect(probe?.engine).toBeDefined();
    expect(probe?.engine).toEqual(engineIdentity(cli.ok([...ENGINE_IDENTITY_ARGS])));

    // Plan step 11I (PR A): the sweep prunes over the Engine API with the label and the age of before: a channel container
    // that was created but never started, younger than 10 minutes, is kept (an open that runs now), and the value says
    // how many it removed (others of this engine older than 10 minutes may go, as at every open). Plan step 11I (U5,
    // decision of 2026-10-08): changed input, with the label of every helper container that the sweep prunes now (the
    // channels carry it, channelRunArgs), so that only its age keeps it.
    const young = `devenv-channel-young-${run.runId}`;
    cli.ok(['create', '--name', young, '--label', `${LABEL_HELPER_RUN}=true`, '--label', `${LABEL_HELPER_CHANNEL}=${channelLabelValue(script)}`, ...runLabelArgs, helperTag, 'true']);
    try {
      const swept = parseSweepValue(await timings.measure('sweep through the channel', () => sweepThrough(channel)));
      expect(swept).toBeDefined();
      expect(swept!.removed).toBeGreaterThanOrEqual(0);
      expect(cli.container(young)?.State.Status).toBe('created');
    } finally {
      cli.run(['rm', '-f', young]);
    }

    channel.close();
    await timings.measure('end after close', () => waitUntil(() => cli.container(name) === undefined, 'the removal of the container'));
  });

  it('ends when the docker run process of the computer is killed hard (the connection breaks)', async () => {
    const { process: started, name } = await open();
    expect(cli.container(name)?.State.Running).toBe(true);
    // SIGKILL: docker run cannot pass a signal on or close anything; the engine sees its connection end.
    process.kill(started.pid!, 'SIGKILL');
    // The end of the input ends it at once; at the latest the silence (CHANNEL_SILENCE_EXIT_MS) does.
    await timings.measure('end after a hard kill of docker run', () =>
      waitUntil(() => cli.container(name) === undefined, 'the removal of the container', 120_000),
    );
  });

  // Plan step 11I1, PR B1: changed test (before: also with a step container started by the operation `docker`, removed by
  // its cleanup label): the end after the silence alone.
  it('ends after the silence while the connection stays open', async () => {
    const containerName = `devenv-channel-test-${run.runId}`;
    // Plan step 5, PR B: changed call: the state volume (a volume of the test).
    const args = channelRunArgs({
      tag: helperTag,
      socketPath: socket,
      stateVolume: testStateVolume({ run, cli }, 'helperChannel'),
      containerName,
      label: channelLabelValue(script),
      scriptHash: bundleHash(script),
    });
    // Review round 1 (P8): long enough for the answer to hello to be seen on a slow runner.
    args.splice(args.indexOf(helperTag), 0, ...runLabelArgs, '-e', 'DEVENV_CHANNEL_SILENCE_MS=10000');
    const process = docker.start(args)!;
    let stdout = '';
    process.onStdout((text) => (stdout += text));
    process.write(encodeBundle(script));
    process.write(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION }));
    await waitUntil(() => stdout.includes('"t":"hello"'), 'the answer to hello');
    // Nothing more is written; the input of docker run stays open, as with a connection that hangs.
    await timings.measure('end after the silence', () => waitUntil(() => cli.container(containerName) === undefined, 'the removal of the channel container'));
    process.end();
    await process.exited;
  });
});
