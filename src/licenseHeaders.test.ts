// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// Every source file starts with the license header (same policy as the other nimblescape extensions).
const ROOT = path.resolve(__dirname, '..');
const LINES = [
  'SPDX-License-Identifier: MIT',
  '© 2026 Hannes Stauss (scalarion@nimblescape.com)',
  'Licensed under the MIT License. See LICENSE in the repository root for details.',
];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mts|mjs|cjs|js)$/.test(entry.name)) files.push(full);
    }
  };
  for (const dir of ['src', 'test', 'scripts']) {
    if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
  }
  for (const name of fs.readdirSync(ROOT)) {
    if (/\.(ts|mts|mjs|cjs|js)$/.test(name)) files.push(path.join(ROOT, name));
  }
  files.push(path.join(ROOT, 'resources', 'helper', 'Dockerfile'));
  return files.sort();
}

describe('license headers', () => {
  it('finds the source files', () => {
    expect(sourceFiles().length).toBeGreaterThan(100);
  });

  it.each(sourceFiles().map((file) => [path.relative(ROOT, file), file]))('%s starts with the license header', (_name, file) => {
    const prefix = file.endsWith('Dockerfile') ? '# ' : '// ';
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 3);
    expect(head).toEqual(LINES.map((line) => prefix + line));
  });
});
