// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 16 (Dp): the Dev Container CLI 0.89.0 writes a compose file for the build of the dev service (function
// `Dp`), with the build arguments of its Dockerfile of Features as text: `- _DEV_CONTAINERS_BASE_IMAGE=<stage>` (the
// target of the build, or the name of the last stage of the Dockerfile). A line break there adds keys to the build (for
// example `ssh` or `secrets` with a file of the workspace helper) or to the dev service.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import { composeProjectName, resourceName } from '../names';
import type { ComposeModel } from './compose';
import { composeAccessReport, type ComposeAccessInput, type HostAccessReport } from '../policy';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
// User decisions 2026-10-03: one name per environment (resourceName); the project, the volume, and the container share it.
const PROJECT = composeProjectName('acme/api', ID);
const OWN = resourceName('acme/api', ID);
const REPO = '/workspaces/api';
const NONE: HostAccessReport = { hostAccess: [], unsupported: [] };
const DOCKERFILE = 'FROM mcr.microsoft.com/devcontainers/base:ubuntu AS base\nRUN true\n';

function model(build: Record<string, unknown>, service = 'app'): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: { image: 'alpine:3.22', command: ['sleep', 'infinity'] },
      db: { image: 'postgres:16' },
      [service]: { build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile', ...build }, command: ['sleep', 'infinity'] },
    },
  };
}

function report(build: Record<string, unknown>, dockerfile = DOCKERFILE, checksOn = true, service = 'app'): HostAccessReport {
  const input: ComposeAccessInput = {
    model: model(build, service),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: OWN,
    engineApiVersion: '1.47',
    dockerfiles: { [service]: dockerfile },
  };
  return composeAccessReport(input, checksOn);
}

const TARGET_VECTOR = 'base\n      ssh:\n        - default=/workspaces/.devenv+/github-token';

describe('review round 16 (Dp): the build of the dev service as the Dev Container CLI writes it', () => {
  it('refuses a build target that is no plain stage name, whatever the switch says', () => {
    for (const checksOn of [true, false]) {
      expect(report({ target: TARGET_VECTOR }, DOCKERFILE, checksOn).unsupported).toContain(
        `service app: build target ${JSON.stringify(TARGET_VECTOR)} (the Dev Container CLI writes it into its compose file for the build as it is: only a plain stage name is supported)`,
      );
    }
    for (const target of ['base\n    privileged: true', 'base\r', 'base\u0085x', 'base\u2028x', 'base x', 'base#x', 'base:', "base'", '-base', 7]) {
      expect(report({ target }).unsupported.length, JSON.stringify(target)).toBeGreaterThan(0);
    }
  });

  it('allows plain stage names, and leaves the targets of other services alone', () => {
    for (const target of ['base', 'dev_container', 'stage-1', 'Stage.2']) expect(report({ target }), target).toEqual(NONE);
    // Compose builds the other services itself; the CLI writes nothing of them.
    expect(report({ target: TARGET_VECTOR }, DOCKERFILE, true, 'db')).toEqual(NONE);
  });

  it('refuses a last stage whose name the CLI reads with a line break of YAML', () => {
    const dockerfile = 'FROM alpine AS a\u0085      ssh:\nRUN true\n';
    const items = report({}, dockerfile).unsupported;
    expect(items).toContain(`service app: the last stage ${JSON.stringify('a\u0085')} of the Dockerfile (the Dev Container CLI writes it into its compose file for the build as it is: only a plain stage name is supported)`);
    expect(items).toContain('service app: the Dockerfile, which holds the character U+0085 (the Dev Container CLI writes it into its compose file for the build as it is: a line break in a name or value is not supported)');
    // The target wins over the last stage (`if(X=EA,pA)Z=pA`).
    expect(report({ target: 'base' }, 'FROM alpine AS base\nFROM alpine AS b#x\n')).toEqual(NONE);
    expect(report({}, 'FROM alpine AS base\nFROM alpine AS b#x\n').unsupported.length).toBe(1);
    expect(report({}, 'FROM alpine\n')).toEqual(NONE);
  });

});

// ---------------------------------------------------------------------------------------------------------------------
// Guard (review round 16, Dp): the parts of `Dp` and the functions that it uses in the vendored CLI that the rules above
// follow, and the text of the compose file for the build with the values that the rules allow, read as YAML.

const CLI_FILE = require.resolve('@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js');
const yaml = createRequire(__filename)('js-yaml') as { load(text: string): unknown };

/**
 * The compose file that `Dp` writes for the build of the dev service `app` with Features, BuildKit, and no context of its
 * own (the lines of `q`, with `a` = '' and no cache_from): a copy of the template of the CLI (see the guard below).
 */
function buildOverride(stage: string, user: string): string {
  const buildArgs: Record<string, string> = {
    _DEV_CONTAINERS_BASE_IMAGE: stage,
    _DEV_CONTAINERS_IMAGE_USER: user,
    _DEV_CONTAINERS_FEATURE_CONTENT_SOURCE: 'dev_container_feature_content_temp',
  };
  let q = '    build:\n';
  q += '      dockerfile: /tmp/devcontainercli/container-features/0.1-1/Dockerfile-with-features\n';
  q += '      target: dev_containers_target_stage\n';
  q += '      context: /tmp/devcontainercli/empty-folder\n';
  q += '      args:\n';
  q += '        - BUILDKIT_INLINE_CACHE=1\n';
  for (const EA in buildArgs) q += `        - ${EA}=${buildArgs[EA]}\n`;
  q += '      additional_contexts:\n';
  q += '        - dev_containers_feature_content_source=/tmp/devcontainercli/container-features/0.1-1\n';
  return `services:\n  app:\n${q.trimEnd()}\n\n`;
}

describe('guard (review round 16, Dp): the compose file of the vendored CLI for the build', () => {
  it('the template and the values of the copy are those of the vendored CLI', () => {
    const cli = readFileSync(CLI_FILE, 'utf8');
    // The arguments, as text; the target stage and the base image; the user of the target stage.
    expect(cli).toContain('for(let EA in uA.buildArgs)q+=`        - ${EA}=${uA.buildArgs[EA]}\n`');
    expect(cli).toContain('q+=`      args:\n`,t.buildKitVersion&&(q+=`        - BUILDKIT_INLINE_CACHE=1\n`)');
    expect(cli).toContain('(dA=N.build)!=null&&dA.target&&(q+=`      target: ${uA.overrideTarget}\n`)');
    expect(cli).toContain('buildArgs:{_DEV_CONTAINERS_BASE_IMAGE:i,_DEV_CONTAINERS_IMAGE_USER:r.user,_DEV_CONTAINERS_FEATURE_CONTENT_SOURCE:I}');
    expect(cli).toContain('overrideTarget:"dev_containers_target_stage",dockerfilePrefixContent:');
    expect(cli).toContain('buildArgs:{_DEV_CONTAINERS_BASE_IMAGE:i},buildKitContexts:{},securityOpts:[]');
    expect(cli).toContain('if(X=EA,pA)Z=pA;else{let{lastStageName:UA,modifiedDockerfile:SA}=DQ(EA,Z);Z=UA,SA&&(X=SA)}');
    expect(cli).toContain('B=QG(C,t,ht(Q==null?void 0:Q.Config.Env),a,i)||(Q==null?void 0:Q.Config.User)||"root"');
    expect(cli).toContain('r=i.Config.User||"root"');
    expect(cli).toContain('yj=new RegExp(/^(?<line>\\s*FROM.*)/,"gmi"),Fj=/FROM\\s+(?<platform>--platform=\\S+\\s+)?(?<image>"?[^\\s]+"?)(\\s+AS\\s+(?<label>[^\\s]+))?/i');
    // The first compose file is our model, as JSON: no line of it starts with `version:` (`wp`).
    expect(cli).toContain('i=(/^\\s*(version:.*)$/m.exec(t)||[])[1]');
  });

  it('reproduces the injection with the target of the findings', () => {
    const parsed = yaml.load(buildOverride(TARGET_VECTOR, 'root')) as { services: { app: { build: Record<string, unknown> } } };
    expect(Object.keys(parsed.services.app.build)).toContain('ssh');
  });

  it('gives the build exactly its keys and arguments for every stage name and user that the rules allow', () => {
    const texts = ['base', 'stage-1', 'Stage.2', 'root', '1000:1000', 'a#b', 'a:b', "a'b", 'a"b', 'a b', 'a\tb'];
    for (const stage of ['base', 'dev_container_auto_added_stage_label', 'stage-1', 'Stage.2', TARGET_VECTOR, 'b#x', 'a\u0085x']) {
      const allowed = report({ target: stage }).unsupported.length === 0;
      if (!allowed) continue;
      for (const user of texts) {
        // slim-down: the user is no longer checked (the check of the user that the CLI computes is removed); the texts
        // here have no line break, as before.
        const parsed = yaml.load(buildOverride(stage, user)) as { services: { app: Record<string, Record<string, unknown>> } };
        expect(Object.keys(parsed)).toEqual(['services']);
        expect(Object.keys(parsed.services)).toEqual(['app']);
        expect(Object.keys(parsed.services.app)).toEqual(['build']);
        const build = parsed.services.app.build;
        expect(Object.keys(build)).toEqual(['dockerfile', 'target', 'context', 'args', 'additional_contexts']);
        const args = build.args as unknown[];
        expect(args.length, `${stage} ${user}`).toBe(4);
        expect(args[1]).toBe(`_DEV_CONTAINERS_BASE_IMAGE=${stage}`);
        // A `: ` or a trailing `:` would make a mapping of the entry, which Compose refuses (no key of its own).
        if (typeof args[2] === 'string') expect(args[2]).toBe(`_DEV_CONTAINERS_IMAGE_USER=${user.replace(/ #.*$/, '')}`);
      }
    }
  });
});

describe('review round 17 (P17-2): multi-line build arguments, and the stage name', () => {
  const CA_CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  const USER_DOCKERFILE = 'FROM mcr.microsoft.com/devcontainers/base:bookworm\nARG USERNAME=vscode\nARG EXTRA_CA_CERT\nRUN echo "$EXTRA_CA_CERT" > /x.crt\nUSER $USERNAME\n';
  const INJECTION = 'root\n      ssh:\n        - default=/workspaces/.devenv+/github-token';

  function reportWith(build: Record<string, unknown>, dockerfile: string, checksOn = true): HostAccessReport {
    const input: ComposeAccessInput = {
      model: model(build),
      devService: 'app',
      project: PROJECT,
      repositoryFolder: REPO,
      ownVolume: OWN,
      engineApiVersion: '1.47',
      dockerfiles: { app: dockerfile },
    };
    return composeAccessReport(input, checksOn);
  }

  it('P17-2: a multi-line build argument is allowed, also when USER uses a variable', () => {
    expect(reportWith({ args: { USERNAME: 'vscode', EXTRA_CA_CERT: CA_CERT } }, USER_DOCKERFILE)).toEqual(NONE);
    expect(reportWith({ args: { USERNAME: INJECTION } }, USER_DOCKERFILE)).toEqual(NONE);
  });

  it('P17-2: the stage name and U+0085 stay refused', () => {
    expect(reportWith({ target: TARGET_VECTOR }, DOCKERFILE).unsupported).toContain(
      `service app: build target ${JSON.stringify(TARGET_VECTOR)} (the Dev Container CLI writes it into its compose file for the build as it is: only a plain stage name is supported)`,
    );
    expect(reportWith({}, 'FROM alpine AS a\u0085      ssh:\nRUN true\n').unsupported.length).toBe(2);
  });

});
