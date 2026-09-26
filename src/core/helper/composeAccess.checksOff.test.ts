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
import { composeAccessClassification, composeAccessReport, composeMissingBuildPaths, type ComposeAccessInput } from './composeAccess';
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
  // Review round 1, S1: the paths of the build, which BuildKit reads in the workspace helper (with the cache volume, the
  // folder with the token, and the Docker socket), also through a link.
  ['a build context that links to the cache volume', input(service('db', { build: { context: `${REPO}/ctx` } }), { realPaths: { [`${REPO}/ctx`]: '/devenv-cache', [`${REPO}/ctx/Dockerfile`]: '/devenv-cache/Dockerfile' } }), `service db: build context ${REPO}/ctx (a link to /devenv-cache, outside of the repository)`, 'protected'],
  ['a build context that links to the folder with the token', input(service('db', { build: { context: `${REPO}/.devcontainer/ctx` } }), { realPaths: { [`${REPO}/.devcontainer/ctx`]: '/workspaces/.devenv+' } }), `service db: build context ${REPO}/.devcontainer/ctx (a link to /workspaces/.devenv+, outside of the repository)`, 'protected'],
  ['a build context that does not exist', input(service('db', { build: { context: `${REPO}/gone` } }), { realPaths: { [`${REPO}/gone`]: null } }), `service db: build context ${REPO}/gone (the path does not exist in the repository)`, 'protected'],
  ['a Dockerfile that links out of the repository', input(service('db', { build: { context: REPO, dockerfile: 'x.Dockerfile' } }), { realPaths: { [REPO]: REPO, [`${REPO}/x.Dockerfile`]: '/root/Dockerfile' } }), 'service db: Dockerfile x.Dockerfile (a link to /root/Dockerfile, outside of the repository)', 'protected'],
  ['the cache volume as build context', input(service('db', { build: { context: '/devenv-cache' } })), 'service db: build context /devenv-cache', 'protected'],
  ['the folder with the token as build context', input(service('db', { build: { context: '/workspaces/.devenv+' } })), 'service db: build context /workspaces/.devenv+', 'protected'],
  ['the parent of the repository as build context', input(service('db', { build: { context: '/workspaces' } })), 'service db: build context /workspaces', 'protected'],
  ['the root as build context', input(service('db', { build: { context: '/' } })), 'service db: build context /', 'protected'],
  ['the folder of the Docker socket as build context', input(service('db', { build: { context: '/var/run' } })), 'service db: build context /var/run', 'protected'],
  ['a context outside that links to the cache volume', input(service('db', { build: { context: '/opt/ctx' } }), { realPaths: { '/opt/ctx': '/devenv-cache/x' } }), 'service db: build context /opt/ctx', 'protected'],
  ['a Dockerfile in the cache volume', input(service('db', { build: { context: REPO, dockerfile: '/devenv-cache/Dockerfile' } })), 'service db: Dockerfile /devenv-cache/Dockerfile', 'protected'],
  ['a local build whose Dockerfile could not be read', input(service('db', { build: { context: REPO } }), { dockerfiles: {} }), `service db: Dockerfile ${REPO}/Dockerfile (it could not be read, so its images cannot be checked)`, 'unsupported'],
  // Review round 1, S4: images of other environments, however they are written, and image IDs.
  ['the image of another environment with index.docker.io', input(service('db', { image: 'index.docker.io/library/devenv-11111111:3' })), 'service db: image index.docker.io/library/devenv-11111111:3 of another environment', 'protected'],
  ['the image of another environment with registry-1.docker.io', input(service('db', { image: 'registry-1.docker.io/devenv-11111111-db@sha256:' + 'a'.repeat(64) })), `service db: image registry-1.docker.io/devenv-11111111-db@sha256:${'a'.repeat(64)} of another environment`, 'protected'],
  ['an image ID', input(service('db', { image: `sha256:${'b'.repeat(64)}` })), `service db: image sha256:${'b'.repeat(64)} (an image ID; name the image)`, 'unsupported'],
  // Review round 2 (S2-05): changed row, a short prefix of an ID may be a name (the pipeline asks Docker); 64 hexadecimal
  // characters are an ID by their form.
  ['a long image ID', input(service('db', { image: 'b'.repeat(64) })), `service db: image ${'b'.repeat(64)} (an image ID; name the image)`, 'unsupported'],
  ['FROM the image of another environment', input(service('db', { build: { context: REPO } }), { dockerfiles: { db: 'FROM docker.io/devenv-11111111:2 AS base\nFROM base\n' } }), 'service db: FROM image docker.io/devenv-11111111:2 of another environment', 'protected'],
  ['FROM the image of another environment through a build argument', input(service('db', { build: { context: REPO, args: { BASE: 'devenv-11111111:2' } } }), { dockerfiles: { db: 'ARG BASE=alpine\nFROM $BASE\n' } }), 'service db: FROM image devenv-11111111:2 of another environment', 'protected'],
  ['FROM the image of another environment in dockerfile_inline', input(service('db', { build: { context: REPO, dockerfile_inline: 'FROM devenv-11111111:2' } }), { dockerfiles: { db: 'FROM devenv-11111111:2' } }), 'service db: FROM image devenv-11111111:2 of another environment', 'protected'],
  ['an additional context of the image of another environment', input(service('db', { build: { context: REPO, additional_contexts: { base: 'docker-image://devenv-11111111:2' } } })), 'service db: build additional_contexts base image devenv-11111111:2 of another environment', 'protected'],
  // Review round 2 (S2-02): every image that a Dockerfile names, also with a variable that is not resolved.
  ['COPY --from the image of another environment', input(service('db', { build: { context: REPO } }), { dockerfiles: { db: 'FROM alpine\nCOPY --from=devenv-11111111:2 /a /a\n' } }), 'service db: COPY --from image devenv-11111111:2 of another environment', 'protected'],
  ['RUN --mount from the image of another environment', input(service('db', { build: { context: REPO } }), { dockerfiles: { db: 'FROM alpine\nRUN --mount=type=bind,from=docker.io/devenv-11111111,target=/a true\n' } }), 'service db: RUN --mount image docker.io/devenv-11111111 of another environment', 'protected'],
  ['the syntax directive with the image of another environment', input(service('db', { build: { context: REPO } }), { dockerfiles: { db: '# syntax=devenv-11111111:1\nFROM alpine\n' } }), 'service db: syntax image devenv-11111111:1 of another environment', 'protected'],
  ['FROM another environment with a variable that is not resolved', input(service('db', { build: { context: REPO } }), { dockerfiles: { db: 'FROM devenv-11111111${TARGETVARIANT}\n' } }), 'service db: FROM image devenv-11111111${TARGETVARIANT} of another environment (a variable that is not resolved)', 'protected'],
  ['COPY --from another environment in dockerfile_inline', input(service('db', { build: { context: REPO, dockerfile_inline: 'x' } }), { dockerfiles: { db: 'FROM alpine\nCOPY --from=devenv-11111111 /a /a' } }), 'service db: COPY --from image devenv-11111111 of another environment', 'protected'],
  // Review round 2 (S2-03): the files and folders that the build client reads in the workspace helper.
  ['an additional context in the cache volume', input(service('db', { build: { context: REPO, additional_contexts: { x: '/devenv-cache' } } })), 'service db: build additional_contexts x=/devenv-cache', 'protected'],
  ['an additional context that links to the folder with the token', input(service('db', { build: { context: REPO, additional_contexts: { x: `${REPO}/ctx` } } }), { realPaths: { [`${REPO}/ctx`]: '/workspaces/.devenv+' } }), `service db: build additional_contexts x=${REPO}/ctx (a link to /workspaces/.devenv+, outside of the repository)`, 'protected'],
  ['a relative additional context', input(service('db', { build: { context: REPO, additional_contexts: { x: '../other' } } })), 'service db: build additional_contexts x=../other (a relative path)', 'protected'],
  ['an OCI layout in the cache volume', input(service('db', { build: { context: REPO, additional_contexts: { x: 'oci-layout:///devenv-cache/l:1' } } })), 'service db: build additional_contexts x=oci-layout:///devenv-cache/l:1', 'protected'],
  ['an additional context of the computer', input(service('db', { build: { context: REPO, additional_contexts: { x: '/opt/ctx' } } })), 'service db: build additional_contexts x=/opt/ctx', 'computer'],
  ['an SSH key in the cache volume', input(service('db', { build: { context: REPO, ssh: ['deploy=/devenv-cache/id'] } })), 'service db: build ssh deploy=/devenv-cache/id', 'protected'],
  ['an SSH key that links out of the repository', input(service('db', { build: { context: REPO, ssh: [{ id: 'deploy', path: `${REPO}/key` }] } }), { realPaths: { [`${REPO}/key`]: '/workspaces/.devenv+/token' } }), `service db: build ssh deploy=${REPO}/key (a link to /workspaces/.devenv+/token, outside of the repository)`, 'protected'],
  ['the file of a build secret that links out of the repository', input((m) => { m.services.db = { ...m.services.db, build: { context: REPO, secrets: [{ source: 'npm', target: 'npm' }] } }; m.secrets = { npm: { file: `${REPO}/npmrc` } }; }, { realPaths: { [`${REPO}/npmrc`]: '/devenv-cache/npmrc' } }), `service db: build secret npm file ${REPO}/npmrc (a link to /devenv-cache/npmrc, outside of the repository)`, 'protected'],
  ['the file of a build secret in the cache volume', input((m) => { m.services.db = { ...m.services.db, build: { context: REPO, secrets: ['npm'] } }; m.secrets = { npm: { file: '/devenv-cache/npmrc' } }; }), 'service db: build secret npm file /devenv-cache/npmrc', 'protected'],
  ['build ssh (the agent)', input(service('db', { build: { context: REPO, ssh: ['default'] } })), 'service db: build ssh', 'computer'],
  // Review round 1, S2: a network of another environment under a name of its own, found by its labels or containers.
  ['a named network of another project', input((m) => (m.networks = { backend: { name: 'backend' } }), { networks: { backend: { labels: { 'com.docker.compose.project': 'devenv-11111111' }, environments: [] } } }), 'network backend of another environment', 'protected'],
  ['an external network with a container of another environment', input((m) => (m.networks = { shared: { name: 'shared', external: true } }), { networks: { shared: { labels: {}, environments: ['11111111-0000-4000-8000-000000000000'] } } }), 'network shared of another environment', 'protected'],
  ['network_mode of a network of another project', input(service('db', { network_mode: 'backend' }), { networks: { backend: { labels: { 'com.docker.compose.project': 'devenv-11111111' }, environments: [] } } }), 'service db: network backend of another environment', 'protected'],
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

  it('allows the build paths and networks of the environment itself (review round 1, S1, S2)', () => {
    const checked = input(
      (m) => {
        m.services.db = { build: { context: `${REPO}/db`, dockerfile: 'Dockerfile', additional_contexts: { base: 'docker-image://postgres:16' } } };
        m.networks = { default: { name: `${PROJECT}_default` }, backend: { name: 'backend' } };
      },
      {
        realPaths: { [`${REPO}/db`]: `${REPO}/db`, [`${REPO}/db/Dockerfile`]: `${REPO}/db/Dockerfile` },
        dockerfiles: { db: 'FROM postgres:16\n' },
        networks: {
          [`${PROJECT}_default`]: { labels: { 'com.docker.compose.project': PROJECT }, environments: [ID] },
          backend: { labels: {}, environments: [] },
        },
      },
    );
    expect(composeAccessReport(checked)).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('lifts a build context outside the repository that is no path of the workspace helper (review round 1, S1)', () => {
    const checked = input(service('db', { build: { context: '/opt/tool' } }), { realPaths: { '/opt/tool': '/opt/tool' }, dockerfiles: { db: 'FROM alpine:3.22\n' } });
    expect(composeAccessClassification(checked)).toEqual([{ item: 'service db: build context /opt/tool', class: 'computer' }]);
    expect(composeAccessReport(checked, false)).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('allows the template model with the checks off as with them on', () => {
    const checked = input(() => undefined);
    expect(composeAccessReport(checked, false)).toEqual({ hostAccess: [], unsupported: [] });
    expect(composeAccessClassification(checked)).toEqual([]);
  });
});

describe('review round 3 of unit 6 (S3-1, P3-1)', () => {
  const classes = (checked: ComposeAccessInput) => composeAccessClassification(checked).map((finding) => `${finding.class}: ${finding.item}`);
  const built = (context: string, more: Record<string, unknown> = {}) => service('db', { image: undefined, build: { context, dockerfile_inline: 'FROM alpine', ...more } });

  it('refuses the folders of the kernel whatever the switch says (S3-1)', () => {
    expect(classes(input(built('/proc/self/root/devenv-cache')))).toEqual(['protected: service db: build context /proc/self/root/devenv-cache']);
    expect(classes(input(built(REPO, { additional_contexts: { x: '/proc/self/root/devenv-cache' } })))).toEqual([
      'protected: service db: build additional_contexts x=/proc/self/root/devenv-cache',
    ]);
  });

  it('refuses a path outside of the repository whose real path is not known whatever the switch says (S3-1)', () => {
    const checked = input(built('/opt/ctx'), { realPaths: { '/opt/ctx': null } });
    expect(classes(checked)).toEqual(['protected: service db: build context /opt/ctx (the path does not exist)']);
    expect(composeAccessReport(checked, false).hostAccess).toEqual(['service db: build context /opt/ctx (the path does not exist)']);
    // With a real path, as before: access to the computer.
    expect(classes(input(built('/opt/ctx'), { realPaths: { '/opt/ctx': '/opt/ctx' } }))).toEqual(['computer: service db: build context /opt/ctx']);
  });

  it('leaves a missing build context or Dockerfile of the repository to composeMissingBuildPaths, not to the policy (P3-1)', () => {
    const context = `${REPO}/db`;
    const missingContext = input(service('db', { image: undefined, build: { context } }), { realPaths: { [context]: null, [`${context}/Dockerfile`]: null }, missing: [context, `${context}/Dockerfile`], dockerfiles: {} });
    expect(composeAccessReport(missingContext)).toEqual({ hostAccess: [], unsupported: [] });
    expect(composeMissingBuildPaths(missingContext)).toEqual([`service db: build context ${context}`]);
    const missingDockerfile = input(service('db', { image: undefined, build: { context: REPO, dockerfile: 'db.Dockerfile' } }), {
      realPaths: { [REPO]: REPO, [`${REPO}/db.Dockerfile`]: null },
      missing: [`${REPO}/db.Dockerfile`],
      dockerfiles: {},
    });
    expect(composeAccessReport(missingDockerfile)).toEqual({ hostAccess: [], unsupported: [] });
    expect(composeMissingBuildPaths(missingDockerfile)).toEqual([`service db: Dockerfile ${REPO}/db.Dockerfile`]);
    // A link that leads nowhere (not in `missing`) stays refused.
    const dangling = { ...missingDockerfile, missing: [] };
    expect(classes(dangling)).toEqual(['protected: service db: Dockerfile db.Dockerfile (the path does not exist in the repository)']);
    expect(composeMissingBuildPaths(dangling)).toEqual([]);
    // A path outside of the repository never counts as missing.
    expect(composeMissingBuildPaths(input(built('/opt/ctx'), { missing: ['/opt/ctx'] }))).toEqual([]);
  });
});
