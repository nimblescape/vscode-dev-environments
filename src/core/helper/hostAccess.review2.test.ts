// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Hotfix review 2: the findings P1 to P6 of the review of the hotfix fix/metadata-variables, with the vectors of the
// reviewers and verifiers.
import { describe, expect, it } from 'vitest';
import { HELPER_CACHE_VOLUME } from '../names';
import { DEVCONTAINER_ID_PLACEHOLDER, helperCliVariables, substituteCliVariables } from './cliVariables';
import { hostAccessClassification, hostAccessProblems, hostAccessReport, mountedVolumeNames, type HostAccessInput } from './hostAccess';

const OWN = 'devenv-acme-api-3f2a9c1e';
const FOREIGN_NAME = 'devenv-other-abcdef12';
const FOREIGN = `volume ${FOREIGN_NAME} of another environment`;
const variables = helperCliVariables('acme/api');
const leftover = (kind: string, text: string, left: string): string => `${kind} ${JSON.stringify(text)} uses ${left}, which cannot be checked`;
const both = (check: (checksOn: boolean) => void): void => {
  for (const checksOn of [true, false]) check(checksOn);
};
/** What read-configuration returns: the configuration substituted once by the CLI in the helper (no TERM, no OLDPWD). */
const readConfiguration = <T>(raw: T): T =>
  substituteCliVariables(raw, { localWorkspaceFolder: '/workspaces/api', containerWorkspaceFolder: '/workspaces/api', env: { HOME: '/root' } });

describe('hotfix review 2, P1: leftover variables are decided on the raw strings of the label', () => {
  it('refuses a string mount whose substitution output hides a leftover, with the checks on and off', () => {
    // After the substitution, the text is `…dst=/y${,src=${localEnv:TERM:…}`: a scan of that text sees only `${,src=${localEnv:TERM:…}`,
    // whose name is no variable of the CLI. The CLI resolves ${localEnv:TERM:…} at `up`, to the volume of another
    // environment when TERM is not set.
    const mount = `type=volume,dst=/y\${localEnv:NOPE:$}{,src=\${localEnv:TERM:${FOREIGN_NAME}}`;
    both((checksOn) => {
      expect(hostAccessReport({ ownVolume: OWN, variables, metadata: [{ mounts: [mount] }] }, checksOn)).toEqual({
        hostAccess: [],
        unsupported: [leftover('mount', `type=volume,dst=/y\${,src=\${localEnv:TERM:${FOREIGN_NAME}}`, `\${localEnv:TERM:${FOREIGN_NAME}}`)],
      });
    });
    const cache = `type=volume,dst=/y\${localEnv:NOPE:$}{,src=\${env:PWD:${HELPER_CACHE_VOLUME}}`;
    both((checksOn) => expect(hostAccessReport({ ownVolume: OWN, variables, metadata: [{ mounts: [cache] }] }, checksOn).unsupported).toHaveLength(1));
  });

  it('refuses an object mount where an earlier field hides a leftover of a later field, with the checks on and off', () => {
    const mount = { type: 'volume,dst=/z${a', source: `\${localEnv:TERM:${FOREIGN_NAME}}`, target: '/y' };
    both((checksOn) => {
      expect(hostAccessReport({ ownVolume: OWN, variables, metadata: [{ mounts: [mount] }] }, checksOn)).toEqual({
        hostAccess: [],
        unsupported: [leftover('mount', `type=volume,dst=/z\${a,src=\${localEnv:TERM:${FOREIGN_NAME}},dst=/y`, `\${localEnv:TERM:${FOREIGN_NAME}}`)],
      });
    });
  });

  it('refuses a single mount (no list) with a hidden leftover', () => {
    const mount = `type=volume,dst=/y\${localEnv:NOPE:$}{,src=\${localEnv:TERM:${FOREIGN_NAME}}`;
    both((checksOn) => expect(hostAccessReport({ ownVolume: OWN, variables, metadata: [{ mounts: mount }] }, checksOn).unsupported).toHaveLength(1));
  });

  it('checks a text that only looks like a variable after the substitution as Docker gets it (the CLI does not substitute it again)', () => {
    // The CLI passes `source=${localEnv:TERM}` to Docker as it is: no volume of another environment, and Docker refuses
    // the `$` in the name of a volume.
    const mount = 'source=${localEnv:NOPE:$}{localEnv:TERM},target=/x,type=volume';
    both((checksOn) => expect(hostAccessProblems({ ownVolume: OWN, variables, metadata: [{ mounts: [mount] }] }, checksOn)).toEqual([]));
  });
});

describe('hotfix review 2, P2: long and many texts', () => {
  it('refuses 40,000 runArgs entries with a leftover in less than a second, and lists at most 20 of them', () => {
    const runArgs: string[] = [];
    for (let i = 0; i < 40_000; i++) runArgs.push(`\${localEnv:TERM:A${i}}`);
    const start = Date.now();
    const report = hostAccessReport({ ownVolume: OWN, variables, config: { runArgs } });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(report.hostAccess).toEqual([]);
    expect(report.unsupported).toHaveLength(21);
    expect(report.unsupported[0]).toBe(leftover('runArgs', '${localEnv:TERM:A0}', '${localEnv:TERM:A0}'));
    expect(report.unsupported[20]).toBe('and 39980 more');
    expect(hostAccessProblems({ ownVolume: OWN, variables, config: { runArgs } })).toHaveLength(21);
  });

  it('refuses 40,000 label mounts with a leftover in less than a second', () => {
    const mounts: string[] = [];
    // Short texts: 40,000 mounts stay below MAX_CLI_SOURCE_LENGTH.
    for (let i = 0; i < 40_000; i++) mounts.push(`\${env:PWD:${i}}`);
    const start = Date.now();
    const report = hostAccessReport({ ownVolume: OWN, variables, metadata: [{ mounts }] });
    mountedVolumeNames({ ownVolume: OWN, variables, metadata: [{ mounts }] });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(report.unsupported).toHaveLength(21);
  });

  it('names at most 20 variables of one entry', () => {
    let entry = '';
    for (let i = 0; i < 1000; i++) entry += `\${localEnv:TERM:A${i}}`;
    const [item] = hostAccessReport({ ownVolume: OWN, variables, config: { runArgs: [entry] } }).unsupported;
    expect(item).toContain('${localEnv:TERM:A19}, and 980 more, which cannot be checked');
    expect(item.slice(item.indexOf('" uses '))).not.toContain('${localEnv:TERM:A20}');
  });

  it('checks the size first: a text that is too long is refused alone and quickly, and no volume is named', () => {
    let text = '';
    for (let i = 0; i < 40_000; i++) text += `\${containerEnv:A${i}}`;
    for (const input of [
      { ownVolume: OWN, variables, config: { runArgs: [text] } },
      { ownVolume: OWN, variables, metadata: [{ mounts: [text, 'source=cache,target=/c'] }] },
    ] as HostAccessInput[]) {
      const start = Date.now();
      const report = hostAccessReport(input);
      const names = mountedVolumeNames(input);
      expect(Date.now() - start).toBeLessThan(1000);
      expect([...report.hostAccess, ...report.unsupported]).toHaveLength(1);
      expect(report.unsupported[0]).toMatch(/^a text longer than 256 KB in /);
      expect(names).toEqual([]);
    }
  });
});

describe('hotfix review 2, P4: ${containerEnv:…} in runArgs, which the CLI does not resolve for docker run', () => {
  it('allows runArgs ["--env", "ORIG_PATH=${containerEnv:PATH}"], with the checks on and off', () => {
    const runArgs = ['--env', 'ORIG_PATH=${containerEnv:PATH}', '-e', 'X=${containerEnv:HOME}'];
    both((checksOn) => {
      expect(hostAccessProblems({ ownVolume: OWN, variables, config: { runArgs } }, checksOn)).toEqual([]);
      expect(hostAccessProblems({ ownVolume: OWN, variables, merged: { runArgs } }, checksOn)).toEqual([]);
    });
  });

  it('still refuses a volume or a mount of runArgs whose name or target holds ${containerEnv:…}', () => {
    const runArgs = ['-v', '${containerEnv:V}:/c', '--mount', 'type=volume,src=${containerEnv:V},dst=/m'];
    both((checksOn) => {
      expect(hostAccessReport({ ownVolume: OWN, variables, config: { runArgs } }, checksOn)).toEqual({
        hostAccess: [],
        unsupported: [
          leftover('volume', '${containerEnv:V}:/c', '${containerEnv:V}'),
          leftover('mount', 'type=volume,src=${containerEnv:V},dst=/m', '${containerEnv:V}'),
        ],
      });
    });
  });
});

describe('hotfix review 2, P6: ${devcontainerId} with arguments, which the CLI replaces whole', () => {
  // The CLI replaces `${devcontainerId:,type=bind}` (any expression named devcontainerId) by the ID, so the field
  // `type=bind` that the checks would read is not there: Docker gets a volume of another environment.
  const hidden = `type=volume,src=${FOREIGN_NAME},dst=/y\${devcontainerId:,type=bind}`;

  it('refuses the volume of another environment in the label, the configuration, and the merged configuration, with the checks on and off', () => {
    both((checksOn) => {
      expect(hostAccessProblems({ ownVolume: OWN, variables, metadata: [{ mounts: [hidden] }] }, checksOn)).toEqual([FOREIGN]);
      expect(hostAccessProblems({ ownVolume: OWN, variables, metadata: [{ mounts: [{ type: 'volume', source: FOREIGN_NAME, target: '/y${devcontainerId:,type=bind}' }] }] }, checksOn)).toEqual([FOREIGN]);
      for (const where of ['config', 'merged'] as const) {
        expect(hostAccessProblems({ ownVolume: OWN, variables, [where]: readConfiguration({ mounts: [hidden] }) }, checksOn)).toEqual([FOREIGN]);
      }
    });
  });

  it('refuses it in a --mount of runArgs, with the checks on and off', () => {
    both((checksOn) => {
      for (const where of ['config', 'merged'] as const) {
        expect(hostAccessProblems({ ownVolume: OWN, variables, [where]: { runArgs: ['--mount', hidden] } }, checksOn)).toEqual([FOREIGN]);
      }
    });
  });

  it('reads a name that the ID replaces as the CLI makes it', () => {
    // `devenv-other-${devcontainerId:x}` is not named like a workspace volume after `up` either.
    const mounts = ['type=volume,src=dind-${devcontainerId:a,b},dst=/d', 'source=${devcontainerId}-history,target=/h,type=volume'];
    both((checksOn) => expect(hostAccessProblems({ ownVolume: OWN, variables, metadata: [{ mounts }] }, checksOn)).toEqual([]));
    // A name with the ID is never a volume whose labels are read or that is created before `up`.
    expect(mountedVolumeNames({ ownVolume: OWN, variables, metadata: [{ mounts }], config: { runArgs: ['-v', 'c-${devcontainerId:x}:/c'] } })).toEqual([]);
  });

  it('names ${devcontainerId} in the items, not the placeholder', () => {
    const mount = 'type=bind,src=/x/${devcontainerId:y},dst=/y';
    expect(hostAccessProblems({ ownVolume: OWN, variables, metadata: [{ mounts: [mount] }] })).toEqual(['bind mount /x/${devcontainerId}']);
  });

  it('does not support the text of the placeholder itself', () => {
    const mount = `source=x-${DEVCONTAINER_ID_PLACEHOLDER},target=/x,type=volume`;
    both((checksOn) => {
      for (const input of [
        { ownVolume: OWN, variables, metadata: [{ mounts: [mount] }] },
        { ownVolume: OWN, variables, config: { mounts: [mount] } },
        { ownVolume: OWN, variables, metadata: [{ mounts: [`source=x-\${localEnv:NOPE:${DEVCONTAINER_ID_PLACEHOLDER.slice(0, 10)}}${DEVCONTAINER_ID_PLACEHOLDER.slice(10)},target=/x`] }] },
      ]) {
        expect(hostAccessReport(input, checksOn).unsupported.length).toBeGreaterThan(0);
      }
    });
    expect(hostAccessClassification({ ownVolume: OWN, variables, config: { mounts: [mount] } }).map((finding) => finding.class)).toEqual(['unsupported']);
  });

  it('keeps the common patterns of Features working (docker-in-docker, shell history)', () => {
    const mounts = [
      { source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' },
      'source=${devcontainerId}-bashhistory,target=/commandhistory,type=volume',
    ];
    both((checksOn) => {
      expect(hostAccessProblems({ ownVolume: OWN, variables, metadata: [{ mounts }] }, checksOn)).toEqual([]);
      expect(hostAccessProblems({ ownVolume: OWN, variables, config: readConfiguration({ mounts, runArgs: ['--label', 'x=${devcontainerId}'] }) }, checksOn)).toEqual([]);
    });
  });
});
