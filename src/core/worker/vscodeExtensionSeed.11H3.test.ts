// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09; live check 3 of the user): the script of the container setup that copies the
// cached `.vsix` files of the store into `~/.vscode-server/extensionsCache` (VSCODE_EXTENSION_SEED_SCRIPT), run with the
// shell of this computer in a temporary folder, as the link tests run theirs: its fixed paths (the store, /etc/passwd,
// /etc/alpine-release) are paths of the sandbox, `uname`, `ldd` and `id -u` are fakes on the PATH, the fake passwd maps
// every user of the tests to a folder of the sandbox, and HOME points into the sandbox, so a run never writes into a real
// home folder. The dev container is untrusted: a planted link is never followed or written through, nothing is replaced.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET } from '../names';
import { scriptCommand } from './containerScripts';
import { VSCODE_EXTENSION_SEED_SCRIPT, vscodeExtensionSeedOutcome } from './vscodeExtensionSeed';

const shell = !spawnSync('dash', ['-c', 'true'], { stdio: 'ignore' }).error ? 'dash' : 'sh';
const UID = String(process.getuid?.() ?? 0);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  store: string;
  home: string;
  alpine: string;
  cache: string;
  run(args: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-seed-'));
  temps.push(root);
  const store = path.join(root, 'store');
  const home = path.join(root, 'home', 'vscode');
  fs.mkdirSync(home, { recursive: true });
  const passwd = path.join(root, 'passwd');
  fs.writeFileSync(passwd, `vscode:x:${UID}:${UID}::${home}:/bin/sh\nother:x:4242:4242::${home}:/bin/sh\n`);
  const alpine = path.join(root, 'alpine-release');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = (name: string, text: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  fake('uname', 'echo "${FAKE_MACHINE:-x86_64}"');
  fake('ldd', 'if [ -n "${FAKE_LDD_MUSL:-}" ]; then echo "musl libc (x86_64)" >&2; exit 1; fi\necho "ldd (GNU libc) 2.36"');
  fake('id', `if [ "$1" = -u ]; then echo "\${FAKE_UID:-${UID}}"; else exec /usr/bin/id "$@"; fi`);
  const script = VSCODE_EXTENSION_SEED_SCRIPT.split(VSCODE_STORE_TARGET).join(store).split('/etc/passwd').join(passwd).split('/etc/alpine-release').join(alpine);
  expect(script).not.toMatch(/\/etc\/|\/opt\/devenv/);
  for (const folder of ['universal', 'linux-x64', 'linux-arm64']) fs.mkdirSync(path.join(store, 'extensions', folder), { recursive: true });
  return {
    store,
    home,
    alpine,
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

/** A cached file of the store: `<folder>/<name>` with `content`. */
function cached(s: Sandbox, entry: string, content = `vsix of ${entry}`): string {
  fs.writeFileSync(path.join(s.store, 'extensions', entry), content);
  return entry;
}

describe('the seed of the shared extension cache (plan step 11H3)', () => {
  it('is a script of the registry: the quality, the platform, then the files', () => {
    expect(scriptCommand('vscodeExtensionSeed', ['stable', 'linux-x64', 'universal/a.b-1.0.0'])).toEqual(['sh', '-c', VSCODE_EXTENSION_SEED_SCRIPT, 'sh', 'stable', 'linux-x64', 'universal/a.b-1.0.0']);
    expect(VSCODE_EXTENSION_SEED_SCRIPT).toContain(`source="${VSCODE_STORE_TARGET}/extensions/$folder/$name"`);
  });

  it('copies the files under their names into ~/.vscode-server/extensionsCache, then finds them present', () => {
    const s = sandbox();
    const files = [cached(s, 'universal/a.b-1.0.0'), cached(s, 'linux-x64/c.d-2.0.0-linux-x64')];
    expect(s.run(['stable', 'linux-x64', ...files])).toMatchObject({ status: 0, stdout: 'seeded: 2 copied, 0 present, 0 skipped, 0 failed\n' });
    expect(fs.readFileSync(path.join(s.cache, 'a.b-1.0.0'), 'utf8')).toBe('vsix of universal/a.b-1.0.0');
    expect(fs.readFileSync(path.join(s.cache, 'c.d-2.0.0-linux-x64'), 'utf8')).toBe('vsix of linux-x64/c.d-2.0.0-linux-x64');
    expect(fs.lstatSync(path.join(s.cache, 'a.b-1.0.0')).isFile()).toBe(true);
    // No temporary file stays.
    expect(fs.readdirSync(s.cache).sort()).toEqual(['a.b-1.0.0', 'c.d-2.0.0-linux-x64']);
    expect(s.run(['stable', 'linux-x64', ...files])).toMatchObject({ status: 0, stdout: 'seeded: 0 copied, 2 present, 0 skipped, 0 failed\n' });
  });

  it('uses ~/.vscode-server-insiders for insider', () => {
    const s = sandbox();
    expect(s.run(['insider', 'linux-x64', cached(s, 'universal/a.b-1.0.0')]).stdout).toBe('seeded: 1 copied, 0 present, 0 skipped, 0 failed\n');
    expect(fs.existsSync(path.join(s.home, '.vscode-server-insiders', 'extensionsCache', 'a.b-1.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(s.home, '.vscode-server'))).toBe(false);
  });

  it('never overwrites: a file, a folder or a link of that name stays as it is', () => {
    const s = sandbox();
    const entry = cached(s, 'universal/a.b-1.0.0');
    fs.mkdirSync(s.cache, { recursive: true });
    const target = path.join(path.dirname(s.home), 'target');
    fs.writeFileSync(target, 'not to be written');
    for (const make of [(file: string) => fs.writeFileSync(file, 'own'), (file: string) => fs.mkdirSync(file), (file: string) => fs.symlinkSync(target, file)]) {
      fs.rmSync(path.join(s.cache, 'a.b-1.0.0'), { recursive: true, force: true });
      make(path.join(s.cache, 'a.b-1.0.0'));
      expect(s.run(['stable', 'linux-x64', entry]).stdout).toBe('seeded: 0 copied, 1 present, 0 skipped, 0 failed\n');
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('not to be written');
  });

  it('refuses a planted link in place of the data folder or of extensionsCache, and writes nothing through it', () => {
    for (const plant of ['.vscode-server', '.vscode-server/extensionsCache']) {
      const s = sandbox();
      const entry = cached(s, 'universal/a.b-1.0.0');
      const elsewhere = path.join(path.dirname(s.home), 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.mkdirSync(path.dirname(path.join(s.home, plant)), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(s.home, plant));
      expect(s.run(['stable', 'linux-x64', entry])).toMatchObject({ status: 0, stdout: `refused: ${path.join(s.home, plant)} is a link\n` });
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    }
  });

  it('refuses a cached file of the store that is a link, and names that are not plain cache names', () => {
    const s = sandbox();
    fs.symlinkSync('/etc/hostname', path.join(s.store, 'extensions', 'universal', 'a.b-1.0.0'));
    // Plain files of the store whose names are no cache names.
    cached(s, 'universal/.hidden');
    cached(s, 'universal/A.b-1.0.0');
    expect(s.run(['stable', 'linux-x64', 'universal/a.b-1.0.0', 'universal/../x', 'universal/.hidden', 'universal/A.b-1.0.0', 'other/a.b-1.0.0']).stdout).toBe(
      'seeded: 0 copied, 0 present, 5 skipped, 0 failed\n',
    );
    expect(fs.readdirSync(s.cache)).toEqual([]);
  });

  it('the platform: files of the engine\'s platform only into a glibc container of that platform; universal into any', () => {
    const s = sandbox();
    const files = [cached(s, 'universal/a.b-1.0.0'), cached(s, 'linux-x64/c.d-2.0.0-linux-x64')];
    // An arm64 container on an x64 engine (emulated): universal only.
    expect(s.run(['stable', 'linux-x64', ...files], { FAKE_MACHINE: 'aarch64' }).stdout).toBe('seeded: 1 copied, 0 present, 1 skipped, 0 failed\n');
    const m = sandbox();
    const musl = [cached(m, 'universal/a.b-1.0.0'), cached(m, 'linux-x64/c.d-2.0.0-linux-x64')];
    expect(m.run(['stable', 'linux-x64', ...musl], { FAKE_LDD_MUSL: '1' }).stdout).toBe('seeded: 1 copied, 0 present, 1 skipped, 0 failed\n');
    const n = sandbox();
    const none = [cached(n, 'universal/a.b-1.0.0'), cached(n, 'linux-x64/c.d-2.0.0-linux-x64')];
    expect(n.run(['stable', 'none', ...none]).stdout).toBe('seeded: 1 copied, 0 present, 1 skipped, 0 failed\n');
    expect(fs.readdirSync(n.cache)).toEqual(['a.b-1.0.0']);
  });

  it('no files, or invalid arguments: nothing is written', () => {
    const s = sandbox();
    expect(s.run(['stable', 'linux-x64']).stdout).toBe('skipped: no cached extensions\n');
    expect(s.run(['beta', 'linux-x64', 'universal/a.b-1.0.0']).stdout).toBe('skipped: the quality is invalid\n');
    expect(s.run(['stable', 'darwin-x64', 'universal/a.b-1.0.0']).stdout).toBe('skipped: the platform is invalid\n');
    expect(fs.existsSync(path.join(s.home, '.vscode-server'))).toBe(false);
  });

  it('reads its one line', () => {
    expect(vscodeExtensionSeedOutcome({ exitCode: 0, stdout: 'seeded: 1 copied, 2 present, 3 skipped, 4 failed\n', stderr: '' })).toEqual({ kind: 'seeded', copied: 1, present: 2, skipped: 3, failed: 4 });
    expect(vscodeExtensionSeedOutcome({ exitCode: 0, stdout: 'refused: x is a link\n', stderr: '' })).toEqual({ kind: 'refused', reason: 'x is a link' });
    expect(vscodeExtensionSeedOutcome({ exitCode: 0, stdout: 'what\n', stderr: '' })).toEqual({ kind: 'failed', reason: 'the script answered "what"' });
    expect(vscodeExtensionSeedOutcome({ exitCode: 1, stdout: '', stderr: 'a\nboom\n' })).toEqual({ kind: 'failed', reason: 'exit code 1: boom' });
    expect(vscodeExtensionSeedOutcome({ exitCode: null, stdout: '', stderr: '', timedOut: true })).toEqual({ kind: 'failed', reason: 'the script took too long' });
  });
});
