// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { nodeSshConfigFiles, parseSshConfig, splitConfigLine, type SshConfigFiles } from './sshConfig';

/** An in-memory file system with POSIX paths. */
function memoryFiles(files: Record<string, string>): SshConfigFiles {
  return {
    readFile: (file) => files[file],
    readDir: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split('/')[0]);
      return names.length > 0 ? [...new Set(names)] : undefined;
    },
  };
}

const HOME = '/home/me';
const location = { home: HOME, pathApi: path.posix };

describe('parseSshConfig', () => {
  it('lists the concrete hosts with HostName, User, and Port; patterns and negations are skipped', () => {
    const files = memoryFiles({
      '/home/me/.ssh/config': [
        '# my hosts',
        'Host build-box',
        '  HostName build-box.example.com',
        '  User me',
        '  Port 2222',
        '',
        'Host web1 web2',
        '    hostname=10.0.0.5',
        'Host *.internal gpu?',
        '  User ops',
        'Host !bastion jump',
        '  User nobody',
        'Host *',
        '  ServerAliveInterval 30',
      ].join('\n'),
    });
    expect(parseSshConfig(files, location)).toEqual([
      { alias: 'build-box', hostName: 'build-box.example.com', user: 'me', port: '2222' },
      { alias: 'web1', hostName: '10.0.0.5' },
      { alias: 'web2', hostName: '10.0.0.5' },
    ]);
  });

  it('keeps the first value of each option, like ssh, and lists each host once', () => {
    const files = memoryFiles({
      '/home/me/.ssh/config': ['Host box', '  User first', '  User second', 'Host box', '  HostName later.example.com', '  User third'].join('\n'),
    });
    expect(parseSshConfig(files, location)).toEqual([{ alias: 'box', user: 'first', hostName: 'later.example.com' }]);
  });

  it('skips the options under Match and names that are no plain alias', () => {
    const files = memoryFiles({
      '/home/me/.ssh/config': ['Host box', 'Match host box exec "true"', '  User matched', 'Host -oProxyCommand=x "a b" ok'].join('\n'),
    });
    expect(parseSshConfig(files, location)).toEqual([{ alias: 'box' }, { alias: 'ok' }]);
  });

  it('follows Include: relative to ~/.ssh, with ~, globs, nested, in order', () => {
    const files = memoryFiles({
      '/home/me/.ssh/config': ['Include config.d/*', 'Include ~/extra/hosts', 'Host main'].join('\n'),
      '/home/me/.ssh/config.d/10-work': ['Host work', '  User w', 'Include nested'].join('\n'),
      '/home/me/.ssh/config.d/20-home': 'Host home-server\n  HostName 192.168.1.2',
      '/home/me/.ssh/config.d/.hidden': 'Host hidden',
      '/home/me/.ssh/nested': 'Host deep',
      '/home/me/extra/hosts': 'Host extra',
    });
    expect(parseSshConfig(files, location).map((entry) => entry.alias)).toEqual(['work', 'deep', 'home-server', 'extra', 'main']);
  });

  it('follows absolute Include paths with glob patterns in folders, and ignores missing files', () => {
    const files = memoryFiles({
      '/home/me/.ssh/config': 'Include /etc/ssh/conf.*/*.conf /missing/file\nHost a',
      '/etc/ssh/conf.a/x.conf': 'Host from-a',
      '/etc/ssh/conf.b/y.conf': 'Host from-b',
      '/etc/ssh/conf.b/y.txt': 'Host not-included',
    });
    expect(parseSshConfig(files, location).map((entry) => entry.alias)).toEqual(['from-a', 'from-b', 'a']);
  });

  it('stops an Include loop', () => {
    const files = memoryFiles({ '/home/me/.ssh/config': 'Host loop\nInclude config' });
    expect(parseSshConfig(files, location)).toEqual([{ alias: 'loop' }]);
  });

  it('gives nothing without a config', () => {
    expect(parseSshConfig(memoryFiles({}), location)).toEqual([]);
  });

  it('reads Windows paths (%USERPROFILE%\\.ssh\\config)', () => {
    const files: SshConfigFiles = {
      readFile: (file) =>
        ({
          'C:\\Users\\me\\.ssh\\config': 'Include conf.d\\*\r\nHost win-box\r\n  User me',
          'C:\\Users\\me\\.ssh\\conf.d\\one': 'Host from-include',
        })[file],
      readDir: (dir) => (dir === 'C:\\Users\\me\\.ssh\\conf.d' ? ['one'] : undefined),
    };
    const winLocation = { home: 'C:\\Users\\me', pathApi: path.win32 };
    // Plan step 11I (PR D): changed, userSshConfigPath (nothing used it) is removed; parseSshConfig reads that path.
    expect(parseSshConfig(files, winLocation)).toEqual([{ alias: 'from-include' }, { alias: 'win-box', user: 'me' }]);
  });

  it('reads the files of this computer', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-ssh-'));
    try {
      fs.mkdirSync(path.join(home, '.ssh', 'hosts'), { recursive: true });
      fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Include hosts/*\nHost local-one\n');
      fs.writeFileSync(path.join(home, '.ssh', 'hosts', 'a'), 'Host from-file\n  HostName 192.0.2.1\n');
      expect(parseSshConfig(nodeSshConfigFiles, { home })).toEqual([{ alias: 'from-file', hostName: '192.0.2.1' }, { alias: 'local-one' }]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('splitConfigLine', () => {
  it.each([
    ['Host a b', ['Host', 'a', 'b']],
    ['  HostName=box.example.com', ['HostName', 'box.example.com']],
    ['HostName = box', ['HostName', 'box']],
    ['IdentityFile "~/My Keys/id"', ['IdentityFile', '~/My Keys/id']],
    ['Host a # comment', ['Host', 'a']],
    ['# comment', []],
    ['   ', []],
  ])('%j', (line, words) => {
    expect(splitConfigLine(line)).toEqual(words);
  });
});
