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
  COMPOSE_HASH_SCRIPT,
  composeHashCommand,
  parseComposeHashes,
  COMPOSE_MODEL_SCRIPT,
  CREDENTIAL_HELPER,
  GIT_FILES_SCRIPT,
  GIT_SUMMARY_SCRIPT,
  LIST_CONFIGS_SCRIPT,
  OVERRIDE_CONFIG_PATH,
  OVERRIDE_FOLDER,
  READ_FILES_SCRIPT,
  SECRETS_FOLDER,
  TOKEN_FILE,
  UP_SCRIPT,
  WRITE_AND_RUN_SCRIPT,
  buildCommand,
  cloneCommand,
  composeModelCommand,
  createFoldersCommand,
  gitFilesCommand,
  listConfigsCommand,
  readFilesCommand,
  upCommand,
  writeAndRunCommand,
} from './scripts';
import { CONTAINER_CREDENTIAL_HELPER, GIT_CREDENTIALS_CONFIG_CONTENT } from './containerGit';
import { composeReferences, parseComposeModelOutput, type ComposeModelOutput } from './compose';
import { MAX_CONFIG_TEXT_LENGTH } from './analysisLimits';
import { MAX_DOCKERFILE_LENGTH } from '../imageCheck/dockerfile';
import { composeAccessReport, type ComposeAccessInput } from '../policy';
import { WORKSPACES_ROOT } from '../names';

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
  // 2026-10-01: the Switch branch command was dropped (user decision). SWITCH_BRANCH_SCRIPT is gone.
  ['GIT_FILES_SCRIPT', GIT_FILES_SCRIPT],
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
    // 2026-10-01: the Switch branch command was dropped (user decision). switchBranchCommand is gone.
    // unit 15: no login argument (the sign-in of the GitHub CLI is written into the memory of the dev container).
    expect(gitFilesCommand('api', { name: 'Me', email: 'me@x' }, 'helper')).toEqual(['sh', '-c', GIT_FILES_SCRIPT, 'sh', 'api', 'Me', 'me@x', 'helper']);
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

  it.each([
    ['CLONE_SCRIPT', cloneCommand('acme/api', `devenv-test-${process.pid}-missing`)],
    // 2026-10-01: the Switch branch command was dropped (user decision). Its row SWITCH_BRANCH_SCRIPT is gone.
  ])('%s refuses to write the token when the secrets folder is not a tmpfs mount', (_name, command) => {
    const result = runSh(command, 'secret-token-value');
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('is not a tmpfs mount');
    expect(result.stdout + result.stderr).not.toContain('secret-token-value');
  });

  it('keeps the credential helper intact through the shell quoting of the scripts', () => {
    // 2026-10-01: the Switch branch command was dropped (user decision). SWITCH_BRANCH_SCRIPT is gone.
    for (const script of [CLONE_SCRIPT]) {
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
    const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const value = JSON.parse(lines[0]) as Record<string, unknown>;
    // Review round 9, S9-2: the script prints each Dockerfile once (dockerfileTexts); parseComposeModelOutput gives
    // each service its text in `dockerfiles`, as the extension reads it.
    const parsed = parseComposeModelOutput(lines[0]);
    if (!('error' in parsed)) value.dockerfiles = parsed.dockerfiles;
    return value;
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

  it('reads each Dockerfile once, and at most one character more than the extension takes (review round 9, S9-2)', () => {
    const { repo, env } = setup();
    // Five services build the same Dockerfile, which is much longer than MAX_DOCKERFILE_LENGTH.
    write(path.join(repo, 'Dockerfile'), `FROM alpine\nRUN echo ${'a'.repeat(MAX_DOCKERFILE_LENGTH + 5000)}\n`);
    const services = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, { build: { context: repo, dockerfile: 'Dockerfile' } }]));
    const command = composeModelCommand(repo, [path.join(repo, 'compose.yml')]);
    const result = spawnSync(process.execPath, command.slice(1), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...env, FAKE_MODEL: JSON.stringify({ name: 'devenv-3f2a9c1e', services }) },
    });
    expect(result.status, result.stderr).toBe(0);
    // Before: the whole file, once per service (5 × the file).
    expect(result.stdout.length).toBeLessThan(MAX_DOCKERFILE_LENGTH + 10_000);
    const raw = JSON.parse(result.stdout) as { dockerfileTexts: Record<string, string>; dockerfileFiles: Record<string, string> };
    expect(Object.keys(raw.dockerfileTexts)).toEqual([fs.realpathSync(path.join(repo, 'Dockerfile'))]);
    expect(Object.keys(raw.dockerfileFiles)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    const parsed = parseComposeModelOutput(result.stdout);
    if ('error' in parsed) throw new Error(parsed.error);
    // Each service has the text, one character longer than the limit: the update check skips it (and the dev service is
    // refused, since its build writes the text). Dockerfile refusals removed (user decision 2026-09-27).
    for (let i = 0; i < 5; i++) expect(parsed.dockerfiles[`s${i}`]).toHaveLength(MAX_DOCKERFILE_LENGTH + 1);
    expect(parsed.dockerfiles.s0.startsWith('FROM alpine\nRUN echo aaa')).toBe(true);
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
    // may be built; its FROM images are the references of the update check); before, it was left out.
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

  it('unescapes the texts of a model that Compose printed with $$ (review round 20, D20-1: and the keys) before it reads the paths (review round 19, S19-1)', () => {
    const { dir, repo, env } = setup();
    // Files whose names hold a literal $, as Compose and BuildKit use them.
    fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, '$d'));
    fs.mkdirSync(path.join(repo, '$c'));
    write(path.join(repo, '$c', '$D.Dockerfile'), 'FROM node:24\n');
    write(path.join(repo, '$e.env'), 'A=1\n');
    const printed = {
      name: 'devenv-3f2a9c1e',
      services: {
        inline: { build: { context: repo, dockerfile_inline: 'ARG X=a\nFROM $$X\n' }, labels: { 'k$$': 'v$$w' } },
        file: { build: { context: `${repo}/$$c`, dockerfile: '$$D.Dockerfile' } },
        db: {
          image: 'postgres:16',
          env_file: [`${repo}/$$e.env`],
          volumes: [
            { type: 'bind', source: `${repo}/$$d`, target: '/x' },
            { type: 'bind', source: `${repo}/$$c/$$new`, target: '/y' },
          ],
        },
      },
    };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(printed) }) as {
      model: Record<string, Record<string, Record<string, unknown>>>;
      dockerfiles: Record<string, string>;
      realPaths: Record<string, string | null>;
      mountAncestors: Record<string, string | null>;
      mountCreateTargets: Record<string, string>;
      inputsHash: string;
    };
    // review round 20, D20-1: changed expectation, the keys are unescaped too.
    expect(output.model.services.inline).toEqual({ build: { context: repo, dockerfile_inline: 'ARG X=a\nFROM $X\n' }, labels: { k$: 'v$w' } });
    expect(output.model.services.db.volumes).toEqual([
      { type: 'bind', source: `${repo}/$d`, target: '/x' },
      { type: 'bind', source: `${repo}/$c/$new`, target: '/y' },
    ]);
    expect(output.dockerfiles).toEqual({ inline: 'ARG X=a\nFROM $X\n', file: 'FROM node:24\n' });
    expect(output.realPaths).toMatchObject({
      [`${repo}/$d`]: fs.realpathSync(path.join(dir, 'outside')),
      [`${repo}/$c`]: fs.realpathSync(path.join(repo, '$c')),
      [`${repo}/$c/$D.Dockerfile`]: fs.realpathSync(path.join(repo, '$c', '$D.Dockerfile')),
      [`${repo}/$e.env`]: fs.realpathSync(path.join(repo, '$e.env')),
      [`${repo}/$c/$new`]: null,
    });
    expect(Object.keys(output.realPaths).some((key) => key.includes('$$'))).toBe(false);
    expect(output.mountAncestors).toEqual({ [`${repo}/$c/$new`]: fs.realpathSync(path.join(repo, '$c')) });
    expect(output.mountCreateTargets).toEqual({ [`${repo}/$c/$new`]: `${fs.realpathSync(path.join(repo, '$c'))}/$new` });
    // The env_file of the inputs hash is the unescaped one: its text changes the hash.
    write(path.join(repo, '$e.env'), 'A=2\n');
    const again = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(printed) }) as { inputsHash: string };
    expect(again.inputsHash).not.toBe(output.inputsHash);
  });

  describe('review round 19 (S19-1): the checks see the texts that Compose and BuildKit use', () => {
    /** The model run of `printed` (as Compose prints it with $$), and the check of its output. */
    function modelRun(repo: string, env: NodeJS.ProcessEnv, printed: unknown): ComposeModelOutput {
      const command = composeModelCommand(repo, [path.join(repo, 'compose.yml')]);
      const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', env: { ...env, FAKE_MODEL: JSON.stringify(printed) } });
      const output = parseComposeModelOutput(result.stdout);
      if ('error' in output) throw new Error(output.error);
      return output;
    }
    function check(repo: string, env: NodeJS.ProcessEnv, printed: unknown): { hostAccess: string[]; unsupported: string[] } {
      const output = modelRun(repo, env, printed);
      const input: ComposeAccessInput = {
        model: output.model,
        devService: 'app',
        project: 'devenv-3f2a9c1e',
        repositoryFolder: repo,
        ownVolume: 'devenv-acme-api-3f2a9c1e',
        engineApiVersion: '1.47',
        dockerfiles: output.dockerfiles,
        realPaths: output.realPaths,
        ...(output.mountAncestors !== undefined ? { mountAncestors: output.mountAncestors } : {}),
        ...(output.missing !== undefined ? { missing: output.missing } : {}),
      };
      return composeAccessReport(input);
    }
    const APP = { image: 'mcr.microsoft.com/devcontainers/base:bookworm', command: ['sleep', 'infinity'] };

    it('allows a dockerfile_inline of another service whose FROM resolves to the image of another environment, and reads it unescaped', () => {
      const { repo, env } = setup();
      const printed = {
        name: 'devenv-3f2a9c1e',
        services: { app: APP, db: { build: { context: repo, dockerfile_inline: 'ARG img=devenv-0badc0de:3\nFROM $$img\n' } } },
      };
      // Dockerfile refusals removed (user decision 2026-09-27): before, refused as `… devenv-0badc0de:3 of another environment`.
      expect(check(repo, env, printed)).toEqual({ hostAccess: [], unsupported: [] });
      // The update check reads the text that BuildKit uses (`$img`, not `$$img`).
      const output = modelRun(repo, env, printed);
      expect(composeReferences(output.model, output.dockerfiles, undefined).images).toEqual(['mcr.microsoft.com/devcontainers/base:bookworm', 'devenv-0badc0de:3']);
    });

    it('checks a bind mount on the unescaped path (a link out of the repository)', () => {
      const { dir, repo, env } = setup();
      fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, '$x'));
      const report = check(repo, env, {
        name: 'devenv-3f2a9c1e',
        services: { app: APP, db: { image: 'postgres:16', volumes: [{ type: 'bind', source: `${repo}/$$x`, target: '/data', bind: { create_host_path: true } }] } },
      });
      expect(report.hostAccess.join('\n')).toContain(`a link to ${fs.realpathSync(path.join(dir, 'outside'))}, outside of the repository`);
    });

    it('checks an env_file on the unescaped path (a link out of the repository)', () => {
      const { dir, repo, env } = setup();
      fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(repo, '$e.env'));
      const report = check(repo, env, { name: 'devenv-3f2a9c1e', services: { app: APP, db: { image: 'postgres:16', env_file: [`${repo}/$$e.env`] } } });
      expect([...report.hostAccess, ...report.unsupported]).toEqual([`service db: env_file ${repo}/$e.env`]);
      // A file of the repository whose name holds a $ is allowed.
      write(path.join(repo, '$ok.env'), 'A=1\n');
      expect(check(repo, env, { name: 'devenv-3f2a9c1e', services: { app: APP, db: { image: 'postgres:16', env_file: [`${repo}/$$ok.env`] } } })).toEqual({ hostAccess: [], unsupported: [] });
    });

    it('does not refuse a dockerfile_inline of the dev service with a variable in FROM', () => {
      const { repo, env } = setup();
      const report = check(repo, env, {
        name: 'devenv-3f2a9c1e',
        services: { app: { build: { context: repo, dockerfile_inline: 'ARG BASE=mcr.microsoft.com/devcontainers/base:bookworm\nFROM $${BASE}\n' }, command: ['sleep', 'infinity'] } },
      });
      expect(report).toEqual({ hostAccess: [], unsupported: [] });
    });
  });

  it('unescapes the keys of every map of a model that Compose printed with $$ (review round 20, D20-1)', () => {
    const { repo, env } = setup();
    const printed = {
      name: 'devenv-3f2a9c1e',
      services: {
        app: {
          image: 'alpine',
          environment: { a$$b: 'c$$d', PLAIN: 'x' },
          labels: { 'k$$': 'v' },
          sysctls: { 'net.x$$y': '1' },
          annotations: { 'a$$$$': 'b' },
          build: { context: repo, dockerfile_inline: 'FROM alpine\n', args: { 'A$$': '1' } },
        },
      },
      volumes: { data: { driver_opts: { 'o$$': 'v$$' } } },
    };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(printed) }) as { model: Record<string, Record<string, Record<string, unknown>>> };
    expect(output.model.services.app).toEqual({
      image: 'alpine',
      environment: { a$b: 'c$d', PLAIN: 'x' },
      labels: { k$: 'v' },
      sysctls: { 'net.x$y': '1' },
      annotations: { a$$: 'b' },
      build: { context: repo, dockerfile_inline: 'FROM alpine\n', args: { A$: '1' } },
    });
    expect(output.model.volumes).toEqual({ data: { driver_opts: { o$: 'v$' } } });
    // A Compose that does not escape: the keys stay as they are.
    const plain = runModel(repo, [path.join(repo, 'compose.yml')], {
      ...env,
      FAKE_MODEL: JSON.stringify(printed),
      FAKE_PROBE: JSON.stringify({ services: { probe: { environment: { V: 'a$b' } } } }),
    }) as { model: unknown };
    expect(plain.model).toEqual(printed);
  });

  it('leaves the texts of a model that Compose printed without escaping $ as they are (review round 19, S19-1)', () => {
    const { repo, env } = setup();
    const printed = { name: 'devenv-3f2a9c1e', services: { app: { image: 'alpine', environment: { A: 'a$$b' } } } };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], {
      ...env,
      FAKE_MODEL: JSON.stringify(printed),
      FAKE_PROBE: JSON.stringify({ services: { probe: { environment: { V: 'a$b' } } } }),
    }) as Record<string, unknown>;
    expect(output.model).toEqual(printed);
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

describe('CLONE_SCRIPT with fake tools', () => {
  // The script needs Linux (a tmpfs in /proc/mounts) and /workspaces. Fake tools on PATH stand in for awk, mktemp and
  // Git, and record what the script does. SECRETS_FOLDER and WORKSPACES_ROOT are replaced by temporary folders.
  function runClone(opts: { cloneExit: number; existing?: 'repo' | 'file' }): {
    status: number | null;
    stdout: string;
    stderr: string;
    ws: string;
    log: string;
    tokenLeft: boolean;
    temp: string[];
  } {
    const dir = tempDir();
    const bin = path.join(dir, 'bin');
    const secrets = path.join(dir, 'secrets');
    const ws = path.join(dir, 'workspaces');
    const log = path.join(dir, 'log');
    fs.mkdirSync(secrets);
    fs.mkdirSync(ws);
    if (opts.existing === 'repo') fs.mkdirSync(path.join(ws, 'api', '.git'), { recursive: true });
    if (opts.existing === 'file') write(path.join(ws, 'api', 'notes.txt'), 'keep me');
    const tool = (name: string, body: string) => {
      write(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    };
    tool('awk', 'exit 0');
    tool(
      'mktemp',
      ['for last; do :; done', 't=$(printf %s "$last" | sed "s/XXXXXX$/abc123/")', 'mkdir "$t"', 'echo "$t"'].join('\n'),
    );
    tool(
      'git',
      [
        // printf, not echo: dash's echo would expand the backslash sequences of the credential helper.
        `printf 'git-args %s prompt=%s\\n' "$*" "$GIT_TERMINAL_PROMPT" >> '${log}'`,
        'while [ "$1" = -c ]; do shift 2; done',
        `if [ -s '${path.join(secrets, 'github-token')}' ]; then token=present; else token=absent; fi`,
        `echo "git $1 token=$token" >> '${log}'`,
        'for last; do :; done',
        'mkdir -p "$last/.git"',
        `[ ${opts.cloneExit} -eq 0 ] || { echo 'fatal: repository not found' >&2; exit ${opts.cloneExit}; }`,
      ].join('\n'),
    );
    // mv records whether the token file is still there when the clone is moved into place, then does the real move.
    tool(
      'mv',
      [
        `if [ -e '${path.join(secrets, 'github-token')}' ]; then token=present; else token=absent; fi`,
        `echo "mv token=$token" >> '${log}'`,
        `PATH='${process.env.PATH ?? ''}' exec mv "$@"`,
      ].join('\n'),
    );
    const script = CLONE_SCRIPT.split(SECRETS_FOLDER).join(secrets).split(WORKSPACES_ROOT).join(ws);
    const result = spawnSync('sh', ['-c', script, 'sh', 'acme/api', 'api', 'main'], {
      encoding: 'utf8',
      input: 'gho_secret',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      ws,
      log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
      tokenLeft: fs.existsSync(path.join(secrets, 'github-token')),
      temp: fs.readdirSync(ws).filter((name) => name.startsWith('.devenv-clone.')),
    };
  }

  it('clones with the token, then removes the token file (review round 2 of PR #81, B-R2-1)', () => {
    const result = runClone({ cloneExit: 0 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.log).toMatch(/git clone token=present\nmv token=absent\n/);
    expect(result.tokenLeft).toBe(false);
    expect(fs.existsSync(path.join(result.ws, 'api', '.git'))).toBe(true);
  });

  it('removes the temporary folder after a clone and after a failed clone (review round 2 of PR #81, B-R2-1)', () => {
    const ok = runClone({ cloneExit: 0 });
    expect(ok.status).toBe(0);
    expect(ok.temp).toEqual([]);
    const failed = runClone({ cloneExit: 128 });
    expect(failed.status).toBe(128);
    expect(failed.stderr).toContain('fatal: repository not found');
    expect(failed.temp).toEqual([]);
    expect(failed.tokenLeft).toBe(false);
    expect(fs.existsSync(path.join(failed.ws, 'api'))).toBe(false);
  });

  it('ends with exit 0 without Git when the repository is already in the volume (review round 2 of PR #81, B-R2-1)', () => {
    const result = runClone({ cloneExit: 0, existing: 'repo' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already in the volume');
    expect(result.log).toBe('');
  });

  it('refuses and keeps a folder that exists and is not a Git repository (review round 2 of PR #81, B-R2-1)', () => {
    const result = runClone({ cloneExit: 0, existing: 'file' });
    expect(result.status).toBe(4);
    expect(result.log).toBe('');
    expect(fs.readFileSync(path.join(result.ws, 'api', 'notes.txt'), 'utf8')).toBe('keep me');
  });

  it('runs Git without hooks, only over https and without a prompt (review round 2 of PR #81, B-R2-2)', () => {
    const result = runClone({ cloneExit: 0 });
    expect(result.status).toBe(0);
    const args = result.log.split('\n').find((line) => line.startsWith('git-args')) ?? '';
    for (const option of [
      '-c core.hooksPath=/dev/null',
      '-c core.fsmonitor=false',
      '-c protocol.allow=never',
      '-c protocol.https.allow=always',
    ]) {
      expect(args).toContain(option);
    }
    expect(args).toMatch(/ prompt=0$/);
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

describe.skipIf(!hasGit)('GIT_FILES_SCRIPT with fake tools', () => {
  // The script needs Linux (GNU stat and mv). Fake tools on PATH stand in for them; Git is real.
  // unit 15: the script gets no token any more; the token and the sign-in of the GitHub CLI go into the memory of the
  // dev container (TOKEN_WRITE_SCRIPT, containerToken.test.ts).

  function setup(): { ws: string; bin: string; log: string } {
    const dir = tempDir();
    const ws = path.join(dir, 'workspaces');
    const bin = path.join(dir, 'bin');
    const log = path.join(dir, 'log');
    fs.mkdirSync(path.join(ws, 'api'), { recursive: true });
    const tool = (name: string, body: string) => {
      write(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    };
    tool('stat', 'echo 1000:1001');
    tool('chown', `echo "chown $*" >> '${log}'`);
    tool('mv', 'if [ "$1" = -fT ]; then shift; exec /bin/mv -f "$1" "$2"; fi\nexec /bin/mv "$@"');
    return { ws, bin, log };
  }

  function run(env: { ws: string; bin: string }, folder = 'api') {
    const script = GIT_FILES_SCRIPT.split('/workspaces').join(env.ws);
    const command = gitFilesCommand(folder, { name: 'Hannes Stauss', email: '1001+scalarion@users.noreply.github.com' }, CONTAINER_CREDENTIAL_HELPER);
    const result = spawnSync('sh', ['-c', script, ...command.slice(3)], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, PATH: `${env.bin}${path.delimiter}${process.env.PATH ?? ''}`, GIT_CONFIG_NOSYSTEM: '1' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function gitConfig(file: string, ...args: string[]): string {
    return spawnSync('git', ['config', '--file', file, ...args], { encoding: 'utf8' }).stdout;
  }

  it('writes the Git configuration and the Docker folder, owned by the repository owner, and no token', () => {
    const env = setup();
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const dir = path.join(env.ws, '.devenv+');
    const cfg = path.join(dir, 'gitconfig');
    expect(gitConfig(cfg, 'user.name')).toBe('Hannes Stauss\n');
    expect(gitConfig(cfg, 'user.email')).toBe('1001+scalarion@users.noreply.github.com\n');
    // unit 15: the credential helper reads the token file in the memory of the container.
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(CONTAINER_CREDENTIAL_HELPER).toContain('/run/devenv/github-token');
    expect(fs.statSync(path.join(dir, 'docker')).mode & 0o777).toBe(0o700);
    const chowned = fs.readFileSync(env.log, 'utf8');
    expect(chowned).toContain(`chown -h 1000:1001 ${dir} ${dir}/docker ${dir}/gitconfig`);
    expect(chowned).toContain(cfg);
    // No GnuPG folder: the extension does not change where GnuPG works (user decision 2026-09-25). unit 15: no token file.
    expect(fs.readdirSync(dir).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    // The file for the credential helpers of the user: only comments, readable by every user of the container.
    const credentials = path.join(dir, 'credentials.gitconfig');
    expect(fs.readFileSync(credentials, 'utf8')).toBe(GIT_CREDENTIALS_CONFIG_CONTENT.split('/workspaces').join(env.ws));
    expect(fs.statSync(credentials).mode & 0o777).toBe(0o644);
    expect(spawnSync('git', ['config', '--file', credentials, '--list'], { encoding: 'utf8' })).toMatchObject({ status: 0, stdout: '' });
    // unit 15: the gh folder of the volume (for config.yml), 0700 and empty, owned by the repository owner.
    const gh = path.join(dir, 'gh');
    expect(fs.statSync(gh).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(gh)).toEqual([]);
    expect(chowned).toContain(`${cfg} ${credentials} ${gh}`);
    // No temporary folder is left.
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.work'))).toEqual([]);
  });

  it('keeps the changes of the user in the Git configuration at each run', () => {
    const env = setup();
    expect(run(env).status).toBe(0);
    const cfg = path.join(env.ws, '.devenv+', 'gitconfig');
    spawnSync('git', ['config', '--file', cfg, 'user.name', 'Changed Name']);
    spawnSync('git', ['config', '--file', cfg, 'alias.st', 'status']);
    const before = fs.readFileSync(cfg, 'utf8');
    expect(run(env).status).toBe(0);
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

  it('replaces a link in place of the configuration folder, so nothing goes into the repository', () => {
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

  it('replaces a link or a file in place of the gh folder', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    const elsewhere = path.join(env.ws, 'api', 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(dir, 'gh'));
    expect(run(env).status).toBe(0);
    expect(fs.lstatSync(path.join(dir, 'gh')).isDirectory()).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual([]);

    fs.rmSync(path.join(dir, 'gh'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'gh'), 'x');
    expect(run(env).status).toBe(0);
    expect(fs.lstatSync(path.join(dir, 'gh')).isDirectory()).toBe(true);
  });

  it('writes nothing without the repository folder', () => {
    const env = setup();
    const missing = run(env, 'other');
    expect(missing.status).toBe(4);
    expect(fs.existsSync(path.join(env.ws, '.devenv+'))).toBe(false);
  });

  it('rejects an invalid folder name', () => {
    const result = run(setup(), '../etc');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid folder name');
  });
});

describe('READ_FILES_SCRIPT', () => {
  function read(repo: string, configPath: string): unknown {
    const result = runNode(readFilesCommand(repo, configPath));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }

  it('reads at most one character more than the extension takes of the configuration and the Dockerfile (review round 9, S9-1, S9-2)', () => {
    const repo = tempDir();
    const readBig = (): { configText: string; dockerfileText?: string } => {
      const command = readFilesCommand(repo, '.devcontainer/devcontainer.json');
      const run = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      expect(run.status, run.stderr).toBe(0);
      return JSON.parse(run.stdout) as { configText: string; dockerfileText?: string };
    };
    write(path.join(repo, '.devcontainer', 'devcontainer.json'), '{ "build": { "dockerfile": "Dockerfile" } }');
    // Of 3 bytes per character in UTF-8: the limit counts characters, not bytes. A Dockerfile within it is read whole.
    const within = `FROM alpine\n# ${'€'.repeat(MAX_DOCKERFILE_LENGTH - 20)}\n`;
    write(path.join(repo, '.devcontainer', 'Dockerfile'), within);
    expect(readBig().dockerfileText).toBe(within);
    // Before: the whole file of any size.
    write(path.join(repo, '.devcontainer', 'Dockerfile'), `FROM alpine\n# ${'€'.repeat(MAX_DOCKERFILE_LENGTH * 2)}\n`);
    expect(readBig().dockerfileText).toHaveLength(MAX_DOCKERFILE_LENGTH + 1);
    write(path.join(repo, '.devcontainer', 'devcontainer.json'), `{ "image": "alpine", "x": "${'€'.repeat(MAX_CONFIG_TEXT_LENGTH * 2)}" }`);
    expect(readBig().configText).toHaveLength(MAX_CONFIG_TEXT_LENGTH + 1);
  });

  it('reads a configuration in a folder whose name has a backslash (review round 6, note of S)', () => {
    const repo = tempDir();
    write(path.join(repo, '.devcontainer', 'a\\b', 'devcontainer.json'), '{ "image": "alpine" }');
    expect(read(repo, '.devcontainer/a\\b/devcontainer.json')).toEqual({ configText: '{ "image": "alpine" }' });
  });

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

  it('U2: returns neither a text nor dockerfileMissing for a Dockerfile linked out of the repository, as written or resolved (the extension refuses it)', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    write(path.join(root, '.devenv+', 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: gho_SECRET\n');
    write(path.join(repo, '.devcontainer', 'devcontainer.json'), '{ "build": { "dockerfile": "${localEnv:DF:Dockerfile}" } }');
    fs.symlinkSync('../../.devenv+/gh/hosts.yml', path.join(repo, '.devcontainer', 'Dockerfile'));
    for (const dockerfile of [undefined, 'Dockerfile', '../../.devenv+/gh/hosts.yml']) {
      const result = runNode(readFilesCommand(repo, '.devcontainer/devcontainer.json', dockerfile));
      expect(result.status).toBe(0);
      const out = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(out).not.toHaveProperty('dockerfileText');
      expect(out).not.toHaveProperty('dockerfileMissing');
      expect(result.stdout).not.toContain('gho_SECRET');
    }
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

describe('review round 8 of unit 6 (P8-2): folders of the repository for the bind mounts of Docker Compose', () => {
  it('COMPOSE_MODEL_SCRIPT prints the nearest folder of each bind mount source in the repository that does not exist', () => {
    const dir = tempDir();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
    write(path.join(repo, 'file'), 'x');
    fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, 'dangling'));
    fs.mkdirSync(path.join(dir, 'out'));
    fs.symlinkSync(path.join(dir, 'out'), path.join(repo, 'out'));
    const bind = (source: string) => ({ type: 'bind', source, target: `/t${source.length}` });
    const model = {
      name: 'devenv-3f2a9c1e',
      services: {
        db: { image: 'postgres:16', volumes: [bind(`${repo}/data/postgres/16`), bind(`${repo}/new`), bind(`${repo}/file/x`), bind(`${repo}/dangling/x`), bind(`${repo}/out/x`), bind(`${repo}/data`), bind(`${dir}/elsewhere`)] },
      },
    };
    const bin = path.join(dir, 'bin');
    write(path.join(bin, 'docker'), '#!/bin/sh\nshift\nif [ "$1 $2" = "version --short" ]; then echo 2.29.1; exit 0; fi\ncase "$*" in *"-p devenv-probe"*) cat > /dev/null; printf \'%s\\n\' "$FAKE_PROBE"; exit 0 ;; esac\nprintf \'%s\\n\' "$FAKE_MODEL"\n');
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_PROBE: JSON.stringify({ services: { probe: { environment: { V: 'a$$b' } } } }),
      FAKE_MODEL: JSON.stringify(model),
    };
    const command = composeModelCommand(repo, [path.join(repo, 'compose.yml')]);
    const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', env });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as { mountAncestors: Record<string, string | null> };
    expect(output.mountAncestors).toEqual({
      [`${repo}/data/postgres/16`]: fs.realpathSync(path.join(repo, 'data')),
      [`${repo}/new`]: fs.realpathSync(repo),
      // A file, and a link that leads nowhere: no folder.
      [`${repo}/file/x`]: null,
      [`${repo}/dangling/x`]: null,
      // A link out of the repository: its real path (the check refuses it).
      [`${repo}/out/x`]: fs.realpathSync(path.join(dir, 'out')),
    });
  });

  it('COMPOSE_MODEL_SCRIPT prints where each folder to create lands after the links of its nearest folder (review round 10, D10-2)', () => {
    const dir = tempDir();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.local'), { recursive: true });
    fs.symlinkSync('.local', path.join(repo, 'data'));
    fs.mkdirSync(path.join(repo, 'plain'));
    const bind = (source: string) => ({ type: 'bind', source, target: `/t${source.length}` });
    const model = { name: 'devenv-3f2a9c1e', services: { db: { image: 'postgres:16', volumes: [bind(`${repo}/data/pg/16`), bind(`${repo}/plain/x/`), bind(`${repo}/data`)] } } };
    const bin = path.join(dir, 'bin');
    write(path.join(bin, 'docker'), '#!/bin/sh\nshift\nif [ "$1 $2" = "version --short" ]; then echo 2.29.1; exit 0; fi\ncase "$*" in *"-p devenv-probe"*) cat > /dev/null; printf \'%s\\n\' "$FAKE_PROBE"; exit 0 ;; esac\nprintf \'%s\\n\' "$FAKE_MODEL"\n');
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_PROBE: JSON.stringify({ services: { probe: { environment: { V: 'a$$b' } } } }),
      FAKE_MODEL: JSON.stringify(model),
    };
    const result = spawnSync(process.execPath, composeModelCommand(repo, [path.join(repo, 'compose.yml')]).slice(1), { encoding: 'utf8', env });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as { mountCreateTargets: Record<string, string>; realPaths: Record<string, string | null> };
    const real = fs.realpathSync(repo);
    expect(output.mountCreateTargets).toEqual({ [`${repo}/data/pg/16`]: `${real}/.local/pg/16`, [`${repo}/plain/x/`]: `${real}/plain/x` });
    expect(output.realPaths[`${repo}/data`]).toBe(`${real}/.local`);
    // CREATE_FOLDERS_SCRIPT creates it there.
    expect(runNode(createFoldersCommand(repo, [`${repo}/data/pg/16`])).status).toBe(0);
    expect(fs.realpathSync(path.join(repo, 'data/pg/16'))).toBe(`${real}/.local/pg/16`);
  });

  it('CREATE_FOLDERS_SCRIPT creates the missing folders in the repository, and nothing through a link out of it', () => {
    const dir = tempDir();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out'));
    fs.symlinkSync(path.join(dir, 'out'), path.join(repo, 'out'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(repo, 'dangling'));
    write(path.join(repo, 'file'), 'x');
    const ok = runNode(createFoldersCommand(repo, [`${repo}/data/postgres/16`, `${repo}/new`, `${repo}/data`]));
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.statSync(path.join(repo, 'data', 'postgres', '16')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(repo, 'new')).isDirectory()).toBe(true);
    for (const [folder, message] of [
      [`${repo}/out/x`, 'leads out of the repository'],
      [`${repo}/dangling/x`, 'a link that leads nowhere'],
      [`${repo}/file/x`, 'is no folder'],
      [`${repo}/../x`, 'Not a folder of the repository'],
      [`${dir}/x`, 'Not a folder of the repository'],
    ]) {
      const refused = runNode(createFoldersCommand(repo, [folder]));
      expect(refused.status, folder).toBe(2);
      expect(refused.stderr).toContain(message);
    }
    expect(fs.existsSync(path.join(dir, 'out', 'x'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'nowhere'))).toBe(false);
  });
});

describe('COMPOSE_HASH_SCRIPT (recreate offer, review round 2)', () => {
  it('writes the model to the path of up and runs docker compose config --hash with the project name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-hash-'));
    try {
      // A fake `docker` that prints its arguments and the model it finds at the path.
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "db ${'a'.repeat(64)}"\necho "args: $*" >&2\ncat "$7" >&2\n`, { mode: 0o755 });
      const file = path.join(dir, 'override', 'compose.json');
      const result = spawnSync('node', ['-e', COMPOSE_HASH_SCRIPT, file, 'devenv-3f2a9c1e'], {
        input: '{"services":{}}',
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`args: compose --project-name devenv-3f2a9c1e --profile * -f ${file} config --hash *`);
      expect(result.stderr).toContain('{"services":{}}');
      expect(parseComposeHashes(result.stdout)).toEqual(new Map([['db', 'a'.repeat(64)]]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses one `<service> <hash>` per line and skips anything else', () => {
    const hash = 'b'.repeat(64);
    expect(parseComposeHashes(`app ${hash}\r\nwarning: something\n\ndb ${hash}\nshort 1234\n`)).toEqual(
      new Map([
        ['app', hash],
        ['db', hash],
      ]),
    );
    expect(composeHashCommand('/tmp/devenv-override/compose.json', 'p')).toEqual(['node', '-e', COMPOSE_HASH_SCRIPT, '/tmp/devenv-override/compose.json', 'p']);
  });
});
