// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `npm run install-local`: packages the extension (npm run package) and installs the .vsix into the VS Code of this
// computer (`code --install-extension … --force`), so that every window has it, also windows that a debug run opens.
// It installs into the VS Code profile that this repository folder is open in (the profile association of the folder in
// VS Code's storage.json), not always into the default profile. `npm run install-local -- --profile <name>` names the
// profile instead.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** The folder of VS Code's user data (VSCODE_USER_DATA_DIR for tests), by platform. */
function userDataDir() {
  if (process.env.VSCODE_USER_DATA_DIR) return process.env.VSCODE_USER_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Code');
}

/** File URIs compare without a trailing slash and, on macOS and Windows, without case (case-insensitive file systems). */
function sameFolder(a, b) {
  const norm = (uri) => {
    const text = decodeURIComponent(uri).replace(/\/+$/, '');
    return process.platform === 'linux' ? text : text.toLowerCase();
  };
  return norm(a) === norm(b);
}

/**
 * The name of the profile that this repository folder is open in: storage.json maps workspace URIs to a profile
 * location (profileAssociations.workspaces), and userDataProfiles gives the name of each location. `undefined` for the
 * default profile or when VS Code's storage cannot be read.
 */
function folderProfile() {
  try {
    const storage = JSON.parse(readFileSync(join(userDataDir(), 'User', 'globalStorage', 'storage.json'), 'utf8'));
    const workspaces = storage?.profileAssociations?.workspaces ?? {};
    const folder = pathToFileURL(root).href;
    const entry = Object.entries(workspaces).find(([uri]) => sameFolder(uri, folder));
    if (!entry || entry[1] === '__default__profile__') return undefined;
    const profile = (storage.userDataProfiles ?? []).find((candidate) => candidate.location === entry[1]);
    return typeof profile?.name === 'string' ? profile.name : undefined;
  } catch {
    return undefined;
  }
}

const profileIndex = process.argv.indexOf('--profile');
const named = profileIndex >= 0 ? process.argv[profileIndex + 1] : undefined;
if (profileIndex >= 0 && !named) {
  console.error('--profile needs the name of a VS Code profile.');
  process.exit(1);
}
const profile = named ?? folderProfile();
console.log(profile ? `VS Code profile: ${profile}` : 'VS Code profile: Default');

run('npm', ['run', 'package']);
if (!existsSync(vsix)) {
  console.error(`The package ${vsix} was not written.`);
  process.exit(1);
}
run('code', ['--install-extension', vsix, '--force', ...(profile ? ['--profile', profile] : [])]);
console.log(`Installed ${name} ${version}${profile ? ` in the profile ${profile}` : ''}. Reload the open VS Code windows (Developer: Reload Window) to use it.`);
