// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `npm run install-local`: packages the extension (npm run package) and installs the .vsix into the VS Code of this
// computer (`code --install-extension … --force`), so that every window has it, also windows that a debug run opens.
// It installs into every VS Code profile: the default profile and each profile listed in VS Code's storage.json
// (userDataProfiles), so that every window has the same build whatever profile it uses (user decision 2026-09-26).
// `npm run install-local -- --profile <name>` installs into that one profile only.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vsix = join(root, `${name}-${version}.vsix`);
// npm and code are .cmd files on Windows, which need a shell.
const shell = process.platform === 'win32';

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  // With a shell (Windows), an argument with spaces (a profile name, the path of the package) must be quoted.
  const shellArgs = shell ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync(command, shellArgs, { cwd: root, stdio: 'inherit', shell });
  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    if (command === 'code') {
      console.error('The command `code` was not found. In VS Code: Shell Command: Install \'code\' command in PATH.');
    }
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** The folder of VS Code's user data (VSCODE_USER_DATA_DIR for tests), by platform. */
function userDataDir() {
  if (process.env.VSCODE_USER_DATA_DIR) return process.env.VSCODE_USER_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Code');
}

/**
 * The names of the profiles other than the default profile (userDataProfiles in VS Code's storage.json). Empty when
 * there are none or VS Code's storage cannot be read.
 */
function profileNames() {
  try {
    const storage = JSON.parse(readFileSync(join(userDataDir(), 'User', 'globalStorage', 'storage.json'), 'utf8'));
    const names = (storage?.userDataProfiles ?? []).map((profile) => profile?.name).filter((name) => typeof name === 'string' && name !== '');
    return [...new Set(names)];
  } catch {
    return [];
  }
}

const profileIndex = process.argv.indexOf('--profile');
const named = profileIndex >= 0 ? process.argv[profileIndex + 1] : undefined;
if (profileIndex >= 0 && !named) {
  console.error('--profile needs the name of a VS Code profile.');
  process.exit(1);
}
// undefined stands for the default profile.
const profiles = named ? [named] : [undefined, ...profileNames()];
console.log(`VS Code profiles: ${profiles.map((profile) => profile ?? 'Default').join(', ')}`);

run('npm', ['run', 'package']);
if (!existsSync(vsix)) {
  console.error(`The package ${vsix} was not written.`);
  process.exit(1);
}
for (const profile of profiles) {
  run('code', ['--install-extension', vsix, '--force', ...(profile ? ['--profile', profile] : [])]);
}
console.log(
  `Installed ${name} ${version} in ${profiles.length === 1 ? 'the profile' : 'the profiles'} ${profiles.map((profile) => profile ?? 'Default').join(', ')}. Reload the open VS Code windows (Developer: Reload Window) to use it.`,
);
