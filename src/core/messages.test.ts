// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { LINUX_ENGINE_START_COMMAND } from './docker/dockerSetup';
import { Messages, dockerHostReason } from './messages';

describe('Messages.localEnvNotPassed', () => {
  // The CLI resolves ${localEnv:NAME} in the workspace helper: HOME is /root there, not empty.
  it('does not say that every variable is empty', () => {
    const text = Messages.localEnvNotPassed('HOME, FOO');
    expect(text).toContain('HOME, FOO');
    expect(text).toContain('HOME is /root');
    expect(text).not.toMatch(/so they are empty/);
  });

  it('names the variables that get the values of the workspace helper', () => {
    const text = Messages.localEnvNotPassed('HOME, FOO', 'HOME');
    expect(text).toContain('The workspace helper sets HOME to its own values');
    expect(text).toContain('The others are empty or have their default value');
  });
});

describe('Messages.containerComposeReplaced (review round 1 of unit 6, P-1)', () => {
  // The containers of the other services are removed: their volumes without a name are left behind, not kept in use.
  it('does not claim that all data of the services is kept', () => {
    const text = Messages.containerComposeReplaced;
    expect(text).not.toMatch(/data of the services are kept/);
    expect(text).toContain('named volumes are kept');
    expect(text).toContain('volumes without a name is no longer used');
  });

  it('says that files outside the repository are removed when a single container becomes Docker Compose', () => {
    expect(Messages.containerComposeCreated).toContain('Files in other folders of the container');
  });
});

describe('Messages.dockerEngineNotRunning', () => {
  // The same command as the action Start Docker of the Docker setup: the service also starts with the computer then.
  it('names the command that enables and starts the Docker service', () => {
    expect(Messages.dockerEngineNotRunning).toContain(LINUX_ENGINE_START_COMMAND);
    expect(LINUX_ENGINE_START_COMMAND).toBe('sudo systemctl enable --now docker');
  });
});

describe('the messages of a remote Docker host (unit 7)', () => {
  it('names the host and the plain reason', () => {
    expect(Messages.dockerHostUnreachable('build-box', dockerHostReason('unreachable', 'build-box'))).toBe(
      'The Docker host build-box cannot be reached. The computer does not answer. Check its name and the network connection.',
    );
  });

  it('asks the user to accept an unknown host key in a terminal, never accepts it', () => {
    const reason = dockerHostReason('hostKey', 'me@box:2222');
    expect(reason).toContain('Run "ssh me@box:2222" once in a terminal');
    expect(reason).toContain('accept it');
  });

  it.each([
    ['closedBeforeLogin', 'closed the connection before the login'],
    ['closedBeforeLogin', 'ControlMaster'],
    ['login', 'SSH could not log in'],
    ['dockerMissing', 'Docker is not installed on that computer.'],
    ['dockerNotRunning', 'Docker is not running on that computer.'],
    ['dockerPermission', 'group docker'],
    ['sshMissing', 'ssh'],
    ['unknown', 'The details show why.'],
  ] as const)('%s', (problem, text) => {
    expect(dockerHostReason(problem, 'box')).toContain(text);
  });

  it('never offers the Docker Desktop start or its installation for a remote host', () => {
    const text = Messages.dockerHostUnreachable('box', dockerHostReason('dockerNotRunning', 'box'));
    expect(text).not.toMatch(/Docker Desktop|install/i);
  });

  it('names both hosts when an environment is on another host', () => {
    expect(Messages.otherDockerHost('acme/api', 'build-box', '')).toBe(
      'The environment of acme/api is on build-box, but Docker is set to the local Docker. Nothing was changed.',
    );
  });

  it('names the refused endpoint and the two commands', () => {
    const text = Messages.dockerEndpointUnsupported('tcp://192.0.2.10:2376');
    expect(text).toContain('tcp://192.0.2.10:2376');
    expect(text).toContain('Use a Remote Docker Host…');
    expect(text).toContain('Use the Local Docker');
  });
});
