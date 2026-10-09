// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #109 (plan step 11E3a), reviewer B: the probes of the mutation testing of the bridge fallback of
// openHelperChannel (a daemon without its default bridge network). No Docker: the processes of the channel are stand-ins.
import { describe, expect, it } from 'vitest';
import { dockerTargetOf, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import { silentLogger, type StartedProcess } from '../ports';
import { openHelperChannel } from './helperChannels';
import { CHANNEL_PROTOCOL_VERSION, encodeMessage, parseClientMessage } from './protocol';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
const ENGINE = '"7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11" "/var/lib/docker"';
/** Plan step 11I (PR A): the same engine as the worker answers it (ProbeValue.engine: the values of `GET /info`). */
const ENGINE_IDENTITY = { id: '7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11', rootDir: '/var/lib/docker' };

/** A channel process that answers hello and the probe. */
function good(): StartedProcess {
  let stdout: ((text: string) => void) | undefined;
  return {
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) {
        const message = parseClientMessage(line);
        if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe', 'sweep'] })));
        if (message?.t === 'op' && message.op === 'probe') {
          // Plan step 11I (PR A): changed answer: the engine as its values (before: the text of ENGINE_IDENTITY_ARGS).
          queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE_IDENTITY } })));
        }
      }
      return true;
    },
    end: () => {},
    kill: () => {},
    onStdout: (listener) => (stdout = listener),
    onStderr: () => {},
    exited: new Promise(() => {}),
  };
}

/** A `docker run` that the daemon refuses with `stderr` (exit code 125). */
function refused(stderr: string): StartedProcess {
  let exit: (value: { exitCode: number | null }) => void = () => {};
  const exited = new Promise<{ exitCode: number | null }>((resolve) => (exit = resolve));
  return {
    write: () => true,
    end: () => {},
    kill: () => {},
    onStdout: () => {},
    onStderr: (listener) => {
      queueMicrotask(() => {
        listener(stderr);
        exit({ exitCode: 125 });
      });
    },
    exited,
  };
}

/** Opens with the processes `first`, then a good one; records the network and the name of each start, and the warnings. */
async function open(first: () => StartedProcess) {
  const networks: string[] = [];
  const names: string[] = [];
  const warnings: string[] = [];
  const processes = [first, good];
  const channel = await openHelperChannel(
    {
      start: (args) => {
        networks.push(args[args.indexOf('--network') + 1]);
        names.push(args[args.indexOf('--name') + 1]);
        return processes.shift()!();
      },
      runDirect: async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }),
      logger: { ...silentLogger, warn: (text) => warnings.push(text) },
      script: async () => 'SCRIPT',
      helperTag: async () => 'devenv-helper:abc',
      socketPath: async () => '/var/run/docker.sock',
      stateVolume: 'devenv-session-monitor',
      vscodeVolume: 'devenv-vscode',
    },
    REMOTE,
  ).catch((error: unknown) => {
    throw Object.assign(error as Error, { networks });
  });
  channel.close();
  return { networks, names, warnings };
}

describe('the bridge fallback of openHelperChannel, review round 2 of PR #109 (B)', () => {
  it('the refusal with the name in quotes or in other case starts again without network', async () => {
    for (const stderr of ['docker: Error response from daemon: network "bridge" not found.\n', 'docker: Error response from daemon: Network bridge not found.\n']) {
      const { networks } = await open(() => refused(stderr));
      expect(networks, stderr).toEqual(['bridge', 'none']);
    }
  });

  it('another failure that names the bridge is not retried', async () => {
    await expect(open(() => refused('docker: Error response from daemon: failed to create endpoint on network bridge: address already in use.\n'))).rejects.toMatchObject({
      networks: ['bridge'],
    });
  });

  it('only a failure of the channel is retried: an error of the start itself with that text is not', async () => {
    await expect(
      open(() => {
        throw new Error('network bridge not found');
      }),
    ).rejects.toMatchObject({ message: 'network bridge not found', networks: ['bridge'] });
  });

  it('the second start has a container name of its own, and the warning names the engine', async () => {
    const { networks, names, warnings } = await open(() => refused('docker: Error response from daemon: network bridge not found.\n'));
    expect(networks).toEqual(['bridge', 'none']);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(warnings.join('\n')).toContain('The Docker engine build-box has no default bridge network');
  });
});
