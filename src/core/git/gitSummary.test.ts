// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_OWNERSHIP_FIX_SCRIPT,
  GIT_BRANCH_FUNCTION,
  GIT_BRANCH_SCRIPT,
  GIT_SCRIPT_PRELUDE,
  GIT_SUMMARY_SCRIPT,
  OWNERSHIP_FIX_SCRIPT,
  MAX_SERVICE_ARGUMENT_CHARACTERS,
  MAX_SERVICE_FOLDERS,
  MAX_SERVICE_PATH_DEPTH,
  MAX_SERVICE_PATH_LENGTH,
  MAX_SERVICE_REAL_PATHS,
  boundServiceFolders,
  configOwnershipFixCommand,
  NUMERIC_OWNERSHIP_FIX_SCRIPT,
  RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT,
  type DevMountPaths,
  type ServiceFolders,
  isNumericId,
  repositoryOwnershipFixCommand,
  parseGitSummaryOutput,
  serviceFolderPaths,
  servicePathArguments,
} from './gitSummary';
import type { EnvironmentDocker } from '../pipeline/environmentService';
import { devMountFolders, verifiedIdentityTargets, workspaceIdentityMounts } from '../pipeline/pipelineRules';
import { BRANCH_EXEC_TIMEOUT_MS, readBranch } from '../pipeline/refreshStates';
import { scriptCommand } from '../worker/containerScripts';

/**
 * Plan step 11I (PR B): the command of the script `ownershipFix` of the registry with the arguments that the pipeline
 * gives it (EnvironmentService.fixOwnership: the folder, the user, servicePathArguments), in place of the removed builder
 * ownershipFixCommand, which built the same command.
 */
function ownershipFix(repo: string, user: string, folders?: ServiceFolders, gitPaths: DevMountPaths = false): string[] {
  return scriptCommand('ownershipFix', [repo, user, ...servicePathArguments(repo, folders, gitPaths)]);
}

/**
 * Plan step 11I (PR D): the `find -path` patterns of the paths of the services, as servicePathArguments gives them (each
 * path as `-path <pattern> -o -path <pattern>/*`), in place of the removed servicePrunePatterns, which nothing used.
 */
function servicePrunePatterns(repo: string, folders: readonly string[] | undefined): string[] {
  const args = servicePathArguments(repo, folders);
  return args.filter((_arg, index) => args[index - 1] === '-path').filter((_pattern, index) => index % 2 === 0);
}

const RECORDED_AT = '2026-09-24T17:10:00.000Z';

function hasProgram(name: string, args: string[] = ['--version']): boolean {
  const result = spawnSync(name, args, { stdio: 'ignore' });
  return !result.error;
}

const hasGit = hasProgram('git');
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

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function runSummary(folder: string): { status: number | null; stdout: string; stderr: string } {
  // Plan step 11I (PR B): the command of the registry (the builder gitSummaryCommand, which built the same, is removed).
  const [file, ...args] = scriptCommand('gitSummary', [folder]);
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('parseGitSummaryOutput', () => {
  it('parses the four lines', () => {
    expect(parseGitSummaryOutput('main\n2\n3\n1\n', RECORDED_AT)).toEqual({
      branch: 'main',
      uncommittedFiles: 2,
      unpushedCommits: 3,
      stashes: 1,
      recordedAt: RECORDED_AT,
    });
  });

  it('gives null for a detached HEAD (empty branch line)', () => {
    expect(parseGitSummaryOutput('\n0\n0\n0\n', RECORDED_AT).branch).toBeNull();
  });

  it('accepts CRLF line endings, a missing final newline, and lines before the result', () => {
    expect(parseGitSummaryOutput('Welcome!\r\nfeature/x\r\n0\r\n5\r\n0', RECORDED_AT)).toMatchObject({
      branch: 'feature/x',
      uncommittedFiles: 0,
      unpushedCommits: 5,
      stashes: 0,
    });
  });

  it('throws on malformed output', () => {
    expect(() => parseGitSummaryOutput('', RECORDED_AT)).toThrow();
    expect(() => parseGitSummaryOutput('main\n1\n2\n', RECORDED_AT)).toThrow();
    expect(() => parseGitSummaryOutput('main\none\n2\n3\n', RECORDED_AT)).toThrow();
    expect(() => parseGitSummaryOutput('main\n1\n-2\n3\n', RECORDED_AT)).toThrow();
  });
});

describe('commands', () => {
  // Review round 6 of PR #84 (B-R6-5): Git runs without the hooks of the repository configuration and without optional
  // locks (no refresh of .git/index by `git status`), so the summary never writes to the repository.
  it('review round 6 of PR #84 (B-R6-5): runs Git without hooks and without optional locks', () => {
    expect(GIT_SUMMARY_SCRIPT).toContain('-c core.hooksPath=/dev/null');
    expect(GIT_SUMMARY_SCRIPT).toMatch(/^GIT_OPTIONAL_LOCKS=0$/m);
    expect(GIT_SUMMARY_SCRIPT).toMatch(/^export GIT_OPTIONAL_LOCKS$/m);
  });

  it('passes the folder as a positional parameter', () => {
    // Plan step 11I (PR B): changed expectation, the commands of the registry (scriptCommand) in place of the removed
    // builders gitSummaryCommand and ownershipFixCommand, with the same commands.
    expect(scriptCommand('gitSummary', ['/workspaces/it\'s "api"'])).toEqual(['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', '/workspaces/it\'s "api"']);
    expect(ownershipFix('/workspaces/api', 'vscode')).toEqual(['sh', '-c', OWNERSHIP_FIX_SCRIPT, 'sh', '/workspaces/api', 'vscode']);
  });

  it('never follows a link and never leaves the file system of the folder, on every branch of the fix (review round 3 of PR #81, B-R3-1, B-R3-2)', () => {
    // Review round 3 of PR #81: the tests with real tools and mounts need root and are skipped elsewhere (CI); this one
    // runs everywhere. Each of the three find commands of the fix keeps -xdev and chown -h.
    // Review round 1 of PR #114 (A-M1): changed expectation for CONFIG_OWNERSHIP_FIX_SCRIPT (before: `-exec`), which runs
    // in the batch helper: `-execdir chown -h --`, so a folder of the path that is replaced by a link is not followed.
    for (const [script, exec] of [
      [OWNERSHIP_FIX_SCRIPT, '-exec chown -h "$fix_owner" {} +'],
      [CONFIG_OWNERSHIP_FIX_SCRIPT, '-execdir chown -h -- "$fix_owner" {} +'],
    ] as const) {
      const finds = script.split('\n').filter((line) => /^\s*find "\$folder"/.test(line));
      expect(finds).toHaveLength(3);
      for (const line of finds) {
        expect(line).toMatch(/^\s*find "\$folder" -xdev /);
        expect(line.endsWith(exec)).toBe(true);
      }
    }
  });

  it.each([
    ['GIT_SUMMARY_SCRIPT', GIT_SUMMARY_SCRIPT],
    ['OWNERSHIP_FIX_SCRIPT', OWNERSHIP_FIX_SCRIPT],
  ])('%s has valid sh syntax', (_name, script) => {
    const result = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasDash).each([
    ['GIT_SUMMARY_SCRIPT', GIT_SUMMARY_SCRIPT],
    ['OWNERSHIP_FIX_SCRIPT', OWNERSHIP_FIX_SCRIPT],
  ])('%s has valid dash syntax', (_name, script) => {
    const result = spawnSync('dash', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('ownership fix runs and changes nothing when every file belongs to the user', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'file.txt'), 'x');
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link'));
    const user = os.userInfo().username;
    const [file, ...args] = ownershipFix(dir, user);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.statSync(path.join(dir, 'sub', 'file.txt')).uid).toBe(os.userInfo().uid);
  });
});

describe('review round 9 (D9-1): the ownership fix leaves out the paths that other services mount', () => {
  const REPO = '/workspaces/api';

  it('passes each path as one argument, escaped as a pattern of find -path, and only paths below the repository', () => {
    expect(servicePrunePatterns(REPO, [`${REPO}/data/postgres`, `${REPO}/-data/my db`, `${REPO}/a*b/[x]?\\y`])).toEqual([
      `${REPO}/data/postgres`,
      `${REPO}/-data/my db`,
      `${REPO}/a\\*b/\\[x]\\?\\\\y`,
    ]);
    // Never the repository itself, a path outside of it, a relative path, `..`, or a duplicate.
    expect(servicePrunePatterns(REPO, [REPO, `${REPO}/`, '/workspaces/other/data', 'data', `${REPO}/../other`, `${REPO}//x`, `${REPO}/x`, `${REPO}/x`])).toEqual([
      `${REPO}/x`,
    ]);
    expect(servicePrunePatterns(REPO, undefined)).toEqual([]);
    // Review round 10 (D10-3): never .git or a path in it (Git writes there as root), also from a recorded list.
    expect(servicePrunePatterns(REPO, [`${REPO}/.git`, `${REPO}/.git/objects`, `${REPO}/sub/.git`, `${REPO}/.github`, `${REPO}/x.git`])).toEqual([`${REPO}/.github`, `${REPO}/x.git`]);
    // Review round 11, G5: the command holds the ready arguments of find (servicePathArguments), not the patterns.
    expect(ownershipFix(REPO, 'vscode', [`${REPO}/data/postgres`])).toEqual([
      'sh',
      '-c',
      OWNERSHIP_FIX_SCRIPT,
      'sh',
      REPO,
      'vscode',
      '-path',
      `${REPO}/data/postgres`,
      '-o',
      '-path',
      `${REPO}/data/postgres/*`,
    ]);
  });

  it('turns the parameters into -path arguments without reading them as shell text', () => {
    // Review round 11, G5: servicePathArguments builds the arguments in TypeScript (before: the shell text
    // SERVICE_PATH_ARGUMENTS from the positional parameters); the shell still gets each one as one argument.
    const script = `shift 3\nprintf '<%s>\\n' "$@"`;
    const result = spawnSync('sh', ['-c', script, 'sh', 'a', 'b', 'c', ...servicePathArguments('/r', ['/r/-x y', '/r/$(touch z)'])], { encoding: 'utf8' });
    // Review round 10, D10-3: the test "in a path of a service" (the paths and everything below them), no -prune: the fix
    // still gives the files of root in them their owner (before: `-path P -prune -o` for each pattern).
    expect(result.stdout).toBe('<-path>\n</r/-x y>\n<-o>\n<-path>\n</r/-x y/*>\n<-o>\n<-path>\n</r/$(touch z)>\n<-o>\n<-path>\n</r/$(touch z)/*>\n');
    expect(servicePathArguments('/r', [])).toEqual([]);
    expect(servicePathArguments('/r', undefined)).toEqual([]);
  });

  it('changes the owner of every file but the pruned paths and their content (with spaces and a leading -)', () => {
    const root = tempDir();
    const repo = path.join(root, 'api');
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'chown.log');
    for (const folder of ['src', 'data/postgres/base', '-data/my db', 'datax']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['src/a.ts', 'data/postgres/base/1', 'data/keep.txt', '-data/my db/f', 'datax/g']) fs.writeFileSync(path.join(repo, file), 'x');
    // The user 4242 owns none of the files: the fix would change all of them; chown only writes its arguments.
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 4242\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'chown'), `#!/bin/sh\nshift 2\nfor f do printf '%s\\n' "$f" >> '${log}'; done\n`, { mode: 0o755 });
    // Review round 10, D10-3: the data of the services has the owner that they give it, not root (the tests may run as
    // root): the fix leaves files of root in these paths no more.
    if (process.getuid?.() === 0) {
      for (const file of ['data/postgres', 'data/postgres/base', 'data/postgres/base/1', '-data/my db', '-data/my db/f']) fs.chownSync(path.join(repo, file), 999, 999);
    }
    const [file, ...args] = ownershipFix(repo, 'someone', [`${repo}/data/postgres`, `${repo}/-data/my db`]);
    const result = spawnSync(file, args, { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const changed = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => path.relative(repo, line)).sort();
    expect(changed).toEqual(['', '-data', 'data', 'data/keep.txt', 'datax', 'datax/g', 'src', 'src/a.ts']);
  });
});

describe.skipIf(!hasGit)('GIT_SUMMARY_SCRIPT with a real repository', () => {
  it('counts uncommitted files, unpushed commits, and stashes', () => {
    const root = tempDir();
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    git(root, 'init', '--bare', '-q', remote);
    git(root, 'init', '-q', '-b', 'main', repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '-q', '-m', 'second');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    git(repo, 'add', 'c.txt');
    git(repo, 'commit', '-q', '-m', 'third');
    // One stash.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    git(repo, 'stash', '-q');
    // Two uncommitted files: one modified, one untracked.
    fs.writeFileSync(path.join(repo, 'b.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'new\n');

    const result = runSummary(repo);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toEqual({
      branch: 'main',
      uncommittedFiles: 2,
      unpushedCommits: 2,
      stashes: 1,
      recordedAt: RECORDED_AT,
    });
  });

  // 2026-10-01: the Switch branch command was dropped (user decision).
  it('counts unpushed commits on a local branch that is not checked out', () => {
    const root = tempDir();
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    git(root, 'init', '--bare', '-q', remote);
    git(root, 'init', '-q', '-b', 'main', repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'checkout', '-q', '-b', 'feature-x');
    for (const name of ['b', 'c', 'd']) {
      fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
      git(repo, 'add', `${name}.txt`);
      git(repo, 'commit', '-q', '-m', name);
    }
    git(repo, 'checkout', '-q', 'main');

    const result = runSummary(repo);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({
      branch: 'main',
      uncommittedFiles: 0,
      unpushedCommits: 3,
      stashes: 0,
    });
  });

  it('counts the commits of other branches when HEAD has no commit yet', () => {
    const repo = tempDir();
    git(repo, 'init', '-q', '-b', 'main', '.');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'checkout', '-q', '--orphan', 'fresh');
    git(repo, 'rm', '-q', '-r', '--cached', '.');
    fs.rmSync(path.join(repo, 'a.txt'));

    const result = runSummary(repo);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({
      branch: 'fresh',
      uncommittedFiles: 0,
      unpushedCommits: 1,
      stashes: 0,
    });
  });

  it('reports a detached HEAD, a clean tree, and no remotes', () => {
    const repo = tempDir();
    git(repo, 'init', '-q', '-b', 'main', '.');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'checkout', '-q', '--detach');

    const result = runSummary(repo);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({
      branch: null,
      uncommittedFiles: 0,
      unpushedCommits: 1,
      stashes: 0,
    });
  });

  it('works in a repository without commits', () => {
    const repo = tempDir();
    git(repo, 'init', '-q', '-b', 'main', '.');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');

    const result = runSummary(repo);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({
      branch: 'main',
      uncommittedFiles: 1,
      unpushedCommits: 0,
      stashes: 0,
    });
  });

  it('does not run hooks or an fsmonitor of the repository configuration', () => {
    const repo = tempDir();
    const marker = path.join(repo, 'marker');
    git(repo, 'init', '-q', '-b', 'main', '.');
    const hook = path.join(repo, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(repo, 'config', 'core.fsmonitor', hook);
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });

    const result = runSummary(repo);
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('review round 6 of PR #84 (B-R6-5): leaves .git/index unchanged when its stat data is stale (no optional locks)', () => {
    const repo = tempDir();
    git(repo, 'init', '-q', '-b', 'main', '.');
    const file = path.join(repo, 'a.txt');
    fs.writeFileSync(file, 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
    // Same content, a new modification time: a plain `git status` would refresh the stat data in the index.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const index = path.join(repo, '.git', 'index');
    const before = fs.readFileSync(index);
    const beforeTime = fs.statSync(index).mtimeMs;

    const result = runSummary(repo);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({ uncommittedFiles: 0 });
    expect(fs.readFileSync(index).equals(before)).toBe(true);
    expect(fs.statSync(index).mtimeMs).toBe(beforeTime);
    expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
  });

  it('fails with a message for a folder that is not a repository', () => {
    const result = runSummary(tempDir());
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });
});

/**
 * Plan step 11I (PR B): the script `branch` of the registry in `folder`, run by the shell of this computer as `docker exec`
 * runs it in the dev container; `PATH` decides which Git it finds (oldGit, or a folder without Git).
 */
function runBranch(folder: string, searchPath = process.env.PATH ?? '/usr/bin:/bin'): { status: number | null; stdout: string; stderr: string } {
  const [shell, ...args] = scriptCommand('branch', [folder]);
  expect(shell).toBe('sh');
  const result = spawnSync('/bin/sh', args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: searchPath, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Plan step 11I (PR B): `PATH` with a Git before 2.22 in front: a stub that refuses `--show-current` as it did, else the real Git. */
function oldGit(): string {
  const bin = path.join(tempDir(), 'bin');
  fs.mkdirSync(bin);
  const real = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nfor a do\n  if [ "$a" = --show-current ]; then echo "error: unknown option 'show-current'" >&2; exit 129; fi\ndone\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  return `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
}

/** Plan step 11I (PR B): a repository on `feature/x` with a commit, one without commits on `main`, and one with a detached HEAD. */
function branchRepos(): { onBranch: string; unborn: string; detached: string } {
  const root = tempDir();
  const [onBranch, unborn, detached] = ['on-branch', 'unborn', 'detached'].map((name) => path.join(root, name));
  git(root, 'init', '-q', '-b', 'feature/x', onBranch);
  git(root, 'init', '-q', '-b', 'main', unborn);
  git(root, 'init', '-q', '-b', 'main', detached);
  for (const repo of [onBranch, detached]) {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
  }
  git(detached, 'checkout', '-q', '--detach');
  return { onBranch, unborn, detached };
}

describe('plan step 11I (PR B): GIT_BRANCH_SCRIPT, the one read of the branch (the script `branch` of the registry)', () => {
  it('starts as GIT_SUMMARY_SCRIPT and reads the branch with the same function, its only read of the branch', () => {
    // One function per fact (section 0 of the plan): the summary and the branch read share the hardening and the read.
    for (const script of [GIT_BRANCH_SCRIPT, GIT_SUMMARY_SCRIPT]) {
      expect(script.startsWith(GIT_SCRIPT_PRELUDE)).toBe(true);
      expect(script.split(GIT_BRANCH_FUNCTION)).toHaveLength(2);
      // Review round 1 of PR #124 (A, L-2): changed expectation, HEAD is read once, with `git symbolic-ref -q HEAD`
      // (before: `git branch --show-current`, with `git symbolic-ref --short` for a Git before 2.22).
      expect(script).not.toContain('--show-current');
      expect(script.split('symbolic-ref -q HEAD')).toHaveLength(2);
    }
    // The hardening of the summary (review rounds 2, 5 and 6 of PR #84) in the start of both.
    for (const part of ["safe.directory='*'", 'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'log.showSignature=false', 'command -v git']) {
      expect(GIT_SCRIPT_PRELUDE).toContain(part);
    }
    expect(GIT_SCRIPT_PRELUDE.split('\n').slice(0, 2)).toEqual(['set -eu', 'export LC_ALL=C LANG=C']);
    expect(GIT_SCRIPT_PRELUDE).toMatch(/^GIT_OPTIONAL_LOCKS=0$/m);
    expect(GIT_BRANCH_SCRIPT.slice(GIT_SCRIPT_PRELUDE.length + GIT_BRANCH_FUNCTION.length)).toBe('git_branch\nprintf \'%s\\n\' "$branch"\n');
    expect(scriptCommand('branch', ['/workspaces/api'])).toEqual(['sh', '-c', GIT_BRANCH_SCRIPT, 'sh', '/workspaces/api']);
  });

  it('has valid sh syntax, and dash syntax where dash exists', () => {
    for (const shell of hasDash ? ['sh', 'dash'] : ['sh']) {
      expect(spawnSync(shell, ['-n', '-c', GIT_BRANCH_SCRIPT], { encoding: 'utf8' }).status, shell).toBe(0);
    }
  });

  it.skipIf(!hasGit)('reads the branch, also one without commits yet, and an empty line for a detached HEAD', () => {
    const { onBranch, unborn, detached } = branchRepos();
    expect(runBranch(onBranch)).toEqual({ status: 0, stdout: 'feature/x\n', stderr: '' });
    expect(runBranch(unborn)).toEqual({ status: 0, stdout: 'main\n', stderr: '' });
    expect(runBranch(detached)).toEqual({ status: 0, stdout: '\n', stderr: '' });
    // The Git state reads the same branch with the same function.
    for (const [repo, branch] of [[onBranch, 'feature/x'], [unborn, 'main'], [detached, null]] as const) {
      expect(parseGitSummaryOutput(runSummary(repo).stdout, RECORDED_AT).branch, repo).toBe(branch);
    }
  });

  it.skipIf(!hasGit)('fails for a folder that is no repository (the exit code of Git, with its message) and without Git (127)', () => {
    const notRepository = runBranch(tempDir());
    expect(notRepository.status).not.toBe(0);
    expect(notRepository.stdout).toBe('');
    expect(notRepository.stderr).toMatch(/not a git repository/i);
    const missing = runBranch(branchRepos().onBranch, tempDir());
    expect(missing).toEqual({ status: 127, stdout: '', stderr: 'Git is not installed.\n' });
    expect(runBranch(path.join(tempDir(), 'missing')).status).not.toBe(0);
  });

  it.skipIf(!hasGit)('reads the branch with a Git before 2.22 (no `git branch --show-current`) as the summary does: `git symbolic-ref`', () => {
    const old = oldGit();
    // The stub refuses `--show-current` as a Git before 2.22 does (so the fallback is what is tested here).
    expect(spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8', env: { ...process.env, PATH: old } }).status).toBe(129);
    const { onBranch, unborn, detached } = branchRepos();
    expect(runBranch(onBranch, old)).toEqual({ status: 0, stdout: 'feature/x\n', stderr: '' });
    expect(runBranch(unborn, old)).toEqual({ status: 0, stdout: 'main\n', stderr: '' });
    expect(runBranch(detached, old)).toEqual({ status: 0, stdout: '\n', stderr: '' });
    const notRepository = runBranch(tempDir(), old);
    expect(notRepository.status).not.toBe(0);
    expect(notRepository.stderr).toMatch(/not a git repository/i);
    // The summary with the same Git reads the same branch.
    const summary = spawnSync('/bin/sh', scriptCommand('gitSummary', [onBranch]).slice(1), {
      encoding: 'utf8',
      env: { ...process.env, PATH: old, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    });
    expect(summary.status).toBe(0);
    expect(parseGitSummaryOutput(summary.stdout, RECORDED_AT).branch).toBe('feature/x');
  });

  // Review round 1 of PR #124 (A, L-2): only a ref below refs/heads/ is a branch. Before, `git branch --show-current`
  // failed for a HEAD outside refs/heads/ and the fallback `git symbolic-ref --short` read its short name (the summary
  // showed `origin/main` or the tag); and a Git before 2.22 read a branch whose name a tag has too as `heads/<name>`.
  it.skipIf(!hasGit)('takes a HEAD that names a remote-tracking branch or a tag for no branch, and reads a branch whose name a tag has too by its name', async () => {
    const { onBranch } = branchRepos();
    git(onBranch, 'tag', 'feature/x');
    expect(runBranch(onBranch)).toEqual({ status: 0, stdout: 'feature/x\n', stderr: '' });
    expect(runBranch(onBranch, oldGit())).toEqual({ status: 0, stdout: 'feature/x\n', stderr: '' });
    const docker: Pick<EnvironmentDocker, 'exec'> = {
      exec: async (_container, command) => {
        const [program, ...args] = command;
        const result = spawnSync(program === 'sh' ? '/bin/sh' : program, args, {
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
        });
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: false };
      },
    };
    git(onBranch, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    for (const head of ['refs/remotes/origin/main', 'refs/tags/feature/x']) {
      fs.writeFileSync(path.join(onBranch, '.git', 'HEAD'), `ref: ${head}\n`);
      expect(runBranch(onBranch), head).toEqual({ status: 0, stdout: '\n', stderr: '' });
      expect(await readBranch(docker, 'c', undefined, onBranch), head).toBeNull();
      const summary = runSummary(onBranch);
      expect(summary.status, head).toBe(0);
      expect(parseGitSummaryOutput(summary.stdout, RECORDED_AT).branch, head).toBeNull();
    }
  });

  it.skipIf(!hasGit)('runs no hook or fsmonitor of the repository configuration', () => {
    const repo = tempDir();
    const marker = path.join(repo, 'marker');
    git(repo, 'init', '-q', '-b', 'main', '.');
    const hook = path.join(repo, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(repo, 'config', 'core.fsmonitor', hook);
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    expect(runBranch(repo)).toMatchObject({ status: 0, stdout: 'main\n' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.skipIf(!hasGit)('is what readBranch reads (the refresh, an attached window, the branch after an open): null for a detached HEAD, undefined without Git or when Git fails', async () => {
    const { onBranch, unborn, detached } = branchRepos();
    // The exec of the pipeline's port, run here as `docker exec` runs the command of the registry in the container.
    const docker = (searchPath = process.env.PATH ?? '/usr/bin:/bin'): Pick<EnvironmentDocker, 'exec'> => ({
      exec: async (_container, command, options = {}) => {
        expect(options).toMatchObject({ timeoutMs: BRANCH_EXEC_TIMEOUT_MS });
        expect(options).not.toHaveProperty('input');
        expect(options).not.toHaveProperty('secretInputName');
        const [program, ...args] = command;
        const result = spawnSync(program === 'sh' ? '/bin/sh' : program, args, {
          encoding: 'utf8',
          env: { ...process.env, PATH: searchPath, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
        });
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: false };
      },
    });
    expect(await readBranch(docker(), 'c', 'vscode', onBranch)).toBe('feature/x');
    expect(await readBranch(docker(), 'c', undefined, unborn)).toBe('main');
    expect(await readBranch(docker(), 'c', undefined, detached)).toBeNull();
    expect(await readBranch(docker(), 'c', undefined, tempDir())).toBeUndefined();
    expect(await readBranch(docker(), 'c', undefined, path.join(tempDir(), 'missing'))).toBeUndefined();
    expect(await readBranch(docker(tempDir()), 'c', undefined, onBranch)).toBeUndefined();
    // A Git before 2.22: the same answers (before plan step 11I, PR B, `git branch --show-current` failed there: undefined).
    const old = oldGit();
    expect(await readBranch(docker(old), 'c', undefined, onBranch)).toBe('feature/x');
    expect(await readBranch(docker(old), 'c', undefined, detached)).toBeNull();
    expect(await readBranch(docker(old), 'c', undefined, tempDir())).toBeUndefined();
    // A time limit or a cancel of the exec is no branch either.
    expect(await readBranch({ exec: async () => ({ exitCode: null, stdout: 'main\n', stderr: '', timedOut: true }) }, 'c', undefined, onBranch)).toBeUndefined();
    expect(await readBranch({ exec: async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, 'c', undefined, onBranch)).toBeUndefined();
  });

  it('runs every Git call in the C locale, whatever locale the caller has', () => {
    const root = tempDir();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(root, 'log');
    // A stub of git that records its locale variables and fails (exit code 1).
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s %s\\n' "\${LC_ALL-unset}" "\${LANG-unset}" >> '${log}'\nexit 1\n`, { mode: 0o755 });
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const [, ...args] = scriptCommand('branch', [repo]);
    const result = spawnSync('/bin/sh', args, {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', LANGUAGE: 'de' },
    });
    // Exit code 1 of `git symbolic-ref -q` is a detached HEAD.
    expect(result).toMatchObject({ status: 0, stdout: '\n' });
    // Review round 1 of PR #124 (A, L-2): changed expectation, one read of HEAD (before: two, the second for a Git before
    // 2.22).
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['C C']);
  });
});

describe.skipIf(process.getuid?.() !== 0)('review round 10 (D10-2, D10-3): the ownership fix in the paths that other services mount, with real tools as root', () => {
  function run(repo: string, user: string, folders: string[]): void {
    const [file, ...args] = ownershipFix(repo, user, folders);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
  const uidOf = (file: string) => fs.lstatSync(file).uid;
  const nobody = Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim());

  it('gives files and folders of root in those paths their owner, and leaves the data of a service alone (D10-3)', () => {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['data/base', 'frontend/src/new', 'nginx']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['data/PG_VERSION', 'data/base/1', 'data/tracked.conf', 'frontend/src/app.ts', 'frontend/src/new/b.ts', 'nginx/default.conf', 'top.txt']) {
      fs.writeFileSync(path.join(repo, file), 'x');
    }
    // The data of Postgres (uid 999); tracked.conf and the source of the frontend were rewritten by root (git switch).
    for (const file of ['data', 'data/base', 'data/base/1', 'data/PG_VERSION']) fs.chownSync(path.join(repo, file), 999, 999);
    run(repo, 'nobody', [`${repo}/data`, `${repo}/frontend`, `${repo}/nginx`]);
    // Before: every file of these paths kept its owner, also root.
    for (const file of ['data/tracked.conf', 'frontend', 'frontend/src/app.ts', 'frontend/src/new', 'frontend/src/new/b.ts', 'nginx/default.conf', 'top.txt', '.']) {
      expect(uidOf(path.join(repo, file)), file).toBe(nobody);
    }
    for (const file of ['data', 'data/base', 'data/base/1', 'data/PG_VERSION']) expect(uidOf(path.join(repo, file)), file).toBe(999);
  });

  it('leaves the real folder of a service behind a link in the repository alone, once it is recorded (D10-2)', () => {
    const repo = path.join(tempDir(), 'api');
    fs.mkdirSync(path.join(repo, '.local/pg'), { recursive: true });
    fs.symlinkSync('.local/pg', path.join(repo, 'data'));
    fs.writeFileSync(path.join(repo, '.local/pg/PG_VERSION'), '16');
    fs.chownSync(path.join(repo, '.local/pg'), 999, 999);
    fs.chownSync(path.join(repo, '.local/pg/PG_VERSION'), 999, 999);
    // The paths as composeUpModel records them: the link and its real path.
    run(repo, 'nobody', [`${repo}/data`, `${repo}/.local/pg`]);
    expect(uidOf(path.join(repo, '.local/pg/PG_VERSION'))).toBe(999);
    expect(uidOf(path.join(repo, '.local'))).toBe(nobody);
    // The link itself belonged to root: it gets the owner (chown -h), its target does not.
    expect(uidOf(path.join(repo, 'data'))).toBe(nobody);
  });
});

describe('review round 11 (G3, G5): the list of the paths of the services, bounded, and its arguments of find', () => {
  const REPO = '/workspaces/api';

  it('drops a path below another path of the list, and keeps the order', () => {
    expect(serviceFolderPaths(REPO, [`${REPO}/data/pg`, `${REPO}/x`, `${REPO}/data`, `${REPO}/data/pg/base`, `${REPO}/datax`, `${REPO}/x`])).toEqual([
      `${REPO}/x`,
      `${REPO}/data`,
      `${REPO}/datax`,
    ]);
    // Before: a pattern for each path, also the ones that the test `-path <path>/*` of another covers.
    expect(servicePrunePatterns(REPO, [`${REPO}/a*`, `${REPO}/a*/b`])).toEqual([`${REPO}/a\\*`]);
  });

  it('bounds the list that per-run paths (such as ./data/${HOSTNAME}) grow at each open', () => {
    let record: { folders: string[]; overflow: boolean } = { folders: [], overflow: false };
    // Each open: the path of this run in the model, and the recorded paths of the earlier runs, which still exist.
    for (let run = 0; run < 1500; run++) record = boundServiceFolders(REPO, [[`${REPO}/data/host-${run}`], [], record.folders], record.overflow);
    // Before: the union never shrank, and grew by one path per open.
    expect(record.folders).toHaveLength(MAX_SERVICE_FOLDERS);
    expect(record.folders[0]).toBe(`${REPO}/data/host-1499`);
    expect(record.overflow).toBe(true);
    // Over the bound, the ownership fixes leave the whole repository to the services (only the files of root change).
    expect(servicePathArguments(REPO, record.overflow ? 'repository' : record.folders)).toEqual(['-path', REPO, '-o', '-path', `${REPO}/*`]);
    // The overflow stays: the paths beyond the bound are not recorded.
    expect(boundServiceFolders(REPO, [[`${REPO}/data/pg`]], true)).toEqual({ folders: [`${REPO}/data/pg`], overflow: true });
    expect(boundServiceFolders(REPO, [[`${REPO}/data/pg`], undefined, [`${REPO}/data/pg`, REPO]])).toEqual({ folders: [`${REPO}/data/pg`], overflow: false });
  });

  it('builds the arguments of 5000 paths in linear time, and falls back to the whole repository over the bounds', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `${REPO}/data/host-${i}`);
    const started = performance.now();
    const over = servicePathArguments(REPO, many);
    const list = serviceFolderPaths(REPO, many);
    const bounded = boundServiceFolders(REPO, [many]);
    const exact = servicePathArguments(REPO, many.slice(0, MAX_SERVICE_FOLDERS));
    const elapsed = performance.now() - started;
    // Before: SERVICE_PATH_ARGUMENTS rebuilt "$@" in the shell for each pattern: 51 s for 5000 patterns in dash.
    expect(elapsed).toBeLessThan(1000);
    expect(list).toHaveLength(5000);
    expect(bounded.folders).toHaveLength(MAX_SERVICE_FOLDERS);
    expect(over).toEqual(['-path', REPO, '-o', '-path', `${REPO}/*`]);
    expect(exact).toHaveLength(6 * MAX_SERVICE_FOLDERS - 1);
    expect(exact.slice(0, 6)).toEqual(['-path', `${REPO}/data/host-0`, '-o', '-path', `${REPO}/data/host-0/*`, '-o']);
    // The command line stays below the bound of its characters (Windows: 32767 for the whole command line).
    expect(exact.join(' ').length).toBeLessThan(MAX_SERVICE_ARGUMENT_CHARACTERS + 20 * MAX_SERVICE_FOLDERS);
    const long = Array.from({ length: 300 }, (_, i) => `${REPO}/${'x'.repeat(1000)}/${i}`);
    expect(servicePathArguments(REPO, long)).toEqual(['-path', REPO, '-o', '-path', `${REPO}/*`]);
    // The whole repository folder is escaped as a pattern too.
    expect(servicePathArguments('/workspaces/a*b', 'repository')).toEqual(['-path', '/workspaces/a\\*b', '-o', '-path', '/workspaces/a\\*b/*']);
  });

  it.skipIf(!hasDash)('runs the ownership fix with the arguments of 1000 paths in dash quickly', () => {
    const repo = path.join(tempDir(), 'api');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'x');
    const [, ...args] = ownershipFix(repo, os.userInfo().username, Array.from({ length: MAX_SERVICE_FOLDERS }, (_, i) => `${repo}/data/host-${i}`));
    const started = performance.now();
    const result = spawnSync('dash', args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('review round 12 (S12-1): the nested-path filter in linear time, with bounds of length and depth', () => {
  const REPO = '/workspaces/repo';
  const WHOLE = ['-path', REPO, '-o', '-path', `${REPO}/*`];

  it('filters 1000 paths at depth 2000 in well under 100 ms, as overflow', () => {
    const deep = Array.from({ length: 1000 }, (_, i) => `${REPO}/${'a/'.repeat(2000)}x${i}`);
    let started = performance.now();
    const list = serviceFolderPaths(REPO, deep);
    // Before: 6 s for serviceFolderPaths alone (the lookup of each ancestor, O(depth x length) per path).
    expect(performance.now() - started).toBeLessThan(100);
    started = performance.now();
    const bounded = boundServiceFolders(REPO, [deep, deep, deep]);
    const args = servicePathArguments(REPO, deep);
    // Before: about 12 s together.
    expect(performance.now() - started).toBeLessThan(500);
    // Never dropped: the paths over the bounds stay in the list, and make it overflow.
    expect(list).toHaveLength(1000);
    expect(bounded).toEqual({ folders: [], overflow: true });
    expect(args).toEqual(WHOLE);
  });

  it('filters 1000 long paths within the bounds in linear time', () => {
    // Depth 251 and about 4000 characters each: at the bounds.
    const deep = `${REPO}/${'abcdefghijklmno/'.repeat(250)}`;
    const paths = Array.from({ length: 1000 }, (_, i) => `${deep}x${i}`);
    let started = performance.now();
    const list = serviceFolderPaths(REPO, paths);
    // Before: several seconds (a lookup of each of the 250 ancestors of each path).
    expect(performance.now() - started).toBeLessThan(500);
    expect(list).toEqual(paths);
    // With a path that covers them all, after them: only it stays.
    started = performance.now();
    expect(serviceFolderPaths(REPO, [...paths, `${REPO}/abcdefghijklmno`])).toEqual([`${REPO}/abcdefghijklmno`]);
    expect(serviceFolderPaths(REPO, [...paths, `${deep}x1/y`, deep.slice(0, -1)])).toEqual([deep.slice(0, -1)]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('treats a path over the length or depth bound as overflow, unless a path of the list covers it', () => {
    const long = `${REPO}/${'x'.repeat(MAX_SERVICE_PATH_LENGTH)}`;
    const deep = `${REPO}/${'d/'.repeat(MAX_SERVICE_PATH_DEPTH)}e`;
    const atDepth = `${REPO}/${'d/'.repeat(MAX_SERVICE_PATH_DEPTH - 1)}e`;
    expect(boundServiceFolders(REPO, [[`${REPO}/pg`, long]])).toEqual({ folders: [`${REPO}/pg`], overflow: true });
    expect(boundServiceFolders(REPO, [[deep, `${REPO}/pg`]])).toEqual({ folders: [`${REPO}/pg`], overflow: true });
    expect(servicePathArguments(REPO, [`${REPO}/pg`, deep])).toEqual(WHOLE);
    // At the bound, a path is named on its own.
    expect(boundServiceFolders(REPO, [[atDepth]])).toEqual({ folders: [atDepth], overflow: false });
    expect(servicePathArguments(REPO, [atDepth])).toEqual(['-path', atDepth, '-o', '-path', `${atDepth}/*`]);
    // Covered by a path of the list: its test `-path <path>/*` names it.
    expect(boundServiceFolders(REPO, [[deep, `${REPO}/d`]])).toEqual({ folders: [`${REPO}/d`], overflow: false });
    expect(boundServiceFolders(REPO, [[`${REPO}/${'x'.repeat(MAX_SERVICE_PATH_LENGTH)}/y`, `${REPO}/${'x'.repeat(10)}`]])).toMatchObject({ overflow: true });
  });

  it('keeps the results for normal inputs, in the input order', () => {
    expect(serviceFolderPaths(REPO, [`${REPO}/b/c`, `${REPO}/a`, `${REPO}/b`, `${REPO}/a/x`, `${REPO}/a-b`, `${REPO}/a b/c`, `${REPO}/b/c`])).toEqual([
      `${REPO}/a`,
      `${REPO}/b`,
      `${REPO}/a-b`,
      `${REPO}/a b/c`,
    ]);
    expect(serviceFolderPaths(REPO, [`${REPO}/a/b/c`, `${REPO}/a/b`, `${REPO}/a/bc`])).toEqual([`${REPO}/a/b`, `${REPO}/a/bc`]);
  });
});

describe('review round 12 (P12-2): the ownership fix resolves the paths of the services behind links', () => {
  /** Runs the ownership fix with a fake `find` that prints its arguments (one per line), and `id` that prints 4242. */
  function findArguments(repo: string, folders: string[] | 'repository'): string[] {
    const bin = path.join(path.dirname(repo), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 4242\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'find'), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
    const [file, ...args] = ownershipFix(repo, 'someone', folders);
    const result = spawnSync(file, args, { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout.split('\n').slice(0, -1);
  }
  const test = (paths: string[]) => paths.flatMap((p, i) => [...(i > 0 ? ['-o'] : []), '-path', p, '-o', '-path', `${p}/*`]);
  const fix = (repo: string, inPaths: string[]) => [repo, '-xdev', '(', '(', ...inPaths, ')', '-user', '0', '-o', '!', '(', ...inPaths, ')', '(', '!', '-user', '4242', '-o', '!', '-group', '4242', ')', ')', '-exec', 'chown', '-h', '4242:4242', '{}', '+'];

  function repository(): string {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['storage/pg', 'lib/x', '.git/objects']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    fs.writeFileSync(path.join(repo, 'storage/app.conf'), 'x');
    return repo;
  }

  it('adds the real path of a folder and of a file behind a link, in the repository', () => {
    const repo = repository();
    fs.symlinkSync('storage/pg', path.join(repo, 'data'));
    fs.symlinkSync(`${repo}/storage/app.conf`, path.join(repo, 'app.conf'));
    // A path below a link, and a path without a link (unchanged).
    fs.symlinkSync('storage', path.join(repo, 'store'));
    expect(findArguments(repo, [`${repo}/data`, `${repo}/app.conf`, `${repo}/store/pg`, `${repo}/lib/x`])).toEqual(
      fix(repo, [
        ...test([`${repo}/data`, `${repo}/app.conf`, `${repo}/store/pg`, `${repo}/lib/x`]),
        '-o',
        // Review round 13, D13-2: a real path is added once (before: storage/pg twice, for data and for store/pg).
        ...test([`${repo}/storage/pg`, `${repo}/storage/app.conf`]),
      ]),
    );
  });

  it('adds no real path outside the repository, of the repository itself, or in .git', () => {
    const repo = repository();
    const outside = path.join(path.dirname(repo), 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, 'out'));
    fs.symlinkSync('.', path.join(repo, 'self'));
    fs.symlinkSync('.git/objects', path.join(repo, 'objects'));
    fs.symlinkSync('missing', path.join(repo, 'dangling'));
    const folders = [`${repo}/out`, `${repo}/self`, `${repo}/objects`, `${repo}/nothing`];
    expect(findArguments(repo, folders)).toEqual(fix(repo, test(folders)));
    // A link that leads nowhere: its target in the repository (readlink -f) is protected too.
    expect(findArguments(repo, [`${repo}/dangling`])).toEqual(fix(repo, [...test([`${repo}/dangling`]), '-o', ...test([`${repo}/missing`])]));
  });

  it('counts the whole repository as a path of the services for a real path with a pattern character, or too many', () => {
    const repo = repository();
    fs.mkdirSync(path.join(repo, 'st*rage'));
    fs.symlinkSync('st*rage', path.join(repo, 'data'));
    const onlyRoot = [repo, '-xdev', '-user', '0', '-exec', 'chown', '-h', '4242:4242', '{}', '+'];
    expect(findArguments(repo, [`${repo}/data`])).toEqual(onlyRoot);
    // A path of a service with a pattern character (escaped with a backslash for -path): it cannot be resolved as written.
    expect(findArguments(repo, [`${repo}/st*rage`])).toEqual(onlyRoot);
    const links = Array.from({ length: MAX_SERVICE_REAL_PATHS + 1 }, (_, i) => {
      fs.mkdirSync(path.join(repo, `real/${i}`), { recursive: true });
      fs.symlinkSync(`real/${i}`, path.join(repo, `link-${i}`));
      return `${repo}/link-${i}`;
    });
    expect(findArguments(repo, links)).toEqual(onlyRoot);
    expect(findArguments(repo, links.slice(0, MAX_SERVICE_REAL_PATHS)).filter((arg) => arg.startsWith(`${repo}/real/`))).toHaveLength(4 * MAX_SERVICE_REAL_PATHS);
    // 'repository' stays the whole repository.
    expect(findArguments(repo, 'repository')).toEqual(fix(repo, ['-path', repo, '-o', '-path', `${repo}/*`]));
  });
});

describe.skipIf(process.getuid?.() !== 0)('review round 12 (D12-2): the ownership fix with the mounts of the dev container, with real tools as root', () => {
  const uidOf = (file: string) => fs.lstatSync(file).uid;
  const nobody = Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim());

  it('gives the folder of a new node_modules volume the user, and leaves the files of db in a shared volume alone', () => {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['src', 'node_modules/left-pad', '.pgdata/base']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['src/a.ts', 'node_modules/left-pad/index.js', 'node_modules/.other', '.pgdata/PG_VERSION', '.pgdata/base/1']) fs.writeFileSync(path.join(repo, file), 'x');
    // The files of Postgres (uid 999) in the volume that db shares; a file of another user in node_modules.
    for (const file of ['.pgdata', '.pgdata/base', '.pgdata/base/1', '.pgdata/PG_VERSION']) fs.chownSync(path.join(repo, file), 999, 999);
    fs.chownSync(path.join(repo, 'node_modules/.other'), 1234, 1234);
    // The paths as withDevMountFolders adds them (devMountFolders of the mounts of the dev container).
    const [file, ...args] = ownershipFix(repo, 'nobody', [`${repo}/.pgdata`, `${repo}/node_modules`]);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The folder that Docker created as root for the volume, and what root wrote in it, get the user.
    for (const name of ['.', 'src', 'src/a.ts', 'node_modules', 'node_modules/left-pad', 'node_modules/left-pad/index.js']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
    // Before (without the paths): 'nobody' too.
    for (const name of ['.pgdata', '.pgdata/base', '.pgdata/base/1', '.pgdata/PG_VERSION']) expect(uidOf(path.join(repo, name)), name).toBe(999);
    expect(uidOf(path.join(repo, 'node_modules/.other'))).toBe(1234);
  });
});

describe.skipIf(process.getuid?.() !== 0)('review round 13 (D13-1, D13-3): the ownership fix with the mounts of the dev container, with real tools and bind mounts as root', () => {
  const uidOf = (file: string) => fs.lstatSync(file).uid;
  const nobody = Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim());
  const VOLUME = 'acme-api-3f2a9c1e';

  /** devMountFolders of `mounts` (targets below /workspaces/api), moved to `repo`. */
  function devFolders(repo: string, mounts: Array<{ type: string; volume?: string; target: string; subpath?: string }>, identities?: ReadonlySet<string>): string[] {
    return devMountFolders({ mountTargets: mounts }, { repository: 'acme/api', volumeName: VOLUME }, 'on', identities).map((folder) => repo + folder.slice('/workspaces/api'.length));
  }

  /** Runs `body` with `source` bind-mounted at `target`; skips the test when the sandbox does not allow `mount --bind`. */
  function withBind(skip: () => void, source: string, target: string, body: () => void): void {
    fs.mkdirSync(target, { recursive: true });
    if (spawnSync('mount', ['--bind', source, target], { stdio: 'ignore' }).status !== 0) {
      skip();
      return;
    }
    try {
      body();
    } finally {
      spawnSync('umount', [target], { stdio: 'ignore' });
    }
  }

  function fixAll(repo: string, folders: string[], loop = false): void {
    const [file, ...args] = ownershipFix(repo, 'nobody', folders);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    if (!loop) {
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      return;
    }
    // find reports the loop of an ancestor mounted below itself (and exits with 1), but goes on with the rest.
    for (const line of result.stderr.split('\n').filter((text) => text !== '')) expect(line).toMatch(/^find: File system loop detected/);
  }

  it('leaves the files of db alone behind an alias of the workspace volume (./data:/workspaces/api/pgview)', ({ skip }) => {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['src', 'data/base']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['src/a.ts', 'data/PG_VERSION', 'data/base/1']) fs.writeFileSync(path.join(repo, file), 'x');
    for (const file of ['data', 'data/base', 'data/base/1', 'data/PG_VERSION']) fs.chownSync(path.join(repo, file), 999, 999);
    withBind(skip, path.join(repo, 'data'), path.join(repo, 'pgview'), () => {
      const mounts = [
        { type: 'volume', volume: VOLUME, target: '/workspaces' },
        { type: 'volume', volume: VOLUME, target: '/workspaces/api/pgview' },
      ];
      // Before: devMountFolders was empty, and `find -xdev` gave the files of db to nobody through pgview.
      expect(devFolders(repo, mounts)).toEqual([`${repo}/pgview`]);
      fixAll(repo, [`${repo}/data`, ...devFolders(repo, mounts)]);
      for (const name of ['data', 'data/base', 'data/base/1', 'data/PG_VERSION']) expect(uidOf(path.join(repo, name)), name).toBe(999);
      for (const name of ['.', 'src', 'src/a.ts']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
    });
  });

  it('fixes the repository in full under its canonical path when `..` is mounted below it', ({ skip }) => {
    const base = tempDir();
    const repo = path.join(base, 'api');
    for (const folder of ['src', 'data']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['src/a.ts', 'src/b.ts', 'data/PG_VERSION']) fs.writeFileSync(path.join(repo, file), 'x');
    fs.chownSync(path.join(repo, 'src/b.ts'), 1234, 1234);
    for (const file of ['data', 'data/PG_VERSION']) fs.chownSync(path.join(repo, file), 999, 999);
    withBind(skip, base, path.join(repo, 'parent'), () => {
      const mounts = [
        { type: 'volume', volume: VOLUME, target: '/workspaces' },
        { type: 'volume', volume: VOLUME, target: '/workspaces/api/parent' },
      ];
      expect(devFolders(repo, mounts)).toEqual([`${repo}/parent`]);
      fixAll(repo, [`${repo}/data`, ...devFolders(repo, mounts)], true);
      // The files of db stay theirs also through parent/api/data; the others get the user under their canonical path.
      for (const name of ['data', 'data/PG_VERSION']) expect(uidOf(path.join(repo, name)), name).toBe(999);
      for (const name of ['.', 'src', 'src/a.ts', 'src/b.ts']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
    });
  });

  it('gives the image content of an anonymous volume the user, and leaves a named volume to its owners', () => {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['node_modules/left-pad', '.cache']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['node_modules/left-pad/index.js', '.cache/entry']) fs.writeFileSync(path.join(repo, file), 'x');
    // Copied up from the image as uid 1000 (the remote user has another uid).
    for (const file of ['node_modules', 'node_modules/left-pad', 'node_modules/left-pad/index.js', '.cache', '.cache/entry']) fs.chownSync(path.join(repo, file), 1000, 1000);
    const folders = devFolders(repo, [
      { type: 'volume', volume: 'd'.repeat(64), target: '/workspaces/api/node_modules' },
      { type: 'volume', volume: 'api-cache', target: '/workspaces/api/.cache' },
    ]);
    expect(folders).toEqual([`${repo}/.cache`]);
    fixAll(repo, folders);
    // Before (review round 12): uid 1000 kept, and `npm install` as the remote user failed with EACCES.
    for (const name of ['node_modules', 'node_modules/left-pad', 'node_modules/left-pad/index.js']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
    for (const name of ['.cache', '.cache/entry']) expect(uidOf(path.join(repo, name)), name).toBe(1000);
  });

  it('gives src the full fix after a change of the uid when the dev service mounts ../src at its own path (review round 14, P14-1)', ({ skip }) => {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['src/lib', 'data']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['src/a.ts', 'src/lib/b.ts', 'data/PG_VERSION']) fs.writeFileSync(path.join(repo, file), 'x');
    // The files of the remote user of the previous container (uid 1000); the remote user now has another uid.
    for (const file of ['.', 'src', 'src/a.ts', 'src/lib', 'src/lib/b.ts']) fs.chownSync(path.join(repo, file), 1000, 1000);
    for (const file of ['data', 'data/PG_VERSION']) fs.chownSync(path.join(repo, file), 999, 999);
    // ..:/workspaces/api and ../src:/workspaces/api/src, rewritten to the subpaths api and api/src.
    withBind(skip, path.join(repo, 'src'), path.join(repo, 'src'), () => {
      const mounts = [
        { type: 'volume', volume: VOLUME, target: '/workspaces' },
        { type: 'volume', volume: VOLUME, target: '/workspaces/api', subpath: 'api' },
        { type: 'volume', volume: VOLUME, target: '/workspaces/api/src', subpath: 'api/src' },
      ];
      const root = `/var/lib/docker/volumes/${VOLUME}/_data`;
      const identities = verifiedIdentityTargets(
        workspaceIdentityMounts({ mountTargets: mounts }, { repository: 'acme/api', volumeName: VOLUME }),
        `2 1 8:1 ${root} /workspaces rw\n3 2 8:1 ${root}/api /workspaces/api rw\n4 3 8:1 ${root}/api/src /workspaces/api/src rw\n`,
      );
      // Before: [src], and only the files of root in src changed: uid 1000 stayed (EACCES for the remote user).
      expect(devFolders(repo, mounts, identities)).toEqual([]);
      fixAll(repo, [`${repo}/data`, ...devFolders(repo, mounts, identities)]);
      for (const name of ['.', 'src', 'src/a.ts', 'src/lib', 'src/lib/b.ts']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
      for (const name of ['data', 'data/PG_VERSION']) expect(uidOf(path.join(repo, name)), name).toBe(999);
    });
  });
});

describe.skipIf(process.getuid?.() !== 0)('review round 11 (G5): over the bound, the ownership fix changes only the files of root, with real tools as root', () => {
  const uidOf = (file: string) => fs.lstatSync(file).uid;
  const nobody = Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim());

  it('gives the files of root their owner, and leaves the files of every other owner alone', () => {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['src', 'data/host-7/base', 'other']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['src/a.ts', 'data/host-7/PG_VERSION', 'data/host-7/base/1', 'other/f', 'top.txt']) fs.writeFileSync(path.join(repo, file), 'x');
    // The data of a service in a path beyond the bound (uid 999), and a file of another user (uid 1234).
    for (const file of ['data/host-7', 'data/host-7/PG_VERSION', 'data/host-7/base', 'data/host-7/base/1']) fs.chownSync(path.join(repo, file), 999, 999);
    fs.chownSync(path.join(repo, 'other/f'), 1234, 1234);
    const folders = Array.from({ length: MAX_SERVICE_FOLDERS + 1 }, (_, i) => `${repo}/data/host-${i + 1000}`);
    const [file, ...args] = ownershipFix(repo, 'nobody', folders);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // Before: a list over the bound was passed whole (and host-7, which it no longer names, was given to nobody).
    for (const name of ['.', 'src', 'src/a.ts', 'data', 'other', 'top.txt']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
    for (const name of ['data/host-7', 'data/host-7/PG_VERSION', 'data/host-7/base', 'data/host-7/base/1']) expect(uidOf(path.join(repo, name)), name).toBe(999);
    expect(uidOf(path.join(repo, 'other/f'))).toBe(1234);
    // The same with 'repository' (Environment.serviceFoldersOverflow).
    fs.chownSync(path.join(repo, 'top.txt'), 0, 0);
    const [again, ...againArgs] = ownershipFix(repo, 'nobody', 'repository');
    expect(spawnSync(again, againArgs, { encoding: 'utf8' }).status).toBe(0);
    expect(uidOf(path.join(repo, 'top.txt'))).toBe(nobody);
    expect(uidOf(path.join(repo, 'data/host-7/PG_VERSION'))).toBe(999);
  });
});

describe.skipIf(process.getuid?.() !== 0)('review round 15 (K4 = D15-2): a mount of the dev container in .git, with real tools as root', () => {
  const uidOf = (file: string) => fs.lstatSync(file).uid;
  const nobody = Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim());

  it('leaves the files of db in a volume at .git/pg alone, and gives the rest of .git the full fix', () => {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['.git/objects/ab', '.git/pg/base', 'src']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['.git/HEAD', '.git/objects/ab/cd', '.git/pg/PG_VERSION', '.git/pg/base/1', 'src/a.ts']) fs.writeFileSync(path.join(repo, file), 'x');
    // Postgres (uid 999) in the volume that db shares; a file of another user in .git (for example after a change of the
    // uid of the remote user), which the full fix gives the user.
    for (const file of ['.git/pg', '.git/pg/base', '.git/pg/base/1', '.git/pg/PG_VERSION']) fs.chownSync(path.join(repo, file), 999, 999);
    fs.chownSync(path.join(repo, '.git/objects/ab/cd'), 1234, 1234);
    // The paths as withDevMountFolders passes them (devMountFolders of the mounts of the dev container), with gitPaths.
    const [file, ...args] = ownershipFix(repo, 'nobody', [`${repo}/.git/pg`], true);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    for (const name of ['.git/pg', '.git/pg/base', '.git/pg/base/1', '.git/pg/PG_VERSION']) expect(uidOf(path.join(repo, name)), name).toBe(999);
    for (const name of ['.', '.git', '.git/HEAD', '.git/objects', '.git/objects/ab', '.git/objects/ab/cd', 'src/a.ts']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
    // Without gitPaths (the records of the services), the path in .git is dropped as before (review round 10, D10-3).
    expect(ownershipFix(repo, 'nobody', [`${repo}/.git/pg`])).toEqual(['sh', '-c', OWNERSHIP_FIX_SCRIPT, 'sh', repo, 'nobody']);
  });
});

describe.skipIf(process.getuid?.() !== 0)('review round 16 (L2 = D16-2): a mount of the dev container at a link into .git, with real tools as root', () => {
  const uidOf = (file: string) => fs.lstatSync(file).uid;
  const nobody = Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim());
  const PG = ['.git/pg', '.git/pg/base', '.git/pg/base/1', '.git/pg/PG_VERSION'];

  /** A repository with the data of db (uid 999) in .git/pg, a link `data -> .git/pg`, and a file of root in .git. */
  function repository(): string {
    const repo = path.join(tempDir(), 'api');
    for (const folder of ['.git/pg/base', '.git/objects', 'src']) fs.mkdirSync(path.join(repo, folder), { recursive: true });
    for (const file of ['.git/HEAD', '.git/objects/x', '.git/pg/PG_VERSION', '.git/pg/base/1', 'src/a.ts']) fs.writeFileSync(path.join(repo, file), 'x');
    fs.symlinkSync('.git/pg', path.join(repo, 'data'));
    for (const file of PG) fs.chownSync(path.join(repo, file), 999, 999);
    return repo;
  }

  function run(command: string[]): void {
    const [file, ...args] = command;
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }

  it('keeps the owner of the data behind the link, when the target of the mount names the link (probe of D16-2)', () => {
    const repo = repository();
    // The target of the mount as withDevMountFolders passes it: marked as a mount (before: 999 -> nobody).
    run(ownershipFix(repo, 'nobody', [`${repo}/data`], new Set([`${repo}/data`])));
    for (const name of PG) expect(uidOf(path.join(repo, name)), name).toBe(999);
    for (const name of ['.git/HEAD', '.git/objects/x', 'src/a.ts']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
  });

  it('marks each mount on its own: a path of the services behind a link into .git still gets no real path there', () => {
    const repo = repository();
    fs.mkdirSync(path.join(repo, 'cache'));
    fs.writeFileSync(path.join(repo, 'cache/c'), 'x');
    fs.chownSync(path.join(repo, 'cache/c'), 999, 999);
    // `data` is a path of the services (a record), `cache` the target of a mount of the dev container, in one list.
    run(ownershipFix(repo, 'nobody', [`${repo}/data`, `${repo}/cache`], new Set([`${repo}/cache`])));
    expect(uidOf(path.join(repo, 'cache/c'))).toBe(999);
    // The real path of the record lies in .git: not protected (review round 10, D10-3), as before.
    for (const name of PG) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
  });

  it('writes the marker only around the patterns of the mounts', () => {
    const repo = '/workspaces/api';
    expect(servicePathArguments(repo, [`${repo}/db`, `${repo}/data`], new Set([`${repo}/data`]))).toEqual([
      '-path', `${repo}/db`, '-o', '-path', `${repo}/db/*`,
      '-o', '(', '-path', `${repo}/data`, '-o', '-path', `${repo}/data/*`, ')',
    ]);
    // A path of the services named `(` or `)` below the repository is a path, never a marker.
    expect(servicePathArguments(repo, [`${repo}/(`], new Set())).toEqual(['-path', `${repo}/(`, '-o', '-path', `${repo}/(/*`]);
  });

  it('has valid sh syntax, and dash syntax where dash exists', () => {
    for (const shell of hasDash ? ['sh', 'dash'] : ['sh']) {
      expect(spawnSync(shell, ['-n', '-c', OWNERSHIP_FIX_SCRIPT], { encoding: 'utf8' }).status, shell).toBe(0);
    }
  });
});

describe('review round 15 (K3): the ownership fix of the internal folder with numeric IDs, for a helper container', () => {
  it('takes only decimal user and group IDs', () => {
    for (const id of ['0', '1000', '999', '4294967294']) expect(isNumericId(id), id).toBe(true);
    for (const id of ['', ' 1000', '1000\n', '-1', '+1', '01', '1e3', '0x10', 'vscode', '4294967295', '99999999999', '1000:1000']) expect(isNumericId(id), id).toBe(false);
    expect(configOwnershipFixCommand('/workspaces/.devenv+', '1000', '1001')).toEqual(['sh', '-c', CONFIG_OWNERSHIP_FIX_SCRIPT, 'sh', '/workspaces/.devenv+', '1000', '1001']);
    expect(() => configOwnershipFixCommand('/workspaces/.devenv+', 'vscode', '1000')).toThrow();
    expect(() => configOwnershipFixCommand('/workspaces/.devenv+', '1000', '$(reboot)')).toThrow();
  });

  it('has valid sh syntax, and dash syntax where dash exists', () => {
    for (const shell of hasDash ? ['sh', 'dash'] : ['sh']) {
      const result = spawnSync(shell, ['-n', '-c', CONFIG_OWNERSHIP_FIX_SCRIPT], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  });

  it('refuses a link or a missing folder in place of the folder', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    for (const folder of [path.join(root, 'link'), path.join(root, 'missing')]) {
      const [file, ...args] = configOwnershipFixCommand(folder, String(os.userInfo().uid), String(os.userInfo().gid));
      const result = spawnSync(file, args, { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not a folder');
    }
  });
});

describe('plan step 11G1: the ownership fix of the repository with numeric IDs, for a step of the batch helper', () => {
  const REPO = '/workspaces/api';

  it('takes only decimal user and group IDs, and the paths of the services as servicePathArguments builds them', () => {
    expect(repositoryOwnershipFixCommand(REPO, '1000', '1001')).toEqual(['sh', '-c', NUMERIC_OWNERSHIP_FIX_SCRIPT, 'sh', REPO, '1000', '1001']);
    // Review round 3 of PR #114 (A3-M1): changed expectation, with paths of services (a resumed clone) the script of a
    // resumed clone (`-execdir` in every branch).
    expect(repositoryOwnershipFixCommand(REPO, '1000', '1001', [`${REPO}/pgdata`])).toEqual([
      'sh',
      '-c',
      RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT,
      'sh',
      REPO,
      '1000',
      '1001',
      ...servicePathArguments(REPO, [`${REPO}/pgdata`]),
    ]);
    expect(repositoryOwnershipFixCommand(REPO, '1000', '1001', 'repository').slice(-5)).toEqual(['-path', REPO, '-o', '-path', `${REPO}/*`]);
    for (const [uid, gid] of [
      ['vscode', '1000'],
      ['1000', '$(reboot)'],
      ['', '1000'],
      ['1000', '-1'],
      ['1000:1000', '1000'],
    ]) {
      expect(() => repositoryOwnershipFixCommand(REPO, uid, gid), `${uid}:${gid}`).toThrow('Invalid user or group ID');
    }
  });

  it('uses the same service_owner_fix as the other fixes, with numbers in place of `id`', () => {
    expect(NUMERIC_OWNERSHIP_FIX_SCRIPT).not.toMatch(/\bid -[ug]\b/);
    expect(NUMERIC_OWNERSHIP_FIX_SCRIPT).toContain('service_owner_fix "$dir" "$uid" "$gid" "$uid:$gid" "$@"');
    const finds = NUMERIC_OWNERSHIP_FIX_SCRIPT.split('\n').filter((line) => /^\s*find "\$folder"/.test(line));
    expect(finds).toHaveLength(3);
    // Review round 1 of PR #114 (A-M1): changed expectation (before: `-exec chown -h`): the batch helper's fix runs chown in
    // the folder that find has open (`-execdir`), so a folder of the path replaced by a link meanwhile is not followed.
    // Review round 2 of PR #114 (A2-M1): changed expectation, the branch without paths of services (a new clone, on which no
    // service has run) keeps `-exec` (one chown for many files; `-execdir` runs one per folder).
    const [whole, withPaths, withoutPaths] = finds;
    for (const line of [whole, withPaths]) expect(line).toMatch(/^\s*find "\$folder" -xdev .* -execdir chown -h -- "\$fix_owner" \{\} \+$/);
    expect(withPaths).toContain('"$@"');
    expect(withoutPaths).not.toContain('"$@"');
    expect(withoutPaths).toMatch(/^\s*find "\$folder" -xdev .* -exec chown -h "\$fix_owner" \{\} \+$/);
  });

  it('has valid sh syntax, and dash syntax where dash exists', () => {
    for (const shell of hasDash ? ['sh', 'dash'] : ['sh']) {
      const result = spawnSync(shell, ['-n', '-c', NUMERIC_OWNERSHIP_FIX_SCRIPT], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  });

  it('refuses a link or a missing folder in place of the repository folder', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'file'), 'x');
    for (const folder of [path.join(root, 'link'), path.join(root, 'missing'), path.join(root, 'file')]) {
      const [file, ...args] = repositoryOwnershipFixCommand(folder, String(os.userInfo().uid), String(os.userInfo().gid));
      const result = spawnSync(file, args, { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not a folder');
    }
  });

  it('runs and changes nothing when every file has the user and the group', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'file.txt'), 'x');
    const [file, ...args] = repositoryOwnershipFixCommand(dir, String(os.userInfo().uid), String(os.userInfo().gid), [`${dir}/sub`]);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.statSync(path.join(dir, 'sub', 'file.txt')).uid).toBe(os.userInfo().uid);
  });

  it.skipIf(process.getuid?.() !== 0)('as root: gives the files the IDs; in a path of a service only the files of root', () => {
    const repo = path.join(tempDir(), 'api');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'pgdata'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'x');
    fs.writeFileSync(path.join(repo, 'pgdata', 'PG_VERSION'), '16');
    fs.writeFileSync(path.join(repo, 'pgdata', 'root-file'), 'x');
    fs.chownSync(path.join(repo, 'pgdata', 'PG_VERSION'), 999, 999);
    const [file, ...args] = repositoryOwnershipFixCommand(repo, '1234', '2345', [`${repo}/pgdata`]);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const owner = (name: string) => {
      const stat = fs.lstatSync(path.join(repo, name));
      return `${stat.uid}:${stat.gid}`;
    };
    expect(['.', 'src', 'src/a.ts', 'pgdata/root-file'].map(owner)).toEqual(['1234:2345', '1234:2345', '1234:2345', '1234:2345']);
    expect(owner('pgdata/PG_VERSION')).toBe('999:999');
  });
});

const canBindMount =
  process.getuid?.() === 0 && spawnSync('unshare', ['-m', 'sh', '-c', 'mount --bind "$1" "$1"', 'sh', os.tmpdir()], { stdio: 'ignore' }).status === 0;

describe.skipIf(!canBindMount)('review round 15 (K3): a mount of the dev container through a link does not reach the fix of the internal folder (real mounts as root)', () => {
  const uidOf = (file: string) => fs.lstatSync(file).uid;
  const nobody = Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim());
  const nobodyGroup = Number(spawnSync('id', ['-g', 'nobody'], { encoding: 'utf8' }).stdout.trim());

  it('gives the token the user in the helper, while in the dev container the data of db (uid 999) would have been walked', () => {
    // The workspace volume as the helper mounts it: the internal folder with the token (root, written before `up`), and
    // the repository with a link x -> ../.devenv+. The data of db (uid 999) in a volume of its own.
    const root = tempDir();
    const volume = path.join(root, 'workspaces');
    const config = path.join(volume, '.devenv+');
    const pgdata = path.join(root, 'pgdata');
    fs.mkdirSync(path.join(config, 'gh'), { recursive: true });
    fs.mkdirSync(path.join(volume, 'api'), { recursive: true });
    fs.writeFileSync(path.join(config, 'github-token'), 'x');
    fs.writeFileSync(path.join(config, 'gh', 'hosts.yml'), 'x');
    fs.symlinkSync('../.devenv+', path.join(volume, 'api', 'x'));
    fs.mkdirSync(path.join(pgdata, 'base'), { recursive: true });
    fs.writeFileSync(path.join(pgdata, 'PG_VERSION'), '16');
    const pgFiles = ['.', 'base', 'PG_VERSION'].map((name) => path.join(pgdata, name));
    for (const file of pgFiles) fs.chownSync(file, 999, 999);

    // The dev container: a volume mounted at /workspaces/api/x, which the kernel resolves through the link into the
    // internal folder. The fix there (before this round: OWNERSHIP_FIX_SCRIPT in the dev container) walks the data of db.
    const devFix = spawnSync(
      'unshare',
      ['-m', 'sh', '-c', 'mount --bind "$1" "$2" && shift 2 && exec sh -c "$@"', 'sh', pgdata, path.join(volume, 'api', 'x'), OWNERSHIP_FIX_SCRIPT, 'sh', config, 'nobody'],
      { encoding: 'utf8' },
    );
    expect(devFix.status, devFix.stderr).toBe(0);
    for (const file of pgFiles) expect(uidOf(file), file).toBe(nobody);
    for (const file of pgFiles) fs.chownSync(file, 999, 999);

    // The helper: only the workspace volume (here: no mount of the dev container in its mount namespace).
    const [file, ...args] = configOwnershipFixCommand(config, String(nobody), String(nobodyGroup));
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    for (const name of ['.', 'github-token', 'gh', 'gh/hosts.yml']) expect(uidOf(path.join(config, name)), name).toBe(nobody);
    for (const pg of pgFiles) expect(uidOf(pg), pg).toBe(999);
  });
});

describe.skipIf(!canBindMount)('review round 3 of PR #81: the ownership fix without paths of the services, with real tools and mounts as root', () => {
  const nobody = Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim());

  /** Runs OWNERSHIP_FIX_SCRIPT for `repo` and user nobody (no paths of the services) after `setup`, in a mount namespace; prints the uid of each of `files`. */
  function fixAndStat(repo: string, setup: string, files: string[]): string[] {
    const script = `${setup}\nsh -c "$1" sh "$2" nobody || exit 1\nshift 2\nfor f do stat -c %u "$f"; done`;
    const result = spawnSync('unshare', ['-m', 'sh', '-c', script, 'sh', OWNERSHIP_FIX_SCRIPT, repo, ...files], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout.trim().split('\n');
  }

  it('gives a link of the repository the user, never its target outside (review round 3 of PR #81, B-R3-1)', () => {
    const root = tempDir();
    const repo = path.join(root, 'api');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(root, 'secret'), 'x');
    fs.symlinkSync('../secret', path.join(repo, 'x'));
    // Before (chown without -h): the target, a file of root outside the repository (such as /etc/sudoers), got the user.
    expect(fixAndStat(repo, ':', [path.join(repo, 'x'), path.join(root, 'secret')])).toEqual([String(nobody), '0']);
  });

  it('leaves the files of another file system mounted in the repository alone (review round 3 of PR #81, B-R3-2)', () => {
    const repo = path.join(tempDir(), 'api');
    fs.mkdirSync(path.join(repo, 'mnt'), { recursive: true });
    // Before (find without -xdev): the file of root in the tmpfs got the user.
    expect(fixAndStat(repo, 'mount -t tmpfs devenv "$2/mnt" && touch "$2/mnt/f" || exit 1', [repo, path.join(repo, 'mnt/f')])).toEqual([String(nobody), '0']);
  });
});

describe('hardening (LC_ALL), review round 2 of PR #84: GIT_SUMMARY_SCRIPT runs Git in the C locale', () => {
  it('hardening (LC_ALL): the script exports LC_ALL=C and LANG=C at its start, before any other command', () => {
    const lines = GIT_SUMMARY_SCRIPT.split('\n');
    expect(lines[0]).toBe('set -eu');
    expect(lines[1]).toBe('export LC_ALL=C LANG=C');
    // Set in the script itself, never as an argument or through `-e`: the command is the script and its parameters.
    // user decision 2026-10-02: Delete runs no Git (the script has one mode, the poll mode; no `complete` argument).
    // Plan step 11I (PR B): changed expectation, the command of the registry (gitSummaryCommand is removed), the same one.
    expect(scriptCommand('gitSummary', ['/workspaces/api'])).toEqual(['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', '/workspaces/api']);
  });

  it('hardening (LC_ALL): every Git call of the script sees LC_ALL=C and LANG=C, whatever locale the caller has', () => {
    const root = tempDir();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(root, 'log');
    // A stub of git that records its locale variables, and exits 0 without output.
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s %s\\n' "\${LC_ALL-unset}" "\${LANG-unset}" >> '${log}'\n`, { mode: 0o755 });
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: also the complete mode).
    const [file, ...args] = scriptCommand('gitSummary', [repo]);
    const result = spawnSync(file, args, {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', LANGUAGE: 'de' },
    });
    expect(result.status).toBe(0);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) expect(call).toBe('C C');
  });
});

/** Whether every folder above `folder` can be passed by other users (for a run as another uid). */
function passableForOthers(folder: string): boolean {
  for (let dir = path.dirname(folder); ; dir = path.dirname(dir)) {
    if ((fs.statSync(dir).mode & 0o001) === 0) return false;
    if (dir === path.dirname(dir)) return true;
  }
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const hasSetpriv = hasProgram('setpriv', ['--version']);

/**
 * Review round 1 of PR #84, A-R1-2: the real script as another user (uid 1000) who owns the repository, as `docker
 * exec` runs it in the dev container as `remoteUser` (needs root, setpriv and Git). User decision 2026-10-02: Delete runs
 * no Git, so only the poll mode of the script is left; its counts are tested here.
 */
describe.skipIf(!hasGit || !isRoot || !hasSetpriv)('GIT_SUMMARY_SCRIPT as the repository owner (review round 1 of PR #84, A-R1-2)', () => {
  function ownerRepo(): string | undefined {
    const base = fs.mkdtempSync(path.join(fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir(), 'devenv-owner-'));
    tempDirs.push(base);
    fs.chmodSync(base, 0o755);
    if (!passableForOthers(base)) return undefined;
    const repo = path.join(base, 'repo');
    git(base, 'init', '-q', '-b', 'main', repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
    spawnSync('chown', ['-R', '1000:1000', repo]);
    return repo;
  }

  function runAsOwner(repo: string): { status: number | null; stdout: string; stderr: string } {
    const [file, ...args] = scriptCommand('gitSummary', [repo]);
    const result = spawnSync('setpriv', ['--reuid', '1000', '--regid', '1000', '--clear-groups', '--', file, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Review round 2 of PR #84, A-R2-1: the repository of the reproduction: 1 unpushed commit on `feature` (main is on
   * origin/main), and 2 stashes; the owner reads `main / 0 / 1 / 2`.
   */
  function stashRepo(): string | undefined {
    const repo = ownerRepo();
    if (repo === undefined) return undefined;
    // The repository is the owner's already (ownerRepo); root's Git needs safe.directory for it.
    const sgit = (cwd: string, ...args: string[]) => git(cwd, '-c', 'safe.directory=*', ...args);
    sgit(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    sgit(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    sgit(repo, 'add', 'b.txt');
    sgit(repo, 'commit', '-q', '-m', 'second');
    sgit(repo, 'checkout', '-q', 'main');
    for (const line of ['x', 'y']) {
      fs.appendFileSync(path.join(repo, 'a.txt'), `${line}\n`);
      sgit(repo, 'stash', '-q');
    }
    spawnSync('chown', ['-R', '1000:1000', repo]);
    return repo;
  }

  it('review round 2 of PR #84, A-R2-1: the baseline reads main / 0 / 1 / 2', () => {
    const repo = stashRepo();
    if (repo === undefined) return;
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: both modes).
    const result = runAsOwner(repo);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 1, stashes: 2 });
  });

  /**
   * Review round 2 of PR #84, B-R2-1: a repository of the owner with 2 commits on main, and `origin/main` at the first.
   */
  function remoteTrackingRepo(): string | undefined {
    const repo = ownerRepo();
    if (repo === undefined) return undefined;
    const sgit = (cwd: string, ...args: string[]) => git(cwd, '-c', 'safe.directory=*', ...args);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    sgit(repo, 'add', 'b.txt');
    sgit(repo, 'commit', '-q', '-m', 'second');
    sgit(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    spawnSync('chown', ['-R', '1000:1000', repo]);
    return repo;
  }

  it('review round 2 of PR #84, B-R2-1: a healthy repository with a remote-tracking ref counts its unpushed commit', () => {
    const repo = remoteTrackingRepo();
    if (repo === undefined) return;
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: both modes).
    const result = runAsOwner(repo);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 1, stashes: 0 });
  });

  /** Review round 3 of PR #84: Git as root on a repository of the owner (safe.directory), then the owner gets it back. */
  const rootGit = (cwd: string, ...args: string[]) => git(cwd, '-c', 'safe.directory=*', '-c', 'protocol.file.allow=always', ...args);
  const giveToOwner = (folder: string) => spawnSync('chown', ['-R', '1000:1000', folder]);

  for (const unborn of [false, true]) {
    // review round 4 of PR #84, A-R4-1: tags fetched by the clone made untouched clones show unpushed commits; tag-only commits are out of scope
    it(`review round 4 of PR #84, A-R4-1: a commit that only a tag reaches is not counted as unpushed (${unborn ? 'unborn HEAD' : 'HEAD with commits'})`, () => {
      const repo = remoteTrackingRepo();
      if (repo === undefined) return;
      rootGit(repo, 'checkout', '-q', '--detach');
      fs.writeFileSync(path.join(repo, 't.txt'), 't\n');
      rootGit(repo, 'add', 't.txt');
      rootGit(repo, 'commit', '-q', '-m', 'tagged');
      rootGit(repo, 'tag', 'v1');
      rootGit(repo, 'checkout', '-q', unborn ? '--orphan' : 'main', ...(unborn ? ['fresh'] : []));
      if (unborn) rootGit(repo, 'rm', '-q', '-r', '--cached', '.');
      if (unborn) for (const file of ['a.txt', 'b.txt', 't.txt']) fs.rmSync(path.join(repo, file), { force: true });
      giveToOwner(repo);
      // user decision 2026-10-02: Delete runs no Git (the poll mode; before: the complete mode of Delete's check).
      const result = runAsOwner(repo);
      expect(result.status).toBe(0);
      // review round 4 of PR #84, A-R4-1: tags fetched by the clone made untouched clones show unpushed commits; tag-only commits are out of scope
      // main has 1 commit that origin/main lacks; the commit that only the tag reaches is not counted.
      expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({ uncommittedFiles: 0, unpushedCommits: 1, stashes: 0 });
    });
  }

  it('review round 4 of PR #84, A-R4-1: a fresh clone of an upstream whose tag sits on a deleted branch reports 0 unpushed commits', () => {
    const repo = ownerRepo();
    if (repo === undefined) return;
    const upstream = repo;
    rootGit(upstream, 'checkout', '-q', '-b', 'release');
    fs.writeFileSync(path.join(upstream, 'r.txt'), 'r\n');
    rootGit(upstream, 'add', 'r.txt');
    rootGit(upstream, 'commit', '-q', '-m', 'release');
    rootGit(upstream, 'tag', 'v1');
    rootGit(upstream, 'checkout', '-q', 'main');
    rootGit(upstream, 'branch', '-q', '-D', 'release');
    // The upstream belongs to root, so that root's clone reads it (safe.directory does not reach upload-pack).
    spawnSync('chown', ['-R', '0:0', upstream]);
    const clone = path.join(path.dirname(upstream), 'clone');
    rootGit(path.dirname(upstream), 'clone', '-q', upstream, clone);
    // The clone has the tag (and so the commit of the deleted branch), but no remote branch contains it.
    expect(rootGit(clone, 'tag', '--list').trim()).toBe('v1');
    giveToOwner(clone);
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: both modes).
    const result = runAsOwner(clone);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0 });
  });

  it('review round 4 of PR #84, A-R4-2: a stash whose reflog was expired still counts as 1 stash; after `git stash clear` 0', () => {
    const repo = stashRepo();
    if (repo === undefined) return;
    rootGit(repo, 'reflog', 'expire', '--expire=now', '--all');
    giveToOwner(repo);
    // Git's own listing shows no stash any more, while refs/stash still names one.
    expect(rootGit(repo, 'stash', 'list')).toBe('');
    expect(rootGit(repo, 'rev-parse', '-q', '--verify', 'refs/stash').trim()).not.toBe('');
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: both modes).
    const result = runAsOwner(repo);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({ branch: 'main', uncommittedFiles: 0, stashes: 1 });
    rootGit(repo, 'stash', 'clear');
    giveToOwner(repo);
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: both modes).
    const cleared = runAsOwner(repo);
    expect(cleared.status).toBe(0);
    expect(parseGitSummaryOutput(cleared.stdout, RECORDED_AT)).toMatchObject({ stashes: 0 });
  });

  it('review round 3 of PR #84, B-R3-1: a stash whose object is deleted makes `git stash list` fail: the script exits non-zero', () => {
    const repo = stashRepo();
    if (repo === undefined) return;
    const id = rootGit(repo, 'rev-parse', 'refs/stash').trim();
    const object = path.join(repo, '.git', 'objects', id.slice(0, 2), id.slice(2));
    expect(fs.existsSync(object)).toBe(true);
    fs.rmSync(object);
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: both modes).
    const result = runAsOwner(repo);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('review round 5 of PR #84: log.showSignature and gpg.program of the repository configuration do not run a program', () => {
    const repo = ownerRepo();
    if (repo === undefined) return;
    const out = path.join(path.dirname(repo), 'out');
    fs.mkdirSync(out);
    spawnSync('chown', ['1000:1000', out]);
    const ran = path.join(out, 'ran');
    const stub = path.join(path.dirname(repo), 'fake-gpg');
    fs.writeFileSync(stub, `#!/bin/sh\nid -u >> '${ran}'\nexit 1\n`, { mode: 0o755 });
    fs.chmodSync(stub, 0o755);
    // A stash commit with a signature header (never verified: the stub fails), named by refs/stash and its reflog.
    const tree = rootGit(repo, 'rev-parse', 'HEAD^{tree}').trim();
    const parent = rootGit(repo, 'rev-parse', 'HEAD').trim();
    const commit = `tree ${tree}\nparent ${parent}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nWIP on main\n`;
    const hashed = spawnSync('git', ['-c', 'safe.directory=*', 'hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: repo,
      input: commit,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    });
    expect(hashed.status).toBe(0);
    rootGit(repo, 'update-ref', '--create-reflog', '-m', 'WIP on main', 'refs/stash', hashed.stdout.trim());
    rootGit(repo, 'config', 'log.showSignature', 'true');
    rootGit(repo, 'config', 'gpg.program', stub);
    giveToOwner(repo);
    // The setup is live: Git's own `git stash list` runs the stub.
    rootGit(repo, 'stash', 'list');
    expect(fs.existsSync(ran)).toBe(true);
    fs.rmSync(ran);
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: both modes).
    const result = runAsOwner(repo);
    expect(result.status).toBe(0);
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({ branch: 'main', stashes: 1 });
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('review round 5 of PR #84, B-R5-1: a commit on a detached HEAD that no branch holds counts as unpushed, with an empty branch', () => {
    const repo = ownerRepo();
    if (repo === undefined) return;
    rootGit(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    rootGit(repo, 'checkout', '-q', '--detach');
    fs.writeFileSync(path.join(repo, 'd.txt'), 'd\n');
    rootGit(repo, 'add', 'd.txt');
    rootGit(repo, 'commit', '-q', '-m', 'detached');
    giveToOwner(repo);
    // user decision 2026-10-02: Delete runs no Git (only the poll mode is left; before: both modes).
    const result = runAsOwner(repo);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('');
    expect(parseGitSummaryOutput(result.stdout, RECORDED_AT)).toMatchObject({ branch: null, uncommittedFiles: 0, unpushedCommits: 1, stashes: 0 });
  });

});

describe.skipIf(process.getuid?.() !== 0)('review round 2 of PR #114 (A2-M1): the fix before the create after a new clone, with real tools as root', () => {
  // Review round 3 of PR #114 (A3-L1): its own time limit (the setup of 3000 folders is synchronous).
  it('gives every file of a repository with many folders its owner quickly (one chown for many files, not one per folder)', { timeout: 60_000 }, () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-many-'));
    try {
      const repository = path.join(folder, 'repo');
      for (let i = 0; i < 3000; i++) {
        const dir = path.join(repository, `d${Math.floor(i / 100)}`, `e${i}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'f'), 'x');
      }
      const started = Date.now();
      const [file, ...args] = repositoryOwnershipFixCommand(repository, '4242', '4343');
      const result = spawnSync(file, args, { encoding: 'utf8', timeout: 60_000 });
      const seconds = (Date.now() - started) / 1000;
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const sample = fs.statSync(path.join(repository, 'd29', 'e2999', 'f'));
      expect([sample.uid, sample.gid]).toEqual([4242, 4343]);
      // `-execdir … +` took about 11 s for 3000 folders here; `-exec … +` a fraction of a second.
      expect(seconds).toBeLessThan(5);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('review round 3 of PR #114 (A3-M1): the fix of a resumed clone', () => {
  it('uses -execdir in every branch for a resumed clone, also with an empty list of paths of services; a new clone keeps -exec without paths', () => {
    const script = (folders?: ServiceFolders) => repositoryOwnershipFixCommand('/workspaces/repo', '1000', '1001', folders)[2];
    for (const folders of [[], ['/workspaces/repo/data'], 'repository'] as ServiceFolders[]) {
      expect(script(folders)).toBe(RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT);
      expect(script(folders)).not.toContain(' -exec chown');
    }
    expect(script(undefined)).toBe(NUMERIC_OWNERSHIP_FIX_SCRIPT);
    const finds = RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT.split('\n').filter((line) => /^\s*find "\$folder"/.test(line));
    expect(finds).toHaveLength(3);
    for (const line of finds) expect(line).toMatch(/ -execdir chown -h -- "\$fix_owner" \{\} \+$/);
  });
});

// Follow-up of plan step 11I (the links of the owner): the fixes of the batch helper give no owner to a file with a second
// hard link (its other name may be a file of another user elsewhere in the volume). A fake `chown` on PATH records the
// inode of each path that it gets (with `-execdir`, relative to the folder that find has open). The files belong to the
// test user, so all of them lack the user 4321: the branch without paths of services gives each one the owner.
const gnuFindForLinks = process.platform === 'linux' && /GNU findutils/.test(spawnSync('find', ['--version'], { encoding: 'utf8' }).stdout ?? '');
describe.runIf(gnuFindForLinks)('the ownership fixes of the batch helper and hard links (follow-up of plan step 11I)', () => {
  it.each([
    ['CONFIG_OWNERSHIP_FIX_SCRIPT', (folder: string) => configOwnershipFixCommand(folder, '4321', '4321')],
    ['NUMERIC_OWNERSHIP_FIX_SCRIPT', (folder: string) => repositoryOwnershipFixCommand(folder, '4321', '4321')],
    ['RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT', (folder: string) => repositoryOwnershipFixCommand(folder, '4321', '4321', [])],
  ] as const)('%s gives no owner to a file that has a second link', (_name, command) => {
    const base = tempDir();
    const folder = path.join(base, 'folder');
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(folder, 'single'), 'x');
    fs.writeFileSync(path.join(folder, 'sub', 'deep'), 'x');
    fs.writeFileSync(path.join(elsewhere, 'data'), 'x');
    fs.linkSync(path.join(elsewhere, 'data'), path.join(folder, 'sub', 'linked'));
    const bin = path.join(base, 'bin');
    const log = path.join(base, 'chowned');
    fs.mkdirSync(bin);
    fs.writeFileSync(log, '');
    fs.writeFileSync(
      path.join(bin, 'chown'),
      ['#!/bin/sh', "owner=''", 'for arg do', '  case "$arg" in', '    -h|--) ;;', '    *) if [ -z "$owner" ]; then owner=$arg; else stat -c %i -- "$arg" >> "$DEVENV_TEST_LOG"; fi ;;', '  esac', 'done', ''].join('\n'),
      { mode: 0o755 },
    );
    const [file, ...args] = command(folder);
    const result = spawnSync(file, args, { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, DEVENV_TEST_LOG: log } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const chowned = fs.readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map(Number);
    const ino = (file: string) => fs.lstatSync(file).ino;
    expect(chowned).not.toContain(ino(path.join(elsewhere, 'data')));
    for (const entry of [folder, path.join(folder, 'sub'), path.join(folder, 'single'), path.join(folder, 'sub', 'deep')]) expect(chowned, entry).toContain(ino(entry));
  });

  it('has the test of the links in every find of the fixes of the batch helper, and not in the fix of the dev container', () => {
    for (const script of [CONFIG_OWNERSHIP_FIX_SCRIPT, NUMERIC_OWNERSHIP_FIX_SCRIPT, RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT]) {
      const finds = script.split('\n').filter((line) => /^\s*find "\$folder"/.test(line));
      expect(finds).toHaveLength(3);
      for (const line of finds) expect(line).toMatch(/ \\\( -type d -o -links 1 \\\) -exec(dir)? chown -h /);
    }
    // The fix in the dev container keeps its test: a BusyBox find may lack -links.
    expect(OWNERSHIP_FIX_SCRIPT).not.toContain('-links');
  });
});
