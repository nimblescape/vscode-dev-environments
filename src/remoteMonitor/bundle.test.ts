// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Session Monitor on a remote Docker host gets its script as an argument of `docker run`, and `ensure` refuses one
// longer than MAX_SCRIPT_LENGTH or a command line longer than MAX_WINDOWS_COMMAND_LINE: then no monitor starts at all. The image maintenance of
// PR #57 and the monitor cleanup of PR #63 made the script about 29 K of the 30 K characters (review round 3 of PR #63,
// R3-5), so the build as esbuild.mjs makes it, and the whole command line of
// `docker run` (windowsCommandLineLength), are checked here. Review round 6 of PR #63 (R6-6; round 5, R5-5, measured
// 29,741), measured at the head of the round-6 fixes: the script is 29,940 of the 30,000 characters; the line with one
// prefix of 128 characters is 31,241 of the 32,000 (31,192 with the two default prefixes). runArgs fills the rest of the
// line with prefixes (the most that the settings allow give 31,906), so the script limit binds first: a script that fits
// leaves room for at least one prefix.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { MAX_SCRIPT_LENGTH, MAX_WINDOWS_COMMAND_LINE, imagePrefixesOf, windowsCommandLineLength } from '../core/remoteMonitor/protocol';
import { RemoteSessionMonitor } from '../core/remoteMonitor/remoteSessionMonitor';
import { silentLogger } from '../core/ports';

describe('the script of the remote Session Monitor', () => {
  it('fits MAX_SCRIPT_LENGTH when it is built as for the extension', async () => {
    const result = await esbuild.build({
      entryPoints: [path.resolve(__dirname, 'main.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      minify: true,
      write: false,
      logLevel: 'silent',
    });
    const script = result.outputFiles[0].text;
    expect(script.length).toBeLessThanOrEqual(MAX_SCRIPT_LENGTH);
    // The whole command line of `docker run`, with the default image settings.
    const monitor = new RemoteSessionMonitor({ docker: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) }, logger: silentLogger, script: async () => script });
    const args = monitor.runArgs('devenv-helper:0123456789ab', '/run/user/1000/docker.sock', '0123456789ab', script, {
      prefixes: ['ghcr.io/majikmate/devcontainer-classroom', 'ghcr.io/majikmate/devcontainer-dev'],
      schedule: '7 6 * * *',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    expect(windowsCommandLineLength(['docker', ...args])).toBeLessThanOrEqual(MAX_WINDOWS_COMMAND_LINE);
    // Review round 6 of PR #57 (F2): the most that the settings allow (50 patterns of 128 characters) still fits.
    const most = imagePrefixesOf(Array.from({ length: 50 }, (_, index) => `ghcr.io/${String(index).padStart(2, '0')}${'a'.repeat(118)}*`));
    const longest = monitor.runArgs('devenv-helper:0123456789ab', '/run/user/1000/docker.sock', '0123456789ab', script, { prefixes: most, schedule: '7 6 * * *', timeZone: 'America/Argentina/Buenos_Aires' });
    expect(windowsCommandLineLength(['docker', ...longest])).toBeLessThanOrEqual(MAX_WINDOWS_COMMAND_LINE);
  });
});
