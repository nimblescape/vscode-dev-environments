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
    ]);
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

  it('contains only the properties that the image metadata does not store', () => {
    expect(buildOverrideConfig(base)).toEqual({
      image: 'devenv-3f2a9c1e:2',
      workspaceMount: 'source=devenv-acme-api-3f2a9c1e,target=/workspaces,type=volume',
      workspaceFolder: '/workspaces/api',
      runArgs: ['--name', 'devenv-acme-api-3f2a9c1e'],
      shutdownAction: 'none',
    });
  });

  it('keeps the repository runArgs without any --name and adds the stable name', () => {
    const override = buildOverrideConfig({
      ...base,
      runArgs: ['--cap-add=SYS_PTRACE', '--name', 'mine', '--network', 'host', '--name=other', '-e', 'A=--name'],
    });
    expect(override.runArgs).toEqual([
      '--cap-add=SYS_PTRACE',
      '--network',
      'host',
      '-e',
      'A=--name',
      '--name',
      'devenv-acme-api-3f2a9c1e',
    ]);
  });

  it('adds appPort and initializeCommand when the configuration has them', () => {
    const override = buildOverrideConfig({ ...base, appPort: [3000, '8080:80'], initializeCommand: ['echo', 'hi'] });
    expect(override.appPort).toEqual([3000, '8080:80']);
    expect(override.initializeCommand).toEqual(['echo', 'hi']);
    expect(buildOverrideConfig({ ...base, appPort: 0 }).appPort).toBe(0);
    expect(buildOverrideConfig({ ...base, initializeCommand: null })).not.toHaveProperty('initializeCommand');
  });

  it('stripNameArgs handles a trailing --name without value', () => {
    expect(stripNameArgs(['--init', '--name'])).toEqual(['--init']);
  });
});
