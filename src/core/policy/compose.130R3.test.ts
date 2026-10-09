// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of PR #130 (reviewer B): mutants of bakeTemplateProblems and of its call in buildProblems (compose.ts)
// that survived every unit test whose module graph holds compose.ts (scratchpad p130r3B-report.md). Bake reads the
// build definition of Docker Compose as HCL (checked with `docker buildx bake --print`): `${…}` and `%{…}` are
// evaluated, the escapes `$${` and `%%{` become a literal `${` and `%{` (so bake reads another path than the text that
// the policy checks), a lone `$`, `%` or brace stays as written, and an unclosed `${` or `%{` fails to parse. The
// tests of R2A-1 (composeAccess.test.ts) put each template into one value of the service `db` with a local context and
// a Dockerfile file, both escapes into one value, and the template of cache_from into its only entry. Each test names
// the mutants that it kills:
// - T04: only the first entry of cache_from checked;
// - T10, T11: an escape `$${` or `%%{` taken for no template (each alone);
// - T12: a template only with its closing brace (an unclosed one holds `${` or `%{` too, the documented rule);
// - T14: any `%` taken for a template (a lone `%`, `$` or brace stays allowed; any `$`, T13, the suite kills already);
// - P02: no template check for a remote context; P04: none for the dev service; P06: none next to dockerfile_inline;
// - P07: a template returned alone, without the other items of the build; P09: a template named only when the build
//   has no other item (so the switch, which lifts the other item, lifts the build).
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from '../helper/composeModel';
import { composeProjectName, resourceName } from '../names';
import { composeAccessReport, type ComposeAccessInput, type HostAccessReport } from './index';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = composeProjectName('acme/api', ID);
const REPO = '/workspaces/api';
/** The reason of a value that bake evaluates as a template (bakeTemplateProblems). */
const TEMPLATE = '(Buildx evaluates `${` and `%{` in it as a template)';
/** A cache import that bake makes a local one from the cache volume of the workspace helper. */
const CACHE = 'type=registry,%{if true}type%{endif}=local,src=/devenv-cache';

/**
 * A model that the policy allows (the dev service `app`), and the service `db` built with `build`; `devBuild` adds to
 * the build of the dev service.
 */
function model(build: Record<string, unknown>, devBuild: Record<string, unknown> = {}): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: {
        build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile', ...devBuild },
        command: ['sleep', 'infinity'],
        volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces' }],
      },
      db: { build: { context: REPO, ...build } },
    },
    networks: { default: { name: `${PROJECT}_default` } },
  };
}

/** The report of the model (its items sorted: the order of the items is no part of these rules). */
function report(build: Record<string, unknown>, devBuild: Record<string, unknown> = {}, checksOn = true): HostAccessReport {
  const input: ComposeAccessInput = {
    model: model(build, devBuild),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: resourceName('acme/api', ID),
    engineApiVersion: '1.47',
    environment: { id: ID, ownerId: '42' },
  };
  const result = composeAccessReport(input, checksOn);
  return { hostAccess: [...result.hostAccess].sort(), unsupported: [...result.unsupported].sort() };
}

const NONE: HostAccessReport = { hostAccess: [], unsupported: [] };
const A = (...items: string[]): HostAccessReport => ({ hostAccess: items.sort(), unsupported: [] });
const U = (...items: string[]): HostAccessReport => ({ hostAccess: [], unsupported: items.sort() });

describe('review round 3 of PR #130 (reviewer B)', () => {
  it('refuses a template in any entry of cache_from, not only in the first (T04)', () => {
    expect(report({ cache_from: ['acme/cache:1', CACHE] })).toEqual(U(`service db: build cache_from ${CACHE} ${TEMPLATE}`));
  });

  it('refuses an escape alone, which bake reads as a literal `${` or `%{` (T10, T11)', () => {
    expect(report({ context: `${REPO}/$\${x}` })).toEqual(U(`service db: build context ${REPO}/$\${x} ${TEMPLATE}`));
    expect(report({ context: `${REPO}/%%{x}` })).toEqual(U(`service db: build context ${REPO}/%%{x} ${TEMPLATE}`));
    const contexts = { a: `${REPO}/$\${a}`, b: `${REPO}/%%{b}` };
    const templates = [`service db: build additional_contexts a ${REPO}/$\${a} ${TEMPLATE}`, `service db: build additional_contexts b ${REPO}/%%{b} ${TEMPLATE}`];
    expect(report({ additional_contexts: contexts })).toEqual({
      hostAccess: [`service db: build additional_contexts a=${REPO}/$\${a}`, `service db: build additional_contexts b=${REPO}/%%{b}`],
      unsupported: templates,
    });
    // Whatever the switch says.
    expect(report({ additional_contexts: contexts }, {}, false)).toEqual(U(...templates));
  });

  it('refuses an unclosed `${` or `%{`, a value that holds one (T12)', () => {
    expect(report({ context: `${REPO}/\${x` })).toEqual(U(`service db: build context ${REPO}/\${x ${TEMPLATE}`));
    expect(report({ dockerfile: 'Dockerfile%{x' })).toEqual(U(`service db: build dockerfile Dockerfile%{x ${TEMPLATE}`));
  });

  it('allows a lone `$`, `%` or brace, which bake reads as written (T14)', () => {
    expect(report({ context: `${REPO}/a$b%c{d}`, dockerfile: 'D$o%c{k}', cache_from: ['type=registry,ref=acme/cache:1,a=$%'] })).toEqual(NONE);
    expect(report({ additional_contexts: { x: `${REPO}/e$f%g{h}` } })).toEqual(A(`service db: build additional_contexts x=${REPO}/e$f%g{h}`));
  });

  it('refuses a template with a remote context too (P02)', () => {
    expect(report({ context: 'https://github.com/acme/tool.git', cache_from: [CACHE] })).toEqual(
      U(`service db: build cache_from ${CACHE} ${TEMPLATE}`, 'service db: build context https://github.com/acme/tool.git (a remote build context is not supported yet)'),
    );
  });

  it('refuses a template in the build of the dev service (P04)', () => {
    expect(report({}, { cache_from: [CACHE], additional_contexts: { x: 'docker-image://%{if true}alpine%{endif}' } })).toEqual(
      U(`service app: build cache_from ${CACHE} ${TEMPLATE}`, `service app: build additional_contexts x docker-image://%{if true}alpine%{endif} ${TEMPLATE}`),
    );
  });

  it('refuses a template next to dockerfile_inline (P06)', () => {
    expect(report({ context: `${REPO}/%{if true}..%{endif}/x`, dockerfile_inline: 'FROM alpine', cache_from: [CACHE] })).toEqual(
      U(`service db: build context ${REPO}/%{if true}..%{endif}/x ${TEMPLATE}`, `service db: build cache_from ${CACHE} ${TEMPLATE}`),
    );
  });

  it('names a template next to the other items of the build, and keeps it with the checks off (P07, P09)', () => {
    const build = { secrets: ['npmrc'], cache_from: [CACHE] };
    expect(report(build)).toEqual({ hostAccess: ['service db: build secrets'], unsupported: [`service db: build cache_from ${CACHE} ${TEMPLATE}`] });
    expect(report(build, {}, false)).toEqual(U(`service db: build cache_from ${CACHE} ${TEMPLATE}`));
  });
});
