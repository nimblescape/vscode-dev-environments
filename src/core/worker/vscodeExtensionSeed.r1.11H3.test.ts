// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3 (A-L1; reviewer A's probe P1): the seed gives a copied file its name with `ln -n`, so a link to
// a folder that a process of the container plants at the name after the check (here a fake `cp` on the PATH plants it
// while the copy runs) is a name that exists: nothing is created inside the folder it points to. Run in a sandbox as the
// seed tests run theirs (the store, /etc/passwd and /etc/alpine-release are paths of the sandbox, HOME points into it).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { VSCODE_STORE_TARGET } from '../names';
import { VSCODE_EXTENSION_SEED_SCRIPT } from './vscodeExtensionSeed';

const UID = String(process.getuid?.() ?? 0);
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the seed never writes through a link planted at the name (review round 1 of 11H3, A-L1)', () => {
  it('a link to a folder planted between the check and ln: the hard link is not made inside that folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ext-seed-r1-'));
    temps.push(root);
    const store = path.join(root, 'store');
    const home = path.join(root, 'home');
    const victim = path.join(root, 'elsewhere');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(victim);
    fs.mkdirSync(path.join(store, 'extensions', 'universal'), { recursive: true });
    fs.writeFileSync(path.join(store, 'extensions', 'universal', 'a.b-1.0.0'), 'PK\x03\x04vsix');
    const passwd = path.join(root, 'passwd');
    fs.writeFileSync(passwd, `u:x:${UID}:${UID}::${home}:/bin/sh\n`);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const cp = spawnSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim();
    expect(cp).toMatch(/^\//);
    // A process of the container that wins the race: it plants the link while cp runs (in the cache folder, the cwd).
    fs.writeFileSync(path.join(bin, 'cp'), `#!/bin/sh\nln -s '${victim}' a.b-1.0.0\nexec '${cp}' "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho x86_64\n', { mode: 0o755 });
    const script = VSCODE_EXTENSION_SEED_SCRIPT.split(VSCODE_STORE_TARGET).join(store).split('/etc/passwd').join(passwd).split('/etc/alpine-release').join(path.join(root, 'none'));
    expect(script).not.toMatch(/\/etc\/|\/opt\/devenv/);
    const result = spawnSync('sh', ['-c', script, 'sh', 'stable', 'linux-x64', 'universal/a.b-1.0.0'], {
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: path.join(root, 'no-home') },
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(fs.readdirSync(victim)).toEqual([]);
    // The planted name counts as present; the temporary name is gone.
    expect(result.stdout.trim()).toBe('seeded: 0 copied, 1 present, 0 skipped, 0 failed');
    const cache = path.join(home, '.vscode-server', 'extensionsCache');
    expect(fs.readdirSync(cache)).toEqual(['a.b-1.0.0']);
    expect(fs.lstatSync(path.join(cache, 'a.b-1.0.0')).isSymbolicLink()).toBe(true);
  });
});
