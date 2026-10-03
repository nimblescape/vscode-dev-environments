// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1: the port `DockerEngine` of the flows (src/core/worker/dockerEngine.ts) over the Docker CLI of the
// tests. In the product the worker serves that port over the Engine API (src/helperChannel/engineClient.ts, tested
// against a real server there, and through a real worker in workerFlows.test.ts); here the flows run against a real
// engine without a worker, so a test of a flow checks what the scripts do in real containers. Where it differs from the
// port of the worker (review round 1 of plan step 11B1, A-R1-19), so that no flow relies on it: the output is trimmed
// (DockerCli.run), `timeoutMs` and `signal` are not served (`timedOut` is never true), and `created` and `imageId` of a
// container are not read.
import type { DockerEngine, EngineContainer, EngineExecOptions, EngineExecResult } from '../../src/core/worker/dockerEngine';
import { EngineError } from '../../src/core/worker/dockerEngine';
import type { ContainerDetails, DockerCli } from './dockerRun';

function containerOf(details: ContainerDetails): EngineContainer {
  const container: EngineContainer = {
    id: details.Id,
    name: details.Name.replace(/^\//, ''),
    state: details.State.Running ? 'running' : 'stopped',
    rawState: details.State.Status,
    labels: details.Config.Labels ?? {},
    image: details.Config.Image,
  };
  if (details.State.ExitCode !== undefined) container.exitCode = details.State.ExitCode;
  if (details.RestartCount !== undefined) container.restartCount = details.RestartCount;
  const volumes = details.Mounts.filter((mount) => mount.Type === 'volume' && mount.Name !== undefined).map((mount) => mount.Name as string);
  if (volumes.length > 0) container.volumes = volumes;
  return container;
}

/**
 * The engine of the tests: `cli` for the requests, `docker exec` for a process in a container. `secrets` holds the
 * values that the worker would hold (EngineExecOptions.secretInputName names one of them; its value never becomes an
 * argument here either).
 */
export function cliEngine(cli: DockerCli, secrets: Readonly<Record<string, string>> = {}): DockerEngine {
  const exec = async (container: string, command: readonly string[], options: EngineExecOptions = {}): Promise<EngineExecResult> => {
    const input = options.secretInputName !== undefined ? secrets[options.secretInputName] : options.input;
    const args = ['exec', ...(input === undefined ? [] : ['-i']), ...(options.user === undefined ? [] : ['-u', options.user])];
    if (options.workdir !== undefined) args.push('-w', options.workdir);
    // The Docker CLI of the tests runs to its end: `timeoutMs` and `signal` of the port are not served here.
    const result = cli.run([...args, container, ...command], input);
    if (result.out !== '') options.onOutput?.('stdout', result.out);
    if (result.err !== '') options.onOutput?.('stderr', result.err);
    return { exitCode: result.code, stdout: result.out, stderr: result.err, timedOut: false };
  };
  return {
    container: async (reference) => {
      const result = cli.run(['container', 'inspect', reference]);
      if (result.code !== 0) {
        // As the port: only a missing container is undefined; any other failure of the engine throws.
        if (/no such (container|object)/i.test(result.err)) return undefined;
        throw new EngineError(result.err || result.out, 500);
      }
      return containerOf((JSON.parse(result.out) as ContainerDetails[])[0]);
    },
    containers: async (label) => {
      const listed = cli.run(['ps', '-a', '--no-trunc', '--filter', `label=${label}`, '--format', '{{.ID}}']);
      if (listed.code !== 0) throw new EngineError(listed.err || listed.out, 500);
      const ids = listed.out.split('\n').filter((line) => line.trim() !== '');
      const found: EngineContainer[] = [];
      for (const id of ids) {
        const details = cli.container(id);
        if (details !== undefined) found.push(containerOf(details));
      }
      return found;
    },
    exec,
    stop: async (container, seconds) => {
      const result = cli.run(['stop', '-t', String(seconds), container]);
      if (result.code !== 0) throw new EngineError(result.err || result.out, 500);
    },
    start: async (container) => {
      const result = cli.run(['start', container]);
      if (result.code !== 0) throw new EngineError(result.err || result.out, 500);
    },
  };
}
