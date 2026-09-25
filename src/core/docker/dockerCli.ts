// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Finding the Docker CLI and the process environment for Docker calls (implementation notes 6 "Finding the CLI").
// The platform is a parameter, so that the Windows rules can be tested on every computer.
import * as fs from 'fs';
import * as path from 'path';

const WINDOWS_PROGRAM_FILES = 'C:\\Program Files';
const WINDOWS_DOCKER_FOLDER = 'Docker\\Docker';

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/** Value of an environment variable. On Windows, names are case-insensitive (`Path`, `ProgramFiles`). */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower && env[key] !== undefined) return env[key];
  }
  return undefined;
}

/**
 * Installation folders of Docker Desktop on Windows, for example `C:\Program Files\Docker\Docker`.
 * Uses `ProgramFiles` / `ProgramW6432` when set, then the default folder.
 */
export function windowsDockerDesktopFolders(env: NodeJS.ProcessEnv = {}): string[] {
  const roots = [envValue(env, 'ProgramW6432', 'win32'), envValue(env, 'ProgramFiles', 'win32'), WINDOWS_PROGRAM_FILES];
  const folders: string[] = [];
  for (const root of roots) {
    if (!root || !path.win32.isAbsolute(root)) continue;
    const folder = path.win32.join(root, WINDOWS_DOCKER_FOLDER);
    if (!folders.some((existing) => existing.toLowerCase() === folder.toLowerCase())) folders.push(folder);
  }
  return folders;
}

/**
 * Extra folders to search after PATH: /usr/local/bin, /opt/homebrew/bin, /Applications/Docker.app/Contents/Resources/bin (darwin),
 * C:\Program Files\Docker\Docker\resources\bin (win32). On Linux: /usr/local/bin and /usr/bin.
 * `env` is optional: on Windows, it gives the Program Files folder if it is not on drive C.
 */
export function extraSearchFolders(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[] {
  switch (platform) {
    case 'darwin':
      return ['/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin'];
    case 'win32':
      return windowsDockerDesktopFolders(env).map((folder) => path.win32.join(folder, 'resources', 'bin'));
    default:
      // The extension host can have a short PATH on Linux too, for example when VS Code starts from a desktop entry.
      return ['/usr/local/bin', '/usr/bin'];
  }
}

/** Removes quotes around a PATH entry (possible on Windows) and surrounding white space. */
function cleanEntry(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).trim();
  return trimmed;
}

/** Key for comparing folders: without trailing separators, case-insensitive on Windows. */
function folderKey(folder: string, platform: NodeJS.Platform): string {
  let value = cleanEntry(folder);
  const separators = platform === 'win32' ? /[\\/]+$/ : /\/+$/;
  const root = pathApi(platform).parse(value).root;
  if (value.length > root.length) value = value.replace(separators, '');
  return platform === 'win32' ? value.toLowerCase() : value;
}

/** Absolute folders of PATH, in order, followed by the extra folders, without duplicates. Relative entries are ignored. */
function searchFolders(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const api = pathApi(platform);
  const pathValue = envValue(env, 'PATH', platform) ?? '';
  const candidates = [...pathValue.split(pathDelimiter(platform)).map(cleanEntry), ...extraSearchFolders(platform, env)];
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const folder of candidates) {
    // A relative entry (or an empty one, which means the current folder) could run a program of the opened folder.
    if (!folder || !api.isAbsolute(folder)) continue;
    const key = folderKey(folder, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(folder);
  }
  return folders;
}

/** True if the file exists, is a regular file (symbolic links are followed), and is executable. */
export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a program in PATH and then in the extra folders. On win32 the file name gets `.exe` (for example `docker.exe`).
 * An absolute `name` is only checked. Returns the full path, or `undefined`.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean = isExecutableFile,
): string | undefined {
  const api = pathApi(platform);
  const fileName = platform === 'win32' && !/\.exe$/i.test(name) ? `${name}.exe` : name;
  if (api.isAbsolute(fileName)) return exists(fileName) ? fileName : undefined;
  for (const folder of searchFolders(env, platform)) {
    const candidate = api.join(folder, fileName);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Full path of the Docker CLI (`docker`, or `docker.exe` on win32), or `undefined` if Docker is not installed. */
export function findDockerCli(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists?: (file: string) => boolean,
): string | undefined {
  return findExecutable('docker', env, platform, exists);
}

/**
 * Process environment for Docker calls: PATH extended with the folder of the Docker CLI and the extra folders,
 * because the Docker CLI starts credential helpers (docker-credential-*) and CLI plugins through PATH.
 * Existing entries keep their order. The function is idempotent. On win32, the existing spelling of the key (`Path`) is kept.
 */
export function dockerProcessEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, dockerPath?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  let key = 'PATH';
  if (platform === 'win32') {
    const pathKeys = Object.keys(result).filter((name) => name.toLowerCase() === 'path');
    key = pathKeys.find((name) => result[name] !== undefined) ?? pathKeys[0] ?? 'Path';
    // Two spellings of the same variable would make the value that Windows uses unpredictable.
    for (const other of pathKeys) if (other !== key) delete result[other];
  }
  const current = result[key] ?? '';
  const delimiter = pathDelimiter(platform);
  const present = new Set(
    current
      .split(delimiter)
      .filter((entry) => entry.trim() !== '')
      .map((entry) => folderKey(entry, platform)),
  );
  const additions: string[] = [];
  const candidates = [dockerPath ? pathApi(platform).dirname(dockerPath) : undefined, ...extraSearchFolders(platform, env)];
  for (const folder of candidates) {
    if (!folder) continue;
    const folderId = folderKey(folder, platform);
    if (present.has(folderId)) continue;
    present.add(folderId);
    additions.push(folder);
  }
  if (additions.length > 0) {
    result[key] = current.trim() === '' ? additions.join(delimiter) : `${current}${delimiter}${additions.join(delimiter)}`;
  }
  return result;
}
