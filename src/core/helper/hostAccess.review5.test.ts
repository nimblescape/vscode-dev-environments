// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Hotfix review 5, A5-1: `devcontainer up` uses the repository folder for ${localWorkspaceFolder} also for a repository
// named *.code-workspace (only read-configuration and build use /workspaces), so the checks must too: otherwise a
// label mount `${localWorkspaceFolderBasename}-node_modules` is checked as workspaces-node_modules while Docker mounts
// the volume x.code-workspace-node_modules of another account's environment of a repository with the same name.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { helperCliVariables, resolveCliVariables } from './cliVariables';
import { hostAccessReport, mountedVolumeNames } from './hostAccess';

const bundle = fs.readFileSync(path.resolve(__dirname, '../../../node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js'), 'utf8');

/** Fo (the first pass of the CLI), Ri and Rp, and the workspace expression of kW, sliced from the bundle. */
function loadCli() {
  class KA extends Error {
    constructor(options: { description: string }) {
      super(options.description);
    }
  }
  const foStart = bundle.indexOf('function Fo(e,A)');
  const foSource = bundle.slice(foStart, bundle.indexOf('async function fN(', foStart));
  const { Fo } = new Function('eg', 'uN', 'Fe', 'kA', `${foSource}\nreturn { Fo };`)(path, crypto, { isUri: () => false }, KA) as {
    Fo: (context: Record<string, unknown>, value: unknown) => unknown;
  };
  const riStart = bundle.indexOf('function Ri(e,A)');
  const riSource = bundle.slice(riStart, bundle.indexOf('}', bundle.indexOf('function Rp(e)', riStart)) + 1);
  const { Ri, Rp } = new Function('TG', `${riSource}\nreturn { Ri, Rp };`)(path.posix);
  const kwStart = bundle.indexOf('E=A&&Ri(g.path,');
  const kwSource = bundle.slice(kwStart, bundle.indexOf(':a)', kwStart) + 3);
  const upWorkspace = (folder: string): { rootFolderPath: string } =>
    new Function('Ri', 'Rp', 'OG', 'g', 'a', 'A', `let ${kwSource}; return E;`)(Ri, Rp, path.posix, { path: path.posix }, folder, { hostPath: folder });
  return { Fo, upWorkspace };
}

describe('hotfix review 5, A5-1: a repository named *.code-workspace at `up`', () => {
  const cli = loadCli();
  const repository = 'mallory/x.code-workspace';
  const folder = '/workspaces/x.code-workspace';
  const mount = 'type=volume,source=${localWorkspaceFolderBasename}-node_modules,target=/steal';
  const victim = { 'devenv.environment-id': 'victimenv', 'devenv.owner-id': '2', 'devenv.volume': 'additional' };
  const input = {
    ownVolume: 'devenv-x.code-workspace-11111111',
    environment: { id: 'attackerenv', ownerId: '1' },
    variables: helperCliVariables(repository),
    metadata: [{ mounts: [mount] }],
  };

  it('the checks see the mount that Docker gets', () => {
    const docker = cli.Fo(
      { platform: 'linux', env: { HOME: '/root' }, localWorkspaceFolder: cli.upWorkspace(folder).rootFolderPath, containerWorkspaceFolder: folder },
      mount,
    );
    expect(docker).toBe('type=volume,source=x.code-workspace-node_modules,target=/steal');
    expect(resolveCliVariables(mount, helperCliVariables(repository)).value).toBe(docker);
    expect(mountedVolumeNames(input)).toEqual(['x.code-workspace-node_modules']);
  });

  it.each([true, false])('refuses the volume of another account (checks %s)', (checks) => {
    const report = hostAccessReport(
      { ...input, foreignVolumes: ['x.code-workspace-node_modules'], volumeLabels: { 'x.code-workspace-node_modules': victim } },
      checks,
    );
    expect(report.hostAccess).toHaveLength(1);
    expect(report.hostAccess[0]).toContain('x.code-workspace-node_modules');
  });
});
