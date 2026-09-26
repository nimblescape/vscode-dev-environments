// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  CONTAINER_CONFIG_UNKNOWN_LABEL,
  CONTAINER_VERSION_LABEL,
  ENVIRONMENT_VOLUME_PATTERN,
  HELPER_CACHE_VOLUME,
  newEnvironmentId,
  resourceName,
} from '../names';
import { containerEnvironment, devContainersSettings, remoteEnvironment } from './containerGit';
import { buildOverrideConfig } from './devcontainerCli';
import {
  MAX_STOP_TIMEOUT_SECONDS,
  buildOptionProblems,
  hostAccessProblems,
  hostAccessReport,
  isLoopbackAddress,
  isOwnVolume,
  loopbackAppPorts,
  loopbackRunArgs,
  mountedVolumeNames,
  overrideRunArgs,
  removedRunArgs,
  runArgsProblems,
  splitPortAddress,
  withLoopbackAddress,
  withoutNameArgs,
  type HostAccessReport,
} from './hostAccess';

const OWN = 'devenv-acme-api-3f2a9c1e';

/** Problems of a repository configuration alone. */
function configProblems(config: Record<string, unknown>): string[] {
  return hostAccessProblems({ config, ownVolume: OWN });
}

describe('host access policy: mounts (concept section 9 "Host access")', () => {
  it.each<[string, unknown, string[]]>([
    ['a named volume', 'source=cache,target=/cache,type=volume', []],
    ['a named volume without type', 'source=cache,target=/cache', []],
    ['an anonymous volume', 'target=/cache,type=volume', []],
    ['a tmpfs', 'type=tmpfs,target=/tmp/x', []],
    ['the own workspace volume', `source=${OWN},target=/other,type=volume`, []],
    ['a volume with ${devcontainerId} (not resolved before the first up)', 'source=${devcontainerId}-history,target=/h,type=volume', []],
    ['a bind mount', 'source=/Users/x/.ssh,target=/root/.ssh,type=bind', ['bind mount /Users/x/.ssh']],
    ['a bind mount with src and upper case type', 'type=BIND,src=/Users/x,dst=/x', ['bind mount /Users/x']],
    ['a path without type', 'source=/var/run/docker.sock,target=/var/run/docker.sock', ['bind mount /var/run/docker.sock']],
    ['a relative path without type', 'source=./data,target=/data', ['bind mount ./data']],
    ['a home path without type', 'source=~/x,target=/x', ['bind mount ~/x']],
    ['a Windows path without type', 'source=C:\\Users\\x,target=/x', ['bind mount C:\\Users\\x']],
    ['a path as the source of a volume', 'source=/Users/x,target=/x,type=volume', ['bind mount /Users/x']],
    ['a quoted source with a comma', 'type=bind,"source=/Users/a,b",target=/x', ['bind mount /Users/a,b']],
    ['a volume of another environment', 'source=devenv-acme-web-11111111,target=/x,type=volume', ['volume devenv-acme-web-11111111 of another environment']],
    // Volumes of the repository whose name starts with `devenv-`, for example `${localWorkspaceFolderBasename}-node_modules`
    // of a repository devenv-tools: not named like the workspace volume of an environment.
    ['a volume of the repository that starts with devenv-', 'source=devenv-tools-node_modules,target=/x,type=volume', []],
    ['an object volume of the repository that starts with devenv-', { type: 'volume', source: 'devenv-home', target: '/h' }, []],
    ['the cache volume of the workspace helper', 'source=devenv-helper-cache,target=/x,type=volume', ['volume devenv-helper-cache of the workspace helper']],
    // The Dev Containers extension keeps VS Code Server for its dev containers in `vscode`, and clones repositories into
    // volumes named with a hash.
    ['the cache volume of the Dev Containers extension', 'source=vscode,target=/vscode,type=volume', ['volume vscode of the Dev Containers extension']],
    ['the cache volume of the Dev Containers extension as an object', { type: 'volume', source: 'vscode', target: '/v' }, ['volume vscode of the Dev Containers extension']],
    // A name that ends in a hash is decided by the volume, when it exists (see "volumes named like a clone volume").
    ['a name like a clone volume of the Dev Containers extension (SHA-256) that does not exist', `source=api-${'5e'.repeat(32)},target=/x,type=volume`, []],
    ['a name like a clone volume of the Dev Containers extension (MD5) that does not exist', `source=vsc-api-${'0f'.repeat(16)},target=/x`, []],
    ['the proposed name of a named clone volume of the Dev Containers extension', 'source=vsc-remote-containers,target=/x,type=volume', ['volume vsc-remote-containers of the Dev Containers extension']],
    ['volumes whose names only look similar', 'source=vscode-extensions,target=/x,type=volume', []],
    ['a hash of another length (SHA-1)', `source=api-${'a'.repeat(40)},target=/x,type=volume`, []],
    ['a hash in upper case', `source=api-${'A'.repeat(32)},target=/x,type=volume`, []],
    // An anonymous volume of another container, named by Docker (older Docker versions do not label it).
    ['a volume named like an anonymous volume', `source=${'ab'.repeat(32)},target=/x,type=volume`, [`volume ${'ab'.repeat(32)} of another container`]],
    ['a volume with driver options (a folder of the computer)', 'type=volume,source=v,target=/x,volume-opt=type=none,volume-opt=device=/Users/x', ['volume options of the mount v']],
    ['a volume with a driver', 'type=volume,source=v,target=/x,volume-driver=local', ['volume options of the mount v']],
    // Labels on a volume that the mount creates: the labels by which the extension restores environments after a lost registry.
    ['a volume with labels', 'type=volume,source=myvol,target=/x,volume-label=devenv.environment-id=x,volume-label=devenv.owner-id=2', ['volume options of the mount myvol']],
    ['a volume with a label in upper case', 'type=volume,source=v,target=/x,Volume-Label=a=b', ['volume options of the mount v']],
    ['the documented volume options without access to the computer', 'type=volume,source=v,target=/x,volume-nocopy,volume-subpath=sub', []],
    ['an object whose target adds a volume label', { type: 'volume', source: 'v', target: '/x,volume-label=devenv.environment-id=x' }, ['volume options of the mount v']],
    ['an object with volume labels', { source: 'v', target: '/x', type: 'volume', volumeLabels: { a: 'b' } }, ['volume options of the mount v']],
    ['a named pipe', 'type=npipe,source=\\\\.\\pipe\\docker_engine,target=/p', ['mount of the type npipe']],
    ['an object bind mount (a Feature: docker-outside-of-docker)', { source: '/var/run/docker.sock', target: '/var/run/docker-host.sock', type: 'bind' }, ['bind mount /var/run/docker.sock']],
    ['an object volume (a Feature: docker-in-docker)', { source: 'dind-var-lib-docker-x', target: '/var/lib/docker', type: 'volume' }, []],
    ['an object without type and a path', { source: '/Users/x', target: '/x' }, ['bind mount /Users/x']],
    ['an object with volume options', { source: 'v', target: '/x', type: 'volume', volumeOptions: {} }, ['volume options of the mount v']],
    ['an invalid entry', 42, ['mount of the type unknown']],
    // The CLI gives Docker an object as `type=…,src=…,dst=…` without quotes: a comma in a value adds fields.
    ['an object whose target adds a bind mount', { type: 'volume', source: 'v', target: '/x,type=bind,src=/' }, ['bind mount /']],
    ['an object whose source adds a bind mount', { type: 'volume', source: 'v,type=bind,source=.', target: '/x' }, ['bind mount .']],
    // Docker reads only the first line: the fields after a line break would be checked, but not used.
    ['a line break', 'type=bind,source=/,target=/host\n,type=volume,source=v', ['mount "type=bind,source=/,target=/host\\n,type=volume,source=v"']],
    ['a quote inside a field (Docker refuses it)', 'type=volume,source=v"x,type=bind', ['mount "type=volume,source=v\\"x,type=bind"']],
    ['a quoted field with an escaped quote', 'type=volume,"source=a""b",target=/x', []],
  ])('%s', (_name, mount, expected) => {
    expect(configProblems({ mounts: [mount] })).toEqual(expected);
  });
});

describe('host access policy: runArgs', () => {
  it.each<[string, string[], string[]]>([
    ['the network, also host', ['--network', 'host', '--net=bridge', '--network=corp'], []],
    [
      'the network of another container',
      ['--network', 'container:devenv-acme-web-11111111', '--net=container:db'],
      ['network of another container (container:devenv-acme-web-11111111)', 'network of another container (container:db)'],
    ],
    ['--mount with a line break', ['--mount', 'type=bind,src=/,dst=/host\n,type=volume,src=v'], ['mount "type=bind,src=/,dst=/host\\n,type=volume,src=v"']],
    ['DNS and hosts', ['--add-host', 'host.docker.internal:host-gateway', '--dns=1.1.1.1', '--dns-search', 'corp', '--dns-option=ndots:1'], []],
    [
      'each known DNS, memory, and health check flag, with its value next or after =',
      [
        '--dns', '1.1.1.1', '--dns=8.8.8.8', '--dns-option', 'ndots:2', '--dns-option=timeout:1', '--dns-opt', 'rotate', '--dns-opt=attempts:2',
        '--dns-search', 'corp', '--dns-search=example.com',
        '--memory', '4g', '--memory=2g', '--memory-reservation', '1g', '--memory-reservation=512m', '--memory-swap', '5g', '--memory-swap=-1',
        '--memory-swappiness', '10', '--memory-swappiness=0',
        '--health-cmd', 'true', '--health-cmd=true', '--health-interval', '30s', '--health-interval=10s', '--health-retries', '3', '--health-retries=5',
        '--health-start-period', '5s', '--health-start-period=1s', '--health-start-interval', '1s', '--health-start-interval=2s',
        '--health-timeout', '2s', '--health-timeout=3s', '--no-healthcheck',
      ],
      [],
    ],
    // An unknown flag that starts like a known one does not take the next argument as its value: `--privileged` is seen.
    ['an unknown flag that starts like --dns', ['--dns-foo', '--privileged'], ['--dns-foo', 'privileged mode']],
    ['unknown flags that start like --memory and --health-', ['--memory-foo', '-v', '/:/host', '--health-foo=1', '--healthcheck'], ['--memory-foo', 'bind mount /', '--health-foo', '--healthcheck']],
    ['a value of a known flag that looks like a flag stays its value', ['--dns-search', '--privileged'], []],
    ['init, labels, hostname, name', ['--init', '--label', 'a=b', '-l', 'c=d', '--hostname', 'h', '-h', 'h2', '--name', 'x'], []],
    ['environment variables', ['--env', 'A=1', '-e', 'B=2', '-eC=3', '-e=D=4', '--env-file', '/workspaces/api/.env'], []],
    ['limits', ['--shm-size=1g', '--ulimit', 'nofile=1024', '--memory', '4g', '-m', '2g', '--memory-swap=5g', '--cpus', '2'], []],
    ['user and working folder', ['--user', 'node', '-u', '1000', '--workdir', '/w', '-w', '/x'], []],
    ['SYS_PTRACE and seccomp=unconfined', ['--cap-add=SYS_PTRACE', '--cap-add', 'CAP_SYS_PTRACE', '--security-opt', 'seccomp=unconfined', '--security-opt=seccomp:unconfined'], []],
    ['ports on localhost or without address', ['-p', '127.0.0.1:8080:80', '--publish=8081:81', '-p3000', '-p', '[::1]:9000:90', '-p', ':7000:70'], []],
    ['a named volume', ['-v', 'cache:/cache', '--volume=other:/o:ro', '-v', '/anonymous', '--mount', 'type=tmpfs,target=/t'], []],
    ['privileged mode', ['--privileged'], ['privileged mode']],
    ['privileged mode with a value', ['--privileged=true'], ['privileged mode']],
    ['a bind mount with -v', ['-v', '/Users/x/project:/src'], ['bind mount /Users/x/project']],
    ['a bind mount with --volume=', ['--volume=/var/run/docker.sock:/var/run/docker.sock'], ['bind mount /var/run/docker.sock']],
    ['a bind mount with -v and a relative path', ['-v', './data:/data'], ['bind mount ./data']],
    ['a bind mount with a Windows path', ['-v', 'C:\\data:/data'], ['bind mount C:\\data']],
    ['a volume of another environment with -v', ['-v', 'devenv-acme-web-11111111:/x'], ['volume devenv-acme-web-11111111 of another environment']],
    ['--mount with type=bind', ['--mount', 'type=bind,source=/etc,target=/host-etc'], ['bind mount /etc']],
    ['--mount= with a volume of the helper', ['--mount=type=volume,source=devenv-helper-cache,target=/c'], ['volume devenv-helper-cache of the workspace helper']],
    ['devices and GPUs', ['--device', '/dev/fuse', '--device-cgroup-rule=c 1:* rwm', '--gpus', 'all'], ['--device=/dev/fuse', '--device-cgroup-rule=c 1:* rwm', '--gpus=all']],
    ['namespaces of the computer', ['--pid=host', '--ipc', 'host', '--uts=host', '--userns=host', '--cgroupns=host'], ['--pid=host', '--ipc=host', '--uts=host', '--userns=host', '--cgroupns=host']],
    ['another namespace mode is not known to be safe', ['--ipc=private'], ['--ipc=private']],
    ['volumes of another container', ['--volumes-from', 'other'], ['--volumes-from=other']],
    ['other capabilities', ['--cap-add', 'NET_ADMIN', '--cap-add=ALL'], ['capability NET_ADMIN', 'capability ALL']],
    ['other security options', ['--security-opt', 'apparmor=unconfined', '--security-opt=label=disable'], ['security option apparmor=unconfined', 'security option label=disable']],
    ['a port on all addresses', ['-p', '0.0.0.0:8080:80'], ['published port 0.0.0.0:8080:80']],
    ['a port on a LAN address', ['--publish=192.168.1.5:8080:80'], ['published port 192.168.1.5:8080:80']],
    ['a port on all IPv6 addresses', ['-p', '[::]:8080:80'], ['published port [::]:8080:80']],
    // Docker's long syntax has no address: Docker publishes it on all addresses, also with 127.0.0.1:: in front of it.
    ['a port in the long syntax', ['-p', 'published=8080,target=80'], ['published port published=8080,target=80']],
    ['a port in the long syntax after an unknown key', ['-p', 'x=y,published=8080,target=80'], ['published port x=y,published=8080,target=80']],
    ['a port in the long syntax with --publish=', ['--publish=published=9090,target=90'], ['published port published=9090,target=90']],
    ['a port in the long syntax attached to -p', ['-ppublished=8080,target=80'], ['published port published=8080,target=80']],
    ['-v with a volume named like an anonymous volume', ['-v', `${'cd'.repeat(32)}:/x`], [`volume ${'cd'.repeat(32)} of another container`]],
    ['--mount with volume labels', ['--mount', 'type=volume,source=myvol,target=/x,volume-label=devenv.repository=acme/api'], ['volume options of the mount myvol']],
    ['a port in the long syntax behind 127.0.0.1', ['-p', '127.0.0.1::published=8080,target=80'], ['published port 127.0.0.1::published=8080,target=80']],
    ['all ports', ['-P'], ['publishing all ports (-P)']],
    ['all ports, long form', ['--publish-all'], ['publishing all ports (--publish-all)']],
    ['the platform (as in build.options)', ['--platform', 'linux/amd64', '--init', '--platform=linux/arm64'], []],
    ['a tmpfs (as a mount of the type tmpfs)', ['--tmpfs', '/tmp', '--tmpfs=/run:rw,size=64m'], []],
    ['volumes of the repository that start with devenv-', ['-v', 'devenv-cache:/x', '--mount=type=volume,source=devenv-db-data,target=/d', '--mount', 'type=volume,src=devenv-cache,dst=/c'], []],
    ['the network of another container in upper case', ['--network=CONTAINER:db'], ['network of another container (CONTAINER:db)']],
    // Docker reads `name=…` as the long form of --network: CSV, keys and values in lower case, the last `name` wins.
    [
      'the network of another container in the long form',
      ['--network', 'name=container:db', '--network=NAME=container:web', '--net', 'alias=x,name=CONTAINER:api', '--network', '"name=container:q"', '--network', 'name=bridge,name=container:last'],
      [
        'network of another container (name=container:db)',
        'network of another container (NAME=container:web)',
        'network of another container (alias=x,name=CONTAINER:api)',
        'network of another container ("name=container:q")',
        'network of another container (name=bridge,name=container:last)',
      ],
    ],
    ['other networks in the long form', ['--network', 'name=corp,alias=api', '--network=name=host', '--network', 'name=bridge,driver-opt=com.docker.network.endpoint.ifname=eth1'], []],
    ['a long form that Docker reads otherwise (only its first line)', ['--network', 'name=bridge\nname=container:db'], ['network "name=bridge\\nname=container:db"']],
    ['flags that only take rights away', ['--cap-drop', 'ALL', '--cap-drop=NET_RAW', '--read-only', '--read-only=true', '--security-opt', 'no-new-privileges'], []],
    [
      'no-new-privileges in each spelling that Docker reads',
      ['--security-opt=no-new-privileges:true', '--security-opt', 'no-new-privileges=true', '--security-opt', 'no-new-privileges=false', '--security-opt=no-new-privileges:1'],
      [],
    ],
    ['security options that give more rights', ['--security-opt', 'no-new-privileges=maybe', '--security-opt=systempaths=unconfined', '--security-opt', 'seccomp=/p.json'], ['security option no-new-privileges=maybe', 'security option systempaths=unconfined', 'security option seccomp=/p.json']],
    [
      'limits of processes, CPUs, block I/O, and storage',
      ['--pids-limit', '100', '--cpu-shares', '512', '-c', '256', '--cpu-period=100000', '--cpu-quota', '50000', '--cpu-rt-period', '1000000', '--cpu-rt-runtime=950000', '--cpuset-cpus', '0-1', '--cpuset-mems=0', '--blkio-weight', '300', '--storage-opt', 'size=20G', '--isolation=default'],
      [],
    ],
    ['an OOM score of 0 or more', ['--oom-score-adj', '500', '--oom-score-adj=0', '--oom-score-adj', '1000'], []],
    ['a negative OOM score (other processes of the computer end first)', ['--oom-score-adj', '-500', '--oom-score-adj=-0x3e8'], ['--oom-score-adj=-500', '--oom-score-adj=-0x3e8']],
    ['groups of the user inside the container', ['--group-add', 'docker', '--group-add=1001'], []],
    [
      'the health check',
      ['--health-cmd', 'curl -f http://localhost || exit 1', '--health-interval=30s', '--health-retries', '3', '--health-start-period', '5s', '--health-start-interval=1s', '--health-timeout', '2s', '--no-healthcheck'],
      [],
    ],
    ['addresses and names in a network, and exposed ports', ['--ip', '172.30.100.104', '--ip6=2001:db8::33', '--network-alias', 'api', '--net-alias=web', '--expose', '3000', '--expose=8000-8010'], []],
    ['kernel settings of the namespaces of the container', ['--sysctl', 'net.ipv4.ip_unprivileged_port_start=0', '--sysctl=kernel.shmmax=1000000'], []],
    ['the stop of the container', ['--stop-signal', 'SIGINT', '--stop-timeout', String(MAX_STOP_TIMEOUT_SECONDS), '--stop-timeout=0'], []],
    [
      'a stop that can take longer than the Session Monitor waits',
      ['--stop-timeout', String(MAX_STOP_TIMEOUT_SECONDS + 1), '--stop-timeout=-1', '--stop-timeout', '0x10'],
      [`--stop-timeout=${MAX_STOP_TIMEOUT_SECONDS + 1}`, '--stop-timeout=-1', '--stop-timeout=0x10'],
    ],
    ['a restart after a failure', ['--restart', 'no', '--restart=on-failure', '--restart', 'on-failure:3'], []],
    ['a start together with Docker', ['--restart', 'always', '--restart=unless-stopped'], ['--restart=always', '--restart=unless-stopped']],
    [
      'logs in files of the container, or none',
      ['--log-driver', 'json-file', '--log-driver=local', '--log-driver', 'none', '--log-opt', 'max-size=10m', '--log-opt=max-file=3', '--log-opt', 'compress=true', '--log-opt', 'tag={{.Name}}', '--log-opt', 'mode=non-blocking'],
      [],
    ],
    ['log drivers that reach the computer or credentials of Docker', ['--log-driver', 'syslog', '--log-driver=journald', '--log-driver', 'awslogs'], ['--log-driver=syslog', '--log-driver=journald', '--log-driver=awslogs']],
    ['log options of other drivers', ['--log-opt', 'syslog-address=unix:///var/run/docker.sock', '--log-opt=awslogs-group=x'], ['--log-opt=syslog-address=unix:///var/run/docker.sock', '--log-opt=awslogs-group=x']],
    ['other storage options', ['--storage-opt', 'dm.basesize=20G'], ['--storage-opt=dm.basesize=20G']],
    ['flags without effect (the CLI sets its own)', ['--entrypoint', '/bin/bash', '--attach', 'STDOUT', '-a', 'STDERR', '-aSTDIN'], []],
    [
      'flags that are removed before up',
      ['--rm', '-i', '-t', '-it', '-ti', '--interactive', '--tty', '-d', '--detach', '-dit', '--rm=false', '--tty=true', '-i=false'],
      [],
    ],
    ['an environment file of the workspace volume', ['--env-file', '/workspaces/api/.env', '--env-file=/workspaces/.devenv+/env', '--env-file', '//workspaces/./api/.env'], []],
    [
      'an environment file outside the workspace volume (docker run reads it in the workspace helper)',
      ['--env-file', '/devenv-cache/x', '--env-file=/Users/x/.env', '--env-file', '.env', '--env-file', '/workspaces/api/../../devenv-cache/x', '--env-file', '/workspaces', '--env-file', '/workspacesx/a'],
      ['--env-file=/devenv-cache/x', '--env-file=/Users/x/.env', '--env-file=.env', '--env-file=/workspaces/api/../../devenv-cache/x', '--env-file=/workspaces', '--env-file=/workspacesx/a'],
    ],
    [
      'devices, runtimes, volume drivers, cgroups, and the Docker socket',
      ['--device-read-bps', '/dev/sda:1mb', '--device-write-iops=/dev/sda:10', '--blkio-weight-device', '/dev/sda:200', '--runtime', 'nvidia', '--volume-driver=local', '--use-api-socket', '--cgroup-parent', '/system.slice', '--oom-kill-disable', '--link', 'db'],
      ['--device-read-bps=/dev/sda:1mb', '--device-write-iops=/dev/sda:10', '--blkio-weight-device=/dev/sda:200', '--runtime=nvidia', '--volume-driver=local', 'the Docker socket (--use-api-socket)', '--cgroup-parent=/system.slice', '--oom-kill-disable', '--link=db'],
    ],
    ['a group of short flags with -P', ['-Pi'], ['publishing all ports (-P)']],
    ['the cache volume of the Dev Containers extension', ['-v', 'vscode:/vscode', '--mount=type=volume,src=vscode,dst=/v'], ['volume vscode of the Dev Containers extension']],
    [
      'labels of Dev Environments and of the Dev Container CLI',
      ['--label', 'devenv.environment-id=x', '-l', 'devenv.owner-id=1', '--label=devcontainer.metadata=[]', '-ldevcontainer.local_folder=/Users/x', '--label', ' DEVENV.container-config=unknown', '--label', 'devenv.container-version=2', '-l', 'devenv.helper-run'],
      ['label devenv.environment-id', 'label devenv.owner-id', 'label devcontainer.metadata', 'label devcontainer.local_folder', 'label DEVENV.container-config', 'label devenv.container-version', 'label devenv.helper-run'],
    ],
    ['the labels that the override configuration adds itself', ['--label', CONTAINER_VERSION_LABEL, '-l', CONTAINER_CONFIG_UNKNOWN_LABEL], []],
    ['other labels', ['--label', 'devenvx=1', '-l', 'devcontainer=1', '--label', 'com.example.devenv.x=1', '--label', 'devenv', '--label', 'devenv-test.run=1'], []],
    [
      'variables of container-only Git (the value of runArgs would win)',
      ['-e', 'GIT_CONFIG_GLOBAL=/tmp/x', '--env', 'GIT_CONFIG_COUNT=0', '-eGIT_CONFIG_PARAMETERS=', '-e=DOCKER_CONFIG=/tmp/docker', '--env=GIT_CONFIG_KEY_0=x', '--env', 'GIT_SSH_COMMAND=ssh', '-e', 'GIT_CONFIG_SYSTEM=/x'],
      [
        'variable GIT_CONFIG_GLOBAL in runArgs',
        'variable GIT_CONFIG_COUNT in runArgs',
        'variable GIT_CONFIG_PARAMETERS in runArgs',
        'variable DOCKER_CONFIG in runArgs',
        'variable GIT_CONFIG_KEY_0 in runArgs',
        'variable GIT_SSH_COMMAND in runArgs',
        'variable GIT_CONFIG_SYSTEM in runArgs',
      ],
    ],
    // Without a value, Docker takes the value of the workspace helper, or removes the variable of the extension.
    ['a variable of container-only Git without a value', ['-e', 'DOCKER_CONFIG', '--env', 'GIT_CONFIG_GLOBAL'], ['variable DOCKER_CONFIG in runArgs', 'variable GIT_CONFIG_GLOBAL in runArgs']],
    ['other variables', ['-e', 'GIT_AUTHOR_NAME=x', '--env', 'BROWSER=x', '-e', 'GIT_CONFIGURATION=x', '-e', 'SSH_AUTH_SOCKET=x'], []],
    // Variables of the Dev Containers extension and GnuPG: the extension leaves them to their owners and does not set them.
    ['variables that the extension does not set', ['-e', 'SSH_AUTH_SOCK=/home/me/agent.sock', '--env=REMOTE_CONTAINERS_IPC=/tmp/ipc', '-e', 'GNUPGHOME=/x'], []],
    ['flags that stay unknown', ['--mac-address', '02:42:ac:11:00:02', '--label-file=/workspaces/api/labels', '--cidfile', '/tmp/id', '--annotation', 'a=b', '--kernel-memory', '1g'], ['--mac-address', '--label-file', '--cidfile', '--annotation', '--kernel-memory']],
    // Docker would take the next argument of the extension (its --label) as the value.
    ['a flag without its value at the end', ['--init', '-e'], ['-e without a value']],
    ['a flag with a check without its value at the end', ['--network'], ['--network without a value']],
    ['--name without its value at the end (removed)', ['--init', '--name'], []],
    ['an unknown flag with =', ['--pull=always'], ['--pull']],
    ['an unknown boolean flag', ['--sig-proxy'], ['--sig-proxy']],
    ['a group of short flags with a flag that is not known', ['-itq'], ['-itq']],
    ['a group of short flags with a flag that takes a value', ['-itp8080:80'], ['-itp8080:80']],
    ['a stray argument', ['host'], ['argument host']],
    ['each item once', ['--privileged', '--privileged', '-v', '/a:/a', '-v', '/a:/b'], ['privileged mode', 'bind mount /a']],
  ])('%s', (_name, runArgs, expected) => {
    expect(runArgsProblems(runArgs, OWN)).toEqual(expected);
    expect(configProblems({ runArgs })).toEqual(expected);
  });

  it('never takes the value of a flag for a flag', () => {
    expect(runArgsProblems(['-e', '--privileged', '--label', '-v'], OWN)).toEqual([]);
  });

  it('refuses entries that are no text, which the list for Docker would not have', () => {
    for (const runArgs of [['--label', 1, '--label', '--privileged'], ['-e', 5, '-e', '--privileged']]) {
      // Without the number, `--label --label --privileged` would give Docker the flag --privileged.
      expect(hostAccessReport({ config: { runArgs }, ownVolume: OWN })).toEqual({
        hostAccess: ['privileged mode'],
        unsupported: [`argument ${runArgs[1]}`],
      });
    }
  });
});

describe('host access policy: settings that need access to the computer, and settings that are not supported', () => {
  const report = (config: Record<string, unknown>) => hostAccessReport({ config, ownVolume: OWN });

  it('reports unknown flags, options, and arguments as not supported, not as access to the computer', () => {
    expect(report({ runArgs: ['--pull=always', '--sig-proxy', '-itq', 'host'] })).toEqual({
      hostAccess: [],
      unsupported: ['--pull', '--sig-proxy', '-itq', 'argument host'],
    });
    expect(report({ build: { options: ['--progress=plain'] } })).toEqual({ hostAccess: [], unsupported: ['build option --progress'] });
  });

  it('reports values of known flags that Dev Environments does not support as not supported', () => {
    expect(
      report({ runArgs: ['--restart=always', '--stop-timeout', '600', '--log-opt', 'syslog-address=udp://x', '--storage-opt', 'dm.basesize=20G', '--init', '-e'] }),
    ).toEqual({
      hostAccess: [],
      unsupported: ['--restart=always', '--stop-timeout=600', '--log-opt=syslog-address=udp://x', '--storage-opt=dm.basesize=20G', '-e without a value'],
    });
    expect(report({ runArgs: ['--log-driver=syslog', '--oom-score-adj=-1', '--env-file', '/etc/passwd'] })).toEqual({
      hostAccess: ['--log-driver=syslog', '--oom-score-adj=-1', '--env-file=/etc/passwd'],
      unsupported: [],
    });
  });

  it('reports labels of Dev Environments as not supported, and variables, volumes, and the port host as access to the computer', () => {
    const config = {
      runArgs: ['--label', 'devenv.environment-id=x', '-e', 'GIT_CONFIG_GLOBAL=/x', '-v', 'vscode:/v'],
      containerEnv: { DOCKER_CONFIG: '/a' },
      customizations: { vscode: { settings: { 'remote.localPortHost': 'allInterfaces' } } },
    };
    expect(report(config)).toEqual({
      hostAccess: [
        'setting remote.localPortHost "allInterfaces"',
        'variable GIT_CONFIG_GLOBAL in runArgs',
        'volume vscode of the Dev Containers extension',
        'variable DOCKER_CONFIG in containerEnv',
      ],
      unsupported: ['label devenv.environment-id'],
    });
  });

  it('keeps the settings that a rule refuses in the list of access to the computer', () => {
    expect(report({ runArgs: ['--privileged', '--restart=always'] })).toEqual({ hostAccess: ['privileged mode'], unsupported: ['--restart=always'] });
    expect(
      report({ runArgs: ['-v', '/Users/x:/x', '-P', '--gpus', 'all'], build: { options: ['--secret', 'id=a'] }, initializeCommand: 'x' }),
    ).toEqual({
      hostAccess: ['initializeCommand', 'bind mount /Users/x', 'publishing all ports (-P)', '--gpus=all', 'build option --secret'],
      unsupported: [],
    });
  });

  it('has the same items as hostAccessProblems, in the same order', () => {
    const config = { runArgs: ['--rm', '--privileged', '--restart=always', '-v', '/a:/a'], mounts: ['type=bind,source=/b,target=/b'] };
    const { hostAccess, unsupported } = report(config);
    const items = hostAccessProblems({ config, ownVolume: OWN });
    expect([...hostAccess, ...unsupported].sort()).toEqual([...items].sort());
    expect(items.filter((item) => hostAccess.includes(item))).toEqual(hostAccess);
    expect(items.filter((item) => unsupported.includes(item))).toEqual(unsupported);
  });
});

describe('host access policy: the runArgs that Docker gets', () => {
  const name = (runArgs: readonly string[]) => withoutNameArgs(runArgs);

  it('removes --name as Docker reads it, and keeps a --name that is the value of another flag', () => {
    expect(name(['--name', 'x', '--init'])).toEqual(['--init']);
    expect(name(['--name=x', '--init'])).toEqual(['--init']);
    expect(name(['--init', '--name'])).toEqual(['--init']);
    expect(name(['--name', '--privileged', '--init'])).toEqual(['--init']);
    expect(name(['-e', 'A=--name', '--init'])).toEqual(['-e', 'A=--name', '--init']);
    expect(name(['-e', '--name', '--init'])).toEqual(['-e', '--name', '--init']);
    expect(name(['--label', '--name', '--init', '--label', '--privileged'])).toEqual(['--label', '--name', '--init', '--label', '--privileged']);
  });

  /** The repository part of the runArgs of the override configuration: without the label and the name it adds. */
  function dockerRunArgs(runArgs: string[]): string[] {
    const all = buildOverrideConfig({ environmentImage: 'i:1', volumeName: OWN, repositoryName: 'api', containerName: OWN, runArgs })
      .runArgs as string[];
    expect(all.slice(-4)).toEqual(['--label', 'devenv.container-version=4', '--name', OWN]);
    return all.slice(0, -4);
  }

  const CASES: string[][] = [
    // `--name` as the value of an allowed flag: removed word by word, the arguments after it would shift by one.
    ['--label', '--name', '--init', '--label', '--privileged'],
    ['-e', '--name', '--init', '-e', '--privileged'],
    ['-e', '--name', '--init', '-e', '--volume=/:/host'],
    ['--label', '--name', '--init', '--label', '--pid=host'],
    ['--label', '--name', '--init', '--label', '-v/Users/hs:/host'],
    ['--label', '--name', '--init', '--label', '--mount=type=bind,source=/Users,target=/host'],
    ['--hostname', '--name', 'x', '--privileged'],
    ['--name', 'x', '--privileged'],
    ['--name=x', '-v', '/Users/hs:/host'],
    ['--name', '--init', '-p', '8080:80'],
    ['--cap-add=SYS_PTRACE', '--name', 'mine', '--network', 'host', '-p', '3000'],
    ['--init', '--name'],
    ['-e', '--name'],
  ];

  it.each(CASES.map((runArgs) => [runArgs.join(' '), runArgs]))('checks what Docker gets: %s', (_name, runArgs) => {
    const passed = dockerRunArgs(runArgs);
    expect(passed).toEqual(overrideRunArgs(runArgs));
    // A configuration that the policy allows gives Docker nothing that the policy refuses.
    const allowed = hostAccessProblems({ config: { runArgs }, ownVolume: OWN }).length === 0;
    if (allowed) expect(runArgsProblems(passed, OWN)).toEqual([]);
  });

  it.each(CASES.slice(0, 6).map((runArgs) => [runArgs.join(' '), runArgs]))('passes %s as it is: --name is a value there', (_name, runArgs) => {
    expect(dockerRunArgs(runArgs)).toEqual(runArgs);
    expect(hostAccessProblems({ config: { runArgs }, ownVolume: OWN })).toEqual([]);
  });

  it('lets no --name, --privileged, or bind mount through as a flag that the policy read as a value', () => {
    expect(hostAccessProblems({ config: { runArgs: ['--label', '--name', '--init', '--label', '--privileged'] }, ownVolume: OWN })).toEqual([]);
    expect(dockerRunArgs(['--label', '--name', '--init', '--label', '--privileged'])).toEqual(['--label', '--name', '--init', '--label', '--privileged']);
    expect(hostAccessProblems({ config: { runArgs: ['--hostname', '--name', 'x', '--privileged'] }, ownVolume: OWN })).toEqual(['argument x', 'privileged mode']);
  });
});

describe('host access policy: flags that are removed before up (--rm, -i, -t, -d, --name)', () => {
  const LIFE_CYCLE = expect.stringContaining('--rm would delete it at each stop');
  const TERMINAL = expect.stringContaining('without a terminal');
  const DETACH = expect.stringContaining('stays attached');
  const NAME = expect.stringContaining('name of the environment');

  it.each<[string, string[], Array<{ arg: string; reason: unknown }>, string[]]>([
    ['--rm', ['--rm', '--init'], [{ arg: '--rm', reason: LIFE_CYCLE }], ['--init']],
    ['--rm with a value', ['--rm=false', '--rm=true'], [{ arg: '--rm=false', reason: LIFE_CYCLE }, { arg: '--rm=true', reason: LIFE_CYCLE }], []],
    ['-i and -t', ['-i', '-t', '--init'], [{ arg: '-i', reason: TERMINAL }, { arg: '-t', reason: TERMINAL }], ['--init']],
    ['-it and -ti', ['-it', '--cap-drop', 'ALL', '-ti'], [{ arg: '-it', reason: TERMINAL }, { arg: '-ti', reason: TERMINAL }], ['--cap-drop', 'ALL']],
    ['the long forms', ['--interactive', '--tty=true', '-i=false'], [{ arg: '--interactive', reason: TERMINAL }, { arg: '--tty=true', reason: TERMINAL }, { arg: '-i=false', reason: TERMINAL }], []],
    ['-d', ['-d', '--detach'], [{ arg: '-d', reason: DETACH }, { arg: '--detach', reason: DETACH }], []],
    ['-dit, with both reasons', ['-dit'], [{ arg: '-dit', reason: expect.stringMatching(/stays attached.*; .*without a terminal/) }], []],
    ['--name with its value', ['--name', 'mine', '--rm', '-p', '3000'], [{ arg: '--name mine', reason: NAME }, { arg: '--rm', reason: LIFE_CYCLE }], ['-p', '127.0.0.1::3000']],
    ['flags that are values of other flags stay', ['--label', '--rm', '-e', '-it', '--hostname', '-d'], [], ['--label', '--rm', '-e', '-it', '--hostname', '-d']],
    ['--rm before a flag whose value looks like a mount', ['--rm', '--label', '-v/Users:/host'], [{ arg: '--rm', reason: LIFE_CYCLE }], ['--label', '-v/Users:/host']],
    ['a group with -P stays (the policy refuses it)', ['-Pi'], [], ['-Pi']],
    ['nothing to remove', ['--init', '--platform', 'linux/amd64'], [], ['--init', '--platform', 'linux/amd64']],
  ])('%s', (_name, runArgs, removed, passed) => {
    expect(removedRunArgs(runArgs)).toEqual(removed);
    expect(overrideRunArgs(runArgs)).toEqual(passed);
    // What Docker gets passes the policy whenever the configuration does.
    if (runArgsProblems(runArgs, OWN).length === 0) expect(runArgsProblems(passed, OWN)).toEqual([]);
  });

  it('removes them from the runArgs of the override configuration, and keeps the rest in order', () => {
    const override = buildOverrideConfig({
      environmentImage: 'i:1',
      volumeName: OWN,
      repositoryName: 'api',
      containerName: OWN,
      runArgs: ['--platform', 'linux/amd64', '--rm', '-it', '--cap-drop', 'ALL', '-d', '--label', '--rm'],
    });
    expect(override.runArgs).toEqual(['--platform', 'linux/amd64', '--cap-drop', 'ALL', '--label', '--rm', '--label', 'devenv.container-version=4', '--name', OWN]);
    expect(hostAccessProblems({ config: { runArgs: override.runArgs }, ownVolume: OWN })).toEqual([]);
  });
});

describe('host access policy: the runArgs check cannot be bypassed (restrictions summary, finding 1)', () => {
  /** The report of a repository configuration, and the runArgs that Docker gets for it (without the extension's own). */
  function check(runArgs: unknown[]): { report: HostAccessReport; passed: string[] } {
    const report = hostAccessReport({ config: { runArgs }, ownVolume: OWN });
    return { report, passed: overrideRunArgs(runArgs) };
  }

  const NONE: HostAccessReport = { hostAccess: [], unsupported: [] };

  it.each<[string, unknown[], HostAccessReport]>([
    // --name as the value of another flag: removed word by word, the next entries would shift and become flags.
    ['--name as a label before a bind mount', ['--label', '--name', '--init', '--label', '-v/Users:/host'], NONE],
    ['--name as a label before --privileged', ['--label', '--name', '--init', '--label', '--privileged'], NONE],
    ['--name as a label before a port on all addresses', ['--label', '--name', '--init', '--label', '-p0.0.0.0:80:80'], NONE],
    ['--rm as a label before a bind mount', ['--label', '--rm', '--init', '--label', '-v/Users:/host'], NONE],
    ['-it as a value before --privileged', ['-e', '-it', '--init', '-e', '--privileged'], NONE],
    // An entry that is no text: dropped from the list, the next entries would shift and become flags.
    ['a number before a bind mount', ['--label', 3, '--label', '-v/Users:/host'], { hostAccess: ['bind mount /Users'], unsupported: ['argument 3'] }],
    ['a number before --privileged', ['--label', 3, '--label', '--privileged'], { hostAccess: ['privileged mode'], unsupported: ['argument 3'] }],
    ['a number before a port on all addresses', ['--label', 3, '--label', '-p0.0.0.0:80:80'], { hostAccess: ['published port 0.0.0.0:80:80'], unsupported: ['argument 3'] }],
    ['true before a bind mount', ['-e', true, '-e', '--volume=/:/host'], { hostAccess: ['bind mount /'], unsupported: ['argument true'] }],
    ['null and an object', ['--init', null, { a: 1 }], { hostAccess: [], unsupported: ['argument null', 'argument {"a":1}'] }],
    // Removed flags whose value is the next entry: the value goes with them.
    ['--name that takes --rm as its value, before a bind mount', ['--name', '--rm', '-v/Users:/host'], { hostAccess: ['bind mount /Users'], unsupported: [] }],
    ['--rm and --name before a label', ['--rm', '--name', '--label', '-v/Users:/host'], { hostAccess: ['bind mount /Users'], unsupported: [] }],
  ])('%s', (_name, runArgs, expected) => {
    const { report, passed } = check(runArgs);
    expect(report).toEqual(expected);
    // A configuration that passes gives Docker the same list: the flags that look removable are values there.
    if (expected.hostAccess.length === 0 && expected.unsupported.length === 0) {
      expect(passed).toEqual(runArgs);
      expect(runArgsProblems(passed, OWN)).toEqual([]);
    }
  });
});

describe('host access policy: build options', () => {
  it.each<[string, string[], string[]]>([
    ['allowed options', ['--network=host', '--add-host', 'x:1.2.3.4', '--build-arg', 'A=1', '--target', 'dev', '--label', 'a=b', '--platform=linux/amd64', '--pull', '--no-cache'], []],
    ['a build context of an image or a URL', ['--build-context', 'base=docker-image://alpine:3', '--build-context=src=https://github.com/a/b.git'], []],
    ['secrets', ['--secret', 'id=npm,src=/Users/x/.npmrc'], ['build option --secret']],
    ['the SSH agent', ['--ssh=default'], ['build option --ssh']],
    ['entitlements', ['--allow', 'network.host'], ['build option --allow']],
    ['a build context of a folder', ['--build-context', 'src=/Users/x/src'], ['build option --build-context=src=/Users/x/src']],
    ['a build context of an OCI layout (a folder)', ['--build-context=x=oci-layout:///Users/x'], ['build option --build-context=x=oci-layout:///Users/x']],
    ['an output', ['--output', 'type=local,dest=/Users/x', '-o', 'out'], ['build option --output', 'build option -o']],
    ['an unknown option', ['--progress=plain'], ['build option --progress']],
  ])('%s', (_name, options, expected) => {
    expect(buildOptionProblems(options)).toEqual(expected);
    expect(configProblems({ build: { dockerfile: 'Dockerfile', options } })).toEqual(expected);
  });
});

describe('host access policy: properties of the configuration, the merged configuration, and the image metadata', () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    ['nothing special', { image: 'node:24', forwardPorts: [3000], portsAttributes: { 3000: { label: 'web' } }, containerEnv: { BROWSER: 'x' } }, []],
    ['privileged mode (docker-in-docker)', { privileged: true }, ['privileged mode']],
    ['privileged false', { privileged: false }, []],
    // The Dev Container CLI adds --privileged for any true-like value, and reads a single value in place of a list.
    ['privileged as another true-like value', { privileged: 1 }, ['privileged mode']],
    ['a capability as a single value', { capAdd: 'SYS_ADMIN' }, ['capability SYS_ADMIN']],
    ['a security option as a single value', { securityOpt: 'apparmor=unconfined' }, ['security option apparmor=unconfined']],
    ['a mount as a single value', { mounts: 'type=bind,source=/,target=/host' }, ['bind mount /']],
    ['a mount object in place of a list', { mounts: { type: 'bind', source: '/Users/x', target: '/x' } }, ['bind mount /Users/x']],
    ['SYS_PTRACE', { capAdd: ['SYS_PTRACE'] }, []],
    ['another capability', { capAdd: ['SYS_PTRACE', 'NET_ADMIN'] }, ['capability NET_ADMIN']],
    ['seccomp=unconfined', { securityOpt: ['seccomp=unconfined'] }, []],
    ['no-new-privileges', { securityOpt: ['no-new-privileges', 'no-new-privileges:true'] }, []],
    ['another security option', { securityOpt: ['apparmor=unconfined'] }, ['security option apparmor=unconfined']],
    ['a GPU', { hostRequirements: { gpu: true } }, ['GPU access (hostRequirements.gpu)']],
    ['an optional GPU', { hostRequirements: { gpu: 'optional' } }, ['GPU access (hostRequirements.gpu)']],
    ['no GPU', { hostRequirements: { gpu: false, cpus: 4 } }, []],
    ['initializeCommand as a string', { initializeCommand: 'docker login' }, ['initializeCommand']],
    ['initializeCommand as an array', { initializeCommand: ['sh', '-c', 'x'] }, ['initializeCommand']],
    ['initializeCommand as an object', { initializeCommand: { a: 'x' } }, ['initializeCommand']],
    ['an empty initializeCommand', { initializeCommand: '' }, []],
    ['appPort numbers (the CLI publishes them on 127.0.0.1)', { appPort: [3000, 8080] }, []],
    ['appPort without address', { appPort: '8080:80' }, []],
    ['appPort on 127.0.0.1', { appPort: ['127.0.0.1:8080:80'] }, []],
    ['appPort on all addresses', { appPort: ['0.0.0.0:8080:80', 3000] }, ['published port 0.0.0.0:8080:80']],
    ['appPort in the long syntax of docker run', { appPort: ['published=8080,target=80'] }, ['published port published=8080,target=80']],
    [
      'variables of container-only Git in containerEnv and remoteEnv',
      { containerEnv: { GIT_CONFIG_GLOBAL: '/x', FOO: 'bar' }, remoteEnv: { GIT_SSH_COMMAND: 'ssh', GIT_CONFIG_PARAMETERS: "'a=b'", PATH: '${containerEnv:PATH}:/x' } },
      ['variable GIT_CONFIG_GLOBAL in containerEnv', 'variable GIT_SSH_COMMAND in remoteEnv', 'variable GIT_CONFIG_PARAMETERS in remoteEnv'],
    ],
    ['other variables', { containerEnv: { NODE_ENV: 'development', GIT_AUTHOR_NAME: 'x' }, remoteEnv: { PATH: '/x', DOCKER_HOST: 'tcp://x' } }, []],
    ['variables of the Dev Containers extension and GnuPG', { containerEnv: { GNUPGHOME: '/g' }, remoteEnv: { SSH_AUTH_SOCK: '/a', REMOTE_CONTAINERS_IPC: '' } }, []],
    // The window applies the settings of the container: VS Code would forward the ports on all addresses of the computer.
    ['VS Code forwards ports on all addresses', { customizations: { vscode: { settings: { 'remote.localPortHost': 'allInterfaces' } } } }, ['setting remote.localPortHost "allInterfaces"']],
    ['the same with a nested key', { customizations: { vscode: { settings: { remote: { localPortHost: 'allInterfaces' } } } } }, ['setting remote.localPortHost "allInterfaces"']],
    ['an unknown value (VS Code uses all addresses for it)', { customizations: { vscode: { settings: { 'remote.localPortHost': '0.0.0.0' } } } }, ['setting remote.localPortHost "0.0.0.0"']],
    ['VS Code forwards ports on localhost', { customizations: { vscode: { settings: { 'remote.localPortHost': 'localhost', 'editor.tabSize': 2 } } } }, []],
    ['other settings and customizations', { customizations: { vscode: { settings: { 'remote.autoForwardPorts': true }, extensions: ['a.b'] }, codespaces: {} } }, []],
  ])('%s', (_name, config, expected) => {
    expect(configProblems(config)).toEqual(expected);
  });

  it('checks the variables in the repository configuration and the image metadata, not in the merged configuration', () => {
    // The merged configuration of a container that the extension created holds the values of its override configuration,
    // also those of container version 2 (GIT_CONFIG_PARAMETERS, GNUPGHOME, an empty SSH_AUTH_SOCK), whose containers the
    // pipeline creates again after this check.
    const version2 = { ...containerEnvironment(), GIT_CONFIG_PARAMETERS: "'credential.helper='", GNUPGHOME: '/workspaces/.devenv+/gnupg' };
    const merged = { containerEnv: version2, remoteEnv: { ...remoteEnvironment(), ...version2, SSH_AUTH_SOCK: '' } };
    expect(hostAccessProblems({ config: {}, merged, ownVolume: OWN })).toEqual([]);
    // A Feature or the base image: the values that the extension does not set itself would reach Git.
    const metadata = [{ id: 'feature', containerEnv: { GIT_CONFIG_PARAMETERS: "'credential.helper=store'", GNUPGHOME: '/g' } }, { remoteEnv: { DOCKER_CONFIG: '/d', SSH_AUTH_SOCK: '/a' } }];
    expect(hostAccessProblems({ metadata, ownVolume: OWN })).toEqual(['variable GIT_CONFIG_PARAMETERS in containerEnv', 'variable DOCKER_CONFIG in remoteEnv']);
  });

  it('checks remote.localPortHost in every entry of the merged configuration and the image metadata', () => {
    const merged = { customizations: { vscode: [{ settings: { 'editor.tabSize': 2 } }, { settings: { 'remote.localPortHost': 'allInterfaces' } }] } };
    expect(hostAccessProblems({ merged, ownVolume: OWN })).toEqual(['setting remote.localPortHost "allInterfaces"']);
    const metadata = [{ id: 'feature', customizations: { vscode: { settings: { remote: { localPortHost: 'allInterfaces' } } } } }];
    expect(hostAccessProblems({ metadata, ownVolume: OWN })).toEqual(['setting remote.localPortHost "allInterfaces"']);
  });

  it('passes the override configuration itself: its labels, variables, and settings', () => {
    for (const runArgs of [['--init', '-p', '3000'], ['--label', CONTAINER_CONFIG_UNKNOWN_LABEL]]) {
      const override = buildOverrideConfig({ environmentImage: 'i:1', volumeName: OWN, repositoryName: 'api', containerName: OWN, runArgs });
      expect(override.customizations).toEqual({ vscode: { settings: devContainersSettings() } });
      expect(hostAccessReport({ config: { runArgs: override.runArgs }, merged: override, ownVolume: OWN })).toEqual({ hostAccess: [], unsupported: [] });
    }
  });

  it('checks the merged configuration (Features and the base image) and the image metadata too', () => {
    const merged = {
      privileged: true,
      mounts: [{ source: '/var/run/docker.sock', target: '/var/run/docker-host.sock', type: 'bind' }],
      runArgs: ['--gpus', 'all'],
    };
    expect(hostAccessProblems({ config: {}, merged, ownVolume: OWN })).toEqual([
      'bind mount /var/run/docker.sock',
      'privileged mode',
      '--gpus=all',
    ]);
    const metadata = [
      { id: 'ghcr.io/devcontainers/features/docker-outside-of-docker:1', mounts: [{ source: '/var/run/docker.sock', target: '/var/run/docker-host.sock', type: 'bind' }] },
      { id: 'ghcr.io/devcontainers/features/docker-in-docker:2', privileged: true, capAdd: ['NET_ADMIN'] },
      'not an entry',
      { remoteUser: 'node', securityOpt: ['seccomp=unconfined'] },
    ];
    expect(hostAccessProblems({ metadata, ownVolume: OWN })).toEqual([
      'bind mount /var/run/docker.sock',
      'privileged mode',
      'capability NET_ADMIN',
    ]);
    // The label of a base image or a Feature, as the CLI reads it (single values, any true-like `privileged`).
    expect(hostAccessProblems({ metadata: [{ privileged: 'true', capAdd: 'SYS_ADMIN', mounts: 'type=bind,src=/,dst=/h' }], ownVolume: OWN })).toEqual([
      'bind mount /',
      'privileged mode',
      'capability SYS_ADMIN',
    ]);
    // runArgs, appPort, and build options are not part of the image metadata: only the configurations name them.
    expect(hostAccessProblems({ metadata: [{ runArgs: ['--privileged'], appPort: '0.0.0.0:1:1' }], ownVolume: OWN })).toEqual([]);
  });

  it('names each problem once, also when the configuration and the merged configuration both have it', () => {
    const config = { mounts: ['source=/Users/x,target=/x,type=bind'], runArgs: ['--privileged'] };
    const merged = { ...config, privileged: true };
    expect(hostAccessProblems({ config, merged, ownVolume: OWN })).toEqual(['bind mount /Users/x', 'privileged mode']);
  });
});

describe('volumes of other environments', () => {
  it.each(['acme/api', 'Acme/My.Repo_Name', 'a/b', 'devenv/x', `${'a'.repeat(40)}/${'b'.repeat(40)}`, 'o/name-with--dashes---'])(
    'recognizes the workspace volume of an environment of %s',
    (repository) => {
      for (let i = 0; i < 20; i++) expect(ENVIRONMENT_VOLUME_PATTERN.test(resourceName(repository, newEnvironmentId()))).toBe(true);
    },
  );

  it.each(['devenv-tools-node_modules', 'devenv-cache', HELPER_CACHE_VOLUME, 'devenv-acme-api', 'cache-3f2a9c1e', 'devenv-acme-api-3f2a9c1', 'devenv-acme-api-3f2a9c1ez'])(
    'does not take %s for one',
    (volume) => {
      expect(ENVIRONMENT_VOLUME_PATTERN.test(volume)).toBe(false);
    },
  );

  it('refuses the workspace volume of another environment, also a shortened long name, and the volume of the helper', () => {
    const long = resourceName(`${'a'.repeat(40)}/${'b'.repeat(40)}`, '0a1b2c3d-0000-4000-8000-000000000000');
    expect(long).toHaveLength(63);
    expect(configProblems({ mounts: [`source=${long},target=/x,type=volume`] })).toEqual([`volume ${long} of another environment`]);
    expect(configProblems({ runArgs: ['-v', 'devenv-acme-web-11111111:/x', '-v', `${HELPER_CACHE_VOLUME}:/c`] })).toEqual([
      'volume devenv-acme-web-11111111 of another environment',
      `volume ${HELPER_CACHE_VOLUME} of the workspace helper`,
    ]);
    // The own volume is allowed, also for a repository whose name starts with devenv-.
    const own = resourceName('acme/devenv-tools', newEnvironmentId());
    expect(hostAccessProblems({ config: { mounts: [`source=${own},target=/o,type=volume`, 'source=devenv-tools-node_modules,target=/n,type=volume'] }, ownVolume: own })).toEqual([]);
  });
});

describe('volumes of environments of other accounts (restrictions summary, finding 4)', () => {
  const FOREIGN = ['shared-cache', 'api-node_modules'];

  it.each<[string, Record<string, unknown>, string[]]>([
    ['a mount', { mounts: ['source=shared-cache,target=/c,type=volume'] }, ['volume shared-cache of another environment']],
    ['a mount object', { mounts: [{ type: 'volume', source: 'api-node_modules', target: '/n' }] }, ['volume api-node_modules of another environment']],
    [
      '-v and --mount of runArgs',
      { runArgs: ['-v', 'shared-cache:/c', '--mount', 'type=volume,source=api-node_modules,target=/n'] },
      ['volume shared-cache of another environment', 'volume api-node_modules of another environment'],
    ],
    ['volumes of no other account', { mounts: ['source=own-cache,target=/c,type=volume'], runArgs: ['-v', 'other:/o', '-v', '/anonymous'] }, []],
  ])('%s', (_name, config, expected) => {
    expect(hostAccessProblems({ config, ownVolume: OWN, foreignVolumes: FOREIGN })).toEqual(expected);
    // Without environments of other accounts, the same volumes are allowed.
    expect(hostAccessProblems({ config, ownVolume: OWN })).toEqual([]);
  });

  it('checks the image metadata and the runArgs as Docker gets them too', () => {
    const metadata = [{ id: 'feature', mounts: [{ type: 'volume', source: 'shared-cache', target: '/c' }] }];
    expect(hostAccessProblems({ metadata, ownVolume: OWN, foreignVolumes: FOREIGN })).toEqual(['volume shared-cache of another environment']);
    expect(runArgsProblems(['-v', 'shared-cache:/c'], OWN, FOREIGN)).toEqual(['volume shared-cache of another environment']);
    expect(runArgsProblems(['-v', 'shared-cache:/c'], OWN)).toEqual([]);
  });

  it('allows the own workspace volume, also when the registry names it for another account', () => {
    expect(hostAccessProblems({ config: { mounts: [`source=${OWN},target=/o,type=volume`] }, ownVolume: OWN, foreignVolumes: [OWN] })).toEqual([]);
  });
});

describe('volumes named like a clone volume of the Dev Containers extension (a name that ends in a hash)', () => {
  const SHA = `api-${'5e'.repeat(32)}`;
  const MD5 = `vsc-api-${'0f'.repeat(16)}`;
  const ENVIRONMENT = { id: 'e0000001-0000-4000-8000-000000000001', ownerId: '1001' };
  const OWN_LABELS = { 'devenv.environment-id': ENVIRONMENT.id, 'devenv.owner-id': '1001', 'devenv.repository': 'acme/api', 'devenv.volume': 'additional' };

  it.each<[string, Record<string, Record<string, string>>, string[]]>([
    ['they do not exist yet (the pipeline creates them with its labels)', {}, []],
    ['they exist without labels (older versions of the Dev Containers extension)', { [SHA]: {}, [MD5]: {} }, [`volume ${SHA} of another program`, `volume ${MD5} of another program`]],
    ['they exist with the labels of the Dev Containers extension', { [SHA]: { 'vsch.local.repository': 'x' }, [MD5]: { 'dev.container.volume': 'true' } }, [`volume ${SHA} of the Dev Containers extension`, `volume ${MD5} of the Dev Containers extension`]],
    ['they exist with other labels', { [SHA]: { 'com.example': 'x' } }, [`volume ${SHA} of another program`]],
    ['they are the own volumes of the environment', { [SHA]: OWN_LABELS, [MD5]: OWN_LABELS }, []],
  ])('%s', (_name, volumeLabels, expected) => {
    const config = { mounts: [`source=${SHA},target=/s,type=volume`], runArgs: ['-v', `${MD5}:/m`] };
    expect(hostAccessProblems({ config, ownVolume: OWN, volumeLabels, environment: ENVIRONMENT })).toEqual(expected);
  });
});

describe('volumes with the labels of Dev Environments', () => {
  const ENVIRONMENT = { id: 'e0000001-0000-4000-8000-000000000001', ownerId: '1001' };
  const FORMER = 'e0000009-0000-4000-8000-000000000009';
  const labels = (id: string, owner?: string, kind: string | null = 'additional'): Record<string, string> => ({
    'devenv.environment-id': id,
    'devenv.repository': 'acme/api',
    ...(owner === undefined ? {} : { 'devenv.owner-id': owner }),
    ...(kind === null ? {} : { 'devenv.volume': kind }),
  });

  it.each<[string, Record<string, string>, readonly string[], string[]]>([
    ['its own volume', labels(ENVIRONMENT.id, '1001'), [ENVIRONMENT.id], []],
    ['its own volume without an owner label (an entry of an older version)', labels(ENVIRONMENT.id), [ENVIRONMENT.id], []],
    ['its own ID with the owner label of another account', labels(ENVIRONMENT.id, '2002'), [ENVIRONMENT.id], ['volume data of another environment']],
    ['a volume of another environment in the registry, also of the same owner', labels(FORMER, '1001'), [ENVIRONMENT.id, FORMER], ['volume data of another environment']],
    ['a volume that the Delete of an environment of the same owner kept', labels(FORMER, '1001'), [ENVIRONMENT.id], []],
    ['a volume that the Delete of an environment of another owner kept', labels(FORMER, '2002'), [ENVIRONMENT.id], ['volume data of another environment']],
    ['a volume of a deleted environment without an owner label', labels(FORMER), [ENVIRONMENT.id], ['volume data of another environment']],
    ['a volume of a deleted environment that is no additional volume', labels(FORMER, '1001', null), [ENVIRONMENT.id], ['volume data of another environment']],
  ])('%s', (_name, volumeLabels, environmentIds, expected) => {
    const config = { mounts: ['source=data,target=/data,type=volume'] };
    expect(hostAccessProblems({ config, ownVolume: OWN, volumeLabels: { data: volumeLabels }, environment: ENVIRONMENT, environmentIds })).toEqual(expected);
  });

  it('refuses every volume with devenv.environment-id when the environment is not known', () => {
    const config = { mounts: ['source=data,target=/data,type=volume'] };
    expect(hostAccessProblems({ config, ownVolume: OWN, volumeLabels: { data: labels(ENVIRONMENT.id, '1001') } })).toEqual(['volume data of another environment']);
  });

  it.each<[string, Record<string, string>, string | undefined, boolean]>([
    ['the ID and the owner', { 'devenv.environment-id': 'a', 'devenv.owner-id': '1' }, '1', true],
    ['the ID without an owner label', { 'devenv.environment-id': 'a' }, '1', true],
    ['the ID of an environment without owner', { 'devenv.environment-id': 'a', 'devenv.owner-id': '1' }, undefined, true],
    ['another owner', { 'devenv.environment-id': 'a', 'devenv.owner-id': '2' }, '1', false],
    ['another ID', { 'devenv.environment-id': 'b', 'devenv.owner-id': '1' }, '1', false],
    ['no labels', {}, '1', false],
    ['labels of another program', { 'com.docker.compose.project': 'a' }, '1', false],
  ])('isOwnVolume: %s', (_name, volumeLabels, ownerId, expected) => {
    expect(isOwnVolume(volumeLabels, 'a', ownerId)).toBe(expected);
  });
});

describe('volumes of other programs, by their labels (restrictions summary, finding 4)', () => {
  it.each<[string, Record<string, string>, string[]]>([
    ['a volume of a Docker Compose project', { 'com.docker.compose.project': 'shop', 'com.docker.compose.volume': 'db' }, ['volume data of the Docker Compose project shop']],
    ['a volume of Docker Compose without a project', { 'com.docker.compose.volume': 'db' }, ['volume data of Docker Compose']],
    ['a clone of the Dev Containers extension', { 'vsch.local.repository': 'https://github.com/a/b.git', 'vsch.local.repository.unique': 'false' }, ['volume data of the Dev Containers extension']],
    ['a volume of a template of the Dev Containers extension', { 'dev.container.volume': 'true' }, ['volume data of the Dev Containers extension']],
    ['an anonymous volume of another container', { 'com.docker.volume.anonymous': '' }, ['volume data of another container']],
    ['the workspace volume of another environment', { 'devenv.environment-id': 'x', 'devenv.owner-id': '1' }, ['volume data of another environment']],
    ['a volume without labels (as the mounts of a configuration create it)', {}, []],
    ['a volume with other labels', { 'com.example.purpose': 'cache' }, []],
  ])('%s', (_name, labels, expected) => {
    const config = { mounts: ['source=data,target=/data,type=volume'], runArgs: ['-v', 'data:/d', '--mount', 'type=volume,src=data,dst=/m'] };
    expect(hostAccessProblems({ config, ownVolume: OWN, volumeLabels: { data: labels } })).toEqual(expected);
    // Without the labels (a volume that does not exist yet), the name alone decides.
    expect(hostAccessProblems({ config, ownVolume: OWN })).toEqual([]);
  });

  it('names the named volumes of the mounts once, for the labels', () => {
    const config = {
      mounts: [
        'source=cache,target=/c,type=volume',
        'type=bind,source=/Users/x,target=/x',
        'target=/anonymous,type=volume',
        { source: 'history', target: '/h', type: 'volume' },
        'source=${devcontainerId}-x,target=/y,type=volume',
        `source=${OWN},target=/o,type=volume`,
        'type=tmpfs,target=/t',
      ],
      runArgs: ['-v', 'data:/data', '-v', '/anon', '-v', './rel:/r', '--mount', 'type=volume,source=more,target=/m', '--label', '-v', '--volume=cache:/c2'],
    };
    const merged = { mounts: [{ source: 'feature-vol', target: '/f', type: 'volume' }] };
    const metadata = [{ mounts: 'source=image-vol,target=/i' }];
    expect(mountedVolumeNames({ config, merged, metadata, ownVolume: OWN })).toEqual(['cache', 'history', 'feature-vol', 'image-vol', 'data', 'more']);
    expect(mountedVolumeNames({ config: { runArgs: ['--init'] }, ownVolume: OWN })).toEqual([]);
    // The cases of the parser that recorded the volumes before (configChecks, concept 7.14).
    expect(
      mountedVolumeNames({
        config: {
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
        },
        ownVolume: OWN,
      }),
    ).toEqual(['api-node_modules', 'pgdata', 'cache', 'history', 'db']);
    // Sources with an unresolved variable (read-configuration before the container exists) are skipped.
    expect(
      mountedVolumeNames({
        config: {
          mounts: [
            'source=${devcontainerId}-history,target=/commandhistory,type=volume',
            { source: '${localEnv:VOLUME}', target: '/v', type: 'volume' },
            'source=1r60kajr11nn-history,target=/commandhistory,type=volume',
          ],
          runArgs: ['-v', '${devcontainerId}-cache:/cache'],
        },
        ownVolume: OWN,
      }),
    ).toEqual(['1r60kajr11nn-history']);
    expect(mountedVolumeNames({ config: { image: 'x' }, ownVolume: OWN })).toEqual([]);
  });
});

describe('ports on localhost', () => {
  it.each<[string, string | undefined, string]>([
    ['80', undefined, '80'],
    ['8080:80', undefined, '8080:80'],
    ['127.0.0.1:8080:80', '127.0.0.1', '8080:80'],
    ['127.0.0.1::80', '127.0.0.1', ':80'],
    [':8080:80', '', '8080:80'],
    ['[::1]:8080:80', '[::1]', '8080:80'],
    ['::1:8080:80', '::1', '8080:80'],
  ])('splits %s', (spec, address, ports) => {
    expect(splitPortAddress(spec)).toEqual({ address, ports });
  });

  it.each<[string, boolean]>([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['[::1]', true],
    ['0:0:0:0:0:0:0:1', true],
    ['0.0.0.0', false],
    ['192.168.1.5', false],
    ['::', false],
    ['localhost', false],
  ])('%s is a loopback address: %s', (address, expected) => {
    expect(isLoopbackAddress(address)).toBe(expected);
  });

  it.each<[string, string]>([
    ['8080:80', '127.0.0.1:8080:80'],
    ['80', '127.0.0.1::80'],
    ['80/udp', '127.0.0.1::80/udp'],
    ['8000-8010:8000-8010', '127.0.0.1:8000-8010:8000-8010'],
    [':8080:80', '127.0.0.1:8080:80'],
    ['127.0.0.1:8080:80', '127.0.0.1:8080:80'],
    ['[::1]:8080:80', '[::1]:8080:80'],
    // The long syntax is refused by the policy; a prefix would only hide it from the final check.
    ['published=8080,target=80', 'published=8080,target=80'],
  ])('publishes %s as %s', (spec, expected) => {
    expect(withLoopbackAddress(spec)).toBe(expected);
  });

  it('binds appPort to 127.0.0.1', () => {
    expect(loopbackAppPorts(3000)).toEqual(['127.0.0.1:3000:3000']);
    expect(loopbackAppPorts('8080:80')).toEqual(['127.0.0.1:8080:80']);
    expect(loopbackAppPorts([3000, '8080:80', '127.0.0.1:9000:90'])).toEqual([
      '127.0.0.1:3000:3000',
      '127.0.0.1:8080:80',
      '127.0.0.1:9000:90',
    ]);
    expect(loopbackAppPorts(undefined)).toBeUndefined();
    expect(loopbackAppPorts([])).toBeUndefined();
  });

  it('adds 127.0.0.1 to the published ports of runArgs, in each form, and changes nothing else', () => {
    expect(
      loopbackRunArgs(['-p', '8080:80', '--publish', '3000', '-p9000:90', '-p=7000:70', '--publish=6000:60', '-e', '-p', '--label', 'x=1']),
    ).toEqual(['-p', '127.0.0.1:8080:80', '--publish', '127.0.0.1::3000', '-p127.0.0.1:9000:90', '-p127.0.0.1:7000:70', '--publish=127.0.0.1:6000:60', '-e', '-p', '--label', 'x=1']);
    expect(loopbackRunArgs(['-p', '127.0.0.1:8080:80', '--network', 'host'])).toEqual(['-p', '127.0.0.1:8080:80', '--network', 'host']);
  });

  it('keeps --network host as it is (Docker ignores -p there, concept section 9 "Host access", exception)', () => {
    expect(loopbackRunArgs(['--network', 'host', '-p', '3000:3000'])).toEqual(['--network', 'host', '-p', '127.0.0.1:3000:3000']);
    expect(hostAccessProblems({ config: { runArgs: ['--network', 'host', '-p', '3000:3000'] }, ownVolume: OWN })).toEqual([]);
  });
});

describe('GH_CONFIG_DIR, the sign-in of the GitHub CLI of the owner account (concept section 9)', () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    ['in containerEnv', { containerEnv: { GH_CONFIG_DIR: '/home/node/.config/gh' } }, ['variable GH_CONFIG_DIR in containerEnv']],
    ['in remoteEnv', { remoteEnv: { gh_config_dir: '/tmp/gh' } }, ['variable gh_config_dir in remoteEnv']],
    ['in runArgs with -e', { runArgs: ['-e', 'GH_CONFIG_DIR=/tmp/gh'] }, ['variable GH_CONFIG_DIR in runArgs']],
    ['in runArgs with --env=', { runArgs: ['--env=GH_CONFIG_DIR=/x'] }, ['variable GH_CONFIG_DIR in runArgs']],
    ['in runArgs with -e and the value attached', { runArgs: ['-eGH_CONFIG_DIR=/y'] }, ['variable GH_CONFIG_DIR in runArgs']],
    // Without a value, Docker removes the variable of the override configuration.
    ['in runArgs without a value', { runArgs: ['--env', 'GH_CONFIG_DIR'] }, ['variable GH_CONFIG_DIR in runArgs']],
    ['other variables of the GitHub CLI', { containerEnv: { GH_PAGER: 'cat' }, runArgs: ['-e', 'GH_NO_UPDATE_NOTIFIER=1'] }, []],
  ])('%s', (_name, config, expected) => {
    expect(configProblems(config)).toEqual(expected);
  });

  it('refuses it in the image metadata, and accepts the value of the override configuration in the merged configuration', () => {
    expect(hostAccessProblems({ metadata: [{ id: 'feature', containerEnv: { GH_CONFIG_DIR: '/g' } }], ownVolume: OWN })).toEqual([
      'variable GH_CONFIG_DIR in containerEnv',
    ]);
    const merged = { containerEnv: containerEnvironment(), remoteEnv: remoteEnvironment() };
    expect(merged.containerEnv.GH_CONFIG_DIR).toBe('/workspaces/.devenv+/gh');
    expect(hostAccessProblems({ config: {}, merged, ownVolume: OWN })).toEqual([]);
  });
});
