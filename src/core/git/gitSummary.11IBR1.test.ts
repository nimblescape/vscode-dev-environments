// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #124 (reviewer B): probes of the mutants of the Git scripts of the dev container
// (GIT_SCRIPT_PRELUDE, GIT_BRANCH_FUNCTION, GIT_BRANCH_SCRIPT of gitSummary.ts) that the tests of the PR leave alive.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvironmentDocker } from '../pipeline/environmentService';
import { readBranch } from '../pipeline/refreshStates';
import { scriptCommand } from '../worker/containerScripts';
import { parseGitSummaryOutput } from './gitSummary';

const hasGit = !spawnSync('git', ['--version'], { stdio: 'ignore', timeout: 10_000 }).error;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

describe('review round 1 of PR #124 (reviewer B): the Git scripts read the repository of their argument, or fail', () => {
  it.skipIf(!hasGit)('a repository folder that does not exist fails both scripts, also when the exec starts in another repository', async () => {
    // Kills `cd "$1" || :` in place of `cd "$1"` in GIT_SCRIPT_PRELUDE (GS18): the tests of the PR run the scripts in a
    // working directory that is no repository, so a failed `cd` that went on ran Git there and still failed. `docker exec`
    // starts in the WORKDIR of the image, which can be a repository (an image that copies its sources with `.git`): with
    // the mutant the sidebar and an open recorded the branch of that repository as the branch of the environment.
    const root = tempDir();
    const workdir = path.join(root, 'image-workdir');
    git(root, 'init', '-q', '-b', 'image-branch', workdir);
    fs.writeFileSync(path.join(workdir, 'a.txt'), 'a\n');
    git(workdir, 'add', 'a.txt');
    git(workdir, 'commit', '-q', '-m', 'first');
    const missing = path.join(root, 'workspaces', 'api');
    for (const name of ['branch', 'gitSummary'] as const) {
      const [, ...args] = scriptCommand(name, [missing]);
      const result = spawnSync('/bin/sh', args, { cwd: workdir, encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
      expect(result.error, name).toBeUndefined();
      expect(result.status, name).not.toBe(0);
      expect(result.stdout, name).toBe('');
    }
    // readBranch (the refresh, an attached window, the branch after an open) over an exec that starts there: no branch.
    const docker: Pick<EnvironmentDocker, 'exec'> = {
      exec: async (_container, command) => {
        const [, ...args] = command;
        const result = spawnSync('/bin/sh', args, { cwd: workdir, encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: result.error !== undefined };
      },
    };
    expect(await readBranch(docker, 'c', undefined, missing)).toBeUndefined();
  });

  it.skipIf(!hasGit)('the summary still counts when the branch cannot be read (Git fails both reads): an empty branch', () => {
    // Kills `${GIT_BRANCH_FUNCTION}git_branch` without `|| branch=''` in GIT_SUMMARY_SCRIPT (GS15). The doc comment
    // promises "a failed read of it is an empty branch here, as before, and the counts after it still decide whether the
    // script fails"; with the mutant a failed read ended the summary, and Delete's confirmation fell back to the recorded,
    // possibly stale counts (safetyCheck). A real Git fails both reads (128) while `git status` works when HEAD names a
    // ref that cannot be resolved (`ref: refs/heads/a..b`, `ref: refs/heads/`, a ref that links to itself; seen with Git
    // 2.43); a stub that fails both reads that way, else the real Git, keeps this probe independent of the Git version.
    const root = tempDir();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const real = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nfor a do\n  case "$a" in --show-current|symbolic-ref) echo 'fatal: No such ref: HEAD' >&2; exit 128 ;; esac\ndone\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
    const repo = path.join(root, 'api');
    git(root, 'init', '-q', '-b', 'main', repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    const env = { ...GIT_ENV, PATH: `${bin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}` };
    const [, ...summaryArgs] = scriptCommand('gitSummary', [repo]);
    const summary = spawnSync('/bin/sh', summaryArgs, { encoding: 'utf8', env, timeout: 30_000 });
    expect(summary.error).toBeUndefined();
    expect(summary.status).toBe(0);
    expect(parseGitSummaryOutput(summary.stdout, '2026-10-08T00:00:00.000Z')).toMatchObject({ branch: null, uncommittedFiles: 2, unpushedCommits: 1, stashes: 0 });
    // The branch read alone fails with Git's exit code (readBranch: undefined, so an open keeps the recorded branch).
    const [, ...branchArgs] = scriptCommand('branch', [repo]);
    const branch = spawnSync('/bin/sh', branchArgs, { encoding: 'utf8', env, timeout: 30_000 });
    expect(branch.status).toBe(128);
    expect(branch.stdout).toBe('');
  });
});

