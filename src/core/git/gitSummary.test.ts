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
  MAX_SERVICE_ARGUMENT_CHARACTERS,
  MAX_SERVICE_FOLDERS,
  MAX_SERVICE_PATH_DEPTH,
  MAX_SERVICE_PATH_LENGTH,
  MAX_SERVICE_REAL_PATHS,
  boundServiceFolders,
  gitSummaryCommand,
  ownershipFixCommand,
  parseGitSummaryOutput,
  serviceFolderPaths,
  servicePathArguments,
  servicePrunePatterns,
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
    // Review round 10 (D10-3): never .git or a path in it (Git writes there as root), also from a record written before.
    expect(servicePrunePatterns(REPO, [`${REPO}/.git`, `${REPO}/.git/objects`, `${REPO}/sub/.git`, `${REPO}/.github`, `${REPO}/x.git`])).toEqual([`${REPO}/.github`, `${REPO}/x.git`]);
    // Review round 11, G5: the command holds the ready arguments of find (servicePathArguments), not the patterns.
    expect(ownershipFixCommand(REPO, 'vscode', [`${REPO}/data/postgres`])).toEqual([
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
    const [file, ...args] = ownershipFixCommand(repo, 'someone', [`${repo}/data/postgres`, `${repo}/-data/my db`]);
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

describe.skipIf(process.getuid?.() !== 0)('review round 10 (D10-2, D10-3): the ownership fix in the paths that other services mount, with real tools as root', () => {
  function run(repo: string, user: string, folders: string[]): void {
    const [file, ...args] = ownershipFixCommand(repo, user, folders);
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
    const [, ...args] = ownershipFixCommand(repo, os.userInfo().username, Array.from({ length: MAX_SERVICE_FOLDERS }, (_, i) => `${repo}/data/host-${i}`));
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
    const [file, ...args] = ownershipFixCommand(repo, 'someone', folders);
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
        ...test([`${repo}/storage/pg`, `${repo}/storage/app.conf`, `${repo}/storage/pg`]),
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
    const [file, ...args] = ownershipFixCommand(repo, 'nobody', [`${repo}/.pgdata`, `${repo}/node_modules`]);
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
    const [file, ...args] = ownershipFixCommand(repo, 'nobody', folders);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // Before: a list over the bound was passed whole (and host-7, which it no longer names, was given to nobody).
    for (const name of ['.', 'src', 'src/a.ts', 'data', 'other', 'top.txt']) expect(uidOf(path.join(repo, name)), name).toBe(nobody);
    for (const name of ['data/host-7', 'data/host-7/PG_VERSION', 'data/host-7/base', 'data/host-7/base/1']) expect(uidOf(path.join(repo, name)), name).toBe(999);
    expect(uidOf(path.join(repo, 'other/f'))).toBe(1234);
    // The same with 'repository' (Environment.serviceFoldersOverflow).
    fs.chownSync(path.join(repo, 'top.txt'), 0, 0);
    const [again, ...againArgs] = ownershipFixCommand(repo, 'nobody', 'repository');
    expect(spawnSync(again, againArgs, { encoding: 'utf8' }).status).toBe(0);
    expect(uidOf(path.join(repo, 'top.txt'))).toBe(nobody);
    expect(uidOf(path.join(repo, 'data/host-7/PG_VERSION'))).toBe(999);
  });
});
