// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `npm run install-local`: packages the extension (npm run package) and installs the .vsix into the VS Code of this
// computer (`code --install-extension … --force`), so that every window has it, also windows that a debug run opens.
// Optional: `npm run install-local -- --profile <name>` installs it into that VS Code profile.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vsix = join(root, `${name}-${version}.vsix`);
// npm and code are .cmd files on Windows, which need a shell.
const shell = process.platform === 'win32';

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell });
  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    if (command === 'code') {
      console.error('The command `code` was not found. In VS Code: Shell Command: Install \'code\' command in PATH.');
    }
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : undefined;
if (profileIndex >= 0 && !profile) {
  console.error('--profile needs the name of a VS Code profile.');
  process.exit(1);
}

run('npm', ['run', 'package']);
if (!existsSync(vsix)) {
  console.error(`The package ${vsix} was not written.`);
  process.exit(1);
}
run('code', ['--install-extension', vsix, '--force', ...(profile ? ['--profile', profile] : [])]);
console.log(`Installed ${name} ${version}. Reload the open VS Code windows (Developer: Reload Window) to use it.`);
