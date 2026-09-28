// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Session Monitor on a remote Docker host gets its script as an argument of `docker run`, and `ensure` refuses one
// longer than MAX_SCRIPT_LENGTH (the command line of Windows): then no monitor starts at all. The image maintenance of
// PR #57 made the script about 24 K characters, so the build as esbuild.mjs makes it is checked here.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { MAX_SCRIPT_LENGTH } from '../core/remoteMonitor/protocol';

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
    expect(result.outputFiles[0].text.length).toBeLessThanOrEqual(MAX_SCRIPT_LENGTH);
  });
});
