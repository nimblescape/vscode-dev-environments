// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR #119 review round 1 (B, mutation testing): checkImagePresent passes the abort of its signal through (its wrapper of
// the worker preparation is gone).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAbortError, silentLogger } from '../ports';
import { helperImageTag } from './helperImage';
import { HelperImages, type HelperImageDocker } from './helperImages';

const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const ID = `sha256:${'a'.repeat(64)}`;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-images-probe-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('HelperImages.checkImagePresent (PR #119, B-R1)', () => {
  it('rejects with an AbortError, not helperFailed, when its signal aborts during the check', async () => {
    const controller = new AbortController();
    const docker: HelperImageDocker = {
      imageExists: async () => true,
      imageId: async () => {
        controller.abort();
        return ID;
      },
      buildImage: async () => ID,
      listImagesByLabel: async () => [],
      removeImage: async () => false,
    };
    const helper = new HelperImages({ docker, logger: silentLogger, dockerfilePath: path.join(dir, 'Dockerfile') });
    expect(helperImageTag(DOCKERFILE)).toBeTruthy();
    await expect(helper.checkImagePresent({ signal: controller.signal })).rejects.toSatisfy(isAbortError);
  });
});
