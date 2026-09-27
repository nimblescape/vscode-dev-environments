// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 11: the one entry point of the container policy (checkContainer). Each stage gives the report of the checks that
// it stands for (the checks themselves are tested in their own files), with the per-repository switch applied.
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from '../helper/compose';
import { runAnalysisJob } from '../helper/configurationAnalysis';
import { COMPOSE_CLEARED_LABELS } from '../names';
import {
  checkContainer,
  composeAccessReport,
  composeConfigurationReport,
  hostAccessReport,
  type CheckStage,
  type ComposeAccessInput,
  type HostAccessInput,
} from '.';

const OWN = 'devenv-acme-api-3f2a9c1e';
const PROJECT = 'devenv-3f2a9c1e';

/** A configuration with an item of each class: `computer` (privileged mode), `protected`, and `unsupported`. */
const CONFIG: HostAccessInput = {
  ownVolume: OWN,
  config: { privileged: true, initializeCommand: 'echo', runArgs: ['--frobnicate'] },
};

function composeInput(): ComposeAccessInput {
  const model: ComposeModel = {
    name: PROJECT,
    services: {
      app: { image: 'alpine', privileged: true },
      db: { image: 'postgres:16', models: ['x'] },
    },
  };
  return { model, devService: 'app', project: PROJECT, repositoryFolder: '/workspaces/api', ownVolume: OWN };
}

describe('checkContainer (unit 11: one entry point of the container policy)', () => {
  it.each(['configuration', 'imageMetadata'] as const)(
    'gives the report of the single-container checks at the stage %s, with the switch of the repository',
    (stage) => {
      expect(checkContainer(stage, { ...CONFIG, checks: 'on' })).toEqual(hostAccessReport(CONFIG, true));
      expect(checkContainer(stage, { ...CONFIG, checks: 'off' })).toEqual(hostAccessReport(CONFIG, false));
      expect(checkContainer(stage, { ...CONFIG, checks: 'on' })).toEqual({
        hostAccess: ['privileged mode', 'initializeCommand'],
        unsupported: ['--frobnicate'],
      });
      // With the checks off, only the class `computer` is lifted.
      expect(checkContainer(stage, { ...CONFIG, checks: 'off' })).toEqual({ hostAccess: ['initializeCommand'], unsupported: ['--frobnicate'] });
    },
  );

  it('checks the image metadata as the CLI applies it at the stage imageMetadata', () => {
    const metadata: HostAccessInput = { ownVolume: OWN, metadata: [{ capAdd: ['SYS_ADMIN'] }, { mounts: ['type=bind,source=/,target=/host'] }] };
    expect(checkContainer('imageMetadata', { ...metadata, checks: 'on' })).toEqual({ hostAccess: ['capability SYS_ADMIN', 'bind mount /'], unsupported: [] });
    expect(checkContainer('imageMetadata', { ...metadata, checks: 'off' })).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('allows the labels that the override configuration adds only at the stage finalRunArgs', () => {
    const runArgs: HostAccessInput = { ownVolume: OWN, config: { runArgs: COMPOSE_CLEARED_LABELS.flatMap((label) => ['--label', label]) } };
    expect(checkContainer('finalRunArgs', { ...runArgs, checks: 'on' })).toEqual({ hostAccess: [], unsupported: [] });
    expect(checkContainer('finalRunArgs', { ...runArgs, checks: 'on' })).toEqual(hostAccessReport({ ...runArgs, overrideConfiguration: true }));
    // The repository configuration may not carry them.
    expect(checkContainer('configuration', { ...runArgs, checks: 'on' }).unsupported).toEqual(['label com.docker.compose.project', 'label com.docker.compose.service']);
  });

  it('checks a Docker Compose model with the settings of devcontainer.json that Compose does not support first', () => {
    const input = composeInput();
    const features = { './local-feature': {}, 'ghcr.io/devcontainers/features/node:1': {} };
    const model = composeAccessReport(input);
    const configuration = composeConfigurationReport({ features });
    expect(model).toEqual({ hostAccess: ['service app: privileged mode'], unsupported: ['service db: models'] });
    expect(checkContainer('composeModel', { ...input, features, checks: 'on' })).toEqual({
      hostAccess: ['service app: privileged mode'],
      unsupported: [...configuration.unsupported, 'service db: models'],
    });
    expect(configuration.unsupported).toEqual(['local Feature ./local-feature in a Docker Compose configuration']);
    // With the checks off, only the class `computer` is lifted.
    expect(checkContainer('composeModel', { ...input, checks: 'off' })).toEqual({ hostAccess: [], unsupported: ['service db: models'] });
  });

  it('is what the analysis worker runs for each job (runAnalysisJob)', () => {
    expect(runAnalysisJob({ kind: 'hostAccess', input: CONFIG, checksOn: false }).report).toEqual(checkContainer('configuration', { ...CONFIG, checks: 'off' }));
    const runArgs: HostAccessInput = { ownVolume: OWN, config: { runArgs: ['--label', COMPOSE_CLEARED_LABELS[0]] } };
    expect(runAnalysisJob({ kind: 'hostAccess', stage: 'finalRunArgs', input: runArgs, checksOn: true }).report).toEqual({ hostAccess: [], unsupported: [] });
    expect(runAnalysisJob({ kind: 'single', input: CONFIG, checksOn: true, config: {} }).report).toEqual(checkContainer('configuration', { ...CONFIG, checks: 'on' }));
    const features = { '../other': {} };
    expect(runAnalysisJob({ kind: 'compose', input: composeInput(), checksOn: true, features }).report).toEqual(
      checkContainer('composeModel', { ...composeInput(), features, checks: 'on' }),
    );
  });

  it('refuses a stage that it does not know', () => {
    expect(() => checkContainer('other' as CheckStage, { ...CONFIG, checks: 'on' } as never)).toThrow('Unknown stage of the container policy other.');
  });
});
