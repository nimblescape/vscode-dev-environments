// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FOLDER, GIT_CONFIG_FILE } from '../names';
import {
  CONTAINER_CREDENTIAL_HELPER,
  GIT_CREDENTIALS_CONFIG_FILE,
  HOME_GIT_CONFIG_CONTENT,
  HOME_GIT_CONFIG_SCRIPT,
  containerEnvironment,
  containerGitSupport,
  gitIdentity,
  homeGitConfigCommand,
  isContainerGitVariable,
  isGitHubCliAccountVariable,
  GITHUB_CLI_ACCOUNT_VARIABLES,
  isGitHubLogin,
  parseGitVersion,
  remoteEnvironment,
} from './containerGit';
import { hostAccessProblems } from './hostAccess';

const hasGit = !spawnSync('git', ['--version'], { stdio: 'ignore' }).error;
/** Optional: the path of an old Git (for example 2.30.2) that the credential tests run with too. */
const OLD_GIT = process.env.DEVENV_TEST_OLD_GIT;

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The environment of this process without Git variables (a test may run inside a Git hook). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value;
  return env;
}

/** A Git config value in double quotes, as `git config` writes it. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

describe('environment of the dev container (concept section 9 "Git inside the container")', () => {
  it('points Git and Docker to the configuration folder in the volume, and never holds the token', () => {
    const env = containerEnvironment();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/workspaces/.devenv+/gitconfig');
    expect(env.DOCKER_CONFIG).toBe('/workspaces/.devenv+/docker');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o IdentityAgent=none');
    // The GitHub CLI reads its sign-in (hosts.yml of the owner account) from the volume, not from ~/.config/gh.
    expect(env.GH_CONFIG_DIR).toBe('/workspaces/.devenv+/gh');
    expect(Object.keys(env).some((name) => /TOKEN/.test(name))).toBe(false);
    expect(remoteEnvironment()).toEqual(env);
  });

  it('sets only documented variables of Git, Docker, and the GitHub CLI, never one of the Dev Containers extension or the VS Code server', () => {
    const documented = /^(GIT_CONFIG_GLOBAL|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_SSH_COMMAND|DOCKER_CONFIG|GH_CONFIG_DIR)$/;
    for (const env of [containerEnvironment(), remoteEnvironment()]) {
      for (const name of Object.keys(env)) expect(name).toMatch(documented);
      // User decision (2026-09-25): these keep the values of their owners, so the browser, the agents, and the
      // channels of the Dev Containers extension work as the Dev Containers extension and VS Code expect.
      for (const name of ['SSH_AUTH_SOCK', 'REMOTE_CONTAINERS_IPC', 'REMOTE_CONTAINERS', 'BROWSER', 'VSCODE_IPC_HOOK_CLI', 'GIT_CONFIG_PARAMETERS', 'GNUPGHOME', 'GH_TOKEN', 'GITHUB_TOKEN']) {
        expect(env).not.toHaveProperty(name);
      }
    }
  });

  it('removes every credential helper, includes the helpers of the user, and then sets the helper for GitHub', () => {
    const env = containerEnvironment();
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'include.path',
      GIT_CONFIG_VALUE_1: '/workspaces/.devenv+/credentials.gitconfig',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2: '',
      GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_3: CONTAINER_CREDENTIAL_HELPER,
    });
    expect(GIT_CREDENTIALS_CONFIG_FILE).toBe('/workspaces/.devenv+/credentials.gitconfig');
    // The Dev Container CLI and the Dev Containers extension substitute `${…}`.
    for (const value of Object.values(env)) expect(value).not.toContain('${');
  });

  it('builds the identity of the owner account like GitHub does for commits in the browser', () => {
    expect(gitIdentity({ databaseId: 1001, login: 'scalarion', name: 'Hannes Stauss' })).toEqual({
      name: 'Hannes Stauss',
      email: '1001+scalarion@users.noreply.github.com',
    });
    expect(gitIdentity({ databaseId: '2002', login: 'staussh', name: '  ' })).toEqual({
      name: 'staussh',
      email: '2002+staussh@users.noreply.github.com',
    });
    expect(gitIdentity({ databaseId: 3, login: 'x', name: null }).name).toBe('x');
  });
});

describe('variables of container-only Git, which a configuration may not set (concept section 9 "Host access")', () => {
  it.each<[string, boolean, boolean]>([
    ['GIT_CONFIG_GLOBAL', true, true],
    ['GIT_CONFIG_PARAMETERS', true, true],
    ['GIT_CONFIG_COUNT', true, true],
    ['GIT_CONFIG_KEY_0', true, true],
    ['GIT_CONFIG_VALUE_3', true, true],
    ['GIT_CONFIG_KEY_4', true, true],
    ['GIT_CONFIG_SYSTEM', true, true],
    ['GIT_CONFIG_NOSYSTEM', true, true],
    ['GIT_CONFIG', true, true],
    ['GIT_CONFIG_PARAMETERS', true, true],
    ['DOCKER_CONFIG', true, true],
    ['GIT_SSH_COMMAND', true, true],
    ['GH_CONFIG_DIR', true, true],
    ['gh_config_dir', true, true],
    [' GH_CONFIG_DIR', true, true],
    ['git_config_global', true, true],
    [' GIT_SSH_COMMAND ', true, true],
    // Variables of the Dev Containers extension, the VS Code server, and GnuPG: the extension does not set them.
    ['SSH_AUTH_SOCK', false, false],
    ['REMOTE_CONTAINERS_IPC', false, false],
    ['GNUPGHOME', false, false],
    ['GIT_CONFIGURATION', false, false],
    ['GIT_AUTHOR_NAME', false, false],
    ['GIT_SSH', false, false],
    ['SSH_AUTH_SOCKET', false, false],
    ['DOCKER_HOST', false, false],
    ['BROWSER', false, false],
    // Deliberate behavior change (user decision 2026-09-26, "nothing else decides who is logged into github"): the
    // variables of the account of the GitHub CLI were allowed before; they are no variables of container-only Git, but
    // the host access policy refuses them (isGitHubCliAccountVariable).
    ['GITHUB_TOKEN', false, true],
    ['GH_CONFIG', false, false],
    ['GH_HOST', false, true],
    ['', false, false],
  ])('%j: container-only Git %s, refused by the policy %s', (name, expected, refused) => {
    expect(isContainerGitVariable(name)).toBe(expected);
    expect(hostAccessProblems({ config: { containerEnv: { [name]: 'x' } }, ownVolume: 'devenv-acme-api-3f2a9c1e' })).toHaveLength(refused ? 1 : 0);
  });

  it('covers every variable that the override configuration sets', () => {
    for (const name of Object.keys({ ...containerEnvironment(), ...remoteEnvironment() })) expect(isContainerGitVariable(name)).toBe(true);
  });
});

describe('variables of the account of the GitHub CLI, which a configuration may not set (user decision 2026-09-26)', () => {
  it.each<[string, boolean]>([
    ['GH_TOKEN', true],
    ['GITHUB_TOKEN', true],
    ['GH_ENTERPRISE_TOKEN', true],
    ['GITHUB_ENTERPRISE_TOKEN', true],
    ['GH_HOST', true],
    ['gh_token', true],
    [' GH_HOST ', true],
    ['GH_CONFIG_DIR', false],
    ['GH_PAGER', false],
    ['GH_NO_UPDATE_NOTIFIER', false],
    ['GITHUB_TOKEN_FILE', false],
    ['GH_TOKENS', false],
    ['', false],
  ])('%j: %s', (name, expected) => {
    expect(isGitHubCliAccountVariable(name)).toBe(expected);
  });

  it('lists exactly the token and host variables of gh', () => {
    expect([...GITHUB_CLI_ACCOUNT_VARIABLES].sort()).toEqual(['GH_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_TOKEN']);
  });

  it('never sets one of them in the container itself', () => {
    for (const name of GITHUB_CLI_ACCOUNT_VARIABLES) {
      expect(Object.keys({ ...containerEnvironment(), ...remoteEnvironment() })).not.toContain(name);
    }
  });
});

describe.skipIf(!hasGit)('settings of the command line level, as Git reads them', () => {
  /** The entries of the command line level, as `git config --list --show-origin -z` names them. */
  function commandLine(env: Record<string, string>): string[] {
    const result = spawnSync('git', ['config', '--list', '--show-origin', '-z'], {
      encoding: 'utf8',
      cwd: tempDir(),
      env: { ...cleanEnv(), HOME: tempDir(), GIT_CONFIG_NOSYSTEM: '1', ...env },
    });
    expect(result.status).toBe(0);
    const fields = result.stdout.split('\0');
    const entries: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i] === 'command line:') entries.push(fields[i + 1].replace('\n', '='));
    }
    return entries;
  }

  const expected = [
    'credential.helper=',
    `include.path=${GIT_CREDENTIALS_CONFIG_FILE}`,
    'credential.https://github.com.helper=',
    `credential.https://github.com.helper=${CONTAINER_CREDENTIAL_HELPER}`,
  ];

  it('reads the entries from GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, and GIT_CONFIG_VALUE_n (Git 2.31 and newer)', () => {
    const count = Object.fromEntries(Object.entries(containerEnvironment()).filter(([name]) => /^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(name)));
    expect(Object.keys(count)).toHaveLength(9);
    expect(commandLine(count)).toEqual(expected);
  });
});

/**
 * How Git in the container runs. `container`: with the variables of the container. `oldGit`: as Git older than 2.31
 * reads them (without GIT_CONFIG_GLOBAL and GIT_CONFIG_COUNT), so only through ~/.gitconfig. `noVariables`: a process
 * without the variables of the container (for example after `sudo` with env_reset, or `su -`), which reads only
 * ~/.gitconfig.
 */
type Mode = 'container' | 'oldGit' | 'noVariables';

const GITS: Array<[string, string]> = [['git', 'git'], ...(OLD_GIT ? [[`old Git ${OLD_GIT}`, OLD_GIT] as [string, string]] : [])];

describe.skipIf(!hasGit).each(GITS)('credentials of Git in the dev container (%s)', (_label, git) => {
  const version = parseGitVersion(spawnSync(git, ['--version'], { encoding: 'utf8' }).stdout ?? '');
  /** Git 2.32 and newer knows GIT_CONFIG_SYSTEM, so the tests can give it a system file. */
  const systemFile = version !== undefined && (version[0] > 2 || version[1] >= 32);

  interface Setup {
    env: NodeJS.ProcessEnv;
    /** The forwarding helper of the Dev Containers extension writes each call here. */
    forwarded: string;
    /** The helper of the user in credentials.gitconfig writes each call here. */
    userLog: string;
  }

  /**
   * A volume folder (CONFIG_FOLDER) and a home folder as the extension prepares them, and the forwarding helper as the
   * Dev Containers extension writes it when its settings of the container do not apply (with them, it writes none):
   * `git config --system --replace-all credential.helper`, and `--global` (its setting
   * gitCredentialHelperConfigLocation), which old Git writes into ~/.gitconfig.
   */
  function setup(options: { mode: Mode; token?: string; userHelper?: 'all' | 'gitlab'; extensionGlobal?: boolean }): Setup {
    const dir = tempDir();
    const volume = path.join(dir, 'devenv+');
    const home = path.join(dir, 'home');
    fs.mkdirSync(volume);
    fs.mkdirSync(home);
    const local = (value: string): string => value.split(CONFIG_FOLDER).join(volume);
    if (options.token !== undefined) fs.writeFileSync(path.join(volume, 'github-token'), options.token, { mode: 0o600 });
    // gitconfig as GIT_FILES_SCRIPT writes it.
    fs.writeFileSync(
      path.join(volume, 'gitconfig'),
      `[user]\n\tname = Owner\n\temail = 1001+owner@users.noreply.github.com\n[credential "https://github.com"]\n\thelper =\n\thelper = ${quoted(local(CONTAINER_CREDENTIAL_HELPER))}\n`,
    );
    const userLog = path.join(dir, 'user.log');
    if (options.userHelper) {
      const helper = `!f() { echo "$1" >> '${userLog}'; echo username=me; echo password=user_secret; }; f`;
      const section = options.userHelper === 'all' ? '[credential]' : '[credential "https://gitlab.corp.example"]';
      fs.writeFileSync(path.join(volume, 'credentials.gitconfig'), `${section}\n\thelper = ${quoted(helper)}\n`);
    }
    fs.writeFileSync(path.join(home, '.gitconfig'), local(HOME_GIT_CONFIG_CONTENT));

    const env: NodeJS.ProcessEnv = { ...cleanEnv(), HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
    if (options.mode !== 'noVariables') {
      for (const [name, value] of Object.entries(containerEnvironment())) {
        if (options.mode === 'oldGit' && /^GIT_CONFIG_(GLOBAL|COUNT|KEY_|VALUE_)/.test(name)) continue;
        env[name] = local(value);
      }
    }
    const system = path.join(dir, 'gitconfig-system');
    fs.writeFileSync(system, '');
    if (systemFile) env.GIT_CONFIG_SYSTEM = system;
    else env.GIT_CONFIG_NOSYSTEM = '1';

    const forwarded = path.join(dir, 'forwarded.log');
    const forwarder = `!f() { echo "$1" >> '${forwarded}'; echo username=mac; echo password=gho_mac; }; f`;
    const locations = [...(systemFile ? ['--system'] : []), ...(options.extensionGlobal ? ['--global'] : [])];
    for (const location of locations) {
      const result = spawnSync(git, ['config', location, '--replace-all', 'credential.helper', forwarder], { env, encoding: 'utf8' });
      expect(result.status).toBe(0);
    }
    return { env, forwarded, userLog };
  }

  function credential(s: Setup, action: 'fill' | 'approve' | 'reject', host: string, protocol = 'https') {
    const input = `protocol=${protocol}\nhost=${host}\n${action === 'fill' ? '' : 'username=x-access-token\npassword=gho_new\n'}\n`;
    const result = spawnSync(git, ['credential', action], { encoding: 'utf8', input, env: s.env });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function forwardedCalls(s: Setup): string {
    return fs.existsSync(s.forwarded) ? fs.readFileSync(s.forwarded, 'utf8') : '';
  }

  const MODES: Array<[Mode, boolean]> = [
    ['container', false],
    ['container', true],
    ['oldGit', false],
    // Such a process has no REMOTE_CONTAINERS_IPC, so the forwarding helper could not reach the computer anyway.
    ['noVariables', false],
  ];

  it.each(MODES)('%s (also --global: %s): the token of the owner for github.com, nothing of the computer', (mode, extensionGlobal) => {
    const s = setup({ mode, token: 'gho_owner\n', extensionGlobal });
    const github = credential(s, 'fill', 'github.com');
    expect(github.status).toBe(0);
    expect(github.stdout).toContain('username=x-access-token\n');
    expect(github.stdout).toContain('password=gho_owner\n');
    const other = credential(s, 'fill', 'gitlab.com');
    expect(other.status).not.toBe(0);
    expect(other.stdout + other.stderr).not.toContain('gho_');
    // No store or erase reaches the computer (it could change the keychain of the computer).
    for (const action of ['approve', 'reject'] as const) {
      expect(credential(s, action, 'github.com').status).toBe(0);
      expect(credential(s, action, 'gitlab.com').status).toBe(0);
    }
    expect(forwardedCalls(s)).toBe('');
    // The identity of the volume, also for Git that ignores GIT_CONFIG_GLOBAL (through the include of ~/.gitconfig).
    expect(spawnSync(git, ['config', 'user.email'], { encoding: 'utf8', env: s.env }).stdout).toBe('1001+owner@users.noreply.github.com\n');
  });

  it('old Git with a forwarding helper in ~/.gitconfig (only when the settings of the container do not apply): github.com gets only the token of the owner', () => {
    // Without GIT_CONFIG_COUNT, nothing removes a helper that `git config --global` writes into ~/.gitconfig of old Git:
    // it answers for other hosts. The settings of the container keep the Dev Containers extension from writing it (V-8).
    const s = setup({ mode: 'oldGit', token: 'gho_owner\n', extensionGlobal: true });
    const github = credential(s, 'fill', 'github.com');
    expect(github.status).toBe(0);
    expect(github.stdout).toContain('password=gho_owner\n');
    expect(credential(s, 'approve', 'github.com').status).toBe(0);
    expect(credential(s, 'reject', 'github.com').status).toBe(0);
    expect(forwardedCalls(s)).toBe('');
    expect(credential(s, 'fill', 'gitlab.com').stdout).toContain('password=gho_mac\n');
    expect(forwardedCalls(s)).toBe('get\n');
  });

  it.each<Mode>(['container', 'oldGit', 'noVariables'])('%s: the helpers of the user in credentials.gitconfig answer for other hosts, never for github.com', (mode) => {
    const s = setup({ mode, token: 'gho_owner\n', userHelper: 'all', extensionGlobal: mode === 'container' });
    const other = credential(s, 'fill', 'gitlab.corp.example');
    expect(other.status).toBe(0);
    expect(other.stdout).toContain('password=user_secret\n');
    expect(fs.readFileSync(s.userLog, 'utf8')).toBe('get\n');
    // github.com: only the token of the owner; the helper of the user gets no get, store, or erase of it.
    expect(credential(s, 'fill', 'github.com').stdout).toContain('password=gho_owner\n');
    expect(credential(s, 'approve', 'github.com').status).toBe(0);
    expect(credential(s, 'reject', 'github.com').status).toBe(0);
    expect(fs.readFileSync(s.userLog, 'utf8')).toBe('get\n');
    expect(forwardedCalls(s)).toBe('');
  });

  it('uses a helper of the user that is set for one host only for that host', () => {
    const s = setup({ mode: 'container', token: 'gho_owner\n', userHelper: 'gitlab' });
    expect(credential(s, 'fill', 'gitlab.corp.example').stdout).toContain('password=user_secret\n');
    expect(credential(s, 'fill', 'example.com').status).not.toBe(0);
    expect(fs.readFileSync(s.userLog, 'utf8')).toBe('get\n');
  });

  it.each([
    ['another host', 'example.com', 'https'],
    ['http', 'github.com', 'http'],
    ['a host that only starts with github.com', 'github.com.example.org', 'https'],
  ])('never gives the token to %s', (_name, host, protocol) => {
    const s = setup({ mode: 'container', token: 'gho_owner\n' });
    const result = credential(s, 'fill', host, protocol);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('gho_owner');
  });

  it('gives no empty password when the token file is missing', () => {
    const s = setup({ mode: 'container' });
    const result = credential(s, 'fill', 'github.com');
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('password=');
    expect(forwardedCalls(s)).toBe('');
  });
});

describe('HOME_GIT_CONFIG_SCRIPT', () => {
  /** Runs the script with a passwd file and fake `id` and `chown` (the real ones need root and Linux). */
  function run(user: string, prepare: (home: string) => void = () => undefined) {
    const dir = tempDir();
    const home = path.join(dir, 'home', 'node');
    fs.mkdirSync(home, { recursive: true });
    prepare(home);
    const passwd = path.join(dir, 'passwd');
    fs.writeFileSync(passwd, `root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::${home}:/bin/sh\n`);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'log');
    fs.writeFileSync(path.join(bin, 'id'), `#!/bin/sh\n[ "$2" = node ] || exit 1\ncase "$1" in -u) echo 1000 ;; -g) echo 1001 ;; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'chown'), `#!/bin/sh\necho "chown $*" >> '${log}'\n`, { mode: 0o755 });
    const [shell, flag, script, ...args] = homeGitConfigCommand(user);
    const result = spawnSync(shell, [flag, script.split('/etc/passwd').join(passwd), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    return { ...result, home, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  }

  const gitconfig = (home: string): string => path.join(home, '.gitconfig');

  it('writes ~/.gitconfig with an include of the configuration of the volume, owned by the user, and nothing else', () => {
    const result = run('node');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(gitconfig(result.home), 'utf8')).toBe(HOME_GIT_CONFIG_CONTENT);
    expect(HOME_GIT_CONFIG_CONTENT).toBe(
      '# Dev Environments: the Git configuration of this container is in /workspaces/.devenv+.\n' +
        '# Git reads it through this file when it is older than version 2.32 or runs without the variables of the container.\n' +
        '[credential]\n\thelper =\n[include]\n\tpath = /workspaces/.devenv+/credentials.gitconfig\n\tpath = /workspaces/.devenv+/gitconfig\n',
    );
    expect(result.log).toBe(`chown 1000:1001 ${gitconfig(result.home)}\n`);
    // No other file of the home folder (for example no ~/.config/git/config).
    expect(fs.readdirSync(result.home)).toEqual(['.gitconfig']);
  });

  it.skipIf(!hasGit)('writes a file that Git reads', () => {
    const file = gitconfig(run('node').home);
    const get = (...args: string[]) => spawnSync('git', ['config', '--file', file, ...args], { encoding: 'utf8' });
    expect(get('--get-all', 'include.path').stdout).toBe(`${GIT_CREDENTIALS_CONFIG_FILE}\n${GIT_CONFIG_FILE}\n`);
    expect(get('--get-all', 'credential.helper').stdout).toBe('\n');
  });

  it('writes its content into an empty file of the image, which keeps its owner', () => {
    const result = run('node', (home) => fs.writeFileSync(gitconfig(home), ''));
    expect(result.status).toBe(0);
    expect(fs.readFileSync(gitconfig(result.home), 'utf8')).toBe(HOME_GIT_CONFIG_CONTENT);
    expect(result.log).toBe('');
  });

  it.each([
    ['only safe.directory', '[safe]\n\tdirectory = *\n'],
    ['a filter without a line break at the end', '[filter "lfs"]\n\tclean = git-lfs clean -- %f'],
    ['a user', '[user]\n\tname = Me\n'],
    ['only a comment', '# settings of the image\n'],
  ])('keeps a file of the image with content: %s', (_name, content) => {
    const result = run('node', (home) => fs.writeFileSync(gitconfig(home), content));
    expect(result.status).toBe(0);
    expect(fs.readFileSync(gitconfig(result.home), 'utf8')).toBe(content);
    expect(result.log).toBe('');
  });

  it('keeps a link', () => {
    const linked = run('node', (home) => fs.symlinkSync('/nonexistent', gitconfig(home)));
    expect(linked.status).toBe(0);
    expect(fs.lstatSync(gitconfig(linked.home)).isSymbolicLink()).toBe(true);
    expect(linked.log).toBe('');
  });

  it('does nothing for a user without a home folder', () => {
    const result = run('nobody-here');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('has no home folder');
  });

  it('has valid sh syntax', () => {
    expect(spawnSync('sh', ['-n', '-c', HOME_GIT_CONFIG_SCRIPT], { encoding: 'utf8' }).status).toBe(0);
  });
});

describe('Git version of the container', () => {
  it.each<[string, [number, number, number] | undefined, ReturnType<typeof containerGitSupport>]>([
    ['git version 2.39.5', [2, 39, 5], 'full'],
    ['git version 2.39.3 (Apple Git-146)', [2, 39, 3], 'full'],
    ['git version 2.32.0', [2, 32, 0], 'full'],
    ['git version 2.45.1.windows.1\n', [2, 45, 1], 'full'],
    ['git version 3.0', [3, 0, 0], 'full'],
    ['git version 2.31.0', [2, 31, 0], 'noGlobalVariable'],
    ['git version 2.30.2', [2, 30, 2], 'noGlobalVariable'],
    ['git version 2.25.1', [2, 25, 1], 'noGlobalVariable'],
    ['git version 2.9.0', [2, 9, 0], 'noGlobalVariable'],
    ['git version 2.7.4', [2, 7, 4], 'unsafe'],
    ['git version 1.8.3.1', [1, 8, 3], 'unsafe'],
    ['', undefined, undefined],
    ['sh: git: not found', undefined, undefined],
  ])('%j', (output, version, support) => {
    expect(parseGitVersion(output)).toEqual(version);
    expect(containerGitSupport(output)).toBe(support);
  });
});

describe('GitHub login of the sign-in of the GitHub CLI (hosts.yml)', () => {
  it.each<[string, boolean]>([
    ['scalarion', true],
    ['octo-cat', true],
    ['a', true],
    ['1234', true],
    ['null', true],
    ['old--login', true],
    ['old-login-', true],
    ['x'.repeat(39), true],
    ['x'.repeat(40), false],
    ['', false],
    ['-octo', false],
    // Enterprise Managed Users have logins `<handle>_<shortcode>`; an earlier expectation (false) had the rule wrong.
    ['octo_cat', true],
    ['dev_acme', true],
    ['_x', false],
    ['octo cat', false],
    ['octo"cat', false],
    ['octo:cat', false],
    ['octo\ncat', false],
    ['${localEnv:USER}', false],
  ])('%j: %s', (login, expected) => {
    expect(isGitHubLogin(login)).toBe(expected);
  });
});
