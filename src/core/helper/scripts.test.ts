import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectConfigurations } from '../discovery/detect';
import {
  BUILD_SCRIPT,
  CLONE_SCRIPT,
  CREDENTIAL_HELPER,
  GIT_SUMMARY_SCRIPT,
  LIST_CONFIGS_SCRIPT,
  OVERRIDE_CONFIG_PATH,
  READ_FILES_SCRIPT,
  SECRETS_FOLDER,
  SWITCH_BRANCH_SCRIPT,
  TOKEN_FILE,
  UP_SCRIPT,
  buildCommand,
  cloneCommand,
  listConfigsCommand,
  readFilesCommand,
  switchBranchCommand,
  upCommand,
} from './scripts';

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

  it('fails for a configuration path outside of the repository', () => {
    const root = tempDir();
    write(path.join(root, 'devcontainer.json'), '{}');
    const result = runNode(readFilesCommand(path.join(root, 'repo'), '../devcontainer.json'));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});
