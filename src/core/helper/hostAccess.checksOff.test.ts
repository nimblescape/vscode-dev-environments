// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The switch of the host access checks (concept section 9 "Host access", user request 2026-09-26): every item that the
// policy refuses, with its class. `computer`: lifted while the checks are off for the repository. `protected` and
// `unsupported`: refused whatever the switch says (account separation, the identity of the owner account, the integrity
// of the extension, items whose class is not clear, and options that the policy does not support).
import { describe, expect, it } from 'vitest';
import { CONTAINER_CONFIG_UNKNOWN_LABEL, CONTAINER_VERSION_LABEL, HOST_ACCESS_UNRESTRICTED_LABEL } from '../names';
import { GITHUB_CLI_ACCOUNT_REASON } from './containerGit';
import { buildOverrideConfig } from './devcontainerCli';
import {
  hostAccessClassification,
  hostAccessProblems,
  hostAccessReport,
  overrideRunArgs,
  runArgsProblems,
  type HostAccessClass,
  type HostAccessInput,
} from './hostAccess';

const OWN = 'devenv-acme-api-3f2a9c1e';
const ENVIRONMENT = { id: 'e0000001-0000-4000-8000-000000000001', ownerId: '1001' };

/** Input with a repository configuration (and more parts of the input). */
function input(config: Record<string, unknown>, more: Partial<HostAccessInput> = {}): HostAccessInput {
  return { config, ownVolume: OWN, environment: ENVIRONMENT, ...more };
}

const mount = (spec: unknown): Record<string, unknown> => ({ mounts: [spec] });
const run = (...runArgs: string[]): Record<string, unknown> => ({ runArgs });
const build = (...options: string[]): Record<string, unknown> => ({ build: { options } });

// Each row: what the configuration has, the item, and its class. Every rule of hostAccess.ts that refuses something.
const TABLE: Array<[string, HostAccessInput, string, HostAccessClass]> = [
  // Files of the computer.
  ['a bind mount in mounts', input(mount('source=/Users/x,target=/x,type=bind')), 'bind mount /Users/x', 'computer'],
  ['a bind mount of the Docker socket', input(mount('source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind')), 'bind mount /var/run/docker.sock', 'computer'],
  ['a bind mount of ${localWorkspaceFolder}', input(mount('source=${localWorkspaceFolder}/.cache,target=/c,type=bind')), 'bind mount ${localWorkspaceFolder}/.cache', 'computer'],
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
  ['--volumes-from', input(run('--volumes-from', 'db')), '--volumes-from=db', 'computer'],
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
  ['build --build-context with a folder', input(build('--build-context', 'src=../other')), 'build option --build-context=src=../other', 'computer'],

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

describe('the override configuration with the checks off', () => {
  it('keeps the address of published ports in runArgs', () => {
    const runArgs = ['-p', '8080:80', '--publish=9000', '--name', 'x', '-it'];
    expect(overrideRunArgs(runArgs)).toEqual(['-p', '127.0.0.1:8080:80', '--publish=127.0.0.1::9000']);
    expect(overrideRunArgs(runArgs, false)).toEqual(['-p', '8080:80', '--publish=9000']);
  });

  it('adds the label devenv.host-access=unrestricted and keeps appPort as the configuration writes it', () => {
    const common = { environmentImage: 'devenv-3f2a9c1e:1', volumeName: OWN, repositoryName: 'api', containerName: OWN, runArgs: ['-p', '80'] };
    const on = buildOverrideConfig({ ...common, appPort: [3000, '0.0.0.0:5000:5000'] as Array<number | string> });
    expect(on.runArgs).toEqual(['-p', '127.0.0.1::80', '--label', CONTAINER_VERSION_LABEL, '--name', OWN]);
    const off = buildOverrideConfig({ ...common, appPort: [3000, '5000:5000'], hostAccessChecks: 'off' });
    expect(off.runArgs).toEqual(['-p', '80', '--label', CONTAINER_VERSION_LABEL, '--label', HOST_ACCESS_UNRESTRICTED_LABEL, '--name', OWN]);
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
