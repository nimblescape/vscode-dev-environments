// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { CONTAINER_VERSION, composeProjectName, environmentImageRepository } from '../names';
import {
  COMPOSE_BUILD_CONTEXT,
  COMPOSE_DEV_DOCKERFILE,
  COMPOSE_MODEL_PATH,
  WORKSPACE_VOLUME_KEY,
  builtServiceImages,
  composeBuildModel,
  composeConfigHash,
  composeInputsHash,
  composeMountVolumeName,
  composeNetworkNames,
  composeNetworkReferences,
  composeReferences,
  composeServiceImage,
  composeServiceImageReferences,
  composeServiceVolumeNames,
  composeUpModel,
  composeUserArgs,
  composeVolumeNames,
  decideServiceMount,
  decideServicePort,
  escapeComposeDollars,
  isOtherEnvironmentProjectName,
  isSupportedComposeVersion,
  parseComposeModelOutput,
  resolveComposeFiles,
  supportsVolumeSubpath,
  type ComposeEntryDecision,
  type ComposeModel,
  type ComposeMountContext,
  type ComposeRewriteParams,
} from './compose';
import { OVERRIDE_FOLDER } from './scripts';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
const PROJECT = 'devenv-3f2a9c1e';
const OWN = 'devenv-acme-api-3f2a9c1e';
const REPO = '/workspaces/api';

/** A merged model in the form of `docker compose config --format json` (the templates' app + db). */
function templateModel(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: {
        build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile' },
        command: ['sleep', 'infinity'],
        networks: { default: null },
        volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces', bind: { create_host_path: true } }],
        environment: { POSTGRES_HOST: 'db' },
      },
      db: {
        image: 'postgres:16',
        container_name: 'db1',
        restart: 'unless-stopped',
        ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }],
        volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} }],
        networks: { default: null },
      },
    },
    networks: { default: { name: `${PROJECT}_default` } },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function params(overrides: Partial<ComposeRewriteParams> = {}): ComposeRewriteParams {
  return {
    project: PROJECT,
    devService: 'app',
    environmentId: ID,
    containerName: OWN,
    volumeName: OWN,
    repositoryFolder: REPO,
    dollarEscaped: true,
    engineApiVersion: '1.47',
    ...overrides,
  };
}

describe('names', () => {
  it('the project of an environment is devenv-<short id>, the repository part of the environment image', () => {
    expect(composeProjectName(ID)).toBe(PROJECT);
    expect(composeProjectName(ID)).toBe(environmentImageRepository(ID));
  });

  it.each<[string, string]>([
    ['app', `${PROJECT}-app`],
    ['Web.Frontend', `${PROJECT}-web-frontend`],
    ['db_1', `${PROJECT}-db-1`],
    ['__', `${PROJECT}-service`],
  ])('composeServiceImage(%s)', (service, image) => {
    expect(composeServiceImage(PROJECT, service)).toBe(image);
  });

  it.each<[string, boolean]>([
    ['devenv-11111111_default', true],
    ['DEVENV-11111111_data', true],
    [`${PROJECT}_default`, false],
    ['devenv-tools_default', false],
    ['frontend', false],
  ])('isOtherEnvironmentProjectName(%s)', (name, expected) => {
    expect(isOtherEnvironmentProjectName(name, PROJECT)).toBe(expected);
  });

  it('the files of the extension are in the override folder', () => {
    expect(COMPOSE_MODEL_PATH).toBe(`${OVERRIDE_FOLDER}/compose.json`);
    expect(COMPOSE_DEV_DOCKERFILE.startsWith(`${OVERRIDE_FOLDER}/`)).toBe(true);
    expect(COMPOSE_BUILD_CONTEXT).toBe(`${OVERRIDE_FOLDER}/context`);
  });
});

describe('versions', () => {
  it.each<[string, boolean]>([
    ['2.24.4', true],
    ['v2.29.1', true],
    ['2.40.0-desktop.1', true],
    ['3.0', true],
    ['2.24.3', false],
    ['2.9.0', false],
    ['1.29.2', false],
    ['', false],
    ['unknown', false],
  ])('isSupportedComposeVersion(%j) is %s', (version, expected) => {
    expect(isSupportedComposeVersion(version)).toBe(expected);
  });

  it.each<[string | undefined, boolean]>([
    ['1.45', true],
    ['1.47', true],
    ['1.51', true],
    ['2.0', true],
    ['1.44', false],
    ['1.9', false],
    [undefined, false],
    ['', false],
  ])('supportsVolumeSubpath(%j) is %s', (version, expected) => {
    expect(supportsVolumeSubpath(version)).toBe(expected);
  });
});

describe('resolveComposeFiles', () => {
  it.each<[string, string, unknown, ReturnType<typeof resolveComposeFiles>]>([
    ['a string, relative to the configuration folder', '.devcontainer/devcontainer.json', 'docker-compose.yml', { files: [`${REPO}/.devcontainer/docker-compose.yml`] }],
    ['a list, in order, each once', '.devcontainer/devcontainer.json', ['../compose.yml', 'extra.yml', '../compose.yml'], { files: [`${REPO}/compose.yml`, `${REPO}/.devcontainer/extra.yml`] }],
    ['a configuration in a sub-folder', '.devcontainer/python/devcontainer.json', 'compose.yml', { files: [`${REPO}/.devcontainer/python/compose.yml`] }],
    ['.devcontainer.json at the root', '.devcontainer.json', 'compose.yml', { files: [`${REPO}/compose.yml`] }],
    ['an absolute path in the repository', '.devcontainer/devcontainer.json', `${REPO}/compose.yml`, { files: [`${REPO}/compose.yml`] }],
    ['a path out of the repository', '.devcontainer/devcontainer.json', '../../other/compose.yml', { problem: 'dockerComposeFile "../../other/compose.yml" (outside of the repository)' }],
    ['the parent of the repository', '.devcontainer/devcontainer.json', '../../compose.yml', { problem: 'dockerComposeFile "../../compose.yml" (outside of the repository)' }],
    ['an absolute path outside', '.devcontainer/devcontainer.json', '/etc/compose.yml', { problem: 'dockerComposeFile "/etc/compose.yml" (outside of the repository)' }],
    ['the configuration folder of the volume', '.devcontainer/devcontainer.json', '../../.devenv+/compose.yml', { problem: 'dockerComposeFile "../../.devenv+/compose.yml" (outside of the repository)' }],
    ['a variable that is not resolved', '.devcontainer/devcontainer.json', '${localEnv:FILE}', { problem: 'dockerComposeFile "${localEnv:FILE}" (a variable that is not resolved)' }],
    ['an empty list', '.devcontainer/devcontainer.json', [], { problem: 'dockerComposeFile without a compose file' }],
    ['no value', '.devcontainer/devcontainer.json', undefined, { problem: 'dockerComposeFile without a compose file' }],
    ['an empty text', '.devcontainer/devcontainer.json', ' ', { problem: 'dockerComposeFile " "' }],
    ['no text', '.devcontainer/devcontainer.json', [1], { problem: 'dockerComposeFile 1' }],
  ])('%s', (_name, configPath, value, expected) => {
    expect(resolveComposeFiles(configPath, 'api', value)).toEqual(expected);
  });
});

describe('parseComposeModelOutput', () => {
  const output = { version: '2.29.1', dollarEscaped: true, model: templateModel(), dockerfiles: { app: 'FROM x\n' }, realPaths: { '/workspaces': '/workspaces', '/x': null } };

  it('reads the last line', () => {
    // Review round 1 (P-4): the hash of the input files; `''` when the output has none.
    expect(parseComposeModelOutput(`warning\n${JSON.stringify(output)}\n\n`)).toEqual({ ...output, inputsHash: '' });
    expect(parseComposeModelOutput(JSON.stringify({ ...output, inputsHash: 'abc' }))).toEqual({ ...output, inputsHash: 'abc' });
  });

  it('returns the message of Docker Compose', () => {
    expect(parseComposeModelOutput(JSON.stringify({ error: 'yaml: line 3: bad' }))).toEqual({ error: 'yaml: line 3: bad' });
  });

  it.each<[string, string]>([
    ['nothing', ''],
    ['no JSON', 'not json'],
    ['no services', JSON.stringify({ ...output, model: {} })],
    ['no version', JSON.stringify({ ...output, version: 2 })],
    ['no escape probe', JSON.stringify({ ...output, dollarEscaped: 'yes' })],
    ['a Dockerfile that is no text', JSON.stringify({ ...output, dockerfiles: { app: 1 } })],
    ['a real path that is no text', JSON.stringify({ ...output, realPaths: { '/x': 1 } })],
    ['no real paths', JSON.stringify({ ...output, realPaths: undefined })],
  ])('throws for %s', (_name, text) => {
    expect(() => parseComposeModelOutput(text)).toThrow(/Compose model/);
  });
});

describe('composeVolumeNames and composeMountVolumeName', () => {
  it('names the project volumes, named volumes, and external volumes', () => {
    const model: ComposeModel = {
      services: {},
      volumes: {
        pgdata: { name: `${PROJECT}_pgdata` },
        cache: { name: 'shared-cache' },
        old: { external: true },
        other: { external: true, name: 'other-name' },
        bare: null,
      },
    };
    expect(composeVolumeNames(model, PROJECT)).toEqual([
      { key: 'pgdata', name: `${PROJECT}_pgdata`, project: true },
      { key: 'cache', name: 'shared-cache', project: false },
      { key: 'old', name: 'old', project: false },
      { key: 'other', name: 'other-name', project: false },
      { key: 'bare', name: `${PROJECT}_bare`, project: true },
    ]);
    expect(composeVolumeNames({ services: {} }, PROJECT)).toEqual([]);
  });

  it.each<[string, unknown, string | undefined]>([
    ['a volume of `mounts` (string)', 'source=history,target=/h,type=volume', `${PROJECT}_history`],
    ['a volume of `mounts` (object)', { type: 'volume', source: 'history', target: '/h' }, `${PROJECT}_history`],
    ['an external volume (object)', { type: 'volume', source: 'shared', target: '/h', external: true }, 'shared'],
    ['a bind mount', 'source=/x,target=/x,type=bind', undefined],
    ['a string without type (the CLI adds no top-level volume)', 'source=history,target=/h', undefined],
    ['a tmpfs', { type: 'tmpfs', target: '/t' }, undefined],
    ['an anonymous volume', { type: 'volume', target: '/t' }, undefined],
    ['no mount', 42, undefined],
  ])('composeMountVolumeName: %s', (_name, mount, expected) => {
    expect(composeMountVolumeName(PROJECT, mount)).toBe(expected);
  });
});

describe('composeReferences', () => {
  it('checks the images of image-only services, the FROM images of built services, and OCI Features', () => {
    const model: ComposeModel = {
      services: {
        app: { build: { context: REPO, dockerfile: 'Dockerfile', args: { BASE: 'node:24' }, target: 'dev' } },
        db: { image: 'postgres:16' },
        pinned: { image: `redis@sha256:${'a'.repeat(64)}` },
        remote: { build: { context: 'https://github.com/acme/tool.git' } },
        again: { image: 'postgres:16' },
      },
    };
    const dockerfiles = { app: 'ARG BASE=node:22\nFROM ${BASE} AS dev\nFROM alpine:3.22 AS prod\n' };
    const features = { 'ghcr.io/devcontainers/features/node:1': {}, './local': {} };
    expect(composeReferences(model, dockerfiles, features)).toEqual({
      images: ['node:24', 'postgres:16'],
      features: ['ghcr.io/devcontainers/features/node:1'],
    });
  });

  it('skips a built service without a Dockerfile, and works without Features', () => {
    expect(composeReferences({ services: { app: { build: { context: REPO } } } }, {}, undefined)).toEqual({ images: [], features: [] });
  });
});

describe('composeConfigHash', () => {
  it('is stable for the same model in another key order', () => {
    const a = composeConfigHash('{}', { services: { a: { image: 'x', ports: [] } }, name: 'p' }, { a: 'FROM x', b: 'FROM y' });
    const b = composeConfigHash('{}', { name: 'p', services: { a: { ports: [], image: 'x' } } }, { b: 'FROM y', a: 'FROM x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each<[string, Parameters<typeof composeConfigHash>]>([
    ['the configuration', ['{ }', { services: {} }, {}]],
    ['the model', ['{}', { services: { a: { image: 'y' } } }, {}]],
    ['a Dockerfile', ['{}', { services: {} }, { a: 'FROM z' }]],
  ])('changes with %s', (_name, args) => {
    expect(composeConfigHash(...args)).not.toBe(composeConfigHash('{}', { services: {} }, {}));
  });
});

describe('builtServiceImages and composeUserArgs', () => {
  it('names the built services and the dev service', () => {
    const model: ComposeModel = { services: { app: { image: 'node:24' }, worker: { build: { context: REPO } }, db: { image: 'postgres' } } };
    expect(builtServiceImages(model, PROJECT, 'app')).toEqual([`${PROJECT}-app`, `${PROJECT}-worker`]);
  });

  it.each<[unknown, string[]]>([
    [{ user: 'node' }, ['--user', 'node']],
    [{ user: '1000:1000' }, ['--user', '1000:1000']],
    [{ user: ' ' }, []],
    [{}, []],
    [undefined, []],
  ])('composeUserArgs(%j)', (service, args) => {
    expect(composeUserArgs(service as Record<string, unknown> | undefined)).toEqual(args);
  });
});

describe('decideServicePort (ports on 127.0.0.1 only)', () => {
  it.each<[string, unknown, ReturnType<typeof decideServicePort>]>([
    ['no address', { target: 5432, published: '5432', protocol: 'tcp' }, { action: 'replace', value: { target: 5432, published: '5432', protocol: 'tcp', host_ip: '127.0.0.1' }, reason: 'published on 127.0.0.1 only' }],
    ['an empty address', { target: 80, host_ip: '' }, { action: 'replace', value: { target: 80, host_ip: '127.0.0.1' }, reason: 'published on 127.0.0.1 only' }],
    ['no published port (a random port)', { target: 80 }, { action: 'replace', value: { target: 80, host_ip: '127.0.0.1' }, reason: 'published on 127.0.0.1 only' }],
    ['a range', { target: 80, published: '8000-8010' }, { action: 'replace', value: { target: 80, published: '8000-8010', host_ip: '127.0.0.1' }, reason: 'published on 127.0.0.1 only' }],
    ['127.0.0.1', { target: 80, published: '8080', host_ip: '127.0.0.1' }, { action: 'keep' }],
    ['127.0.0.2', { target: 80, host_ip: '127.0.0.2' }, { action: 'keep' }],
    ['::1', { target: 80, host_ip: '::1' }, { action: 'keep' }],
    ['0.0.0.0', { target: 80, published: '8080', host_ip: '0.0.0.0' }, { action: 'refuse', kind: 'hostAccess', item: 'published port 0.0.0.0:8080:80' }],
    ['::', { target: 80, published: '8080', host_ip: '::' }, { action: 'refuse', kind: 'hostAccess', item: 'published port :::8080:80' }],
    ['a LAN address', { target: 80, host_ip: '192.168.1.5' }, { action: 'refuse', kind: 'hostAccess', item: 'published port 192.168.1.5::80' }],
    ['short syntax without an address', '8080:80', { action: 'replace', value: '127.0.0.1:8080:80', reason: 'published on 127.0.0.1 only' }],
    ['short syntax with a loopback address', '127.0.0.1:8080:80', { action: 'keep' }],
    ['short syntax with another address', '0.0.0.0:8080:80', { action: 'refuse', kind: 'hostAccess', item: 'published port 0.0.0.0:8080:80' }],
    ['a number', 80, { action: 'replace', value: '127.0.0.1::80', reason: 'published on 127.0.0.1 only' }],
    ['a text with =', 'published=8080,target=80', { action: 'refuse', kind: 'unsupported', item: 'published port published=8080,target=80' }],
    ['no port', null, { action: 'refuse', kind: 'unsupported', item: 'published port null' }],
  ])('%s', (_name, entry, expected) => {
    expect(decideServicePort(entry)).toEqual(expected);
  });
});

describe('decideServiceMount (D-6, D-11)', () => {
  function context(overrides: Partial<ComposeMountContext> = {}): ComposeMountContext {
    return {
      isDev: false,
      repositoryFolder: REPO,
      volumeNames: new Map([
        ['pgdata', `${PROJECT}_pgdata`],
        ['ws', OWN],
      ]),
      ownVolume: OWN,
      engineApiVersion: '1.47',
      ...overrides,
    };
  }
  const dev = { isDev: true };
  const subpath = (sub: string, target: string, readOnly = false): ComposeEntryDecision => ({
    action: 'replace',
    value: { type: 'volume', source: WORKSPACE_VOLUME_KEY, target, volume: { nocopy: true, subpath: sub }, ...(readOnly ? { read_only: true } : {}) },
    reason: `the folder ${sub} of the workspace volume (the service can read and change these files of the repository)`,
  });

  // Package C of unit 6 (the switch of the host access checks for Compose): the refusals that stay refused whatever the
  // switch says carry `guarded: true` (HostAccessClass `protected`): the workspace volume with the GitHub token in
  // another service, and a link out of the repository, whose target is not clear.
  it.each<[string, unknown, Partial<ComposeMountContext>, ReturnType<typeof decideServiceMount>]>([
    ['a tmpfs', { type: 'tmpfs', target: '/tmp/x' }, {}, { action: 'keep' }],
    ['an anonymous volume', { type: 'volume', target: '/data' }, {}, { action: 'keep' }],
    ['a named volume', { type: 'volume', source: 'pgdata', target: '/data' }, {}, { action: 'keep' }],
    ['a named volume without type', { source: 'pgdata', target: '/data' }, {}, { action: 'keep' }],
    ['a volume that is not declared', { type: 'volume', source: 'nope', target: '/data' }, {}, { action: 'refuse', kind: 'unsupported', item: 'volume nope (not in the top-level volumes)' }],
    ['the workspace volume in another service', { type: 'volume', source: 'ws', target: '/w' }, {}, { action: 'refuse', kind: 'hostAccess', item: `volume ${OWN} (the workspace volume, which holds the GitHub token)`, guarded: true }],
    ['the workspace volume in the dev service', { type: 'volume', source: 'ws', target: '/w' }, dev, { action: 'keep' }],
    ['a volume at /workspaces in the dev service', { type: 'volume', source: 'pgdata', target: '/workspaces' }, dev, { action: 'refuse', kind: 'unsupported', item: 'mount at /workspaces' }],
    ['a tmpfs at /workspaces/ in the dev service', { type: 'tmpfs', target: '/workspaces/' }, dev, { action: 'refuse', kind: 'unsupported', item: 'mount at /workspaces' }],
    ['a volume at /workspaces in another service', { type: 'volume', source: 'pgdata', target: '/workspaces' }, {}, { action: 'keep' }],
    ['the templates\' ../..:/workspaces in the dev service', { type: 'bind', source: '/workspaces', target: '/workspaces' }, dev, { action: 'drop', reason: 'the workspace volume is mounted there' }],
    ['the repository at /workspaces in the dev service', { type: 'bind', source: `${REPO}/`, target: '/workspaces' }, dev, { action: 'drop', reason: 'the workspace volume is mounted there' }],
    ['the parent at another target in the dev service', { type: 'bind', source: '/workspaces', target: '/src', read_only: true }, dev, { action: 'replace', value: { type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/src', read_only: true }, reason: 'the workspace volume in place of the folder' }],
    ['the parent in another service', { type: 'bind', source: '/workspaces', target: '/workspaces' }, {}, { action: 'refuse', kind: 'hostAccess', item: 'bind mount /workspaces → /workspaces (the workspace volume, which holds the GitHub token)', guarded: true }],
    ['the repository in another service', { type: 'bind', source: REPO, target: '/app' }, {}, subpath('api', '/app')],
    ['the repository at /workspace (older templates) in the dev service', { type: 'bind', source: REPO, target: '/workspace' }, dev, subpath('api', '/workspace')],
    ['a file of the repository, read-only', { type: 'bind', source: `${REPO}/init.sql`, target: '/docker-entrypoint-initdb.d/init.sql', read_only: true }, {}, subpath('api/init.sql', '/docker-entrypoint-initdb.d/init.sql', true)],
    ['a folder of the repository in the dev service', { type: 'bind', source: `${REPO}/data`, target: '/data' }, dev, subpath('api/data', '/data')],
    ['a folder of the repository at /workspaces in the dev service', { type: 'bind', source: `${REPO}/data`, target: '/workspaces' }, dev, { action: 'refuse', kind: 'unsupported', item: 'mount at /workspaces' }],
    ['repository files with an old engine', { type: 'bind', source: `${REPO}/init.sql`, target: '/i.sql' }, { engineApiVersion: '1.44' }, { action: 'refuse', kind: 'unsupported', item: `bind mount ${REPO}/init.sql → /i.sql (needs Docker Engine 26 or newer)` }],
    // Review round 1 (P-5): an unknown version is named as unknown, not as an old engine.
    ['repository files with an unknown engine', { type: 'bind', source: `${REPO}/init.sql`, target: '/i.sql' }, { engineApiVersion: undefined }, { action: 'refuse', kind: 'unsupported', item: `bind mount ${REPO}/init.sql → /i.sql (needs Docker Engine 26 or newer; the version of the Docker Engine could not be read)` }],
    ['a link out of the repository', { type: 'bind', source: `${REPO}/data`, target: '/d' }, { realPaths: { [`${REPO}/data`]: '/workspaces/.devenv+' } }, { action: 'refuse', kind: 'hostAccess', item: `bind mount ${REPO}/data → /d (a link to /workspaces/.devenv+, outside of the repository)`, guarded: true }],
    ['a link in the repository', { type: 'bind', source: `${REPO}/data`, target: '/d' }, { realPaths: { [`${REPO}/data`]: `${REPO}/real` } }, subpath('api/data', '/d')],
    ['a path that does not exist', { type: 'bind', source: `${REPO}/data`, target: '/d' }, { realPaths: { [`${REPO}/data`]: null } }, { action: 'refuse', kind: 'unsupported', item: `bind mount ${REPO}/data → /d (the path does not exist in the repository)` }],
    ['a sibling that starts like the repository', { type: 'bind', source: '/workspaces/api2', target: '/x' }, {}, { action: 'refuse', kind: 'hostAccess', item: 'bind mount /workspaces/api2 → /x' }],
    ['the configuration folder of the volume', { type: 'bind', source: '/workspaces/.devenv+', target: '/x' }, dev, { action: 'refuse', kind: 'hostAccess', item: 'bind mount /workspaces/.devenv+ → /x' }],
    ['.. out of the repository', { type: 'bind', source: `${REPO}/../other`, target: '/x' }, {}, { action: 'refuse', kind: 'hostAccess', item: `bind mount ${REPO}/../other → /x` }],
    ['the Docker socket', { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }, dev, { action: 'refuse', kind: 'hostAccess', item: 'bind mount /var/run/docker.sock → /var/run/docker.sock' }],
    ['a relative source', { type: 'bind', source: './x', target: '/x' }, {}, { action: 'refuse', kind: 'hostAccess', item: 'bind mount ./x → /x' }],
    ['a named pipe', { type: 'npipe', source: '\\\\.\\pipe\\docker_engine', target: '/p' }, {}, { action: 'refuse', kind: 'unsupported', item: 'mount of the type npipe (\\\\.\\pipe\\docker_engine → /p)' }],
    ['an image mount', { type: 'image', source: 'alpine', target: '/i' }, {}, { action: 'refuse', kind: 'unsupported', item: 'mount of the type image (alpine → /i)' }],
    ['no target', { type: 'volume', source: 'pgdata' }, {}, { action: 'refuse', kind: 'unsupported', item: 'volume pgdata → undefined without a target' }],
    ['a text', 'pgdata:/data', {}, { action: 'refuse', kind: 'unsupported', item: 'volume "pgdata:/data"' }],
  ])('%s', (_name, entry, overrides, expected) => {
    expect(decideServiceMount(entry, context(overrides))).toEqual(expected);
  });
});

describe('composeUpModel', () => {
  const up = (model: ComposeModel, overrides: Partial<ComposeRewriteParams> = {}) =>
    composeUpModel(model, { ...params(overrides), image: 'devenv-3f2a9c1e:7' });

  it('rewrites the template model as the implementation notes show it', () => {
    const { model, rewrites } = up(templateModel());
    expect(model).toEqual({
      name: PROJECT,
      services: {
        app: {
          image: 'devenv-3f2a9c1e:7',
          pull_policy: 'never',
          container_name: OWN,
          command: ['sleep', 'infinity'],
          networks: { default: null },
          environment: { POSTGRES_HOST: 'db' },
          labels: { 'devenv.environment-id': ID, 'devenv.container-version': String(CONTAINER_VERSION) },
          volumes: [{ type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/workspaces' }],
          // Package C of unit 6: the dev container is named after the repository, as a single container (containerHostname).
          hostname: 'api',
        },
        db: {
          image: 'postgres:16',
          pull_policy: 'missing',
          restart: 'unless-stopped',
          labels: { 'devenv.environment-id': ID, 'devenv.compose-service': 'db' },
          ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp', host_ip: '127.0.0.1' }],
          volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} }],
          networks: { default: null },
        },
      },
      networks: { default: { name: `${PROJECT}_default` } },
      volumes: {
        pgdata: { name: `${PROJECT}_pgdata`, external: true },
        [WORKSPACE_VOLUME_KEY]: { name: OWN, external: true },
      },
    });
    expect(rewrites).toEqual([
      { item: 'service app: bind mount /workspaces → /workspaces', reason: 'the workspace volume is mounted there' },
      { item: 'service db: container_name db1', reason: 'removed: two environments of one repository would use the same name' },
      { item: 'service db: port 5432:5432', reason: 'published on 127.0.0.1 only' },
      { item: 'service app: build', reason: 'the environment image devenv-3f2a9c1e:7 is used' },
    ]);
  });

  it('does not change the model that it gets', () => {
    const model = templateModel();
    const before = JSON.stringify(model);
    up(model);
    composeBuildModel(model, params());
    expect(JSON.stringify(model)).toBe(before);
  });

  it('keeps the labels of the repository, and replaces the values of the own labels', () => {
    const model = templateModel();
    model.services.app.labels = { team: 'a', 'devenv.environment-id': 'forged' };
    model.services.db.labels = ['tier=data', 'devenv.compose-service=app'];
    const result = up(model).model;
    expect(result.services.app.labels).toEqual({ team: 'a', 'devenv.environment-id': ID, 'devenv.container-version': String(CONTAINER_VERSION) });
    expect(result.services.db.labels).toEqual({ tier: 'data', 'devenv.environment-id': ID, 'devenv.compose-service': 'db' });
  });

  it('gives the dev container the name of the environment, and logs a different name of the repository', () => {
    const model = templateModel();
    model.services.app.container_name = 'my-app';
    const { model: result, rewrites } = up(model);
    expect(result.services.app.container_name).toBe(OWN);
    expect(rewrites).toContainEqual({ item: 'service app: container_name my-app', reason: `the container gets the name of the environment, ${OWN}` });
  });

  it('names the images of built side services after the project, and logs a changed pull_policy', () => {
    const model = templateModel();
    model.services.worker = { build: { context: REPO }, image: 'acme/worker:latest', pull_policy: 'always' };
    const { model: result, rewrites } = up(model);
    expect(result.services.worker).toMatchObject({ image: `${PROJECT}-worker`, pull_policy: 'missing', build: { context: REPO } });
    expect(rewrites).toContainEqual({ item: 'service worker: image acme/worker:latest', reason: `the built image is named ${PROJECT}-worker` });
    expect(rewrites).toContainEqual({ item: 'service worker: pull_policy always', reason: 'Dev Environments pulls the images itself (missing)' });
  });

  it('keeps network_mode service:<name> of a service of the model (D-9)', () => {
    const model = templateModel();
    model.services.app.network_mode = 'service:db';
    delete model.services.app.networks;
    expect(up(model).model.services.app.network_mode).toBe('service:db');
  });

  it('mounts repository files from the workspace volume, and keeps the other mounts in order', () => {
    const model = templateModel();
    model.services.db.volumes = [
      { type: 'bind', source: `${REPO}/init.sql`, target: '/docker-entrypoint-initdb.d/init.sql', read_only: true, bind: { create_host_path: true } },
      { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' },
      { type: 'tmpfs', target: '/run' },
    ];
    const { model: result, rewrites } = up(model);
    expect(result.services.db.volumes).toEqual([
      { type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/docker-entrypoint-initdb.d/init.sql', read_only: true, volume: { nocopy: true, subpath: 'api/init.sql' } },
      { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' },
      { type: 'tmpfs', target: '/run' },
    ]);
    expect(rewrites).toContainEqual({
      item: `service db: bind mount ${REPO}/init.sql → /docker-entrypoint-initdb.d/init.sql`,
      reason: 'the folder api/init.sql of the workspace volume (the service can read and change these files of the repository)',
    });
  });

  it('declares every volume external: named, external, the workspace volume, and the volumes of `mounts`', () => {
    const model = templateModel();
    model.volumes = { pgdata: { name: `${PROJECT}_pgdata`, labels: { a: 'b' }, driver: 'local' }, cache: { name: 'shared-cache' }, old: { external: true, name: 'old' } };
    const result = up(model, { mountVolumeSources: ['history', 'pgdata'] }).model;
    expect(result.volumes).toEqual({
      pgdata: { name: `${PROJECT}_pgdata`, external: true },
      cache: { name: 'shared-cache', external: true },
      old: { name: 'old', external: true },
      history: { name: `${PROJECT}_history`, external: true },
      [WORKSPACE_VOLUME_KEY]: { name: OWN, external: true },
    });
  });

  it('sets the project name, and logs another one', () => {
    const model = templateModel();
    model.name = 'api_devcontainer';
    const { model: result, rewrites } = up(model);
    expect(result.name).toBe(PROJECT);
    expect(rewrites).toContainEqual({ item: 'project name api_devcontainer', reason: `the project of the environment is ${PROJECT}` });
  });

  it('escapes $ when the output of Docker Compose does not, and not when it does', () => {
    const model = templateModel();
    model.services.app.environment = { A: 'a$b' };
    expect(up(model, { dollarEscaped: false }).model.services.app.environment).toEqual({ A: 'a$$b' });
    expect(up(model, { dollarEscaped: true }).model.services.app.environment).toEqual({ A: 'a$b' });
  });

  it.each<[string, (model: ComposeModel) => void, RegExp]>([
    ['a dev service that is not in the model', (model) => delete model.services.app, /no service app/],
    ['a published port on all addresses', (model) => ((model.services.db.ports as unknown[])[0] = { target: 1, host_ip: '0.0.0.0' }), /published port 0\.0\.0\.0/],
    ['a bind mount of the computer', (model) => (model.services.db.volumes = [{ type: 'bind', source: '/etc', target: '/etc' }]), /bind mount \/etc/],
    ['repository files with an old engine', (model) => (model.services.db.volumes = [{ type: 'bind', source: `${REPO}/x`, target: '/x' }]), /Docker Engine 26/],
  ])('throws for a model that the check refuses: %s', (_name, change, message) => {
    const model = templateModel();
    change(model);
    expect(() => up(model, { engineApiVersion: '1.43' })).toThrow(message);
  });
});

describe('composeBuildModel', () => {
  it('builds the dev service of the repository as <project>-<service>', () => {
    const { model, devDockerfile } = composeBuildModel(templateModel(), params());
    expect(devDockerfile).toBeUndefined();
    expect(model.services.app).toMatchObject({
      image: `${PROJECT}-app`,
      build: { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile' },
      container_name: OWN,
      pull_policy: 'never',
    });
    // The other rewrites are those of the up model.
    expect(model.services.db.ports).toEqual([{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp', host_ip: '127.0.0.1' }]);
    expect(model.services.db.container_name).toBeUndefined();
    expect(model.volumes?.[WORKSPACE_VOLUME_KEY]).toEqual({ name: OWN, external: true });
  });

  it('synthesizes a build for an image-only dev service (D-8)', () => {
    const source = templateModel();
    source.services.app = { image: 'mcr.microsoft.com/devcontainers/python:3.12' };
    const { model, devDockerfile } = composeBuildModel(source, params());
    expect(devDockerfile).toBe('FROM mcr.microsoft.com/devcontainers/python:3.12\n');
    expect(model.services.app).toMatchObject({
      image: `${PROJECT}-app`,
      build: { context: COMPOSE_BUILD_CONTEXT, dockerfile: COMPOSE_DEV_DOCKERFILE },
    });
  });

  it('writes a dockerfile_inline of the dev service to a file, which the CLI reads', () => {
    const source = templateModel();
    source.services.app.build = { context: REPO, dockerfile_inline: 'FROM alpine:3.22\nRUN echo $$HOME\n' };
    const escaped = composeBuildModel(source, params({ dollarEscaped: true }));
    expect(escaped.devDockerfile).toBe('FROM alpine:3.22\nRUN echo $HOME\n');
    expect(escaped.model.services.app.build).toEqual({ context: REPO, dockerfile: COMPOSE_DEV_DOCKERFILE });
    source.services.app.build = { context: REPO, dockerfile_inline: 'FROM alpine:3.22\nRUN echo $HOME\n' };
    expect(composeBuildModel(source, params({ dollarEscaped: false })).devDockerfile).toBe('FROM alpine:3.22\nRUN echo $HOME\n');
  });

  it('throws for a dev service without image and build', () => {
    const source = templateModel();
    source.services.app = { command: ['sleep'] };
    expect(() => composeBuildModel(source, params())).toThrow(/no image and no build/);
  });
});

describe('escapeComposeDollars', () => {
  it('escapes texts, not keys, at every depth', () => {
    expect(escapeComposeDollars({ $k: ['a$', { b: '$$' }, 1, null, true] })).toEqual({ $k: ['a$$', { b: '$$$$' }, 1, null, true] });
  });
});

describe('review round 1 of unit 6', () => {
  const P = 'devenv-3f2a9c1e';
  const m: ComposeModel = {
    name: P,
    services: {
      app: { image: 'mcr.microsoft.com/devcontainers/base:ubuntu', volumes: [{ type: 'volume', source: 'cache', target: '/c' }], network_mode: 'service:db' },
      db: { image: ' postgres:16 ', volumes: [{ type: 'volume', source: 'pgdata', target: '/d' }, { type: 'volume', target: '/anon' }, { type: 'tmpfs', target: '/t' }] },
      worker: { build: { context: '/workspaces/api' }, image: 'x', volumes: [{ type: 'volume', source: 'shared', target: '/s' }], network_mode: 'backend' },
      tool: { image: 'alpine:3.22', network_mode: 'host' },
    },
    volumes: { pgdata: { name: 'myapp-db' }, cache: { name: `${P}_cache` }, shared: { name: 'shared', external: true } },
    networks: { default: { name: `${P}_default` }, other: { external: true }, named: { name: 'backend' } },
  };

  it('composeServiceVolumeNames: the named volumes that the other services mount (D1)', () => {
    expect(composeServiceVolumeNames(m, P, 'app')).toEqual(['myapp-db', 'shared']);
  });

  it('composeServiceImageReferences: the images of the other services that are not built (D5)', () => {
    expect(composeServiceImageReferences(m, 'app')).toEqual(['alpine:3.22', 'postgres:16']);
  });

  it('composeNetworkNames and composeNetworkReferences: the Docker names of the networks, and the networks of network_mode (S2)', () => {
    expect(composeNetworkNames(m, P)).toEqual([
      { key: 'default', name: `${P}_default` },
      { key: 'other', name: 'other' },
      { key: 'named', name: 'backend' },
    ]);
    expect(composeNetworkReferences(m, P)).toEqual([`${P}_default`, 'other', 'backend']);
  });

  it('composeInputsHash: depends on the files, not on the model (P-4)', () => {
    const a = composeInputsHash('{}', 'x', { app: 'FROM a' });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(composeInputsHash('{}', 'x', { app: 'FROM a' })).toBe(a);
    expect(composeInputsHash('{}', 'y', { app: 'FROM a' })).not.toBe(a);
    expect(composeInputsHash('{ }', 'x', { app: 'FROM a' })).not.toBe(a);
    expect(composeInputsHash('{}', 'x', { app: 'FROM b' })).not.toBe(a);
  });
});
