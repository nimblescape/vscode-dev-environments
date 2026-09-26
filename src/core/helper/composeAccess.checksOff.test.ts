// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Package C of unit 6: the switch of the host access checks (concept section 9 "Host access", container-restrictions.md
// section 12) for Docker Compose configurations. Every item that composeAccessReport refuses has the class that the
// same setting has for a single container (hostAccess.checksOff.test.ts): `computer` is lifted while the checks are off
// for the repository; `protected` (account separation, the GitHub token and the owner account, items whose class is not
// clear) and `unsupported` stay refused whatever the switch says.
import { describe, expect, it } from 'vitest';
import type { ComposeModel } from './compose';
import { composeAccessClassification, composeAccessReport, type ComposeAccessInput } from './composeAccess';
import { GITHUB_CLI_ACCOUNT_REASON } from './containerGit';
import type { HostAccessClass } from './hostAccess';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = 'devenv-3f2a9c1e';
const OWN = 'devenv-acme-api-3f2a9c1e';
const REPO = '/workspaces/api';

function model(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: { image: 'mcr.microsoft.com/devcontainers/base:ubuntu', command: ['sleep', 'infinity'] },
      db: { image: 'postgres:16', volumes: [{ type: 'volume', source: 'pgdata', target: '/data' }] },
    },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function input(change: (m: ComposeModel) => void, overrides: Partial<ComposeAccessInput> = {}): ComposeAccessInput {
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
    ...overrides,
  };
}

/** The input with `settings` added to the service `service`. */
const service =
  (name: string, settings: Record<string, unknown>) =>
  (m: ComposeModel): void => {
    m.services[name] = { ...m.services[name], ...settings };
  };

// Each row: what the model has, the item, and its class.
const TABLE: Array<[string, ComposeAccessInput, string, HostAccessClass]> = [
  // Files, devices, privileges, and namespaces of the computer: as for a single container.
  ['a bind mount of the computer', input(service('db', { volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/s' }] })), 'service db: bind mount /var/run/docker.sock → /s', 'computer'],
  ['privileged mode', input(service('db', { privileged: true })), 'service db: privileged mode', 'computer'],
  ['a capability', input(service('db', { cap_add: ['NET_ADMIN'] })), 'service db: capability NET_ADMIN', 'computer'],
  ['a security option', input(service('db', { security_opt: ['apparmor=unconfined'] })), 'service db: security option apparmor=unconfined', 'computer'],
  ['devices', input(service('db', { devices: ['/dev/fuse'] })), 'service db: devices', 'computer'],
  ['device cgroup rules', input(service('db', { device_cgroup_rules: ['c 1:3 mr'] })), 'service db: device_cgroup_rules', 'computer'],
  ['gpus', input(service('db', { gpus: 'all' })), 'service db: GPU access (gpus)', 'computer'],
  ['a GPU reservation', input(service('db', { deploy: { resources: { reservations: { devices: [{ capabilities: ['gpu'] }] } } } })), 'service db: GPU or device access (deploy.resources.reservations.devices)', 'computer'],
  ['limits of devices', input(service('db', { blkio_config: { device_read_bps: [{ path: '/dev/sda', rate: '1mb' }] } })), 'service db: blkio_config device_read_bps', 'computer'],
  ['a runtime', input(service('db', { runtime: 'nvidia' })), 'service db: runtime', 'computer'],
  ['a cgroup parent', input(service('db', { cgroup_parent: '/x' })), 'service db: cgroup_parent', 'computer'],
  ['the pid namespace of the computer', input(service('db', { pid: 'host' })), 'service db: pid host', 'computer'],
  ['the ipc namespace of another container', input(service('db', { ipc: 'container:x' })), 'service db: ipc container:x', 'computer'],
  ['the uts namespace of the computer', input(service('db', { uts: 'host' })), 'service db: uts host', 'computer'],
  ['the user namespace of the computer', input(service('db', { userns_mode: 'host' })), 'service db: userns_mode host', 'computer'],
  ['the cgroup namespace of the computer', input(service('db', { cgroup: 'host' })), 'service db: cgroup host', 'computer'],
  ['volumes_from', input(service('db', { volumes_from: ['other'] })), 'service db: volumes_from', 'computer'],
  ['links', input(service('db', { links: ['other'] })), 'service db: links', 'computer'],
  ['external_links', input(service('db', { external_links: ['other'] })), 'service db: external_links', 'computer'],
  ['the network of another container', input(service('db', { network_mode: 'container:x' })), 'service db: network of another container (container:x)', 'computer'],
  ['a port on all addresses', input(service('db', { ports: [{ target: 5432, published: '5432', host_ip: '0.0.0.0' }] })), 'service db: published port 0.0.0.0:5432:5432', 'computer'],
  ['the Docker socket', input(service('db', { use_api_socket: true })), 'service db: the Docker socket (use_api_socket)', 'computer'],
  ['secrets of a service', input(service('db', { secrets: ['pw'] })), 'service db: secrets', 'computer'],
  ['top-level secrets', input((m) => (m.secrets = { pw: { file: '/etc/pw' } })), 'secrets', 'computer'],
  ['a privileged hook', input(service('db', { post_start: [{ command: 'x', privileged: true }] })), 'service db: privileged post_start', 'computer'],
  ['a build context outside the repository', input(service('db', { build: { context: '/etc' } })), 'service db: build context /etc', 'computer'],
  ['build secrets', input(service('db', { build: { context: REPO, secrets: ['npmrc'] } })), 'service db: build secrets', 'computer'],
  ['an additional build context of a folder', input(service('db', { build: { context: REPO, additional_contexts: { home: '/root' } } })), 'service db: build additional_contexts home=/root', 'computer'],
  ['a volume driver', input((m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver: 'nfs' } })), 'volume pgdata: driver nfs', 'computer'],
  ['volume driver options', input((m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver_opts: { device: '/x' } } })), 'volume pgdata: driver options', 'computer'],
  ['a network driver', input((m) => (m.networks = { lan: { driver: 'macvlan' } })), 'network lan: driver macvlan', 'computer'],
  ['a volume of another program', input(() => undefined, { volumeLabels: { [`${PROJECT}_pgdata`]: { 'com.docker.compose.project': 'shop' } } }), `volume ${PROJECT}_pgdata of the Docker Compose project shop`, 'computer'],
  // Account separation, the GitHub token, the owner account, and items whose class is not clear.
  ['the image of another environment', input(service('db', { image: 'devenv-11111111:3' })), 'service db: image devenv-11111111:3 of another environment', 'protected'],
  ['a volume of another environment by its project name', input((m) => (m.volumes = { pgdata: { name: 'devenv-11111111_pgdata' } })), 'volume devenv-11111111_pgdata of another environment', 'protected'],
  ['a volume of another environment by its labels', input(() => undefined, { volumeLabels: { [`${PROJECT}_pgdata`]: { 'devenv.environment-id': 'other' } } }), `volume ${PROJECT}_pgdata of another environment`, 'protected'],
  ['a volume of an environment of another account', input(() => undefined, { foreignVolumes: [`${PROJECT}_pgdata`] }), `volume ${PROJECT}_pgdata of another environment`, 'protected'],
  ['the cache volume of the workspace helper', input((m) => (m.volumes = { pgdata: { name: 'devenv-helper-cache' } })), 'volume devenv-helper-cache of the workspace helper', 'protected'],
  ['a network of another environment', input((m) => (m.networks = { other: { name: 'devenv-11111111_default', external: true } })), 'network devenv-11111111_default of another environment', 'protected'],
  ['network_mode of another environment', input(service('db', { network_mode: 'devenv-11111111_default' })), 'service db: network devenv-11111111_default of another environment', 'protected'],
  ['the workspace volume in a side service', input(service('db', { volumes: [{ type: 'bind', source: '/workspaces', target: '/w' }] })), 'service db: bind mount /workspaces → /w (the workspace volume, which holds the GitHub token)', 'protected'],
  ['a link out of the repository', input(service('db', { volumes: [{ type: 'bind', source: `${REPO}/d`, target: '/d' }] }), { realPaths: { [`${REPO}/d`]: '/workspaces/.devenv+' } }), `service db: bind mount ${REPO}/d → /d (a link to /workspaces/.devenv+, outside of the repository)`, 'protected'],
  ['an env_file outside the repository', input(service('db', { env_file: ['/root/.env'] })), 'service db: env_file /root/.env', 'protected'],
  ['a Git variable in the dev service', input(service('app', { environment: { GIT_CONFIG_GLOBAL: '/x' } })), 'service app: variable GIT_CONFIG_GLOBAL in environment', 'protected'],
  ['a gh variable in the dev service', input(service('app', { environment: { GH_TOKEN: 'x' } })), `service app: variable GH_TOKEN in environment (${GITHUB_CLI_ACCOUNT_REASON})`, 'protected'],
  ['a log driver', input(service('db', { logging: { driver: 'syslog' } })), 'service db: log driver syslog', 'protected'],
  ['oom_kill_disable', input(service('db', { oom_kill_disable: true })), 'service db: oom_kill_disable', 'protected'],
  ['a negative oom_score_adj', input(service('db', { oom_score_adj: -500 })), 'service db: oom_score_adj -500', 'protected'],
  // Not supported, whatever the switch says.
  ['restart always', input(service('db', { restart: 'always' })), 'service db: restart always', 'unsupported'],
  ['an unknown key', input(service('db', { future: 1 })), 'service db: future', 'unsupported'],
  ['a reserved label', input(service('db', { labels: { 'devenv.environment-id': 'x' } })), 'service db: label devenv.environment-id', 'unsupported'],
  ['a repository file with an old engine', input(service('db', { volumes: [{ type: 'bind', source: `${REPO}/i.sql`, target: '/i' }] }), { engineApiVersion: '1.44' }), `service db: bind mount ${REPO}/i.sql → /i (needs Docker Engine 26 or newer)`, 'unsupported'],
];

describe('composeAccessClassification', () => {
  it.each(TABLE)('%s', (_name, checked, item, expected) => {
    const findings = composeAccessClassification(checked);
    expect(findings).toContainEqual({ item, class: expected });
    const on = composeAccessReport(checked);
    const off = composeAccessReport(checked, false);
    const listed = (report: { hostAccess: string[]; unsupported: string[] }) => [...report.hostAccess, ...report.unsupported].includes(item);
    // Refused while the checks are on, whatever the class.
    expect(listed(on)).toBe(true);
    // Lifted while they are off only for the class `computer`, and reported in the same list otherwise.
    expect(listed(off)).toBe(expected !== 'computer');
    if (expected === 'unsupported') expect(off.unsupported).toContain(item);
    if (expected === 'protected') expect(off.hostAccess).toContain(item);
  });

  it('keeps the refusal that the switch does not lift when two rules name the same item', () => {
    // The same volume name in two keys: one of another program (computer), the same text never gets weaker.
    const checked = input(() => undefined, { foreignVolumes: [`${PROJECT}_pgdata`], volumeLabels: { [`${PROJECT}_pgdata`]: { 'devenv.environment-id': 'x' } } });
    expect(composeAccessReport(checked, false).hostAccess).toEqual([`volume ${PROJECT}_pgdata of another environment`]);
  });

  it('allows the template model with the checks off as with them on', () => {
    const checked = input(() => undefined);
    expect(composeAccessReport(checked, false)).toEqual({ hostAccess: [], unsupported: [] });
    expect(composeAccessClassification(checked)).toEqual([]);
  });
});
