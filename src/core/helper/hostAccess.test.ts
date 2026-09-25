// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_VOLUME_PATTERN, HELPER_CACHE_VOLUME, newEnvironmentId, resourceName } from '../names';
import { buildOverrideConfig } from './devcontainerCli';
import {
  buildOptionProblems,
  hostAccessProblems,
  hostAccessReport,
  isLoopbackAddress,
  loopbackAppPorts,
  loopbackRunArgs,
  overrideRunArgs,
  runArgsProblems,
  splitPortAddress,
  withLoopbackAddress,
  withoutNameArgs,
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
    ['a volume with driver options (a folder of the computer)', 'type=volume,source=v,target=/x,volume-opt=type=none,volume-opt=device=/Users/x', ['volume options of the mount v']],
    ['a volume with a driver', 'type=volume,source=v,target=/x,volume-driver=local', ['volume options of the mount v']],
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
    ['all ports', ['-P'], ['publishing all ports (-P)']],
    ['all ports, long form', ['--publish-all'], ['publishing all ports (--publish-all)']],
    ['the platform (as in build.options)', ['--platform', 'linux/amd64', '--init', '--platform=linux/arm64'], []],
    ['a tmpfs (as a mount of the type tmpfs)', ['--tmpfs', '/tmp', '--tmpfs=/run:rw,size=64m'], []],
    ['volumes of the repository that start with devenv-', ['-v', 'devenv-cache:/x', '--mount=type=volume,source=devenv-db-data,target=/d', '--mount', 'type=volume,src=devenv-cache,dst=/c'], []],
    ['the network of another container in upper case', ['--network=CONTAINER:db'], ['network of another container (CONTAINER:db)']],
    ['an unknown flag with =', ['--restart=always'], ['--restart']],
    ['an unknown boolean flag', ['--rm'], ['--rm']],
    ['a group of short flags', ['-it'], ['-it']],
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
    expect(report({ runArgs: ['--restart=always', '--rm', '-it', 'host'] })).toEqual({
      hostAccess: [],
      unsupported: ['--restart', '--rm', '-it', 'argument host'],
    });
    expect(report({ build: { options: ['--progress=plain'] } })).toEqual({ hostAccess: [], unsupported: ['build option --progress'] });
  });

  it('keeps the settings that a rule refuses in the list of access to the computer', () => {
    expect(report({ runArgs: ['--privileged', '--restart=always'] })).toEqual({ hostAccess: ['privileged mode'], unsupported: ['--restart'] });
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
    expect(all.slice(-4)).toEqual(['--label', 'devenv.container-version=2', '--name', OWN]);
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
  ])('%s', (_name, config, expected) => {
    expect(configProblems(config)).toEqual(expected);
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
