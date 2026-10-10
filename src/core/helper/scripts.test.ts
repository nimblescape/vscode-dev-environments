// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectConfigurations } from '../discovery/detect';
// user decision 2026-10-02: Delete runs no Git: GIT_SUMMARY_SCRIPT no longer runs in the workspace helper, so scripts.ts
// does not re-export it; its syntax is still checked here (it runs in the dev container).
import { GIT_SUMMARY_SCRIPT, configOwnershipFixCommand } from '../git/gitSummary';
import {
  CLONE_SCRIPT,
  COMPOSE_FILES_MAX_AGE_MS,
  MAX_LOCKFILE_LENGTH,
  COMPOSE_HASH_SCRIPT,
  composeHashCommand,
  parseComposeHashes,
  COMPOSE_MODEL_SCRIPT,
  CREDENTIAL_HELPER,
  GIT_FILES_SCRIPT,
  OVERRIDE_CONFIG_PATH,
  OVERRIDE_FOLDER,
  TOKEN_FILE,
  UP_SCRIPT,
  WRITE_AND_RUN_SCRIPT,
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
import { BATCH_HELPER_FOLDERS, composeAccessReport, isHelperPath, type ComposeAccessInput } from '../policy';
import { SECRETS_FOLDER, WORKSPACES_ROOT, composeProjectName, resourceName } from '../names';

/** User decisions 2026-10-03: the name of an environment of another repository and ID (before: devenv-<8 hex>). */
const OTHER = resourceName('acme/web', '11111111-2222-4333-8444-555555555555');

// User decisions 2026-10-03: the names of an environment are resourceName (before: devenv-<8 hex>).
const NAME_ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = composeProjectName('acme/api', NAME_ID);
const OWN = resourceName('acme/api', NAME_ID);

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
  // Follow-up of plan step 11I (the links of the owner): GIT_FILES_SCRIPT is a Node.js script now; its suite below runs it.
  ['GIT_SUMMARY_SCRIPT', GIT_SUMMARY_SCRIPT],
  ['UP_SCRIPT', UP_SCRIPT],
  // Follow-up of PR #121: BUILD_SCRIPT is gone (every build runs through WRITE_AND_RUN_SCRIPT, for its lockfile rule).
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
    // Follow-up of plan step 11I (the links of the owner): changed expectation, a Node.js script (was `sh -c … sh`); the
    // values are still arguments only. Review round 1 of that follow-up (B-L1): changed expectation, `--` before them, so
    // that Node takes none of them for one of its options.
    expect(gitFilesCommand('api', { name: 'Me', email: 'me@x' }, 'helper')).toEqual(['node', '-e', GIT_FILES_SCRIPT, '--', 'api', 'Me', 'me@x', 'helper']);
    expect(upCommand(OVERRIDE_CONFIG_PATH, ['up', '--x'])).toEqual(['sh', '-c', UP_SCRIPT, 'sh', OVERRIDE_CONFIG_PATH, 'up', '--x']);
    // Follow-up of PR #121: buildCommand is gone (every build runs through writeAndRunCommand, whose test names it).
  });

  // Review round 1 of the follow-up of plan step 11I (B-L1): without `--`, Node read a first argument that starts with `-`
  // as its own option (`-x`: "bad option", exit 9; `--title=x`: taken, and the next argument became the folder name). The
  // script refuses such a name before it touches anything, so the real command runs here (the name `..` refuses the
  // folder name that Node would leave the script after taking `--title=x`).
  it.each(['-x', '--title=x'])('gitFilesCommand passes the folder name %j to the script, not to Node', (folder) => {
    const [, ...args] = gitFilesCommand(folder, { name: '..', email: 'me@x' }, 'helper');
    // Review round 3 of PR G (A-L4): SIGKILL at the time limit (the script ignores SIGTERM).
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
    expect(result.stderr).toBe(`Invalid folder name: ${folder}\n`);
    expect(result.status).toBe(2);
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

  // Follow-up of PR #121: the test of BUILD_SCRIPT is gone with it; the lockfile tests of WRITE_AND_RUN_SCRIPT cover
  // a build without our copy of the configuration.
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
      timeout: 10_000,
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

  // Follow-up of PR #121: the arguments name the workspace folder (buildArgs), the repository folder of the lockfile
  // rule, so the fake CLI prints it too.
  it('uses the lockfile of the repository next to our copy of the configuration, and adds --no-lockfile without one', () => {
    const { dir, folder, env } = setup();
    const repo = path.join(dir, 'repo');
    const build = ['build', '--workspace-folder', repo];
    const printed = `build\n--workspace-folder\n${repo}\n`;
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    const own = `${folder}/devcontainer.json`;
    expect(run(folder, env, { [own]: '{}' }, build, { repository: repositoryConfig, own }).stdout).toBe(`${printed}--no-lockfile\n`);
    expect(fs.existsSync(`${folder}/devcontainer-lock.json`)).toBe(false);
    write(path.join(repo, '.devcontainer', 'devcontainer-lock.json'), '{"features":{}}');
    expect(run(folder, env, { [own]: '{}' }, build, { repository: repositoryConfig, own }).stdout).toBe(printed);
    expect(fs.readFileSync(`${folder}/devcontainer-lock.json`, 'utf8')).toBe('{"features":{}}');
    expect(fs.statSync(`${folder}/devcontainer-lock.json`).mode & 0o777).toBe(0o600);
    // Without a copy of the configuration (every build that is not one of Docker Compose), the CLI uses the file of the
    // repository (follow-up of PR #121: the rule of BUILD_SCRIPT, which is gone).
    expect(run(folder, env, {}, build, { repository: repositoryConfig }).stdout).toBe(printed);
    // A root .devcontainer.json has the lockfile .devcontainer-lock.json.
    const rootConfig = path.join(repo, '.devcontainer.json');
    write(rootConfig, '{}');
    expect(run(folder, env, {}, build, { repository: rootConfig }).stdout).toBe(`${printed}--no-lockfile\n`);
    write(path.join(repo, '.devcontainer-lock.json'), '{}');
    expect(run(folder, env, {}, build, { repository: rootConfig }).stdout).toBe(printed);
  });

  // Follow-up of PR #121 (review A): the CLI runs as root, and read the lockfile of the repository through a link (here
  // to the file of the token next to the repository), copied it, and wrote it. Such a lockfile fails the run before the
  // CLI starts. A \`..\` after a link of the target is resolved as the system resolves it, not as text (the decoy).
  it.each([
    ['a link out of the repository', '../../.devenv+/gh/hosts.yml', false],
    ['a link out of the repository', '../../.devenv+/gh/hosts.yml', true],
    ['a link whose .. follows a link out of the repository', 'out/../hosts.yml', false],
    ['a link whose .. follows a link out of the repository', 'out/../hosts.yml', true],
  ])('refuses a lockfile that is %s (%s, our copy: %s), and never reads or writes it', (_name, target, withCopy) => {
    const { dir, folder, env } = setup();
    const repo = path.join(dir, 'repo');
    const token = path.join(dir, '.devenv+', 'gh', 'hosts.yml');
    write(token, 'github.com:\n  oauth_token: gho_LOCK_SECRET\n');
    fs.mkdirSync(path.join(dir, '.devenv+', 'gh', 'cache'));
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    write(path.join(repo, '.devcontainer', 'hosts.yml'), '{"decoy":true}');
    fs.symlinkSync(path.join(dir, '.devenv+', 'gh', 'cache'), path.join(repo, '.devcontainer', 'out'));
    fs.symlinkSync(target, path.join(repo, '.devcontainer', 'devcontainer-lock.json'));
    const own = `${folder}/devcontainer.json`;
    const result = run(folder, env, withCopy ? { [own]: '{}' } : {}, ['build', '--workspace-folder', repo], {
      repository: repositoryConfig,
      ...(withCopy ? { own } : {}),
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('The lockfile .devcontainer/devcontainer-lock.json is not a file of the repository.');
    expect(`${result.stdout}${result.stderr}`).not.toContain('gho_LOCK_SECRET');
    expect(fs.existsSync(`${folder}/devcontainer-lock.json`)).toBe(false);
    expect(fs.readFileSync(token, 'utf8')).toBe('github.com:\n  oauth_token: gho_LOCK_SECRET\n');
  });

  it.skipIf(process.platform === 'win32')('refuses a lockfile that is a FIFO without waiting for a writer', () => {
    const { dir, folder, env } = setup();
    const repo = path.join(dir, 'repo');
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    expect(spawnSync('mkfifo', [path.join(repo, '.devcontainer', 'devcontainer-lock.json')]).status).toBe(0);
    const own = `${folder}/devcontainer.json`;
    const result = run(folder, env, { [own]: '{}' }, ['build', '--workspace-folder', repo], { repository: repositoryConfig, own });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('is not a file of the repository.');
  });

  it('uses a lockfile that is a link to a plain file of the repository, and takes a folder for no lockfile', () => {
    const { dir, folder, env } = setup();
    const repo = path.join(dir, 'repo');
    const build = ['build', '--workspace-folder', repo];
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    write(path.join(repo, 'shared', 'lock.json'), '{"features":{"x":{}}}');
    fs.symlinkSync('../shared/lock.json', path.join(repo, '.devcontainer', 'devcontainer-lock.json'));
    const own = `${folder}/devcontainer.json`;
    const linked = run(folder, env, { [own]: '{}' }, build, { repository: repositoryConfig, own });
    expect(linked.stderr).toBe('');
    expect(linked.stdout).toBe(`build\n--workspace-folder\n${repo}\n`);
    expect(fs.readFileSync(`${folder}/devcontainer-lock.json`, 'utf8')).toBe('{"features":{"x":{}}}');
    fs.rmSync(path.join(repo, '.devcontainer', 'devcontainer-lock.json'));
    fs.mkdirSync(path.join(repo, '.devcontainer', 'devcontainer-lock.json'));
    expect(run(folder, env, {}, build, { repository: repositoryConfig }).stdout).toBe(`build\n--workspace-folder\n${repo}\n--no-lockfile\n`);
  });

  it('refuses a lockfile longer than MAX_LOCKFILE_LENGTH characters, and takes one of that length', () => {
    const { dir, folder, env } = setup();
    const repo = path.join(dir, 'repo');
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    write(repositoryConfig, '{}');
    const lockfile = path.join(repo, '.devcontainer', 'devcontainer-lock.json');
    const own = `${folder}/devcontainer.json`;
    write(lockfile, 'x'.repeat(MAX_LOCKFILE_LENGTH));
    expect(run(folder, env, { [own]: '{}' }, ['build', '--workspace-folder', repo], { repository: repositoryConfig, own }).status).toBe(0);
    expect(fs.readFileSync(`${folder}/devcontainer-lock.json`, 'utf8')).toHaveLength(MAX_LOCKFILE_LENGTH);
    write(lockfile, 'x'.repeat(MAX_LOCKFILE_LENGTH + 1));
    const result = run(folder, env, {}, ['build', '--workspace-folder', repo], { repository: repositoryConfig });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`is longer than ${MAX_LOCKFILE_LENGTH} characters.`);
  });

  it.each<[string, (repo: string) => { args: string[]; config: string }]>([
    ['without the workspace folder', (repo) => ({ args: ['build'], config: `${repo}/devcontainer.json` })],
    ['out of the workspace folder', (repo) => ({ args: ['build', '--workspace-folder', `${repo}/sub`], config: `${repo}/devcontainer.json` })],
    ['with ..', (repo) => ({ args: ['build', '--workspace-folder', repo], config: `${repo}/x/../devcontainer.json` })],
    ['with the root as the workspace folder', (repo) => ({ args: ['build', '--workspace-folder', '/'], config: `${repo}/devcontainer.json` })],
    ['with a relative workspace folder', () => ({ args: ['build', '--workspace-folder', 'repo'], config: 'repo/devcontainer.json' })],
  ])('refuses a configuration of the repository %s, and does not run the CLI', (_name, input) => {
    const { dir, folder, env } = setup();
    const repo = path.join(dir, 'repo');
    write(path.join(repo, 'devcontainer.json'), '{}');
    const { args, config } = input(repo);
    const result = run(folder, env, {}, args, { repository: config });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid configuration path');
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
    name: PROJECT,
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
      COMPOSE_PROJECT_NAME: PROJECT,
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
      name: PROJECT,
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

  it('records the real path of the folder that Buildx reads, as written (review round 3 of PR #130, R3A-1)', () => {
    const { repo, env } = setup();
    fs.mkdirSync(path.join(repo, 'x:a'));
    fs.mkdirSync(path.join(repo, 'x'));
    const model = {
      name: PROJECT,
      services: {
        tool: {
          build: {
            context: repo,
            dockerfile_inline: 'FROM alpine',
            // The tag after the last colon (Buildx's ocilayout.Parse); a space before an absolute path makes it relative.
            additional_contexts: { a: `oci-layout://${repo}/x:a:1`, b: ` ${repo}/x`, c: `OCI-LAYOUT://${repo}/x` },
          },
        },
      },
    };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(model) }) as { realPaths: Record<string, string | null> };
    expect(output.realPaths[`${repo}/x:a`]).toBe(fs.realpathSync(path.join(repo, 'x:a')));
    expect(Object.keys(output.realPaths)).not.toContain(`${repo}/x`);
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
      env: { ...env, FAKE_MODEL: JSON.stringify({ name: PROJECT, services }) },
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

  it('never waits on a FIFO of the repository as a Dockerfile, and reads no text of it (decision of 2026-10-07)', () => {
    const { repo, env } = setup();
    expect(spawnSync('mkfifo', [path.join(repo, 'fifo.Dockerfile')]).status).toBe(0);
    const model = { name: PROJECT, services: { fifo: { build: { context: repo, dockerfile: 'fifo.Dockerfile' } }, app: { build: { context: `${repo}/.devcontainer`, dockerfile: 'Dockerfile' } } } };
    const command = composeModelCommand(repo, [path.join(repo, 'compose.yml')]);
    const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', timeout: 10_000, env: { ...env, FAKE_MODEL: JSON.stringify(model) } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const parsed = parseComposeModelOutput(result.stdout.trim());
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.dockerfiles.fifo).toBeUndefined();
    expect(parsed.dockerfiles.app).toBe('FROM node:24\n');
  });

  it('prints the model of all profiles, the Dockerfiles in the repository, and the real paths', () => {
    const { dir, repo, argsFile, env } = setup();
    const files = [path.join(repo, 'compose.yml'), path.join(repo, '.devcontainer', 'compose.yml')];
    const output = runModel(repo, files, env) as Record<string, unknown>;
    expect(fs.readFileSync(argsFile, 'utf8').split('\n').slice(0, -1)).toEqual([
      repo,
      PROJECT,
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
    const model = { name: PROJECT, services: { app: { build: { context: `${repo}/ctx` } } } };
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
    const model = { name: PROJECT, services: { app: { build: { context } } } };
    const output = runModel(repo, [path.join(repo, 'compose.yml')], { ...env, FAKE_MODEL: JSON.stringify(model) }) as Record<string, unknown>;
    expect(output.dockerfiles).toEqual({});
  });

  it.each(BATCH_HELPER_FOLDERS)('does not read a Dockerfile in %s, a folder of the batch helper (follow-up of plan step 11I)', (folder) => {
    // The test cannot write the folder of the helper: in the list of the script, a temporary folder with a Dockerfile
    // stands for it. The script as it is reads that Dockerfile (outside the repository, no path of the helper).
    const { dir, repo, env } = setup();
    const standIn = path.join(dir, 'helper-folder');
    write(path.join(standIn, 'Dockerfile'), 'FROM secret\n');
    const script = COMPOSE_MODEL_SCRIPT.split(`'${folder}'`).join(JSON.stringify(standIn));
    expect(script).not.toBe(COMPOSE_MODEL_SCRIPT);
    const model = { name: PROJECT, services: { app: { build: { context: standIn } } } };
    const command = composeModelCommand(repo, [path.join(repo, 'compose.yml')]);
    const dockerfiles = (text: string): unknown => {
      const result = spawnSync(process.execPath, ['-e', text, ...command.slice(3)], { encoding: 'utf8', env: { ...env, FAKE_MODEL: JSON.stringify(model) } });
      expect(result.status, result.stderr).toBe(0);
      const parsed = parseComposeModelOutput(result.stdout.trim());
      if ('error' in parsed) throw new Error(parsed.error);
      return parsed.dockerfiles;
    };
    expect(dockerfiles(COMPOSE_MODEL_SCRIPT)).toEqual({ app: 'FROM secret\n' });
    expect(dockerfiles(script)).toEqual({});
  });

  // Review round 1 of the follow-up of plan step 11I (A-F5): the copy of isHelperPath in the script takes a path with a `..`
  // segment for a path of the helper, as isHelperPath of ../policy/rules.ts does (`..` after a link of the helper image
  // leads elsewhere than the text says). Its only caller (readDockerfile) gets paths that path.posix.resolve normalized
  // and their real paths, so the copy is run here by itself, with the `inside` of the repository folder.
  it('has a copy of isHelperPath that agrees with isHelperPath, also for a `..` segment', () => {
    const repo = '/workspaces/api';
    const start = COMPOSE_MODEL_SCRIPT.indexOf('const overlaps = ');
    const end = COMPOSE_MODEL_SCRIPT.indexOf('\n};\n', COMPOSE_MODEL_SCRIPT.indexOf('const isHelperPath = (file) => {'));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const copy = new Function('path', 'inside', `${COMPOSE_MODEL_SCRIPT.slice(start, end + 3)}\nreturn isHelperPath;`)(path, (file: string) => file === repo || file.startsWith(`${repo}/`)) as (file: string) => boolean;
    for (const [file, expected] of [
      ['/var/run/../devenv-cache', true],
      ['/var/lock/../devenv-secrets', true],
      ['/usr/lib/ssl/certs/../../../run/devenv-secrets', true],
      ['/opt/tools/../other', true],
      ['/workspaces/api/../.devenv+', true],
      ['/opt/..tools', false],
      ['/run/devenv-secrets/github-token', true],
      ['/var/run/devenv-docker', true],
      ['/workspaces/api/x', false],
      ['/tmp/devenv-override/context', false],
    ] as const) {
      expect(copy(file), file).toBe(expected);
      expect(isHelperPath(file, repo), file).toBe(expected);
    }
  });

  it('lists the build contexts and Dockerfiles that are missing in the repository, not links that lead out or nowhere (review round 3, P3-1)', () => {
    const { dir, repo, env } = setup();
    fs.mkdirSync(path.join(repo, 'ctx'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(repo, 'dangling.Dockerfile'));
    fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, 'out'));
    const model = {
      name: PROJECT,
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
      name: PROJECT,
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
      name: PROJECT,
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
        project: PROJECT,
        repositoryFolder: repo,
        ownVolume: OWN,
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
        name: PROJECT,
        services: { app: APP, db: { build: { context: repo, dockerfile_inline: `ARG img=${OTHER}:3\nFROM $$img\n` } } },
      };
      // Dockerfile refusals removed (user decision 2026-09-27): before, refused as `… devenv-0badc0de:3 of another environment`.
      expect(check(repo, env, printed)).toEqual({ hostAccess: [], unsupported: [] });
      // The update check reads the text that BuildKit uses (`$img`, not `$$img`).
      const output = modelRun(repo, env, printed);
      expect(composeReferences(output.model, output.dockerfiles, undefined).images).toEqual(['mcr.microsoft.com/devcontainers/base:bookworm', `${OTHER}:3`]);
    });

    it('checks a bind mount on the unescaped path (a link out of the repository)', () => {
      const { dir, repo, env } = setup();
      fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, '$x'));
      const report = check(repo, env, {
        name: PROJECT,
        services: { app: APP, db: { image: 'postgres:16', volumes: [{ type: 'bind', source: `${repo}/$$x`, target: '/data', bind: { create_host_path: true } }] } },
      });
      expect(report.hostAccess.join('\n')).toContain(`a link to ${fs.realpathSync(path.join(dir, 'outside'))}, outside of the repository`);
    });

    it('checks an env_file on the unescaped path (a link out of the repository)', () => {
      const { dir, repo, env } = setup();
      fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(repo, '$e.env'));
      const report = check(repo, env, { name: PROJECT, services: { app: APP, db: { image: 'postgres:16', env_file: [`${repo}/$$e.env`] } } });
      expect([...report.hostAccess, ...report.unsupported]).toEqual([`service db: env_file ${repo}/$e.env`]);
      // A file of the repository whose name holds a $ is allowed.
      write(path.join(repo, '$ok.env'), 'A=1\n');
      expect(check(repo, env, { name: PROJECT, services: { app: APP, db: { image: 'postgres:16', env_file: [`${repo}/$$ok.env`] } } })).toEqual({ hostAccess: [], unsupported: [] });
    });

    it('does not refuse a dockerfile_inline of the dev service with a variable in FROM', () => {
      const { repo, env } = setup();
      const report = check(repo, env, {
        name: PROJECT,
        services: { app: { build: { context: repo, dockerfile_inline: 'ARG BASE=mcr.microsoft.com/devcontainers/base:bookworm\nFROM $${BASE}\n' }, command: ['sleep', 'infinity'] } },
      });
      expect(report).toEqual({ hostAccess: [], unsupported: [] });
    });
  });

  it('unescapes the keys of every map of a model that Compose printed with $$ (review round 20, D20-1)', () => {
    const { repo, env } = setup();
    const printed = {
      name: PROJECT,
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
    const printed = { name: PROJECT, services: { app: { image: 'alpine', environment: { A: 'a$$b' } } } };
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

// Follow-up of plan step 11I (the links of the owner): the script needs Linux (/proc/self/fd, as in the helper), so the suite
// runs on Linux only (before, fakes of GNU stat and mv let it run elsewhere too).
describe.skipIf(!hasGit || process.platform !== 'linux')('GIT_FILES_SCRIPT with fake tools', () => {
  // The script needs Linux (/proc/self/fd, GNU rm). Git is real. Fake tools stand in for what a test cannot do as a user:
  // a module that Node loads before the script (`--require`) records the owner changes of the script (fchown, lchown)
  // instead of making them, by the inode they reach, and gives the repository folder the owner 1000:1001. A fake `git` on
  // PATH records the file that Git edits and runs the real Git; for the races, it first plays the owner of the repository
  // once (`race`, a shell command with that file as $1).
  // unit 15: the script gets no token any more; the token and the sign-in of the GitHub CLI go into the memory of the
  // dev container (TOKEN_WRITE_SCRIPT, containerToken.test.ts).
  // Follow-up of plan step 11I (the links of the owner): GIT_FILES_SCRIPT is a Node.js script (was sh, with a fake stat,
  // chown and mv).
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

  interface GitFilesEnv {
    dir: string;
    ws: string;
    bin: string;
    log: string;
    gitFiles: string;
    preload: string;
  }

  function setup(): GitFilesEnv {
    const dir = tempDir();
    const ws = path.join(dir, 'workspaces');
    const bin = path.join(dir, 'bin');
    const log = path.join(dir, 'log');
    const gitFiles = path.join(dir, 'git-files');
    const preload = path.join(dir, 'preload.js');
    fs.mkdirSync(path.join(ws, 'api'), { recursive: true });
    fs.writeFileSync(log, '');
    fs.writeFileSync(gitFiles, '');
    write(
      preload,
      [
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        'const { DEVENV_TEST_LOG: log, DEVENV_TEST_REPO: repo, DEVENV_TEST_MKDIR_RACE: race, DEVENV_TEST_GROW: grow, DEVENV_TEST_ROOT_LOCK: rootLock } = process.env;',
        // Review round 3 of PR G (A-L1, A-L2, B3-N2): the owner of gitconfig.lock as the script sees it; the inodes that
        // are the owner's (1000:1001) by their fstat; a log of the inodes that the script reads; the lock removed right
        // after the script's first lstat of it (the user, as the message of the step tells).
        'const { DEVENV_TEST_LOCK_OWNER: lockOwner, DEVENV_TEST_OWNED_INOS: ownedInos, DEVENV_TEST_READS: reads, DEVENV_TEST_UNLINK_LOCK: unlinkLock, DEVENV_TEST_UNLINK_LOCK_ERROR: unlinkError } = process.env;',
        "const lockIds = rootLock ? [0, 0] : lockOwner ? lockOwner.split(':').map(Number) : undefined;",
        "const record = (stat, uid, gid) => fs.appendFileSync(log, stat.ino + ' ' + uid + ':' + gid + '\\n');",
        'fs.fchownSync = (fd, uid, gid) => record(fs.fstatSync(fd), uid, gid);',
        'fs.lchownSync = (file, uid, gid) => record(fs.lstatSync(file), uid, gid);',
        'fs.chownSync = (file, uid, gid) => record(fs.statSync(file), uid, gid);',
        "for (const name of ['lstatSync', 'statSync']) {",
        '  const real = fs[name];',
        '  fs[name] = (file, ...rest) => {',
        '    const stat = real.call(fs, file, ...rest);',
        // Review round 2 of the follow-up (A-L1): with DEVENV_TEST_ROOT_LOCK, gitconfig.lock is root's (round 3: or the
        // owner of DEVENV_TEST_LOCK_OWNER).
        "    if (lockIds && stat && path.basename(String(file)) === 'gitconfig.lock') return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: lockIds[0], gid: lockIds[1] });",
        '    return file === repo && stat ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 1000, gid: 1001 }) : stat;',
        '  };',
        '}',
        // The race of the owner between the creation of a folder and its mode: right after the script made the folder
        // `entry`, the owner renames it away and puts a link to `target` in its place.
        'if (race) {',
        '  const [entry, target] = JSON.parse(race);',
        '  const mkdirSync = fs.mkdirSync;',
        '  fs.mkdirSync = (file, ...rest) => {',
        '    const result = mkdirSync.call(fs, file, ...rest);',
        '    if (path.basename(String(file)) === entry) {',
        "      fs.renameSync(file, file + '.moved');",
        '      fs.symlinkSync(target, file);',
        '    }',
        '    return result;',
        '  };',
        '}',
        "if (unlinkLock) {",
        '  const lstatSync = fs.lstatSync;',
        '  let done = false;',
        '  fs.lstatSync = (file, ...rest) => {',
        '    const stat = lstatSync.call(fs, file, ...rest);',
        "    if (!done && path.basename(String(file)) === 'gitconfig.lock') {",
        '      done = true;',
        '      fs.unlinkSync(file);',
        '    }',
        '    return stat;',
        '  };',
        '}',
        // With DEVENV_TEST_UNLINK_LOCK_ERROR, the removal of gitconfig.lock fails with that code.
        'if (unlinkError) {',
        '  const unlinkSync = fs.unlinkSync;',
        '  fs.unlinkSync = (file, ...rest) => {',
        "    if (path.basename(String(file)) === 'gitconfig.lock') throw Object.assign(new Error(unlinkError + ': the removal failed'), { code: unlinkError });",
        '    return unlinkSync.call(fs, file, ...rest);',
        '  };',
        '}',
        'if (ownedInos) {',
        "  const owned = ownedInos.split(',').map(Number);",
        '  const fstatSync = fs.fstatSync;',
        '  fs.fstatSync = (descriptor, ...rest) => {',
        '    const stat = fstatSync.call(fs, descriptor, ...rest);',
        '    return owned.includes(stat.ino) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 1000, gid: 1001 }) : stat;',
        '  };',
        '}',
        'if (reads) {',
        '  const readSync = fs.readSync;',
        '  fs.readSync = (descriptor, ...rest) => {',
        "    fs.appendFileSync(reads, fs.fstatSync(descriptor).ino + '\\n');",
        '    return readSync.call(fs, descriptor, ...rest);',
        '  };',
        '}',
        // Review round 1 of the follow-up of plan step 11I (A-F2): the owner appends `grow` bytes to gitconfig right after
        // the script looked at its size (the fstat of the file that it opened): a file that grows while it is copied.
        'if (grow) {',
        '  const { openSync, fstatSync } = fs;',
        '  let opened;',
        '  fs.openSync = (file, flags, ...rest) => {',
        '    const descriptor = openSync.call(fs, file, flags, ...rest);',
        "    if (opened === undefined && path.basename(String(file)) === 'gitconfig' && typeof flags === 'number' && (flags & fs.constants.O_CREAT) === 0) opened = descriptor;",
        '    return descriptor;',
        '  };',
        '  fs.fstatSync = (descriptor, ...rest) => {',
        '    const stat = fstatSync.call(fs, descriptor, ...rest);',
        '    if (descriptor === opened) {',
        '      opened = -1;',
        "      fs.appendFileSync('/proc/self/fd/' + descriptor, '#'.repeat(Number(grow)) + '\\n');",
        '    }',
        '    return stat;',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    write(
      path.join(bin, 'git'),
      [
        '#!/bin/sh',
        "file=''",
        "previous=''",
        'for arg do',
        '  if [ "$previous" = --file ]; then file=$arg; fi',
        '  previous=$arg',
        'done',
        'printf \'%s %s\\n\' "$(stat -c %a "$(dirname "$file")")" "$file" >> "$DEVENV_TEST_GIT_FILES"',
        // Review round 2 of the follow-up (A-L1): the number of this call of Git, for the race and the signal at a call.
        'calls=$(($(wc -l < "$DEVENV_TEST_GIT_FILES")))',
        'if [ -n "${DEVENV_TEST_RACE-}" ] && [ "$calls" -eq "${DEVENV_TEST_RACE_AT:-1}" ]; then',
        '  sh -c "$DEVENV_TEST_RACE" sh "$file"',
        'fi',
        // A Cancel: the signal to the script and to its Git (the batch helper signals the whole process group of the step).
        'if [ "$calls" -eq "${DEVENV_TEST_SIGNAL_AT:-0}" ]; then',
        '  kill -s "$DEVENV_TEST_SIGNAL" "$PPID"',
        '  kill -s "$DEVENV_TEST_SIGNAL" "$$"',
        'fi',
        'case " $* " in *" ${DEVENV_TEST_GIT_FAIL-none} "*) exit 1 ;; esac',
        'exec "$DEVENV_TEST_REAL_GIT" "$@"',
        '',
      ].join('\n'),
    );
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    return { dir, ws, bin, log, gitFiles, preload };
  }

  interface RunOptions {
    folder?: string;
    /** A shell command that the fake git runs once, at its first call (or at the call raceAt), as the owner of the repository. */
    race?: string;
    /** Review round 2 of the follow-up (A-L1): the call of Git at which `race` runs (1 when not given). */
    raceAt?: number;
    /** Review round 2 of the follow-up (A-L1): at this call of Git, the signal goes to the script and to that Git. */
    signalAt?: { call: number; signal: 'TERM' | 'INT' | 'HUP' | 'KILL' };
    /** Review round 2 of the follow-up (A-L1): lstat reports gitconfig.lock as root's (as the test may not run as root). */
    rootLock?: boolean;
    /** Review round 3 of PR G (A-L1): lstat reports gitconfig.lock with this owner (uid:gid). */
    lockOwner?: string;
    /** Review round 3 of PR G (A-L2): fstat reports these inodes as the owner's (1000:1001). */
    ownedInodes?: number[];
    /** Review round 3 of PR G (A-L2): the file where the inode of each read of the script is noted. */
    reads?: string;
    /** Review round 3 of PR G (B3-N2): the lock is removed right after the script's first lstat of it. */
    unlinkLockAfterLstat?: boolean;
    /** Review round 3 of PR G (B3-N2): the removal of gitconfig.lock fails with this code. */
    unlinkLockError?: string;
    /** [entry, target]: the folder `entry` is replaced by a link to `target` right after the script created it. */
    mkdirRace?: [string, string];
    /** The fake git fails when its arguments contain this one. */
    gitFails?: string;
    /** Review round 1 of the follow-up (A-F2): the owner appends this many bytes to gitconfig right after its open. */
    grow?: number;
    /** The largest file that the script may write, in blocks of 512 bytes (`ulimit -f`; more ends it with SIGXFSZ). */
    fileLimit?: number;
  }

  function run(env: GitFilesEnv, options: RunOptions = {}) {
    const script = GIT_FILES_SCRIPT.split('/workspaces').join(env.ws);
    const command = gitFilesCommand(options.folder ?? 'api', { name: 'Hannes Stauss', email: '1001+scalarion@users.noreply.github.com' }, CONTAINER_CREDENTIAL_HELPER);
    expect(command.slice(0, 3)).toEqual(['node', '-e', GIT_FILES_SCRIPT]);
    const argv = [process.execPath, '--require', env.preload, '-e', script, ...command.slice(3)];
    const [file, ...args] = options.fileLimit === undefined ? argv : ['sh', '-c', 'ulimit -f "$1" && shift && exec "$@"', 'sh', String(options.fileLimit), ...argv];
    const result = spawnSync(file, args, {
      encoding: 'utf8',
      input: '',
      timeout: 20_000,
      // Review round 3 of PR G (A-L4): the script ignores SIGTERM (review round 2, A-L1), the default signal of the time
      // limit, so a script that hangs is ended with SIGKILL.
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        PATH: `${env.bin}${path.delimiter}${process.env.PATH ?? ''}`,
        GIT_CONFIG_NOSYSTEM: '1',
        DEVENV_TEST_LOG: env.log,
        DEVENV_TEST_REPO: path.join(env.ws, options.folder ?? 'api'),
        DEVENV_TEST_GIT_FILES: env.gitFiles,
        DEVENV_TEST_REAL_GIT: realGit,
        ...(options.race !== undefined ? { DEVENV_TEST_RACE: options.race } : {}),
        ...(options.raceAt !== undefined ? { DEVENV_TEST_RACE_AT: String(options.raceAt) } : {}),
        ...(options.signalAt !== undefined ? { DEVENV_TEST_SIGNAL_AT: String(options.signalAt.call), DEVENV_TEST_SIGNAL: options.signalAt.signal } : {}),
        ...(options.rootLock === true ? { DEVENV_TEST_ROOT_LOCK: '1' } : {}),
        ...(options.lockOwner !== undefined ? { DEVENV_TEST_LOCK_OWNER: options.lockOwner } : {}),
        ...(options.ownedInodes !== undefined ? { DEVENV_TEST_OWNED_INOS: options.ownedInodes.join(',') } : {}),
        ...(options.reads !== undefined ? { DEVENV_TEST_READS: options.reads } : {}),
        ...(options.unlinkLockAfterLstat === true ? { DEVENV_TEST_UNLINK_LOCK: '1' } : {}),
        ...(options.unlinkLockError !== undefined ? { DEVENV_TEST_UNLINK_LOCK_ERROR: options.unlinkLockError } : {}),
        ...(options.mkdirRace !== undefined ? { DEVENV_TEST_MKDIR_RACE: JSON.stringify(options.mkdirRace) } : {}),
        ...(options.gitFails !== undefined ? { DEVENV_TEST_GIT_FAIL: options.gitFails } : {}),
        ...(options.grow !== undefined ? { DEVENV_TEST_GROW: String(options.grow) } : {}),
      },
    });
    return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error };
  }

  function gitConfig(file: string, ...args: string[]): string {
    return spawnSync('git', ['config', '--file', file, ...args], { encoding: 'utf8' }).stdout;
  }

  /** The owners that the script gave, by inode (the records of the fake chown). */
  function owners(env: GitFilesEnv): Map<number, string[]> {
    const result = new Map<number, string[]>();
    for (const line of fs.readFileSync(env.log, 'utf8').split('\n').filter((entry) => entry !== '')) {
      const [ino, owner] = line.split(' ');
      result.set(Number(ino), [...(result.get(Number(ino)) ?? []), owner]);
    }
    return result;
  }

  const ino = (file: string): number => fs.lstatSync(file).ino;

  /**
   * Follow-up of plan step 11I (the links of the owner): a folder outside the volume (in the helper, the cache volume or
   * its own files), with files named as those of CONFIG_FOLDER, at which the owner points links; `state` is all that the
   * script must not change (names, kinds, modes, inodes, contents), `inodes` what it must give no owner.
   */
  function outside(env: GitFilesEnv): { folder: string; file: string; state: () => string[]; inodes: () => number[] } {
    const folder = path.join(env.dir, 'outside');
    fs.mkdirSync(path.join(folder, 'docker'), { recursive: true });
    for (const name of ['file', 'gitconfig', 'credentials.gitconfig']) write(path.join(folder, name), `[outside]\n\tname = ${name}\n`);
    for (const name of ['file', 'gitconfig', 'credentials.gitconfig']) fs.chmodSync(path.join(folder, name), 0o640);
    fs.chmodSync(path.join(folder, 'docker'), 0o751);
    fs.chmodSync(folder, 0o751);
    const entries = (): Array<[string, fs.Stats]> => {
      const list: Array<[string, fs.Stats]> = [['.', fs.lstatSync(folder)]];
      const walk = (at: string) => {
        for (const name of fs.readdirSync(at).sort()) {
          const file = path.join(at, name);
          const stat = fs.lstatSync(file);
          list.push([path.relative(folder, file), stat]);
          if (stat.isDirectory()) walk(file);
        }
      };
      walk(folder);
      return list;
    };
    return {
      folder,
      file: path.join(folder, 'file'),
      state: () =>
        entries().map(([name, stat]) => {
          const kind = stat.isDirectory() ? 'folder' : stat.isSymbolicLink() ? `link ${fs.readlinkSync(path.join(folder, name))}` : JSON.stringify(fs.readFileSync(path.join(folder, name), 'utf8'));
          return `${name} ${(stat.mode & 0o7777).toString(8)} ${stat.ino} ${kind}`;
        }),
      inodes: () => entries().map(([, stat]) => stat.ino),
    };
  }

  /** A gitconfig of the user whose credential section the script has to repair, in a new CONFIG_FOLDER. */
  function userGitConfig(env: GitFilesEnv): string {
    const cfg = path.join(env.ws, '.devenv+', 'gitconfig');
    write(cfg, '[user]\n\tname = Changed Name\n[credential "https://github.com"]\n\thelper = store\n[alias]\n\tst = status\n');
    return cfg;
  }

  /** CONFIG_FOLDER `dir` as the script leaves it: the four entries, their modes, the owner 1000:1001 of each. */
  function expectConfigFolder(env: GitFilesEnv, dir: string): void {
    expect(fs.readdirSync(dir).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    expect(fs.lstatSync(dir).mode & 0o777).toBe(0o755);
    for (const name of ['docker', 'gh']) {
      expect(fs.lstatSync(path.join(dir, name)).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(dir, name)).mode & 0o777).toBe(0o700);
    }
    for (const name of ['gitconfig', 'credentials.gitconfig']) expect(fs.lstatSync(path.join(dir, name)).isFile()).toBe(true);
    expect(gitConfig(path.join(dir, 'gitconfig'), '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    const given = owners(env);
    for (const name of ['.', 'docker', 'gh', 'gitconfig', 'credentials.gitconfig']) expect(given.get(ino(path.join(dir, name))), name).toEqual(['1000:1001']);
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
    // Follow-up of plan step 11I (the links of the owner): changed expectation, the owner changes are recorded by the inode
    // that the script gives the owner through its descriptor (fchown), not as a chown command line; the same five entries
    // (the folder, docker, gitconfig, credentials.gitconfig, gh) get 1000:1001, and nothing else gets an owner.
    const given = owners(env);
    const credentials = path.join(dir, 'credentials.gitconfig');
    const gh = path.join(dir, 'gh');
    expect([...given.keys()].sort()).toEqual([dir, path.join(dir, 'docker'), cfg, credentials, gh].map(ino).sort());
    for (const file of [dir, path.join(dir, 'docker'), cfg, credentials, gh]) expect(given.get(ino(file)), file).toEqual(['1000:1001']);
    // No GnuPG folder: the extension does not change where GnuPG works (user decision 2026-09-25). unit 15: no token file.
    expect(fs.readdirSync(dir).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    // The file for the credential helpers of the user: only comments, readable by every user of the container.
    expect(fs.readFileSync(credentials, 'utf8')).toBe(GIT_CREDENTIALS_CONFIG_CONTENT.split('/workspaces').join(env.ws));
    expect(fs.statSync(credentials).mode & 0o777).toBe(0o644);
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o644);
    expect(spawnSync('git', ['config', '--file', credentials, '--list'], { encoding: 'utf8' })).toMatchObject({ status: 0, stdout: '' });
    // unit 15: the gh folder of the volume (for config.yml), 0700 and empty, owned by the repository owner.
    expect(fs.statSync(gh).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(gh)).toEqual([]);
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
    const missing = run(env, { folder: 'other' });
    expect(missing.status).toBe(4);
    expect(fs.existsSync(path.join(env.ws, '.devenv+'))).toBe(false);
  });

  it('rejects an invalid folder name', () => {
    const result = run(setup(), { folder: '../etc' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid folder name');
  });

  // Follow-up of plan step 11I (the links of the owner): root never follows a link that the owner of the repository
  // planted, before the run or while it runs, and never resolves a path through an entry of the volume.

  it.each([
    ['gitconfig', 'file'],
    ['credentials.gitconfig', 'file'],
    ['docker', 'folder'],
    ['gh', 'folder'],
  ] as const)('leaves the target of a link planted at %s before the run unchanged, and writes a correct configuration', (entry, target) => {
    const env = setup();
    const out = outside(env);
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    fs.symlinkSync(target === 'file' ? out.file : out.folder, path.join(dir, entry));
    const before = out.state();
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    expectConfigFolder(env, dir);
  });

  it('edits no gitconfig that the owner replaces by a link while Git runs', () => {
    const env = setup();
    const out = outside(env);
    const cfg = userGitConfig(env);
    const before = out.state();
    // The owner renames gitconfig away and puts a link to a file outside the volume in its place when Git starts.
    // Review round 2 of the follow-up (A-L1): changed test, at the second call of Git (the first under Git's lock, on the
    // copy that it writes; the first call is now the check without the lock, the next test).
    const result = run(env, { race: `mv '${cfg}' '${cfg}.moved' && ln -s '${out.file}' '${cfg}'`, raceAt: 2 });
    expect(fs.readFileSync(`${cfg}.moved`, 'utf8')).toContain('helper = store');
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The rename of the new file replaced the link itself: gitconfig is the repaired configuration of the user.
    expect(fs.lstatSync(cfg).isFile()).toBe(true);
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(owners(env).get(ino(cfg))).toEqual(['1000:1001']);
  });

  // Review round 2 of the follow-up of plan step 11I (A-L1): a link that the owner puts in place of gitconfig during the
  // check without the lock is removed under the lock, and a new gitconfig takes its place (the file of the owner is where
  // it moved it).
  it('edits no gitconfig that the owner replaces by a link during its check without the lock', () => {
    const env = setup();
    const out = outside(env);
    const cfg = userGitConfig(env);
    const before = out.state();
    const result = run(env, { race: `mv '${cfg}' '${cfg}.moved' && ln -s '${out.file}' '${cfg}'` });
    expect(fs.readFileSync(`${cfg}.moved`, 'utf8')).toContain('helper = store');
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.lstatSync(cfg).isFile()).toBe(true);
    expect(gitConfig(cfg, 'user.name')).toBe('Hannes Stauss\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(owners(env).get(ino(cfg))).toEqual(['1000:1001']);
  });

  it('writes only into the configuration folder that it opened, also when it is replaced by a link while Git runs', () => {
    // Root of the dev container (also a remote user with sudo) can rename the entries of /workspaces too.
    const env = setup();
    const out = outside(env);
    userGitConfig(env);
    const dir = path.join(env.ws, '.devenv+');
    const before = out.state();
    const result = run(env, { race: `mv '${dir}' '${dir}.moved' && ln -s '${out.folder}' '${dir}'` });
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // Everything went into the folder that the script opened, wherever the owner moved it.
    expectConfigFolder(env, `${dir}.moved`);
    expect(gitConfig(path.join(`${dir}.moved`, 'gitconfig'), 'alias.st')).toBe('status\n');
  });

  it.each(['.devenv+', 'docker', 'gh'])('changes no mode through a link that replaces %s between its creation and its mode', (entry) => {
    const env = setup();
    const out = outside(env);
    const before = out.state();
    const result = run(env, { mkdirRace: [entry, out.folder] });
    // The script finds a link where it created the folder: it stops (a warning of the open), and follows nothing.
    const moved = entry === '.devenv+' ? path.join(env.ws, '.devenv+.moved') : path.join(env.ws, '.devenv+', `${entry}.moved`);
    expect(fs.lstatSync(moved).isDirectory()).toBe(true);
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    expect(result.status).toBe(1);
  });

  it('lets Git edit only a copy in a folder of root outside the volume, which it removes at the end, also after a failure', () => {
    const env = setup();
    userGitConfig(env);
    expect(run(env).status).toBe(0);
    const edited = fs.readFileSync(env.gitFiles, 'utf8').split('\n').filter((line) => line !== '');
    expect(edited.length).toBeGreaterThan(0);
    const folders = new Set(edited.map((line) => path.dirname(line.slice(line.indexOf(' ') + 1))));
    expect(folders.size).toBe(1);
    const [work] = [...folders];
    // Root's folder (0700), outside the workspace volume, gone after the run.
    expect(edited.every((line) => line.startsWith('700 '))).toBe(true);
    expect(path.relative(env.ws, work).startsWith('..')).toBe(true);
    expect(fs.existsSync(work)).toBe(false);

    // A failure of Git: the step fails, and neither the folder nor a new file of the script is left.
    const failing = setup();
    const cfg = userGitConfig(failing);
    const original = fs.readFileSync(cfg, 'utf8');
    const result = run(failing, { gitFails: '--add' });
    expect(result.status).not.toBe(0);
    const failedWork = path.dirname(fs.readFileSync(failing.gitFiles, 'utf8').split('\n')[0].split(' ')[1]);
    expect(path.relative(failing.ws, failedWork).startsWith('..')).toBe(true);
    expect(fs.existsSync(failedWork)).toBe(false);
    expect(fs.readdirSync(path.join(failing.ws, '.devenv+')).sort()).toEqual(['docker', 'gh', 'gitconfig']);
    expect(fs.readFileSync(cfg, 'utf8')).toBe(original);
  });

  it('gives no owner to a file that has another link, and writes such a gitconfig again as a new file', () => {
    // A hard link could name a file of another user elsewhere in the volume.
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    const sharedCredentials = path.join(env.ws, 'api', 'credentials');
    const sharedConfig = path.join(env.ws, 'api', 'config');
    write(sharedCredentials, 'credentials of another file\n');
    const correct = `[credential "https://github.com"]\n\thelper = \n\thelper = ${JSON.stringify(CONTAINER_CREDENTIAL_HELPER)}\n`;
    write(sharedConfig, correct);
    fs.linkSync(sharedCredentials, path.join(dir, 'credentials.gitconfig'));
    fs.linkSync(sharedConfig, path.join(dir, 'gitconfig'));
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(owners(env).has(ino(sharedCredentials))).toBe(false);
    expect(owners(env).has(ino(sharedConfig))).toBe(false);
    expect(fs.readFileSync(sharedConfig, 'utf8')).toBe(correct);
    expect(fs.readFileSync(sharedCredentials, 'utf8')).toBe('credentials of another file\n');
    // gitconfig: a new file of the owner; credentials.gitconfig stays as it is. Review round 3 of PR G (A-L2): changed
    // expectation (was: the new file had the same text): the linked file is not the owner's (1000 here), so its text is
    // not taken; the new gitconfig starts as a missing one does (the identity and the section).
    const cfg = path.join(dir, 'gitconfig');
    expect(ino(cfg)).not.toBe(ino(sharedConfig));
    expect(gitConfig(cfg, 'user.name')).toBe('Hannes Stauss\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o644);
    expect(owners(env).get(ino(cfg))).toEqual(['1000:1001']);
    expect(ino(path.join(dir, 'credentials.gitconfig'))).toBe(ino(sharedCredentials));
  });

  // Review round 3 of PR G (A-L2), older than the follow-up: where fs.protected_hardlinks is off, the owner can link a file
  // of another user that Git can read (for example the configuration of a service, with its password, mode 0600) at
  // gitconfig. The script wrote such a gitconfig again as a new file of the owner with its text, so the owner could read
  // it. Now a linked file that is not the owner's stays unread.
  it('reads nothing of a file of another user that the owner linked at gitconfig, and starts a new gitconfig without its text', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    const secret = path.join(env.dir, 'service', 'my.cnf');
    write(secret, '[client]\n\tpassword = s3cret-of-the-service\n');
    fs.chmodSync(secret, 0o600);
    fs.linkSync(secret, path.join(dir, 'gitconfig'));
    const reads = path.join(env.dir, 'reads');
    fs.writeFileSync(reads, '');
    const result = run(env, { reads });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const cfg = path.join(dir, 'gitconfig');
    expect(ino(cfg)).not.toBe(ino(secret));
    expect(fs.readFileSync(cfg, 'utf8')).not.toContain('s3cret');
    expect(gitConfig(cfg, 'user.name')).toBe('Hannes Stauss\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(owners(env).get(ino(cfg))).toEqual(['1000:1001']);
    // The file of the service: never read by the script, nor by its Git, and as it was.
    expect(fs.readFileSync(reads, 'utf8').split('\n').filter((line) => line !== '').map(Number)).not.toContain(ino(secret));
    for (const line of fs.readFileSync(env.gitFiles, 'utf8').split('\n').filter((entry) => entry !== '')) expect(path.basename(line)).toBe('gitconfig');
    expect(fs.readFileSync(secret, 'utf8')).toBe('[client]\n\tpassword = s3cret-of-the-service\n');
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    expect(owners(env).has(ino(secret))).toBe(false);
  });

  // Review round 3 of PR G (A-L2): a linked gitconfig of the owner is its configuration: written again as a new file (one
  // link) with its text and its mode.
  it('keeps the text of a gitconfig of the owner that has a second link, in a new file', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    const shared = path.join(env.ws, 'api', 'dotfiles-gitconfig');
    write(shared, '[alias]\n\tst = status\n');
    fs.chmodSync(shared, 0o640);
    fs.linkSync(shared, path.join(dir, 'gitconfig'));
    const result = run(env, { ownedInodes: [ino(shared)] });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const cfg = path.join(dir, 'gitconfig');
    expect(ino(cfg)).not.toBe(ino(shared));
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(gitConfig(cfg, 'user.name')).toBe('');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(shared, 'utf8')).toBe('[alias]\n\tst = status\n');
  });

  it('never waits on a FIFO in place of gitconfig', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    fs.mkdirSync(dir);
    expect(spawnSync('mkfifo', [path.join(dir, 'gitconfig')]).status).toBe(0);
    const result = run(env);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${dir}/gitconfig is not a file.`);
    // Review round 1 of the follow-up of plan step 11I (A-F4): no lock is left. Review round 3 of PR G (B3-L1): since review
    // round 2 (A-L1) the step fails in its check without the lock, so it takes none (the removal of its own lock on a
    // failure is tested elsewhere).
    expect(fs.existsSync(path.join(dir, 'gitconfig.lock'))).toBe(false);
  });

  // Review round 1 of the follow-up of plan step 11I (A-F4): gitconfig is the GIT_CONFIG_GLOBAL of the dev container. The
  // script took no lock (the shell script before it ran `git config --file` on it, which took Git's lock each time), so a
  // `git config --global` in the dev container between its copy and its rename was lost.
  it("holds Git's lock while it reads and replaces gitconfig: a change of Git in the dev container meanwhile fails, and is never lost", () => {
    const env = setup();
    const cfg = userGitConfig(env);
    const status = path.join(env.dir, 'concurrent-status');
    const stderr = path.join(env.dir, 'concurrent-stderr');
    // When the script's Git starts (after the copy), Git in the dev container sets user.name in gitconfig. Review round 2
    // of the follow-up (A-L1): changed test, at the second call of Git, the first under the lock (the first call is now
    // the check without the lock, the next test).
    const result = run(env, { race: `"$DEVENV_TEST_REAL_GIT" config --file '${cfg}' user.name 'Concurrent Name' 2> '${stderr}'; echo $? > '${status}'`, raceAt: 2 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // Git finds the lock and fails, as for another Git: the user sees it (never a change that is silently lost).
    expect(fs.readFileSync(status, 'utf8').trim()).not.toBe('0');
    expect(fs.readFileSync(stderr, 'utf8')).toContain('could not lock config file');
    expect(gitConfig(cfg, 'user.name')).toBe('Changed Name\n');
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    expect(owners(env).get(ino(cfg))).toEqual(['1000:1001']);
    expect(fs.readdirSync(path.dirname(cfg)).sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
  });

  // Review round 2 of the follow-up of plan step 11I (A-L1): during the check without the lock, a change of Git in the dev
  // container succeeds; the script reads gitconfig again under the lock, so the change is kept.
  it('keeps a change that Git in the dev container makes during the check without the lock', () => {
    const env = setup();
    const cfg = userGitConfig(env);
    const status = path.join(env.dir, 'concurrent-status');
    const result = run(env, { race: `"$DEVENV_TEST_REAL_GIT" config --file '${cfg}' user.name 'Concurrent Name'; echo $? > '${status}'` });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(status, 'utf8').trim()).toBe('0');
    expect(gitConfig(cfg, 'user.name')).toBe('Concurrent Name\n');
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  it('fails and changes nothing when gitconfig.lock exists (a Git of the dev container holds it), as Git does', () => {
    const env = setup();
    const cfg = userGitConfig(env);
    const lock = `${cfg}.lock`;
    write(lock, 'the lock of another Git\n');
    const before = { text: fs.readFileSync(cfg, 'utf8'), ino: ino(cfg), lock: ino(lock) };
    const result = run(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${lock} exists`);
    expect(result.stderr).not.toContain('/proc/self/fd');
    // gitconfig and the lock of the other Git stay as they are; Git did not run. Review round 2 of the follow-up (A-L1):
    // changed expectation, Git ran once, on the copy of the check without the lock (was: never), and never on a copy to
    // write.
    expect({ text: fs.readFileSync(cfg, 'utf8'), ino: ino(cfg), lock: ino(lock) }).toEqual(before);
    expect(fs.readFileSync(lock, 'utf8')).toBe('the lock of another Git\n');
    expect(fs.readFileSync(env.gitFiles, 'utf8').split('\n').filter((line) => line !== '').map((line) => path.basename(line))).toEqual(['check']);
  });

  it('removes only its own lock when it fails: an entry that the owner put in its place stays', () => {
    const env = setup();
    const cfg = userGitConfig(env);
    const lock = `${cfg}.lock`;
    // When Git starts under the lock (its second call; review round 2 of the follow-up, A-L1: the first is the check
    // without the lock), the owner moves the lock of the script away and puts a file of its own at gitconfig.lock; then
    // Git fails.
    const result = run(env, { race: `mv '${lock}' '${lock}.moved' && printf 'other\\n' > '${lock}'`, raceAt: 2, gitFails: '--add' });
    expect(result.status).toBe(1);
    expect(fs.readFileSync(lock, 'utf8')).toBe('other\n');
    expect(fs.readFileSync(cfg, 'utf8')).toContain('helper = store');
  });

  // Review round 2 of the follow-up of plan step 11I (A-L1): the script took Git's lock at every run, also when nothing
  // changed (every open, also of a running dev container); a run killed then (a Cancel) left it, and it stopped every
  // later run and every `git config --global` in the dev container. A run that changes nothing takes no lock now.
  it.each(['file', 'folder'])('takes no lock when nothing changes: a gitconfig.lock (a %s) does not stop the run, and stays', (kind) => {
    const env = setup();
    const cfg = path.join(env.ws, '.devenv+', 'gitconfig');
    write(cfg, `[credential "https://github.com"]\n\thelper = \n\thelper = ${JSON.stringify(CONTAINER_CREDENTIAL_HELPER)}\n`);
    const lock = `${cfg}.lock`;
    if (kind === 'folder') fs.mkdirSync(lock);
    else write(lock, 'the lock of another Git\n');
    const before = { text: fs.readFileSync(cfg, 'utf8'), ino: ino(cfg), lock: ino(lock) };
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect({ text: fs.readFileSync(cfg, 'utf8'), ino: ino(cfg), lock: ino(lock) }).toEqual(before);
    expect(owners(env).get(ino(cfg))).toEqual(['1000:1001']);
  });

  // Review round 2 of the follow-up of plan step 11I (A-L1): a Cancel sends SIGTERM to the process group of the step (the
  // script and its Git); the script died with it, and a run killed while it held the lock left it. Now it ignores the
  // signal and ends at once with its cleanup: at the second call of Git (under the lock) its Git dies, it takes the
  // section for changed and writes it; at the fourth (the first `--add`) the step fails and changes nothing.
  it.each([
    [2, 'TERM'],
    [4, 'TERM'],
    [2, 'INT'],
    [2, 'HUP'],
  ] as const)('leaves no lock and ends at once at the call %s of Git (under the lock) when it gets SIG%s', (call, signal) => {
    const env = setup();
    const cfg = userGitConfig(env);
    const started = Date.now();
    const result = run(env, { signalAt: { call, signal } });
    // Before the SIGKILL of the batch helper (CHANNEL_KILL_GRACE_MS, 5 seconds).
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.signal).toBeNull();
    expect(fs.existsSync(`${cfg}.lock`)).toBe(false);
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    if (call === 2) {
      expect(result.status).toBe(0);
      expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
    } else {
      expect(result.status).toBe(1);
      expect(fs.readFileSync(cfg, 'utf8')).toContain('helper = store');
    }
  });

  // Review round 2 of the follow-up of plan step 11I (A-L1): a lock that a killed run left (root's, a plain file of one
  // link, unchanged for more than 10 minutes) is removed, with a line in the log; any other lock stays and stops the step.
  const staleLock = (lock: string, minutes: number) => {
    const time = (Date.now() - minutes * 60 * 1000) / 1000;
    if (fs.lstatSync(lock).isSymbolicLink()) fs.lutimesSync(lock, time, time);
    else fs.utimesSync(lock, time, time);
  };

  it('removes a lock of root that is unchanged for more than 10 minutes (a run that was killed), says so, and repairs gitconfig', () => {
    const env = setup();
    const cfg = userGitConfig(env);
    const lock = `${cfg}.lock`;
    write(lock, '');
    staleLock(lock, 11);
    const result = run(env, { rootLock: true });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removed ${lock}, the lock of a run that was killed (unchanged for 11 minutes).\n`);
    expect(fs.existsSync(lock)).toBe(false);
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  it.each([
    ['younger than 10 minutes', 9, 'file'],
    ['of another owner', 11, 'other'],
    // Review round 3 of PR G (A-L1): the owner of the lock is told by its uid, not by the group of the owner.
    ['of another user in the group of the owner', 11, 'group'],
    ['a folder', 11, 'folder'],
    ['a file with a second link', 11, 'linked'],
    ['a link', 11, 'link'],
  ] as const)('keeps a lock that is %s, and fails as for a Git that runs', (_what, minutes, kind) => {
    const env = setup();
    const cfg = userGitConfig(env);
    const lock = `${cfg}.lock`;
    if (kind === 'folder') fs.mkdirSync(lock);
    else if (kind === 'link') fs.symlinkSync(path.join(env.dir, 'nowhere'), lock);
    else write(lock, 'the lock of another Git\n');
    if (kind === 'linked') fs.linkSync(lock, path.join(env.dir, 'second'));
    staleLock(lock, minutes);
    const before = fs.lstatSync(lock).ino;
    // Review round 3 of PR G (A-L1): changed test, the lock of another owner is reported as 4321's (was: the test user's,
    // or chowned to 4321 as root): a lock of the owner of the repository (1000 here, which the test user may be) is
    // removed now.
    const result = run(env, kind === 'other' ? { lockOwner: '4321:4321' } : kind === 'group' ? { lockOwner: '4321:1001' } : { rootLock: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${lock} exists`);
    expect(result.stdout).not.toContain('Removed');
    expect(fs.lstatSync(lock).ino).toBe(before);
    expect(fs.readFileSync(cfg, 'utf8')).toContain('helper = store');
  });

  // Review round 3 of PR G (A-L1): a run killed while it held the lock leaves a lock of root; the next open within 10
  // minutes fails the step, and its ownership fix of CONFIG_FOLDER after `up` (fixConfigOwnership, CONFIG_OWNERSHIP_FIX_SCRIPT)
  // gives the lock to the remote user. The rule took only a lock of root, so that lock stayed for good. A lock of the
  // owner is taken now too (here as the script sees it; the test below makes it so with the real tools, as root).
  it('removes a lock of the owner that is unchanged for more than 10 minutes (a killed run, then the ownership fix), and repairs gitconfig', () => {
    const env = setup();
    const cfg = userGitConfig(env);
    const lock = `${cfg}.lock`;
    write(lock, '');
    staleLock(lock, 11);
    const result = run(env, { lockOwner: '1000:1001' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removed ${lock}, the lock of a run that was killed (unchanged for 11 minutes).\n`);
    expect(fs.existsSync(lock)).toBe(false);
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  // Review round 3 of PR G (A-L1): reviewer A's reproduction with the real tools (scratchpad/pGr3A-work/e2-ownerfix.sh):
  // the first open is killed (SIGKILL) at its first call of Git, under the lock; the ownership fix of the next open gives
  // the lock to the remote user (1000:1001); 11 minutes later the step removes it and writes gitconfig.
  it.skipIf(process.getuid?.() !== 0)('removes the lock of a killed run that the ownership fix gave to the remote user, with the real ownership fix as root', () => {
    const env = setup();
    const dir = path.join(env.ws, '.devenv+');
    const lock = path.join(dir, 'gitconfig.lock');
    const killed = run(env, { signalAt: { call: 1, signal: 'KILL' } });
    // A script that the signal ended leaves its work folder (root's, in the helper's /tmp).
    const work = path.dirname(fs.readFileSync(env.gitFiles, 'utf8').split('\n')[0].split(' ')[1]);
    expect(path.basename(work)).toMatch(/^devenv-git-files-/);
    fs.rmSync(work, { recursive: true, force: true });
    expect(killed.signal).toBe('SIGKILL');
    expect(fs.lstatSync(lock).uid).toBe(0);
    const [file, ...args] = configOwnershipFixCommand(dir, '1000', '1001');
    expect(spawnSync(file, args, { encoding: 'utf8' }).status).toBe(0);
    expect([fs.lstatSync(lock).uid, fs.lstatSync(lock).gid]).toEqual([1000, 1001]);
    staleLock(lock, 11);
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removed ${lock}, the lock of a run that was killed (unchanged for 11 minutes).\n`);
    expect(fs.existsSync(lock)).toBe(false);
    expect(gitConfig(path.join(dir, 'gitconfig'), 'user.name')).toBe('Hannes Stauss\n');
    expect(gitConfig(path.join(dir, 'gitconfig'), '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  // Review round 3 of PR G (B3-N2): a stale lock removed between the script's lstat and its removal (by the user, as the
  // message of the step tells) failed the step with ENOENT; it is a lock that is gone, so the script takes its own.
  it('takes the lock when a stale lock is removed between its check and its removal', () => {
    const env = setup();
    const cfg = userGitConfig(env);
    const lock = `${cfg}.lock`;
    write(lock, '');
    staleLock(lock, 11);
    const result = run(env, { rootLock: true, unlinkLockAfterLstat: true });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Removed');
    expect(fs.existsSync(lock)).toBe(false);
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  // Review round 3 of PR G (B3-N2): only ENOENT of the removal is a lock that is gone; any other error is the step's error
  // as it is, never taken for a lock of another Git.
  it('fails with the error of its removal of a stale lock that it cannot remove', () => {
    const env = setup();
    const cfg = userGitConfig(env);
    const lock = `${cfg}.lock`;
    write(lock, '');
    staleLock(lock, 11);
    const result = run(env, { rootLock: true, unlinkLockError: 'EPERM' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('EPERM: the removal failed\n');
    expect(result.stdout).not.toContain('Removed');
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(cfg, 'utf8')).toContain('helper = store');
  });

  // Review round 1 of the follow-up of plan step 11I (A-F2): the script copied the whole gitconfig of the owner into the
  // helper before Git read a line of it (the shell script before it let Git read the file in place).
  it('refuses a gitconfig of more than 1 MiB before Git reads it, and changes nothing', () => {
    const env = setup();
    const cfg = path.join(env.ws, '.devenv+', 'gitconfig');
    write(cfg, `[alias]\n\tst = status\n# ${'x'.repeat(1024 * 1024)}\n`);
    const before = { text: fs.readFileSync(cfg, 'utf8'), ino: ino(cfg) };
    const result = run(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${cfg} is larger than 1 MiB: it stays as it is.\n`);
    expect({ text: fs.readFileSync(cfg, 'utf8'), ino: ino(cfg) }).toEqual(before);
    expect(fs.readFileSync(env.gitFiles, 'utf8')).toBe('');
    expect(fs.readdirSync(path.dirname(cfg)).sort()).toEqual(['docker', 'gh', 'gitconfig']);
  });

  it('refuses a gitconfig that grows over 1 MiB while it is copied (after the script looked at its size)', () => {
    const env = setup();
    const cfg = path.join(env.ws, '.devenv+', 'gitconfig');
    const text = `[alias]\n\tst = status\n# `;
    write(cfg, `${text}${'x'.repeat(1024 * 1024 - text.length - 11)}\n`);
    expect(fs.statSync(cfg).size).toBe(1024 * 1024 - 10);
    const result = run(env, { grow: 100 });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${cfg} is larger than 1 MiB: it stays as it is.\n`);
    expect(fs.statSync(cfg).size).toBe(1024 * 1024 + 91);
    expect(fs.readFileSync(env.gitFiles, 'utf8')).toBe('');
    expect(fs.readdirSync(path.dirname(cfg)).sort()).toEqual(['docker', 'gh', 'gitconfig']);
  });

  it('repairs a gitconfig of exactly 1 MiB', () => {
    const env = setup();
    const cfg = path.join(env.ws, '.devenv+', 'gitconfig');
    const text = `[alias]\n\tst = status\n# `;
    write(cfg, `${text}${'x'.repeat(1024 * 1024 - text.length - 1)}\n`);
    expect(fs.statSync(cfg).size).toBe(1024 * 1024);
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(gitConfig(cfg, 'alias.st')).toBe('status\n');
    expect(gitConfig(cfg, '--get-all', 'credential.https://github.com.helper')).toBe(`\n${CONTAINER_CREDENTIAL_HELPER}\n`);
  });

  // By its size: it copies no byte of it (a run that copies from it fails at the limit of 512 KiB on the files it writes).
  it('refuses a sparse gitconfig of 1 TiB without copying any of it', () => {
    const env = setup();
    const cfg = path.join(env.ws, '.devenv+', 'gitconfig');
    write(cfg, '');
    fs.truncateSync(cfg, 2 ** 40);
    const result = run(env, { fileLimit: 1024 });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${cfg} is larger than 1 MiB: it stays as it is.\n`);
    expect(fs.statSync(cfg).size).toBe(2 ** 40);
  });

  // Review round 1 of the follow-up of plan step 11I (A, a test that was missing): a folder at credentials.gitconfig is
  // removed with GNU rm (through the folder that the script opened), which follows no link inside it either.
  it('removes a folder at credentials.gitconfig without following the links in it to a folder and a file outside', () => {
    const env = setup();
    const out = outside(env);
    const dir = path.join(env.ws, '.devenv+');
    const folder = path.join(dir, 'credentials.gitconfig');
    fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
    fs.symlinkSync(out.folder, path.join(folder, 'out'));
    fs.symlinkSync(out.folder, path.join(folder, 'sub', 'out'));
    fs.symlinkSync(out.file, path.join(folder, 'file'));
    const before = out.state();
    const result = run(env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(out.state()).toEqual(before);
    expect(out.inodes().filter((inode) => owners(env).has(inode))).toEqual([]);
    expectConfigFolder(env, dir);
    expect(fs.readFileSync(folder, 'utf8')).toBe(GIT_CREDENTIALS_CONFIG_CONTENT.split('/workspaces').join(env.ws));
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

  // Follow-up of PR #121 (review A): the chain of missingInRepository resolved a \`..\` of a link target as text, so a link
  // \`out/../gone\` whose \`out\` leads out of the repository was a missing Dockerfile of the repository; the system resolves
  // the \`..\` after the link of \`out\`, out of the repository.
  it('takes no link whose .. follows a link out of the repository for a missing Dockerfile', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(root, 'outside', 'inner'), { recursive: true });
    const config = '{ "build": { "dockerfile": "Dockerfile" } }';
    const dev = path.join(repo, '.devcontainer');
    write(path.join(dev, 'devcontainer.json'), config);
    fs.symlinkSync(path.join(root, 'outside', 'inner'), path.join(dev, 'out'));
    fs.symlinkSync('out/../gone', path.join(dev, 'Dockerfile'));
    expect(read(repo, '.devcontainer/devcontainer.json')).toEqual({ configText: config, dockerfilePath: '.devcontainer/Dockerfile' });
    // A \`..\` before every name of the target stays a missing Dockerfile of the repository.
    fs.unlinkSync(path.join(dev, 'Dockerfile'));
    fs.symlinkSync('../gone', path.join(dev, 'Dockerfile'));
    expect(read(repo, '.devcontainer/devcontainer.json')).toMatchObject({ dockerfilePath: '.devcontainer/Dockerfile', dockerfileMissing: true });
  });

  it('fails for a configuration path outside of the repository', () => {
    const root = tempDir();
    write(path.join(root, 'devcontainer.json'), '{}');
    const result = runNode(readFilesCommand(path.join(root, 'repo'), '../devcontainer.json'));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
  // Decision of the user of 2026-10-07: the configuration file was read through a link with a check of its path text
  // only, so a repository could name a file of the token (or any file that root reads in the batch helper) as its
  // devcontainer.json. A configuration file that is no plain file of the repository after links fails the script and is
  // never read; one that a link of the repository leads to is read as before.
  it('refuses a configuration file that links out of the repository, and never reads it (decision of 2026-10-07)', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    write(path.join(root, '.devenv+', 'github-token'), 'gho_SECRET_TOKEN');
    write(path.join(repo, 'README.md'), 'x');
    fs.mkdirSync(path.join(repo, '.devcontainer'), { recursive: true });
    for (const target of ['../../.devenv+/github-token', path.join(root, '.devenv+', 'github-token')]) {
      fs.rmSync(path.join(repo, '.devcontainer', 'devcontainer.json'), { force: true });
      fs.symlinkSync(target, path.join(repo, '.devcontainer', 'devcontainer.json'));
      const result = runNode(readFilesCommand(repo, '.devcontainer/devcontainer.json'));
      expect(result.status, target).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('The configuration file is not a file of the repository.');
      expect(`${result.stdout}${result.stderr}`).not.toContain('gho_SECRET_TOKEN');
    }
    // Also through a folder link of the repository that leads out of it.
    fs.rmSync(path.join(repo, '.devcontainer'), { recursive: true, force: true });
    fs.symlinkSync(path.join(root, '.devenv+'), path.join(repo, '.devcontainer'));
    const through = runNode(readFilesCommand(repo, '.devcontainer/github-token'));
    expect(through.status).not.toBe(0);
    expect(`${through.stdout}${through.stderr}`).not.toContain('gho_SECRET_TOKEN');
  });

  it('reads a configuration file that a link of the repository leads to (decision of 2026-10-07)', () => {
    const repo = tempDir();
    write(path.join(repo, 'config', 'real.json'), '{ "image": "alpine" }');
    fs.mkdirSync(path.join(repo, '.devcontainer'), { recursive: true });
    fs.symlinkSync('../config/real.json', path.join(repo, '.devcontainer', 'devcontainer.json'));
    expect(read(repo, '.devcontainer/devcontainer.json')).toEqual({ configText: '{ "image": "alpine" }' });
    // A link that leads nowhere is a configuration that does not exist, as before.
    fs.symlinkSync('../config/gone.json', path.join(repo, '.devcontainer', 'gone.json'));
    expect(read(repo, '.devcontainer/gone.json')).toBeNull();
  });

  // Review round 1 of PR #121 (A): the realpathSync of JavaScript resolves a `..` of a link target as text, the kernel
  // physically: a link `../sub/../target.txt` whose `sub` leads out of the repository names a file of the repository for
  // it (a decoy) and a file out of it for the open. Before this PR, its Dockerfile text was read; neither is read now.
  it('reads no file through a link whose .. leads out of the repository after a folder link (review round 1 of PR #121, A)', () => {
    const root = tempDir();
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(root, 'out', 'inner'), { recursive: true });
    write(path.join(root, 'out', 'target.txt'), '{ "image": "OUTSIDE_SECRET" }');
    write(path.join(repo, 'target.txt'), '{ "image": "decoy" }');
    fs.symlinkSync(path.join(root, 'out', 'inner'), path.join(repo, 'sub'));
    fs.mkdirSync(path.join(repo, 'a'), { recursive: true });
    fs.symlinkSync('../sub/../target.txt', path.join(repo, 'a', 'devcontainer.json'));
    // The setup holds: the open reaches the file out of the repository.
    expect(fs.readFileSync(path.join(repo, 'a', 'devcontainer.json'), 'utf8')).toContain('OUTSIDE_SECRET');
    const config = runNode(readFilesCommand(repo, 'a/devcontainer.json'));
    expect(config.status).not.toBe(0);
    expect(config.stderr).toContain('The configuration file is not a file of the repository.');
    expect(`${config.stdout}${config.stderr}`).not.toContain('OUTSIDE_SECRET');
    write(path.join(repo, 'b', 'devcontainer.json'), '{ "build": { "dockerfile": "Dockerfile" } }');
    fs.symlinkSync('../sub/../target.txt', path.join(repo, 'b', 'Dockerfile'));
    expect(read(repo, 'b/devcontainer.json')).toEqual({ configText: '{ "build": { "dockerfile": "Dockerfile" } }', dockerfilePath: 'b/Dockerfile' });
  });

  // Review round 1 of PR #121 (A-1): a Dockerfile that links to standard input (a file of the system that the first version
  // of the PR opened, and failed on in the batch helper, whose input is a socket) is not read, and the script ends well.
  it('reads no Dockerfile that links to standard input (review round 1 of PR #121, A-1)', () => {
    const repo = tempDir();
    write(path.join(repo, 'b', 'devcontainer.json'), '{ "build": { "dockerfile": "Dockerfile" } }');
    fs.symlinkSync('/dev/stdin', path.join(repo, 'b', 'Dockerfile'));
    const result = spawnSync(process.execPath, readFilesCommand(repo, 'b/devcontainer.json').slice(1), { encoding: 'utf8', input: 'FROM stdin\n', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ configText: '{ "build": { "dockerfile": "Dockerfile" } }', dockerfilePath: 'b/Dockerfile' });
  });

  it('never waits on a FIFO of the repository, as the configuration or as its Dockerfile (decision of 2026-10-07)', () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, 'a'), { recursive: true });
    expect(spawnSync('mkfifo', [path.join(repo, 'a', 'devcontainer.json')]).status).toBe(0);
    const started = Date.now();
    const fifoConfig = spawnSync(process.execPath, readFilesCommand(repo, 'a/devcontainer.json').slice(1), { encoding: 'utf8', timeout: 10_000 });
    expect(fifoConfig.error).toBeUndefined();
    expect(fifoConfig.status).not.toBe(0);
    expect(fifoConfig.stderr).toContain('The configuration file is not a file of the repository.');
    write(path.join(repo, 'b', 'devcontainer.json'), '{ "build": { "dockerfile": "Dockerfile" } }');
    expect(spawnSync('mkfifo', [path.join(repo, 'b', 'Dockerfile')]).status).toBe(0);
    const fifoDockerfile = spawnSync(process.execPath, readFilesCommand(repo, 'b/devcontainer.json').slice(1), { encoding: 'utf8', timeout: 10_000 });
    expect(fifoDockerfile.error).toBeUndefined();
    expect(fifoDockerfile.status).toBe(0);
    // Not read, and not missing: the extension refuses the Dockerfile (dockerfileUnreadable), as for a link out.
    expect(JSON.parse(fifoDockerfile.stdout)).toEqual({ configText: '{ "build": { "dockerfile": "Dockerfile" } }', dockerfilePath: 'b/Dockerfile' });
    expect(Date.now() - started).toBeLessThan(10_000);
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
      name: PROJECT,
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
    const model = { name: PROJECT, services: { db: { image: 'postgres:16', volumes: [bind(`${repo}/data/pg/16`), bind(`${repo}/plain/x/`), bind(`${repo}/data`)] } } };
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

  // Follow-up of PR #121 (review A): the realpathSync of JavaScript resolved a \`..\` of a link target as text. The link
  // \`via\` -> \`out/..\` named the repository folder for it, while the system reaches the folder out of the repository
  // that holds the target of \`out\`.
  it('COMPOSE_MODEL_SCRIPT and CREATE_FOLDERS_SCRIPT resolve a .. of a link target as the system does', () => {
    const dir = tempDir();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(dir, 'outside', 'inner'), { recursive: true });
    write(path.join(dir, 'outside', 'Dockerfile'), 'FROM secret\n');
    write(path.join(repo, 'Dockerfile'), 'FROM decoy\n');
    fs.symlinkSync(path.join(dir, 'outside', 'inner'), path.join(repo, 'out'));
    fs.symlinkSync('out/..', path.join(repo, 'via'));
    fs.symlinkSync('out/../nothing', path.join(repo, 'gone'));
    const outside = fs.realpathSync.native(path.join(dir, 'outside'));
    const bind = (source: string) => ({ type: 'bind', source, target: `/t${source.length}` });
    const model = {
      name: PROJECT,
      services: {
        app: { build: { context: `${repo}/via`, dockerfile: 'Dockerfile' }, volumes: [bind(`${repo}/via`), bind(`${repo}/via/new`)] },
        tool: { build: { context: `${repo}/gone` } },
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
    const result = spawnSync(process.execPath, composeModelCommand(repo, [path.join(repo, 'compose.yml')]).slice(1), { encoding: 'utf8', env });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as {
      realPaths: Record<string, string | null>;
      mountAncestors: Record<string, string | null>;
      mountCreateTargets: Record<string, string>;
      missing: string[];
      dockerfileFiles: Record<string, string>;
      dockerfileTexts: Record<string, string>;
    };
    expect(output.realPaths[`${repo}/via`]).toBe(outside);
    expect(output.realPaths[`${repo}/via/Dockerfile`]).toBe(path.join(outside, 'Dockerfile'));
    expect(output.mountAncestors[`${repo}/via/new`]).toBe(outside);
    expect(output.mountCreateTargets[`${repo}/via/new`]).toBe(path.join(outside, 'new'));
    // A Dockerfile out of the repository through a link is not read (neither the decoy nor the file out of it), and a
    // link whose .. follows a link out of the repository is no missing path of the repository.
    expect(output.dockerfileFiles).toEqual({});
    expect(JSON.stringify(output.dockerfileTexts)).not.toMatch(/secret|decoy/);
    expect(output.missing).toEqual([]);
    const created = runNode(createFoldersCommand(repo, [`${repo}/via/new`]));
    expect(created.status).toBe(2);
    expect(created.stderr).toContain('leads out of the repository');
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
  });
});

// Follow-up of plan step 11I (the links of the owner): CREATE_FOLDERS_SCRIPT runs as root when root owns the repository,
// and root of the dev container can replace a folder of the repository by a link between a check and a use. A module
// that Node loads before the script (`--require`) plays it once: right after the script resolved the real path of
// DEVENV_TEST_RACE_REAL (its last check of the nearest folder), or right before it creates a folder named
// DEVENV_TEST_RACE_MKDIR, or right before it changes into a folder named DEVENV_TEST_RACE_CHDIR, the folder
// DEVENV_TEST_RACE_SWAP is renamed away and a link to DEVENV_TEST_RACE_TARGET takes its place. The script never creates a
// folder out of the repository.
describe('CREATE_FOLDERS_SCRIPT and the links of the owner (follow-up of plan step 11I)', () => {
  function setup(): { dir: string; repo: string; outside: string; preload: string } {
    const dir = fs.realpathSync.native(tempDir());
    const repo = path.join(dir, 'repo');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
    fs.mkdirSync(outside);
    const preload = path.join(dir, 'race.js');
    write(
      preload,
      [
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        'const { DEVENV_TEST_RACE_REAL: real, DEVENV_TEST_RACE_MKDIR: made, DEVENV_TEST_RACE_CHDIR: entered, DEVENV_TEST_RACE_SWAP: swap, DEVENV_TEST_RACE_TARGET: target } = process.env;',
        'let done = false;',
        'const act = () => {',
        '  if (done) return;',
        '  done = true;',
        "  fs.renameSync(swap, swap + '.moved');",
        '  fs.symlinkSync(target, swap);',
        '};',
        'const realpath = fs.realpathSync.native;',
        'fs.realpathSync.native = (file, ...rest) => {',
        '  const result = realpath(file, ...rest);',
        '  if (file === real) act();',
        '  return result;',
        '};',
        'const mkdirSync = fs.mkdirSync;',
        'fs.mkdirSync = (file, ...rest) => {',
        '  if (made !== undefined && path.basename(String(file)) === made) act();',
        '  return mkdirSync.call(fs, file, ...rest);',
        '};',
        'const chdir = process.chdir;',
        'process.chdir = (folder) => {',
        '  if (entered !== undefined && path.basename(String(folder)) === entered) act();',
        '  return chdir.call(process, folder);',
        '};',
        '',
      ].join('\n'),
    );
    return { dir, repo, outside, preload };
  }

  function run(preload: string, repo: string, folders: string[], env: Record<string, string>) {
    const command = createFoldersCommand(repo, folders);
    const result = spawnSync(process.execPath, ['--require', preload, ...command.slice(1)], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env } });
    expect(result.error).toBeUndefined();
    return result;
  }

  it('creates nothing out of the repository when its nearest folder is replaced by a link after the checks', () => {
    const { repo, outside, preload } = setup();
    const result = run(preload, repo, [`${repo}/data/new/sub`], {
      DEVENV_TEST_RACE_REAL: `${repo}/data`,
      DEVENV_TEST_RACE_SWAP: `${repo}/data`,
      DEVENV_TEST_RACE_TARGET: outside,
    });
    expect(fs.lstatSync(`${repo}/data`).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${repo}/data is no folder of the repository.`);
  });

  it('creates each part in the folder that it made before, also when that folder is replaced by a link', () => {
    const { repo, outside, preload } = setup();
    const result = run(preload, repo, [`${repo}/data/new/sub`], {
      DEVENV_TEST_RACE_MKDIR: 'sub',
      DEVENV_TEST_RACE_SWAP: `${repo}/data/new`,
      DEVENV_TEST_RACE_TARGET: outside,
    });
    expect(fs.lstatSync(`${repo}/data/new`).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    // `sub` is in the folder `new` that the script made (the owner moved it to new.moved).
    expect(fs.lstatSync(`${repo}/data/new.moved/sub`).isDirectory()).toBe(true);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  // Review round 1 of the follow-up (A-F3): the check is the lstat of the folder now (was: its open for reading).
  it('stops when a folder is replaced by a link between its check and the change into it (the folder entered must be the folder checked)', () => {
    const { repo, outside, preload } = setup();
    const result = run(preload, repo, [`${repo}/data/new`], {
      DEVENV_TEST_RACE_CHDIR: 'data',
      DEVENV_TEST_RACE_SWAP: `${repo}/data`,
      DEVENV_TEST_RACE_TARGET: outside,
    });
    expect(fs.lstatSync(`${repo}/data`).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${repo}/data is no folder of the repository.`);
  });

  // Review round 1 of the follow-up of plan step 11I (A-F3): `enter` opened each folder for reading (O_RDONLY), so a folder
  // that the owner may enter but not read (0311 here; 0711 of another user in the review) stopped the step ("… is no
  // folder of the repository."), and the Compose open failed each time; the shell script before it needed only the
  // search permission. The step runs as the owner of the repository: as root, the script runs without the capabilities
  // that bypass the permissions (as the batch helper runs a step of a user), so that the modes count.
  const createPermissions = process.getuid?.() !== 0 ? [] : spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).error === undefined ? ['setpriv', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--'] : undefined;
  it.skipIf(createPermissions === undefined || process.platform === 'win32')('creates folders below folders that it may enter but not read, the repository folder too', () => {
    const { repo } = setup();
    const data = path.join(repo, 'data');
    const prefixed = (command: string[]) => {
      const [file, ...args] = [...(createPermissions ?? []), process.execPath, ...command.slice(1)];
      return spawnSync(file, args, { encoding: 'utf8', timeout: 20_000 });
    };
    fs.chmodSync(data, 0o311);
    fs.chmodSync(repo, 0o311);
    try {
      // The setup holds: the folders cannot be opened for reading.
      const probe = prefixed(['node', '-e', "for (const folder of process.argv.slice(1)) { try { require('fs').openSync(folder, 'r'); process.stdout.write('read '); } catch (error) { process.stdout.write(error.code + ' '); } }", repo, data]);
      expect(probe.stdout).toBe('EACCES EACCES ');
      const result = prefixed(createFoldersCommand(repo, [`${data}/new/sub`, `${repo}/top`]));
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      fs.chmodSync(repo, 0o755);
      fs.chmodSync(data, 0o755);
    }
    expect(fs.lstatSync(`${data}/new/sub`).isDirectory()).toBe(true);
    expect(fs.lstatSync(`${repo}/top`).isDirectory()).toBe(true);
  });

  it('refuses a link in place of the repository folder, and creates nothing where it leads', () => {
    const { dir, outside } = setup();
    const link = path.join(dir, 'linked-repo');
    fs.symlinkSync(outside, link);
    const result = runNode(createFoldersCommand(link, [`${link}/x`]));
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(result.status).toBe(2);
    // Review round 1 of the follow-up (A-F3): the whole message, with the code that the open of the folder gave for a link
    // before (ENOTDIR), which the check by lstat keeps.
    expect(result.stderr).toBe(`The repository folder ${link} is no folder of its own (ENOTDIR).\n`);
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
      const result = spawnSync('node', ['-e', COMPOSE_HASH_SCRIPT, file, PROJECT], {
        input: '{"services":{}}',
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`args: compose --project-name ${PROJECT} --profile * -f ${file} config --hash *`);
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
