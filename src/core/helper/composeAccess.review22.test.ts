// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 22 (H22-1 to H22-6): the guard rails on the final configuration. Settings that only join services of the
// same model are allowed; what reaches the GitHub token (the workspace volume and the processes of the dev container) or
// other containers stays refused whatever the switch of the host access checks says.
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from './compose';
import { composeAccessClassification, composeAccessReport, type ComposeAccessInput } from './composeAccess';
import { hostAccessClassification, type HostAccessFinding, type HostAccessInput } from './hostAccess';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = 'devenv-3f2a9c1e';
const OWN = 'devenv-acme-api-3f2a9c1e';
const REPO = '/workspaces/api';
const INTERNAL = "mounts into the extension's internal folder are not supported";

/** The dev service `app`, a database `db`, and a cache `cache`. */
function model(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: { image: 'mcr.microsoft.com/devcontainers/base:ubuntu', command: ['sleep', 'infinity'] },
      db: { image: 'postgres:16', volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }] },
      cache: { image: 'redis:7' },
    },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function input(change: (m: ComposeModel) => void): ComposeAccessInput {
  const m = model();
  change(m);
  return {
    model: m,
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: OWN,
    engineApiVersion: '1.47',
    environment: { id: ID, ownerId: '42' },
  };
}

const set =
  (name: string, settings: Record<string, unknown>) =>
  (m: ComposeModel): void => {
    m.services[name] = { ...m.services[name], ...settings };
  };

function classes(change: (m: ComposeModel) => void): HostAccessFinding[] {
  return composeAccessClassification(input(change));
}

const OFF_NONE = { hostAccess: [], unsupported: [] };

describe('review round 22, H22-1: links', () => {
  it('allows links to services of the model, also with an alias', () => {
    expect(classes(set('app', { links: ['db', 'cache:redis'] }))).toEqual([]);
    expect(classes(set('db', { links: ['app'] }))).toEqual([]);
  });

  it('refuses a link to a service that is not in the model as not supported', () => {
    expect(classes(set('app', { links: ['other'] }))).toEqual([{ item: 'service app: links other (not a service of the Docker Compose configuration)', class: 'unsupported' }]);
  });

  it('keeps external_links refused (access to the computer)', () => {
    expect(classes(set('app', { external_links: ['redis'] }))).toEqual([{ item: 'service app: external_links', class: 'computer' }]);
  });
});

describe('review round 22, H22-2: volumes_from', () => {
  it('allows the volumes of a service of the model that is not the dev service', () => {
    expect(classes(set('cache', { volumes_from: ['db', 'db:ro'] }))).toEqual([]);
    expect(classes(set('app', { volumes_from: ['db:rw'] }))).toEqual([]);
  });

  it('refuses the volumes of the dev service (the workspace volume with the token) whatever the switch says', () => {
    expect(classes(set('db', { volumes_from: ['app:ro'] }))).toEqual([
      // unit 15: the workspace volume no longer holds the GitHub token (it is in the memory of the dev container).
      { item: 'service db: volumes_from app:ro (the volumes of the dev container, with the workspace volume)', class: 'protected' },
    ]);
    const report = composeAccessReport(input(set('db', { volumes_from: ['app'] })), false);
    expect(report.hostAccess).toHaveLength(1);
  });

  it('refuses the volumes of any container whatever the switch says', () => {
    for (const entry of ['container:devenv-acme-web-11111111', 'container:postgres:ro', 'container:x:rw']) {
      expect(classes(set('db', { volumes_from: [entry] }))).toEqual([{ item: `service db: volumes_from ${entry} (the volumes of another container)`, class: 'protected' }]);
    }
  });

  it('refuses a service that is not in the model, and the service itself, as not supported', () => {
    expect(classes(set('db', { volumes_from: ['other'] }))).toEqual([{ item: 'service db: volumes_from other (not a service of the Docker Compose configuration)', class: 'unsupported' }]);
    expect(classes(set('db', { volumes_from: ['db'] }))).toEqual([{ item: 'service db: volumes_from db (not a service of the Docker Compose configuration)', class: 'unsupported' }]);
  });

  it('applies the rules of the mounts of the dev service to the mounts of a service whose volumes the dev service takes', () => {
    const atToken = (m: ComposeModel): void => {
      m.services.db.volumes = [{ type: 'volume', source: 'pgdata', target: '/workspaces/.devenv+' }];
      m.services.app.volumes_from = ['db'];
    };
    expect(classes(atToken)).toEqual([{ item: `service app: volumes_from db: mount at /workspaces/.devenv+ (${INTERNAL})`, class: 'unsupported' }]);
    const atWorkspaces = (m: ComposeModel): void => {
      m.services.db.tmpfs = ['/workspaces:size=1m'];
      m.services.app.volumes_from = ['cache'];
      m.services.cache.volumes_from = ['db'];
    };
    expect(classes(atWorkspaces)).toEqual([{ item: 'service app: volumes_from cache: mount at /workspaces', class: 'unsupported' }]);
    // The same mounts in a service that the dev service does not take are allowed.
    expect(classes((m) => (m.services.db.volumes = [{ type: 'volume', source: 'pgdata', target: '/workspaces/.devenv+' }]))).toEqual([]);
  });

  it('refuses --volumes-from of a single container whatever the switch says', () => {
    const single: HostAccessInput = { config: { runArgs: ['--volumes-from', 'db'] }, ownVolume: OWN };
    expect(hostAccessClassification(single)).toEqual([{ item: '--volumes-from=db', class: 'protected' }]);
  });
});

describe("review round 22, H22-3: Docker's default capabilities", () => {
  const DEFAULTS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'NET_RAW', 'SYS_CHROOT', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP'];
  const ALLOWED = [...DEFAULTS, 'SYS_PTRACE', 'cap_chown', 'Cap_Net_Raw', 'setfcap', ' KILL '];

  it('allows them in cap_add (cap_drop ALL and the defaults again)', () => {
    expect(classes(set('db', { cap_drop: ['ALL'], cap_add: ALLOWED }))).toEqual([]);
  });

  it('allows them in capAdd and --cap-add', () => {
    expect(hostAccessClassification({ config: { capAdd: ALLOWED }, ownVolume: OWN })).toEqual([]);
    expect(hostAccessClassification({ config: { runArgs: ALLOWED.flatMap((name) => ['--cap-add', name.trim()]) }, ownVolume: OWN })).toEqual([]);
  });

  it('refuses ALL and every other capability', () => {
    expect(classes(set('db', { cap_add: ['ALL', 'NET_ADMIN', 'CAP_SYS_ADMIN'] }))).toEqual([
      { item: 'service db: capability ALL', class: 'computer' },
      { item: 'service db: capability NET_ADMIN', class: 'computer' },
      { item: 'service db: capability CAP_SYS_ADMIN', class: 'computer' },
    ]);
    expect(hostAccessClassification({ config: { capAdd: ['all', 'CAP_BPF'] }, ownVolume: OWN })).toEqual([
      { item: 'capability all', class: 'computer' },
      { item: 'capability CAP_BPF', class: 'computer' },
    ]);
    expect(hostAccessClassification({ config: { runArgs: ['--cap-add=ALL', '--cap-add', 'SYS_MODULE'] }, ownVolume: OWN })).toEqual([
      { item: 'capability ALL', class: 'computer' },
      { item: 'capability SYS_MODULE', class: 'computer' },
    ]);
  });
});

describe('review round 22, H22-4: secrets and configs', () => {
  it('allows secrets and configs from the environment of Compose and configs with a content', () => {
    const change = (m: ComposeModel): void => {
      m.secrets = { pw: { name: `${PROJECT}_pw`, environment: 'DB_PASSWORD' } };
      m.configs = { conf: { name: `${PROJECT}_conf`, content: 'a=1\n' }, env: { environment: 'CONF' } };
      m.services.db.secrets = [{ source: 'pw', target: '/run/secrets/pw' }];
      m.services.app.secrets = ['pw'];
      m.services.app.configs = [{ source: 'conf' }, { source: 'env', target: '/etc/env.conf', mode: 0o444 }];
    };
    expect(classes(change)).toEqual([]);
  });

  it('refuses a file of the repository as not supported, with the hint to mount it read-only', () => {
    expect(classes((m) => (m.secrets = { pw: { name: `${PROJECT}_pw`, file: `${REPO}/.devcontainer/pw.txt` } }))).toEqual([
      {
        item: `secret pw: file ${REPO}/.devcontainer/pw.txt (a file of the repository is not supported; mount it read-only instead, for example ./pw.txt:/run/secrets/pw:ro)`,
        class: 'unsupported',
      },
    ]);
    expect(classes((m) => (m.configs = { c: { file: `${REPO}/c.conf` } }))).toEqual([
      { item: `config c: file ${REPO}/c.conf (a file of the repository is not supported; mount it read-only instead, for example ./c.conf:/c:ro)`, class: 'unsupported' },
    ]);
  });

  it('refuses a file of the workspace helper whatever the switch says, and another file of the computer as access to it', () => {
    expect(classes((m) => (m.secrets = { t: { file: '/workspaces/.devenv+/token' } }))).toEqual([{ item: 'secret t: file /workspaces/.devenv+/token', class: 'protected' }]);
    expect(classes((m) => (m.configs = { t: { file: '/devenv-cache/x' } }))).toEqual([{ item: 'config t: file /devenv-cache/x', class: 'protected' }]);
    expect(classes((m) => (m.secrets = { pw: { file: '/etc/pw' } }))).toEqual([{ item: 'secret pw: file /etc/pw', class: 'computer' }]);
  });

  it('refuses content for secrets, external ones, and unknown keys as not supported', () => {
    expect(classes((m) => (m.secrets = { a: { content: 'x' }, b: { external: true, name: 'b' }, c: { driver: 'x' } }))).toEqual([
      { item: 'secret a: content', class: 'unsupported' },
      { item: 'secret b: external', class: 'unsupported' },
      { item: 'secret c: driver', class: 'unsupported' },
    ]);
  });

  it('refuses a target in the internal folder or at /workspaces of the dev service', () => {
    const change = (m: ComposeModel): void => {
      m.secrets = { pw: { environment: 'PW' } };
      m.configs = { c: { content: 'x' } };
      m.services.app.secrets = [{ source: 'pw', target: '/workspaces/.devenv+/token' }];
      m.services.app.configs = [{ source: 'c', target: '/workspaces' }];
      m.services.db.secrets = [{ source: 'pw', target: '/workspaces/.devenv+/token' }];
    };
    expect(classes(change)).toEqual([
      { item: `service app: secret pw at /workspaces/.devenv+/token (${INTERNAL})`, class: 'unsupported' },
      { item: 'service app: config c at /workspaces', class: 'unsupported' },
    ]);
  });

  it('leaves build secrets as they were (access to the computer)', () => {
    expect(classes(set('db', { build: { context: REPO, secrets: ['pw'] } }))).toContainEqual({ item: 'service db: build secrets', class: 'computer' });
  });
});

describe('review round 22, H22-5: driver and driver options of a top-level volume', () => {
  const HINT = 'Dev Environments creates the volumes with the local driver and without options; for a tmpfs, use the tmpfs option of the service';

  it('refuses them as not supported (they would be dropped), also with the checks off', () => {
    const tmpfs = (m: ComposeModel): void => {
      m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver: 'local', driver_opts: { type: 'tmpfs', device: 'tmpfs', o: 'size=100m' } } };
    };
    expect(classes(tmpfs)).toEqual([{ item: `volume pgdata: driver options (${HINT})`, class: 'unsupported' }]);
    expect(composeAccessReport(input(tmpfs), false).unsupported).toEqual([`volume pgdata: driver options (${HINT})`]);
    const bind = (m: ComposeModel): void => {
      m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver_opts: { type: 'tmpfs', device: 'tmpfs', o: 'bind' } } };
    };
    expect(classes(bind)).toEqual([{ item: `volume pgdata: driver options (${HINT})`, class: 'unsupported' }]);
    expect(classes((m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver: 'nfs' } }))).toEqual([{ item: `volume pgdata: driver nfs (${HINT})`, class: 'unsupported' }]);
  });

  it('allows the local driver without options, and the tmpfs option of a service', () => {
    expect(classes((m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver: 'local' } }))).toEqual([]);
    expect(classes(set('db', { tmpfs: ['/var/lib/postgresql/data:size=100m'] }))).toEqual([]);
  });
});

describe('review round 22, H22-6: ipc and pid of another service', () => {
  it('allows ipc service: of another service of the model, also of the dev service', () => {
    expect(classes((m) => ((m.services.db.ipc = 'shareable'), (m.services.cache.ipc = 'service:db')))).toEqual([]);
    expect(classes((m) => ((m.services.app.ipc = 'shareable'), (m.services.db.ipc = 'service:app')))).toEqual([]);
    expect(classes(set('app', { ipc: 'service:db' }))).toEqual([]);
  });

  it('keeps ipc of the service itself, of an unknown service, and of a container refused', () => {
    expect(classes(set('db', { ipc: 'service:db' }))).toEqual([{ item: 'service db: ipc service:db', class: 'computer' }]);
    expect(classes(set('db', { ipc: 'service:other' }))).toEqual([{ item: 'service db: ipc service:other', class: 'computer' }]);
    expect(classes(set('db', { ipc: 'container:x' }))).toEqual([{ item: 'service db: ipc container:x', class: 'computer' }]);
  });

  it('allows pid service: between services that are not the dev service', () => {
    expect(classes(set('cache', { pid: 'service:db' }))).toEqual([]);
    expect(classes((m) => ((m.services.cache.pid = 'service:db'), (m.services.db.pid = 'host')))).toEqual([{ item: 'service db: pid host', class: 'computer' }]);
  });

  it('refuses pid sharing with the dev service, also through a chain, whatever the switch says', () => {
    const reason = '(the processes of the dev container, which holds the GitHub token)';
    expect(classes(set('db', { pid: 'service:app' }))).toEqual([{ item: `service db: pid service:app ${reason}`, class: 'protected' }]);
    expect(classes(set('app', { pid: 'service:db' }))).toEqual([{ item: `service app: pid service:db ${reason}`, class: 'protected' }]);
    // cache → db → app, and app and cache → db.
    expect(classes((m) => ((m.services.cache.pid = 'service:db'), (m.services.db.pid = 'service:app')))).toEqual([
      { item: `service db: pid service:app ${reason}`, class: 'protected' },
      { item: `service cache: pid service:db ${reason}`, class: 'protected' },
    ]);
    expect(classes((m) => ((m.services.cache.pid = 'service:db'), (m.services.app.pid = 'service:db')))).toEqual([
      { item: `service app: pid service:db ${reason}`, class: 'protected' },
      { item: `service cache: pid service:db ${reason}`, class: 'protected' },
    ]);
    expect(composeAccessReport(input(set('db', { pid: 'service:app' })), false)).not.toEqual(OFF_NONE);
  });

  it('refuses pid container: and --pid container: whatever the switch says', () => {
    expect(classes(set('db', { pid: 'container:devenv-acme-web-11111111' }))).toEqual([{ item: 'service db: pid container:devenv-acme-web-11111111', class: 'protected' }]);
    expect(hostAccessClassification({ config: { runArgs: ['--pid', 'container:x'] }, ownVolume: OWN })).toEqual([{ item: '--pid=container:x', class: 'protected' }]);
    expect(hostAccessClassification({ config: { runArgs: ['--pid=host'] }, ownVolume: OWN })).toEqual([{ item: '--pid=host', class: 'computer' }]);
  });
});
