// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3: the base of every fake DockerEngine of the tests: each method fails, so that a test names only the
// methods that its flow may use, and a call of any other one fails the test.
import type { DockerEngine } from './dockerEngine';

/** A DockerEngine whose every method rejects with the name of the method; a fake overrides the ones it serves. */
export function unusedEngine(): DockerEngine {
  const unused =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`The fake engine of this test does not serve ${name}.`);
    };
  return {
    container: unused('container'),
    containers: unused('containers'),
    exec: unused('exec'),
    stop: unused('stop'),
    start: unused('start'),
    version: unused('version'),
    inspect: unused('inspect'),
    containerIds: unused('containerIds'),
    images: unused('images'),
    volumeNames: unused('volumeNames'),
    networkNames: unused('networkNames'),
    removeContainer: unused('removeContainer'),
    renameContainer: unused('renameContainer'),
    removeImage: unused('removeImage'),
    createVolume: unused('createVolume'),
    removeVolume: unused('removeVolume'),
    removeNetwork: unused('removeNetwork'),
    pull: unused('pull'),
    labelImage: unused('labelImage'),
    runContainer: unused('runContainer'),
  };
}
