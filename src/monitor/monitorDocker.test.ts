import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../core/ports';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import {
  capTimeout,
  DOCKER_LOOKUP_RETRY_MS,
  MONITOR_DOCKER_TIMEOUT_MS,
  MonitorDockerClient,
  monitorDockerEnv,
} from './monitorDocker';
import { MonitorLoop } from './monitorLoop';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const T0 = Date.parse('2026-09-24T17:00:00.000Z');
const DOCKER = '/usr/local/bin/docker';

interface Call {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

function result(stdout: string, exitCode = 0, stderr = ''): RunResult {
  return { exitCode, stdout, stderr, timedOut: false };
}

/** Answers the Docker CLI calls of the monitor for one container of environment A. */
class FakeDockerCli implements ProcessRunner {
  calls: Call[] = [];
  running = true;

  async run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ file, args, options });
    const [command] = args;
    if (command === 'ps') return result('"c0ffee"\n');
    if (command === 'container' && args[1] === 'inspect') {
      return result(
        JSON.stringify([
          {
            Id: 'c0ffee',
            Name: '/devenv-acme-api-3f2a9c1e',
            Created: '2026-09-24T10:00:00Z',
            State: { Status: this.running ? 'running' : 'exited' },
            Config: { Image: 'devenv-3f2a9c1e:1', Labels: { [LABEL_ENVIRONMENT_ID]: ID_A } },
          },
        ]),
      );
    }
    if (command === 'exec') return result('main\n0\n0\n0\n');
    if (command === 'stop') {
      this.running = false;
      return result('c0ffee\n');
    }
    return result('', 1, `unexpected command ${args.join(' ')}`);
  }
}

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('capTimeout', () => {
  it('limits every call to the cap, also calls without a time limit', async () => {
    const seen: Array<number | undefined> = [];
    const inner: ProcessRunner = {
      run: async (_file, _args, options) => {
        seen.push(options?.timeoutMs);
        return result('');
      },
    };
    const runner = capTimeout(inner, 30_000);
    await runner.run('docker', ['ps']);
    await runner.run('docker', ['stop', 'x'], { timeoutMs: 60_000 });
    await runner.run('docker', ['exec', 'x'], { timeoutMs: 20_000 });
    expect(seen).toEqual([30_000, 30_000, 20_000]);
  });
});

describe('monitorDockerEnv', () => {
  it('removes ELECTRON_RUN_AS_NODE in any spelling and keeps the rest', () => {
    const env = monitorDockerEnv({ ELECTRON_RUN_AS_NODE: '1', Electron_Run_As_Node: '1', PATH: '/bin', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('MonitorDockerClient', () => {
  it('lets the monitor use only the container list, docker exec, and docker stop — never a Docker start', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
    roots.push(root);
    const paths = new StoragePaths(root);
    let now = T0;
    const clock = { now: () => now };
    const registry = new EnvironmentRegistry(paths, clock);
    const sessionFiles = new SessionFiles(paths, clock);
    await registry.add({
      id: ID_A,
      repository: 'acme/api',
      configPath: '.devcontainer/devcontainer.json',
      volumeName: 'devenv-acme-api-3f2a9c1e',
      containerName: 'devenv-acme-api-3f2a9c1e',
      createdAt: new Date(T0).toISOString(),
      lastUsedAt: new Date(T0).toISOString(),
      remoteUser: 'vscode',
    });
    await sessionFiles.writeWindowStatus({
      windowId: 'w1',
      pid: 999_991,
      environmentId: ID_A,
      state: 'closing',
      updatedAt: new Date(T0).toISOString(),
    });

    const cli = new FakeDockerCli();
    const docker = new MonitorDockerClient({
      runner: cli,
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
      platform: 'darwin',
      logger: silentLogger,
      clock,
      findDocker: () => DOCKER,
    });
    const loop = new MonitorLoop({
      registry,
      sessionFiles,
      docker,
      logger: silentLogger,
      clock,
      isAlive: () => false,
      refreshLock: () => true,
      delay: async (ms) => {
        now += ms;
      },
    });

    expect(await loop.run()).toBe('idle');
    const commands = cli.calls.map((call) => call.args.slice(0, 2).join(' '));
    expect(commands).toContain('stop c0ffee');
    expect(commands.some((command) => command.startsWith('exec'))).toBe(true);
    for (const call of cli.calls) {
      expect(call.file).toBe(DOCKER);
      expect(['ps', 'container', 'exec', 'stop']).toContain(call.args[0]);
      expect(call.args).not.toContain('desktop');
      expect(call.args).not.toContain('start');
      expect(call.args).not.toContain('info');
      expect(call.options.timeoutMs).toBeDefined();
      expect(call.options.timeoutMs).toBeLessThanOrEqual(MONITOR_DOCKER_TIMEOUT_MS);
      expect(call.options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    }
    const exec = cli.calls.find((call) => call.args[0] === 'exec');
    expect(exec?.args.slice(0, 4)).toEqual(['exec', '-u', 'vscode', 'c0ffee']);
    expect((await registry.get(ID_A))?.gitSummary?.branch).toBe('main');
  });

  it('fails every call without a Docker CLI, and looks for the CLI again after a minute', async () => {
    let now = T0;
    let lookups = 0;
    let found: string | undefined;
    const cli = new FakeDockerCli();
    const docker = new MonitorDockerClient({
      runner: cli,
      env: {},
      platform: 'linux',
      logger: silentLogger,
      clock: { now: () => now },
      findDocker: () => {
        lookups++;
        return found;
      },
    });
    await expect(docker.listEnvironmentContainers()).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    await expect(docker.stopContainer('x')).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(lookups).toBe(1);
    expect(cli.calls).toEqual([]);

    found = DOCKER;
    now += DOCKER_LOOKUP_RETRY_MS - 1;
    await expect(docker.listEnvironmentContainers()).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(lookups).toBe(1);
    now += 1;
    expect((await docker.listEnvironmentContainers()).map((container) => container.id)).toEqual(['c0ffee']);
    expect(lookups).toBe(2);
    await docker.listEnvironmentContainers();
    expect(lookups).toBe(2);
  });
});
