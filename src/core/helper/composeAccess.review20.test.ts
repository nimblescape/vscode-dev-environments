// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 20 (S20-1): the Dev Container CLI 0.89.0 reads the dev service from the output of `docker compose config`
// of the model that we write; a Compose that escapes a literal `$` there (ComposeModelOutput.dollarEscaped) shows it the
// build arguments with `$$`, while Docker builds with the unescaped ones.
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from './compose';
import { cliPlatformVariables } from './cliDockerfile';
import {
  composeAccessReport,
  composeCliBaseImageCheck,
  composeDevBuildImages,
  composeImageReferences,
  type ComposeAccessInput,
} from './composeAccess';

const PROJECT = 'devenv-3f2a9c1e';
const REPO = '/workspaces/api';
const OTHER = 'devenv-0badc0de:3';
const BASE = 'FROM mcr.microsoft.com/devcontainers/base:bookworm AS x\n';
/** A FROM line that only the CLI reads (a heredoc of RUN for Docker), with an image when B is set. */
const HIDDEN = `ARG B\n${BASE}RUN <<EOF\nFROM \${B:+${OTHER}} AS y\nEOF\n`;
const ARGS = { B: '$X' };

function model(build: Record<string, unknown>): ComposeModel {
  return { name: PROJECT, services: { app: { build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile', ...build }, command: ['sleep', 'infinity'] } } };
}

function input(dollarEscaped: boolean | undefined, dockerfile = HIDDEN, args: Record<string, unknown> = ARGS, features = false): ComposeAccessInput {
  return {
    model: model({ args }),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: 'devenv-acme-api-3f2a9c1e',
    engineApiVersion: '1.47',
    dockerfiles: { app: dockerfile },
    features,
    ...(dollarEscaped !== undefined ? { dollarEscaped } : {}),
  };
}

const ITEM = `service app: base image of the Dev Container CLI ${OTHER} of another environment`;

describe('review round 20 (S20-1): the build arguments of the dev service as the Dev Container CLI reads them', () => {
  it('the configuration check refuses the image of another environment that the CLI reads from an escaped argument', () => {
    for (const features of [false, true]) {
      const report = composeAccessReport(input(true, HIDDEN, ARGS, features));
      expect(report.hostAccess, String(features)).toContain(ITEM);
      // Whatever the switch says.
      expect(composeAccessReport(input(true, HIDDEN, ARGS, features), false).hostAccess).toContain(ITEM);
    }
    // The image that the CLI reads is asked about (another image than one of another environment).
    const dockerfile = HIDDEN.replace(OTHER, 'cafe1234');
    expect(composeImageReferences(model({ args: ARGS }), { app: dockerfile }, 'app', true)).toContainEqual({ reference: 'cafe1234', what: 'service app: base image of the Dev Container CLI' });
    expect(composeImageReferences(model({ args: ARGS }), { app: dockerfile }, 'app', false).map((entry) => entry.reference)).not.toContain('cafe1234');
  });

  it('reads the arguments as they are when Compose does not escape them', () => {
    // `${B:+…}` of the unescaped argument `$X`: the CLI reads it as it is, and so do we (the result of round 19).
    const unescaped = composeCliBaseImageCheck(model({ args: ARGS }), { app: HIDDEN }, 'app', cliPlatformVariables('amd64'), undefined, false);
    const escaped = composeCliBaseImageCheck(model({ args: ARGS }), { app: HIDDEN }, 'app', cliPlatformVariables('amd64'), undefined, true);
    expect(escaped?.findings.map((finding) => finding.item)).toContain(ITEM);
    expect(unescaped?.findings.map((finding) => finding.item)).not.toContain(ITEM);
    expect(composeAccessReport(input(false)).hostAccess).not.toContain(ITEM);
    expect(composeAccessReport(input(undefined)).hostAccess).not.toContain(ITEM);
    // An argument that the CLI reads the same way either way is refused either way.
    for (const dollarEscaped of [true, false]) expect(composeAccessReport(input(dollarEscaped, HIDDEN, { B: 'x' })).hostAccess).toContain(ITEM);
  });

  it('the runtime check follows the escaped argument to the image that the CLI inspects', () => {
    const platform = cliPlatformVariables('amd64');
    const dockerfile = `ARG B\n${BASE}RUN <<EOF\nFROM \${B:+ghcr.io/acme/other:1} AS y\nEOF\n`;
    expect(composeDevBuildImages(model({ args: ARGS }), { app: dockerfile }, 'app', platform, true)).toEqual({ images: ['ghcr.io/acme/other:1'], unresolved: [] });
    expect(composeDevBuildImages(model({ args: ARGS }), { app: dockerfile }, 'app', platform, false).images).not.toContain('ghcr.io/acme/other:1');
  });

});
