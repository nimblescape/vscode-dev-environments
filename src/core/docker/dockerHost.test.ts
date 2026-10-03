// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  classifyDockerEndpoint,
  describeDockerHost,
  dockerHostField,
  dockerHostOf,
  dockerHostProblem,
  isSshClosedBeforeLogin,
  dockerTargetOf,
  environmentsOfHost,
  isOnDockerHost,
  isOwnContextDescription,
  isRootlessEngine,
  isUsableSshAlias,
  parseContextInspect,
  parseSshAddress,
  ownContextDescription,
  remoteContextNames,
  rootlessSocketPath,
  sameDockerHost,
  sshCommandArgs,
  sshEndpoint,
  sshTargetOf,
  RUNTIME_DIR_COMMAND,
} from './dockerHost';
import { namePair } from '../namePairs';

describe('classifyDockerEndpoint (unit 7: SSH only for another computer)', () => {
  it.each([
    ['', 'local'],
    ['unix:///var/run/docker.sock', 'local'],
    ['unix:///run/user/1000/docker.sock', 'local'],
    ['unix:///Users/me/.docker/run/docker.sock', 'local'],
    ['npipe:////./pipe/docker_engine', 'local'],
    ['npipe:////./pipe/dockerDesktopLinuxEngine', 'local'],
    ['tcp://localhost:2375', 'local'],
    ['tcp://127.0.0.1:2376', 'local'],
    ['tcp://[::1]:2375', 'local'],
  ])('%s is the local Docker', (endpoint, kind) => {
    expect(classifyDockerEndpoint(endpoint)).toEqual({ kind, host: '' });
  });

  it.each([
    ['ssh://build-box', 'build-box'],
    ['ssh://me@build-box', 'me@build-box'],
    ['ssh://me@192.0.2.10:2222', 'me@192.0.2.10:2222'],
    ['ssh://me@[2001:db8::1]:22', 'me@[2001:db8::1]:22'],
    ['SSH://build-box/', 'build-box'],
  ])('%s is the remote host %s', (endpoint, host) => {
    expect(classifyDockerEndpoint(endpoint)).toEqual({ kind: 'remote', host });
  });

  it.each(['tcp://build-box:2376', 'tcp://192.0.2.10:2375', 'https://docker.example.com', 'fd://', 'build-box', 'ssh://'])(
    '%s is refused (not SSH, not local)',
    (endpoint) => {
      expect(classifyDockerEndpoint(endpoint)).toEqual({ kind: 'unsupported', host: endpoint });
    },
  );

  it('keeps the context name only when a context decides the endpoint', () => {
    expect(dockerTargetOf('ssh://box', 'devenv-remote-26f8567f')).toEqual({ kind: 'remote', host: 'box', endpoint: 'ssh://box', context: 'devenv-remote-26f8567f' });
    expect(dockerTargetOf('ssh://box', undefined)).toEqual({ kind: 'remote', host: 'box', endpoint: 'ssh://box' });
  });
});

describe('parseContextInspect', () => {
  it('reads the name and the Docker endpoint of `docker context inspect --format {{json .}}`', () => {
    const stdout = JSON.stringify({
      Name: 'devenv-remote-26f8567f',
      Metadata: { Description: 'x' },
      Endpoints: { docker: { Host: 'ssh://build-box', SkipTLSVerify: false } },
    });
    expect(parseContextInspect(`${stdout}\n`)).toEqual({ name: 'devenv-remote-26f8567f', endpoint: 'ssh://build-box' });
  });

  it('reads the first entry of a list, and gives an empty endpoint when none is set', () => {
    expect(parseContextInspect(JSON.stringify([{ Name: 'default', Endpoints: {} }]))).toEqual({ name: 'default', endpoint: '' });
  });

  it.each(['', 'not json', '{}', '[]', 'null', '{"Name": 3}'])('refuses %j', (stdout) => {
    expect(parseContextInspect(stdout)).toBeUndefined();
  });
});

// User decisions 2026-10-03: the contexts are named after the SSH host and recognised as ours by their description
// (replaces the tests of remoteContextName and isOwnRemoteContext).
describe('remoteContextNames (the names of the context of a remote host)', () => {
  it('takes an alias as it is, the pair of the host only for the second name', () => {
    expect(remoteContextNames('htldvm')).toEqual(['htldvm', `htldvm-${namePair('htldvm')}`]);
    expect(remoteContextNames('build_box.lan+1')).toEqual(['build_box.lan+1', `build_box.lan+1-${namePair('build_box.lan+1')}`]);
  });

  it('takes the host of an address, without the user and the port; the pair is of the whole address', () => {
    expect(remoteContextNames('me@htldvm:2222')).toEqual(['htldvm', `htldvm-${namePair('me@htldvm:2222')}`]);
    expect(remoteContextNames('me@htldvm')[0]).toBe('htldvm');
    expect(remoteContextNames('htldvm:2222')[0]).toBe('htldvm');
    // Same base name, different hosts: the second names differ.
    expect(remoteContextNames('me@htldvm:2222')[1]).not.toBe(remoteContextNames('htldvm')[1]);
  });

  it('turns characters that Docker does not allow into "-"', () => {
    const [name] = remoteContextNames('me@[fe80::1]:22');
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/);
    expect(name).toBe('fe80-1');
    expect(remoteContextNames('höst~name')[0]).toBe('h-st-name');
    expect(remoteContextNames('-.box')[0]).toBe('box');
  });

  it("gives 'remote' for an empty name or the name 'default'", () => {
    expect(remoteContextNames('default')).toEqual(['remote', `remote-${namePair('default')}`]);
    expect(remoteContextNames('me@default')[0]).toBe('remote');
    expect(remoteContextNames('')[0]).toBe('remote');
    expect(remoteContextNames('~~~')[0]).toBe('remote');
  });
});

describe('ownContextDescription and isOwnContextDescription (the contexts of "Use a Remote Docker Host…")', () => {
  it('names the host in the description', () => {
    expect(ownContextDescription('me@htldvm:2222')).toBe('Dev Environments: remote Docker host me@htldvm:2222');
  });

  it('is true only for a description that Dev Environments wrote, whatever the name of the context', () => {
    expect(isOwnContextDescription(ownContextDescription('box'))).toBe(true);
    expect(isOwnContextDescription(undefined)).toBe(false);
    expect(isOwnContextDescription('')).toBe(false);
    expect(isOwnContextDescription('Docker Desktop')).toBe(false);
    expect(isOwnContextDescription('my box: Dev Environments: remote Docker host box')).toBe(false);
  });
});

describe('the Docker host of environments (registry filter)', () => {
  const local = { id: 'a', dockerHost: undefined };
  const box = { id: 'b', dockerHost: 'build-box' };
  const boxAddress = { id: 'c', dockerHost: 'me@build-box' };

  it('a missing field is the local Docker (greenfield, no migration)', () => {
    expect(dockerHostOf(local)).toBe('');
    expect(isOnDockerHost(local, '')).toBe(true);
    expect(isOnDockerHost(local, 'build-box')).toBe(false);
  });

  it('shows only the environments of the current host; two names of one computer are two hosts', () => {
    const all = [local, box, boxAddress];
    expect(environmentsOfHost(all, '')).toEqual([local]);
    expect(environmentsOfHost(all, 'build-box')).toEqual([box]);
    expect(environmentsOfHost(all, 'me@build-box')).toEqual([boxAddress]);
    expect(environmentsOfHost(all, 'other')).toEqual([]);
    expect(sameDockerHost(undefined, '')).toBe(true);
    expect(sameDockerHost('build-box', 'Build-Box')).toBe(false);
  });

  it('a new local environment gets no field; a remote one its host', () => {
    expect(dockerHostField('')).toEqual({});
    expect(dockerHostField('build-box')).toEqual({ dockerHost: 'build-box' });
    expect(describeDockerHost('')).toBe('the local Docker');
    expect(describeDockerHost('build-box')).toBe('build-box');
  });
});

describe('parseSshAddress (Enter an SSH address…)', () => {
  it.each([
    ['me@build-box', 'me@build-box', { user: 'me', host: 'build-box' }],
    ['build-box.example.com', 'build-box.example.com', { host: 'build-box.example.com' }],
    ['  me@192.0.2.10:2222  ', 'me@192.0.2.10:2222', { user: 'me', host: '192.0.2.10', port: 2222 }],
    ['me@[2001:db8::1]:22', 'me@[2001:db8::1]:22', { user: 'me', host: '2001:db8::1', port: 22 }],
    ['[::1]', '[::1]', { host: '::1' }],
    ['ssh://me@build-box', 'me@build-box', { user: 'me', host: 'build-box' }],
    ['first.last@box', 'first.last@box', { user: 'first.last', host: 'box' }],
  ])('accepts %j as %s', (text, address, parts) => {
    expect(parseSshAddress(text)).toEqual({ ok: true, address, parts });
  });

  it.each([
    ['', 'empty'],
    ['me@build box', 'spaces'],
    ['-oProxyCommand=evil', 'option'],
    ['me@box/path', 'path'],
    ['me@box?x=1', 'path'],
    ['me@box#frag', 'path'],
    ['-l@box', 'option'],
    ['me;rm@box', 'user'],
    ['me:pw@box', 'user'],
    ['me@-box', 'host'],
    ['me@bo$x', 'host'],
    ['me@box:0', 'port'],
    ['me@box:65536', 'port'],
    ['me@box:22x', 'port'],
    ['me@2001:db8::1', 'ipv6'],
    ['me@[2001:db8::1', 'ipv6'],
    ['me@[box]', 'ipv6'],
    ['me@[::1]x', 'port'],
  ])('refuses %j (%s)', (text, problem) => {
    expect(parseSshAddress(text)).toEqual({ ok: false, problem });
  });
});

describe('SSH aliases and the ssh command line', () => {
  it.each(['build-box', 'box_1', 'my.box', 'Box'])('offers the alias %s', (alias) => {
    expect(isUsableSshAlias(alias)).toBe(true);
  });

  it.each(['-oProxyCommand=x', 'a b', 'a;b', '$(x)', '', 'a/b', 'a@b'])('does not offer %j', (alias) => {
    expect(isUsableSshAlias(alias)).toBe(false);
  });

  it('builds a non-interactive ssh call with the destination after --', () => {
    expect(sshCommandArgs({ host: 'build-box' }, RUNTIME_DIR_COMMAND)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-T',
      '--',
      'build-box',
      'printf %s "$XDG_RUNTIME_DIR"',
    ]);
    expect(sshCommandArgs({ user: 'me', host: '2001:db8::1', port: 2222 }, 'true', 5)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-T',
      '-p',
      '2222',
      '-l',
      'me',
      '--',
      '2001:db8::1',
      'true',
    ]);
  });

  it('parses a recorded host back into its parts, and refuses anything else', () => {
    expect(sshTargetOf('build-box')).toEqual({ host: 'build-box' });
    expect(sshTargetOf('me@box:2222')).toEqual({ user: 'me', host: 'box', port: 2222 });
    expect(sshTargetOf('me@box/run/docker.sock')).toBeUndefined();
    expect(sshTargetOf('-oProxyCommand=x')).toBeUndefined();
    expect(sshEndpoint('me@box:2222')).toBe('ssh://me@box:2222');
  });
});

describe('rootless Docker on the remote computer', () => {
  it('detects name=rootless in the security options of docker info', () => {
    expect(isRootlessEngine(['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'])).toBe(true);
    expect(isRootlessEngine(['name=seccomp,profile=builtin', 'name=cgroupns'])).toBe(false);
    expect(isRootlessEngine(null)).toBe(false);
    expect(isRootlessEngine('name=rootless')).toBe(false);
  });

  it('places the socket in the runtime folder of the user', () => {
    expect(rootlessSocketPath('/run/user/1000')).toBe('/run/user/1000/docker.sock');
    expect(rootlessSocketPath('/run/user/1000/\n')).toBe('/run/user/1000/docker.sock');
    expect(rootlessSocketPath('')).toBeUndefined();
    expect(rootlessSocketPath('relative/dir')).toBeUndefined();
    expect(rootlessSocketPath('/run/user/../etc')).toBeUndefined();
    expect(rootlessSocketPath('/run/user/1000;rm')).toBeUndefined();
  });
});

describe('dockerHostProblem (plain reasons of a failed connection)', () => {
  it.each([
    ['error during connect: ssh: Could not resolve hostname build-box: Name or service not known', 'unreachable'],
    ['ssh: connect to host 192.0.2.10 port 22: Connection timed out', 'unreachable'],
    ['ssh: connect to host box port 22: Connection refused', 'unreachable'],
    ['docker info did not answer within 45 seconds.', 'unreachable'],
    ['me@box: Permission denied (publickey,password).', 'login'],
    ['Host key verification failed.', 'hostKey'],
    ['No ED25519 host key is known for box and you have requested strict checking.\r\nHost key verification failed.', 'hostKey'],
    ['bash: line 1: docker: command not found', 'dockerMissing'],
    ['sh: 1: docker: not found', 'dockerMissing'],
    ['zsh:1: command not found: docker', 'dockerMissing'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'dockerNotRunning'],
    [
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied',
      'dockerPermission',
    ],
    ['error during connect: exec: "ssh": executable file not found in $PATH', 'sshMissing'],
    // sshd dropped the connection before the login (MaxStartups, PerSourcePenalties): OpenSSH 9.6 and older clients.
    [
      'error during connect: Get "http://docker.example.com/v1.48/info": command [ssh -o ConnectTimeout=30 -T -- box docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=Connection closed by 127.0.0.1 port 32771\r\n',
      'closedBeforeLogin',
    ],
    ['kex_exchange_identification: Connection closed by remote host\r\nConnection closed by 192.0.2.10 port 22', 'closedBeforeLogin'],
    ['kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 192.0.2.10 port 22', 'closedBeforeLogin'],
    ['something else', 'unknown'],
  ])('%s → %s', (detail, problem) => {
    expect(dockerHostProblem(detail)).toBe(problem);
  });
});

describe('isSshClosedBeforeLogin', () => {
  it('is true only when ssh said nothing but the closed connection', () => {
    expect(isSshClosedBeforeLogin('Connection closed by 127.0.0.1 port 32771')).toBe(true);
    expect(isSshClosedBeforeLogin('… installed on the remote host: stderr=Connection closed by 127.0.0.1 port 32771\r\n\n')).toBe(true);
    expect(isSshClosedBeforeLogin('')).toBe(false);
    expect(isSshClosedBeforeLogin('kex_exchange_identification: Connection closed by remote host')).toBe(false);
    expect(isSshClosedBeforeLogin('root@box: Permission denied (publickey).\r\nConnection closed by 127.0.0.1 port 22')).toBe(false);
    expect(isSshClosedBeforeLogin('Connection to box closed by remote host.')).toBe(false);
    expect(isSshClosedBeforeLogin('ssh: connect to host box port 22: Connection refused')).toBe(false);
  });
});
