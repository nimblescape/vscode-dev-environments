// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { ComposeModel } from './compose';
import {
  composeAccessReport,
  composeConfigurationReport,
  composeIgnoredProperties,
  durationSeconds,
  type ComposeAccessInput,
} from './composeAccess';
import { GITHUB_CLI_ACCOUNT_REASON } from './containerGit';
import type { HostAccessReport } from './hostAccess';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = 'devenv-3f2a9c1e';
const OWN = 'devenv-acme-api-3f2a9c1e';
const REPO = '/workspaces/api';
const NONE: HostAccessReport = { hostAccess: [], unsupported: [] };

/** A merged model that the policy allows: the dev service `app` and a database `db`. */
function model(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: {
        build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile' },
        command: ['sleep', 'infinity'],
        volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces' }],
      },
      db: {
        image: 'postgres:16',
        ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }],
        volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }],
      },
    },
    networks: { default: { name: `${PROJECT}_default` } },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function input(overrides: Partial<ComposeAccessInput> = {}): ComposeAccessInput {
  return {
    model: model(),
    devService: 'app',
    project: PROJECT,
    repositoryFolder: REPO,
    ownVolume: OWN,
    engineApiVersion: '1.47',
    environment: { id: ID, ownerId: '42' },
    ...overrides,
  };
}

/** The report of the model with `settings` added to the service `service`. */
function serviceReport(service: string, settings: Record<string, unknown>, overrides: Partial<ComposeAccessInput> = {}): HostAccessReport {
  const base = model();
  base.services[service] = { ...(base.services[service] ?? { image: 'alpine:3.22' }), ...settings };
  return composeAccessReport(input({ model: base, ...overrides }));
}

const A = (...items: string[]): HostAccessReport => ({ hostAccess: items, unsupported: [] });
const U = (...items: string[]): HostAccessReport => ({ hostAccess: [], unsupported: items });

describe('composeAccessReport: the allowed model', () => {
  it('allows the template model', () => {
    expect(composeAccessReport(input())).toEqual(NONE);
  });

  it('allows extension fields at every level', () => {
    const base = model();
    base['x-common'] = { a: 1 };
    base.services.db['x-note'] = 'x';
    expect(composeAccessReport(input({ model: base }))).toEqual(NONE);
  });
});

describe('composeAccessReport: services (rule table 4.2)', () => {
  // [description, service, settings, expected report]. Each rule: an allowed value and a refused one.
  it.each<[string, string, Record<string, unknown>, HostAccessReport]>([
    // image (D-17)
    ['an image', 'db', { image: 'mirror.gcr.io/library/alpine:3.22' }, NONE],
    ['the image of another environment', 'db', { image: 'devenv-11111111:3' }, A('service db: image devenv-11111111:3 of another environment')],
    ['the image of another environment on Docker Hub', 'db', { image: 'docker.io/library/devenv-11111111-app' }, A('service db: image docker.io/library/devenv-11111111-app of another environment')],
    // build
    ['a build context in the repository', 'db', { build: { context: REPO, dockerfile: 'docker/Dockerfile', args: { A: '1' }, target: 'dev', network: 'host', pull: true, no_cache: true, shm_size: '1g', extra_hosts: ['a:1.2.3.4'], platforms: ['linux/amd64'], ulimits: {}, isolation: 'default' } }, NONE],
    ['a remote build context', 'db', { build: { context: 'https://github.com/acme/tool.git#main', dockerfile: 'Dockerfile' } }, NONE],
    ['a build context of git@', 'db', { build: { context: 'git@github.com:acme/tool.git' } }, NONE],
    ['a build context of the parent of the repository', 'db', { build: { context: '/workspaces' } }, A('service db: build context /workspaces')],
    ['a build context outside the repository', 'db', { build: { context: '/etc' } }, A('service db: build context /etc')],
    ['a build context with ..', 'db', { build: { context: `${REPO}/../other` } }, A(`service db: build context ${REPO}/../other`)],
    ['a build without context', 'db', { build: { dockerfile: 'Dockerfile' } }, A('service db: build context undefined')],
    ['a Dockerfile outside the repository', 'db', { build: { context: REPO, dockerfile: '../../etc/Dockerfile' } }, A('service db: Dockerfile ../../etc/Dockerfile')],
    ['an absolute Dockerfile outside the repository', 'db', { build: { context: REPO, dockerfile: '/root/Dockerfile' } }, A('service db: Dockerfile /root/Dockerfile')],
    ['a dockerfile_inline', 'db', { build: { context: REPO, dockerfile_inline: 'FROM alpine' } }, NONE],
    ['a build label', 'db', { build: { context: REPO, labels: { team: 'a' } } }, NONE],
    ['a reserved build label', 'db', { build: { context: REPO, labels: { 'devenv.environment-id': 'x' } } }, U('service db: build label devenv.environment-id')],
    ['build ssh', 'db', { build: { context: REPO, ssh: ['default'] } }, A('service db: build ssh')],
    ['build secrets', 'db', { build: { context: REPO, secrets: ['npmrc'] } }, A('service db: build secrets')],
    ['build entitlements', 'db', { build: { context: REPO, entitlements: ['network.host'] } }, A('service db: build entitlements')],
    ['a privileged build', 'db', { build: { context: REPO, privileged: true } }, A('service db: build privileged')],
    ['build tags', 'db', { build: { context: REPO, tags: ['devenv-11111111:1'] } }, U('service db: build tags')],
    ['build cache_to', 'db', { build: { context: REPO, cache_to: ['type=local,dest=/x'] } }, U('service db: build cache_to')],
    ['an unknown build key', 'db', { build: { context: REPO, future: 1 } }, U('service db: build future')],
    ['cache_from of an image and a registry', 'db', { build: { context: REPO, cache_from: ['acme/cache:1', 'type=registry,ref=acme/cache'] } }, NONE],
    ['cache_from of a local folder', 'db', { build: { context: REPO, cache_from: ['type=local,src=/x'] } }, U('service db: build cache_from type=local,src=/x')],
    ['additional contexts of images and URLs', 'db', { build: { context: REPO, additional_contexts: { base: 'docker-image://alpine', src: 'https://x/y.git' } } }, NONE],
    ['an additional context of a folder', 'db', { build: { context: REPO, additional_contexts: { home: '/root' } } }, A('service db: build additional_contexts home=/root')],
    ['an additional context of a service', 'db', { build: { context: REPO, additional_contexts: { base: 'service:app' } } }, A('service db: build additional_contexts base=service:app')],
    // container_name (rewritten, D-12)
    ['a container_name', 'db', { container_name: 'db1' }, NONE],
    // labels
    ['labels', 'db', { labels: { team: 'a' } }, NONE],
    ['a devenv. label', 'db', { labels: { 'devenv.environment-id': 'x' } }, U('service db: label devenv.environment-id')],
    ['a devcontainer. label (list)', 'db', { labels: ['devcontainer.metadata=[]'] }, U('service db: label devcontainer.metadata')],
    ['a com.docker.compose. label', 'db', { labels: { 'com.docker.compose.project': 'other' } }, U('service db: label com.docker.compose.project')],
    ['a label_file', 'db', { label_file: ['./labels'] }, U('service db: label_file')],
    // environment (D-5)
    ['a Git variable in a side service', 'db', { environment: { GH_TOKEN: 'x', GIT_CONFIG_GLOBAL: '/x' } }, NONE],
    ['a Git variable in the dev service', 'app', { environment: { GIT_CONFIG_GLOBAL: '/x', PORT: '1' } }, A('service app: variable GIT_CONFIG_GLOBAL in environment')],
    ['a gh variable in the dev service', 'app', { environment: { GH_TOKEN: 'x' } }, A(`service app: variable GH_TOKEN in environment (${GITHUB_CLI_ACCOUNT_REASON})`)],
    ['a Git variable in the dev service (list)', 'app', { environment: ['GIT_CONFIG_GLOBAL=/x'] }, A('service app: variable GIT_CONFIG_GLOBAL in environment')],
    // env_file
    ['an env_file in the repository', 'db', { env_file: [`${REPO}/.env.db`, { path: `${REPO}/.devcontainer/db.env`, required: false }] }, NONE],
    ['an env_file outside the repository', 'db', { env_file: ['/root/.env'] }, A('service db: env_file /root/.env')],
    ['an env_file in the configuration folder of the volume', 'app', { env_file: ['/workspaces/.devenv+/github-token'] }, A('service app: env_file /workspaces/.devenv+/github-token')],
    ['an env_file with ..', 'db', { env_file: [`${REPO}/../x.env`] }, A(`service db: env_file ${REPO}/../x.env`)],
    ['an env_file that links out of the repository', 'db', { env_file: [`${REPO}/x.env`] }, A(`service db: env_file ${REPO}/x.env`)],
    ['an env_file that is no path', 'db', { env_file: [1] }, U('service db: env_file 1')],
    // ports
    ['a port on 127.0.0.1', 'db', { ports: [{ target: 1, host_ip: '127.0.0.1' }] }, NONE],
    ['a port on all addresses', 'db', { ports: [{ target: 5432, published: '5432', host_ip: '0.0.0.0' }] }, A('service db: published port 0.0.0.0:5432:5432')],
    ['a port that cannot be read', 'db', { ports: [true] }, U('service db: published port true')],
    ['expose', 'db', { expose: ['5432'] }, NONE],
    // network_mode (D-9)
    ['network_mode host', 'db', { network_mode: 'host' }, NONE],
    ['network_mode none', 'db', { network_mode: 'none' }, NONE],
    ['network_mode bridge', 'db', { network_mode: 'bridge' }, NONE],
    ['network_mode of a network', 'db', { network_mode: 'frontend' }, NONE],
    ['network_mode of a service of the configuration', 'app', { network_mode: 'service:db' }, NONE],
    ['network_mode of an unknown service', 'app', { network_mode: 'service:other' }, A('service app: network of another container (service:other)')],
    ['network_mode of the service itself', 'app', { network_mode: 'service:app' }, A('service app: network of another container (service:app)')],
    ['network_mode of a container', 'app', { network_mode: 'container:devenv-acme-web-11111111' }, A('service app: network of another container (container:devenv-acme-web-11111111)')],
    ['network_mode of another environment', 'db', { network_mode: 'devenv-11111111_default' }, A('service db: network devenv-11111111_default of another environment')],
    ['networks', 'db', { networks: { default: { aliases: ['database'], ipv4_address: '172.20.0.5' } } }, NONE],
    // volumes (D-6, D-11: details in compose.test.ts)
    ['the workspace volume in a side service', 'db', { volumes: [{ type: 'bind', source: '/workspaces', target: '/w' }] }, A('service db: bind mount /workspaces → /w (the workspace volume, which holds the GitHub token)')],
    ['a bind mount of the computer', 'db', { volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] }, A('service db: bind mount /var/run/docker.sock → /var/run/docker.sock')],
    ['a bind mount of repository files', 'db', { volumes: [{ type: 'bind', source: `${REPO}/init.sql`, target: '/i.sql' }] }, NONE],
    ['a volume at /workspaces of the dev service', 'app', { volumes: [{ type: 'volume', source: 'pgdata', target: '/workspaces' }] }, U('service app: mount at /workspaces')],
    ['a mount of the type npipe', 'db', { volumes: [{ type: 'npipe', source: 'p', target: '/p' }] }, U('service db: mount of the type npipe (p → /p)')],
    // other containers
    ['volumes_from', 'db', { volumes_from: ['app'] }, A('service db: volumes_from')],
    ['links', 'db', { links: ['app'] }, A('service db: links')],
    ['external_links', 'db', { external_links: ['redis'] }, A('service db: external_links')],
    // privileges
    ['privileged', 'db', { privileged: true }, A('service db: privileged mode')],
    ['privileged false', 'db', { privileged: false }, NONE],
    ['cap_add SYS_PTRACE', 'app', { cap_add: ['SYS_PTRACE'] }, NONE],
    ['cap_add NET_ADMIN', 'db', { cap_add: ['SYS_PTRACE', 'NET_ADMIN'] }, A('service db: capability NET_ADMIN')],
    ['cap_drop', 'db', { cap_drop: ['ALL'] }, NONE],
    ['security_opt seccomp=unconfined, no-new-privileges', 'db', { security_opt: ['seccomp=unconfined', 'no-new-privileges:true'] }, NONE],
    ['security_opt apparmor=unconfined', 'db', { security_opt: ['apparmor=unconfined'] }, A('service db: security option apparmor=unconfined')],
    // devices
    ['devices', 'db', { devices: [{ source: '/dev/kvm', target: '/dev/kvm' }] }, A('service db: devices')],
    ['device_cgroup_rules', 'db', { device_cgroup_rules: ['c 1:3 mr'] }, A('service db: device_cgroup_rules')],
    ['gpus', 'db', { gpus: 'all' }, A('service db: GPU access (gpus)')],
    ['blkio_config weight', 'db', { blkio_config: { weight: 300 } }, NONE],
    ['blkio_config of a device', 'db', { blkio_config: { weight_device: [{ path: '/dev/sda', weight: 1 }], device_read_bps: [{ path: '/dev/sda', rate: '1mb' }] } }, A('service db: blkio_config weight_device', 'service db: blkio_config device_read_bps')],
    ['an unknown blkio_config key', 'db', { blkio_config: { future: 1 } }, U('service db: blkio_config future')],
    ['runtime', 'db', { runtime: 'nvidia' }, A('service db: runtime')],
    ['cgroup_parent', 'db', { cgroup_parent: 'm-executor' }, A('service db: cgroup_parent')],
    ['oom_kill_disable', 'db', { oom_kill_disable: true }, A('service db: oom_kill_disable')],
    ['oom_score_adj 0 or more', 'db', { oom_score_adj: 500 }, NONE],
    ['oom_score_adj below 0', 'db', { oom_score_adj: -500 }, A('service db: oom_score_adj -500')],
    // namespaces
    ['pid host', 'db', { pid: 'host' }, A('service db: pid host')],
    ['pid of another service', 'db', { pid: 'service:app' }, A('service db: pid service:app')],
    ['ipc private', 'db', { ipc: 'private' }, NONE],
    ['ipc shareable', 'db', { ipc: 'shareable' }, NONE],
    ['ipc host', 'db', { ipc: 'host' }, A('service db: ipc host')],
    ['ipc of a container', 'db', { ipc: 'container:x' }, A('service db: ipc container:x')],
    ['an unknown ipc', 'db', { ipc: 'future' }, U('service db: ipc future')],
    ['uts host', 'db', { uts: 'host' }, A('service db: uts host')],
    ['userns_mode host', 'db', { userns_mode: 'host' }, A('service db: userns_mode host')],
    ['cgroup private', 'db', { cgroup: 'private' }, NONE],
    ['cgroup host', 'db', { cgroup: 'host' }, A('service db: cgroup host')],
    ['sysctls (D-13)', 'db', { sysctls: { 'net.core.somaxconn': 1024 } }, NONE],
    // logging
    ['logging json-file with max-size', 'db', { logging: { driver: 'json-file', options: { 'max-size': '10m' } } }, NONE],
    ['logging syslog', 'db', { logging: { driver: 'syslog' } }, A('service db: log driver syslog')],
    ['a log option of another driver', 'db', { logging: { options: { 'syslog-address': 'udp://1.2.3.4' } } }, U('service db: log option syslog-address')],
    ['storage_opt size', 'db', { storage_opt: { size: '1G' } }, NONE],
    ['another storage_opt', 'db', { storage_opt: { dm: 'x' } }, U('service db: storage_opt dm')],
    // restart and stop (D-14)
    ['restart no', 'db', { restart: 'no' }, NONE],
    ['restart on-failure:3', 'db', { restart: 'on-failure:3' }, NONE],
    ['restart always', 'db', { restart: 'always' }, U('service db: restart always')],
    ['restart unless-stopped', 'db', { restart: 'unless-stopped' }, U('service db: restart unless-stopped')],
    ['stop_grace_period 20s', 'db', { stop_grace_period: '20s' }, NONE],
    ['stop_grace_period 21s', 'db', { stop_grace_period: '21s' }, U('service db: stop_grace_period 21s')],
    ['stop_grace_period 1m', 'db', { stop_grace_period: '1m' }, U('service db: stop_grace_period 1m')],
    ['stop_grace_period that cannot be read', 'db', { stop_grace_period: 'soon' }, U('service db: stop_grace_period soon')],
    ['stop_signal', 'db', { stop_signal: 'SIGINT' }, NONE],
    // deploy
    ['deploy limits and reservations', 'db', { deploy: { resources: { limits: { cpus: '1', memory: '1g', pids: 100 }, reservations: { memory: '100m' } }, restart_policy: { condition: 'on-failure' } } }, NONE],
    ['a GPU reservation', 'db', { deploy: { resources: { reservations: { devices: [{ capabilities: ['gpu'] }] } } } }, A('service db: GPU or device access (deploy.resources.reservations.devices)')],
    ['deploy restart_policy any', 'db', { deploy: { restart_policy: { condition: 'any' } } }, U('service db: deploy.restart_policy.condition any')],
    ['deploy replicas', 'db', { deploy: { replicas: 2 } }, U('service db: deploy.replicas')],
    ['deploy generic_resources', 'db', { deploy: { resources: { reservations: { generic_resources: [{}] } } } }, U('service db: deploy.resources.reservations.generic_resources')],
    ['pull_policy (rewritten, D-16)', 'db', { pull_policy: 'always' }, NONE],
    ['use_api_socket', 'db', { use_api_socket: true }, A('service db: the Docker socket (use_api_socket)')],
    ['service secrets', 'db', { secrets: [{ source: 'pw' }] }, A('service db: secrets')],
    ['service configs', 'db', { configs: [{ source: 'c' }] }, A('service db: configs')],
    ['models', 'db', { models: { m: {} } }, U('service db: models')],
    ['provider', 'db', { provider: { type: 'x' } }, U('service db: provider')],
    ['credential_spec', 'db', { credential_spec: { file: 'x' } }, U('service db: credential_spec')],
    ['scale 1', 'db', { scale: 1 }, NONE],
    ['scale 2', 'db', { scale: 2 }, U('service db: scale 2')],
    ['post_start', 'db', { post_start: [{ command: 'x' }] }, NONE],
    ['a privileged post_start', 'db', { post_start: [{ command: 'x', privileged: true }] }, A('service db: privileged post_start')],
    ['a privileged pre_stop', 'db', { pre_stop: [{ command: 'x', privileged: true }] }, A('service db: privileged pre_stop')],
    ['settings without access to the computer', 'db', { entrypoint: ['x'], working_dir: '/x', user: '1000', group_add: ['a'], hostname: 'h', domainname: 'd', dns: ['1.1.1.1'], dns_search: ['x'], dns_opt: ['a'], extra_hosts: ['a:1.2.3.4'], init: true, tty: true, stdin_open: true, read_only: true, tmpfs: ['/run'], shm_size: '1g', ulimits: { nofile: 1 }, cpus: 1, cpu_shares: 1, cpuset: '0', mem_limit: '1g', memswap_limit: '1g', mem_swappiness: 1, pids_limit: 10, healthcheck: { test: ['CMD', 'true'] }, depends_on: { app: { condition: 'service_started' } }, profiles: ['tools'], platform: 'linux/amd64', annotations: { a: 'b' }, attach: false, develop: { watch: [] }, mac_address: '02:42:ac:11:00:02' }, NONE],
    ['an unknown key', 'db', { future_key: true }, U('service db: future_key')],
    ['extends (left after the merge)', 'db', { extends: { service: 'x' } }, U('service db: extends')],
    ['a dev service without image and build', 'app', { build: null, image: null }, U('service app: no image and no build')],
  ])('%s', (_name, service, settings, expected) => {
    const overrides: Partial<ComposeAccessInput> = _name === 'an env_file that links out of the repository' ? { realPaths: { [`${REPO}/x.env`]: '/root/.env' } } : {};
    expect(serviceReport(service, settings, overrides)).toEqual(expected);
  });

  it('checks every service, also services of profiles that runServices does not start', () => {
    const report = serviceReport('tools', { image: 'alpine', privileged: true, profiles: ['debug'] }, { runServices: ['app', 'db'] });
    expect(report).toEqual(A('service tools: privileged mode'));
  });

  it('refuses bind mounts of repository files with an engine before Docker Engine 26', () => {
    expect(serviceReport('db', { volumes: [{ type: 'bind', source: `${REPO}/init.sql`, target: '/i.sql' }] }, { engineApiVersion: '1.44' })).toEqual(
      U(`service db: bind mount ${REPO}/init.sql → /i.sql (needs Docker Engine 26 or newer)`),
    );
  });

  it('refuses the workspace volume by name in a side service', () => {
    const base = model();
    base.volumes = { ...base.volumes, ws: { name: OWN, external: true } };
    base.services.db.volumes = [{ type: 'volume', source: 'ws', target: '/w' }];
    expect(composeAccessReport(input({ model: base }))).toEqual(A(`service db: volume ${OWN} (the workspace volume, which holds the GitHub token)`));
  });
});

describe('composeAccessReport: the top level (rule table 4.1)', () => {
  function topReport(change: (model: ComposeModel) => void, overrides: Partial<ComposeAccessInput> = {}): HostAccessReport {
    const base = model();
    change(base);
    return composeAccessReport(input({ model: base, ...overrides }));
  }

  it.each<[string, (model: ComposeModel) => void, HostAccessReport]>([
    ['another project name', (m) => (m.name = 'api_devcontainer'), U('project name api_devcontainer')],
    ['version (obsolete)', (m) => (m.version = '3.8'), NONE],
    ['secrets', (m) => (m.secrets = { pw: { file: './pw.txt' } }), A('secrets')],
    ['configs', (m) => (m.configs = { c: { file: './c' } }), A('configs')],
    ['models', (m) => (m.models = { m: {} }), U('models')],
    ['include (left after the merge)', (m) => (m.include = ['x.yml']), U('include')],
    ['an unknown key', (m) => (m.future = { a: 1 }), U('future')],
    // volumes
    ['a named volume', (m) => (m.volumes = { ...m.volumes, cache: { name: 'shared-cache' } }), NONE],
    ['an external volume', (m) => (m.volumes = { ...m.volumes, old: { external: true, name: 'old' } }), NONE],
    ['a volume with the local driver', (m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver: 'local' } }), NONE],
    ['a volume with another driver', (m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver: 'nfs' } }), A('volume pgdata: driver nfs')],
    ['a volume with driver options', (m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, driver_opts: { type: 'none', device: '/Users/x', o: 'bind' } } }), A('volume pgdata: driver options')],
    ['a volume with a reserved label', (m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, labels: { 'devenv.volume': 'additional' } } }), U('volume pgdata: label devenv.volume')],
    ['a volume with an unknown option', (m) => (m.volumes = { pgdata: { name: `${PROJECT}_pgdata`, future: 1 } }), U('volume pgdata: future')],
    ['the key of the workspace volume', (m) => (m.volumes = { ...m.volumes, 'devenv-workspace': { name: `${PROJECT}_devenv-workspace` } }), U('volume key devenv-workspace (Dev Environments uses it)')],
    ['a volume of the project of another environment', (m) => (m.volumes = { ...m.volumes, data: { name: 'devenv-11111111_pgdata', external: true } }), A('volume devenv-11111111_pgdata of another environment')],
    ['the workspace volume of another environment', (m) => (m.volumes = { ...m.volumes, data: { name: 'devenv-acme-web-11111111', external: true } }), A('volume devenv-acme-web-11111111 of another environment')],
    ['the cache volume of the helper', (m) => (m.volumes = { ...m.volumes, data: { name: 'devenv-helper-cache', external: true } }), A('volume devenv-helper-cache of the workspace helper')],
    ['a volume of the Dev Containers extension', (m) => (m.volumes = { ...m.volumes, data: { name: 'vscode', external: true } }), A('volume vscode of the Dev Containers extension')],
    // networks
    ['a bridge network', (m) => (m.networks = { front: { driver: 'bridge', internal: true, attachable: true, enable_ipv6: false, ipam: { config: [] }, labels: { a: 'b' } } }), NONE],
    ['an external network', (m) => (m.networks = { shared: { name: 'shared', external: true } }), NONE],
    ['a macvlan network', (m) => (m.networks = { lan: { driver: 'macvlan' } }), A('network lan: driver macvlan')],
    ['network driver options', (m) => (m.networks = { lan: { driver_opts: { parent: 'eth0' } } }), A('network lan: driver options')],
    ['a network of another environment', (m) => (m.networks = { other: { name: 'devenv-11111111_default', external: true } }), A('network devenv-11111111_default of another environment')],
    ['a network with a reserved label', (m) => (m.networks = { front: { labels: { 'com.docker.compose.network': 'x' } } }), U('network front: label com.docker.compose.network')],
    ['a network with an unknown option', (m) => (m.networks = { front: { future: 1 } }), U('network front: future')],
  ])('%s', (_name, change, expected) => {
    expect(topReport(change)).toEqual(expected);
  });

  it('allows the own project volume when it exists with the labels of the environment, and refuses one of another account', () => {
    const own = { 'devenv.environment-id': ID, 'devenv.owner-id': '42', 'devenv.volume': 'compose' };
    expect(composeAccessReport(input({ volumeLabels: { [`${PROJECT}_pgdata`]: own } }))).toEqual(NONE);
    const other = { ...own, 'devenv.environment-id': '11111111-0000-4000-8000-000000000000' };
    expect(composeAccessReport(input({ volumeLabels: { [`${PROJECT}_pgdata`]: other } }))).toEqual(A(`volume ${PROJECT}_pgdata of another environment`));
    expect(composeAccessReport(input({ foreignVolumes: [`${PROJECT}_pgdata`] }))).toEqual(A(`volume ${PROJECT}_pgdata of another environment`));
    expect(composeAccessReport(input({ volumeLabels: { [`${PROJECT}_pgdata`]: { 'com.docker.compose.project': 'shop' } } }))).toEqual(
      A(`volume ${PROJECT}_pgdata of the Docker Compose project shop`),
    );
  });
});

describe('composeAccessReport: devcontainer.json (rule table 4.3)', () => {
  it.each<[string, Partial<ComposeAccessInput>, HostAccessReport]>([
    ['runServices of the model', { runServices: ['db'] }, NONE],
    // `app` is then a side service, which may not mount the parent of the repository.
    [
      'a dev service that is not in the model',
      { devService: 'web' },
      {
        hostAccess: ['service app: bind mount /workspaces → /workspaces (the workspace volume, which holds the GitHub token)'],
        unsupported: ['service web (not in the Docker Compose configuration)'],
      },
    ],
    ['runServices that are not in the model', { runServices: ['db', 'cache', 3] }, U('runServices "cache" (not in the Docker Compose configuration)', 'runServices 3 (not in the Docker Compose configuration)')],
    ['runServices that are no list', { runServices: 'db' }, U('runServices "db"')],
  ])('%s', (_name, overrides, expected) => {
    expect(composeAccessReport(input(overrides))).toEqual(expected);
  });

  it('lists each item once, and splits access and unsupported settings', () => {
    const base = model();
    base.services.db = { ...base.services.db, privileged: true, restart: 'always', cap_add: ['NET_ADMIN', 'NET_ADMIN'] };
    expect(composeAccessReport(input({ model: base }))).toEqual({
      hostAccess: ['service db: privileged mode', 'service db: capability NET_ADMIN'],
      unsupported: ['service db: restart always'],
    });
  });

  it.each<[string, Record<string, unknown>, HostAccessReport]>([
    ['OCI Features', { features: { 'ghcr.io/devcontainers/features/node:1': {} } }, NONE],
    ['a local Feature', { features: { './local-feature': {}, '../shared': {} } }, U('local Feature ./local-feature in a Docker Compose configuration', 'local Feature ../shared in a Docker Compose configuration')],
    ['no Features', {}, NONE],
  ])('composeConfigurationReport: %s', (_name, config, expected) => {
    expect(composeConfigurationReport(config)).toEqual(expected);
  });

  it('names the properties that the CLI ignores for Compose (D-18)', () => {
    expect(composeIgnoredProperties({ runArgs: [], appPort: 3000, workspaceMount: 'x', build: { options: [] }, image: 'x' })).toEqual([
      'runArgs',
      'appPort',
      'workspaceMount',
      'build.options',
    ]);
    expect(composeIgnoredProperties({ dockerComposeFile: 'x', service: 'app' })).toEqual([]);
  });
});

describe('durationSeconds', () => {
  it.each<[unknown, number | undefined]>([
    ['20s', 20],
    ['1m30s', 90],
    ['1h', 3600],
    ['500ms', 0.5],
    ['1.5s', 1.5],
    [10, 10],
    ['10', undefined],
    ['soon', undefined],
    [undefined, undefined],
  ])('%j → %s', (value, seconds) => {
    expect(durationSeconds(value)).toBe(seconds);
  });
});
