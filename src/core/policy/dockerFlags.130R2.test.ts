// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #130 (reviewer B): mutants of imageContext and isUrlContext (dockerFlags.ts) that survived the
// whole unit suite (scratchpad p130r2B-report.md). Buildx 0.37.2 (build/opt.go, util/urlutil) takes a build context for
// an image only by the exact prefix `docker-image://` (`docker-image:alpine` is a local path), and for a URL only by the
// exact prefix `https://` or `http://` (` https://…` with a space before it and `httpdocs` are local paths, relative to
// the working folder of the build); a local path that the policy takes for an image or a URL escapes the check of the
// path. The tests of A-F2 spell the prefixes in upper case or put a space before `docker-image://`, never before
// `https://`, and use only `https://`. Each test names the mutants that it kills:
// - I07: `docker-image:` without `//` taken for an image;
// - U02: the value trimmed before the prefix of a URL; U03: only `https://` a URL; U04: any value that starts with
//   `http` a URL.
import { describe, expect, it } from 'vitest';
import { composeProjectName, resourceName } from '../names';
import { composeAccessReport, hostAccessProblems, imageContext, isUrlContext } from './index';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = composeProjectName('acme/api', ID);
const OWN = resourceName('acme/api', ID);
const REPO = '/workspaces/api';

/** The items of `source` as the value of `--build-context` (single container) and of `additional_contexts` (Compose). */
function contextProblems(source: string): { single: string[]; compose: string[] } {
  const single = hostAccessProblems({ config: { build: { dockerfile: 'Dockerfile', options: ['--build-context', `x=${source}`] } }, ownVolume: OWN });
  const report = composeAccessReport({
    model: {
      name: PROJECT,
      services: {
        app: { build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile' }, command: ['sleep', 'infinity'], volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces' }] },
        db: { build: { context: REPO, additional_contexts: { x: source } } },
      },
      networks: { default: { name: `${PROJECT}_default` } },
    },
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: OWN,
    engineApiVersion: '1.47',
    environment: { id: ID, ownerId: '42' },
  });
  return { single, compose: [...report.hostAccess, ...report.unsupported] };
}

describe('review round 2 of PR #130 (reviewer B)', () => {
  it('takes only docker-image:// for an image, and only http:// or https:// for a URL (I07, U02, U03, U04)', () => {
    expect(imageContext('docker-image://alpine:3')).toBe('alpine:3');
    expect(imageContext('docker-image:alpine:3')).toBeUndefined();
    expect(isUrlContext('http://example.com/a.tar.gz')).toBe(true);
    expect(isUrlContext('https://example.com/b.git')).toBe(true);
    expect(isUrlContext(' https://example.com/b.git')).toBe(false);
    expect(isUrlContext('httpdocs')).toBe(false);
  });

  it('allows a build context of an http:// URL (U03)', () => {
    expect(contextProblems('http://example.com/a.tar.gz')).toEqual({ single: [], compose: [] });
  });

  it('refuses a build context that Buildx reads as a local path although it looks like an image or a URL (I07, U02, U04)', () => {
    // Review round 2 of PR #130 (D1): Buildx reads it as a path relative to its working folder, so it is also refused whatever the switch says.
    expect(contextProblems('docker-image:alpine')).toEqual({
      single: ['build option --build-context=x=docker-image:alpine'],
      compose: ['service db: build additional_contexts x=docker-image:alpine', 'service db: build additional_contexts x=docker-image:alpine (a relative path)'],
    });
    expect(contextProblems(' https://example.com/x.git')).toEqual({
      single: ['build option --build-context=x= https://example.com/x.git'],
      compose: ['service db: build additional_contexts x= https://example.com/x.git', 'service db: build additional_contexts x= https://example.com/x.git (a relative path)'],
    });
    expect(contextProblems('httpdocs')).toEqual({
      single: ['build option --build-context=x=httpdocs'],
      compose: ['service db: build additional_contexts x=httpdocs', 'service db: build additional_contexts x=httpdocs (a relative path)'],
    });
  });
});
