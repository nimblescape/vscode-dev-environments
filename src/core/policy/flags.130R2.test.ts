// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #130 (reviewer B): mutants of buildContextProblems (flags.ts) that survived the whole unit suite
// (scratchpad p130r2B-report.md). `docker buildx build --build-context name=value` (Buildx 0.37.2,
// util/buildflags/context.go ParseContextNames, build/opt.go) takes the value as it is: an image only by the exact prefix
// `docker-image://`, a URL only by the exact `https://` or `http://`; with a space before the prefix the value is a
// local path, relative to the working folder of the build. The tests of A-F2 (hostAccess.test.ts) spell the prefixes in
// upper case, never with a space before them, and no test has an image ID in a build context. Each test names the
// mutants that it kills:
// - F01: imageContext of the trimmed value (` docker-image://alpine` taken for an image, the path not checked);
// - F02: isUrlContext of the trimmed value (` https://…` taken for a URL, the path not checked);
// - F05: the image of a build context not checked (an image ID stays refused).
import { describe, expect, it } from 'vitest';
import { resourceName } from '../names';
import { hostAccessProblems } from './index';

const OWN = resourceName('acme/api', '3f2a9c1e-0000-4000-8000-000000000000');

function problems(options: string[]): string[] {
  return hostAccessProblems({ config: { build: { dockerfile: 'Dockerfile', options } }, ownVolume: OWN });
}

describe('review round 2 of PR #130 (reviewer B)', () => {
  it('refuses a build context of an image or a URL after a space, a path for Buildx (F01, F02)', () => {
    expect(problems(['--build-context', 'x= docker-image://alpine'])).toEqual(['build option --build-context=x= docker-image://alpine']);
    expect(problems(['--build-context', 'x= https://example.com/x.git'])).toEqual(['build option --build-context=x= https://example.com/x.git']);
    expect(problems(['--build-context', 'a=docker-image://alpine:3', '--build-context=b=http://example.com/b.tar.gz', '--build-context', 'c=https://example.com/c.git'])).toEqual([]);
  });

  it('refuses the image ID of a build context (F05)', () => {
    expect(problems(['--build-context', 'x=docker-image://sha256:abc'])).toEqual(['build option --build-context image sha256:abc (an image ID; name the image)']);
  });
});
