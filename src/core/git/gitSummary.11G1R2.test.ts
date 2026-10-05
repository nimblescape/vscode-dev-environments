// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #114 (B, mutation testing of A-M1): a behavioural check of `-execdir chown -h --` in the fixes of
// the batch helper. A `chown` on the PATH replaces a folder of the walked tree by a link to a folder outside of it at its
// first call (as a running container of a service could, after `find` listed the files). With `-exec`, chown resolves
// the whole path again and gives the files outside the owner; with `-execdir`, it runs in the folder that `find` has
// open. Needs root (chown) and GNU find (`-execdir` with `+`); skipped elsewhere.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_OWNERSHIP_FIX_SCRIPT, RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT } from './gitSummary';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const gnuFind = process.platform === 'linux' && /GNU findutils/.test(spawnSync('find', ['--version'], { encoding: 'utf8' }).stdout ?? '');

describe.runIf(isRoot && gnuFind)('the ownership fixes of the batch helper with a folder replaced by a link (review round 2 of PR #114, B)', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  for (const [name, script] of [
    ['CONFIG_OWNERSHIP_FIX_SCRIPT', CONFIG_OWNERSHIP_FIX_SCRIPT],
    // Review round 3 of PR #114 (A3-M1): the fix of a resumed clone, whose containers may run (a new clone keeps `-exec`
    // in its branch without paths: no container of the environment has run on its files).
    ['RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT', RESUMED_NUMERIC_OWNERSHIP_FIX_SCRIPT],
  ] as const) {
    it(`${name} never gives a file outside the folder the owner`, () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-execdir-'));
      folders.push(base);
      const repo = path.join(base, 'repo');
      const outside = path.join(base, 'outside');
      const bin = path.join(base, 'bin');
      for (const folder of [path.join(repo, 'sub', 'deep'), path.join(outside, 'deep'), bin]) fs.mkdirSync(folder, { recursive: true });
      for (const root of [path.join(repo, 'sub'), outside]) {
        fs.writeFileSync(path.join(root, 'file'), 'x');
        fs.writeFileSync(path.join(root, 'deep', 'f2'), 'x');
      }
      const chown = spawnSync('which', ['chown'], { encoding: 'utf8' }).stdout.trim();
      expect(chown).not.toBe('');
      fs.writeFileSync(
        path.join(bin, 'chown'),
        `#!/bin/sh
if [ ! -e '${base}/swapped' ]; then
  : > '${base}/swapped'
  mv '${repo}/sub' '${repo}/sub.real'
  ln -s '${outside}' '${repo}/sub'
fi
exec '${chown}' "$@"
`,
        { mode: 0o755 },
      );
      spawnSync('chown', ['-R', '0:0', repo, outside]);
      const result = spawnSync('sh', ['-c', script, 'sh', repo, '1234', '1234'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` },
      });
      // The race happened (the fix may fail for it: find does not walk into the link).
      expect(fs.existsSync(path.join(base, 'swapped')), result.stderr).toBe(true);
      expect(fs.lstatSync(path.join(repo, 'sub')).isSymbolicLink()).toBe(true);
      for (const file of [outside, path.join(outside, 'file'), path.join(outside, 'deep'), path.join(outside, 'deep', 'f2')]) {
        expect(fs.lstatSync(file).uid, file).toBe(0);
      }
    });
  }
});
