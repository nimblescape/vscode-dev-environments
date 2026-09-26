// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { containerHostname } from '../names';
import { buildOverrideConfig } from './devcontainerCli';
import { runArgsDecideHostname } from './hostAccess';

const base = { environmentImage: 'i:1', volumeName: 'devenv-acme-api-3f2a9c1e', repositoryName: 'module-oop', containerName: 'devenv-acme-api-3f2a9c1e' };

function hostnameOf(runArgs: string[]): string | undefined {
  const args = buildOverrideConfig({ ...base, runArgs }).runArgs as string[];
  const index = args.lastIndexOf('--hostname');
  return index >= 0 ? args[index + 1] : undefined;
}

describe('containerHostname', () => {
  it.each([
    ['module-oop', 'module-oop'],
    ['Module-OOP', 'module-oop'],
    ['my_repo.js', 'my-repo-js'],
    ['--a..b__', 'a-b'],
    ['___', 'devenv'],
    ['', 'devenv'],
    ['a'.repeat(70), 'a'.repeat(63)],
    [`${'a'.repeat(62)}-b`, 'a'.repeat(62)],
  ])('%s gives %s', (name, hostname) => {
    const result = containerHostname(name);
    expect(result).toBe(hostname);
    expect(result).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
  });
});

describe('the host name of the container in the override configuration', () => {
  it('names the host after the repository instead of the container ID', () => {
    expect(hostnameOf([])).toBe('module-oop');
    expect(hostnameOf(['--init', '-p', '3000'])).toBe('module-oop');
    // With the host access checks off too.
    const off = buildOverrideConfig({ ...base, hostAccessChecks: 'off' }).runArgs as string[];
    expect(off.slice(-2)).toEqual(['--hostname', 'module-oop']);
  });

  it.each([
    ['--hostname of the repository', ['--hostname', 'mine']],
    ['--hostname=', ['--hostname=mine']],
    ['-h', ['-h', 'mine']],
    ['--network host', ['--network', 'host']],
    ['--net=host', ['--net=host']],
    ['--network container:', ['--network', 'container:db']],
    ['--uts host', ['--uts', 'host']],
  ])('adds none where the repository decides it: %s', (_label, runArgs) => {
    expect(runArgsDecideHostname(runArgs)).toBe(true);
    const args = buildOverrideConfig({ ...base, runArgs, hostAccessChecks: 'off' }).runArgs as string[];
    expect(args.filter((arg) => arg === '--hostname')).toHaveLength(runArgs[0] === '--hostname' ? 1 : 0);
  });

  it.each([
    ['a --hostname that is the value of another flag', ['--label', '--hostname']],
    ['-e HOSTNAME', ['-e', 'HOSTNAME=x']],
    ['--network bridge', ['--network', 'bridge']],
    ['--network none', ['--network', 'none']],
  ])('adds it where the repository does not decide it: %s', (_label, runArgs) => {
    expect(runArgsDecideHostname(runArgs)).toBe(false);
    expect(hostnameOf(runArgs)).toBe('module-oop');
  });
});
