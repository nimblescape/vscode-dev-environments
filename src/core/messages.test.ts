// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { LINUX_ENGINE_START_COMMAND } from './docker/dockerSetup';
import { Messages, dockerHostReason, lastSeenInUse, recordedStateNote } from './messages';

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
    // review, C4: `ssh me@box:2222` is no valid command line (ssh takes the port with -p).
    expect(reason).toContain('Run "ssh -p 2222 me@box" once in a terminal');
    expect(reason).toContain('accept it');
  });

  it.each([
    ['build-box', 'ssh build-box'],
    ['me@box', 'ssh me@box'],
    ['me@box:2222', 'ssh -p 2222 me@box'],
    ['box:2222', 'ssh -p 2222 box'],
    ['me@[2001:db8::1]:22', 'ssh -p 22 me@2001:db8::1'],
    ['[2001:db8::1]', 'ssh 2001:db8::1'],
    ['me@192.0.2.10', 'ssh me@192.0.2.10'],
  ])('the host key advice for %s is a valid ssh command line: %s (review, C4)', (host, line) => {
    expect(dockerHostReason('hostKey', host)).toContain(`Run "${line}" once in a terminal`);
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

  // Review round 3 (H2, H3): the texts before the window connects.
  it('names both hosts and the commands to switch back when the context changed during a start', () => {
    const text = Messages.otherDockerHostAfterStart('acme/api', 'build-box', '');
    expect(text).toContain('runs on build-box');
    expect(text).toContain('Docker is now set to the local Docker');
    expect(text).toContain('Use a Remote Docker Host…');
    expect(text).toContain('Use the Local Docker');
    expect(text).not.toContain('Nothing was changed');
  });

  it('points to the details, not to a short wait, when the container does not run', () => {
    const text = Messages.containerNotReady('acme/api', 'devenv-acme-api-a1b2c3d4');
    expect(text).toContain('does not run');
    expect(text).toContain('details');
    expect(text).not.toContain('yet');
  });

  it('names the refused endpoint and the two commands', () => {
    const text = Messages.dockerEndpointUnsupported('tcp://192.0.2.10:2376');
    expect(text).toContain('tcp://192.0.2.10:2376');
    expect(text).toContain('Use a Remote Docker Host…');
    expect(text).toContain('Use the Local Docker');
  });
});

describe('the recreate offer (user request 2026-09-26)', () => {
  it.each([false, true])('names what is kept and what is lost (Docker Compose: %s)', (compose) => {
    const detail = Messages.containerRecreateDetail(compose);
    expect(detail).toContain('Kept: the repository with its uncommitted changes, unpushed commits, and stashes');
    expect(detail).toContain('installed packages, changes to the system, and files outside /workspaces and the volumes');
    expect(detail).toContain('(onCreateCommand, postCreateCommand) run again');
    expect(detail).toContain('Cancel changes nothing.');
    expect(Messages.containerRecreateQuestion('acme/api', compose)).toContain('acme/api cannot be started or used');
  });

  it('says for Docker Compose that only the dev container is recreated, and the other services and the named volumes stay', () => {
    expect(Messages.containerRecreateQuestion('acme/api', true)).toBe('The dev container of acme/api cannot be started or used. Recreate it?');
    expect(Messages.containerRecreateDetail(true)).toContain('Only the dev container is removed and created again');
    expect(Messages.containerRecreateDetail(true)).toContain('the named volumes of the environment, and the containers of the other services');
    expect(Messages.containerRecreateDetail(false)).not.toContain('other services');
  });
});

describe('the recreate offer, review round 2 (V1): volumes without a name', () => {
  it('names their folders in the question and in the progress, and keeps only the named volumes', () => {
    for (const compose of [false, true]) {
      const detail = Messages.containerRecreateDetail(compose, ['/workspaces/api/node_modules', '/data']);
      expect(detail).toContain('named volumes');
      expect(detail).toContain('not carried over');
      expect(detail).toContain('Docker volume without a name: /workspaces/api/node_modules, /data.');
      expect(detail).not.toContain('all volumes');
    }
    expect(Messages.containerRecreatedDamaged(['/data'])).toContain('without a name: /data.');
    expect(Messages.containerRecreatedDamaged()).not.toContain('without a name');
  });
});

describe('helperFailedOpenedAsItIs (review round 4 of PR #64, R4-4)', () => {
  it('says that the helper failed, that the running environment opens as it is, and what was not applied', () => {
    // User decision 2026-09-29 (a helperFailed during an update fails the open): the 'update' variant no longer exists
    // (before: helperFailedOpenedAsItIs('update') said "the update was not applied"); the full text is checked for 'rebuild'.
    expect(Messages.helperFailedOpenedAsItIs('rebuild')).toBe(
      'The workspace helper could not be prepared. The running environment is opened as it is: it was not rebuilt. Open it again to try again.',
    );
    expect(Messages.helperFailedOpenedAsItIs('configuration', 'devcontainer.json')).toContain(
      'the selected configuration was not applied, and devcontainer.json stays selected',
    );
    // User decision 2026-09-29 (a helperFailed during an update fails the open): 'update' dropped (before: also checked).
    for (const change of ['rebuild', 'configuration'] as const) {
      expect(Messages.helperFailedOpenedAsItIs(change).startsWith(Messages.helperFailed)).toBe(true);
    }
  });
});

// Review round 21 of PR #64 (B-R21-2): the question of a switch from Docker Compose to a single container names the
// switch with the configuration path, what Rebuild now removes, and points to Select configuration… (container
// restrictions, "Switching between Docker Compose and a single container"), also in the window that is connected.
describe('the question of a switch from Docker Compose to a single container (review round 21 of PR #64, B-R21-2)', () => {
  const configPath = '.devcontainer/python/devcontainer.json';
  it.each([
    ['at an open', Messages.configurationKindChanged(true, configPath)],
  ])('names the switch, what Rebuild now removes, and Select configuration… (%s)', (_where, text) => {
    expect(text).toContain(`The containers of this environment use Docker Compose, but the configuration ${configPath} uses a single container.`);
    expect(text).toContain(
      'Rebuild now switches the environment to a single container: it removes the containers of the other services and the files outside the volumes; named volumes are kept.',
    );
    expect(text).toContain('To use the Docker Compose configuration of the repository, choose Select configuration… in the list of environments.');
  });
});

// Review round 1 of PR #87 (A-R1-4).
describe('recordedStateNote (review round 1 of PR #87, A-R1-4)', () => {
  const used = '2026-10-02T10:00:00.000Z';
  const format = (time: string) => `<${time}>`;
  it('names the time of a state older than the last use; nothing for a newer or equal one, or an unknown last use', () => {
    expect(recordedStateNote({ recordedAt: '2026-10-02T09:00:00.000Z' }, used, format)).toBe(` ${Messages.deleteChangesUnknownSince('<2026-10-02T09:00:00.000Z>')}`);
    expect(recordedStateNote({ recordedAt: used }, used, format)).toBe('');
    expect(recordedStateNote({ recordedAt: '2026-10-02T11:00:00.000Z' }, used, format)).toBe('');
    expect(recordedStateNote({ recordedAt: '2026-10-02T09:00:00.000Z' }, undefined, format)).toBe('');
    expect(recordedStateNote({ recordedAt: '2026-10-02T09:00:00.000Z' }, 'not a time', format)).toBe('');
  });
  it('says that changes since the last open are not known without a valid recorded state', () => {
    expect(recordedStateNote(undefined, used, format)).toBe(` ${Messages.deleteChangesNotRecorded}`);
    expect(recordedStateNote({ recordedAt: 'garbage' }, used, format)).toBe(` ${Messages.deleteChangesNotRecorded}`);
  });
});

// Review round 2 of PR #87 (A-R2-2): the last use for Delete's note is the later of the last time a window was seen using
// the environment and the last open.
describe('lastSeenInUse (review round 2 of PR #87, A-R2-2)', () => {
  const early = '2026-10-02T09:00:00.000Z';
  const late = '2026-10-02T11:00:00.000Z';
  it('gives the later valid time of lastSeenInUseAt and lastUsedAt, the valid one alone, or nothing', () => {
    expect(lastSeenInUse({ lastUsedAt: early, lastSeenInUseAt: late })).toBe(late);
    expect(lastSeenInUse({ lastUsedAt: late, lastSeenInUseAt: early })).toBe(late);
    expect(lastSeenInUse({ lastUsedAt: early })).toBe(early);
    expect(lastSeenInUse({ lastUsedAt: 'not a time', lastSeenInUseAt: late })).toBe(late);
    expect(lastSeenInUse({ lastUsedAt: early, lastSeenInUseAt: 'not a time' })).toBe(early);
    expect(lastSeenInUse({ lastUsedAt: 'not a time' })).toBeUndefined();
    expect(lastSeenInUse({})).toBeUndefined();
  });
});
