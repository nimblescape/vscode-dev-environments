// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The switch of the host access checks (concept section 9 "Host access", user request 2026-09-26): every item that the
// policy refuses, with its class. `computer`: lifted while the checks are off for the repository. `protected` and
// `unsupported`: refused whatever the switch says (account separation, the identity of the owner account, the integrity
// of the extension, items whose class is not clear, and options that the policy does not support).
import { describe, expect, it } from 'vitest';
import { MAX_DOCKERFILE_LENGTH } from '../imageCheck/dockerfile';
import { CONTAINER_CONFIG_UNKNOWN_LABEL, CONTAINER_VERSION_LABEL, HOST_ACCESS_UNRESTRICTED_LABEL } from '../names';
import { runAnalysisJob } from './configurationAnalysis';
import { GITHUB_CLI_ACCOUNT_REASON } from './containerGit';
import { buildOverrideConfig } from './devcontainerCli';
import {
  hostAccessClassification,
  hostAccessProblems,
  hostAccessReport,
  overrideRunArgs,
  runArgsProblems,
  singleImageReferences,
  type HostAccessClass,
  type HostAccessInput,
} from './hostAccess';

const OWN = 'devenv-acme-api-3f2a9c1e';
const ENVIRONMENT = { id: 'e0000001-0000-4000-8000-000000000001', ownerId: '1001' };

/** Input with a repository configuration (and more parts of the input). */
function input(config: Record<string, unknown>, more: Partial<HostAccessInput> = {}): HostAccessInput {
  return { config, ownVolume: OWN, environment: ENVIRONMENT, ...more };
}

/** The folders of a single container's configuration `.devcontainer/devcontainer.json` in the repository `api`. */
const HELPER_PATHS: Partial<HostAccessInput> = { configFolder: '/workspaces/api/.devcontainer', repositoryFolder: '/workspaces/api' };

const mount = (spec: unknown): Record<string, unknown> => ({ mounts: [spec] });
const run = (...runArgs: string[]): Record<string, unknown> => ({ runArgs });
const build = (...options: string[]): Record<string, unknown> => ({ build: { options } });

/**
 * Dockerfile refusals removed (user decision 2026-09-27): a single container that builds `text` as its Dockerfile,
 * analysed as the pipeline analyses it (runAnalysisJob): the report of the host access policy, the image references for
 * the question of image IDs, and the references of the update check (the FROM images).
 */
function single(text: string, buildMore: Record<string, unknown> = {}, checksOn = true) {
  const config = { build: { dockerfile: 'Dockerfile', ...buildMore } };
  return runAnalysisJob({ kind: 'single', input: input(config, HELPER_PATHS), checksOn, config, dockerfileText: text });
}
const ALLOWED = { hostAccess: [], unsupported: [] };

/** Dockerfile refusals removed (user decision 2026-09-27): `text` is allowed, with the checks on and off. */
function expectAllowed(text: string, buildMore: Record<string, unknown> = {}): void {
  expect(single(text, buildMore).report).toEqual(ALLOWED);
  expect(single(text, buildMore, false).report).toEqual(ALLOWED);
}

// Each row: what the configuration has, the item, and its class. Every rule of hostAccess.ts that refuses something.
const TABLE: Array<[string, HostAccessInput, string, HostAccessClass]> = [
  // Files of the computer.
  ['a bind mount in mounts', input(mount('source=/Users/x,target=/x,type=bind')), 'bind mount /Users/x', 'computer'],
  ['a bind mount of the Docker socket', input(mount('source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind')), 'bind mount /var/run/docker.sock', 'computer'],
  // hotfix review 1, N1: read-configuration returns ${localWorkspaceFolder} resolved (the repository folder in the
  // helper); a variable left in a mount, also a bind mount, is not supported.
  ['a bind mount of ${localWorkspaceFolder}', input(mount('source=/workspaces/api/.cache,target=/c,type=bind')), 'bind mount /workspaces/api/.cache', 'computer'],
  [
    'a bind mount with ${localWorkspaceFolder} left',
    input(mount('source=${localWorkspaceFolder}/.cache,target=/c,type=bind')),
    'mount "source=${localWorkspaceFolder}/.cache,target=/c,type=bind" uses ${localWorkspaceFolder}, which cannot be checked',
    'unsupported',
  ],
  ['a bind mount in the object form', input(mount({ source: '/Users/x', target: '/x', type: 'bind' })), 'bind mount /Users/x', 'computer'],
  ['a path as the source of a volume', input(mount('source=/Users/x,target=/x,type=volume')), 'bind mount /Users/x', 'computer'],
  ['a bind mount without a source', input(mount('type=bind,target=/x')), 'bind mount', 'computer'],
  ['a named pipe of the computer', input(mount('type=npipe,source=\\\\.\\pipe\\docker_engine,target=/p')), 'mount of the type npipe', 'computer'],
  ['-v with a path', input(run('-v', '/Users/x:/x')), 'bind mount /Users/x', 'computer'],
  ['--mount with a bind mount', input(run('--mount', 'type=bind,src=/etc,dst=/host-etc')), 'bind mount /etc', 'computer'],
  ['a Feature that mounts the Docker socket (merged configuration)', { ownVolume: OWN, merged: mount({ source: '/var/run/docker.sock', target: '/d', type: 'bind' }) }, 'bind mount /var/run/docker.sock', 'computer'],
  ['a base image that mounts a folder (image metadata)', { ownVolume: OWN, metadata: [mount('source=/opt,target=/opt,type=bind')] }, 'bind mount /opt', 'computer'],
  // Volume drivers and their options: a "volume" that can be a folder of the computer.
  ['volume-driver', input(mount('type=volume,source=v,target=/x,volume-driver=local')), 'volume options of the mount v', 'computer'],
  ['volume-opt', input(mount('type=volume,source=v,target=/x,volume-opt=type=none,volume-opt=device=/Users/x')), 'volume options of the mount v', 'computer'],
  ['volumeDriver in the object form', input(mount({ type: 'volume', source: 'v', target: '/x', volumeDriver: 'local' })), 'volume options of the mount v', 'computer'],
  ['--volume-driver', input(run('--volume-driver', 'nfs')), '--volume-driver=nfs', 'computer'],
  // Volumes of other programs.
  ['a volume of Docker Compose', input(mount('source=db,target=/db'), { volumeLabels: { db: { 'com.docker.compose.project': 'shop' } } }), 'volume db of the Docker Compose project shop', 'computer'],
  ['a volume of the Dev Containers extension, by its labels', input(mount('source=clone,target=/c'), { volumeLabels: { clone: { 'dev.container.volume': 'true' } } }), 'volume clone of the Dev Containers extension', 'computer'],
  ['the volume vscode of the Dev Containers extension', input(mount('source=vscode,target=/vscode,type=volume')), 'volume vscode of the Dev Containers extension', 'computer'],
  ['a volume named like an anonymous volume', input(mount(`source=${'ab'.repeat(32)},target=/x,type=volume`)), `volume ${'ab'.repeat(32)} of another container`, 'computer'],
  ['an anonymous volume of another container, by its labels', input(mount('source=anon,target=/x'), { volumeLabels: { anon: { 'com.docker.volume.anonymous': '' } } }), 'volume anon of another container', 'computer'],
  ['an existing clone volume without labels', input(mount(`source=api-${'5e'.repeat(32)},target=/x`), { volumeLabels: { [`api-${'5e'.repeat(32)}`]: {} } }), `volume api-${'5e'.repeat(32)} of another program`, 'computer'],
  // Privileges, devices, namespaces.
  ['privileged', input({ privileged: true }), 'privileged mode', 'computer'],
  ['--privileged', input(run('--privileged')), 'privileged mode', 'computer'],
  ['capAdd', input({ capAdd: ['NET_ADMIN'] }), 'capability NET_ADMIN', 'computer'],
  ['--cap-add', input(run('--cap-add', 'SYS_ADMIN')), 'capability SYS_ADMIN', 'computer'],
  ['securityOpt', input({ securityOpt: ['apparmor=unconfined'] }), 'security option apparmor=unconfined', 'computer'],
  ['--security-opt', input(run('--security-opt', 'label=disable')), 'security option label=disable', 'computer'],
  ['hostRequirements.gpu', input({ hostRequirements: { gpu: true } }), 'GPU access (hostRequirements.gpu)', 'computer'],
  ['--gpus', input(run('--gpus', 'all')), '--gpus=all', 'computer'],
  ['--device', input(run('--device', '/dev/fuse')), '--device=/dev/fuse', 'computer'],
  ['--device-cgroup-rule', input(run('--device-cgroup-rule', 'c 1:3 mr')), '--device-cgroup-rule=c 1:3 mr', 'computer'],
  ['--device-read-bps', input(run('--device-read-bps', '/dev/sda:1mb')), '--device-read-bps=/dev/sda:1mb', 'computer'],
  ['--device-write-bps', input(run('--device-write-bps', '/dev/sda:1mb')), '--device-write-bps=/dev/sda:1mb', 'computer'],
  ['--device-read-iops', input(run('--device-read-iops', '/dev/sda:10')), '--device-read-iops=/dev/sda:10', 'computer'],
  ['--device-write-iops', input(run('--device-write-iops', '/dev/sda:10')), '--device-write-iops=/dev/sda:10', 'computer'],
  ['--blkio-weight-device', input(run('--blkio-weight-device', '/dev/sda:200')), '--blkio-weight-device=/dev/sda:200', 'computer'],
  ['--runtime', input(run('--runtime', 'nvidia')), '--runtime=nvidia', 'computer'],
  ['--use-api-socket', input(run('--use-api-socket')), 'the Docker socket (--use-api-socket)', 'computer'],
  ['--cgroup-parent', input(run('--cgroup-parent', '/x')), '--cgroup-parent=/x', 'computer'],
  ['--pid', input(run('--pid', 'host')), '--pid=host', 'computer'],
  ['--ipc', input(run('--ipc', 'host')), '--ipc=host', 'computer'],
  ['--uts', input(run('--uts', 'host')), '--uts=host', 'computer'],
  ['--userns', input(run('--userns', 'host')), '--userns=host', 'computer'],
  ['--cgroupns', input(run('--cgroupns', 'host')), '--cgroupns=host', 'computer'],
  // review round 22, H22-2: changed expectation, the volumes of another container stay refused whatever the switch says.
  ['--volumes-from', input(run('--volumes-from', 'db')), '--volumes-from=db', 'protected'],
  ['--link', input(run('--link', 'db')), '--link=db', 'computer'],
  ['--network container:', input(run('--network', 'container:db')), 'network of another container (container:db)', 'computer'],
  // Ports on all addresses.
  ['-p on all addresses', input(run('-p', '0.0.0.0:80:80')), 'published port 0.0.0.0:80:80', 'computer'],
  ['-p in the long syntax', input(run('--publish', 'published=80,target=80')), 'published port published=80,target=80', 'computer'],
  ['-P', input(run('-P')), 'publishing all ports (-P)', 'computer'],
  ['--publish-all', input(run('--publish-all')), 'publishing all ports (--publish-all)', 'computer'],
  ['appPort on all addresses', input({ appPort: ['0.0.0.0:3000:3000'] }), 'published port 0.0.0.0:3000:3000', 'computer'],
  ['remote.localPortHost', input({ customizations: { vscode: { settings: { 'remote.localPortHost': 'allInterfaces' } } } }), 'setting remote.localPortHost "allInterfaces"', 'computer'],
  // Build options that reach the computer.
  ['build --secret', input(build('--secret', 'id=npm,src=/Users/x/.npmrc')), 'build option --secret', 'computer'],
  ['build --ssh', input(build('--ssh', 'default')), 'build option --ssh', 'computer'],
  ['build --allow', input(build('--allow', 'security.insecure')), 'build option --allow', 'computer'],
  ['build --output', input(build('--output', 'type=local,dest=/Users/x')), 'build option --output', 'computer'],
  ['build -o', input(build('-o', '/Users/x')), 'build option -o', 'computer'],
  // Review round 2 (S2-03 addendum): changed expectation, a relative folder is resolved in the workspace helper against a
  // working folder that the check does not know: stays refused.
  ['build --build-context with a folder', input(build('--build-context', 'src=../other')), 'build option --build-context=src=../other', 'protected'],
  ['build --build-context with a folder of the computer', input(build('--build-context', 'src=/Users/x/other')), 'build option --build-context=src=/Users/x/other', 'computer'],
  ['build --build-context with the cache volume of the helper', input(build('--build-context', 'src=/devenv-cache')), 'build option --build-context=src=/devenv-cache', 'protected'],
  ['build --build-context with the folder of the token', input(build('--build-context', 'src=/workspaces/.devenv+')), 'build option --build-context=src=/workspaces/.devenv+', 'protected'],
  ['build --build-context with an OCI layout in the cache volume', input(build('--build-context', 'src=oci-layout:///devenv-cache/x:1@sha256:' + 'a'.repeat(64))), `build option --build-context=src=oci-layout:///devenv-cache/x:1@sha256:${'a'.repeat(64)}`, 'protected'],
  ['build --build-context with an OCI layout of the computer', input(build('--build-context', 'src=oci-layout:///Users/x/layout')), 'build option --build-context=src=oci-layout:///Users/x/layout', 'computer'],

  // Account separation.
  ['the workspace volume of another environment', input(mount('source=devenv-acme-web-11111111,target=/w,type=volume')), 'volume devenv-acme-web-11111111 of another environment', 'protected'],
  ['a volume of an environment of another account (registry)', input(mount('source=data,target=/d'), { foreignVolumes: ['data'] }), 'volume data of another environment', 'protected'],
  ['a volume with the labels of another environment', input(mount('source=data,target=/d'), { volumeLabels: { data: { 'devenv.environment-id': 'other', 'devenv.owner-id': '2002' } } }), 'volume data of another environment', 'protected'],
  ['-v with the volume of another environment', input(run('-v', 'devenv-acme-web-11111111:/w')), 'volume devenv-acme-web-11111111 of another environment', 'protected'],
  ['the cache volume of the workspace helper', input(mount('source=devenv-helper-cache,target=/c,type=volume')), 'volume devenv-helper-cache of the workspace helper', 'protected'],
  ['--env-file outside the workspace volume (a file of the workspace helper)', input(run('--env-file', '/devenv-cache/x')), '--env-file=/devenv-cache/x', 'protected'],
  ['volume-label (the labels that tell the volumes of the environments apart)', input(mount('type=volume,source=v,target=/x,volume-label=devenv.environment-id=x')), 'volume options of the mount v', 'protected'],
  ['volumeLabels in the object form', input(mount({ type: 'volume', source: 'v', target: '/x', volumeLabels: {} })), 'volume options of the mount v', 'protected'],
  ['volume-driver together with volume-label', input(mount('type=volume,source=v,target=/x,volume-driver=local,volume-label=a=b')), 'volume options of the mount v', 'protected'],
  // The identity of the owner account.
  ['a variable of container-only Git in containerEnv', input({ containerEnv: { GIT_CONFIG_GLOBAL: '/x' } }), 'variable GIT_CONFIG_GLOBAL in containerEnv', 'protected'],
  ['a variable of Git in remoteEnv', input({ remoteEnv: { GIT_CONFIG_PARAMETERS: 'x' } }), 'variable GIT_CONFIG_PARAMETERS in remoteEnv', 'protected'],
  ['a variable of Git in -e', input(run('-e', 'GIT_SSH_COMMAND=ssh')), 'variable GIT_SSH_COMMAND in runArgs', 'protected'],
  ['GH_TOKEN in containerEnv', input({ containerEnv: { GH_TOKEN: 'x' } }), `variable GH_TOKEN in containerEnv (${GITHUB_CLI_ACCOUNT_REASON})`, 'protected'],
  ['GH_HOST in -e of a Feature (image metadata)', { ownVolume: OWN, metadata: [{ containerEnv: { GH_HOST: 'x' } }] }, `variable GH_HOST in containerEnv (${GITHUB_CLI_ACCOUNT_REASON})`, 'protected'],
  // The integrity of the extension.
  ['initializeCommand (it would run in the workspace helper, with the Docker socket)', input({ initializeCommand: 'docker ps' }), 'initializeCommand', 'protected'],
  // Items whose class is not clear: the safer choice.
  ['a mount that Docker would read otherwise', input(mount('type=bind,"source=/a"x,target=/b')), 'mount "type=bind,\\"source=/a\\"x,target=/b"', 'protected'],
  ['a mount of the type image', input(mount('type=image,source=alpine,target=/i')), 'mount of the type image', 'protected'],
  ['a mount of the type cluster', input(mount('type=cluster,source=v,target=/c')), 'mount of the type cluster', 'protected'],
  ['a mount of an unknown type', input(mount('type=nfs,source=v,target=/c')), 'mount of the type nfs', 'protected'],
  ['an appPort entry that is no number and no text', input({ appPort: [{ port: 80 }] }), 'published port {"port":80}', 'protected'],
  ['a negative --oom-score-adj', input(run('--oom-score-adj', '-500')), '--oom-score-adj=-500', 'protected'],
  ['--oom-kill-disable', input(run('--oom-kill-disable')), '--oom-kill-disable', 'protected'],
  ['a log driver that writes to the computer', input(run('--log-driver', 'syslog')), '--log-driver=syslog', 'protected'],

  // Options that the policy does not support.
  ['a label of Dev Environments', input(run('--label', 'devenv.environment-id=x')), 'label devenv.environment-id', 'unsupported'],
  ['another value of the label devenv.host-access', input(run('--label', 'devenv.host-access=none')), 'label devenv.host-access', 'unsupported'],
  ['an unknown flag', input(run('--pull=always')), '--pull', 'unsupported'],
  ['a stray argument', input(run('stray')), 'argument stray', 'unsupported'],
  ['a flag without its value at the end', input(run('--init', '-e')), '-e without a value', 'unsupported'],
  ['--restart always', input(run('--restart=always')), '--restart=always', 'unsupported'],
  ['--stop-timeout over 20 seconds', input(run('--stop-timeout', '60')), '--stop-timeout=60', 'unsupported'],
  ['a log option of another driver', input(run('--log-opt', 'syslog-address=tcp://x')), '--log-opt=syslog-address=tcp://x', 'unsupported'],
  ['a storage option other than size', input(run('--storage-opt', 'dm.basesize=20G')), '--storage-opt=dm.basesize=20G', 'unsupported'],
  ['a network that Docker would read otherwise', input(run('--network', 'name="a,alias=b')), 'network "name=\\"a,alias=b"', 'unsupported'],
  ['an unknown build option', input(build('--progress=plain')), 'build option --progress', 'unsupported'],

  // Review round 1 (S1 addendum): the build of a single container runs in the workspace helper; its paths there.
  ['the cache volume as build context', input({ build: { dockerfile: 'Dockerfile', context: '/devenv-cache' } }, HELPER_PATHS), 'build context /devenv-cache (a folder of the workspace helper)', 'protected'],
  ['the folder with the token as build context', input({ build: { dockerfile: 'Dockerfile', context: '../../.devenv+' } }, HELPER_PATHS), 'build context ../../.devenv+ (a folder of the workspace helper)', 'protected'],
  ['the root as build context', input({ build: { dockerfile: 'Dockerfile', context: '/' } }, HELPER_PATHS), 'build context / (a folder of the workspace helper)', 'protected'],
  ['the older property context', input({ dockerFile: 'Dockerfile', context: '/workspaces' }, HELPER_PATHS), 'build context /workspaces (a folder of the workspace helper)', 'protected'],
  ['a Dockerfile in the cache volume', input({ build: { dockerfile: '/devenv-cache/Dockerfile' } }, HELPER_PATHS), 'Dockerfile /devenv-cache/Dockerfile (a folder of the workspace helper)', 'protected'],
  // U2: a Dockerfile that is a link out of the repository (for example to the token) or could not be read.
  ['a Dockerfile that is a link out of the repository', input({ build: { dockerfile: 'Dockerfile' } }, { ...HELPER_PATHS, dockerfileUnreadable: 'Dockerfile' }), 'Dockerfile Dockerfile (the Dockerfile is a link out of the repository or could not be read)', 'protected'],
  // U1: a size limit, not a check of the content.
  ['a Dockerfile longer than MAX_DOCKERFILE_LENGTH', input({ build: { dockerfile: 'Dockerfile' } }, { ...HELPER_PATHS, dockerfileLength: MAX_DOCKERFILE_LENGTH + 1 }), `the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the Dockerfile is too large)`, 'unsupported'],
  // Review round 1 (S4): images of other environments, however they are written, and image IDs.
  ['the image of another environment', input({ image: 'devenv-11111111:2' }), 'image devenv-11111111:2 of another environment', 'protected'],
  ['the image of another environment on Docker Hub', input({ image: 'index.docker.io/library/devenv-11111111:2' }), 'image index.docker.io/library/devenv-11111111:2 of another environment', 'protected'],
  ['an image ID', input({ image: `sha256:${'c'.repeat(64)}` }), `image sha256:${'c'.repeat(64)} (an image ID; name the image)`, 'unsupported'],
  ['a build context of the image of another environment', input(build('--build-context', 'base=docker-image://docker.io/devenv-11111111:2')), 'build option --build-context image docker.io/devenv-11111111:2 of another environment', 'protected'],
  // Review round 1 (S3): the Compose network of another environment, by its name (also the long form) or its labels.
  ['the Compose network of another environment', input(run('--network', 'devenv-11111111_default')), 'network devenv-11111111_default of another environment', 'protected'],
  ['the long form of the network of another environment', input(run('--network=name=devenv-11111111_default,alias=x')), 'network devenv-11111111_default of another environment', 'protected'],
  ['a network labelled for another environment', input(run('--net', 'backend'), { networks: { backend: { labels: { 'com.docker.compose.project': 'devenv-11111111' }, environments: [] } } }), 'network backend of another environment', 'protected'],
  ['a network with a container of another environment', input(run('--network', 'shared'), { networks: { shared: { labels: {}, environments: ['e0000002-0000-4000-8000-000000000002'] } } }), 'network shared of another environment', 'protected'],
  // Review round 1 (D3): Docker Compose finds and removes containers by these labels.
  ['a label of Docker Compose', input(run('--label', 'com.docker.compose.project=devenv-e0000001')), 'label com.docker.compose.project', 'unsupported'],
];

describe('the switch of the host access checks: the class of every refused item', () => {
  it.each(TABLE)('%s', (_name, checked, item, expected) => {
    const classes = hostAccessClassification(checked).filter((finding) => finding.item === item);
    expect(classes).toEqual([{ item, class: expected }]);
    // Checks on: refused, in the list of its message.
    const on = hostAccessReport(checked);
    expect(expected === 'unsupported' ? on.unsupported : on.hostAccess).toContain(item);
    // Checks off: only the class `computer` is lifted.
    const off = hostAccessReport(checked, false);
    const offItems = [...off.hostAccess, ...off.unsupported];
    if (expected === 'computer') expect(offItems).not.toContain(item);
    else expect(expected === 'unsupported' ? off.unsupported : off.hostAccess).toContain(item);
    expect(hostAccessProblems(checked, false)).toEqual(offItems);
  });

  it('has the same items with the checks on as hostAccessProblems, in the same order', () => {
    for (const [, checked] of TABLE) {
      expect(hostAccessClassification(checked).map((finding) => finding.item)).toEqual(hostAccessProblems(checked));
    }
  });

  it('lifts everything of a configuration that only needs the computer, and nothing of the rest', () => {
    const config = {
      privileged: true,
      mounts: ['source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind', 'source=devenv-helper-cache,target=/c,type=volume'],
      runArgs: ['--gpus', 'all', '-p', '0.0.0.0:80:80', '--restart=always'],
      containerEnv: { GH_TOKEN: 'x' },
    };
    expect(hostAccessReport(input(config), false)).toEqual({
      hostAccess: ['volume devenv-helper-cache of the workspace helper', `variable GH_TOKEN in containerEnv (${GITHUB_CLI_ACCOUNT_REASON})`],
      unsupported: ['--restart=always'],
    });
    expect(hostAccessReport(input({ privileged: true, runArgs: ['--pid=host', '-P'], appPort: '0.0.0.0:1:1' }), false)).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('still checks the name of a volume whose driver options the switch lifts', () => {
    const checked = input(mount('type=volume,source=devenv-helper-cache,target=/x,volume-driver=local'));
    expect(hostAccessProblems(checked)).toEqual(['volume options of the mount devenv-helper-cache', 'volume devenv-helper-cache of the workspace helper']);
    expect(hostAccessProblems(checked, false)).toEqual(['volume devenv-helper-cache of the workspace helper']);
  });

  it('keeps an item that two rules find refused when one of them is not lifted', () => {
    // The same text from a lifted rule (volume-driver) and one that is not (volume-label), of two mounts of one volume.
    const checked = input({ mounts: ['type=volume,source=v,target=/a,volume-driver=local', 'type=volume,source=v,target=/b,volume-label=a=b'] });
    expect(hostAccessClassification(checked)).toEqual([{ item: 'volume options of the mount v', class: 'protected' }]);
    expect(hostAccessProblems(checked, false)).toEqual(['volume options of the mount v']);
  });
});

describe('review round 1: what stays allowed', () => {
  it('allows a build context and a Dockerfile in the repository, and the networks of the environment itself', () => {
    const config = { build: { dockerfile: 'Dockerfile', context: '..' }, runArgs: ['--network', 'devenv-e0000001_default', '--network', 'mine'] };
    const checked = input(config, {
      ...HELPER_PATHS,
      networks: { mine: { labels: { 'com.docker.compose.project': 'devenv-e0000001' }, environments: [ENVIRONMENT.id] } },
    });
    expect(hostAccessReport(checked)).toEqual({ hostAccess: [], unsupported: [] });
    // Dockerfile refusals removed (user decision 2026-09-27): the Dockerfile goes to the analysis job only, for the update check.
    const analysis = runAnalysisJob({ kind: 'single', input: checked, checksOn: true, config, dockerfileText: 'FROM mcr.microsoft.com/devcontainers/base:ubuntu\nFROM alpine:3.22\n' });
    expect(analysis.report).toEqual(ALLOWED);
    expect(analysis.references.images).toEqual(['mcr.microsoft.com/devcontainers/base:ubuntu', 'alpine:3.22']);
  });

  it('allows FROM the image of another environment (the Dockerfile is not checked)', () => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM image devenv-11111111:2 of another environment` (protected).
    const analysis = single('ARG B\nFROM ${B}\n', { args: { B: 'devenv-11111111:2' } });
    expect(analysis.report).toEqual(ALLOWED);
    expect(analysis.imageReferences).toEqual([]);
    expect(analysis.references.images).toEqual(['devenv-11111111:2']);
  });

  it('refuses a build context outside of the repository, also one that is no path of the workspace helper', () => {
    // Review round 3, S3-1: changed expectation (it was allowed): such a context can only be a folder of the workspace
    // helper, whose links the check does not resolve (for example /proc/self/root/devenv-cache).
    const checked = input({ build: { dockerfile: 'Dockerfile', context: '/opt/tools' } }, HELPER_PATHS);
    expect(hostAccessReport(checked)).toEqual({ hostAccess: ['build context /opt/tools (outside of the repository)'], unsupported: [] });
    expect(hostAccessReport(checked, false)).toEqual({ hostAccess: ['build context /opt/tools (outside of the repository)'], unsupported: [] });
  });
});

describe('the override configuration with the checks off', () => {
  it('keeps the address of published ports in runArgs', () => {
    const runArgs = ['-p', '8080:80', '--publish=9000', '--name', 'x', '-it'];
    expect(overrideRunArgs(runArgs)).toEqual(['-p', '127.0.0.1:8080:80', '--publish=127.0.0.1::9000']);
    expect(overrideRunArgs(runArgs, false)).toEqual(['-p', '8080:80', '--publish=9000']);
  });

  it('adds the label devenv.host-access=unrestricted and keeps appPort as the configuration writes it', () => {
    const common = { environmentImage: 'devenv-3f2a9c1e:1', volumeName: OWN, repositoryName: 'api', containerName: OWN, runArgs: ['-p', '80'] };
    const on = buildOverrideConfig({ ...common, appPort: [3000, '0.0.0.0:5000:5000'] as Array<number | string> });
    // Review round 2 (D2-1): changed expectation, the labels of Docker Compose set empty.
    const cleared = ['--label', 'com.docker.compose.project=', '--label', 'com.docker.compose.service='];
    expect(on.runArgs).toEqual(['-p', '127.0.0.1::80', '--label', CONTAINER_VERSION_LABEL, ...cleared, '--name', OWN, '--hostname', 'api']);
    const off = buildOverrideConfig({ ...common, appPort: [3000, '5000:5000'], hostAccessChecks: 'off' });
    expect(off.runArgs).toEqual(['-p', '80', '--label', CONTAINER_VERSION_LABEL, '--label', HOST_ACCESS_UNRESTRICTED_LABEL, ...cleared, '--name', OWN, '--hostname', 'api']);
    expect(off.appPort).toEqual([3000, '5000:5000']);
    expect(buildOverrideConfig({ ...common, appPort: 3000, hostAccessChecks: 'off' }).appPort).toBe(3000);
    expect(buildOverrideConfig({ ...common, hostAccessChecks: 'off' })).not.toHaveProperty('appPort');
    expect(buildOverrideConfig({ ...common, hostAccessChecks: 'on' }).runArgs).toEqual(on.runArgs);
  });

  it('accepts the labels of the override configuration with the checks on (also in the merged configuration of a container)', () => {
    const runArgs = ['--label', CONTAINER_VERSION_LABEL, '--label', CONTAINER_CONFIG_UNKNOWN_LABEL, '--label', HOST_ACCESS_UNRESTRICTED_LABEL];
    expect(runArgsProblems(runArgs, OWN)).toEqual([]);
    expect(hostAccessProblems({ ownVolume: OWN, merged: { runArgs } })).toEqual([]);
  });
});

describe('review round 3 of unit 6 (S3-1 to S3-6)', () => {
  // Dockerfile refusals removed (user decision 2026-09-27): the Dockerfile is no part of the input of the policy.
  const dockerfile = (_text: string, buildMore: Record<string, unknown> = {}): HostAccessInput =>
    input({ build: { dockerfile: 'Dockerfile', ...buildMore } }, HELPER_PATHS);
  const classes = (checked: HostAccessInput) => hostAccessClassification(checked).map((finding) => `${finding.class}: ${finding.item}`);

  it.each([
    ['/proc/self/root/devenv-cache', 'folder of the workspace helper'],
    ['/proc/self/cwd/../../devenv-cache', 'folder of the workspace helper'],
    ['/sys/fs', 'folder of the workspace helper'],
    ['/dev/fd/3', 'folder of the workspace helper'],
    ['/tmp', 'outside of the repository'],
  ])('refuses the build context %s whatever the switch says (S3-1)', (context, why) => {
    const checked = input({ build: { dockerfile: 'Dockerfile', context } }, HELPER_PATHS);
    expect(hostAccessReport(checked, false).hostAccess).toEqual([`build context ${context} (a ${why})`.replace('(a outside', '(outside')]);
  });

  it('refuses the folders of the kernel in --build-context whatever the switch says (S3-1)', () => {
    const checked = input(build('--build-context', 'x=/proc/self/root/devenv-cache'));
    expect(classes(checked)).toEqual(['protected: build option --build-context=x=/proc/self/root/devenv-cache']);
  });

  const STAGES = 'ARG BASE=alpine\nFROM ${BASE} AS a\nFROM devenv-abcd1234:2 AS b\n';
  it.each<[string, string, string[], Record<string, unknown>]>([
    ['--build-arg K=V', STAGES, ['--build-arg', 'BASE=devenv-abcd1234:1'], {}],
    ['--build-arg=K=V', STAGES, ['--build-arg=BASE=devenv-abcd1234:1'], { args: { BASE: 'alpine' } }],
    ['--target over build.target', STAGES, ['--target', 'b'], { target: 'a' }],
    ['BUILDKIT_SYNTAX of build.args', STAGES, [], { args: { BUILDKIT_SYNTAX: 'devenv-abcd1234:3' } }],
    ['BUILDKIT_SYNTAX of build.options', STAGES, ['--build-arg', 'BUILDKIT_SYNTAX=docker.io/devenv-abcd1234:3'], {}],
  ])('allows the Dockerfile with %s (S3-2)', (_name, text, options, more) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, the images of the Dockerfile were refused (protected).
    expectAllowed(text, { ...more, options });
  });

  it('still refuses --build-arg K without a value, a build option of the configuration (S3-2, S4-1)', () => {
    // Dockerfile refusals removed (user decision 2026-09-27): only the build option is refused, not `FROM devenv${BASE}`.
    expect(single('ARG BASE=alpine\nFROM devenv${BASE}\n', { args: { BASE: 'alpine' }, options: ['--build-arg', 'BASE'] }).report).toEqual({
      hostAccess: [],
      unsupported: [
        'build option --build-arg BASE without a value (the value would come from the environment of the workspace helper, or the argument would be dropped, so Dev Environments cannot check it)',
      ],
    });
  });

  it('reads the value of --build-arg K from the helper, as a variable that is not resolved (S3-2)', () => {
    // The Dockerfile would get `devenv-…` if the helper had such a variable: not refused unless the text holds devenv.
    // Review round 4, S4-1: changed expectation, --build-arg K without a value is refused as unsupported itself (buildx
    // drops it when the helper has no such variable, so the default of the ARG or build.args applies).
    expect(hostAccessReport(dockerfile('ARG BASE=alpine\nFROM ${BASE}\n', { options: ['--build-arg', 'BASE'] }))).toEqual({
      hostAccess: [],
      unsupported: [
        'build option --build-arg BASE without a value (the value would come from the environment of the workspace helper, or the argument would be dropped, so Dev Environments cannot check it)',
      ],
    });
  });

  it('reads build.args and build.options for the FROM images of the update check (S3-2)', () => {
    const text = 'ARG BASE=alpine\nFROM ${BASE}\n';
    // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM image devenv-abcd1234:1 of another environment`.
    expectAllowed(text, { args: { BASE: 'devenv-abcd1234:1' }, options: ['--build-arg', 'OTHER=1'] });
    expectAllowed(text, { args: { BASE: 'devenv-abcd1234:1' }, options: ['--build-arg', 'BASE=alpine:3.22'] });
    expect(single(text, { args: { BASE: 'alpine:3.21' } }).references.images).toEqual(['alpine:3.21']);
  });

  it('allows the images of every stage, whatever the target (S3-3)', () => {
    for (const text of ['FROM alpine AS a\nCOPY --from=b /x /y\nFROM devenv-abcd1234:1 AS b\n', 'FROM alpine AS a\nRUN --mount=from=b,target=/m ls\nFROM devenv-abcd1234:1 AS b\n']) {
      // Dockerfile refusals removed (user decision 2026-09-27): before, `FROM image devenv-abcd1234:1 of another environment`.
      expectAllowed(text, { target: 'a' });
      expect(single(text, { target: 'a' }).references.images).toEqual(['alpine']);
    }
  });

  it.each([
    'FROM devenv${TARGETVARIANT}-abcd1234:1\n',
    'FROM ${TARGETVARIANT}devenv-abcd1234:1\n',
    'FROM alpine\nCOPY --from=${NOPE}devenv-abcd1234:1 / /x\n',
    'FROM alpine\nRUN --mount=from=${NOPE}DevEnv-abcd1234:1,target=/m ls\n',
  ])('allows the unresolved reference in %j that holds devenv (S3-4)', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, refused as `… of another environment (a variable that is not resolved)`.
    expectAllowed(text);
    expect(single(text).references.images).toEqual(text.startsWith('FROM alpine') ? ['alpine'] : []);
  });

  it.each([
    'FROM alpine\nRUN --mount="from=devenv-abcd1234:1,target=/x" ls\n',
    'FROM alpine\nRUN --mount=type=bind,"from=devenv-abcd1234:1" ls\n',
    "FROM alpine\nRUN --mount='type=bind, from=devenv-abcd1234:1' ls\n",
    'FROM alpine\nRUN --network=none --mount=type=bind,from=devenv-abcd1234:1 ls\n',
    'FROM alpine\nRUN --mount=type=bind,\\"from=devenv-abcd1234:1\\" ls\n',
  ])('allows the quoted flags of %j (S3-5)', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, `RUN --mount image devenv-abcd1234:1 of another environment`.
    expectAllowed(text);
    expect(single(text).references.images).toEqual(['alpine']);
  });

  it('allows a quoted COPY --from of another environment (S3-5)', () => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, `COPY --from image devenv-abcd1234:1 of another environment`.
    expectAllowed('FROM alpine\nCOPY --from="devenv-abcd1234:1" /a /b\n');
  });

  it.each([
    [['--secret', 'id=c,src=/devenv-cache/x'], 'build option --secret id=c,src=/devenv-cache/x'],
    [['--secret', 'id=c,source=/proc/self/root/devenv-cache/x'], 'build option --secret id=c,source=/proc/self/root/devenv-cache/x'],
    [['--secret', 'id=relative'], 'build option --secret id=relative (a relative path)'],
    [['--ssh', 'k=/devenv-cache/key'], 'build option --ssh k=/devenv-cache/key'],
    [['--ssh=k=/Users/x/key,key2'], 'build option --ssh k=/Users/x/key,key2 (a relative path)'],
    [['--output', 'type=local,dest=/devenv-cache/poison'], 'build option --output type=local,dest=/devenv-cache/poison'],
    [['-o', '/workspaces/.devenv+'], 'build option -o /workspaces/.devenv+'],
    [['-o', 'out'], 'build option -o out (a relative path)'],
  ])('refuses the files of %j in the workspace helper whatever the switch says (S3-6)', (options, item) => {
    const report = hostAccessReport(input(build(...options)), false);
    expect(report.hostAccess).toEqual([item]);
  });

  it('leaves the other files of --secret, --ssh, and --output to the switch (S3-6)', () => {
    for (const options of [['--secret', 'id=npm,src=/Users/x/.npmrc'], ['--secret', 'id=t,env=TOKEN'], ['--ssh', 'default'], ['--output', 'type=local,dest=/Users/x'], ['-o', '-']]) {
      expect(hostAccessReport(input(build(...options)), false)).toEqual({ hostAccess: [], unsupported: [] });
      expect(hostAccessReport(input(build(...options))).hostAccess).toHaveLength(1);
    }
  });
});

describe('review round 4 of unit 6 (S4-1 to S4-6)', () => {
  // Dockerfile refusals removed (user decision 2026-09-27): the Dockerfile is no part of the input of the policy.
  const dockerfile = (_text: string, buildMore: Record<string, unknown> = {}): HostAccessInput =>
    input({ build: { dockerfile: 'Dockerfile', ...buildMore } }, HELPER_PATHS);
  const classes = (checked: HostAccessInput) => hostAccessClassification(checked).map((finding) => `${finding.class}: ${finding.item}`);
  const WITHOUT_VALUE = (name: string) =>
    `unsupported: build option --build-arg ${name} without a value (the value would come from the environment of the workspace helper, or the argument would be dropped, so Dev Environments cannot check it)`;

  it.each([
    [['--build-arg', 'BASE']],
    [['--build-arg=BASE']],
  ])('refuses --build-arg without a value in %j, whatever the switch says (S4-1)', (options) => {
    // buildx drops the argument when the helper has no variable BASE: the default of the ARG (devenv-…) applies.
    const checked = dockerfile('ARG BASE=devenv-abcd1234:1\nFROM $BASE\n', { args: { BASE: 'alpine' }, options });
    expect(classes(checked)).toContain(WITHOUT_VALUE('BASE'));
    expect(hostAccessReport(checked, false).unsupported).toContain(WITHOUT_VALUE('BASE').replace('unsupported: ', ''));
  });

  it('allows --build-arg with a value, also an empty one (S4-1)', () => {
    expect(hostAccessReport(dockerfile('ARG BASE=alpine\nFROM $BASE\n', { options: ['--build-arg', 'BASE=', '--build-arg=X=1'] }))).toEqual({
      hostAccess: [],
      unsupported: [],
    });
  });

  it.each(['x://../../../../devenv-cache', 'a://../../../../workspaces/.devenv+'])(
    'resolves the URL-like build context %s as a path, as the CLI does (S4-2)',
    (context) => {
      expect(classes(input({ build: { dockerfile: 'Dockerfile', context } }, HELPER_PATHS))).toEqual([`protected: build context ${context} (a folder of the workspace helper)`]);
    },
  );

  it('resolves a URL-like Dockerfile as a path, as the CLI does (S4-2)', () => {
    expect(classes(input({ build: { dockerfile: 'x://../../../../devenv-cache/Dockerfile' } }, HELPER_PATHS))).toEqual([
      'protected: Dockerfile x://../../../../devenv-cache/Dockerfile (a folder of the workspace helper)',
    ]);
  });

  it('allows a URL-like build context that resolves into the repository (S4-2)', () => {
    expect(classes(input({ build: { dockerfile: 'Dockerfile', context: 'x://..' } }, HELPER_PATHS))).toEqual([]);
  });

  it.each([
    'ARG A=devenv-abcd1234:1x\nFROM ${A%x}\n',
    'ARG A=devenv-abcd1234:1xyx\nFROM ${A%%x*}\n',
    'ARG A=xdevenv-abcd1234:1\nFROM ${A#x}\n',
    'ARG A=a/b/devenv-abcd1234:1\nFROM ${A##*/}\n',
    'ARG A=zzzenv-abcd1234:1\nFROM ${A/zzz/dev}\n',
    'ARG A=zenv-abcd1234:1\nFROM ${A//z/dev}\n',
    'ARG A=devenv-abcd1234:1?\nFROM ${A%\\?}\n',
    'FROM alpine\nARG A=devenv-abcd1234:1x\nCOPY --from=${A%x} / /x\n',
    'FROM alpine\nARG A=devenv-abcd1234:1x\nRUN --mount=from=${A%x},target=/x ls\n',
    'FROM alpine\nENV A=devenv-abcd1234:1x\nCOPY --from=${A%?} / /x\n',
    'ARG A=devenv-abcd1234:1x\nARG B=${A%x}\nFROM $B\n',
    'ARG A=devenv-abcd1234:1[x]\nFROM ${A%[x]}\n',
    'ARG A=devenv-abcd1234:1x\nFROM ${A%[x]}\n',
  ])('allows the pattern operator in %j, and the update check skips it (S4-3)', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, evaluated and refused as `… of another environment`.
    expectAllowed(text);
    expect(single(text).references.images).toEqual(text.startsWith('FROM alpine') ? ['alpine'] : []);
  });

  it('allows a pattern operator that gives another image, and the update check skips it (S4-3)', () => {
    for (const text of ['ARG V=3.22.1\nFROM alpine:${V%.*}\n', 'ARG A=devenv-abcd1234:1\nFROM ${A#devenv-abcd1234:1}alpine\n', 'ARG A=abcd1234:1\nFROM ${A#abcd1234:1}alpine\n']) {
      expectAllowed(text);
      // Dockerfile refusals removed (user decision 2026-09-27): the pattern forms are not evaluated.
      expect(single(text).references.images).toEqual([]);
    }
  });

  it.each([
    'FROM alpine:${TARGETARCH%64}\n',
    'FROM alpine\nCOPY --from=${NOPE#x} / /x\n',
    'ARG A=devenv-abcd1234:1\nFROM ${A:1:3}\n',
    'FROM alpine\nARG A=devenv-abcd1234:1x\nCOPY --from=${A%${NOPE}} / /x\n',
    'ARG A=devenv-abcd1234:1x\nARG B=${A/x}\nFROM $B\n',
    'ARG A=alpine\nFROM ${A:1:3}\n',
    'ARG A=alpine\nFROM ${A/p/\\$0}\n',
    'ARG A=alpine\nFROM ${A%\\x}\n',
  ])('allows the form in %j that cannot be evaluated (S4-3)', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, refused as protected or unsupported ("uses a variable form …").
    expectAllowed(text);
    expect(single(text).references.images).toEqual(text.startsWith('FROM alpine\n') ? ['alpine'] : []);
  });

  it('gives the image ID check no references of the Dockerfile (S4-3, S2-05)', () => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, `[{ reference: 'abcdef12', what: 'FROM image' }]`.
    expect(singleImageReferences({ build: { dockerfile: 'Dockerfile' } })).toEqual([]);
    expect(single('ARG A=abcdef12x\nFROM ${A%x}\nFROM abcdef12\n').imageReferences).toEqual([]);
  });

  it.each([
    'docker/dockerfile:1',
    'docker/dockerfile:1.7-labs',
    'docker/dockerfile-upstream:master',
    'docker.io/docker/dockerfile:1',
    'index.docker.io/docker/dockerfile',
    'registry-1.docker.io/docker/dockerfile-upstream:1-labs',
    `docker/dockerfile:1@sha256:${'a'.repeat(64)}`,
    `docker/dockerfile@sha256:${'a'.repeat(64)}`,
  ])('allows the official frontend %s (S4-4)', (frontend) => {
    expectAllowed(`# syntax=${frontend}\nFROM alpine\n`);
    expectAllowed('FROM alpine\n', { args: { BUILDKIT_SYNTAX: frontend } });
  });

  it.each([
    'docker.io/attacker/frontend:1',
    'ghcr.io/docker/dockerfile:1',
    'docker.io/library/docker/dockerfile:1',
    'docker/dockerfile-evil:1',
    'dockerfile:1',
    'localhost:5000/docker/dockerfile:1',
  ])('allows the frontend %s (S4-4)', (frontend) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, `syntax image … (only the official Dockerfile frontends … may build)` (protected).
    expectAllowed(`# syntax=${frontend}\nFROM alpine\n`);
    expectAllowed('FROM alpine\n', { options: ['--build-arg', `BUILDKIT_SYNTAX=${frontend}`] });
    expect(single(`# syntax=${frontend}\nFROM alpine\n`).references.images).toEqual(['alpine']);
  });

  it.each([
    [['--output', '/devenv-cache/a=b'], 'build option --output /devenv-cache/a=b'],
    [['-o', '/devenv-cache/a=b/../x'], 'build option -o /devenv-cache/a=b/../x'],
    [['--output=out=1'], 'build option --output out=1 (a relative path)'],
  ])('reads %j as buildx does: one field without type= is the destination (S4-5)', (options, item) => {
    expect(hostAccessReport(input(build(...options)), false).hostAccess).toEqual([item]);
  });

  it('reads dest= of an --output with type= (S4-5)', () => {
    expect(hostAccessReport(input(build('--output', 'type=local,dest=/devenv-cache/x')), false).hostAccess).toEqual(['build option --output type=local,dest=/devenv-cache/x']);
    expect(hostAccessReport(input(build('--output', 'type=local,dest=/Users/x/out')), false)).toEqual({ hostAccess: [], unsupported: [] });
  });

  it.each([
    'FROM ghcr.io/example/devenv-base:${TARGETARCH}\n',
    'FROM --platform=$BUILDPLATFORM ghcr.io/cachix/devenv:v1-$TARGETARCH\n',
    'FROM localhost:5000/devenv-tools:${TARGETARCH}\n',
    'FROM registry.example.com:443/team/devenv${TARGETVARIANT}\n',
  ])('allows the registry image in %j (S4-6)', (text) => {
    expectAllowed(text);
  });

  it.each([
    'FROM docker.io/example/devenv-base:${TARGETARCH}\n',
    'FROM index.docker.io/x/devenv${TARGETVARIANT}\n',
    'FROM example/devenv-base:${TARGETARCH}\n',
    'FROM localhost/devenv-base:${TARGETARCH}\n',
    'FROM ${TARGETVARIANT}ghcr.io/devenv-abcd1234:1\n',
    'FROM ghcr.io${TARGETVARIANT}/devenv-abcd1234:1\n',
  ])('allows %j, and the update check reads it with a platform build argument (S4-6)', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, refused as `… of another environment (a variable that is not resolved)`.
    expectAllowed(text);
    expect(single(text).references.images).toEqual([]);
    expect(single(text, { args: { TARGETARCH: 'amd64', TARGETVARIANT: '' } }).references.images).toHaveLength(1);
  });
});

describe('the label devenv.config-path (review round 4, D4-2)', () => {
  it('allows the label of the override configuration with a configuration path', () => {
    for (const configPath of ['.devcontainer/devcontainer.json', '.devcontainer.json', '.devcontainer/python/devcontainer.json']) {
      const runArgs = buildOverrideConfig({ environmentImage: 'img', volumeName: OWN, repositoryName: 'api', containerName: OWN, configPath }).runArgs as string[];
      expect(runArgs).toEqual(expect.arrayContaining(['--label', `devenv.config-path=${configPath}`]));
      expect(hostAccessProblems({ config: { runArgs }, ownVolume: OWN, overrideConfiguration: true })).toEqual([]);
    }
  });

  it('refuses the label in the runArgs of the repository, and another value in the override configuration', () => {
    expect(hostAccessProblems(input(run('--label', 'devenv.config-path=.devcontainer/devcontainer.json')))).toEqual(['label devenv.config-path']);
    expect(hostAccessProblems({ config: { runArgs: ['--label', 'devenv.config-path=../x/devcontainer.json'] }, ownVolume: OWN, overrideConfiguration: true })).toEqual([
      'label devenv.config-path',
    ]);
  });
});

describe('review round 5 of unit 6 (S5-1 to S5-3, P5-2, D5-2)', () => {
  // Dockerfile refusals removed (user decision 2026-09-27): the Dockerfile is no part of the input of the policy.
  const dockerfile = (_text: string, buildMore: Record<string, unknown> = {}): HostAccessInput =>
    input({ build: { dockerfile: 'Dockerfile', ...buildMore } }, HELPER_PATHS);
  const classes = (checked: HostAccessInput) => hostAccessClassification(checked).map((finding) => `${finding.class}: ${finding.item}`);

  it.each([
    // A positional parameter, a special parameter, and a name of Unicode letters: not set, so empty, as in BuildKit.
    ['FROM dev$1env-abcd1234:1\n', ['devenv-abcd1234:1']],
    ['FROM dev$12env-abcd1234:1\n', ['devenv-abcd1234:1']],
    ['FROM dev$@env-abcd1234:1\n', ['devenv-abcd1234:1']],
    ['FROM dev$$env-abcd1234:1\n', ['devenv-abcd1234:1']],
    ['FROM dev${1}env-abcd1234:1\n', ['devenv-abcd1234:1']],
    ['FROM dev$é\\env-abcd1234:1\n', ['devenv-abcd1234:1']],
    ['ARG é=devenv-abcd1234:1\nFROM $é\n', ['devenv-abcd1234:1']],
    ['FROM alpine\nCOPY --from=dev$1env-abcd1234:1 / /x\n', ['alpine']],
    ['FROM alpine\nCOPY --from=dev$@env-abcd1234:1 / /x\n', ['alpine']],
    ['FROM alpine\nENV X=dev$é\\env-abcd1234:1\nCOPY --from=$X / /x\n', ['alpine']],
    ['FROM alpine\nENV X=dev$1"e"nv-abcd1234:1\nCOPY --from=$X / /x\n', ['alpine']],
    // A platform ARG that is not resolved: the update check skips the reference.
    ['FROM dev${TARGETVARIANT}env-abcd1234:1\n', []],
    ['FROM dev$TARGETVARIANT\\env-abcd1234:1\n', []],
    ['FROM dev${TARGETVARIANT:+x}env-abcd1234:1\n', []],
    ['FROM ${TARGETVARIANT:-dev}env-abcd1234:1\n', []],
    ['FROM ${TARGETVARIANT+d${TARGETARCH}ev}env-abcd1234:1\n', []],
    ['FROM ${TARGETVARIANT}sha256:0123abcd\n', []],
    ['FROM ${TARGETVARIANT}0123abcd\n', []],
    ['FROM alpine\nCOPY --from=${TARGETARCH:+0123}abcd / /x\n', ['alpine']],
  ])('allows %j, and reads its variables as BuildKit does for the update check (S5-1)', (text, images) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, refused (protected) as an image of another environment or an image ID.
    expectAllowed(text);
    expect(single(text).references.images).toEqual(images);
  });

  it('expands a name of Unicode letters that is not set to the empty text, as BuildKit does (S5-1)', () => {
    // Dockerfile refusals removed (user decision 2026-09-27): the FROM images are references of the update check only,
    // not of the question of image IDs (before: `[{ reference: 'dev-abcd1234:1', what: 'FROM image' }]`).
    expect(single('FROM dev$éenv-abcd1234:1\n').references.images).toEqual(['dev-abcd1234:1']);
    expect(single('FROM dev$éenv-abcd1234:1\n').imageReferences).toEqual([]);
    // A pattern form is not evaluated (before: `aline`).
    expect(single('ARG A=alpine\nFROM ${A/p/$0}\n').references.images).toEqual([]);
  });

  it.each([
    'FROM alpine:${TARGETARCH}\n',
    'FROM node:20-${TARGETARCH}${TARGETVARIANT}\n',
    'FROM alpine\nCOPY --from=build-${TARGETARCH} / /x\n',
    'FROM ${TARGETVARIANT:-alpine}\n',
    // `$éenv` is one name: `dev-abcd1234:1` when it is empty.
    'FROM alpine\nCOPY --from=dev$éenv-abcd1234:1 / /x\n',
  ])('allows the reference with a variable that is not resolved in %j (S5-1)', (text) => {
    expectAllowed(text);
  });

  it.each([
    ['ARG A=alpine\nFROM $A\n', { A: ['devenv-abcd1234:1'] }, ['alpine']],
    ['ARG A=alpine\nFROM $A\n', { A: ['devenv-abcd1234:1', 'x'] }, ['alpine']],
    ['ARG A\nFROM ${A:+devenv-abcd1234:1}\n', { A: null }, []],
    ['ARG A\nFROM ${A:+devenv-abcd1234:1}\n', { A: 1 }, ['devenv-abcd1234:1']],
    ['ARG A\nFROM ${A:+devenv-abcd1234:1}\n', { A: false }, ['devenv-abcd1234:1']],
    ['FROM alpine\n', { BUILDKIT_SYNTAX: ['evil/fe'] }, ['alpine']],
    ['FROM alpine\n', { BUILDKIT_SYNTAX: null }, ['alpine']],
  ])('allows the value of build.args in %j: %j (S5-2)', (text, args, images) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, refused (protected) as an image of another environment or a frontend.
    expectAllowed(text, { args });
    // The update check takes the build arguments that are texts, numbers, or booleans (buildArgumentTexts).
    expect(single(text, { args }).references.images).toEqual(images);
  });

  it('refuses an object as the value of a build argument (S5-2)', () => {
    const checked = dockerfile('ARG A\nFROM alpine\n', { args: { A: { x: 1 } } });
    expect(classes(checked)).toEqual(['unsupported: build.args A (an object; the value of a build argument is a text)']);
    expect(hostAccessReport(checked, false).unsupported).toEqual(['build.args A (an object; the value of a build argument is a text)']);
  });

  it.each([
    ['#!/bin/sh\n# syntax=FRONTEND\nFROM alpine\n'],
    ['﻿#!/usr/bin/env buildctl\n# syntax=FRONTEND\nFROM alpine\n'],
    ['// syntax=FRONTEND\nFROM alpine\n'],
    ['#!/bin/sh\n// escape=\\\n// syntax=FRONTEND\nFROM alpine\n'],
    ['{"syntax":"FRONTEND"}\n'],
    ['#!/bin/sh\n{"syntax": "FRONTEND", "x": "\\nFROM alpine"}\n'],
  ])('allows any frontend in %j (S5-3)', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, `syntax image evil/frontend:1 (only the official …)` (protected).
    expectAllowed(text.replace('FRONTEND', 'evil/frontend:1'));
    expectAllowed(text.replace('FRONTEND', 'docker/dockerfile:1'));
  });

  it('allows a frontend up to its first space and after it (P5-2)', () => {
    expectAllowed('# syntax=docker/dockerfile:1 # comment\nFROM alpine\n');
    expectAllowed('# syntax = docker/dockerfile:1.7-labs  x\nFROM alpine\n');
    expectAllowed('FROM alpine\n', { args: { BUILDKIT_SYNTAX: ' docker/dockerfile:1 x' } });
    expectAllowed('FROM alpine\n', { options: ['--build-arg', 'BUILDKIT_SYNTAX=docker/dockerfile:1 x'] });
    // Dockerfile refusals removed (user decision 2026-09-27): before, `syntax image evil/frontend:1 (only the official …)` (protected).
    expectAllowed('# syntax=evil/frontend:1 docker/dockerfile:1\nFROM alpine\n');
    expectAllowed('FROM alpine\n', { args: { BUILDKIT_SYNTAX: 'evil/frontend:1 docker/dockerfile:1' } });
  });

  it('allows the label devenv.config-path of the override configuration for a folder that the discovery finds (D5-2)', () => {
    for (const configPath of ['.devcontainer/a\\b/devcontainer.json', '.devcontainer/ /devcontainer.json', '.devcontainer/my config/devcontainer.json']) {
      const runArgs = buildOverrideConfig({ environmentImage: 'img', volumeName: OWN, repositoryName: 'api', containerName: OWN, configPath }).runArgs as string[];
      expect(runArgs).toEqual(expect.arrayContaining(['--label', `devenv.config-path=${configPath}`]));
      expect(hostAccessProblems({ config: { runArgs }, ownVolume: OWN, overrideConfiguration: true })).toEqual([]);
    }
  });

  it('adds no label devenv.config-path for a path that is no configuration path of the discovery (D5-2)', () => {
    for (const configPath of ['.devcontainer/a/b/devcontainer.json', '.devcontainer/../devcontainer.json', '.devcontainer//devcontainer.json', '../x/devcontainer.json']) {
      const runArgs = buildOverrideConfig({ environmentImage: 'img', volumeName: OWN, repositoryName: 'api', containerName: OWN, configPath }).runArgs as string[];
      expect(runArgs.some((arg) => arg.startsWith('devenv.config-path'))).toBe(false);
      expect(hostAccessProblems({ config: { runArgs }, ownVolume: OWN, overrideConfiguration: true })).toEqual([]);
    }
  });
});

describe('review round 6 of unit 6 (S6-1, P6-2)', () => {
  const VARIANTS8 = Array.from({ length: 8 }, (_, i) => `\${X${i}:-${'abcdefgh'[i]}}`).join('');
  const timed = <T,>(run: () => T): { result: T; ms: number } => {
    const start = Date.now();
    const result = run();
    return { result, ms: Date.now() - start };
  };

  it('allows a COPY --from reference with 8 variables and 4000 characters, quickly (S6-1)', () => {
    const { result, ms } = timed(() => single(`FROM alpine\nCOPY --from=${VARIANTS8}${'a'.repeat(4000)} / /\n`, {}, false));
    // Dockerfile refusals removed (user decision 2026-09-27): before, `COPY --from image … (the image reference is too long)`.
    expect(result.report).toEqual(ALLOWED);
    expect(result.references.images).toEqual(['alpine']);
    expect(ms).toBeLessThan(1000);
  });

  it('skips a FROM value longer than 1024 characters for the update check, and still refuses such an image of the configuration (S6-1)', () => {
    const long = `\${A:-${'a'.repeat(1100)}}`;
    // Dockerfile refusals removed (user decision 2026-09-27): before, `… image … (the image reference is too long)` for each.
    for (const text of [`ARG A=alpine\nFROM ${long}\n`, `FROM alpine\nARG A=x\nCOPY --from=${long} / /\n`, `FROM alpine\nARG A=x\nRUN --mount=type=bind,from=${long},target=/x true\n`]) {
      expectAllowed(text);
    }
    expect(single(`FROM ${'a'.repeat(1100)}\nFROM b\n`).references.images).toEqual(['b']);
    // The image of the configuration is still checked.
    const image = `alpine:${'1'.repeat(1100)}`;
    expect(hostAccessReport(input({ image }), false)).toEqual({ hostAccess: [], unsupported: [`image ${image.slice(0, 64)}… (the image reference is too long)`] });
    // 1024 characters are still read.
    const tag = '1'.repeat(1024 - 'alpine:'.length);
    expect(single(`FROM alpine:${tag}\n`).references.images).toEqual([`alpine:${tag}`]);
  });

  it.each([
    ['resolved', 'ARG A\nFROM NEST\n'],
    ['not resolved', 'FROM NEST\n'],
    ['in an ARG', 'ARG A\nARG B=NEST\nFROM alpine:$B\n'],
  ])('allows a nesting of ${…} deeper than 32 levels (%s), without an exception (S6-1)', (_, template) => {
    const nest = (levels: number, name: string) => `\${${name}:-`.repeat(levels) + 'x' + '}'.repeat(levels);
    const name = template.startsWith('FROM') ? 'TARGETARCH' : 'A';
    for (const levels of [33, 5000]) {
      const text = template.replace('NEST', nest(levels, name));
      const { result, ms } = timed(() => single(text));
      // Dockerfile refusals removed (user decision 2026-09-27): before, refused as unsupported.
      expect(result.report).toEqual(ALLOWED);
      expect(result.references.images).toEqual([]);
      expect(ms).toBeLessThan(1000);
    }
    // 32 levels are evaluated.
    expectAllowed(template.replace('NEST', nest(32, name)));
  });

  it('allows ARGs that double their value, without an exception (S6-1)', () => {
    for (const n of [20, 26, 40]) {
      const text =
        'ARG A0=abcdefgh\n' +
        Array.from({ length: n }, (_, i) => `ARG A${i + 1}=\${A${i}}\${A${i}}`).join('\n') +
        `\nFROM alpine:\${A${n}}\nARG A${n}\nCOPY --from=x\${A${n}}\${TARGETARCH} / /\n`;
      const { result, ms } = timed(() => single(text));
      // Dockerfile refusals removed (user decision 2026-09-27): before, two items `… (the image reference is too long)`.
      expect(result.report).toEqual(ALLOWED);
      expect(result.references.images).toEqual([]);
      expect(ms).toBeLessThan(1000);
    }
  });

  it.each([
    'FROM node:20 AS deps\nFROM node:20\nCOPY --from=${STAGE:-0} /a /b\n',
    'FROM node:20 AS deps\nFROM node:20\nRUN --mount=type=bind,from=${STAGE:-1},target=/x true\n',
    'FROM alpine AS cafe\nFROM ${TARGETVARIANT}cafe\n',
    'FROM alpine AS b1\nFROM b${TARGETVARIANT}1\n',
    'FROM alpine AS cafe\nFROM alpine\nCOPY --from=${STAGE:-CAFE} / /x\n',
  ])('allows a variant that names a stage or a stage index in %j (P6-2)', (text) => {
    expectAllowed(text);
  });

  it.each([
    'FROM ${TARGETVARIANT}cafe\nFROM alpine AS cafe\n',
    'FROM ${TARGETVARIANT:-0}\n',
    'FROM alpine AS cafe\nFROM alpine\nCOPY --from=${STAGE:+be}cafe / /x\n',
  ])('allows %j (P6-2)', (text) => {
    // Dockerfile refusals removed (user decision 2026-09-27): before, `… (with its variables that are not resolved, it can name an image of another environment or an image ID)` (protected).
    expectAllowed(text);
  });
});
