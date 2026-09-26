// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Package C of unit 6: the model that `up` runs (compose.ts) with the switch of the host access checks of the
// repository (../hostAccessChecks.ts), and the host name of the dev container. With the checks off, the rewrite keeps
// what only the class `computer` refuses (published ports on other addresses, bind mounts of the computer) and labels
// every container devenv.host-access=unrestricted, as buildOverrideConfig does for a single container.
import { describe, expect, it } from 'vitest';
import { HOST_ACCESS_UNRESTRICTED, LABEL_HOST_ACCESS } from '../names';
import { composeBuildModel, composeUpModel, serviceDecidesHostname, type ComposeModel, type ComposeRewriteParams, type ComposeService } from './compose';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = 'devenv-3f2a9c1e';
const OWN = 'devenv-acme-api-3f2a9c1e';
const REPO = '/workspaces/api';

function model(app: ComposeService = {}, db: ComposeService = {}): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: { image: 'mcr.microsoft.com/devcontainers/base:ubuntu', command: ['sleep', 'infinity'], ...app },
      db: {
        image: 'postgres:16',
        ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }],
        volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }],
        ...db,
      },
    },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function params(overrides: Partial<ComposeRewriteParams> = {}): ComposeRewriteParams & { image: string } {
  return {
    project: PROJECT,
    devService: 'app',
    environmentId: ID,
    containerName: OWN,
    volumeName: OWN,
    repositoryFolder: REPO,
    dollarEscaped: true,
    engineApiVersion: '1.47',
    image: 'devenv-3f2a9c1e:7',
    ...overrides,
  };
}

describe('the host name of the dev container', () => {
  it('names the dev container after the repository, and leaves the other services alone', () => {
    const result = composeUpModel(model(), params()).model;
    expect(result.services.app.hostname).toBe('api');
    expect(result.services.db).not.toHaveProperty('hostname');
    // The build model does not start a container.
    expect(composeBuildModel(model(), params()).model.services.app).not.toHaveProperty('hostname');
  });

  it('uses the rules of containerHostname for the repository name', () => {
    expect(composeUpModel(model(), params({ repositoryFolder: '/workspaces/My_Repo.v2' })).model.services.app.hostname).toBe('my-repo-v2');
  });

  it.each<[string, ComposeService, boolean]>([
    ['nothing', {}, false],
    ['its own hostname', { hostname: 'mine' }, true],
    ['an empty hostname', { hostname: '' }, false],
    ['network_mode host', { network_mode: 'host' }, true],
    ['network_mode service:db', { network_mode: 'service:db' }, true],
    ['network_mode container:x', { network_mode: 'container:x' }, true],
    ['network_mode bridge', { network_mode: 'bridge' }, false],
    ['a network of the project', { network_mode: 'backend' }, false],
    ['uts host', { uts: 'host' }, true],
  ])('with %s the service decides the host name: %s', (_name, service, decides) => {
    expect(serviceDecidesHostname(service)).toBe(decides);
    const app = composeUpModel(model(service), params()).model.services.app;
    if (decides) expect(app.hostname).toBe(service.hostname);
    else expect(app.hostname).toBe('api');
  });
});

describe('composeUpModel with the host access checks off', () => {
  it('labels every container devenv.host-access=unrestricted only while the checks are off', () => {
    const off = composeUpModel(model(), params({ hostAccessChecks: 'off' })).model;
    expect(off.services.app.labels).toMatchObject({ [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED });
    expect(off.services.db.labels).toMatchObject({ [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED });
    const built = composeBuildModel(model(), params({ hostAccessChecks: 'off' })).model;
    expect(built.services.db.labels).toMatchObject({ [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED });
    for (const checks of [undefined, 'on'] as const) {
      const on = composeUpModel(model(), params({ hostAccessChecks: checks })).model;
      expect(on.services.app.labels).not.toHaveProperty(LABEL_HOST_ACCESS);
      expect(on.services.db.labels).not.toHaveProperty(LABEL_HOST_ACCESS);
    }
  });

  it('keeps the published ports as the model has them (no 127.0.0.1)', () => {
    const ports = [
      { mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' },
      { mode: 'ingress', target: 80, published: '8080', protocol: 'tcp', host_ip: '0.0.0.0' },
    ];
    const off = composeUpModel(model({}, { ports }), params({ hostAccessChecks: 'off' }));
    expect(off.model.services.db.ports).toEqual(ports);
    expect(off.rewrites.some((rewrite) => rewrite.reason === 'published on 127.0.0.1 only')).toBe(false);
    // With the checks on, the port without an address is bound to 127.0.0.1, and the other one is refused by the check.
    expect(() => composeUpModel(model({}, { ports }), params())).toThrow('published port 0.0.0.0:8080:80');
  });

  it('keeps a bind mount of the computer, and still replaces the template bind and the repository files', () => {
    const socket = { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' };
    const app = { volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces' }, socket] };
    const db = { volumes: [{ type: 'bind', source: `${REPO}/init.sql`, target: '/init.sql', read_only: true }] };
    const result = composeUpModel(model(app, db), params({ hostAccessChecks: 'off' })).model;
    expect(result.services.app.volumes).toEqual([{ type: 'volume', source: 'devenv-workspace', target: '/workspaces' }, socket]);
    expect(result.services.db.volumes).toEqual([
      { type: 'volume', source: 'devenv-workspace', target: '/init.sql', volume: { nocopy: true, subpath: 'api/init.sql' }, read_only: true },
    ]);
    expect(() => composeUpModel(model(app), params())).toThrow('bind mount /var/run/docker.sock');
  });

  it('still refuses what stays refused with the checks off: the workspace volume in another service, a link out of the repository, another folder at /workspaces', () => {
    const off = params({ hostAccessChecks: 'off' });
    expect(() => composeUpModel(model({}, { volumes: [{ type: 'bind', source: '/workspaces', target: '/w' }] }), off)).toThrow('the workspace volume');
    const link = { volumes: [{ type: 'bind', source: `${REPO}/data`, target: '/d' }] };
    expect(() => composeUpModel(model({}, link), { ...off, realPaths: { [`${REPO}/data`]: '/workspaces/.devenv+' } })).toThrow('a link to');
    expect(() => composeUpModel(model({ volumes: [{ type: 'bind', source: '/opt', target: '/workspaces' }] }), off)).toThrow('mount at /workspaces');
    // Published ports of a text that Docker would read otherwise are not supported.
    expect(() => composeUpModel(model({}, { ports: ['published=1,target=2'] }), off)).toThrow('published port');
  });
});
