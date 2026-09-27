// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The container policy (concept section 9 "Host access", container-restrictions.md): one entry point, checkContainer,
// for every check of the final configuration of a container, and the module's other functions for the pipeline (what
// the policy changes in the configuration, the volumes and networks that it needs to know). Under the adopted trust
// model the policy is a guard rail on the final configuration: a dev container may use the network, and nothing else
// of the computer. The files of the module:
// - ./rules.ts:            the rules table (classes, protected paths, capabilities, security options, labels, variables);
// - ./flags.ts:            the flags of `docker run` and `docker build`, flag by flag, with the checks of their values;
// - ./dockerFlags.ts:      how Docker and the Dev Container CLI read flags, CSV fields, mounts, networks, and ports;
// - ./single.ts:           the checks of a single container (configuration, merged configuration, image metadata);
// - ./compose.ts:          the checks of a Docker Compose model;
// - ./volumes.ts:          which volumes and networks belong to the environment, and which to others;
// - ./images.ts:           image references (other environments, image IDs, Docker's grammar) and image labels;
// - ./rewrites.ts:         what the policy changes instead of refusing (removed flags, 127.0.0.1, Compose mounts/ports);
// - ./report.ts:           the report, the classes of its items, and the limits of a listed item;
// - ./hostAccessChecks.ts: the per-repository switch (setting devEnvLauncher.hostAccessChecksOff).
// Pure functions, no I/O, no `vscode`: the pipeline runs checkContainer in the analysis worker
// (../helper/configurationAnalysis.ts), with limits of time and memory.
import { composeAccessReport, composeConfigurationReport, type ComposeAccessInput } from './compose';
import type { HostAccessChecks } from './hostAccessChecks';
import type { HostAccessReport } from './report';
import { hostAccessReport, type HostAccessInput } from './single';

export * from './compose';
export * from './dockerFlags';
export * from './flags';
export * from './hostAccessChecks';
export * from './images';
export * from './report';
export * from './rewrites';
export * from './rules';
export * from './single';
export * from './volumes';

/**
 * The stages at which the pipeline checks a container, each with what it checks:
 * - `configuration`: devcontainer.json as read-configuration resolved it, and its merged configuration (a single
 *   container; for a Docker Compose configuration devcontainer.json without the properties that the CLI ignores,
 *   withoutComposeIgnored, and with `composeMounts`), before any build;
 * - `imageMetadata`: the label devcontainer.metadata of the environment image (base image, Features, configuration),
 *   before `up` creates a container;
 * - `finalRunArgs`: the runArgs and appPort of the override configuration, as Docker gets them (`config`), before `up`;
 * - `composeModel`: the merged model of a Docker Compose configuration (every service) and the settings of
 *   devcontainer.json that Compose does not support (its `features`), before any build and before `up` creates the
 *   containers.
 */
export type CheckStage = 'configuration' | 'imageMetadata' | 'finalRunArgs' | 'composeModel';

/** What each stage checks (CheckStage). */
export interface CheckInputs {
  configuration: HostAccessInput;
  imageMetadata: HostAccessInput;
  finalRunArgs: HostAccessInput;
  composeModel: ComposeAccessInput & { features?: unknown };
}

/** The input of a stage, with the switch of the repository (hostAccessChecks). */
export type CheckInput<S extends CheckStage> = CheckInputs[S] & { checks: HostAccessChecks };

/**
 * The container policy: the settings of `input` that need access to the computer, or that the policy does not know or
 * support, at `stage` (CheckStage). With `checks` `off` (the per-repository switch), the items of the class `computer`
 * are lifted, and published ports keep the address that the configuration gives them; the classes `protected` and
 * `unsupported` stay refused. Empty lists: the container may be used as configured.
 */
export function checkContainer<S extends CheckStage>(stage: S, input: CheckInput<S>): HostAccessReport {
  const checksOn = input.checks === 'on';
  switch (stage) {
    case 'configuration':
    case 'imageMetadata':
      return hostAccessReport(withoutChecks(input as CheckInput<'configuration'>), checksOn);
    case 'finalRunArgs':
      // The override configuration may carry the labels that it adds itself (HostAccessInput.overrideConfiguration).
      return hostAccessReport({ ...withoutChecks(input as CheckInput<'finalRunArgs'>), overrideConfiguration: true }, checksOn);
    case 'composeModel': {
      const { features, ...compose } = withoutChecks(input as CheckInput<'composeModel'>);
      // The settings of devcontainer.json first, then the model; each item once.
      const configuration = composeConfigurationReport({ features });
      const model = composeAccessReport(compose, checksOn);
      return {
        hostAccess: [...new Set([...configuration.hostAccess, ...model.hostAccess])],
        unsupported: [...new Set([...configuration.unsupported, ...model.unsupported])],
      };
    }
    default:
      throw new Error(`Unknown stage of the container policy ${String(stage)}.`);
  }
}

/** `input` without the switch (checkContainer passes it on as `checksOn`). */
function withoutChecks<T extends { checks: HostAccessChecks }>(input: T): Omit<T, 'checks'> {
  const { checks: _checks, ...rest } = input;
  return rest;
}
