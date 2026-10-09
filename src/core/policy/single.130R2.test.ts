// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #130 (reviewer B): mutants of singleImageReferences (single.ts) that survived the whole unit
// suite (scratchpad p130r2B-report.md); no test gives it a value that the new rule (imageContext, A-F2) reads otherwise
// than the old one. Buildx pulls the image of `--build-context name=docker-image://<image>` only by the exact prefix (a
// value with a space before it, or in another case, is a local path, which the policy refuses), and the references are
// trimmed as that of `image` is. Each test names the mutants that it kills:
// - G01: imageContext of the trimmed value; G02: the old rule (`/^docker-image:\/\/(.*)$/i` on the trimmed value);
// - G03: the image not trimmed.
import { describe, expect, it } from 'vitest';
import { singleImageReferences } from './index';

describe('review round 2 of PR #130 (reviewer B)', () => {
  it('asks only about the images of --build-context that Buildx pulls, trimmed (G01, G02, G03)', () => {
    const options = ['--build-context', 'a=docker-image://alpine:3 ', '--build-context', 'b= docker-image://busybox:1', '--build-context=c=DOCKER-IMAGE://debian:12', '--build-context', 'd=https://example.com/d.git'];
    expect(singleImageReferences({ build: { dockerfile: 'Dockerfile', options } })).toEqual([{ reference: 'alpine:3', what: 'build option --build-context image' }]);
  });
});
