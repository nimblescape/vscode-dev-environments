// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import {
  DevcontainerCommandError,
  HELPER_CACHE_FOLDER,
  buildArgs,
  buildOverrideConfig,
  isLifecycleCommandFailure,
  parseDevcontainerResult,
  readConfigurationArgs,
  stripNameArgs,
  tryParseDevcontainerResult,
  upArgs,
} from './devcontainerCli';
import { containerEnvironment, remoteEnvironment } from './containerGit';

describe('argument builders', () => {
  it('read-configuration', () => {
    expect(
      readConfigurationArgs({
        workspaceFolder: '/workspaces/api',
        configPath: '/workspaces/api/.devcontainer/python/devcontainer.json',
        idLabel: 'devenv.environment-id=3f2a',
      }),
    ).toEqual([
      'read-configuration',
      '--workspace-folder',
      '/workspaces/api',
      '--config',
      '/workspaces/api/.devcontainer/python/devcontainer.json',
      '--id-label',
      'devenv.environment-id=3f2a',
      '--include-merged-configuration',
    ]);
    expect(
      readConfigurationArgs({ workspaceFolder: '/workspaces/api', configPath: '/c', idLabel: 'devenv.environment-id=3f2a', merged: false }),
    ).not.toContain('--include-merged-configuration');
  });

  it('build', () => {
    expect(
      buildArgs({
        workspaceFolder: '/workspaces/api',
        configPath: '/workspaces/api/.devcontainer/devcontainer.json',
        imageName: 'devenv-3f2a9c1e:2',
      }),
    ).toEqual([
      'build',
      '--workspace-folder',
      '/workspaces/api',
      '--config',
      '/workspaces/api/.devcontainer/devcontainer.json',
      '--image-name',
      'devenv-3f2a9c1e:2',
      '--user-data-folder',
      HELPER_CACHE_FOLDER,
    ]);
  });

  it('up without and with --remove-existing-container', () => {
    const base = {
      workspaceFolder: '/workspaces/api',
      overrideConfigPath: '/tmp/devenv-override/devcontainer.json',
      idLabel: 'devenv.environment-id=3f2a',
    };
    const args = upArgs({ ...base, removeExistingContainer: false });
    expect(args).toEqual([
      'up',
      '--workspace-folder',
      '/workspaces/api',
      '--override-config',
      '/tmp/devenv-override/devcontainer.json',
      '--id-label',
      'devenv.environment-id=3f2a',
      '--user-data-folder',
      HELPER_CACHE_FOLDER,
      '--update-remote-user-uid-default',
      'never',
      '--skip-post-attach',
    ]);
    expect(upArgs({ ...base, removeExistingContainer: true })).toEqual([...args, '--remove-existing-container']);
  });
});

describe('parseDevcontainerResult', () => {
  it('takes the JSON result on the last line after log lines', () => {
    const stdout = [
      '[2026-09-24T15:40:00.000Z] @devcontainers/cli 0.89.0.',
      '{"not":"a result"}',
      '{"outcome":"success","containerId":"abc","remoteUser":"vscode","remoteWorkspaceFolder":"/workspaces/api"}',
      '',
    ].join('\n');
    expect(parseDevcontainerResult(stdout)).toEqual({
      outcome: 'success',
      containerId: 'abc',
      remoteUser: 'vscode',
      remoteWorkspaceFolder: '/workspaces/api',
    });
  });

  it('accepts CRLF and trailing empty lines, and ignores later non-result lines', () => {
    expect(parseDevcontainerResult('log\r\n{"outcome":"success","imageName":["a:1"]}\r\n\r\n')).toEqual({
      outcome: 'success',
      imageName: ['a:1'],
    });
    expect(parseDevcontainerResult('{"outcome":"success"}\nnoise after\n').outcome).toBe('success');
  });

  it('returns an error outcome', () => {
    expect(parseDevcontainerResult('{"outcome":"error","message":"Command failed","description":"An error occurred."}\n')).toEqual({
      outcome: 'error',
      message: 'Command failed',
      description: 'An error occurred.',
    });
  });

  it('throws without a result line', () => {
    expect(() => parseDevcontainerResult('')).toThrow();
    expect(() => parseDevcontainerResult('only logs\n{"outcome":"maybe"}\n[1,2]\n')).toThrow();
    expect(() => parseDevcontainerResult('{"outcome":"success"')).toThrow();
  });

  it('tryParseDevcontainerResult recognizes only result lines', () => {
    expect(tryParseDevcontainerResult('  {"outcome":"success"}  \n')).toEqual({ outcome: 'success' });
    expect(tryParseDevcontainerResult('[1]')).toBeUndefined();
    expect(tryParseDevcontainerResult('{"message":"x"}')).toBeUndefined();
    expect(tryParseDevcontainerResult('text {"outcome":"success"}')).toBeUndefined();
  });
});

describe('DevcontainerCommandError', () => {
  it('is a CommandError that names the message of the CLI result', () => {
    const error = new DevcontainerCommandError('devcontainer build', 1, 'out', 'err', {
      outcome: 'error',
      message: 'Command failed: docker pull x',
      description: 'An error occurred building the container.',
    });
    expect(error).toBeInstanceOf(CommandError);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(
      'devcontainer build failed with exit code 1: Command failed: docker pull x An error occurred building the container.',
    );
    expect(error.result?.outcome).toBe('error');
  });

  it('keeps the message of CommandError without a result', () => {
    const error = new DevcontainerCommandError('devcontainer up', null, '', 'killed');
    expect(error.message).toBe('devcontainer up failed with exit code null: killed');
    expect(error.result).toBeUndefined();
  });
});

describe('isLifecycleCommandFailure', () => {
  const error = (description: string, containerId: string | null = 'c1') =>
    ({ outcome: 'error', message: 'Command failed', description, containerId: containerId ?? undefined }) as const;

  it.each([
    'onCreateCommand from devcontainer.json failed.',
    'updateContentCommand from devcontainer.json failed.',
    'postCreateCommand from devcontainer.json failed.',
    'postStartCommand from devcontainer.json failed.',
    "postCreateCommand from Feature 'ghcr.io/devcontainers/features/node:1' failed.",
    'install of postCreateCommand from devcontainer.json failed.',
  ])('recognizes "%s"', (description) => {
    expect(isLifecycleCommandFailure(error(description))).toBe(true);
  });

  it('needs an error outcome, a container ID, and the text of a lifecycle command', () => {
    expect(isLifecycleCommandFailure(undefined)).toBe(false);
    expect(isLifecycleCommandFailure({ outcome: 'success', containerId: 'c1', description: 'postStartCommand from devcontainer.json failed.' })).toBe(false);
    expect(isLifecycleCommandFailure(error('postStartCommand from devcontainer.json failed.', null))).toBe(false);
    expect(isLifecycleCommandFailure(error('postStartCommand from devcontainer.json failed.', ' '))).toBe(false);
    expect(isLifecycleCommandFailure(error('An error occurred setting up the container.'))).toBe(false);
    expect(isLifecycleCommandFailure(error('initializeCommand from devcontainer.json failed.'))).toBe(false);
    expect(isLifecycleCommandFailure(error('postStartCommand from devcontainer.json interrupted.'))).toBe(false);
  });
});

describe('buildOverrideConfig', () => {
  const base = {
    environmentImage: 'devenv-3f2a9c1e:2',
    volumeName: 'devenv-acme-api-3f2a9c1e',
    repositoryName: 'api',
    containerName: 'devenv-acme-api-3f2a9c1e',
  };

  it('contains only the properties that the image metadata does not store, and the variables of container-only Git', () => {
    expect(buildOverrideConfig(base)).toEqual({
      image: 'devenv-3f2a9c1e:2',
      workspaceMount: 'source=devenv-acme-api-3f2a9c1e,target=/workspaces,type=volume',
      workspaceFolder: '/workspaces/api',
      runArgs: ['--label', 'devenv.container-version=2', '--name', 'devenv-acme-api-3f2a9c1e'],
      containerEnv: containerEnvironment(),
      remoteEnv: remoteEnvironment(),
      shutdownAction: 'none',
    });
  });

  it('switches off the forwarding of the computer with variables of the container and of VS Code (concept section 9)', () => {
    const override = buildOverrideConfig(base);
    const containerEnv = override.containerEnv as Record<string, string>;
    const remoteEnv = override.remoteEnv as Record<string, string>;
    for (const env of [containerEnv, remoteEnv]) {
      expect(env).toMatchObject({
        GIT_CONFIG_GLOBAL: '/workspaces/.devenv+/gitconfig',
        DOCKER_CONFIG: '/workspaces/.devenv+/docker',
        GNUPGHOME: '/workspaces/.devenv+/gnupg',
        GIT_SSH_COMMAND: 'ssh -o IdentityAgent=none',
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'include.path',
        GIT_CONFIG_VALUE_1: '/workspaces/.devenv+/credentials.gitconfig',
        GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
        GIT_CONFIG_VALUE_2: '',
        GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
      });
      expect(env.GIT_CONFIG_PARAMETERS).toMatch(/^'credential\.helper=' /);
      // No token in a variable, and the local browser stays (URLs of the container open on the computer).
      expect(Object.keys(env)).not.toContain('GH_TOKEN');
      expect(Object.keys(env)).not.toContain('GITHUB_TOKEN');
      expect(Object.keys(env)).not.toContain('BROWSER');
      // The CLI substitutes `${…}` in the override configuration.
      for (const value of Object.values(env)) expect(value).not.toContain('${');
    }
    expect(containerEnv).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(remoteEnv.SSH_AUTH_SOCK).toBe('');
  });

  it('keeps the repository runArgs without any --name, binds published ports to 127.0.0.1, and adds the label and the name', () => {
    const override = buildOverrideConfig({
      ...base,
      runArgs: ['--cap-add=SYS_PTRACE', '--name', 'mine', '--network', 'host', '--name=other', '-e', 'A=--name', '-p', '8080:80'],
    });
    expect(override.runArgs).toEqual([
      '--cap-add=SYS_PTRACE',
      '--network',
      'host',
      '-e',
      'A=--name',
      '-p',
      '127.0.0.1:8080:80',
      '--label',
      'devenv.container-version=2',
      '--name',
      'devenv-acme-api-3f2a9c1e',
    ]);
  });

  it('binds appPort to 127.0.0.1 and never passes initializeCommand', () => {
    const override = buildOverrideConfig({ ...base, appPort: [3000, '8080:80'] });
    expect(override.appPort).toEqual(['127.0.0.1:3000:3000', '127.0.0.1:8080:80']);
    expect(buildOverrideConfig({ ...base, appPort: 0 }).appPort).toEqual(['127.0.0.1:0:0']);
    expect(buildOverrideConfig({ ...base, appPort: [] })).not.toHaveProperty('appPort');
    expect(buildOverrideConfig(base)).not.toHaveProperty('initializeCommand');
  });

  it('stripNameArgs handles a trailing --name without value', () => {
    expect(stripNameArgs(['--init', '--name'])).toEqual(['--init']);
  });

  it('stripNameArgs reads the flags as Docker does: a --name that is the value of another flag stays', () => {
    expect(stripNameArgs(['--name', 'x', '--init'])).toEqual(['--init']);
    expect(stripNameArgs(['--name=x', '--init'])).toEqual(['--init']);
    expect(stripNameArgs(['-e', 'A=--name', '--init'])).toEqual(['-e', 'A=--name', '--init']);
    expect(stripNameArgs(['-e', '--name', '--init'])).toEqual(['-e', '--name', '--init']);
    // Removed word by word, `--privileged` would become a flag for Docker (the value of `--label` for the policy).
    const shifting = ['--label', '--name', '--init', '--label', '--privileged'];
    expect(stripNameArgs(shifting)).toEqual(shifting);
    expect(buildOverrideConfig({ ...base, runArgs: shifting }).runArgs).toEqual([
      ...shifting,
      '--label',
      'devenv.container-version=2',
      '--name',
      'devenv-acme-api-3f2a9c1e',
    ]);
  });
});
