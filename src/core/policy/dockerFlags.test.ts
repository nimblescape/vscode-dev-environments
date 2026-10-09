// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of PR #130 (R3A-1, R3A-4): the folder of a build context as Buildx 0.37.2 reads it. An OCI layout
// reference loses its digest and its tag as util/ocilayout Parse takes them off (the unanchored DigestRegexp and
// TagRegexp of distribution/reference); every value is taken as written, not trimmed.
import { describe, expect, it } from 'vitest';
import { localContextPath, ociLayoutFolder } from './dockerFlags';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('ociLayoutFolder (review round 3 of PR #130, R3A-1)', () => {
  it.each([
    ['/repo/layout', '/repo/layout'],
    ['/repo/layout:1', '/repo/layout'],
    [`/repo/layout@${DIGEST}`, '/repo/layout'],
    [`/repo/layout:1@${DIGEST}`, '/repo/layout'],
    // The tag is after the last colon of the whole rest, not of its last folder.
    ['/repo/x:a:1', '/repo/x:a'],
    ['/repo/a:b/c', '/repo/a'],
    // A digest has at least 32 hexadecimal digits; a shorter one is taken for a tag.
    ['/repo/x@sha256:abc', '/repo/x@sha256'],
    // A part without a word character is no tag.
    ['/repo/x:..', '/repo/x:..'],
    // The colon of a Windows drive is no tag.
    ['C:/layout', 'C:/layout'],
  ])('%s is the folder %s', (rest, folder) => {
    expect(ociLayoutFolder(rest)).toBe(folder);
  });
});

describe('localContextPath (review round 3 of PR #130)', () => {
  it('takes the value as Buildx reads it: not trimmed, and oci-layout:// only by its exact prefix (R3A-1)', () => {
    expect(localContextPath('oci-layout:///repo/x:1')).toBe('/repo/x');
    expect(localContextPath(' oci-layout:///repo/x:1')).toBe(' oci-layout:///repo/x:1');
    expect(localContextPath('OCI-LAYOUT:///etc')).toBe('OCI-LAYOUT:///etc');
    expect(localContextPath(' /devenv-cache')).toBe(' /devenv-cache');
  });

  it('leaves service: to Docker Compose, which makes it a target; for docker buildx build it is a folder (R3A-4)', () => {
    expect(localContextPath('service:app')).toBe('service:app');
    expect(localContextPath('target:base')).toBeUndefined();
  });
});
