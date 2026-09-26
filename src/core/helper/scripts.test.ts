// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectConfigurations } from '../discovery/detect';
import {
  BUILD_SCRIPT,
  CLONE_SCRIPT,
  COMPOSE_FILES_MAX_AGE_MS,
  COMPOSE_MODEL_SCRIPT,
  CREDENTIAL_HELPER,
  GIT_FILES_SCRIPT,
  GIT_SUMMARY_SCRIPT,
  LIST_CONFIGS_SCRIPT,
  OVERRIDE_CONFIG_PATH,
  OVERRIDE_FOLDER,
  READ_FILES_SCRIPT,
  REMOVE_GIT_TOKEN_SCRIPT,
  SECRETS_FOLDER,
  SWITCH_BRANCH_SCRIPT,
  TOKEN_FILE,
  UP_SCRIPT,
  WRITE_AND_RUN_SCRIPT,
  buildCommand,
  cloneCommand,
  composeModelCommand,
  gitFilesCommand,
  listConfigsCommand,
  readFilesCommand,
  removeGitTokenCommand,
  switchBranchCommand,
  upCommand,
  writeAndRunCommand,
} from './scripts';
import { CONTAINER_CREDENTIAL_HELPER, GIT_CREDENTIALS_CONFIG_CONTENT } from './containerGit';

function hasProgram(name: string, args: string[]): boolean {
  return !spawnSync(name, args, { stdio: 'ignore' }).error;
}

const hasGit = hasProgram('git', ['--version']);
const hasDash = hasProgram('dash', ['-c', 'true']);

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function runNode(command: string[]): { status: number | null; stdout: string; stderr: string } {
  expect(command[0]).toBe('node');
  const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runSh(command: string[], input = ''): { status: number | null; stdout: string; stderr: string } {
  const [file, ...args] = command;
  const result = spawnSync(file, args, { encoding: 'utf8', input });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const SHELL_SCRIPTS: Array<[string, string]> = [
  ['CLONE_SCRIPT', CLONE_SCRIPT],
  ['SWITCH_BRANCH_SCRIPT', SWITCH_BRANCH_SCRIPT],
  ['GIT_FILES_SCRIPT', GIT_FILES_SCRIPT],
  ['REMOVE_GIT_TOKEN_SCRIPT', REMOVE_GIT_TOKEN_SCRIPT],
  ['GIT_SUMMARY_SCRIPT', GIT_SUMMARY_SCRIPT],
  ['UP_SCRIPT', UP_SCRIPT],
  ['BUILD_SCRIPT', BUILD_SCRIPT],
];

describe('shell scripts', () => {
  it.each(SHELL_SCRIPTS)('%s has valid sh syntax', (_name, script) => {
    const result = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasDash).each(SHELL_SCRIPTS)('%s has valid dash syntax (the /bin/sh of the helper)', (_name, script) => {
    const result = spawnSync('dash', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('never embeds a value: the commands pass all values as positional parameters', () => {
    expect(cloneCommand('acme/api', 'api', 'main')).toEqual(['sh', '-c', CLONE_SCRIPT, 'sh', 'acme/api', 'api', 'main']);
    expect(cloneCommand('acme/api', 'api')).toEqual(['sh', '-c', CLONE_SCRIPT, 'sh', 'acme/api', 'api', '']);
    expect(switchBranchCommand('/workspaces/api', 'feature/x', 'acme/api')).toEqual([
      'sh',
      '-c',
      SWITCH_BRANCH_SCRIPT,
      'sh',
      '/workspaces/api',
      'feature/x',
      'acme/api',
    ]);
    expect(gitFilesCommand('api', { name: 'Me', email: 'me@x' }, 'helper', 'octo')).toEqual([
      'sh',
      '-c',
      GIT_FILES_SCRIPT,
      'sh',
      'api',
      'Me',
      'me@x',
      'helper',
      'octo',
    ]);
    expect(removeGitTokenCommand()).toEqual(['sh', '-c', REMOVE_GIT_TOKEN_SCRIPT, 'sh']);
    expect(upCommand(OVERRIDE_CONFIG_PATH, ['up', '--x'])).toEqual(['sh', '-c', UP_SCRIPT, 'sh', OVERRIDE_CONFIG_PATH, 'up', '--x']);
    expect(buildCommand('/workspaces/api/.devcontainer/devcontainer.json', ['build'])).toEqual([
      'sh',
      '-c',
      BUILD_SCRIPT,
      'sh',
      '/workspaces/api/.devcontainer/devcontainer.json',
      'build',
    ]);
  });

  it.each([
    ['a repository name with a slash too many', ['acme/api/x', 'api', ''], 'Invalid repository name'],
    ['a repository name without owner', ['api', 'api', ''], 'Invalid repository name'],
    ['a repository name with a space', ['acme/my api', 'api', ''], 'Invalid repository name'],
    ['a repository name with ..', ['acme/..', 'api', ''], 'Invalid repository name'],
    ['a folder with a slash', ['acme/api', '../etc', ''], 'Invalid folder name'],
    ['a folder ..', ['acme/api', '..', ''], 'Invalid folder name'],
    ['a branch that looks like an option', ['acme/api', 'api', '--upload-pack=x'], 'Invalid branch name'],
  ])('CLONE_SCRIPT rejects %s', (_name, args, message) => {
    const result = runSh(['sh', '-c', CLONE_SCRIPT, 'sh', ...args], 'token');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it('SWITCH_BRANCH_SCRIPT rejects a branch that looks like an option', () => {
    const result = runSh(switchBranchCommand(tempDir(), '-f', 'acme/api'), 'token');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid branch name');
  });

  it.each([
    ['CLONE_SCRIPT', cloneCommand('acme/api', `devenv-test-${process.pid}-missing`)],
    ['SWITCH_BRANCH_SCRIPT', switchBranchCommand(os.tmpdir(), 'main', 'acme/api')],
  ])('%s refuses to write the token when the secrets folder is not a tmpfs mount', (_name, command) => {
    const result = runSh(command, 'secret-token-value');
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('is not a tmpfs mount');
    expect(result.stdout + result.stderr).not.toContain('secret-token-value');
  });

  it('keeps the credential helper intact through the shell quoting of the scripts', () => {
    for (const script of [CLONE_SCRIPT, SWITCH_BRANCH_SCRIPT]) {
      const line = script.split('\n').find((candidate) => candidate.startsWith('helper='));
      expect(line).toBeDefined();
      const result = runSh(['sh', '-c', `${line}\nprintf '%s' "$helper"`]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(CREDENTIAL_HELPER);
    }
  });

  it('UP_SCRIPT writes stdin to the override file before it runs the CLI', () => {
    const dir = tempDir();
    const override = path.join(dir, 'sub', 'devcontainer.json');
    // A fake `devcontainer` on PATH that prints its arguments and the override file.
    write(path.join(dir, 'bin', 'devcontainer'), `#!/bin/sh\nprintf '%s|' "$@"\ncat '${override}'\n`);
    fs.chmodSync(path.join(dir, 'bin', 'devcontainer'), 0o755);
    const result = spawnSync('sh', ['-c', UP_SCRIPT, 'sh', override, 'up', '--flag'], {
      encoding: 'utf8',
      input: '{"image":"x"}',
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('up|--flag|{"image":"x"}');
  });

  it('BUILD_SCRIPT adds --no-lockfile unless the repository has a lockfile', () => {
    const dir = tempDir();
    write(path.join(dir, 'bin', 'devcontainer'), `#!/bin/sh\nprintf '%s|' "$@"\n`);
    fs.chmodSync(path.join(dir, 'bin', 'devcontainer'), 0o755);
    const env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` };
    const config = path.join(dir, 'repo', '.devcontainer', 'devcontainer.json');
    const rootConfig = path.join(dir, 'repo', '.devcontainer.json');
    write(config, '{}');
    write(rootConfig, '{}');
    const run = (file: string) => spawnSync('sh', ['-c', BUILD_SCRIPT, 'sh', file, 'build', '--x'], { encoding: 'utf8', env }).stdout;

    expect(run(config)).toBe('build|--x|--no-lockfile|');
    write(path.join(dir, 'repo', '.devcontainer', 'devcontainer-lock.json'), '{}');
    expect(run(config)).toBe('build|--x|');
    // A root .devcontainer.json has the lockfile .devcontainer-lock.json.
    expect(run(rootConfig)).toBe('build|--x|--no-lockfile|');
    write(path.join(dir, 'repo', '.devcontainer-lock.json'), '{}');
    expect(run(rootConfig)).toBe('build|--x|');
  });
});

describe('WRITE_AND_RUN_SCRIPT (Docker Compose runs of the Dev Container CLI)', () => {
  /** A fake `devcontainer` that prints its arguments, one per line, and exits with $FAKE_EXIT. */
  function setup(): { dir: string; folder: string; env: NodeJS.ProcessEnv } {
    const dir = tempDir();
    write(path.join(dir, 'bin', 'devcontainer'), `#!/bin/sh\nprintf '%s\\n' "$@"\nexit "\${FAKE_EXIT:-0}"\n`);
    fs.chmodSync(path.join(dir, 'bin', 'devcontainer'), 0o755);
    const env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` };
    return { dir, folder: path.join(dir, 'override'), env };
  }

  function run(
    folder: string,
    env: NodeJS.ProcessEnv,
    files: Record<string, string>,
    args: string[],
    configs: { repository?: string; own?: string } = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['-e', WRITE_AND_RUN_SCRIPT, folder, configs.repository ?? '', configs.own ?? '', ...args], {
      encoding: 'utf8',
      input: JSON.stringify({ files }),
      env,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('builds its command with the override folder', () => {
    expect(writeAndRunCommand({}, ['up', '--x'])).toEqual(['node', '-e', WRITE_AND_RUN_SCRIPT, OVERRIDE_FOLDER, '', '', 'up', '--x']);
    expect(writeAndRunCommand({ repositoryConfig: '/workspaces/api/.devcontainer/devcontainer.json', config: OVERRIDE_CONFIG_PATH }, ['build'])).toEqual([
      'node',
      '-e',
      WRITE_AND_RUN_SCRIPT,
      OVERRIDE_FOLDER,
      '/workspaces/api/.devcontainer/devcontainer.json',
      OVERRIDE_CONFIG_PATH,
      'build',
    ]);
    expect(OVERRIDE_CONFIG_PATH).toBe(`${OVERRIDE_FOLDER}/devcontainer.json`);
  });

  it('writes the files (mode 0600) and the empty build context, then runs the CLI with the arguments', () => {
    const { folder, env } = setup();
    const files = { [`${folder}/devcontainer.json`]: '{"service":"app"}', [`${folder}/sub/compose.json`]: '{}' };
    const result = run(folder, env, files, ['up', '--override-config', `${folder}/devcontainer.json`]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`up\n--override-config\n${folder}/devcontainer.json\n`);
    expect(fs.readFileSync(`${folder}/devcontainer.json`, 'utf8')).toBe('{"service":"app"}');
    expect(fs.readFileSync(`${folder}/sub/compose.json`, 'utf8')).toBe('{}');
    expect(fs.statSync(`${folder}/devcontainer.json`).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${folder}/context`).isDirectory()).toBe(true);
    expect(fs.readdirSync(`${folder}/context`)).toEqual([]);
  });

  it('passes the exit code of the CLI on', () => {
    const { folder, env } = setup();
    expect(run(folder, { ...env, FAKE_EXIT: '3' }, {}, ['up']).status).toBe(3);
  });

  // Limit L-5 of unit 6: the compose files that the CLI generates in the cache volume accumulate otherwise.
  it('removes the compose files of the CLI older than 30 days from the data folder before up, and nothing else', () => {
    const { dir, folder, env } = setup();
    const data = path.join(dir, 'cache');
    const compose = path.join(data, 'docker-compose');
    const old = (Date.now() - COMPOSE_FILES_MAX_AGE_MS - 60_000) / 1000;
    const names = {
      oldFeatures: 'docker-compose.devcontainer.containerFeatures-1700000000000-3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d.yml',
      oldBuild: 'docker-compose.devcontainer.build-1700000000000.yml',
      newFeatures: 'docker-compose.devcontainer.containerFeatures-1800000000000-0a1b.yml',
      oldOther: 'notes.yml',
    };
    for (const [key, name] of Object.entries(names)) {
      write(path.join(compose, name), 'x');
      if (key.startsWith('old')) fs.utimesSync(path.join(compose, name), old, old);
    }
    // `build` and a run without the data folder leave them.
    expect(run(folder, env, {}, ['build', '--user-data-folder', data]).status).toBe(0);
    expect(run(folder, env, {}, ['up']).status).toBe(0);
    expect(fs.readdirSync(compose).sort()).toEqual(Object.values(names).sort());
    expect(run(folder, env, {}, ['up', '--user-data-folder', data]).status).toBe(0);
    expect(fs.readdirSync(compose).sort()).toEqual([names.newFeatures, names.oldOther].sort());
    // A missing folder is no error.
    expect(run(folder, env, {}, ['up', '--user-data-folder', path.join(dir, 'none')]).status).toBe(0);
  });

  it.each<[string, (folder: string) => string]>([
    ['a path outside the folder', () => '/tmp/elsewhere.json'],
    ['a path with ..', (folder) => `${folder}/../escape.json`],
    ['a relative path', () => 'compose.json'],
    ['the folder itself', (folder) => folder],
  ])('refuses %s and does not run the CLI', (_name, file) => {
    const { folder, env } = setup();
    const result = run(folder, env, { [file(folder)]: 'x' }, ['up']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid file');
    expect(result.stdout).toBe('');
  });

  it('refuses a text that is no text', () => {
    const { folder, env } = setup();
    const result = spawnSync(process.execPath, ['-e', WRITE_AND_RUN_SCRIPT, folder, '', '', 'up'], {
      encoding: 'utf8',
      input: JSON.stringify({ files: { [`${folder}/a.json`]: 1 } }),
      env,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
  });

  it('uses the lockfile of the repository next to our copy of the configuration, and adds --no-lockfile without one', () => {
    const { dir, folder, env } = setup();
    const repositoryConfig = path.join(dir, 'repo', '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    const own = `${folder}/devcontainer.json`;
    expect(run(folder, env, { [own]: '{}' }, ['build'], { repository: repositoryConfig, own }).stdout).toBe('build\n--no-lockfile\n');
    expect(fs.existsSync(`${folder}/devcontainer-lock.json`)).toBe(false);
    write(path.join(dir, 'repo', '.devcontainer', 'devcontainer-lock.json'), '{"features":{}}');
    expect(run(folder, env, { [own]: '{}' }, ['build'], { repository: repositoryConfig, own }).stdout).toBe('build\n');
    expect(fs.readFileSync(`${folder}/devcontainer-lock.json`, 'utf8')).toBe('{"features":{}}');
    // Without a copy of the configuration, the rule of BUILD_SCRIPT alone.
    expect(run(folder, env, {}, ['build'], { repository: repositoryConfig }).stdout).toBe('build\n');
    // A root .devcontainer.json has the lockfile .devcontainer-lock.json.
    const rootConfig = path.join(dir, 'repo', '.devcontainer.json');
    write(rootConfig, '{}');
    expect(run(folder, env, {}, ['build'], { repository: rootConfig }).stdout).toBe('build\n--no-lockfile\n');
  });

  it('refuses a copy of the configuration outside the folder', () => {
    const { dir, folder, env } = setup();
    const repositoryConfig = path.join(dir, 'repo', 'devcontainer.json');
    write(repositoryConfig, '{}');
    const result = run(folder, env, {}, ['build'], { repository: repositoryConfig, own: path.join(dir, 'elsewhere.json') });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
  });
});

describe('COMPOSE_MODEL_SCRIPT with a fake docker', () => {
  const MODEL = {
    name: 'devenv-3f2a9c1e',
    services: {
      app: { build: { context: '<repo>/.devcontainer', dockerfile: 'Dockerfile' }, volumes: [{ type: 'bind', source: '<repo>', target: '/app' }] },
      inline: { build: { context: '<repo>', dockerfile_inline: 'FROM alpine:3.22' } },
      outside: { build: { context: '<repo>', dockerfile: '../outside/Dockerfile' } },
      linked: { build: { context: '<repo>', dockerfile: 'linked.Dockerfile' } },
      remote: { build: { context: 'https://github.com/acme/tool.git' } },
      db: {
        image: 'postgres:16',
        env_file: ['<repo>/db.env', { path: '<repo>/missing.env', required: false }],
        volumes: [
          { type: 'bind', source: '<repo>/link-out', target: '/x' },
          { type: 'bind', source: '<repo>/missing', target: '/y' },
          { type: 'volume', source: 'pgdata', target: '/data' },
        ],
      },
    },
  };

  /**
   * A temporary repository and a fake `docker` on PATH: `compose version --short` prints 2.29.1, the probe prints
   * $FAKE_PROBE, and `config` writes its arguments and working folder to a file and prints $FAKE_MODEL (or fails with
   * $FAKE_ERROR).
   */
  function setup(): { dir: string; repo: string; argsFile: string; env: NodeJS.ProcessEnv } {
    const dir = tempDir();
    const repo = path.join(dir, 'repo');
    const argsFile = path.join(dir, 'args');
    write(path.join(repo, '.devcontainer', 'Dockerfile'), 'FROM node:24\n');
    write(path.join(repo, 'db.env'), 'A=1\n');
    write(path.join(dir, 'outside', 'Dockerfile'), 'FROM secret\n');
    write(path.join(dir, 'secret.txt'), 'secret\n');
    fs.symlinkSync(path.join(dir, 'outside', 'Dockerfile'), path.join(repo, 'linked.Dockerfile'));
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(repo, 'link-out'));
    const fake = [
      '#!/bin/sh',
      'shift',
      'if [ "$1 $2" = "version --short" ]; then echo 2.29.1; exit 0; fi',
      'case "$*" in',
      '  *"-p devenv-probe"*) cat > /dev/null; printf \'%s\\n\' "$FAKE_PROBE"; exit 0 ;;',
      'esac',
      `printf '%s\\n' "$PWD" "$COMPOSE_PROJECT_NAME" "$@" > '${argsFile}'`,
      'if [ -n "\${FAKE_ERROR:-}" ]; then printf \'%s\\n\' "$FAKE_ERROR" >&2; exit 15; fi',
      'printf \'%s\\n\' "$FAKE_MODEL"',
    ].join('\n');
    write(path.join(dir, 'bin', 'docker'), `${fake}\n`);
    fs.chmodSync(path.join(dir, 'bin', 'docker'), 0o755);
    const model = JSON.stringify(MODEL).split('<repo>').join(repo);
    const env = {
      ...process.env,
      PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      COMPOSE_PROJECT_NAME: 'devenv-3f2a9c1e',
      FAKE_PROBE: JSON.stringify({ services: { probe: { environment: { V: 'a$$b' } } } }),
      FAKE_MODEL: model,
    };
    return { dir, repo, argsFile, env };
  }

  function runModel(repo: string, files: string[], env: NodeJS.ProcessEnv): unknown {
    const command = composeModelCommand(repo, files);
    expect(command.slice(0, 3)).toEqual(['node', '-e', COMPOSE_MODEL_SCRIPT]);
    const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', env });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
  }

  it('prints the real paths of additional contexts, SSH keys, and the files of build secrets (review round 2, S2-03)', () => {
    const { dir, repo, env } = setup();
    fs.mkdirSync(path.join(repo, 'layout'));
    fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, 'ctx-link'));
    write(path.join(repo, 'key'), 'key');
    const model = {
      name: 'devenv-3f2a9c1e',
      services: {
        tool: {
          build: {
            context: repo,
            dockerfile_inline: 'FROM alpine',
            additional_contexts: { a: `${repo}/ctx-link`, b: `oci-layout://${repo}/layout:1`, c: 'docker-image://alpine', d: 'https://example.com/x.git' },
            ssh: [`deploy=${repo}/key`, 'default'],
            secrets: [{ source: 'npm', target: 'npm' }, 'env-only'],
          },
        },
      },
      secrets: { npm: { file: `${repo}/secret-link` }, 'env-only': { environment: 'X' } },
    };
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(repo, 'secret-link'));
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(model) }) as { realPaths: Record<string, string | null> };
    expect(output.realPaths).toMatchObject({
      [`${repo}/ctx-link`]: fs.realpathSync(path.join(dir, 'outside')),
      [`${repo}/layout`]: fs.realpathSync(path.join(repo, 'layout')),
      [`${repo}/key`]: fs.realpathSync(path.join(repo, 'key')),
      [`${repo}/secret-link`]: fs.realpathSync(path.join(dir, 'secret.txt')),
    });
    expect(Object.keys(output.realPaths).some((key) => key.includes('alpine') || key.includes('example.com'))).toBe(false);
  });

  it('prints the model of all profiles, the Dockerfiles in the repository, and the real paths', () => {
    const { dir, repo, argsFile, env } = setup();
    const files = [path.join(repo, 'compose.yml'), path.join(repo, '.devcontainer', 'compose.yml')];
    const output = runModel(repo, files, env) as Record<string, unknown>;
    expect(fs.readFileSync(argsFile, 'utf8').split('\n').slice(0, -1)).toEqual([
      repo,
      'devenv-3f2a9c1e',
      '-f',
      files[0],
      '-f',
      files[1],
      '--profile',
      '*',
      'config',
      '--format',
      'json',
    ]);
    expect(output.version).toBe('2.29.1');
    expect(output.dollarEscaped).toBe(true);
    expect(output.model).toEqual(JSON.parse(env.FAKE_MODEL!));
    // Not a Dockerfile in the repository whose link leads out of it, and none of a remote context. Review round 1 (S1):
    // a Dockerfile outside the repository that is no path of the workspace helper is read now (with the checks off it
    // may be built, and its FROM images must be checked); before, it was left out.
    expect(output.dockerfiles).toEqual({ app: 'FROM node:24\n', inline: 'FROM alpine:3.22', outside: 'FROM secret\n' });
    // Review round 1 (S1): the real paths of the build contexts and the Dockerfiles too.
    expect(output.realPaths).toEqual({
      [repo]: fs.realpathSync(repo),
      [`${repo}/.devcontainer`]: fs.realpathSync(path.join(repo, '.devcontainer')),
      [`${repo}/.devcontainer/Dockerfile`]: fs.realpathSync(path.join(repo, '.devcontainer', 'Dockerfile')),
      [path.join(dir, 'outside', 'Dockerfile')]: fs.realpathSync(path.join(dir, 'outside', 'Dockerfile')),
      [`${repo}/linked.Dockerfile`]: fs.realpathSync(path.join(dir, 'outside', 'Dockerfile')),
      [`${repo}/link-out`]: fs.realpathSync(path.join(dir, 'secret.txt')),
      [`${repo}/missing`]: null,
      [`${repo}/db.env`]: fs.realpathSync(path.join(repo, 'db.env')),
      [`${repo}/missing.env`]: null,
    });
  });

  it('records the real path of a build context that links out of the repository, and does not read its Dockerfile', () => {
    // Review round 1 (S1): without the real path of the context, a link to a folder of the workspace helper passed.
    const { dir, repo, env } = setup();
    fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, 'ctx'));
    const model = { name: 'devenv-3f2a9c1e', services: { app: { build: { context: `${repo}/ctx` } } } };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(model) }) as Record<string, unknown>;
    expect(output.realPaths).toEqual({
      [`${repo}/ctx`]: fs.realpathSync(path.join(dir, 'outside')),
      [`${repo}/ctx/Dockerfile`]: fs.realpathSync(path.join(dir, 'outside', 'Dockerfile')),
    });
    expect(output.dockerfiles).toEqual({});
  });

  it('does not read a Dockerfile below the folders of the kernel (review round 3, S3-1)', () => {
    const { dir, repo, env } = setup();
    const context = `/proc/self/root${path.join(dir, 'outside')}`;
    const model = { name: 'devenv-3f2a9c1e', services: { app: { build: { context } } } };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(model) }) as Record<string, unknown>;
    expect(output.dockerfiles).toEqual({});
  });

  it('lists the build contexts and Dockerfiles that are missing in the repository, not links that lead out or nowhere (review round 3, P3-1)', () => {
    const { dir, repo, env } = setup();
    fs.mkdirSync(path.join(repo, 'ctx'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(repo, 'dangling.Dockerfile'));
    fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, 'out'));
    const model = {
      name: 'devenv-3f2a9c1e',
      services: {
        a: { build: { context: `${repo}/ctx`, dockerfile: 'missing.Dockerfile' } },
        b: { build: { context: `${repo}/gone` } },
        c: { build: { context: repo, dockerfile: 'dangling.Dockerfile' } },
        d: { build: { context: `${repo}/out`, dockerfile: 'missing.Dockerfile' } },
        e: { build: { context: path.join(dir, 'elsewhere') } },
      },
    };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(model) }) as Record<string, unknown>;
    expect(output.missing).toEqual([`${repo}/ctx/missing.Dockerfile`, `${repo}/gone`, `${repo}/gone/Dockerfile`]);
  });

  it('lists a Dockerfile whose link chain stays in the repository and leads nowhere, not one that leads out (review round 4, P4-1)', () => {
    const { dir, repo, env } = setup();
    fs.mkdirSync(path.join(repo, 'db'));
    fs.symlinkSync('../docker/Dockerfile.gone', path.join(repo, 'db', 'Dockerfile'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(repo, 'db', 'out.Dockerfile'));
    fs.symlinkSync('loop.Dockerfile', path.join(repo, 'db', 'loop.Dockerfile'));
    const model = {
      name: 'devenv-3f2a9c1e',
      services: {
        a: { build: { context: `${repo}/db` } },
        b: { build: { context: `${repo}/db`, dockerfile: 'out.Dockerfile' } },
        c: { build: { context: `${repo}/db`, dockerfile: 'loop.Dockerfile' } },
      },
    };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(model) }) as Record<string, unknown>;
    expect(output.missing).toEqual([`${repo}/db/Dockerfile`]);
  });

  it('prints the hash of the files that Compose read, which follows their texts (review round 1, P-4)', () => {
    const { repo, env } = setup();
    const files = [path.join(repo, 'compose.yml')];
    write(files[0], 'services: {}\n');
    const first = (runModel(repo, files, env) as Record<string, unknown>).inputsHash;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect((runModel(repo, files, env) as Record<string, unknown>).inputsHash).toBe(first);
    // The .env of the project folder (the folder of the first compose file).
    write(path.join(repo, '.env'), 'A=1\n');
    const withEnv = (runModel(repo, files, env) as Record<string, unknown>).inputsHash;
    expect(withEnv).not.toBe(first);
    // An env_file of the model.
    write(path.join(repo, 'db.env'), 'A=2\n');
    const withEnvFile = (runModel(repo, files, env) as Record<string, unknown>).inputsHash;
    expect(withEnvFile).not.toBe(withEnv);
    // A compose file.
    write(files[0], 'services: { a: {} }\n');
    expect((runModel(repo, files, env) as Record<string, unknown>).inputsHash).not.toBe(withEnvFile);
  });

  it('reports a $ that the output does not escape', () => {
    const { repo, env } = setup();
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_PROBE: JSON.stringify({ services: { probe: { environment: { V: 'a$b' } } } }) });
    expect((output as Record<string, unknown>).dollarEscaped).toBe(false);
  });

  it('reports an unknown form of $ as an error', () => {
    const { repo, env } = setup();
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_PROBE: JSON.stringify({ services: { probe: { environment: { V: 'ab' } } } }) });
    expect(output).toEqual({ error: 'docker compose config printed an unknown form of $: "ab"' });
  });

  it('prints the message of Docker Compose when config fails', () => {
    const { repo, env } = setup();
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_ERROR: 'yaml: line 3: mapping values are not allowed' });
    expect(output).toEqual({ error: 'yaml: line 3: mapping values are not allowed' });
  });

  it('prints an error when Docker Compose is missing', () => {
    const { repo, env } = setup();
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, PATH: path.join(tempDir(), 'empty') });
    expect(output).toMatchObject({ error: expect.stringContaining('ENOENT') });
  });
});

describe.skipIf(!hasGit)('credential helper', () => {
  function fill(tokenFile: string, request: string): { status: number | null; stdout: string; stderr: string } {
    const helper = CREDENTIAL_HELPER.split(TOKEN_FILE).join(tokenFile);
    const result = spawnSync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'credential', 'fill'], {
      encoding: 'utf8',
      input: request,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('answers requests for https://github.com with the token from the file', () => {
    const tokenFile = path.join(tempDir(), 'token');
    fs.writeFileSync(tokenFile, 'gho_secret\n');
    const result = fill(tokenFile, 'protocol=https\nhost=github.com\npath=acme/api.git\n\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('username=x-access-token\n');
    expect(result.stdout).toContain('password=gho_secret\n');
  });

  it.each([
    ['another host', 'protocol=https\nhost=example.com\n\n'],
    ['http', 'protocol=http\nhost=github.com\n\n'],
  ])('never gives the token to %s', (_name, request) => {
    const tokenFile = path.join(tempDir(), 'token');
    fs.writeFileSync(tokenFile, 'gho_secret\n');
    const result = fill(tokenFile, request);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('gho_secret');
  });
});

describe('LIST_CONFIGS_SCRIPT', () => {
  it('lists the configurations in the order of precedence', () => {
    const repo = tempDir();
    write(path.join(repo, '.devcontainer', 'devcontainer.json'), '{}');
    write(path.join(repo, '.devcontainer.json'), '{}');
    write(path.join(repo, '.devcontainer', 'python', 'devcontainer.json'), '{}');
    write(path.join(repo, '.devcontainer', 'Zeta', 'devcontainer.json'), '{}');
    write(path.join(repo, '.devcontainer', 'go-1', 'devcontainer.json'), '{}');
    write(path.join(repo, '.devcontainer', 'go', 'devcontainer.json'), '{}');
    write(path.join(repo, '.devcontainer', 'empty', 'other.json'), '{}');
    write(path.join(repo, '.devcontainer', 'folder', 'devcontainer.json', 'x'), '{}');
    write(path.join(repo, '.devcontainer', 'Dockerfile'), 'FROM x');

    const result = runNode(listConfigsCommand(repo));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The order of the discovery (detect.ts): UTF-16 code units, uppercase first, 'go' < 'go-1'.
    expect(JSON.parse(result.stdout)).toEqual([
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
      '.devcontainer/Zeta/devcontainer.json',
      '.devcontainer/go/devcontainer.json',
      '.devcontainer/go-1/devcontainer.json',
      '.devcontainer/python/devcontainer.json',
    ]);
  });

  it('prints an empty list for a repository without configuration and for a missing folder', () => {
    expect(JSON.parse(runNode(listConfigsCommand(tempDir())).stdout)).toEqual([]);
    expect(JSON.parse(runNode(listConfigsCommand(path.join(tempDir(), 'missing'))).stdout)).toEqual([]);
  });

  it('names the same default configuration as the discovery', () => {
    const repo = tempDir();
    for (const name of ['python', 'go-1', 'go', 'Zeta']) write(path.join(repo, '.devcontainer', name, 'devcontainer.json'), '{}');
    const listed = JSON.parse(runNode(listConfigsCommand(repo)).stdout) as string[];
    const detected = detectConfigurations({
      folder: {
        entries: ['python', 'go-1', 'go', 'Zeta'].map((name) => ({
          name,
          type: 'tree',
          object: { entries: [{ name: 'devcontainer.json', type: 'blob' }] },
        })),
      },
    });
    expect(listed).toEqual(detected);
  });
});

describe('SWITCH_BRANCH_SCRIPT with fake tools', () => {
  // The script needs Linux (a tmpfs in /proc/mounts, GNU stat). Fake tools on PATH stand in for them and for Git, and
  // record what the script does.
  function runSwitch(git: { fetchExit: number; switchExit: number }): {
    status: number | null;
    stdout: string;
    stderr: string;
    log: string;
    tokenLeft: boolean;
  } {
    const dir = tempDir();
    const bin = path.join(dir, 'bin');
    const secrets = path.join(dir, 'secrets');
    const repo = path.join(dir, 'repo');
    const log = path.join(dir, 'log');
    fs.mkdirSync(secrets);
    fs.mkdirSync(repo);
    const tool = (name: string, body: string) => {
      write(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    };
    tool('awk', 'exit 0');
    tool('stat', 'echo 1000:1000');
    tool('find', `echo "find $*" >> '${log}'`);
    tool(
      'git',
      [
        'while [ "$1" = -c ]; do shift 2; done',
        `if [ -s '${path.join(secrets, 'github-token')}' ]; then token=present; else token=absent; fi`,
        `echo "git $1 token=$token" >> '${log}'`,
        'case "$1" in',
        `  fetch) [ ${git.fetchExit} -eq 0 ] || { echo 'fatal: unable to access the repository' >&2; exit ${git.fetchExit}; } ;;`,
        `  switch) [ ${git.switchExit} -eq 0 ] || { echo 'error: Your local changes would be overwritten' >&2; exit ${git.switchExit}; } ;;`,
        'esac',
      ].join('\n'),
    );
    const script = SWITCH_BRANCH_SCRIPT.split(SECRETS_FOLDER).join(secrets);
    const result = spawnSync('sh', ['-c', script, 'sh', repo, 'dev', 'acme/api'], {
      encoding: 'utf8',
      input: 'gho_secret',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
      tokenLeft: fs.existsSync(path.join(secrets, 'github-token')),
    };
  }

  it('fetches with the token, switches without it, and restores the owner', () => {
    const result = runSwitch({ fetchExit: 0, switchExit: 0 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.log).toMatch(/^git fetch token=present\ngit switch token=absent\nfind .*-exec chown -h 1000:1000/);
    expect(result.tokenLeft).toBe(false);
  });

  it('restores the owner also when Git refuses the switch (the fetch wrote files as root)', () => {
    const result = runSwitch({ fetchExit: 0, switchExit: 1 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('error: Your local changes would be overwritten');
    expect(result.log).toContain('git switch');
    expect(result.log).toMatch(/find .*-exec chown -h 1000:1000/);
    expect(result.tokenLeft).toBe(false);
  });

  it('restores the owner and does not switch when the fetch fails', () => {
    const result = runSwitch({ fetchExit: 128, switchExit: 0 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fatal: unable to access the repository');
    expect(result.log).not.toContain('git switch');
    expect(result.log).toMatch(/find .*-exec chown -h 1000:1000/);
    expect(result.tokenLeft).toBe(false);
  });
});

describe.skipIf(!hasGit)('GIT_FILES_SCRIPT with fake tools', () => {
  // The script needs Linux (a tmpfs in /proc/mounts, GNU stat and mv). Fake tools on PATH stand in for them; Git is real.
  const TOKEN = 'gho_secret_value';

  function setup(): { ws: string; secrets: string; bin: string; log: string } {
    const dir = tempDir();
    const ws = path.join(dir, 'workspaces');
    const secrets = path.join(dir, 'secrets');
    const bin = path.join(dir, 'bin');
    const log = path.join(dir, 'log');
    fs.mkdirSync(path.join(ws, 'api'), { recursive: true });
    fs.mkdirSync(secrets);
    const tool = (name: string, body: string) => {
      write(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    };
    tool('awk', 'exit 0');
    tool('stat', 'echo 1000:1001');
    tool('chown', `echo "chown $*" >> '${log}'`);
    tool('mv', 'if [ "$1" = -fT ]; then shift; exec /bin/mv -f "$1" "$2"; fi\nexec /bin/mv "$@"');
    return { ws, secrets, bin, log };
  }

  function run(env: { ws: string; secrets: string; bin: string }, token = TOKEN, folder = 'api', login = 'scalarion') {
    const script = GIT_FILES_SCRIPT.split(SECRETS_FOLDER).join(env.secrets).split('/workspaces').join(env.ws);
    const command = gitFilesCommand(
      folder,
      { name: 'Hannes Stauss', email: '1001+scalarion@users.noreply.github.com' },
      CONTAINER_CREDENTIAL_HELPER,
      login,
    );
    const result = spawnSync('sh', ['-c', script, ...command.slice(3)], {
      encoding: 'utf8',
      input: token,
      env: { ...process.env, PATH: `${env.bin}${path.delimiter}${process.env.PATH ?? ''}`, GIT_CONFIG_NOSYSTEM: '1' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function gitConfig(file: string, ...args: string[]): string {
    return spawnSync('git', ['config', '--file', file, ...args], { encoding: 'utf8' }).stdout;
  }

  it('writes the token (0600), the Git configuration, and the Docker folder, owned by the repository owner', () => {
    const env = setup();
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    const dir = path.join(env.ws, '.devenv+');
    const tokenFile = path.join(dir, 'github-token');
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(TOKEN);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    const cfg = path.join(dir, 'gitconfig');
    expect(gitConfig(cfg, 'user.name')).toBe('Hannes Stauss\n');
    expect(gitConfig(cfg, 'user.email')).toBe('1001+scalarion@users.noreply.github.com\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(fs.statSync(path.join(dir, 'docker')).mode & 0o777).toBe(0o700);
    const chowned = fs.readFileSync(env.log, 'utf8');
    expect(chowned).toContain(`chown 1000:1001 ${path.join(dir, '.work.')}`);
    expect(chowned).toContain(`chown -h 1000:1001 ${dir} ${dir}/docker ${dir}/gitconfig`);
    expect(chowned).toContain(cfg);
    // The token is gone from the tmpfs, and no temporary folder is left.
    expect(fs.readdirSync(env.secrets)).toEqual([]);
    // No GnuPG folder: the extension does not change where GnuPG works (user decision 2026-09-25).
    expect(fs.readdirSync(dir).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig', 'github-token']);
    // The file for the credential helpers of the user: only comments, readable by every user of the container.
    const credentials = path.join(dir, 'credentials.gitconfig');
    expect(fs.readFileSync(credentials, 'utf8')).toBe(GIT_CREDENTIALS_CONFIG_CONTENT.split('/workspaces').join(env.ws));
    expect(fs.statSync(credentials).mode & 0o777).toBe(0o644);
    expect(spawnSync('git', ['config', '--file', credentials, '--list'], { encoding: 'utf8' })).toMatchObject({ status: 0, stdout: '' });
    expect(chowned).toContain(`${cfg} ${credentials}`);
    // The token is only in the token file and in the sign-in of the GitHub CLI.
    const hosts = path.join(dir, 'gh', 'hosts.yml');
    expect(spawnSync('grep', ['-rl', TOKEN, env.ws], { encoding: 'utf8' }).stdout.trim().split('\n').sort()).toEqual([hosts, tokenFile].sort());
  });

  it('writes a new token at each run, and keeps the changes of the user in the Git configuration', () => {
    const env = setup();
    expect(run(env).status).toBe(0);
    const cfg = path.join(env.ws, '.devenv+', 'gitconfig');
    spawnSync('git', ['config', '--file', cfg, 'user.name', 'Changed Name']);
    spawnSync('git', ['config', '--file', cfg, 'alias.st', 'status']);
    const before = fs.readFileSync(cfg, 'utf8');
    expect(run(env, 'gho_new_token').status).toBe(0);
    expect(fs.readFileSync(path.join(env.ws, '.devenv+', 'github-token'), 'utf8')).toBe('gho_new_token');
    // Unchanged: the credential section is as it must be.
    expect(fs.readFileSync(cfg, 'utf8')).toBe(before);

    // The credential helpers of the user stay.
    const credentials = path.join(env.ws, '.devenv+', 'credentials.gitconfig');
    fs.writeFileSync(credentials, '[credential "https://gitlab.example.com"]\n\thelper = store\n');
    expect(run(env).status).toBe(0);
    expect(fs.readFileSync(credentials, 'utf8')).toBe('[credential "https://gitlab.example.com"]\n\thelper = store\n');

    // A changed credential section is repaired; the rest of the file stays.
    spawnSync('git', ['config', '--file', cfg, '--replace-all', 'credential.https://github.com.helper', 'store']);
    expect(run(env).status).toBe(0);
    expect(gitConfig(cfg, 'user.name')).toBe('Changed Name\n');
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  it('replaces a link in place of the configuration folder, so the token never goes into the repository', () => {
    const env = setup();
    fs.symlinkSync(path.join(env.ws, 'api'), path.join(env.ws, '.devenv+'));
    expect(run(env).status).toBe(0);
    expect(fs.lstatSync(path.join(env.ws, '.devenv+')).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(env.ws, 'api'))).toEqual([]);
  });

  it('replaces a link or a folder in place of credentials.gitconfig', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    const target = path.join(env.ws, 'api', 'target');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'credentials.gitconfig'));
    expect(run(env).status).toBe(0);
    expect(fs.lstatSync(path.join(dir, 'credentials.gitconfig')).isFile()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');

    fs.rmSync(path.join(dir, 'credentials.gitconfig'));
    fs.mkdirSync(path.join(dir, 'credentials.gitconfig'));
    expect(run(env).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'credentials.gitconfig'), 'utf8')).toBe(GIT_CREDENTIALS_CONFIG_CONTENT.split('/workspaces').join(env.ws));
  });

  it('signs the GitHub CLI in as the owner account with the token of the token file (hosts.yml, 0600 in a 0700 folder)', () => {
    const env = setup();
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const gh = path.join(env.ws, '.devenv+', 'gh');
    const hosts = path.join(gh, 'hosts.yml');
    // Both forms that gh reads: the keys of the host (gh before 2.40, and the active account of gh 2.40 and newer), and
    // the accounts under `users` (gh 2.40 and newer).
    expect(fs.readFileSync(hosts, 'utf8')).toBe(
      [
        'github.com:',
        '    users:',
        '        "scalarion":',
        `            oauth_token: "${TOKEN}"`,
        '    git_protocol: https',
        `    oauth_token: "${TOKEN}"`,
        '    user: "scalarion"',
        '',
      ].join('\n'),
    );
    expect(fs.statSync(hosts).mode & 0o777).toBe(0o600);
    expect(fs.statSync(gh).mode & 0o777).toBe(0o700);
    const chowned = fs.readFileSync(env.log, 'utf8');
    expect(chowned).toMatch(new RegExp(`chown 1000:1001 \\S*/\\.work\\.[^/]+/hosts\\.yml`));
    expect(chowned).toContain(`${path.join(env.ws, '.devenv+', 'credentials.gitconfig')} ${gh}`);
    expect(result.stdout).not.toContain(TOKEN);
    // No temporary folder is left, and gh's own config.yml is not written.
    expect(fs.readdirSync(path.join(env.ws, '.devenv+')).filter((name) => name.startsWith('.work'))).toEqual([]);
    expect(fs.readdirSync(gh)).toEqual(['hosts.yml']);
  });

  it('writes hosts.yml again at each run (a new sign-in), and keeps the other files of the gh folder', () => {
    const env = setup();
    expect(run(env).status).toBe(0);
    const gh = path.join(env.ws, '.devenv+', 'gh');
    const hosts = path.join(gh, 'hosts.yml');
    // gh changed it (for example `gh auth login` as another account in the container), and wrote its own files.
    fs.writeFileSync(hosts, 'github.com:\n    user: someone-else\n    oauth_token: gho_other\nghe.example.com:\n    user: x\n');
    fs.writeFileSync(path.join(gh, 'config.yml'), 'version: "1"\neditor: vim\n');
    expect(run(env, 'gho_new_token', 'api', 'octo-cat').status).toBe(0);
    const text = fs.readFileSync(hosts, 'utf8');
    expect(text).toContain('    oauth_token: "gho_new_token"\n    user: "octo-cat"\n');
    expect(text).toContain('        "octo-cat":\n            oauth_token: "gho_new_token"\n');
    expect(text).not.toMatch(/someone-else|gho_other|ghe\.example\.com/);
    expect(fs.readFileSync(path.join(gh, 'config.yml'), 'utf8')).toBe('version: "1"\neditor: vim\n');
  });

  it('replaces a link or a folder in place of the gh folder or hosts.yml, so the token never goes to another place', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    const elsewhere = path.join(env.ws, 'api', 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(dir, 'gh'));
    expect(run(env).status).toBe(0);
    expect(fs.lstatSync(path.join(dir, 'gh')).isDirectory()).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual([]);

    const target = path.join(env.ws, 'api', 'target');
    fs.writeFileSync(target, 'x');
    fs.rmSync(path.join(dir, 'gh', 'hosts.yml'));
    fs.symlinkSync(target, path.join(dir, 'gh', 'hosts.yml'));
    expect(run(env).status).toBe(0);
    expect(fs.lstatSync(path.join(dir, 'gh', 'hosts.yml')).isFile()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');

    fs.rmSync(path.join(dir, 'gh', 'hosts.yml'));
    fs.mkdirSync(path.join(dir, 'gh', 'hosts.yml'));
    expect(run(env).status).toBe(0);
    expect(fs.lstatSync(path.join(dir, 'gh', 'hosts.yml')).isFile()).toBe(true);
  });

  it('signs the GitHub CLI in nowhere for a token that YAML would need to escape, and still writes the token file', () => {
    const env = setup();
    expect(run(env).status).toBe(0);
    const hosts = path.join(env.ws, '.devenv+', 'gh', 'hosts.yml');
    expect(fs.existsSync(hosts)).toBe(true);
    const result = run(env, 'gho_"x":\\y');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('The GitHub CLI in the container is not signed in');
    expect(fs.existsSync(hosts)).toBe(false);
    expect(fs.readFileSync(path.join(env.ws, '.devenv+', 'github-token'), 'utf8')).toBe('gho_"x":\\y');
  });

  it('signs the GitHub CLI in with the login of an Enterprise Managed User (with an underscore)', () => {
    const env = setup();
    const result = run(env, TOKEN, 'api', 'dev_acme');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const text = fs.readFileSync(path.join(env.ws, '.devenv+', 'gh', 'hosts.yml'), 'utf8');
    expect(text).toContain('    users:\n        "dev_acme":\n            oauth_token: "gho_secret_value"\n');
    expect(text).toContain('    user: "dev_acme"\n');
  });

  // Until review round 1 of unit 5, an invalid login stopped the script before it wrote anything, so a login that the
  // rule did not know (the underscore of Enterprise Managed Users) left the container without any Git setup. Now the
  // invalid login never goes into hosts.yml, and the token and the Git configuration are still written.
  it.each([
    ['empty', ''],
    ['starting with a hyphen', '-octo'],
    ['starting with an underscore', '_x'],
    ['with a quote', 'octo"'],
    ['with a colon and a space', 'a: b'],
    ['with a new line', 'octo\nuser: x'],
    ['too long', 'x'.repeat(40)],
  ])('signs the GitHub CLI in nowhere for a GitHub login %s, and still writes the token and the Git configuration', (_name, login) => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    // A sign-in of an earlier run is removed, so gh never works with an old token or as another account.
    expect(run(env).status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'gh', 'hosts.yml'))).toBe(true);
    const result = run(env, TOKEN, 'api', login);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('The GitHub CLI in the container is not signed in: the GitHub login of the account is not known.');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(fs.existsSync(path.join(dir, 'gh', 'hosts.yml'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'github-token'), 'utf8')).toBe(TOKEN);
    expect(gitConfig(path.join(dir, 'gitconfig'), '--get-all', 'credential.https://github.com.helper')).toBe(
      `\n${CONTAINER_CREDENTIAL_HELPER}\n`,
    );
    expect(fs.readdirSync(env.secrets)).toEqual([]);
  });

  it('writes the token and the Git configuration without a GitHub login on the first run too', () => {
    const env = setup();
    const result = run(env, TOKEN, 'api', '');
    expect(result.status).toBe(0);
    const dir = path.join(env.ws, '.devenv+');
    expect(fs.readFileSync(path.join(dir, 'github-token'), 'utf8')).toBe(TOKEN);
    expect(fs.statSync(path.join(dir, 'github-token')).mode & 0o777).toBe(0o600);
    expect(gitConfig(path.join(dir, 'gitconfig'), 'user.name')).toBe('Hannes Stauss\n');
    expect(fs.existsSync(path.join(dir, 'gh', 'hosts.yml'))).toBe(false);
  });

  it('writes nothing without the repository folder, and nothing without a tmpfs for the token', () => {
    const env = setup();
    const missing = run(env, TOKEN, 'other');
    expect(missing.status).toBe(4);
    expect(fs.existsSync(path.join(env.ws, '.devenv+'))).toBe(false);

    write(path.join(env.bin, 'awk'), '#!/bin/sh\nexit 1\n');
    const noTmpfs = run(env);
    expect(noTmpfs.status).toBe(3);
    expect(noTmpfs.stderr).toContain('is not a tmpfs mount');
    expect(fs.existsSync(path.join(env.ws, '.devenv+'))).toBe(false);
    expect(noTmpfs.stdout + noTmpfs.stderr).not.toContain(TOKEN);
  });

  it('rejects an invalid folder name', () => {
    const result = run(setup(), TOKEN, '../etc');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid folder name');
  });
});

describe('REMOVE_GIT_TOKEN_SCRIPT (concept 7.5, in the workspace helper)', () => {
  function runRemoval(ws: string): { status: number | null; stdout: string; stderr: string } {
    const script = REMOVE_GIT_TOKEN_SCRIPT.split('/workspaces').join(ws);
    const result = spawnSync('sh', ['-c', script, 'sh'], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('removes the token file and the sign-in of the GitHub CLI, and nothing else', () => {
    const ws = tempDir();
    const dir = path.join(ws, '.devenv+');
    write(path.join(dir, 'github-token'), 'gho_secret');
    write(path.join(dir, 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: "gho_secret"\n');
    write(path.join(dir, 'gh', 'config.yml'), 'editor: vim\n');
    write(path.join(dir, 'gitconfig'), '[user]\n\tname = x\n');
    write(path.join(ws, 'api', 'README.md'), 'x');
    const result = runRemoval(ws);
    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout).toContain('The GitHub token was removed');
    expect(fs.existsSync(path.join(dir, 'github-token'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'gh', 'hosts.yml'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'gh'))).toEqual(['config.yml']);
    expect(fs.readdirSync(dir).sort()).toEqual(['gh', 'gitconfig']);
    expect(fs.readdirSync(path.join(ws, 'api'))).toEqual(['README.md']);
  });

  it('succeeds when there is no token (a volume of an older version, or removed before)', () => {
    const ws = tempDir();
    expect(runRemoval(ws)).toMatchObject({ status: 0, stderr: '' });
    fs.mkdirSync(path.join(ws, '.devenv+'));
    expect(runRemoval(ws)).toMatchObject({ status: 0, stderr: '' });
  });

  it('removes a link in place of the token file, not its target', () => {
    const ws = tempDir();
    const target = path.join(ws, 'api', 'kept');
    write(target, 'x');
    fs.mkdirSync(path.join(ws, '.devenv+', 'gh'), { recursive: true });
    fs.symlinkSync(target, path.join(ws, '.devenv+', 'github-token'));
    fs.symlinkSync(target, path.join(ws, '.devenv+', 'gh', 'hosts.yml'));
    expect(runRemoval(ws).status).toBe(0);
    expect(fs.existsSync(path.join(ws, '.devenv+', 'github-token'))).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('fails with exit code 1 when a file cannot be removed, and removes the other one all the same', () => {
    const ws = tempDir();
    const dir = path.join(ws, '.devenv+');
    write(path.join(dir, 'github-token'), 'gho_secret');
    write(path.join(dir, 'gh', 'hosts.yml'), 'x');
    // An rm that refuses the token file (root may remove any file, so a fake tool stands in for the refusal).
    const bin = path.join(ws, 'bin');
    write(path.join(bin, 'rm'), `#!/bin/sh\ncase "$*" in *github-token*) echo 'rm: Permission denied' >&2; exit 1 ;; esac\nexec /bin/rm "$@"\n`);
    fs.chmodSync(path.join(bin, 'rm'), 0o755);
    const script = REMOVE_GIT_TOKEN_SCRIPT.split('/workspaces').join(ws);
    const result = spawnSync('sh', ['-c', script, 'sh'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('github-token could not be removed');
    expect(result.stdout).not.toContain('The GitHub token was removed');
    expect(fs.existsSync(path.join(dir, 'gh', 'hosts.yml'))).toBe(false);
  });
});

describe('READ_FILES_SCRIPT', () => {
  function read(repo: string, configPath: string): unknown {
    const result = runNode(readFilesCommand(repo, configPath));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }

  it('reads the configuration and its Dockerfile (JSONC, relative to the configuration folder)', () => {
    const repo = tempDir();
    const configText = `{
  // A comment with "quotes" and a // slash.
  "name": "api /* not a comment */",
  "build": {
    "dockerfile": "../docker/Dockerfile", /* trailing comma follows */
  },
}`;
    write(path.join(repo, '.devcontainer', 'devcontainer.json'), configText);
    write(path.join(repo, 'docker', 'Dockerfile'), 'FROM node:22\n');
    expect(read(repo, '.devcontainer/devcontainer.json')).toEqual({
      configText,
      dockerfilePath: 'docker/Dockerfile',
      dockerfileText: 'FROM node:22\n',
    });
  });

  it('supports the old property dockerFile and a configuration in the repository root', () => {
    const repo = tempDir();
    write(path.join(repo, '.devcontainer.json'), '﻿{ "dockerFile": "Dockerfile" }');
    write(path.join(repo, 'Dockerfile'), 'FROM alpine\n');
    expect(read(repo, '.devcontainer.json')).toMatchObject({ dockerfilePath: 'Dockerfile', dockerfileText: 'FROM alpine\n' });
  });

  it('gives null when the configuration does not exist', () => {
    expect(read(tempDir(), '.devcontainer/devcontainer.json')).toBeNull();
  });

  it('returns only the text for an image configuration, invalid JSON, or a missing Dockerfile', () => {
    const repo = tempDir();
    write(path.join(repo, 'a', 'devcontainer.json'), '{ "image": "node:22" }');
    write(path.join(repo, 'b', 'devcontainer.json'), '{ "build": ');
    write(path.join(repo, 'c', 'devcontainer.json'), '{ "build": { "dockerfile": "Dockerfile" } }');
    expect(read(repo, 'a/devcontainer.json')).toEqual({ configText: '{ "image": "node:22" }' });
    expect(read(repo, 'b/devcontainer.json')).toEqual({ configText: '{ "build": ' });
    expect(read(repo, 'c/devcontainer.json')).toEqual({
      configText: '{ "build": { "dockerfile": "Dockerfile" } }',
      dockerfilePath: 'c/Dockerfile',
      // Review round 3, P3-1: changed expectation, a missing Dockerfile of the repository is told apart.
      dockerfileMissing: true,
    });
  });

  it('never reads a Dockerfile outside of the repository or with an unresolved variable', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    write(path.join(root, 'secret'), 'secret');
    write(path.join(repo, 'a', 'devcontainer.json'), '{ "build": { "dockerfile": "../../secret" } }');
    write(path.join(repo, 'b', 'devcontainer.json'), '{ "build": { "dockerfile": "${localEnv:X}/Dockerfile" } }');
    expect(read(repo, 'a/devcontainer.json')).toEqual({ configText: '{ "build": { "dockerfile": "../../secret" } }' });
    expect(read(repo, 'b/devcontainer.json')).not.toHaveProperty('dockerfilePath');
  });

  it('reads the Dockerfile that the resolved configuration names in place of the one of the text (review round 2, S2-01)', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    write(path.join(root, 'secret'), 'secret');
    write(path.join(repo, '.devcontainer', 'devcontainer.json'), '{ "build": { "dockerfile": "${localEnv:X:Dockerfile}" } }');
    write(path.join(repo, '.devcontainer', 'Dockerfile'), 'FROM node:24\n');
    const run = (dockerfile: string) => {
      const result = runNode(readFilesCommand(repo, '.devcontainer/devcontainer.json', dockerfile));
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    expect(run('Dockerfile')).toMatchObject({ dockerfilePath: '.devcontainer/Dockerfile', dockerfileText: 'FROM node:24\n' });
    expect(run(`${repo}/.devcontainer/Dockerfile`)).toMatchObject({ dockerfileText: 'FROM node:24\n' });
    // Still only in the repository.
    expect(run('../../secret')).not.toHaveProperty('dockerfileText');
    expect(readFilesCommand(repo, 'x', '')).toHaveLength(5);
  });

  it('tells a missing Dockerfile apart from a link out, a link that leads nowhere, and a variable (review round 3, P3-1)', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    write(path.join(root, 'secret'), 'FROM secret\n');
    const config = (dockerfile: string) => `{ "build": { "dockerfile": "${dockerfile}" } }`;
    write(path.join(repo, 'a', 'devcontainer.json'), config('Dockerfile'));
    write(path.join(repo, 'b', 'devcontainer.json'), config('link.Dockerfile'));
    fs.symlinkSync(path.join(root, 'secret'), path.join(repo, 'b', 'link.Dockerfile'));
    write(path.join(repo, 'c', 'devcontainer.json'), config('dangling.Dockerfile'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(repo, 'c', 'dangling.Dockerfile'));
    write(path.join(repo, 'd', 'devcontainer.json'), config('sub/Dockerfile'));
    fs.symlinkSync(root, path.join(repo, 'd', 'sub'));
    write(path.join(repo, 'e', 'devcontainer.json'), config('${localEnv:X}/Dockerfile'));
    write(path.join(repo, 'f', 'devcontainer.json'), config('../../elsewhere/Dockerfile'));
    expect(read(repo, 'a/devcontainer.json')).toMatchObject({ dockerfilePath: 'a/Dockerfile', dockerfileMissing: true });
    // A link out of the repository is not read (before: its text was returned).
    expect(read(repo, 'b/devcontainer.json')).toEqual({ configText: config('link.Dockerfile'), dockerfilePath: 'b/link.Dockerfile' });
    expect(read(repo, 'c/devcontainer.json')).toEqual({ configText: config('dangling.Dockerfile'), dockerfilePath: 'c/dangling.Dockerfile' });
    expect(read(repo, 'd/devcontainer.json')).toEqual({ configText: config('sub/Dockerfile'), dockerfilePath: 'd/sub/Dockerfile' });
    expect(read(repo, 'e/devcontainer.json')).toEqual({ configText: config('${localEnv:X}/Dockerfile') });
    expect(read(repo, 'f/devcontainer.json')).toEqual({ configText: config('../../elsewhere/Dockerfile') });
  });

  it('takes a link in the repository that leads nowhere in the repository for a missing Dockerfile (review round 4, P4-1)', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    const config = (dockerfile: string) => `{ "build": { "dockerfile": "${dockerfile}", "context": ".." } }`;
    write(path.join(repo, 'docker', 'Dockerfile.real'), 'FROM alpine\n');
    write(path.join(repo, '.devcontainer', 'devcontainer.json'), config('Dockerfile'));
    const dev = path.join(repo, '.devcontainer');
    // A chain of two links in the repository whose target was deleted.
    fs.symlinkSync('../docker/Dockerfile.gone', path.join(dev, 'Dockerfile'));
    expect(read(repo, '.devcontainer/devcontainer.json')).toMatchObject({ dockerfilePath: '.devcontainer/Dockerfile', dockerfileMissing: true });
    fs.unlinkSync(path.join(dev, 'Dockerfile'));
    fs.symlinkSync('hop', path.join(dev, 'Dockerfile'));
    fs.symlinkSync('../docker/gone/Dockerfile', path.join(dev, 'hop'));
    expect(read(repo, '.devcontainer/devcontainer.json')).toMatchObject({ dockerfileMissing: true });
    // A link through a folder link of the repository.
    fs.symlinkSync('../docker', path.join(dev, 'dlink'));
    write(path.join(dev, 'devcontainer.json'), config('dlink/nope'));
    expect(read(repo, '.devcontainer/devcontainer.json')).toMatchObject({ dockerfilePath: '.devcontainer/dlink/nope', dockerfileMissing: true });
    // Still refused: a link out of the repository, a chain in a circle, a link through a folder out of the repository.
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(dev, 'out'));
    fs.symlinkSync('circle2', path.join(dev, 'circle1'));
    fs.symlinkSync('circle1', path.join(dev, 'circle2'));
    fs.symlinkSync('../../elsewhere/x', path.join(dev, 'upward'));
    fs.symlinkSync('../docker/Dockerfile.real', path.join(dev, 'present'));
    for (const dockerfile of ['out', 'circle1', 'upward']) {
      write(path.join(dev, 'devcontainer.json'), config(dockerfile));
      expect(read(repo, '.devcontainer/devcontainer.json')).toEqual({ configText: config(dockerfile), dockerfilePath: `.devcontainer/${dockerfile}` });
    }
    // A link that leads to a file of the repository is read.
    write(path.join(dev, 'devcontainer.json'), config('present'));
    expect(read(repo, '.devcontainer/devcontainer.json')).toMatchObject({ dockerfileText: 'FROM alpine\n' });
  });

  it('fails for a configuration path outside of the repository', () => {
    const root = tempDir();
    write(path.join(root, 'devcontainer.json'), '{}');
    const result = runNode(readFilesCommand(path.join(root, 'repo'), '../devcontainer.json'));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});
