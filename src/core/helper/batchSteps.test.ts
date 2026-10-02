// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the step table of the batch helper. Each kind builds its command with the builders of the per-step
// runs from checked inputs; an unknown kind, a key too many, a path out of the repository, and a refused variable are
// refused; a command line is never taken from the request.
import { describe, expect, it } from 'vitest';
import { configOwnershipFixCommand } from '../git/gitSummary';
import { CONFIG_FOLDER, environmentIdLabel } from '../names';
import { BATCH_STEP_KINDS, BatchStepError, COMPOSE_REMOTE_OFF, batchStepCommand, isBatchStepKind } from './batchSteps';
import { COMPOSE_MODEL_PATH } from './compose';
import { CONTAINER_CREDENTIAL_HELPER } from './containerGit';
import { buildArgs, readConfigurationArgs, runUserCommandsArgs, upArgs } from './devcontainerCli';
import {
  OVERRIDE_CONFIG_PATH,
  buildCommand,
  cloneCommand,
  composeHashCommand,
  composeModelCommand,
  createFoldersCommand,
  gitFilesCommand,
  listConfigsCommand,
  readFilesCommand,
  writeAndRunCommand,
} from './scripts';
import { isPassableEnvName, overrideCommand, overrideInput, writeAndRunInput } from './stepInputs';

const REPO = 'octo/hello';
const FOLDER = '/workspaces/hello';
const ID = 'env-1';

describe('batchStepCommand (plan step 6, PR B)', () => {
  it('knows exactly the twelve kinds of the plan', () => {
    // user decision 2026-10-02: Delete runs no Git: changed expectation, gitSummary is no kind any more (was in plan step
    // 7: thirteen kinds with gitSummary, Delete's check), and the batch helper refuses it as unknown.
    expect([...BATCH_STEP_KINDS].sort()).toEqual(
      ['build', 'clone', 'composeHash', 'composeModel', 'createFolders', 'gitFiles', 'listConfigs', 'ownershipFix', 'readConfiguration', 'readFiles', 'runUserCommands', 'up'],
    );
    expect(isBatchStepKind('gitSummary')).toBe(false);
    expect(() => batchStepCommand('gitSummary', { repository: REPO })).toThrow(BatchStepError);
    expect(isBatchStepKind('clone')).toBe(true);
    expect(isBatchStepKind('docker')).toBe(false);
    expect(isBatchStepKind('toString')).toBe(false);
  });

  it('builds the clone with the builder, as the Git user, with the secret on stdin', () => {
    expect(batchStepCommand('clone', { repository: REPO, branch: 'dev' })).toEqual({ command: cloneCommand(REPO, 'hello', 'dev'), env: {}, git: true, secret: 'stdin' });
    expect(batchStepCommand('clone', { repository: REPO })).toEqual({ command: cloneCommand(REPO, 'hello', undefined), env: {}, git: true, secret: 'stdin' });
    expect(batchStepCommand('clone', { repository: REPO, branch: '' }).command).toEqual(cloneCommand(REPO, 'hello', undefined));
  });

  it('builds the read steps with their builders, as root, without a secret', () => {
    // User decision of 2026-10-01 (agreed extension of "Compose reads as the repository owner"): readFiles, listConfigs
    // and createFolders run as the owner of the repository folder too (was: root, no `owner`).
    expect(batchStepCommand('readFiles', { repository: REPO, configPath: '.devcontainer/devcontainer.json', dockerfile: 'Dockerfile' })).toEqual({
      command: readFilesCommand(FOLDER, '.devcontainer/devcontainer.json', 'Dockerfile'),
      env: {},
      git: false,
      owner: FOLDER,
    });
    expect(batchStepCommand('listConfigs', { repository: REPO })).toEqual({ command: listConfigsCommand(FOLDER), env: {}, git: false, owner: FOLDER });
    // User decision of 2026-10-01: Compose reads as the repository owner. Changed expectation (option A had `git: true,
    // readOnly: true`, the unprivileged Git user): the Compose read steps run as the owner of the repository folder
    // (`owner`), which the helper reads at step time; composeHash names its repository for that.
    expect(batchStepCommand('composeModel', { repository: REPO, files: [`${FOLDER}/compose.yml`], project: 'p1' })).toEqual({
      command: composeModelCommand(FOLDER, [`${FOLDER}/compose.yml`]),
      env: { COMPOSE_PROJECT_NAME: 'p1' },
      git: false,
      owner: FOLDER,
      // Review round 1 of PR #84, A-R1-1: added expectation: only the Compose steps close CONFIG_FOLDER for the step.
      closeConfigFolder: true,
    });
    expect(batchStepCommand('composeHash', { repository: REPO, model: '{}', project: 'p1' })).toEqual({
      command: composeHashCommand(COMPOSE_MODEL_PATH, 'p1'),
      input: '{}',
      env: { COMPOSE_PROJECT_NAME: 'p1' },
      git: false,
      owner: FOLDER,
      // Review round 1 of PR #84, A-R1-1: added expectation: only the Compose steps close CONFIG_FOLDER for the step.
      closeConfigFolder: true,
    });
    // User decision of 2026-10-01: Compose reads as the repository owner, so composeHash without its repository, or
    // with one outside /workspaces, is refused.
    expect(() => batchStepCommand('composeHash', { model: '{}', project: 'p1' })).toThrow(BatchStepError);
    expect(() => batchStepCommand('composeHash', { repository: '../x', model: '{}', project: 'p1' })).toThrow(BatchStepError);
    // User decision of 2026-10-01 (agreed extension): createFolders as the owner too (was: root, no `owner`).
    expect(batchStepCommand('createFolders', { repository: REPO, folders: [`${FOLDER}/data`] })).toEqual({
      command: createFoldersCommand(FOLDER, [`${FOLDER}/data`]),
      env: {},
      git: false,
      owner: FOLDER,
    });
    // User decision of 2026-10-01 (agreed extension): only the steps without the Docker socket run as the owner; the
    // clone stays Git's, and the steps that need the socket, gitFiles and ownershipFix stay root.
    const owners = BATCH_STEP_KINDS.filter((kind) => {
      const samples: Record<string, unknown> = {
        clone: { repository: REPO },
        readFiles: { repository: REPO, configPath: '.devcontainer/devcontainer.json' },
        listConfigs: { repository: REPO },
        readConfiguration: { repository: REPO, configPath: '.devcontainer/devcontainer.json', environmentId: ID, merged: false },
        build: { repository: REPO, configPath: '.devcontainer/devcontainer.json', imageName: 'devenv-x' },
        composeModel: { repository: REPO, files: [`${FOLDER}/compose.yml`], project: 'p' },
        composeHash: { repository: REPO, model: '{}', project: 'p' },
        createFolders: { repository: REPO, folders: [`${FOLDER}/data`] },
        up: { repository: REPO, override: {}, environmentId: ID, removeExistingContainer: false },
        runUserCommands: { repository: REPO, override: {}, environmentId: ID, containerId: 'a'.repeat(64) },
        gitFiles: { repository: REPO, identity: { name: 'n', email: 'e' } },
        ownershipFix: { folder: '/workspaces/.devenv+', uid: '1000', gid: '1000' },
      };
      return batchStepCommand(kind, samples[kind]).owner !== undefined;
    });
    // user decision 2026-10-02: Delete runs no Git: changed expectation, no gitSummary step runs as the owner (was in plan
    // step 7: gitSummary too).
    expect(owners).toEqual(['readFiles', 'listConfigs', 'composeModel', 'composeHash', 'createFolders']);
    expect(batchStepCommand('clone', { repository: REPO }).git).toBe(true);
  });

  it('builds the runs of the Dev Container CLI with their builders and inputs', () => {
    const override = { name: 'x' };
    const files = { '/tmp/devenv-override/compose.json': '{}' };
    const idLabel = environmentIdLabel(ID);
    const read = readConfigurationArgs({ workspaceFolder: FOLDER, configPath: `${FOLDER}/.devcontainer.json`, idLabel, merged: true, overrideConfigPath: OVERRIDE_CONFIG_PATH });
    expect(batchStepCommand('readConfiguration', { repository: REPO, configPath: '.devcontainer.json', environmentId: ID, merged: true, override, files, env: { COMPOSE_PROJECT_NAME: 'p' } })).toEqual({
      command: writeAndRunCommand({}, read),
      input: writeAndRunInput(files, override),
      env: { COMPOSE_PROJECT_NAME: 'p' },
      git: false,
    });
    const plain = readConfigurationArgs({ workspaceFolder: FOLDER, configPath: `${FOLDER}/.devcontainer.json`, idLabel, merged: false, overrideConfigPath: undefined });
    expect(batchStepCommand('readConfiguration', { repository: REPO, configPath: '.devcontainer.json', environmentId: ID, merged: false })).toEqual({
      command: ['devcontainer', ...plain],
      input: undefined,
      env: {},
      git: false,
    });
    const configFile = `${FOLDER}/.devcontainer/devcontainer.json`;
    expect(batchStepCommand('build', { repository: REPO, configPath: '.devcontainer/devcontainer.json', imageName: 'devenv-x:1' })).toEqual({
      command: buildCommand(configFile, buildArgs({ workspaceFolder: FOLDER, configPath: configFile, imageName: 'devenv-x:1' })),
      env: {},
      git: false,
    });
    expect(batchStepCommand('build', { repository: REPO, configPath: '.devcontainer/devcontainer.json', imageName: 'devenv-x:1', override, files })).toEqual({
      command: writeAndRunCommand({ repositoryConfig: configFile, config: OVERRIDE_CONFIG_PATH }, buildArgs({ workspaceFolder: FOLDER, configPath: OVERRIDE_CONFIG_PATH, imageName: 'devenv-x:1' })),
      input: writeAndRunInput(files, override),
      env: {},
      git: false,
    });
    const up = upArgs({ workspaceFolder: FOLDER, overrideConfigPath: OVERRIDE_CONFIG_PATH, idLabel, removeExistingContainer: true });
    expect(batchStepCommand('up', { repository: REPO, override, environmentId: ID, removeExistingContainer: true })).toEqual({
      command: overrideCommand(up, undefined),
      input: overrideInput(undefined, override),
      env: {},
      git: false,
      secret: 'mask',
    });
    const user = runUserCommandsArgs({ workspaceFolder: FOLDER, overrideConfigPath: OVERRIDE_CONFIG_PATH, idLabel, containerId: 'abcdef012345' });
    expect(batchStepCommand('runUserCommands', { repository: REPO, override, environmentId: ID, containerId: 'abcdef012345', files })).toEqual({
      command: overrideCommand(user, files),
      input: overrideInput(files, override),
      env: {},
      git: false,
      secret: 'mask',
    });
  });

  it('builds the Git files and the ownership fix of CONFIG_FOLDER with their builders, as root', () => {
    expect(batchStepCommand('gitFiles', { repository: REPO, identity: { name: 'A', email: 'a@b' } })).toEqual({
      command: gitFilesCommand('hello', { name: 'A', email: 'a@b' }, CONTAINER_CREDENTIAL_HELPER),
      env: {},
      git: false,
    });
    expect(batchStepCommand('ownershipFix', { folder: CONFIG_FOLDER, uid: '1000', gid: '1000' })).toEqual({ command: configOwnershipFixCommand(CONFIG_FOLDER, '1000', '1000'), env: {}, git: false });
  });

  it('refuses an unknown kind and never takes a command line from the request', () => {
    for (const kind of ['docker', 'exec', 'run', 'sh', '__proto__', 'constructor', '']) {
      expect(() => batchStepCommand(kind, { command: ['sh', '-c', 'id'] })).toThrow(BatchStepError);
    }
    // A key that the kind does not know (a command, args, a script) is refused, not ignored.
    expect(() => batchStepCommand('listConfigs', { repository: REPO, command: ['sh', '-c', 'id'] })).toThrow(BatchStepError);
    expect(() => batchStepCommand('build', { repository: REPO, configPath: 'a.json', imageName: 'x', args: ['--x'] })).toThrow(BatchStepError);
    expect(() => batchStepCommand('clone', { repository: REPO, script: 'id' })).toThrow(BatchStepError);
  });

  it('refuses inputs beyond the checks of the per-step runs', () => {
    const bad: Array<[string, unknown]> = [
      ['clone', { repository: '../x' }],
      ['clone', { repository: 'a/b/c' }],
      ['clone', { repository: '-a/b' }],
      ['clone', null],
      ['clone', ['octo/hello']],
      ['readFiles', { repository: REPO, configPath: '../x.json' }],
      ['readFiles', { repository: REPO, configPath: '/etc/passwd' }],
      ['readConfiguration', { repository: REPO, configPath: 'a.json', environmentId: '../x', merged: true }],
      ['readConfiguration', { repository: REPO, configPath: 'a.json', environmentId: ID, merged: 'yes' }],
      ['readConfiguration', { repository: REPO, configPath: 'a.json', environmentId: ID, merged: true, files: { '/etc/passwd': 'x' } }],
      ['readConfiguration', { repository: REPO, configPath: 'a.json', environmentId: ID, merged: true, files: { '/tmp/devenv-override/a': 1 } }],
      ['build', { repository: REPO, configPath: 'a.json', imageName: '--privileged' }],
      ['composeModel', { repository: REPO, files: ['/workspaces/other/compose.yml'], project: 'p' }],
      ['composeModel', { repository: REPO, files: [`${FOLDER}/../x.yml`], project: 'p' }],
      ['composeModel', { repository: REPO, files: [], project: 'p' }],
      ['composeModel', { repository: REPO, files: [`${FOLDER}/a.yml`], project: 'P Q' }],
      ['createFolders', { repository: REPO, folders: [`${FOLDER}/./a`] }],
      ['up', { repository: REPO, override: [], environmentId: ID, removeExistingContainer: false }],
      ['up', { repository: REPO, override: {}, environmentId: ID, removeExistingContainer: 'no' }],
      ['runUserCommands', { repository: REPO, override: {}, environmentId: ID, containerId: 'not-an-id' }],
      ['gitFiles', { repository: REPO, identity: { name: 'a' } }],
      ['ownershipFix', { folder: '/workspaces', uid: '0', gid: '0' }],
      ['ownershipFix', { folder: CONFIG_FOLDER, uid: 'root', gid: '0' }],
    ];
    for (const [kind, params] of bad) expect(() => batchStepCommand(kind, params), `${kind} ${JSON.stringify(params)}`).toThrow(BatchStepError);
  });

  it('passes only the variables that isPassableEnvName accepts, on the step', () => {
    expect(batchStepCommand('up', { repository: REPO, override: {}, environmentId: ID, removeExistingContainer: false, env: { COMPOSE_PROJECT_NAME: 'p', http_proxy: 'x' } }).env).toEqual({
      COMPOSE_PROJECT_NAME: 'p',
      http_proxy: 'x',
    });
    for (const name of ['DOCKER_HOST', 'REMOTE_CONTAINERS_IPC', 'REMOTE_CONTAINERS', 'VSCODE_IPC_HOOK_CLI', 'vscode_git_askpass_node', 'SSH_AUTH_SOCK', 'BROWSER', 'PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'A-B', '1A']) {
      expect(() => batchStepCommand('build', { repository: REPO, configPath: 'a.json', imageName: 'x', env: { [name]: 'v' } }), name).toThrow(BatchStepError);
    }
  });

  it('review round 4 of PR #80, B-R4-2: every kind that takes env refuses the same variables (readConfiguration, build, up, runUserCommands)', () => {
    const withEnv: Array<[string, Record<string, unknown>]> = [
      ['readConfiguration', { repository: REPO, configPath: 'a.json', environmentId: ID, merged: true }],
      ['build', { repository: REPO, configPath: 'a.json', imageName: 'x' }],
      ['up', { repository: REPO, override: {}, environmentId: ID, removeExistingContainer: false }],
      ['runUserCommands', { repository: REPO, override: {}, environmentId: ID, containerId: 'abcdef012345' }],
    ];
    const refused = ['NODE_OPTIONS', 'LD_PRELOAD', 'DOCKER_HOST', 'SSH_AUTH_SOCK', 'BROWSER', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_x', 'REMOTE_CONTAINERS_IPC', 'REMOTE_CONTAINERS_x', 'PATH'];
    for (const [kind, params] of withEnv) {
      // The allowed name passes, so a refusal below comes from the name alone.
      expect(batchStepCommand(kind, { ...params, env: { COMPOSE_PROJECT_NAME: 'p' } }).env, kind).toEqual({ COMPOSE_PROJECT_NAME: 'p' });
      for (const name of refused) {
        expect(() => batchStepCommand(kind, { ...params, env: { COMPOSE_PROJECT_NAME: 'p', [name]: 'v' } }), `${kind} ${name}`).toThrow(BatchStepError);
      }
    }
  });

  it('review round 4 of PR #80, B-R4-3: readConfiguration and build refuse a configuration path outside the repository', () => {
    const bad = ['../x.json', '../../etc/shadow', '/etc/passwd', 'a/../../x.json'];
    for (const configPath of bad) {
      expect(() => batchStepCommand('readConfiguration', { repository: REPO, configPath, environmentId: ID, merged: true }), `readConfiguration ${configPath}`).toThrow(BatchStepError);
      expect(() => batchStepCommand('build', { repository: REPO, configPath, imageName: 'x' }), `build ${configPath}`).toThrow(BatchStepError);
    }
    // The same request with a path inside the repository is accepted.
    expect(() => batchStepCommand('readConfiguration', { repository: REPO, configPath: 'a.json', environmentId: ID, merged: true })).not.toThrow();
    expect(() => batchStepCommand('build', { repository: REPO, configPath: 'a.json', imageName: 'x' })).not.toThrow();
  });

  it('isPassableEnvName also refuses the variables of VS Code and the Dev Containers extension, SSH_AUTH_SOCK and BROWSER', () => {
    for (const name of ['REMOTE_CONTAINERS_IPC', 'REMOTE_CONTAINERS_SOCKETS', 'remote_containers', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_GIT_IPC_HANDLE', 'SSH_AUTH_SOCK', 'ssh_auth_sock', 'BROWSER', 'DOCKER_HOST']) {
      expect(isPassableEnvName(name), name).toBe(false);
    }
    for (const name of ['HOME', 'COMPOSE_PROJECT_NAME', 'GITHUB_USER', 'BROWSERS', 'MY_VSCODE']) expect(isPassableEnvName(name), name).toBe(true);
  });

  it('review round 2 of PR #80, B-R2-3: refuses a sibling folder that shares the prefix of the repository folder (S39)', () => {
    // A sibling of the repository folder `/workspaces/hello` whose name starts with `hello`: it is not below the folder.
    // (`hello2/a` alone would also fail on its empty part under S39; the name after the prefix needs two characters.)
    const siblings = ['/workspaces/hello-other/a', '/workspaces/hello22/a', '/workspaces/hellox/compose.yml', '/workspaces/hello2/a'];
    for (const entry of siblings) {
      expect(() => batchStepCommand('createFolders', { repository: REPO, folders: [entry] }), entry).toThrow(BatchStepError);
      expect(() => batchStepCommand('composeModel', { repository: REPO, files: [entry], project: 'p' }), entry).toThrow(BatchStepError);
    }
    // The folder itself followed by `/` still passes.
    expect(() => batchStepCommand('createFolders', { repository: REPO, folders: [`${FOLDER}/a`] })).not.toThrow();
  });

  it('switches the remote includes of Docker Compose off', () => {
    expect(COMPOSE_REMOTE_OFF).toEqual({ COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false', COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false' });
  });
});
