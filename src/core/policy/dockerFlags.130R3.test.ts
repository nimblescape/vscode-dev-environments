// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of PR #130 (reviewer B): mutants of localContextPath (dockerFlags.ts) that survived every unit test
// whose module graph holds dockerFlags.ts (scratchpad p130r3B-report.md). localContextPath leaves out a build context
// only by the exact prefix of what Buildx never reads from the files of the build client (bake/bake.go loadLinks and
// isLocalPath, build/opt.go: `target:` exactly, `docker-image://`, `http://`, `https://`; Docker Compose makes
// `service:` a `target:`); every other value is checked as a path, and a relative one is refused whatever the switch
// says. The tests of D1 (composeAccess.test.ts, composeAccess.checksOff.test.ts, hostAccess.checksOff.test.ts) cover
// `cwd://`, another scheme and the exact `target:` and `service:` of Compose, not these spellings. Each test names the
// mutants that it kills:
// - L05, L06: `target:` or `service:` in another case taken for the prefix (the values with a blank before the prefix
//   pin the order of the trim too, whose mutant L12 the suite kills already);
// - L07, L08: `target` or `service` without the colon (a relative folder `targets/…` or `services/…` taken for a
//   target);
// - L09, L10: `target:` or `service:` anywhere in the value (a folder of the workspace helper that holds one of them
//   taken for a target).
import { describe, expect, it } from 'vitest';
import { composeProjectName, resourceName } from '../names';
import { composeAccessClassification, hostAccessClassification, type HostAccessFinding } from './index';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = composeProjectName('acme/api', ID);
const OWN = resourceName('acme/api', ID);
const REPO = '/workspaces/api';

/** The findings of `source` as the value of `--build-context` (single container). */
function single(source: string): HostAccessFinding[] {
  return hostAccessClassification({ config: { build: { dockerfile: 'Dockerfile', options: ['--build-context', `x=${source}`] } }, ownVolume: OWN });
}

/** The findings of `source` as a value of `additional_contexts` (Docker Compose). */
function compose(source: string): HostAccessFinding[] {
  return composeAccessClassification({
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
}

/** A value that Buildx reads as a folder relative to its working folder: refused whatever the switch says. */
function expectRelativeFolder(source: string): void {
  expect(single(source), JSON.stringify(source)).toEqual([{ item: `build option --build-context=x=${source}`, class: 'protected' }]);
  expect(compose(source), JSON.stringify(source)).toEqual([
    { item: `service db: build additional_contexts x=${source}`, class: 'computer' },
    { item: `service db: build additional_contexts x=${source} (a relative path)`, class: 'protected' },
  ]);
}

describe('review round 3 of PR #130 (reviewer B)', () => {
  it('takes target: and service: only by the exact lower-case prefix; in another case or after a blank, a relative folder (L05, L06)', () => {
    for (const source of ['TARGET:base', 'SERVICE:app', 'Target:base', ' target:base', ' service:app']) expectRelativeFolder(source);
    // The exact prefix: a target of the build, which build/opt.go hands to the frontend, no folder (the exact `target:`
    // and `service:` of Docker Compose: composeAccess.test.ts).
    expect(single('target:base')).toEqual([{ item: 'build option --build-context=x=target:base', class: 'computer' }]);
  });

  it('refuses a relative folder whose name starts with target or service (L07, L08)', () => {
    for (const source of ['targets/base', 'target', 'services/app', 'service']) expectRelativeFolder(source);
  });

  it('refuses a folder of the workspace helper that holds target: or service: (L09, L10)', () => {
    for (const source of ['/devenv-cache/target:x', '/devenv-cache/service:x']) {
      expect(single(source), source).toEqual([{ item: `build option --build-context=x=${source}`, class: 'protected' }]);
      expect(compose(source), source).toEqual([{ item: `service db: build additional_contexts x=${source}`, class: 'protected' }]);
    }
  });
});
