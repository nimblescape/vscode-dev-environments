// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1 (reviewer B, mutation testing): probes of the link script of the shared VS Code server
// (VSCODE_SERVER_LINK_SCRIPT) and of the reading of its output that no test held: a home folder that /etc/passwd names
// but that is no folder, the entry of exactly the user's ID, a failing `id -u`, and the first line only, at its start.
// Run as vscodeServerLink.test.ts runs it: the fixed paths of the script are replaced by paths of a temporary folder, the
// fake /etc/passwd maps every user to a folder of the sandbox, HOME points into the sandbox, and `uname`, `ldd` and `id`
// are fakes on the PATH; nothing is written outside the sandbox.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET } from '../names';
import { VSCODE_SERVER_LINK_SCRIPT, vscodeServerLinkOutcome } from './vscodeServerLink';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const shell = !spawnSync('dash', ['-c', 'true'], { stdio: 'ignore' }).error ? 'dash' : 'sh';
const UID = String(process.getuid?.() ?? 0);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A sandbox whose fake /etc/passwd has `lines` (each home must be in the sandbox), with the server in its store. */
function sandbox(lines: (root: string) => string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-link-probe-'));
  temps.push(root);
  const store = path.join(root, 'store');
  const server = path.join(store, 'server', 'stable', 'linux-x64', COMMIT);
  fs.mkdirSync(path.join(server, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(server, 'bin', 'code-server'), '');
  fs.writeFileSync(path.join(server, 'node'), '');
  const passwd = path.join(root, 'passwd');
  const entries = lines(root);
  // Every home of the fake passwd is in the sandbox.
  for (const line of entries) expect(line.split(':')[5].startsWith(`${root}/`)).toBe(true);
  fs.writeFileSync(passwd, `${entries.join('\n')}\n`);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  fake('uname', 'echo x86_64');
  fake('ldd', 'echo "ldd (GNU libc) 2.36"');
  fake('id', `if [ "$1" = -u ]; then if [ -n "\${FAKE_ID_FAILS:-}" ]; then exit 1; fi; echo ${UID}; else exec /usr/bin/id "$@"; fi`);
  const script = VSCODE_SERVER_LINK_SCRIPT.split(VSCODE_STORE_TARGET).join(store).split('/etc/passwd').join(passwd).split('/etc/alpine-release').join(path.join(root, 'alpine-release'));
  expect(script).not.toMatch(/\/etc\/|\/opt\/devenv/);
  return {
    root,
    server,
    run: (env: Record<string, string> = {}) => {
      const result = spawnSync(shell, ['-c', script, 'sh', COMMIT, 'stable', 'linux-x64'], {
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: path.join(root, 'no-home'), ...env },
        cwd: root,
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout };
    },
  };
}

describe('the link script, probes (review round 1 of 11H1, reviewer B)', () => {
  it('a home folder that /etc/passwd names but that is no folder: skipped, nothing created', () => {
    const s = sandbox((root) => [`vscode:x:${UID}:${UID}::${root}/home/missing:/bin/sh`]);
    expect(s.run()).toEqual({ status: 0, stdout: 'skipped: the user has no home folder\n' });
    expect(fs.existsSync(path.join(s.root, 'home'))).toBe(false);
  });

  it("takes the entry of exactly the user's ID, not the first entry of a larger one", () => {
    const larger = String(Number(UID) + 1000);
    const s = sandbox((root) => [`other:x:${larger}:${larger}::${root}/home/other:/bin/sh`, `vscode:x:${UID}:${UID}::${root}/home/vscode:/bin/sh`]);
    fs.mkdirSync(path.join(s.root, 'home', 'other'), { recursive: true });
    fs.mkdirSync(path.join(s.root, 'home', 'vscode'), { recursive: true });
    expect(s.run().stdout).toBe('linked\n');
    expect(fs.readlinkSync(path.join(s.root, 'home', 'vscode', '.vscode-server', 'bin', COMMIT))).toBe(s.server);
    expect(fs.readdirSync(path.join(s.root, 'home', 'other'))).toEqual([]);
  });

  it('a failing `id -u` is a failure of the script (non-zero), nothing created', () => {
    const s = sandbox((root) => [`vscode:x:${UID}:${UID}::${root}/home/vscode:/bin/sh`]);
    fs.mkdirSync(path.join(s.root, 'home', 'vscode'), { recursive: true });
    const result = s.run({ FAKE_ID_FAILS: '1' });
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(path.join(s.root, 'home', 'vscode'))).toEqual([]);
  });
});

describe('the outcome of the link, probes (review round 1 of 11H1, reviewer B)', () => {
  const ok = (stdout: string) => vscodeServerLinkOutcome({ exitCode: 0, stdout, stderr: '' });
  it('reads only the first line, from its start', () => {
    expect(ok('linked\nskipped: later\n')).toEqual({ kind: 'linked' });
    expect(ok('xskipped: the store does not have the server\n').kind).toBe('failed');
    expect(ok('not refused: a\n').kind).toBe('failed');
  });
});
