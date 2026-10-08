// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The hosts of the user's SSH config (~/.ssh/config; on Windows %USERPROFILE%\.ssh\config) for the quick pick of "Use a
// Remote Docker Host…" (unit 7). Read only; the parsing is pure (a small file system interface), with `Include` followed
// like ssh does (relative to ~/.ssh, `~` for the home folder, glob patterns with * and ?), at most 16 levels deep.
// A `Host` line names concrete hosts; patterns (with *, ?, or !) are skipped, and so is everything under `Match`.
import * as fs from 'fs';
import * as path from 'path';
import { isUsableSshAlias } from './docker/dockerHost';

export interface SshHostEntry {
  /** The name after `Host`, which `ssh <alias>` uses. */
  alias: string;
  hostName?: string;
  user?: string;
  port?: string;
}

/** The files that the parser reads. Paths are absolute; `readDir` gives the names in a folder. */
export interface SshConfigFiles {
  readFile(file: string): string | undefined;
  readDir(dir: string): string[] | undefined;
}

export interface SshConfigLocation {
  /** The user's home folder. */
  home: string;
  /** Path module of the platform (`path.posix` or `path.win32`). Default: `path`. */
  pathApi?: path.PlatformPath;
}

/** ssh reads nested Include files at most this deep. */
const MAX_INCLUDE_DEPTH = 16;
/** A config that is not reasonable (for example a loop of globs) is read to at most this many files. */
const MAX_FILES = 256;

/**
 * The concrete hosts of the SSH config, in the order of the files, each once (the first `Host` line that names it
 * wins, as ssh takes the first value of each option). HostName, User, and Port come from the blocks that name the alias
 * exactly (the first value of each).
 */
export function parseSshConfig(files: SshConfigFiles, location: SshConfigLocation): SshHostEntry[] {
  const api = location.pathApi ?? path;
  const sshDir = api.join(location.home, '.ssh');
  const entries = new Map<string, SshHostEntry>();
  let filesRead = 0;

  const readConfig = (file: string, depth: number): void => {
    if (depth > MAX_INCLUDE_DEPTH || filesRead >= MAX_FILES) return;
    const text = files.readFile(file);
    if (text === undefined) return;
    filesRead++;
    // The aliases of the current `Host` block; empty under a pattern-only block or `Match`.
    let current: SshHostEntry[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const words = splitConfigLine(rawLine);
      if (words.length === 0) continue;
      const keyword = words[0].toLowerCase();
      const args = words.slice(1);
      switch (keyword) {
        case 'host': {
          current = [];
          // A block with a negated pattern applies to other hosts too: none of its names is offered on its own.
          if (args.some((name) => name.startsWith('!'))) break;
          for (const alias of args) {
            if (/[*?]/.test(alias) || !isUsableSshAlias(alias)) continue;
            let entry = entries.get(alias);
            if (!entry) {
              entry = { alias };
              entries.set(alias, entry);
            }
            current.push(entry);
          }
          break;
        }
        case 'match':
          current = [];
          break;
        case 'include':
          for (const pattern of args) {
            for (const included of expandInclude(pattern, sshDir, location.home, api, files)) readConfig(included, depth + 1);
          }
          break;
        case 'hostname':
        case 'user':
        case 'port': {
          const value = args[0];
          if (value === undefined) break;
          const field = keyword === 'hostname' ? 'hostName' : keyword;
          for (const entry of current) if (entry[field] === undefined) entry[field] = value;
          break;
        }
        default:
          break;
      }
    }
  };

  readConfig(api.join(sshDir, 'config'), 0);
  return [...entries.values()];
}

/**
 * Splits a config line into its keyword and arguments: `Keyword arg…` or `Keyword=arg`, with double quotes around
 * arguments that contain spaces. A comment line and an empty line give no words.
 */
export function splitConfigLine(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return [];
  const keywordMatch = /^([^\s=]+)\s*(?:=\s*|\s+|$)/.exec(trimmed);
  if (!keywordMatch) return [];
  const words = [keywordMatch[1]];
  const rest = trimmed.slice(keywordMatch[0].length);
  const argument = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = argument.exec(rest)) !== null) {
    const word = match[1] ?? match[2];
    if (match[1] === undefined && word.startsWith('#')) break;
    words.push(word);
  }
  return words;
}

/** The files of one `Include` argument: `~` expanded, relative to ~/.ssh, glob patterns (* and ?) in any part. */
function expandInclude(pattern: string, sshDir: string, home: string, api: path.PlatformPath, files: SshConfigFiles): string[] {
  let full = pattern;
  if (full === '~' || full.startsWith('~/') || full.startsWith('~\\')) full = api.join(home, full.slice(1));
  else if (!api.isAbsolute(full)) full = api.join(sshDir, full);
  full = api.normalize(full);
  if (!/[*?]/.test(full)) return [full];
  const root = api.parse(full).root;
  const parts = full.slice(root.length).split(/[\\/]+/).filter((part) => part !== '');
  let candidates = [root];
  for (const part of parts) {
    const next: string[] = [];
    for (const dir of candidates) {
      if (!/[*?]/.test(part)) {
        next.push(api.join(dir, part));
        continue;
      }
      const matcher = globMatcher(part);
      const names = (files.readDir(dir) ?? []).filter((name) => matcher.test(name) && !name.startsWith('.')).sort();
      for (const name of names) next.push(api.join(dir, name));
    }
    candidates = next;
    if (candidates.length > MAX_FILES) candidates = candidates.slice(0, MAX_FILES);
  }
  return candidates;
}

function globMatcher(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`);
}

/** The files of this computer, read synchronously (the config is small); errors count as a missing file or folder. */
export const nodeSshConfigFiles: SshConfigFiles = {
  readFile(file) {
    try {
      if (!fs.statSync(file).isFile()) return undefined;
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  readDir(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return undefined;
    }
  },
};
