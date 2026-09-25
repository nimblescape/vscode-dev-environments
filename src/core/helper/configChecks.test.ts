// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { additionalNamedVolumes, checkConfiguration } from './configChecks';

describe('checkConfiguration', () => {
  it('finds nothing in a plain image configuration', () => {
    expect(checkConfiguration('{ "image": "mcr.microsoft.com/devcontainers/python:3.12" }')).toEqual({
      compose: false,
      computerDependent: [],
    });
  });

  it('detects Docker Compose', () => {
    expect(checkConfiguration('{ "dockerComposeFile": "docker-compose.yml", "service": "app" }').compose).toBe(true);
    expect(checkConfiguration('{ "dockerComposeFile": ["a.yml", "b.yml"], "service": "app" }').compose).toBe(true);
    expect(checkConfiguration('{ // "dockerComposeFile": "x.yml"\n "image": "x" }').compose).toBe(false);
  });

  it('reports ${localWorkspaceFolder} only where it matters', () => {
    const harmless = `{
      "name": "\${localWorkspaceFolder}",
      "workspaceFolder": "\${localWorkspaceFolder}",
      "workspaceMount": "source=\${localWorkspaceFolder},target=/src,type=bind",
      "initializeCommand": "cd \${localWorkspaceFolder} && ./prepare.sh",
      // "containerEnv": { "X": "\${localWorkspaceFolder}" }
      "image": "x"
    }`;
    expect(checkConfiguration(harmless).computerDependent).toEqual([]);
    const harmful = '{ "image": "x", "containerEnv": { "HOST_PATH": "${localWorkspaceFolder}" } }';
    expect(checkConfiguration(harmful).computerDependent).toEqual(['${localWorkspaceFolder}']);
  });

  it('does not report ${localWorkspaceFolderBasename}: the helper resolves it to the repository name', () => {
    const text = `{
      "image": "x",
      "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
      "mounts": ["source=\${localWorkspaceFolderBasename}-node_modules,target=/workspaces/x/node_modules,type=volume"]
    }`;
    expect(checkConfiguration(text).computerDependent).toEqual([]);
  });

  it('leaves mounts to the host access policy, which refuses bind mounts (concept section 9)', () => {
    const text = `{
      "image": "x",
      "mounts": [
        "source=\${localEnv:HOME}/.ssh,target=/home/vscode/.ssh,type=bind,consistency=cached",
        { "source": "/Users/x/data", "target": "/data", "type": "bind" },
        "source=\${localWorkspaceFolder}/.cache,target=/cache2,type=bind"
      ],
      "runArgs": ["-v", "/Users/x/src:/src", "--env-file", "\${localWorkspaceFolder}/.env"]
    }`;
    expect(checkConfiguration(text).computerDependent).toEqual([]);
  });

  it('checks the text as well as possible when the JSON is invalid', () => {
    expect(checkConfiguration('{ "dockerComposeFile": "a.yml", ')).toEqual({ compose: true, computerDependent: [] });
    expect(checkConfiguration('{ "x": "${localWorkspaceFolder}" ').computerDependent).toEqual(['${localWorkspaceFolder}']);
    expect(checkConfiguration('not json at all')).toEqual({ compose: false, computerDependent: [] });
  });
});

describe('additionalNamedVolumes', () => {
  it('finds named volumes of mounts and runArgs, without duplicates and without binds', () => {
    expect(
      additionalNamedVolumes({
        mounts: [
          'source=api-node_modules,target=/workspaces/api/node_modules,type=volume',
          'src=pgdata,dst=/var/lib/postgresql/data',
          { source: 'cache', target: '/cache', type: 'volume' },
          { source: '/Users/x', target: '/x', type: 'bind' },
          'source=/tmp,target=/tmp,type=bind',
          'type=volume,target=/anonymous',
          { source: 'cache', target: '/cache2', type: 'volume' },
        ],
        runArgs: ['-v', 'history:/commandhistory', '--mount', 'type=volume,source=db,target=/db', '-v', './x:/x'],
      }),
    ).toEqual(['api-node_modules', 'pgdata', 'cache', 'history', 'db']);
  });

  it('skips sources with an unresolved variable (read-configuration before the container exists)', () => {
    expect(
      additionalNamedVolumes({
        mounts: [
          'source=${devcontainerId}-history,target=/commandhistory,type=volume',
          { source: '${localEnv:VOLUME}', target: '/v', type: 'volume' },
          'source=1r60kajr11nn-history,target=/commandhistory,type=volume',
        ],
        runArgs: ['-v', '${devcontainerId}-cache:/cache'],
      }),
    ).toEqual(['1r60kajr11nn-history']);
  });

  it('returns an empty list without mounts', () => {
    expect(additionalNamedVolumes({ image: 'x' })).toEqual([]);
  });
});
