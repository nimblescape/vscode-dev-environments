// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages, dockerHostReason } from '../messages';
import type { RunOptions, RunResult } from '../ports';
import { RemoteDockerState } from '../storage/remoteDockerState';
import { remoteContextName } from './dockerHost';
import {
  ENGINE_INFO_FORMAT,
  SSH_CHECK_CACHE_MS,
  SshLoginCache,
  checkCurrentEngine,
  checkSshLogin,
  chooseLocalContext,
  dockerVariableOverride,
  ensureDockerHostReachable,
  listContexts,
  localContextChoice,
  noPromptEnv,
  parseEngineInfo,
  readRootlessSocket,
  startDockerFor,
  testRemoteDockerHost,
  useContext,
  useRemoteContext,
  type RemoteDockerCli,
} from './remoteDocker';

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string, exitCode = 1): RunResult => ({ exitCode, stdout: '', stderr, timedOut: false });
const info = (rootless = false) =>
  ok(`${JSON.stringify({ version: '28.1.0', securityOptions: ['name=seccomp,profile=builtin', ...(rootless ? ['name=rootless'] : [])] })}\n`);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
/** The ssh check before the Docker calls (review, C3): `ssh … -- <host> true`. */
const isSshCheck = (args: readonly string[]): boolean => args[args.length - 1] === 'true';
/** A runner whose ssh check succeeds and whose other ssh call prints `runtimeDir`. */
function sshRunner(runtimeDir = '/run/user/1000', check: RunResult = ok('')) {
  return { run: vi.fn(async (_file: string, args: readonly string[], _options?: RunOptions) => (isSshCheck(args) ? check : ok(runtimeDir))) };
}
const sshDeps = (runner = sshRunner()) => ({ runner, sshPath: '/usr/bin/ssh', env: { PATH: '/usr/bin' } });

type Call = { args: readonly string[]; options?: RunOptions };

function fakeDocker(answer: (args: readonly string[]) => RunResult | Promise<RunResult>): RemoteDockerCli & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    isInstalled: () => true,
    processEnv: () => ({ PATH: '/usr/bin', DOCKER_CONTEXT: 'desktop-linux', SSH_AUTH_SOCK: '/tmp/agent.sock', SSH_ASKPASS_REQUIRE: 'force' }),
    run: async (args, options) => {
      calls.push({ args, options });
      return answer(args);
    },
  };
}

let dir: string;
let state: RemoteDockerState;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-'));
  state = new RemoteDockerState(path.join(dir, 'remote-docker.json'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseEngineInfo', () => {
  it('reads the version and a rootless engine', () => {
    expect(parseEngineInfo(info(true).stdout)).toEqual({ version: '28.1.0', rootless: true });
    expect(parseEngineInfo(info(false).stdout)).toEqual({ version: '28.1.0', rootless: false });
  });

  it('needs a server version', () => {
    expect(parseEngineInfo('{"version":"","securityOptions":null}')).toBeUndefined();
    expect(parseEngineInfo('garbage')).toBeUndefined();
  });
});

describe('testRemoteDockerHost (the test before the switch)', () => {
  it('runs docker -H ssh://<host> info without questions, and without the context of VS Code', async () => {
    const docker = fakeDocker(() => info());
    await expect(testRemoteDockerHost(docker, 'me@box:2222', sshDeps())).resolves.toEqual({ ok: true, version: '28.1.0', rootless: false });
    expect(docker.calls).toHaveLength(1);
    const [{ args, options }] = docker.calls;
    expect(args).toEqual(['-H', 'ssh://me@box:2222', 'info', '--format', ENGINE_INFO_FORMAT]);
    expect(options?.timeoutMs).toBe(45_000);
    expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
    expect(options?.env).not.toHaveProperty('DOCKER_CONTEXT');
    expect(options?.env).not.toHaveProperty('DOCKER_HOST');
    // The SSH agent of the user stays as it is.
    expect(options?.env?.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
  });

  it.each([
    ['Permission denied (publickey).', 'login'],
    ['Host key verification failed.', 'hostKey'],
    ['ssh: Could not resolve hostname box: Name or service not known', 'unreachable'],
    ['bash: docker: command not found', 'dockerMissing'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'dockerNotRunning'],
  ])('maps %s to %s', async (stderr, problem) => {
    const docker = fakeDocker(() => fail(`error during connect: ${stderr}`));
    await expect(testRemoteDockerHost(docker, 'box', sshDeps())).resolves.toMatchObject({ ok: false, problem });
  });

  it('counts a time-out as unreachable', async () => {
    const docker = fakeDocker(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
    await expect(testRemoteDockerHost(docker, 'box', sshDeps(), { timeoutMs: 1000 })).resolves.toEqual({
      ok: false,
      problem: 'unreachable',
      detail: 'docker info did not answer within 1 seconds.',
    });
  });

  it('noPromptEnv replaces every spelling of SSH_ASKPASS_REQUIRE', () => {
    expect(noPromptEnv({ ssh_askpass_require: 'force', A: '1' })).toEqual({ A: '1', SSH_ASKPASS_REQUIRE: 'never' });
  });
});

describe('the ssh check before the Docker calls (review, C3)', () => {
  it('runs ssh with BatchMode, a connection time limit, no terminal, the host after --, and the command true', async () => {
    const runner = sshRunner();
    await expect(checkSshLogin('me@box:2222', { runner, sshPath: '/usr/bin/ssh', env: { PATH: '/usr/bin', SSH_ASKPASS_REQUIRE: 'force' } })).resolves.toEqual({ ok: true });
    const [file, args, options] = runner.run.mock.calls[0];
    expect(file).toBe('/usr/bin/ssh');
    expect(args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-p', '2222', '-l', 'me', '--', 'box', 'true']);
    expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
    expect(options?.timeoutMs).toBe(30_000);
    await checkSshLogin('me@[2001:db8::1]:22', { runner, sshPath: '/usr/bin/ssh', env: {} });
    expect(runner.run.mock.calls[1][1]).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-p', '22', '-l', 'me', '--', '2001:db8::1', 'true']);
  });

  it.each([
    ['Host key verification failed.', 'hostKey'],
    ['me@box: Permission denied (publickey,password).', 'login'],
    ['ssh: Could not resolve hostname box: Name or service not known', 'unreachable'],
    ['ssh: connect to host box port 22: Connection timed out', 'unreachable'],
    ['Connection closed by 192.0.2.10 port 22', 'closedBeforeLogin'],
  ])('names the reason of %s: %s', async (stderr, problem) => {
    const runner = sshRunner('', { exitCode: 255, stdout: '', stderr, timedOut: false });
    await expect(checkSshLogin('box', { runner, sshPath: '/usr/bin/ssh', env: {} })).resolves.toEqual({ ok: false, problem, detail: stderr });
  });

  it('counts a time-out as unreachable, and fails without ssh', async () => {
    const runner = sshRunner('', { exitCode: null, stdout: '', stderr: '', timedOut: true });
    await expect(checkSshLogin('box', { runner, sshPath: '/usr/bin/ssh', env: {} })).resolves.toMatchObject({ ok: false, problem: 'unreachable' });
    await expect(checkSshLogin('box', { runner, sshPath: undefined, env: {} })).resolves.toMatchObject({ ok: false, problem: 'sshMissing' });
  });

  it('leaves a host that is no SSH alias or address to the Docker CLI', async () => {
    const runner = sshRunner();
    await expect(checkSshLogin('me@box/path', { runner, sshPath: '/usr/bin/ssh', env: {} })).resolves.toEqual({ ok: true, skipped: 'notAnSshTarget' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('keeps a success for a minute per host, never a failure', async () => {
    let now = 1_000_000;
    const sshLogins = new SshLoginCache({ now: () => now });
    const runner = sshRunner();
    const deps = { runner, sshPath: '/usr/bin/ssh', env: {}, sshLogins };
    await checkSshLogin('box', deps);
    await checkSshLogin('box', deps);
    expect(runner.run).toHaveBeenCalledTimes(1);
    await checkSshLogin('other', deps);
    expect(runner.run).toHaveBeenCalledTimes(2);
    now += SSH_CHECK_CACHE_MS;
    await checkSshLogin('box', deps);
    expect(runner.run).toHaveBeenCalledTimes(3);
    // A failure is not kept, and ends a kept success.
    runner.run.mockImplementation(async () => fail('Permission denied (publickey).', 255));
    await expect(checkSshLogin('box', deps, { useCache: false })).resolves.toMatchObject({ ok: false, problem: 'login' });
    await expect(checkSshLogin('box', deps)).resolves.toMatchObject({ ok: false, problem: 'login' });
    expect(runner.run).toHaveBeenCalledTimes(5);
  });

  it('runs before docker -H ssh://… info of the test, always connects, and stops at its failure', async () => {
    const sshLogins = new SshLoginCache();
    sshLogins.remember('box');
    const docker = fakeDocker(() => info());
    const failing = sshRunner('', fail('Host key verification failed.', 255));
    await expect(testRemoteDockerHost(docker, 'box', { ...sshDeps(failing), sshLogins })).resolves.toEqual({
      ok: false,
      problem: 'hostKey',
      detail: 'Host key verification failed.',
    });
    expect(failing.run).toHaveBeenCalledTimes(1);
    expect(docker.calls).toEqual([]);
  });

  it('runs before docker info of each operation (a success of the last minute counts), and stops at its failure', async () => {
    const target = { kind: 'remote' as const, host: 'me@box:2222', endpoint: 'ssh://me@box:2222', context: remoteContextName('me@box:2222') };
    const docker = fakeDocker(() => info());
    const runner = sshRunner();
    const sshLogins = new SshLoginCache();
    const deps = { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {}, sshLogins };
    await ensureDockerHostReachable(target, deps);
    await ensureDockerHostReachable(target, deps);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(docker.calls).toHaveLength(2);
    sshLogins.forget('me@box:2222');
    runner.run.mockImplementation(async () => fail('Host key verification failed.', 255));
    await expect(ensureDockerHostReachable(target, deps)).rejects.toMatchObject({
      code: 'dockerHostUnreachable',
      message: Messages.dockerHostUnreachable('me@box:2222', dockerHostReason('hostKey', 'me@box:2222')),
    });
    expect(docker.calls).toHaveLength(2);
  });
});

describe('readRootlessSocket', () => {
  it('asks ssh with BatchMode for XDG_RUNTIME_DIR; the host after --', async () => {
    const runner = { run: vi.fn(async (_file: string, _args: readonly string[], _options?: RunOptions) => ok('/run/user/1001')) };
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', 'me@box:2222', { PATH: '/usr/bin' })).resolves.toEqual({
      ok: true,
      socket: '/run/user/1001/docker.sock',
    });
    const [file, args, options] = runner.run.mock.calls[0];
    expect(file).toBe('/usr/bin/ssh');
    expect(args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-p', '2222', '-l', 'me', '--', 'box', 'printf %s "$XDG_RUNTIME_DIR"']);
    expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
  });

  it('fails without ssh, for an unusable host, and without XDG_RUNTIME_DIR', async () => {
    const runner = { run: vi.fn(async () => ok('')) };
    await expect(readRootlessSocket(runner, undefined, 'box', {})).resolves.toMatchObject({ ok: false, problem: 'sshMissing' });
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', 'box/path', {})).resolves.toMatchObject({ ok: false, problem: 'unknown' });
    await expect(readRootlessSocket(runner, '/usr/bin/ssh', 'box', {})).resolves.toMatchObject({ ok: false, problem: 'unknown' });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});

describe('ensureDockerHostReachable (the Docker start of a remote host)', () => {
  const target = { kind: 'remote' as const, host: 'box', endpoint: 'ssh://box', context: 'devenv-remote' };

  it('asks docker info through the current context; a rootful engine has no recorded socket', async () => {
    await state.setRootlessSocket('box', '/run/user/1000/docker.sock');
    const docker = fakeDocker(() => info(false));
    const runner = sshRunner();
    await ensureDockerHostReachable(target, { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {} });
    expect(docker.calls.map((call) => call.args)).toEqual([['info', '--format', ENGINE_INFO_FORMAT]]);
    // review, C3: only the ssh check runs (before: no ssh call at all); no read of a socket.
    expect(runner.run.mock.calls.map((call) => call[1])).toEqual([['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '--', 'box', 'true']]);
    expect(await state.rootlessSocket('box')).toBeUndefined();
  });

  it('records the socket of a rootless engine once', async () => {
    const docker = fakeDocker(() => info(true));
    const runner = sshRunner('/run/user/1000');
    const deps = { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {} };
    await ensureDockerHostReachable(target, deps);
    await ensureDockerHostReachable(target, deps);
    // review, C3: the ssh checks are not counted here (before: every ssh call was the read of the socket).
    expect(runner.run.mock.calls.filter((call) => !isSshCheck(call[1]))).toHaveLength(1);
    expect(await state.rootlessSocket('box')).toBe('/run/user/1000/docker.sock');
  });

  it('throws dockerHostUnreachable with the plain reason', async () => {
    const docker = fakeDocker(() => fail('me@box: Permission denied (publickey).'));
    // review, C3: with ssh (before: without it, which the ssh check now reports as sshMissing).
    const error = await ensureDockerHostReachable(target, { docker, runner: sshRunner(), state, logger, sshPath: '/usr/bin/ssh', env: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as UserFacingError).code).toBe('dockerHostUnreachable');
    expect((error as UserFacingError).message).toBe(Messages.dockerHostUnreachable('box', dockerHostReason('login', 'box')));
    expect((error as UserFacingError).detail).toContain('Permission denied');
  });

  it('checkCurrentEngine passes the signal and never adds -H', async () => {
    const docker = fakeDocker(() => info());
    const signal = new AbortController().signal;
    await checkCurrentEngine(docker, { signal });
    expect(docker.calls[0].options?.signal).toBe(signal);
    expect(docker.calls[0].args).not.toContain('-H');
  });
});

describe('startDockerFor (remote mode skips the Docker Desktop start)', () => {
  it('starts the local Docker as before', async () => {
    const startLocal = vi.fn(async () => {});
    const docker = fakeDocker(() => info());
    await startDockerFor({ kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock' }, startLocal, {
      docker,
      runner: { run: vi.fn() },
      state,
      logger,
      sshPath: undefined,
      env: {},
    });
    expect(startLocal).toHaveBeenCalledTimes(1);
    expect(docker.calls).toEqual([]);
  });

  it('only checks a remote host: no Docker Desktop start, no desktop command', async () => {
    const startLocal = vi.fn(async () => {});
    const docker = fakeDocker(() => fail('ssh: connect to host box port 22: Connection refused'));
    const runner = sshRunner();
    await expect(
      startDockerFor({ kind: 'remote', host: 'box', endpoint: 'ssh://box' }, startLocal, { docker, runner, state, logger, sshPath: '/usr/bin/ssh', env: {} }),
    ).rejects.toMatchObject({ code: 'dockerHostUnreachable', message: Messages.dockerHostUnreachable('box', dockerHostReason('unreachable', 'box')) });
    expect(startLocal).not.toHaveBeenCalled();
    // review, C3: the ssh check ran (before: no ssh call); nothing else.
    expect(runner.run.mock.calls.every((call) => isSshCheck(call[1]))).toBe(true);
    expect(docker.calls.flatMap((call) => call.args)).not.toContain('desktop');
  });

  it('refuses an endpoint that is neither local nor SSH', async () => {
    const startLocal = vi.fn(async () => {});
    const docker = fakeDocker(() => info());
    await expect(
      startDockerFor({ kind: 'unsupported', host: 'tcp://box:2376', endpoint: 'tcp://box:2376' }, startLocal, {
        docker,
        runner: { run: vi.fn() },
        state,
        logger,
        sshPath: undefined,
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.dockerEndpointUnsupported('tcp://box:2376') });
    expect(startLocal).not.toHaveBeenCalled();
    expect(docker.calls).toEqual([]);
  });
});

describe('the Docker context commands', () => {
  it('creates the context of the host and uses it, without DOCKER_CONTEXT in their environment', async () => {
    const docker = fakeDocker((args) => (args[1] === 'ls' ? ok('default\ndesktop-linux\n') : ok('')));
    const name = remoteContextName('me@box');
    await expect(useRemoteContext(docker, 'me@box')).resolves.toBe(name);
    // review, C1: a context per host (before: `devenv-remote` for every host).
    expect(docker.calls.map((call) => call.args)).toEqual([
      ['context', 'ls', '--format', '{{.Name}}'],
      ['context', 'create', name, '--description', 'Dev Environments: remote Docker host me@box', '--docker', 'host=ssh://me@box'],
      ['context', 'use', name],
    ]);
    for (const call of docker.calls) expect(call.options?.env).not.toHaveProperty('DOCKER_CONTEXT');
  });

  it('never changes the context of a host that exists; it only uses it (review, C1)', async () => {
    // review, C1: before, `docker context update devenv-remote` moved the context to the new host.
    const name = remoteContextName('other');
    const docker = fakeDocker((args) => {
      if (args[1] === 'ls') return ok(`default\n${name}\n`);
      if (args[1] === 'inspect') return ok(JSON.stringify({ Name: name, Endpoints: { docker: { Host: 'ssh://other' } } }));
      return ok('');
    });
    await useRemoteContext(docker, 'other');
    expect(docker.calls.map((call) => call.args[1])).toEqual(['ls', 'inspect', 'use']);
    expect(docker.calls[1].args).toEqual(['context', 'inspect', name, '--format', '{{json .}}']);
    expect(docker.calls.map((call) => call.args[1])).not.toContain('update');
  });

  it('refuses one of its names that points to another endpoint, and changes nothing', async () => {
    const name = remoteContextName('other');
    const docker = fakeDocker((args) => {
      if (args[1] === 'ls') return ok(`${name}\n`);
      if (args[1] === 'inspect') return ok(JSON.stringify({ Name: name, Endpoints: { docker: { Host: 'ssh://elsewhere' } } }));
      return ok('');
    });
    await expect(useRemoteContext(docker, 'other')).rejects.toThrow(`docker context rm ${name}`);
    expect(docker.calls.map((call) => call.args[1])).toEqual(['ls', 'inspect']);
  });

  it('names each host differently, with a valid context name', () => {
    const names = ['box', 'me@box', 'me@box:2222', 'me@[2001:db8::1]:22', 'gpu'].map(remoteContextName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^devenv-remote-[0-9a-f]{8}$/);
    // sha256("box") = 26f8567f…
    expect(remoteContextName('box')).toBe('devenv-remote-26f8567f');
    expect(remoteContextName('box')).toBe(remoteContextName('box'));
  });

  it('throws when a command fails', async () => {
    const docker = fakeDocker(() => fail('context "x" does not exist'));
    await expect(useContext(docker, 'x')).rejects.toThrow('docker context use x failed: context "x" does not exist');
    await expect(listContexts(docker)).rejects.toThrow('docker context ls');
  });

  it('goes back to the remembered context, else default', () => {
    expect(localContextChoice('desktop-linux', ['default', 'desktop-linux', 'devenv-remote'])).toBe('desktop-linux');
    expect(localContextChoice('gone', ['default'])).toBe('default');
    expect(localContextChoice(undefined, ['default', 'desktop-linux'])).toBe('default');
    expect(localContextChoice('devenv-remote', ['default', 'devenv-remote'])).toBe('default');
    // review, C1: every context of ours.
    expect(localContextChoice(remoteContextName('box'), ['default', remoteContextName('box')])).toBe('default');
  });

  it('goes back to a remembered context only when it points to the local Docker (review, C2)', async () => {
    const endpoints: Record<string, string> = {
      default: 'unix:///var/run/docker.sock',
      'desktop-linux': 'unix:///home/me/.docker/desktop/docker.sock',
      mybox: 'ssh://me@mybox',
      tcpbox: 'tcp://10.0.0.5:2375',
      loop: 'tcp://127.0.0.1:2375',
    };
    const docker = fakeDocker((args) => {
      if (args[1] === 'ls') return ok(`${Object.keys(endpoints).join('\n')}\n`);
      if (args[1] === 'inspect') return ok(JSON.stringify({ Name: args[2], Endpoints: { docker: { Host: endpoints[args[2]] } } }));
      return fail('unexpected');
    });
    await expect(chooseLocalContext(docker, 'desktop-linux')).resolves.toBe('desktop-linux');
    await expect(chooseLocalContext(docker, 'loop')).resolves.toBe('loop');
    await expect(chooseLocalContext(docker, 'mybox')).resolves.toBe('default');
    await expect(chooseLocalContext(docker, 'tcpbox')).resolves.toBe('default');
    await expect(chooseLocalContext(docker, undefined)).resolves.toBe('default');
    const unreadable = fakeDocker((args) => (args[1] === 'ls' ? ok('default\nx\n') : fail('no')));
    await expect(chooseLocalContext(unreadable, 'x')).resolves.toBe('default');
  });

  it('names DOCKER_HOST or DOCKER_CONTEXT set for VS Code', () => {
    expect(dockerVariableOverride({}, 'linux')).toBeUndefined();
    expect(dockerVariableOverride({ DOCKER_HOST: 'unix:///x' }, 'linux')).toBe('DOCKER_HOST');
    expect(dockerVariableOverride({ DOCKER_CONTEXT: 'x' }, 'linux')).toBe('DOCKER_CONTEXT');
    expect(dockerVariableOverride({ docker_host: 'x' }, 'win32')).toBe('DOCKER_HOST');
    expect(dockerVariableOverride({ DOCKER_HOST: ' ' }, 'linux')).toBeUndefined();
  });
});

describe('RemoteDockerState', () => {
  it('remembers the previous context and the rootless sockets per host', async () => {
    expect(await state.read()).toEqual({});
    await state.setPreviousContext('desktop-linux');
    await state.setRootlessSocket('box', '/run/user/1000/docker.sock');
    await state.setRootlessSocket('__proto__', '/run/user/1/docker.sock');
    expect(await state.previousContext()).toBe('desktop-linux');
    expect(await state.rootlessSocket('box')).toBe('/run/user/1000/docker.sock');
    expect(await state.rootlessSocket('__proto__')).toBe('/run/user/1/docker.sock');
    expect(await state.rootlessSocket('other')).toBeUndefined();
    await state.setRootlessSocket('box', undefined);
    await state.setPreviousContext(undefined);
    expect(await state.read()).toEqual({ hosts: [{ host: '__proto__', rootlessSocket: '/run/user/1/docker.sock' }] });
  });

  it('ignores invalid content', async () => {
    fs.writeFileSync(state.file, JSON.stringify({ previousContext: 3, hosts: [{ host: 'a', rootlessSocket: 'relative' }, 'x', { host: '' }] }));
    expect(await state.read()).toEqual({ hosts: [{ host: 'a' }] });
  });
});
