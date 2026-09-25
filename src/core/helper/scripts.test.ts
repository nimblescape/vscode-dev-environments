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
  CREDENTIAL_HELPER,
  GIT_FILES_SCRIPT,
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
  gitFilesCommand,
  listConfigsCommand,
  readFilesCommand,
  switchBranchCommand,
  upCommand,
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
    expect(gitFilesCommand('api', { name: 'Me', email: 'me@x' }, 'helper')).toEqual([
      'sh',
      '-c',
      GIT_FILES_SCRIPT,
      'sh',
      'api',
      'Me',
      'me@x',
      'helper',
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

  function run(env: { ws: string; secrets: string; bin: string }, token = TOKEN, folder = 'api') {
    const script = GIT_FILES_SCRIPT.split(SECRETS_FOLDER).join(env.secrets).split('/workspaces').join(env.ws);
    const command = gitFilesCommand(folder, { name: 'Hannes Stauss', email: '1001+scalarion@users.noreply.github.com' }, CONTAINER_CREDENTIAL_HELPER);
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

  it('writes the token (0600), the Git configuration, and the Docker and GPG folders, owned by the repository owner', () => {
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
    for (const folder of ['docker', 'gnupg', 'gnupg/private-keys-v1.d']) {
      expect(fs.statSync(path.join(dir, folder)).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(path.join(dir, 'gnupg', 'private-keys-v1.d'))).toEqual(['README-devenv']);
    const chowned = fs.readFileSync(env.log, 'utf8');
    expect(chowned).toContain(`chown 1000:1001 ${path.join(dir, '.work.')}`);
    expect(chowned).toContain(`chown -h 1000:1001 ${dir} ${dir}/docker ${dir}/gnupg ${dir}/gnupg/private-keys-v1.d`);
    expect(chowned).toContain(cfg);
    // The token is gone from the tmpfs, and no temporary folder is left.
    expect(fs.readdirSync(env.secrets)).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(['credentials.gitconfig', 'docker', 'gitconfig', 'github-token', 'gnupg']);
    // The file for the credential helpers of the user: only comments, readable by every user of the container.
    const credentials = path.join(dir, 'credentials.gitconfig');
    expect(fs.readFileSync(credentials, 'utf8')).toBe(GIT_CREDENTIALS_CONFIG_CONTENT.split('/workspaces').join(env.ws));
    expect(fs.statSync(credentials).mode & 0o777).toBe(0o644);
    expect(spawnSync('git', ['config', '--file', credentials, '--list'], { encoding: 'utf8' })).toMatchObject({ status: 0, stdout: '' });
    expect(chowned).toContain(`${cfg} ${credentials}`);
    // The token is only in the token file.
    expect(spawnSync('grep', ['-rl', TOKEN, env.ws], { encoding: 'utf8' }).stdout.trim()).toBe(tokenFile);
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
