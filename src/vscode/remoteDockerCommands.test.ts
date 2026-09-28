// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { dockerTargetOf, remoteContextName } from '../core/docker/dockerHost';
import { runWithDockerTarget } from '../core/docker/dockerTargets';
import { ENGINE_INFO_FORMAT } from '../core/docker/remoteDocker';
import { Messages, dockerHostReason } from '../core/messages';
import type { RunOptions, RunResult } from '../core/ports';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { RemoteDockerCommands, RemoteDockerTexts, describeEntry } from './remoteDockerCommands';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string): RunResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false });

/**
 * A Docker CLI with contexts: `context ls|create|update|use|inspect`, and `info` (with -H: the tested host; without:
 * the current context). `hosts` answers per ssh host.
 */
class FakeCli {
  readonly calls: Array<{ args: string[]; options?: RunOptions }> = [];
  contexts = new Map<string, string>([
    ['default', 'unix:///var/run/docker.sock'],
    ['desktop-linux', 'unix:///home/me/.docker/desktop/docker.sock'],
  ]);
  current = 'desktop-linux';
  hosts = new Map<string, RunResult>();

  isInstalled = () => true;
  processEnv = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent' });

  run = async (args: readonly string[], options?: RunOptions): Promise<RunResult> => {
    this.calls.push({ args: [...args], options });
    if (args[0] === '-H') return this.hosts.get(args[1].slice('ssh://'.length)) ?? fail('ssh: Could not resolve hostname');
    if (args[0] !== 'context') return ok();
    switch (args[1]) {
      case 'ls':
        return ok(`${[...this.contexts.keys()].join('\n')}\n`);
      case 'create':
      case 'update':
        this.contexts.set(args[2], args[args.length - 1].replace(/^host=/, ''));
        return ok();
      case 'use':
        if (!this.contexts.has(args[2])) return fail(`context "${args[2]}" does not exist`);
        this.current = args[2];
        return ok();
      case 'inspect': {
        // `context inspect [<name>] --format …`: the named context, else the current one.
        const name = args[2] !== '--format' ? args[2] : this.current;
        if (!this.contexts.has(name)) return fail(`context "${name}" does not exist`);
        return ok(JSON.stringify({ Name: name, Endpoints: { docker: { Host: this.contexts.get(name) } } }));
      }
    }
    return fail('unknown');
  };

  get changes(): string[][] {
    return this.calls.filter((call) => call.args[0] === 'context' && ['create', 'update', 'use'].includes(call.args[1])).map((call) => call.args);
  }
}

/** The ssh check before the Docker calls (review, C3): `ssh … -- <host> true`. */
const isSshCheck = (args: readonly string[]): boolean => args[args.length - 1] === 'true';
const BUILD_BOX = remoteContextName('build-box');
const GPU = remoteContextName('gpu');

const engineInfo = (rootless = false): RunResult =>
  ok(JSON.stringify({ version: '28.1.0', securityOptions: rootless ? ['name=rootless'] : ['name=seccomp,profile=builtin'] }));

let dir: string;
let cli: FakeCli;
let state: RemoteDockerState;
let runner: { run: ReturnType<typeof vi.fn> };
let onDidSwitch: ReturnType<typeof vi.fn>;
let showLog: ReturnType<typeof vi.fn>;
let env: NodeJS.ProcessEnv;
let commands: RemoteDockerCommands;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
const { window } = fakeVscode;

function create(): RemoteDockerCommands {
  return new RemoteDockerCommands({
    docker: cli,
    runner,
    targets: {
      resolve: async () => {
        const result = await cli.run(['context', 'inspect', '--format', '{{json .}}']);
        const parsed = JSON.parse(result.stdout) as { Name: string; Endpoints: { docker: { Host: string } } };
        return dockerTargetOf(parsed.Endpoints.docker.Host, parsed.Name);
      },
    },
    state,
    logger,
    showLog,
    sshHosts: () => [
      { alias: 'build-box', hostName: 'build-box.example.com', user: 'me' },
      { alias: 'gpu', port: '2222' },
    ],
    sshPath: () => '/usr/bin/ssh',
    env,
    platform: 'linux',
    onDidSwitch,
  });
}

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-ui-'));
  cli = new FakeCli();
  state = new RemoteDockerState(path.join(dir, 'remote-docker.json'));
  runner = { run: vi.fn(async () => ok('/run/user/1000')) };
  onDidSwitch = vi.fn(async () => {});
  showLog = vi.fn();
  env = { PATH: '/usr/bin' };
  window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  );
  commands = create();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The user picks `label` in the quick pick, and answers the modal with `answer`. */
function answer(label: string, confirm: 'yes' | 'no' = 'yes'): void {
  window.showQuickPick.mockImplementation(async (items: Array<{ label: string }>) => items.find((item) => item.label === label));
  window.showWarningMessage.mockImplementation(async (_message: string, _options: unknown, button: string) => (confirm === 'yes' ? button : undefined));
}

describe('Use a Remote Docker Host…', () => {
  it('lists the hosts of the SSH config with HostName and User, and "Enter an SSH address…" last', async () => {
    await commands.useRemoteHost();
    const [items, options] = window.showQuickPick.mock.calls[0] as [Array<{ label: string; description?: string; kind?: number }>, { title: string }];
    expect(items.map((item) => [item.label, item.description])).toEqual([
      ['build-box', 'me@build-box.example.com'],
      ['gpu', 'gpu:2222'],
      ['', undefined],
      [RemoteDockerTexts.enterAddress, RemoteDockerTexts.enterAddressDetail],
    ]);
    expect(items[2].kind).toBe(fakeVscode.QuickPickItemKind.Separator);
    expect(options.title).toBe('Use a Remote Docker Host');
    // Cancelled: nothing ran.
    expect(cli.calls).toEqual([]);
  });

  it('tests the host, asks in a modal, remembers the context, then creates and uses the context of the host', async () => {
    cli.hosts.set('build-box', engineInfo());
    answer('build-box');
    await commands.useRemoteHost();
    // The test: docker -H ssh://build-box info, without questions.
    const test = cli.calls.find((call) => call.args[0] === '-H');
    expect(test?.args).toEqual(['-H', 'ssh://build-box', 'info', '--format', ENGINE_INFO_FORMAT]);
    expect(test?.options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
    // The modal.
    // User decision 2026-09-28 ("don't show again" for all Docker warnings): the second button "…, Don't Ask Again".
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'All Docker tools on this computer will use build-box until you switch back.',
      expect.objectContaining({ modal: true }),
      'Use build-box',
      "Use build-box, Don't Ask Again",
    );
    // review, C1: the context of this host (before: `devenv-remote` for every host).
    expect(cli.changes).toEqual([
      ['context', 'create', BUILD_BOX, '--description', 'Dev Environments: remote Docker host build-box', '--docker', 'host=ssh://build-box'],
      ['context', 'use', BUILD_BOX],
    ]);
    expect(await state.previousContext()).toBe('desktop-linux');
    expect(window.showInformationMessage).toHaveBeenCalledWith('Docker now uses build-box.');
    expect(onDidSwitch).toHaveBeenCalledTimes(1);
    // review, C3: our own ssh only for the check before the test (before: no ssh of our own for a rootful engine).
    expect(runner.run.mock.calls.map((call) => (call as [string, string[]])[1])).toEqual([
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '--', 'build-box', 'true'],
    ]);
    const check = cli.calls.findIndex((call) => call.args[0] === '-H');
    expect(check).toBeGreaterThanOrEqual(0);
  });

  it('changes nothing when the modal is cancelled', async () => {
    cli.hosts.set('build-box', engineInfo());
    answer('build-box', 'no');
    await commands.useRemoteHost();
    expect(cli.changes).toEqual([]);
    expect(await state.previousContext()).toBeUndefined();
    expect(onDidSwitch).not.toHaveBeenCalled();
  });

  it('shows the plain reason and changes nothing when the host cannot be used', async () => {
    cli.hosts.set('build-box', fail('Host key verification failed.'));
    answer('build-box');
    window.showErrorMessage.mockResolvedValue('Show details');
    await commands.useRemoteHost();
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      Messages.dockerHostUnreachable('build-box', dockerHostReason('hostKey', 'build-box')),
      'Show details',
    );
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(cli.changes).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showLog).toHaveBeenCalledTimes(1);
  });

  it('takes a typed SSH address after validation, and never changes an existing context (review, C1)', async () => {
    cli.contexts.set('devenv-remote', 'ssh://old');
    cli.hosts.set('me@192.0.2.10:2222', engineInfo());
    answer(RemoteDockerTexts.enterAddress);
    window.showInputBox.mockImplementation(async (options: { validateInput: (value: string) => string | undefined }) => {
      expect(options.validateInput('-oProxyCommand=x')).toBe(RemoteDockerTexts.addressProblem('option'));
      expect(options.validateInput('me@2001:db8::1')).toBe(RemoteDockerTexts.addressProblem('ipv6'));
      expect(options.validateInput('me@192.0.2.10:2222')).toBeUndefined();
      return ' me@192.0.2.10:2222 ';
    });
    await commands.useRemoteHost();
    // review, C1: the context of this host is created; `devenv-remote` of an earlier build stays as it is (before: updated).
    const name = remoteContextName('me@192.0.2.10:2222');
    expect(cli.changes[0]).toEqual([
      'context',
      'create',
      name,
      '--description',
      'Dev Environments: remote Docker host me@192.0.2.10:2222',
      '--docker',
      'host=ssh://me@192.0.2.10:2222',
    ]);
    expect(cli.contexts.get('devenv-remote')).toBe('ssh://old');
    expect(cli.current).toBe(name);
  });

  it('keeps the first remembered context when it switches from one remote host to another', async () => {
    cli.hosts.set('build-box', engineInfo());
    cli.hosts.set('gpu', engineInfo());
    answer('build-box');
    await commands.useRemoteHost();
    answer('gpu');
    await commands.useRemoteHost();
    // review, C1: each host has its context (before: `devenv-remote` pointed to gpu now).
    expect(cli.contexts.get(BUILD_BOX)).toBe('ssh://build-box');
    expect(cli.contexts.get(GPU)).toBe('ssh://gpu');
    expect(cli.current).toBe(GPU);
    expect(await state.previousContext()).toBe('desktop-linux');
  });

  it('a switch from host A to host B leaves an operation that runs on A on A (review, C1)', async () => {
    cli.hosts.set('build-box', engineInfo());
    cli.hosts.set('gpu', engineInfo());
    answer('build-box');
    await commands.useRemoteHost();
    // An operation of another window started on build-box: its Docker calls name the context it read (ContainerAdapter).
    const pinned = dockerTargetOf(cli.contexts.get(cli.current) ?? '', cli.current);
    await runWithDockerTarget(pinned, async () => {
      answer('gpu');
      await commands.useRemoteHost();
    });
    expect(cli.current).toBe(GPU);
    expect(pinned.context).toBe(BUILD_BOX);
    // The context that the operation names still points to build-box: its next Docker calls stay there.
    expect(cli.contexts.get(pinned.context as string)).toBe('ssh://build-box');
    expect(cli.changes.filter((change) => change[2] === BUILD_BOX)).toEqual([
      ['context', 'create', BUILD_BOX, '--description', 'Dev Environments: remote Docker host build-box', '--docker', 'host=ssh://build-box'],
      ['context', 'use', BUILD_BOX],
    ]);
  });

  it('a second switch to the same host uses its context again without changing it', async () => {
    cli.hosts.set('build-box', engineInfo());
    cli.hosts.set('gpu', engineInfo());
    answer('build-box');
    await commands.useRemoteHost();
    answer('gpu');
    await commands.useRemoteHost();
    answer('build-box');
    await commands.useRemoteHost();
    expect(cli.current).toBe(BUILD_BOX);
    expect(cli.changes.filter((change) => change[1] !== 'use').map((change) => change[2])).toEqual([BUILD_BOX, GPU]);
  });

  it('checks the SSH login first (BatchMode) and does not ask Docker when it fails (review, C3)', async () => {
    cli.hosts.set('build-box', engineInfo());
    answer('build-box');
    runner.run.mockImplementation(async (_file: string, args: string[]) =>
      isSshCheck(args) ? { exitCode: 255, stdout: '', stderr: 'Host key verification failed.', timedOut: false } : ok('/run/user/1000'),
    );
    await commands.useRemoteHost();
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      Messages.dockerHostUnreachable('build-box', dockerHostReason('hostKey', 'build-box')),
      'Show details',
    );
    expect(cli.calls.filter((call) => call.args[0] === '-H')).toEqual([]);
    expect(cli.changes).toEqual([]);
  });

  it('records the socket of a rootless engine (read once with ssh, BatchMode) before the switch', async () => {
    cli.hosts.set('build-box', engineInfo(true));
    answer('build-box');
    await commands.useRemoteHost();
    // review, C3: the ssh check runs first (before: the read of the socket was the only ssh call).
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(isSshCheck((runner.run.mock.calls[0] as [string, string[]])[1])).toBe(true);
    const [file, args] = runner.run.mock.calls[1] as [string, string[]];
    expect(file).toBe('/usr/bin/ssh');
    expect(args).toContain('BatchMode=yes');
    expect(args.slice(-3)).toEqual(['--', 'build-box', 'printf %s "$XDG_RUNTIME_DIR"']);
    expect(await state.rootlessSocket('build-box')).toBe('/run/user/1000/docker.sock');
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.nowRemote('build-box', true));
  });

  // Review of the sidebar host (S1): without a Docker CLI on this computer, the missing CLI is the reason, not the host.
  it('names the missing Docker CLI of this computer before it asks for a host', async () => {
    cli.isInstalled = () => false;
    await commands.useRemoteHost();
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(window.showErrorMessage.mock.calls[0]?.[0]).toBe(RemoteDockerTexts.cliMissing);
    expect(cli.calls).toEqual([]);
  });

  it('refuses while DOCKER_HOST is set for VS Code (the context would have no effect)', async () => {
    env.DOCKER_HOST = 'unix:///var/run/docker.sock';
    commands = create();
    await commands.useRemoteHost();
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(window.showErrorMessage).toHaveBeenCalledWith(RemoteDockerTexts.variableSet('DOCKER_HOST'), 'Show details');
    expect(cli.calls).toEqual([]);
  });
});

// User request 2026-09-28: the title-bar icon of the view while Docker is set to a remote host.
describe('Remote Docker Host… (the choice of the title bar)', () => {
  it('names the current host and runs "Use a Remote Docker Host…" or "Use the Local Docker"', async () => {
    cli.contexts.set(BUILD_BOX, 'ssh://build-box');
    cli.current = BUILD_BOX;
    const choose = commands.chooseDockerHost.bind(commands);
    const useRemote = vi.spyOn(commands, 'useRemoteHost').mockResolvedValue();
    const useLocal = vi.spyOn(commands, 'useLocalDocker').mockResolvedValue();
    window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string }>) => items[0]);
    await choose();
    window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string }>) => items[1]);
    await choose();
    const [items, options] = window.showQuickPick.mock.calls[0] as [Array<{ label: string }>, { title: string }];
    expect(items.map((item) => item.label)).toEqual([`$(remote) ${RemoteDockerTexts.useAnotherHost}`, `$(vm) ${RemoteDockerTexts.useLocal}`]);
    expect(options.title).toBe('Docker host: build-box');
    expect(useRemote).toHaveBeenCalledTimes(1);
    expect(useLocal).toHaveBeenCalledTimes(1);
  });

  // Review of the sidebar host (S5).
  it('explains DOCKER_HOST first instead of offering choices that are refused', async () => {
    env.DOCKER_HOST = 'ssh://build-box';
    commands = create();
    await commands.chooseDockerHost();
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(window.showErrorMessage.mock.calls[0]?.[0]).toBe(RemoteDockerTexts.variableSet('DOCKER_HOST'));
  });

  it('changes nothing when the choice is cancelled', async () => {
    const useRemote = vi.spyOn(commands, 'useRemoteHost');
    const useLocal = vi.spyOn(commands, 'useLocalDocker');
    await commands.chooseDockerHost();
    expect(useRemote).not.toHaveBeenCalled();
    expect(useLocal).not.toHaveBeenCalled();
    expect(cli.changes).toEqual([]);
  });
});

// User decision 2026-09-28: "Don't Ask Again" for every Docker host question, and a command to be asked again.
describe("Don't Ask Again for the Docker host questions", () => {
  it('remembers "Don\'t Ask Again" for the switch to a remote host and switches without the modal next time', async () => {
    cli.hosts.set('build-box', engineInfo());
    cli.hosts.set('gpu', engineInfo());
    answer('build-box');
    window.showWarningMessage.mockImplementation(async (_message: string, _options: unknown, _button: string, always: string) => always);
    await commands.useRemoteHost();
    expect(cli.current).toBe(BUILD_BOX);
    expect(await state.dontAsk('switchToRemote')).toBe(true);
    window.showWarningMessage.mockClear();
    answer('gpu');
    window.showWarningMessage.mockClear();
    window.showWarningMessage.mockResolvedValue(undefined);
    await commands.useRemoteHost();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(cli.current).toBe(GPU);
  });

  it('asks the questions of a restored window each on its own, and skips each one that was answered so', async () => {
    cli.hosts.set('build-box', engineInfo());
    await state.setDontAsk('switchBack');
    window.showWarningMessage.mockImplementation(async (_message: string, _options: unknown, button: string) => button);
    const current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    await expect(commands.offerSwitchBack('build-box', current)).resolves.toBe(true);
    // "Use build-box again?" was skipped; the switch itself was still asked.
    expect(window.showWarningMessage.mock.calls.map((call) => call[0])).toEqual([RemoteDockerTexts.confirm('build-box')]);
    await state.setDontAsk('switchToLocal');
    window.showWarningMessage.mockClear();
    await expect(commands.offerSwitchBack('', dockerTargetOf('ssh://build-box', BUILD_BOX))).resolves.toBe(true);
    expect(window.showWarningMessage.mock.calls.map((call) => call[0])).not.toContain(RemoteDockerTexts.confirmLocal);
  });

  it('asks again after "Ask Again Before Changing the Docker Host"', async () => {
    await commands.askAgain();
    expect(window.showInformationMessage.mock.calls.at(-1)?.[0]).toBe(RemoteDockerTexts.askAgainNothing);
    await state.setDontAsk('switchToRemote');
    await state.setDontAsk('switchBack');
    await commands.askAgain();
    expect(window.showInformationMessage.mock.calls.at(-1)?.[0]).toBe(RemoteDockerTexts.askAgainDone);
    expect(await state.dontAsk('switchToRemote')).toBe(false);
    expect(await state.dontAsk('switchBack')).toBe(false);
  });
});

describe('Use the Local Docker', () => {
  it('goes back to the remembered context and forgets it', async () => {
    cli.hosts.set('build-box', engineInfo());
    answer('build-box');
    await commands.useRemoteHost();
    await commands.useLocalDocker();
    expect(cli.current).toBe('desktop-linux');
    expect(await state.previousContext()).toBeUndefined();
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('Docker now uses the local Docker (context desktop-linux).');
    expect(onDidSwitch).toHaveBeenCalledTimes(2);
  });

  it('uses the context default when the remembered context points to another computer, and says so (review, C2)', async () => {
    cli.contexts.set('mybox', 'ssh://me@mybox');
    cli.contexts.set(BUILD_BOX, 'ssh://build-box');
    cli.current = BUILD_BOX;
    await state.setPreviousContext('mybox');
    await commands.useLocalDocker();
    expect(cli.current).toBe('default');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('Docker now uses the local Docker (context default).');
  });

  it('never says "local" when the context of the switch back does not point to the local Docker (review, C2)', async () => {
    // A `default` context that is not local (for example Docker Desktop's CLI settings pointing elsewhere).
    cli.contexts.set('default', 'tcp://10.0.0.5:2375');
    cli.contexts.set(BUILD_BOX, 'ssh://build-box');
    cli.current = BUILD_BOX;
    await commands.useLocalDocker();
    expect(cli.current).toBe('default');
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).toHaveBeenCalledWith(RemoteDockerTexts.notLocal('default', 'tcp://10.0.0.5:2375'), 'Show details');
  });

  it('uses the context default when none is remembered (or it is gone)', async () => {
    cli.contexts.set('devenv-remote', 'ssh://box');
    cli.current = 'devenv-remote';
    await state.setPreviousContext('removed-context');
    await commands.useLocalDocker();
    expect(cli.current).toBe('default');
  });

  it('says so when Docker is local already', async () => {
    await commands.useLocalDocker();
    expect(cli.changes).toEqual([]);
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.alreadyLocal);
  });
});

describe('the mismatch of a restored window (offerSwitchBack)', () => {
  it('asks "Use <host> again?", then switches as the command does (test and modal)', async () => {
    cli.hosts.set('build-box', engineInfo());
    window.showWarningMessage.mockImplementation(async (_message: string, _options: unknown, button: string) => button);
    const current = dockerTargetOf('unix:///home/me/.docker/desktop/docker.sock', 'desktop-linux');
    await expect(commands.offerSwitchBack('build-box', current)).resolves.toBe(true);
    expect(window.showWarningMessage.mock.calls[0][0]).toBe(
      'This environment is on build-box, but Docker is set to the local Docker. Use build-box again?',
    );
    expect(window.showWarningMessage.mock.calls[1][0]).toBe(RemoteDockerTexts.confirm('build-box'));
    // review, C1: the context of build-box (before: `devenv-remote`).
    expect(cli.current).toBe(BUILD_BOX);
  });

  it('switches back to the local Docker for a local environment', async () => {
    cli.contexts.set('devenv-remote', 'ssh://box');
    cli.current = 'devenv-remote';
    await state.setPreviousContext('desktop-linux');
    window.showWarningMessage.mockImplementation(async (_message: string, _options: unknown, button: string) => button);
    await expect(commands.offerSwitchBack('', dockerTargetOf('ssh://box', 'devenv-remote'))).resolves.toBe(true);
    expect(window.showWarningMessage.mock.calls[0][0]).toBe(
      'This environment is on the local Docker, but Docker is set to box. Use the local Docker again?',
    );
    expect(cli.current).toBe('desktop-linux');
  });

  it('changes nothing when the user declines', async () => {
    await expect(commands.offerSwitchBack('build-box', dockerTargetOf('', 'default'))).resolves.toBe(false);
    expect(cli.calls).toEqual([]);
  });
});

describe('describeEntry', () => {
  it('shows User, HostName and Port where set', () => {
    expect(describeEntry({ alias: 'a' })).toBeUndefined();
    expect(describeEntry({ alias: 'a', user: 'me' })).toBe('me@a');
    expect(describeEntry({ alias: 'a', hostName: 'h', port: '22' })).toBe('h:22');
  });
});
