// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_SUMMARY_SCRIPT,
  OWNERSHIP_FIX_SCRIPT,
  gitSummaryCommand,
  ownershipFixCommand,
  parseGitSummaryOutput,
} from './gitSummary';

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
  const [file, ...args] = gitSummaryCommand(folder);
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
  it('passes the folder as a positional parameter', () => {
    expect(gitSummaryCommand('/workspaces/it\'s "api"')).toEqual(['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', '/workspaces/it\'s "api"']);
    expect(ownershipFixCommand('/workspaces/api', 'vscode')).toEqual(['sh', '-c', OWNERSHIP_FIX_SCRIPT, 'sh', '/workspaces/api', 'vscode']);
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
    const [file, ...args] = ownershipFixCommand(dir, user);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.statSync(path.join(dir, 'sub', 'file.txt')).uid).toBe(os.userInfo().uid);
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

  it('counts unpushed commits on a local branch that is not checked out (Switch branch…)', () => {
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

  it('fails with a message for a folder that is not a repository', () => {
    const result = runSummary(tempDir());
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });
});
