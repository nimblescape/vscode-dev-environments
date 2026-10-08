// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #125 (reviewer B): probes of the mutants of the image calls of BootstrapDocker after plan step 11I
// (PR D) replaced MISSING_PATTERNS by IMAGE_MISSING_PATTERN. The tests of the PR only answer `No such image` and never a
// call that ran out of time; each probe names its mutant.
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import { silentLogger, type ProcessRunner, type RunResult } from '../ports';
import { BootstrapDocker } from './bootstrapDocker';

const DOCKER = '/usr/local/bin/docker';

function bootstrap(answer: (args: readonly string[]) => RunResult): BootstrapDocker {
  const runner: ProcessRunner = { run: async (_file, args) => answer(args) };
  return new BootstrapDocker(runner, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'linux');
}

describe('review round 1 of PR #125 (reviewer B): a missing image for BootstrapDocker', () => {
  // Mutant BD-missing-noobject: IMAGE_MISSING_PATTERN without `object` (the words of `docker inspect` of older Docker
  // versions for a missing image: "Error: No such object: <reference>").
  it('reads "No such object" as a missing image', async () => {
    const docker = bootstrap(() => ({ exitCode: 1, stdout: '', stderr: 'Error: No such object: gone:1', timedOut: false }));
    expect(await docker.imageExists('gone:1')).toBe(false);
    expect(await docker.imageId('gone:1')).toBeUndefined();
    expect(await docker.removeImage('gone:1')).toBe(false);
  });

  // Mutant BD-missing-timeout: a call that ran out of time is never a missing image, whatever it printed before.
  it('never reads a call that ran out of time as a missing image', async () => {
    const docker = bootstrap(() => ({ exitCode: null, stdout: '', stderr: 'Error response from daemon: No such image: gone:1', timedOut: true }));
    await expect(docker.imageExists('gone:1')).rejects.toBeInstanceOf(CommandError);
    await expect(docker.imageId('gone:1')).rejects.toBeInstanceOf(CommandError);
    await expect(docker.removeImage('gone:1')).rejects.toBeInstanceOf(CommandError);
  });
});
