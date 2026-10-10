// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review of unit 15 (T2 and the mount propagation): the configuration checks of mounts that would reach the tmpfs of the
// token (/run/devenv) by its other name /var/run/devenv, or bring it to the computer with a shared mount propagation.
// The real protection is the check of the write in the container (containerToken.test.ts); these give a clear message.
import { describe, expect, it } from 'vitest';
import { composeProjectName, resourceName } from '../names';
import type { ComposeModel } from './composeModel';
import {
  decideServiceMount,
  composeAccessClassification,
  configFolderTarget,
  hostAccessClassification,
  hostAccessReport,
  isSharedPropagation,
  sharedPropagationItem,
  tokenPropagationTarget,
  volumeFlagOptions,
  type ComposeMountContext,
  type ComposeAccessInput,
  type HostAccessInput,
} from '../policy';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
// User decisions 2026-10-03: one name per environment (resourceName); the project, the volume, and the container share it.
const OWN = resourceName('acme/api', ID);
const PROJECT = composeProjectName('acme/api', ID);
const REPO = '/workspaces/api';
const INTERNAL = "mounts into the extension's internal folder are not supported";

const single = (config: Record<string, unknown>): HostAccessInput => ({ config, ownVolume: OWN });
const classes = (config: Record<string, unknown>) => hostAccessClassification(single(config)).map((finding) => `${finding.class}: ${finding.item}`);

describe('configFolderTarget: /var/run/devenv is the folder of the token too (T2)', () => {
  it.each([
    ['/var/run/devenv', '/var/run/devenv'],
    ['/var/run/devenv/github-token', '/var/run/devenv/github-token'],
    ['/var//run/./devenv/', '/var/run/devenv'],
  ])('%s', (target, normal) => {
    expect(configFolderTarget(target)).toBe(normal);
  });

  it.each(['/var/run', '/var/run/devenvx', '/var', '/srv/var/run/devenv'])('not %s', (target) => {
    expect(configFolderTarget(target)).toBeUndefined();
  });

  it('refuses a mount there as not supported, whatever the switch says', () => {
    expect(classes({ runArgs: ['--mount', 'type=tmpfs,dst=/var/run/devenv'] })).toEqual([`unsupported: mount at /var/run/devenv (${INTERNAL})`]);
    expect(classes({ runArgs: ['-v', 'pgdata:/var/run/devenv'] })).toContain(`unsupported: mount at /var/run/devenv (${INTERNAL})`);
    const bind = single({ runArgs: ['-v', '/srv/file:/var/run/devenv/github-token'] });
    expect(hostAccessReport(bind, false).unsupported).toEqual([`mount at /var/run/devenv/github-token (${INTERNAL})`]);
  });
});

describe('a shared mount propagation where the tmpfs of the token would reach the computer', () => {
  it('knows the shared propagations', () => {
    for (const value of ['shared', 'rshared', 'RShared', ' rshared ']) expect(isSharedPropagation(value)).toBe(true);
    for (const value of ['slave', 'rslave', 'private', 'rprivate', '']) expect(isSharedPropagation(value)).toBe(false);
  });

  it('the targets: the root and the parents of /run/devenv and /var/run/devenv', () => {
    for (const target of ['/', '/run', '/run/', '/var', '/var/run', '//var/./run']) expect(tokenPropagationTarget(target)).toBeDefined();
    expect(tokenPropagationTarget('/var/./run')).toBe('/var/run');
    for (const target of ['/srv', '/run/devenvx', '/run/user', '/var/lib', 'run']) expect(tokenPropagationTarget(target)).toBeUndefined();
  });

  it('reads the options of -v', () => {
    expect(volumeFlagOptions('/srv:/run:rshared')).toEqual(['rshared']);
    expect(volumeFlagOptions('/srv:/run:ro,rshared')).toEqual(['ro', 'rshared']);
    expect(volumeFlagOptions('C:\\x:/run:rshared')).toEqual(['rshared']);
    expect(volumeFlagOptions('/run:rshared')).toEqual(['rshared']);
    expect(volumeFlagOptions('/srv:/run')).toEqual([]);
    expect(volumeFlagOptions('/run')).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['-v … :rshared at /run', { runArgs: ['-v', '/srv/run:/run:rshared'] }, '/run'],
    ['--volume … :ro,shared at /var/run', { runArgs: ['--volume=/srv/run:/var/run:ro,shared'] }, '/var/run'],
    ['--mount bind-propagation=rshared at /', { runArgs: ['--mount', 'type=bind,src=/srv,dst=/,bind-propagation=rshared'] }, '/'],
    ['mounts with bind-propagation=shared at /var', { mounts: ['type=bind,source=/srv/var,target=/var,bind-propagation=shared'] }, '/var'],
  ])('refuses %s whatever the switch says (protected)', (_name, config, target) => {
    expect(classes(config)).toContain(`protected: ${sharedPropagationItem(target)}`);
    expect(hostAccessReport(single(config), false).hostAccess).toContain(sharedPropagationItem(target));
  });

  it.each<[string, Record<string, unknown>]>([
    ['rslave at /run', { runArgs: ['-v', '/srv/run:/run:rslave'] }],
    ['rshared at another folder', { runArgs: ['-v', '/srv/data:/data:rshared'] }],
    ['rshared below /run', { runArgs: ['--mount', 'type=bind,src=/srv,dst=/run/user,bind-propagation=rshared'] }],
  ])('leaves %s to the switch', (_name, config) => {
    expect(classes(config).filter((line) => line.includes('propagation'))).toEqual([]);
  });
});

describe('a shared mount propagation in the dev service of a Docker Compose configuration', () => {
  const context = (isDev: boolean): ComposeMountContext => ({
    isDev,
    repositoryFolder: REPO,
    volumeNames: new Map([['pgdata', `${PROJECT}_pgdata`]]),
    ownVolume: OWN,
    engineApiVersion: '1.47',
  });

  it.each(['/run', '/var/run', '/'])('decideServiceMount refuses bind.propagation rshared at %s (protected)', (target) => {
    const entry = { type: 'bind', source: '/srv/x', target, bind: { propagation: 'rshared' } };
    expect(decideServiceMount(entry, context(true))).toEqual({ action: 'refuse', kind: 'hostAccess', item: sharedPropagationItem(target), guarded: true });
  });

  it('decideServiceMount leaves other propagations, other targets, and other services to the other rules', () => {
    const refused = (entry: Record<string, unknown>, isDev = true) => {
      const decision = decideServiceMount(entry, context(isDev));
      return decision.action === 'refuse' && decision.item.includes('propagation');
    };
    expect(refused({ type: 'bind', source: '/srv/x', target: '/run', bind: { propagation: 'rslave' } })).toBe(false);
    expect(refused({ type: 'bind', source: '/srv/x', target: '/data', bind: { propagation: 'rshared' } })).toBe(false);
    expect(refused({ type: 'bind', source: '/srv/x', target: '/run', bind: { propagation: 'rshared' } }, false)).toBe(false);
  });

  it('composeAccessClassification: protected in the dev service', () => {
    const model: ComposeModel = {
      name: PROJECT,
      services: {
        app: {
          image: 'alpine:3.22',
          volumes: [
            { type: 'bind', source: '/workspaces', target: '/workspaces' },
            { type: 'bind', source: '/srv/run', target: '/run', bind: { propagation: 'rshared' } },
          ],
        },
      },
    };
    const input: ComposeAccessInput = {
      model,
      devService: 'app',
      project: PROJECT,
      repositoryFolder: REPO,
      ownVolume: OWN,
      engineApiVersion: '1.47',
      environment: { id: '3f2a9c1e-0000-4000-8000-000000000000', ownerId: '42' },
    };
    expect(composeAccessClassification(input)).toContainEqual({ item: `service app: ${sharedPropagationItem('/run')}`, class: 'protected' });
  });
});
