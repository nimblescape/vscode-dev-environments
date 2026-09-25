import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FOLDER, GIT_CONFIG_FILE } from '../names';
import {
  CONTAINER_CREDENTIAL_HELPER,
  DEV_CONTAINERS_GITCONFIG_CHECK,
  GIT_CREDENTIALS_CONFIG_FILE,
  HOME_GIT_CONFIG_CONTENT,
  HOME_GIT_CONFIG_SCRIPT,
  containerEnvironment,
  containerGitSupport,
  gitIdentity,
  homeGitConfigCommand,
  parseGitVersion,
  remoteEnvironment,
} from './containerGit';

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
  it('points Git, Docker, and GPG to the configuration folder in the volume, and never holds the token', () => {
    const env = containerEnvironment();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/workspaces/.devenv+/gitconfig');
    expect(env.DOCKER_CONFIG).toBe('/workspaces/.devenv+/docker');
    expect(env.GNUPGHOME).toBe('/workspaces/.devenv+/gnupg');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o IdentityAgent=none');
    expect(Object.keys(env).some((name) => /TOKEN/.test(name))).toBe(false);
    expect(remoteEnvironment()).toEqual({ ...env, SSH_AUTH_SOCK: '' });
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
    // The same settings for Git older than 2.31, in the format of `git -c` (sq_quote: `'` and `!` outside the quotes).
    const helper = CONTAINER_CREDENTIAL_HELPER.replace(/'/g, "'\\''").replace(/!/g, "'\\!'");
    expect(env.GIT_CONFIG_PARAMETERS).toBe(
      "'credential.helper=' 'include.path=/workspaces/.devenv+/credentials.gitconfig' " +
        `'credential.https://github.com.helper=' 'credential.https://github.com.helper=${helper}'`,
    );
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

  it('reads the same entries from GIT_CONFIG_PARAMETERS (every Git version) and from GIT_CONFIG_COUNT (Git 2.31)', () => {
    const { GIT_CONFIG_PARAMETERS, ...env } = containerEnvironment();
    const count = Object.fromEntries(Object.entries(env).filter(([name]) => /^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(name)));
    expect(commandLine({ GIT_CONFIG_PARAMETERS })).toEqual(expected);
    expect(commandLine(count)).toEqual(expected);
    // Git 2.31 and newer reads both: each list sets the helpers anew, so the result is the same.
    expect(commandLine({ GIT_CONFIG_PARAMETERS, ...count })).toEqual([...expected, ...expected]);
  });
});

/**
 * How Git in the container runs. `container`: with the variables of the container. `oldGit`: as Git older than 2.31
 * reads them (without GIT_CONFIG_GLOBAL and GIT_CONFIG_COUNT). `noVariables`: a process without the variables of the
 * container (for example after `sudo` with env_reset, or `su -`), which reads only ~/.gitconfig.
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
   * Dev Containers extension writes it: `git config --system --replace-all credential.helper` (the default), and
   * `--global` (its setting gitCredentialHelperConfigLocation), which old Git writes into ~/.gitconfig.
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
    ['oldGit', true],
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

  it.each<Mode>(['container', 'oldGit', 'noVariables'])('%s: the helpers of the user in credentials.gitconfig answer for other hosts, never for github.com', (mode) => {
    const s = setup({ mode, token: 'gho_owner\n', userHelper: 'all', extensionGlobal: mode !== 'noVariables' });
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

  /** The check of the Dev Containers extension (DEV_CONTAINERS_GITCONFIG_CHECK) for `home`: whether it copies. */
  function extensionCopies(home: string): boolean {
    const result = spawnSync('sh', ['-c', `${DEV_CONTAINERS_GITCONFIG_CHECK}; exit 0`], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    if (result.status === 1) {
      expect(result.stdout).toContain('exists');
      return false;
    }
    expect(result.status).toBe(0);
    return true;
  }

  const gitconfig = (home: string): string => path.join(home, '.gitconfig');

  it('writes ~/.gitconfig with a section that stops the copy of the Dev Containers extension, and an empty ~/.config/git/config', () => {
    const result = run('node');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(gitconfig(result.home), 'utf8')).toBe(HOME_GIT_CONFIG_CONTENT);
    expect(HOME_GIT_CONFIG_CONTENT).toBe(
      '# Dev Environments: the Git configuration of this container is in /workspaces/.devenv+.\n' +
        '# This file keeps the Dev Containers extension from copying the Git configuration of the computer into the container.\n' +
        '[credential]\n\thelper =\n[include]\n\tpath = /workspaces/.devenv+/credentials.gitconfig\n\tpath = /workspaces/.devenv+/gitconfig\n',
    );
    expect(extensionCopies(result.home)).toBe(false);
    expect(fs.readFileSync(path.join(result.home, '.config', 'git', 'config'), 'utf8')).toBe('');
    // The check of the extension for ~/.config/git/config (function Xte) is only whether the file exists.
    expect(spawnSync('sh', ['-c', `[ -e "$HOME/.config/git/config" ] && exit 1; exit 0`], { env: { ...process.env, HOME: result.home } }).status).toBe(1);
    expect(result.log).toContain(`chown 1000:1001 ${gitconfig(result.home)}`);
    expect(result.log).toContain(`chown 1000:1001 ${path.join(result.home, '.config')}`);
  });

  it.skipIf(!hasGit)('writes a file that Git reads', () => {
    const file = gitconfig(run('node').home);
    const get = (...args: string[]) => spawnSync('git', ['config', '--file', file, ...args], { encoding: 'utf8' });
    expect(get('--get-all', 'include.path').stdout).toBe(`${GIT_CREDENTIALS_CONFIG_FILE}\n${GIT_CONFIG_FILE}\n`);
    expect(get('--get-all', 'credential.helper').stdout).toBe('\n');
  });

  it.each([
    ['an empty file', ''],
    ['only safe.directory', '[safe]\n\tdirectory = *\n'],
    ['only a filter and safe.directory, without a line break at the end', '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n[safe]\n\tdirectory = *'],
  ])('adds its content to a file of the image that would not stop the copy: %s', (_name, content) => {
    let copiedBefore = true;
    const result = run('node', (home) => {
      fs.writeFileSync(gitconfig(home), content);
      copiedBefore = extensionCopies(home);
    });
    expect(copiedBefore).toBe(true);
    expect(result.status).toBe(0);
    const text = fs.readFileSync(gitconfig(result.home), 'utf8');
    expect(text.startsWith(content)).toBe(true);
    expect(text.endsWith(`\n${HOME_GIT_CONFIG_CONTENT}`) || text === HOME_GIT_CONFIG_CONTENT).toBe(true);
    expect(extensionCopies(result.home)).toBe(false);
    // The file keeps its owner.
    expect(result.log).not.toContain(gitconfig(result.home));
  });

  it('keeps a file with another section, and links', () => {
    const result = run('node', (home) => {
      fs.writeFileSync(gitconfig(home), '[user]\n\tname = Me\n');
      fs.mkdirSync(path.join(home, '.config'));
      fs.symlinkSync('/nonexistent', path.join(home, '.config', 'git'));
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(gitconfig(result.home), 'utf8')).toBe('[user]\n\tname = Me\n');
    expect(extensionCopies(result.home)).toBe(false);
    expect(fs.lstatSync(path.join(result.home, '.config', 'git')).isSymbolicLink()).toBe(true);
    expect(result.log).toBe('');

    const linked = run('node', (home) => fs.symlinkSync('/nonexistent', gitconfig(home)));
    expect(linked.status).toBe(0);
    expect(fs.lstatSync(gitconfig(linked.home)).isSymbolicLink()).toBe(true);
  });

  it('documents why an empty file is not enough: the Dev Containers extension copies into it', () => {
    const dir = tempDir();
    expect(extensionCopies(dir)).toBe(true);
    fs.writeFileSync(gitconfig(dir), '');
    expect(extensionCopies(dir)).toBe(true);
    fs.writeFileSync(gitconfig(dir), '[safe]\n\tdirectory = *\n[filter]\n');
    expect(extensionCopies(dir)).toBe(true);
    fs.writeFileSync(gitconfig(dir), '[safe]\n\tdirectory = *\n[core]\n');
    expect(extensionCopies(dir)).toBe(false);
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
