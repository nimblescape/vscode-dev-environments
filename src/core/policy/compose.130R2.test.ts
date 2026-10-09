// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #130 (reviewer B): mutants of compose.ts that survived the whole unit suite (scratchpad
// p130r2B-report.md). Buildx 0.37.2 reads an entry of `cache_from` by util/buildflags/cache.go: without `=` each CSV
// field is the reference of a registry image; else the fields of go-csvvalue (one record: only a trailing line break is
// dropped, one inside the text is part of a field), keys in lower case and not trimmed, values as they are, the last
// `type` counting; only the exact type `local` reads a local folder (BuildKit's client). cacheFromIsRegistry takes
// exactly one `type` field with exactly the value `registry`; the tests of A-F1 (composeAccess.test.ts) pin a second
// `type` after `type=registry` and keys in another case, not the rest. Each test names the mutants that it kills:
// - C06a/C06b/C06c: a text that csvFields cannot read (a line break) allowed, read with `text.split(',')` (as
//   optionFields does), or the `undefined` check dropped (a TypeError). Buildx reads
//   `type=registry,"type=local",a=b\n,src=/tmp/c` as one record whose quoted second `type` wins: a local cache import
//   from /tmp/c of the workspace helper, the case of A-F1.
// - C04 (the last `type` counts), C09 (`types >= 1`), C10 (`types <= 1`: no `type` at all), C02 (the key not trimmed),
//   C05 (the value trimmed), C12 (the value compared case-insensitively), C08 (the empty text a registry reference):
//   exactly one `type` field, counted also with spaces around its key, with exactly the value `registry`. Each of these
//   accepts only entries that Buildx 0.37.2 reads as a registry import or refuses, so the test pins the documented rule,
//   which does not depend on which of several types Buildx takes or on how it spells a key.
// - K01: the entry not trimmed by buildProblems: the item names a refused entry without the spaces around it.
// - S02: an additional context taken for a URL after trimming (` https://…` is a path for Buildx).
// - S05: the image of an additional context not checked (an image ID stays refused).
// - R01/R02/R03: composeImageReferences takes an image by the exact prefix only (R01: after trimming; R02: the old
//   rule, case-insensitive after trimming), and trims it as it trims the `image` of a service (R03).
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from '../helper/composeModel';
import { composeProjectName, resourceName } from '../names';
import { cacheFromIsRegistry, composeAccessReport, composeImageReferences, type ComposeAccessInput, type HostAccessReport } from './index';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = composeProjectName('acme/api', ID);
const REPO = '/workspaces/api';
const NONE: HostAccessReport = { hostAccess: [], unsupported: [] };
const A = (...items: string[]): HostAccessReport => ({ hostAccess: items, unsupported: [] });
const U = (...items: string[]): HostAccessReport => ({ hostAccess: [], unsupported: items });

/** A model that the policy allows (the dev service `app`), and the service `db` built with `build`. */
function model(build: Record<string, unknown>): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: {
        build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile' },
        command: ['sleep', 'infinity'],
        volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces' }],
      },
      db: { build: { context: REPO, ...build } },
    },
    networks: { default: { name: `${PROJECT}_default` } },
  };
}

function report(build: Record<string, unknown>): HostAccessReport {
  const input: ComposeAccessInput = {
    model: model(build),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: resourceName('acme/api', ID),
    engineApiVersion: '1.47',
    environment: { id: ID, ownerId: '42' },
  };
  return composeAccessReport(input);
}

describe('review round 2 of PR #130 (reviewer B)', () => {
  it('refuses a cache import with a line break, which Buildx reads as one record with a second type (C06a, C06b, C06c)', () => {
    const entry = 'type=registry,"type=local",a=b\n,src=/tmp/c';
    expect(cacheFromIsRegistry(entry)).toBe(false);
    expect(report({ cache_from: [entry] })).toEqual(U(`service db: build cache_from ${entry}`));
  });

  it('takes a cache import only with exactly one type field whose value is exactly registry (C02, C04, C05, C08, C09, C10, C12)', () => {
    for (const entry of ['acme/cache:1', 'acme/a,acme/b', 'type=registry', 'type=registry,ref=acme/cache', 'TYPE=registry,ref=acme/cache', 'type=registry,"ref=acme/cache"']) {
      expect(cacheFromIsRegistry(entry), entry).toBe(true);
    }
    const refused = [
      '', // C08: no reference (Buildx skips an empty entry).
      'type=local,src=/tmp/c,type=registry', // C04: the last type is `registry`, but there are two.
      'type=registry,type=registry', // C09: two type fields.
      'type=registry, type=local,src=/tmp/c', // C02: a second type field, with a space before its key.
      'ref=acme/cache', // C10: no type field (Buildx: "type required").
      'type= registry', // C05: the type ` registry`, which BuildKit does not know.
      'type=registry ', // C05: the type `registry `.
      'type=Registry', // C12: the type `Registry`.
    ];
    for (const entry of refused) expect(cacheFromIsRegistry(entry), JSON.stringify(entry)).toBe(false);
    expect(report({ cache_from: ['type= registry', 'type=local,src=/tmp/c,type=registry', 'type=registry,type=registry'] })).toEqual(
      U('service db: build cache_from type= registry', 'service db: build cache_from type=local,src=/tmp/c,type=registry', 'service db: build cache_from type=registry,type=registry'),
    );
  });

  it('names a refused cache import without the spaces around it (K01)', () => {
    expect(report({ cache_from: ['  type=local,src=/tmp/c  ', ' acme/cache:1 '] })).toEqual(U('service db: build cache_from type=local,src=/tmp/c'));
  });

  it('refuses an additional context of a URL after a space, a path for Buildx (S02)', () => {
    // Review round 2 of PR #130 (D1): Buildx reads it as a path relative to its working folder, so it is also refused whatever the switch says.
    expect(report({ additional_contexts: { x: ' https://example.com/x.git' } })).toEqual(
      A('service db: build additional_contexts x= https://example.com/x.git', 'service db: build additional_contexts x= https://example.com/x.git (a relative path)'),
    );
    expect(report({ additional_contexts: { a: 'http://example.com/a.tar.gz', b: 'https://example.com/b.git' } })).toEqual(NONE);
  });

  it('refuses the image ID of an additional context (S05)', () => {
    expect(report({ additional_contexts: { x: 'docker-image://sha256:abc' } })).toEqual(U('service db: build additional_contexts x image sha256:abc (an image ID; name the image)'));
  });

  it('asks only about the images that Buildx pulls, trimmed (R01, R02, R03)', () => {
    const m = model({ additional_contexts: { a: 'docker-image://alpine:3 ', b: ' docker-image://busybox:1', c: 'DOCKER-IMAGE://debian:12', d: 'https://example.com/d.git' } });
    expect(composeImageReferences(m)).toEqual([{ reference: 'alpine:3', what: 'service db: build additional_contexts a image' }]);
  });
});
