// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channel against the real Docker engine of the runner (user request 2026-09-28): the container of a channel
// with the workspace helper image, as openHelperChannel starts it on a remote host (here without a Docker context, so
// on the engine of the runner). The script is bundled from src/helperChannel/main.ts like dist/helperChannel.js.
// Checked above all: the container ends and is removed by itself when its connection is lost (the extension closes it,
// the `docker run` process of the computer is killed, or the connection stays silent), and a container that an
// operation started with its cleanup label is removed with it. Review round 1 (P7): the step containers run `sleep` as
// process 1 (no init), which ignores SIGTERM, so only the cleanup of the channel can remove them; and afterAll fails
// when a channel container is left over.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { workerScriptsPlugin } from '../../scripts/workerScripts.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { dockerTargetOf } from '../../src/core/docker/dockerHost';
import { HelperChannel } from '../../src/core/helperChannel/helperChannel';
import { channelRunArgs, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import {
  CHANNEL_PROTOCOL_VERSION,
  LABEL_HELPER_CHANNEL,
  channelLabelValue,
  channelStepLabel,
  encodeMessage,
  newCleanupLabel,
} from '../../src/core/helperChannel/protocol';
import { PIPE_LOADER, bundleHash, encodeBundle } from '../../src/core/loader/pipeLoader';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
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

describe('the helper channel with the real Docker engine', () => {
  const { run, env, cli, log } = dockerTestContext('helperChannel');
  const docker = new ContainerAdapter(new NodeProcessRunner(), run.dockerPath, env, log);
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
        runDirect: (args, options) => docker.runDirect(args, options),
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

  /** A step container that only the cleanup can remove: `sleep` as process 1 ignores SIGTERM (no init). */
  function stepArgs(name: string, label: string): string[] {
    return ['run', '--rm', '--name', name, '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--label', channelStepLabel(label), '--entrypoint', 'sleep', helperTag, '300'];
  }

  it('opens: the container has no network, no capability, --rm, and the labels; Docker calls and their output come back', async () => {
    const { channel, name } = await timings.measure('open a channel', () => open());
    const details = cli.container(name)!;
    expect(details.State.Running).toBe(true);
    expect(details.HostConfig.AutoRemove).toBe(true);
    expect(details.HostConfig.CapDrop).toEqual(['ALL']);
    expect(details.HostConfig.RestartPolicy?.Name ?? 'no').toMatch(/^(no|)$/);
    expect(details.Config.Labels?.[LABEL_HELPER_CHANNEL]).toBe(channelLabelValue(script));
    expect((details as unknown as { HostConfig: { NetworkMode: string } }).HostConfig.NetworkMode).toBe('none');
    // Plan step 3 (pipe loading, user decision 2026-09-29): the command is the pipe loader with the path, the hash and the
    // entry; the script came over stdin and is nowhere in the configuration of the container.
    expect(details.Config.Cmd).toEqual(['node', '-e', PIPE_LOADER, '/opt/devenv/channel.js', bundleHash(script), 'startChannel']);
    expect(details.Config.OpenStdin).toBe(true);
    // Review round 1 of PR #69 (B-R1-8): changed expectation (before: script.slice(0, 200), which JSON.stringify escapes, so
    // the check could never fail): the piece as it appears in the JSON of the details.
    expect(JSON.stringify(details)).not.toContain(JSON.stringify(script).slice(1, 201));

    const version = await timings.measure('docker version through the channel', () => channel.docker(['version', '--format', '{{.Server.Version}}']));
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(cli.ok(['version', '--format', '{{.Server.Version}}']));
    const input = await channel.docker(['run', '--rm', '-i', '--label', `${TEST_RUN_LABEL}=${run.runId}`, helperTag, 'cat'], { input: 'through the channel' });
    expect(input).toMatchObject({ exitCode: 0, stdout: 'through the channel' });

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

  it('cancels an operation: its Docker call ends and the container it started is removed', async () => {
    const { channel, name } = await open();
    const stepName = `devenv-test-channel-step-${run.runId}`;
    const label = newCleanupLabel();
    const controller = new AbortController();
    const running = channel.docker(stepArgs(stepName, label), { signal: controller.signal, cleanup: label });
    await waitUntil(() => cli.container(stepName)?.State.Running === true, 'the start of the step');
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await waitUntil(() => cli.container(stepName) === undefined, 'the removal of the step container');
    expect(channel.isOpen).toBe(true);
    channel.close();
    await waitUntil(() => cli.container(name) === undefined, 'the removal of the channel container');
  });

  it('ends after the silence while the connection stays open, with the containers of what ran', async () => {
    const containerName = `devenv-channel-test-${run.runId}`;
    const stepName = `devenv-test-channel-silent-${run.runId}`;
    const label = newCleanupLabel();
    // Plan step 5, PR B: changed call: the state volume (a volume of the test).
    const args = channelRunArgs({
      tag: helperTag,
      socketPath: socket,
      stateVolume: testStateVolume({ run, cli }, 'helperChannel'),
      containerName,
      label: channelLabelValue(script),
      scriptHash: bundleHash(script),
    });
    // Review round 1 (P8): long enough for the step to start and be seen on a slow runner.
    args.splice(args.indexOf(helperTag), 0, ...runLabelArgs, '-e', 'DEVENV_CHANNEL_SILENCE_MS=10000');
    const process = docker.start(args)!;
    let stdout = '';
    process.onStdout((text) => (stdout += text));
    process.write(encodeBundle(script));
    process.write(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION }));
    process.write(
      encodeMessage({
        t: 'op',
        id: 1,
        op: 'docker',
        params: { args: stepArgs(stepName, label), cleanup: label },
      }),
    );
    await waitUntil(() => stdout.includes('"t":"hello"'), 'the answer to hello');
    await waitUntil(() => cli.container(stepName)?.State.Running === true, 'the start of the step', 60_000, 100);
    // Nothing more is written; the input of docker run stays open, as with a connection that hangs.
    await timings.measure('end after the silence', () => waitUntil(() => cli.container(containerName) === undefined, 'the removal of the channel container'));
    await waitUntil(() => cli.container(stepName) === undefined, 'the removal of the step container');
    process.end();
    await process.exited;
  });
});
