// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3 (reviewer B, mutation testing): probes of the seed script (VSCODE_EXTENSION_SEED_SCRIPT) that no
// test pinned, run with the shell of this computer in a temporary folder as the 11H3 tests run it (the store,
// /etc/passwd and /etc/alpine-release are paths of the sandbox; `uname`, `ldd`, `id` and, for the races, `cp` are fakes on
// the PATH; HOME points into the sandbox, so nothing is written into a real home folder): /etc/alpine-release alone means
// musl; `amd64` is x64; only `universal` and the container's platform are folders it copies from; a name with a slash or
// a source that is a folder is skipped; CDPATH is ignored; and the races the script closes: a link planted at the
// temporary name is never written through (`cp -n`), and a file that appears at the final name is never replaced
// (`ln`). And the reading of its one line.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET } from '../names';
import { VSCODE_EXTENSION_SEED_SCRIPT, vscodeExtensionSeedOutcome } from './vscodeExtensionSeed';

const shell = !spawnSync('dash', ['-c', 'true'], { stdio: 'ignore' }).error ? 'dash' : 'sh';
const UID = String(process.getuid?.() ?? 0);
const REAL_CP = spawnSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim();

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  store: string;
  home: string;
  alpine: string;
  cache: string;
  bin: string;
  run(args: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-seed-pH3R1-'));
  temps.push(root);
  const store = path.join(root, 'store');
  const home = path.join(root, 'home', 'vscode');
  fs.mkdirSync(home, { recursive: true });
  const passwd = path.join(root, 'passwd');
  fs.writeFileSync(passwd, `vscode:x:${UID}:${UID}::${home}:/bin/sh\n`);
  const alpine = path.join(root, 'alpine-release');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  fake('uname', 'echo "${FAKE_MACHINE:-x86_64}"');
  fake('ldd', 'echo "ldd (GNU libc) 2.36"');
  fake('id', `if [ "$1" = -u ]; then echo "${UID}"; else exec /usr/bin/id "$@"; fi`);
  const script = VSCODE_EXTENSION_SEED_SCRIPT.split(VSCODE_STORE_TARGET).join(store).split('/etc/passwd').join(passwd).split('/etc/alpine-release').join(alpine);
  expect(script).not.toMatch(/\/etc\/|\/opt\/devenv/);
  for (const folder of ['universal', 'linux-x64', 'linux-arm64']) fs.mkdirSync(path.join(store, 'extensions', folder), { recursive: true });
  return {
    root,
    store,
    home,
    alpine,
    bin,
    cache: path.join(home, '.vscode-server', 'extensionsCache'),
    run: (args, env = {}) => {
      const result = spawnSync(shell, ['-c', script, 'sh', ...args], {
        env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: path.join(root, 'no-home'), ...env },
        cwd: root,
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

function cached(s: Sandbox, entry: string, content = `vsix of ${entry}`): string {
  fs.mkdirSync(path.dirname(path.join(s.store, 'extensions', entry)), { recursive: true });
  fs.writeFileSync(path.join(s.store, 'extensions', entry), content);
  return entry;
}

describe('the seed script: the platform and the folders (review round 1 of 11H3, reviewer B)', () => {
  it('/etc/alpine-release alone (an ldd that names glibc) means musl: universal files only', () => {
    const s = sandbox();
    fs.writeFileSync(s.alpine, '3.20.0\n');
    const files = [cached(s, 'universal/a.b-1.0.0'), cached(s, 'linux-x64/c.d-2.0.0-linux-x64')];
    expect(s.run(['stable', 'linux-x64', ...files]).stdout).toBe('seeded: 1 copied, 0 present, 1 skipped, 0 failed\n');
    expect(fs.readdirSync(s.cache)).toEqual(['a.b-1.0.0']);
  });

  it('uname amd64 is x64', () => {
    const s = sandbox();
    const files = [cached(s, 'universal/a.b-1.0.0'), cached(s, 'linux-x64/c.d-2.0.0-linux-x64')];
    expect(s.run(['stable', 'linux-x64', ...files], { FAKE_MACHINE: 'amd64' }).stdout).toBe('seeded: 2 copied, 0 present, 0 skipped, 0 failed\n');
  });

  it('copies only from universal and the container\'s platform; any other folder of the store is skipped', () => {
    const s = sandbox();
    const files = [cached(s, 'linux-arm64/c.d-2.0.0-linux-arm64'), cached(s, 'wanted/aaaaaaaaaa.json', '{"at":1}'), cached(s, 'tmp/e.f-1.0.0-0123456789ab')];
    expect(s.run(['stable', 'linux-x64', ...files]).stdout).toBe('seeded: 0 copied, 0 present, 3 skipped, 0 failed\n');
    expect(fs.readdirSync(s.cache)).toEqual([]);
  });

  it('a name with a slash, and a source that is a folder, are skipped (not failed)', () => {
    const s = sandbox();
    const nested = cached(s, 'universal/sub/a.b-1.0.0');
    fs.mkdirSync(path.join(s.store, 'extensions', 'universal', 'c.d-1.0.0'));
    expect(s.run(['stable', 'linux-x64', nested, 'universal/c.d-1.0.0']).stdout).toBe('seeded: 0 copied, 0 present, 2 skipped, 0 failed\n');
    expect(fs.readdirSync(s.cache)).toEqual([]);
  });

  it('ignores CDPATH of the image: the folders are entered relative to the home folder', () => {
    const s = sandbox();
    const other = path.join(s.root, 'other');
    fs.mkdirSync(path.join(other, '.vscode-server', 'extensionsCache'), { recursive: true });
    const entry = cached(s, 'universal/a.b-1.0.0');
    expect(s.run(['stable', 'linux-x64', entry], { CDPATH: other }).stdout).toBe('seeded: 1 copied, 0 present, 0 skipped, 0 failed\n');
    expect(fs.readdirSync(s.cache)).toEqual(['a.b-1.0.0']);
    expect(fs.readdirSync(path.join(other, '.vscode-server', 'extensionsCache'))).toEqual([]);
  });
});

describe('the seed script: the races it closes (review round 1 of 11H3, reviewer B)', () => {
  it.skipIf(REAL_CP === '')('a link planted at the temporary name right before the copy is never written through', () => {
    const s = sandbox();
    const victim = path.join(s.root, 'victim');
    fs.writeFileSync(victim, 'untouched');
    // The fake cp plants the link at its destination when that is the temporary name, then copies.
    fs.writeFileSync(
      path.join(s.bin, 'cp'),
      `#!/bin/sh\nfor last in "$@"; do :; done\ncase "$last" in .devenv-seed-*) ln -s "${victim}" "$last" ;; esac\nexec "${REAL_CP}" "$@"\n`,
      { mode: 0o755 },
    );
    const entry = cached(s, 'universal/a.b-1.0.0');
    expect(s.run(['stable', 'linux-x64', entry]).stdout).toBe('seeded: 0 copied, 0 present, 0 skipped, 1 failed\n');
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    expect(fs.readdirSync(s.cache)).toEqual([]);
  });

  it.skipIf(REAL_CP === '')('a file that appears at the final name after the check is never replaced', () => {
    const s = sandbox();
    // The fake cp copies, then puts a file of the container at the final name (the name without the temporary prefix).
    fs.writeFileSync(
      path.join(s.bin, 'cp'),
      `#!/bin/sh\nfor last in "$@"; do :; done\n"${REAL_CP}" "$@"\nrc=$?\ncase "$last" in .devenv-seed-*) echo planted > "\${last#.devenv-seed-*-}" ;; esac\nexit $rc\n`,
      { mode: 0o755 },
    );
    const entry = cached(s, 'universal/a.b-1.0.0');
    expect(s.run(['stable', 'linux-x64', entry]).stdout).toBe('seeded: 0 copied, 1 present, 0 skipped, 0 failed\n');
    expect(fs.readFileSync(path.join(s.cache, 'a.b-1.0.0'), 'utf8')).toBe('planted\n');
    expect(fs.readdirSync(s.cache)).toEqual(['a.b-1.0.0']);
  });
});

describe('the reading of its one line (review round 1 of 11H3, reviewer B)', () => {
  it('only the exact line counts, with at most six digits per number', () => {
    expect(vscodeExtensionSeedOutcome({ exitCode: 0, stdout: 'xseeded: 1 copied, 0 present, 0 skipped, 0 failed\n', stderr: '' }).kind).toBe('failed');
    expect(vscodeExtensionSeedOutcome({ exitCode: 0, stdout: 'seeded: 1234567 copied, 0 present, 0 skipped, 0 failed\n', stderr: '' }).kind).toBe('failed');
  });

  it('a non-zero exit code is a failure whatever the output', () => {
    expect(vscodeExtensionSeedOutcome({ exitCode: 1, stdout: 'seeded: 1 copied, 0 present, 0 skipped, 0 failed\n', stderr: 'boom' })).toEqual({ kind: 'failed', reason: 'exit code 1: boom' });
  });

  it('a long reason is clipped', () => {
    const outcome = vscodeExtensionSeedOutcome({ exitCode: 0, stdout: `refused: ${'x'.repeat(400)}\n`, stderr: '' });
    expect(outcome).toEqual({ kind: 'refused', reason: `${'x'.repeat(299)}…` });
  });
});
