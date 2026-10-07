// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #121 (reviewer B, mutation testing): probes of readInRepository (READ_FILES_SCRIPT) for the
// mutants that the tests of scripts.test.ts leave alive.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFilesCommand } from './scripts';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** `fd`: a descriptor of this process that the script gets as its fd 3. */
function runNode(command: string[], fd?: number): { status: number | null; stdout: string; stderr: string } {
  expect(command[0]).toBe('node');
  const result = spawnSync(process.execPath, command.slice(1), {
    encoding: 'utf8',
    timeout: 10_000,
    ...(fd !== undefined ? { stdio: ['pipe', 'pipe', 'pipe', fd] } : {}),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const BUILD_CONFIG = '{ "build": { "dockerfile": "Dockerfile" } }';
const REFUSED = 'The configuration file is not a file of the repository.';

describe('READ_FILES_SCRIPT, review round 1 of PR #121 (reviewer B)', () => {
  // Mutant: real.startsWith(rootReal) without the '/'. A repository named `.devenv` (checkRepository allows it) has the
  // folder /workspaces/.devenv, a prefix of CONFIG_FOLDER /workspaces/.devenv+ (gh/hosts.yml holds a token).
  it('refuses a link to a folder next to the repository whose name starts with the name of the repository folder', () => {
    const root = tempDir();
    const repo = path.join(root, '.devenv');
    write(path.join(root, '.devenv+', 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: gho_SIBLING_SECRET\n');
    fs.mkdirSync(path.join(repo, 'a'), { recursive: true });
    fs.symlinkSync('../../.devenv+/gh/hosts.yml', path.join(repo, 'a', 'devcontainer.json'));
    write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
    fs.symlinkSync('../../.devenv+/gh/hosts.yml', path.join(repo, 'b', 'Dockerfile'));
    const config = runNode(readFilesCommand(repo, 'a/devcontainer.json'));
    expect(config.status).not.toBe(0);
    expect(config.stderr).toContain(REFUSED);
    expect(`${config.stdout}${config.stderr}`).not.toContain('gho_SIBLING_SECRET');
    const dockerfile = runNode(readFilesCommand(repo, 'b/devcontainer.json'));
    expect(dockerfile.status, dockerfile.stderr).toBe(0);
    expect(JSON.parse(dockerfile.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' });
  });

  // Mutants: no dev/ino comparison, dev only, stat(file) or fstat(fd) in place of stat(real), and real === null not
  // checked. A deterministic stand-in for a link that is changed between the open and the check: the link leads to
  // /proc/self/fd/3, a file of the repository that was deleted after this process opened it. open() follows the
  // descriptor to that file, while realpath reads the text of the magic link, `<repository>/stale (deleted)`, which
  // names another file of the repository (a decoy) or nothing.
  it.skipIf(process.platform !== 'linux')('reads only the file that its real path names (dev and ino of the opened file)', () => {
    const repo = tempDir();
    write(path.join(repo, 'stale'), '{ "image": "STALE_SECRET" }');
    const fd = fs.openSync(path.join(repo, 'stale'), 'r');
    try {
      fs.unlinkSync(path.join(repo, 'stale'));
      write(path.join(repo, 'stale (deleted)'), '{ "image": "decoy" }');
      fs.mkdirSync(path.join(repo, 'a'));
      fs.symlinkSync('/proc/self/fd/3', path.join(repo, 'a', 'devcontainer.json'));
      write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
      fs.symlinkSync('/proc/self/fd/3', path.join(repo, 'b', 'Dockerfile'));
      // The setup holds: for the script, the real path is the decoy, and the open reaches the deleted file.
      const probe = spawnSync(
        process.execPath,
        ['-e', "const fs = require('fs'); process.stdout.write(JSON.stringify([fs.realpathSync(process.argv[1]), fs.readFileSync(process.argv[1], 'utf8')]))", path.join(repo, 'a', 'devcontainer.json')],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', fd] },
      );
      expect(JSON.parse(probe.stdout)).toEqual([path.join(fs.realpathSync(repo), 'stale (deleted)'), '{ "image": "STALE_SECRET" }']);
      for (const decoy of [true, false]) {
        if (!decoy) fs.rmSync(path.join(repo, 'stale (deleted)'));
        const config = runNode(readFilesCommand(repo, 'a/devcontainer.json'), fd);
        expect(config.status, `decoy: ${decoy}`).not.toBe(0);
        expect(config.stderr).toContain(REFUSED);
        expect(`${config.stdout}${config.stderr}`).not.toContain('STALE_SECRET');
        const dockerfile = runNode(readFilesCommand(repo, 'b/devcontainer.json'), fd);
        expect(dockerfile.status, dockerfile.stderr).toBe(0);
        expect(JSON.parse(dockerfile.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' });
      }
    } finally {
      fs.closeSync(fd);
    }
  });

  // Mutants: a folder -> null, ENOTDIR rethrown. "undefined: no such file (or a folder)", as before the PR.
  it('takes a configuration path that is a folder, or that leads through a file, for a configuration that does not exist', () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, '.devcontainer', 'devcontainer.json'), { recursive: true });
    write(path.join(repo, 'README.md'), 'x');
    for (const configPath of ['.devcontainer/devcontainer.json', 'README.md/devcontainer.json']) {
      const result = runNode(readFilesCommand(repo, configPath));
      expect(result.stderr, configPath).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
    }
  });

  // Review round 2 of PR #121 (A-2): a configuration path that is a link to the repository folder itself is a folder, as a
  // link to any other folder of the repository: no configuration (it was refused as a file out of the repository).
  it('takes a configuration path that links to the repository folder itself for a configuration that does not exist', () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, 'x'), { recursive: true });
    fs.symlinkSync('..', path.join(repo, 'x', 'root.json'));
    const result = runNode(readFilesCommand(repo, 'x/root.json'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBeNull();
  });

  // Mutant: ELOOP -> undefined (a configuration that does not exist). The PR refuses it (null).
  it('refuses a configuration file that is a link in a circle', () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, '.devcontainer'), { recursive: true });
    fs.symlinkSync('other.json', path.join(repo, '.devcontainer', 'devcontainer.json'));
    fs.symlinkSync('devcontainer.json', path.join(repo, '.devcontainer', 'other.json'));
    const result = runNode(readFilesCommand(repo, '.devcontainer/devcontainer.json'));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(REFUSED);
  });

  // B-R14, a regression of the first version of the PR (fixed in its review round 1): before, a missing repository folder
  // printed null, and the batch helper relies on it (batchHelper.ts, A-R5-1: "a missing folder ... runs the step as
  // nobody ... so that its script reports it as before (readFiles: no configuration)"); environmentService
  // .resolveConfigFiles then gives noConfiguration. The first version threw "The configuration file is not a file of the
  // repository." (readInRepository: rootReal === null -> null).
  it('gives null when the repository folder does not exist, as before the PR', () => {
    const root = tempDir();
    const result = runNode(readFilesCommand(path.join(root, 'gone'), '.devcontainer/devcontainer.json'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBeNull();
  });

  // Review round 1 of PR #121 (B, finding 7): a socket as the configuration (or its Dockerfile) failed the whole script
  // with ENXIO (also before the PR); it is no plain file of the repository: refused (the configuration) or not read (the
  // Dockerfile), as a FIFO.
  it('refuses a socket as the configuration and reads none as the Dockerfile', async () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, 'a'), { recursive: true });
    write(path.join(repo, 'b', 'devcontainer.json'), BUILD_CONFIG);
    const servers = [path.join(repo, 'a', 'devcontainer.json'), path.join(repo, 'b', 'Dockerfile')].map((socket) => net.createServer().listen(socket));
    try {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())))));
      const config = runNode(readFilesCommand(repo, 'a/devcontainer.json'));
      expect(config.status).not.toBe(0);
      expect(config.stderr).toContain(REFUSED);
      const dockerfile = runNode(readFilesCommand(repo, 'b/devcontainer.json'));
      expect(dockerfile.status, dockerfile.stderr).toBe(0);
      expect(JSON.parse(dockerfile.stdout)).toEqual({ configText: BUILD_CONFIG, dockerfilePath: 'b/Dockerfile' });
    } finally {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });
});
