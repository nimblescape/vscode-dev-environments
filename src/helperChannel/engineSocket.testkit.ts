// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G3 (moved here from batch.e2e.test.ts by plan step 11I, PR A, for channel.e2e.test.ts too): the worker of
// an end-to-end test talks to a fake engine of the test. Never bundled into the extension or the worker of dist.
import * as fs from 'fs';
import type * as esbuild from 'esbuild';

/**
 * Plan step 11G3: the Engine API of the worker's bundle on `socketPath` instead of /var/run/docker.sock (only in the
 * build of the test; the worker itself has no way to choose another engine).
 */
export function engineSocketPlugin(socketPath: string): esbuild.Plugin {
  return {
    name: 'engine-socket-of-the-test',
    setup(build) {
      build.onLoad({ filter: /[\\/]helperChannel[\\/]engineApi\.ts$/ }, async (args) => {
        const text = await fs.promises.readFile(args.path, 'utf8');
        const parts = text.split('socketPath: string = HELPER_DOCKER_SOCKET');
        // The API and the hijack: a change of either must change this test too.
        if (parts.length !== 3) throw new Error('The default socket of engineApi.ts changed; the e2e tests of the worker cannot replace it.');
        return { contents: parts.join(`socketPath: string = ${JSON.stringify(socketPath)}`), loader: 'ts' };
      });
    },
  };
}
