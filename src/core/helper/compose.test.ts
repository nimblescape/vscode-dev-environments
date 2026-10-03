// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { CONTAINER_VERSION, TOKEN_TMPFS, composeProjectName, environmentImageRepository, resourceName } from '../names';
import {
  COMPOSE_BUILD_CONTEXT,
  COMPOSE_DEV_DOCKERFILE,
  COMPOSE_MODEL_PATH,
  WORKSPACE_VOLUME_KEY,
  builtServiceImages,
  composeBuildModel,
  composeConfigHash,
  composeInputsHash,
  composeModelLimit,
  composeMountVolumeName,
  composeNetworkNames,
  composeNetworkReferences,
  composeReferences,
  composeServiceImage,
  composeServiceImageReferences,
  composeServiceVolumeNames,
  composeUpModel,
  composeUserArgs,
  type ComposeModelOutput,
  composeVolumeNames,
  escapeComposeDollars,
  isSupportedComposeVersion,
  parseComposeModelOutput,
  resolveComposeFiles,
  supportsVolumeSubpath,
  type ComposeModel,
  type ComposeRewriteParams,
} from './compose';
import { OVERRIDE_FOLDER } from './scripts';
import {
  decideServiceMount,
  decideServicePort,
  isOtherEnvironmentProjectName,
  type ComposeEntryDecision,
  type ComposeMountContext,
} from '../policy';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
// User decisions 2026-10-03: one name per environment (resourceName), so the project, the volume, and the container
// share it (devenv-acme-api-wise-stallman).
const PROJECT = composeProjectName('acme/api', ID);
const OWN = resourceName('acme/api', ID);
/** The Compose project of an environment of another repository and ID. */
const OTHER_PROJECT = composeProjectName('acme/web', '11111111-2222-4333-8444-555555555555');
const REPO = '/workspaces/api';
const DEV_DOCKERFILE = 'FROM mcr.microsoft.com/devcontainers/base:bookworm\n';

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
    engineApiVersion: '1.47',
    // Review round 20 (P20-1): the Dockerfile of the dev service that the model run read (templateModel builds one).
    dockerfiles: { app: DEV_DOCKERFILE },
    ...overrides,
  };
}

describe('review round 22, H22-7', () => {
  it('has no parameter dollarEscaped of the rewrite any more (the written texts are always escaped)', () => {
    // @ts-expect-error review round 22, H22-7: ComposeRewriteParams.dollarEscaped is removed (tsc fails if it comes back).
    const p: ComposeRewriteParams = { ...params(), dollarEscaped: true };
    expect(composeUpModel(templateModel(), { ...p, image: `${PROJECT}:7` }).model.name).toBe(PROJECT);
  });
});

describe('names', () => {
  it('the project of an environment is its resourceName, the repository part of the environment image', () => {
    // User decisions 2026-10-03: composeProjectName(repository, id) = resourceName (before: devenv-<short id>).
    expect(composeProjectName('acme/api', ID)).toBe('devenv-acme-api-wise-stallman');
    expect(composeProjectName('acme/api', ID)).toBe(environmentImageRepository('acme/api', ID));
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
    // User decisions 2026-10-03: the prefix before the first `_` is the name of another environment (before: devenv-<8 hex>).
    [`${OTHER_PROJECT}_default`, true],
    [`${OTHER_PROJECT.toUpperCase()}_data`, true],
    [`${composeProjectName('acme/api', '11111111-2222-4333-8444-555555555555')}_default`, true],
    // Review round 1 of PR #88 (B-R1-2): a key with `_` of its own; the project is what comes before the first `_`.
    [`${OTHER_PROJECT}_my_data`, true],
    [`${PROJECT}_my_data`, false],
    [`${PROJECT}_default`, false],
    [`${PROJECT.toUpperCase()}_default`, false],
    ['devenv-tools_default', false],
    ['devenv-11111111_default', false],
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
    // unit 15: the workspace volume no longer holds the GitHub token (it is in the memory of the dev container).
    ['the workspace volume in another service', { type: 'volume', source: 'ws', target: '/w' }, {}, { action: 'refuse', kind: 'hostAccess', item: `volume ${OWN} (the workspace volume, with the repository and the Git configuration of the environment)`, guarded: true }],
    ['the workspace volume in the dev service', { type: 'volume', source: 'ws', target: '/w' }, dev, { action: 'keep' }],
    ['a volume at /workspaces in the dev service', { type: 'volume', source: 'pgdata', target: '/workspaces' }, dev, { action: 'refuse', kind: 'unsupported', item: 'mount at /workspaces' }],
    ['a tmpfs at /workspaces/ in the dev service', { type: 'tmpfs', target: '/workspaces/' }, dev, { action: 'refuse', kind: 'unsupported', item: 'mount at /workspaces' }],
    ['a volume at /workspaces in another service', { type: 'volume', source: 'pgdata', target: '/workspaces' }, {}, { action: 'keep' }],
    ['the templates\' ../..:/workspaces in the dev service', { type: 'bind', source: '/workspaces', target: '/workspaces' }, dev, { action: 'drop', reason: 'the workspace volume is mounted there' }],
    ['the repository at /workspaces in the dev service', { type: 'bind', source: `${REPO}/`, target: '/workspaces' }, dev, { action: 'drop', reason: 'the workspace volume is mounted there' }],
    ['the parent at another target in the dev service', { type: 'bind', source: '/workspaces', target: '/src', read_only: true }, dev, { action: 'replace', value: { type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/src', read_only: true }, reason: 'the workspace volume in place of the folder' }],
    // unit 15: the workspace volume no longer holds the GitHub token (it is in the memory of the dev container).
    ['the parent in another service', { type: 'bind', source: '/workspaces', target: '/workspaces' }, {}, { action: 'refuse', kind: 'hostAccess', item: 'bind mount /workspaces → /workspaces (the workspace volume, with the repository and the Git configuration of the environment)', guarded: true }],
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
    composeUpModel(model, { ...params(overrides), image: `${PROJECT}:7` });

  it('rewrites the template model as the implementation notes show it', () => {
    const { model, rewrites } = up(templateModel());
    expect(model).toEqual({
      name: PROJECT,
      services: {
        app: {
          image: `${PROJECT}:7`,
          pull_policy: 'never',
          container_name: OWN,
          command: ['sleep', 'infinity'],
          networks: { default: null },
          environment: { POSTGRES_HOST: 'db' },
          // Review round 2 (D2-2): changed expectation, nimblescape.devenv.host-access set on every service.
          labels: { 'nimblescape.devenv.environment-id': ID, 'nimblescape.devenv.container-version': String(CONTAINER_VERSION), 'nimblescape.devenv.host-access': 'checked' },
          volumes: [{ type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/workspaces' }],
          // Package C of unit 6: the dev container is named after the repository, as a single container (containerHostname).
          hostname: 'api',
          // unit 15: changed expectation, the tmpfs of the token, only in the dev container.
          tmpfs: ['/run/devenv:rw,nosuid,nodev,noexec,size=1m,mode=0700'],
        },
        db: {
          image: 'postgres:16',
          pull_policy: 'missing',
          // Review round 7, P7-1: changed expectation, `restart: unless-stopped` is rewritten to `no`.
          restart: 'no',
          labels: { 'nimblescape.devenv.environment-id': ID, 'nimblescape.devenv.compose-service': 'db', 'nimblescape.devenv.host-access': 'checked' },
          ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp', host_ip: '127.0.0.1' }],
          volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} }],
          networks: { default: null },
        },
      },
      // User decisions 2026-10-03: changed expectation, every network that Compose creates carries the environment ID.
      networks: { default: { name: `${PROJECT}_default`, labels: { 'nimblescape.devenv.environment-id': ID } } },
      volumes: {
        pgdata: { name: `${PROJECT}_pgdata`, external: true },
        [WORKSPACE_VOLUME_KEY]: { name: OWN, external: true },
      },
    });
    expect(rewrites).toEqual([
      { item: 'service app: bind mount /workspaces → /workspaces', reason: 'the workspace volume is mounted there' },
      { item: 'service db: container_name db1', reason: 'removed: two environments of one repository would use the same name' },
      { item: 'service db: port 5432:5432', reason: 'published on 127.0.0.1 only' },
      // Review round 7, P7-1: changed expectation, the rewrite of `restart` is logged.
      { item: 'service db: restart unless-stopped', reason: 'Dev Environments starts the containers itself (no)' },
      { item: 'service app: build', reason: `the environment image ${PROJECT}:7 is used` },
    ]);
  });

  // Review round 7, P7-1: the templates (Python & PostgreSQL, …) set `restart: unless-stopped` on the database.
  it.each<[string, unknown, unknown]>([
    ['always', 'always', 'no'],
    ['unless-stopped', 'unless-stopped', 'no'],
    ['no', 'no', 'no'],
    // Review round 8, S8-6: changed expectations, `on-failure` is rewritten to `no` too (Docker restarts such a container
    // when the Docker daemon starts).
    ['on-failure', 'on-failure', 'no'],
    ['on-failure:3', 'on-failure:3', 'no'],
  ])('rewrites restart %s to a restart that Docker does not start by itself', (_name, value, expected) => {
    for (const service of ['app', 'db']) {
      const model = templateModel();
      model.services[service].restart = value;
      const { model: result, rewrites } = up(model);
      expect(result.services[service].restart).toBe(expected);
      const logged = rewrites.some((entry) => entry.item === `service ${service}: restart ${String(value)}`);
      expect(logged).toBe(expected !== value);
      expect(composeBuildModel(model, params()).model.services[service].restart).toBe(expected);
    }
  });

  it('leaves a missing restart missing', () => {
    const model = templateModel();
    delete model.services.db.restart;
    const { model: result, rewrites } = up(model);
    expect(result.services.db.restart).toBeUndefined();
    expect(rewrites.some((entry) => entry.item.includes('restart'))).toBe(false);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, boolean]>([
    ['condition any', { condition: 'any' }, { condition: 'none' }, true],
    // Review round 8, P8-1: changed expectation, `max_attempts` is removed with the condition `none`.
    ['no condition', { max_attempts: 3 }, { condition: 'none' }, true],
    ['an empty restart_policy', {}, { condition: 'none' }, true],
    ['condition none', { condition: 'none' }, { condition: 'none' }, false],
    // Review round 8, S8-6 and P8-1: changed expectation, `on-failure` becomes `none`, without `max_attempts`.
    ['condition on-failure', { condition: 'on-failure', max_attempts: 2 }, { condition: 'none' }, true],
  ])('rewrites deploy.restart_policy with %s (review round 7, P7-1)', (_name, policy, expected, logged) => {
    const model = templateModel();
    model.services.db.deploy = { resources: { limits: { memory: '1g' } }, restart_policy: policy };
    const { model: result, rewrites } = up(model);
    expect(result.services.db.deploy).toEqual({ resources: { limits: { memory: '1g' } }, restart_policy: expected });
    expect(rewrites.some((entry) => entry.item.startsWith('service db: deploy.restart_policy.condition'))).toBe(logged);
    expect(model.services.db.deploy).toEqual({ resources: { limits: { memory: '1g' } }, restart_policy: policy });
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
    model.services.app.labels = { team: 'a', 'nimblescape.devenv.environment-id': 'forged' };
    model.services.db.labels = ['tier=data', 'nimblescape.devenv.compose-service=app'];
    const result = up(model).model;
    // Review round 2 (D2-2): changed expectation, nimblescape.devenv.host-access set on every service.
    expect(result.services.app.labels).toEqual({ team: 'a', 'nimblescape.devenv.environment-id': ID, 'nimblescape.devenv.container-version': String(CONTAINER_VERSION), 'nimblescape.devenv.host-access': 'checked' });
    expect(result.services.db.labels).toEqual({ tier: 'data', 'nimblescape.devenv.environment-id': ID, 'nimblescape.devenv.compose-service': 'db', 'nimblescape.devenv.host-access': 'checked' });
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

  it('escapes $ whatever the output of Docker Compose', () => {
    const model = templateModel();
    model.services.app.environment = { A: 'a$b' };
    // review round 19, S19-1: changed expectation, the model holds the unescaped texts (COMPOSE_MODEL_SCRIPT unescapes
    // them), so the written model is escaped also when Compose prints $ as $$. Review round 22, H22-7: the rewrite has
    // no parameter dollarEscaped any more.
    expect(up(model).model.services.app.environment).toEqual({ A: 'a$$b' });
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
    // review round 20, P20-1: changed expectation, the checked Dockerfile text is written to COMPOSE_DEV_DOCKERFILE.
    expect(devDockerfile).toBe(DEV_DOCKERFILE);
    expect(model.services.app).toMatchObject({
      image: `${PROJECT}-app`,
      build: { context: `${REPO}/.devcontainer`, dockerfile: COMPOSE_DEV_DOCKERFILE },
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
    // review round 19, S19-1: changed expectation, the model holds the unescaped text (COMPOSE_MODEL_SCRIPT unescapes
    // it), which is written as it is, whatever Compose prints.
    source.services.app.build = { context: REPO, dockerfile_inline: 'FROM alpine:3.22\nRUN echo $HOME\n' };
    // Review round 22, H22-7: the rewrite has no parameter dollarEscaped any more.
    const escaped = composeBuildModel(source, params());
    expect(escaped.devDockerfile).toBe('FROM alpine:3.22\nRUN echo $HOME\n');
    // User decisions 2026-10-03: changed expectation, every built image carries the environment ID (build.labels).
    expect(escaped.model.services.app.build).toEqual({ context: REPO, dockerfile: COMPOSE_DEV_DOCKERFILE, labels: { 'nimblescape.devenv.environment-id': ID } });
  });

  // User decisions 2026-10-03: the images that Compose builds and the networks that it creates carry the environment ID.
  it('labels every built service with the environment ID, and keeps the build labels of the repository', () => {
    const source = templateModel();
    source.services.app.build = { context: `${REPO}/.devcontainer`, dockerfile: 'Dockerfile', labels: { team: 'a', 'nimblescape.devenv.environment-id': 'forged' } };
    source.services.worker = { build: { context: REPO, labels: ['tier=worker'] } };
    const { model } = composeBuildModel(source, params());
    expect((model.services.app.build as Record<string, unknown>).labels).toEqual({ team: 'a', 'nimblescape.devenv.environment-id': ID });
    expect((model.services.worker.build as Record<string, unknown>).labels).toEqual({ tier: 'worker', 'nimblescape.devenv.environment-id': ID });
    expect(model.services.db.build).toBeUndefined();
    // The up model builds side services too.
    const up = composeUpModel(source, { ...params(), image: `${PROJECT}:7` }).model;
    expect((up.services.worker.build as Record<string, unknown>).labels).toEqual({ tier: 'worker', 'nimblescape.devenv.environment-id': ID });
  });

  it('labels every network of the project with the environment ID, keeps its labels, and leaves an external network alone', () => {
    const source = templateModel();
    source.networks = {
      default: { name: `${PROJECT}_default` },
      back: { name: `${PROJECT}_back`, labels: { tier: 'back' } },
      shared: { name: 'shared', external: true },
      old: { name: 'old', external: { name: 'old' } },
    };
    for (const model of [composeBuildModel(source, params()).model, composeUpModel(source, { ...params(), image: `${PROJECT}:7` }).model]) {
      expect(model.networks).toEqual({
        default: { name: `${PROJECT}_default`, labels: { 'nimblescape.devenv.environment-id': ID } },
        back: { name: `${PROJECT}_back`, labels: { tier: 'back', 'nimblescape.devenv.environment-id': ID } },
        shared: { name: 'shared', external: true },
        old: { name: 'old', external: { name: 'old' } },
      });
    }
  });

  // Review round 5 of PR #88 (B-R5-5, mutant H2): a network declared without a body (`networks:\n  backend:`, null in
  // YAML) is created by Compose for the project, so it carries the environment ID too.
  it('B-R5-5: labels a network of the project that is declared without a body with the environment ID', () => {
    const source = templateModel();
    source.networks = { backend: null };
    for (const model of [composeBuildModel(source, params()).model, composeUpModel(source, { ...params(), image: `${PROJECT}:7` }).model]) {
      expect(model.networks).toEqual({ backend: { labels: { 'nimblescape.devenv.environment-id': ID } } });
    }
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
  const P = PROJECT;
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

describe('review round 5 of unit 6 (D5-1, D5-2)', () => {
  const up = (configPath: string | undefined) => composeUpModel(templateModel(), { ...params(), image: `${PROJECT}:7`, configPath }).model;

  it('labels only the dev service with the configuration path, so the other services stay the same for another configuration (D5-1)', () => {
    const first = up('.devcontainer/devcontainer.json');
    const second = up('.devcontainer/other/devcontainer.json');
    expect(first.services.app.labels).toMatchObject({ 'nimblescape.devenv.config-path': '.devcontainer/devcontainer.json' });
    expect(second.services.app.labels).toMatchObject({ 'nimblescape.devenv.config-path': '.devcontainer/other/devcontainer.json' });
    const others = Object.keys(first.services).filter((name) => name !== 'app');
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) {
      expect(first.services[name].labels).not.toHaveProperty(['nimblescape.devenv.config-path']);
      expect(second.services[name]).toEqual(first.services[name]);
    }
  });

  it('labels the dev service with a folder that has a backslash or a space (D5-2)', () => {
    for (const configPath of ['.devcontainer/a\\b/devcontainer.json', '.devcontainer/ /devcontainer.json']) {
      expect(up(configPath).services.app.labels).toMatchObject({ 'nimblescape.devenv.config-path': configPath });
    }
  });

  it('adds no label for a path that is no configuration path of the discovery (D5-2)', () => {
    for (const configPath of ['.devcontainer/a/b/devcontainer.json', '../x/devcontainer.json', '.devcontainer/../devcontainer.json']) {
      expect(up(configPath).services.app.labels).not.toHaveProperty(['nimblescape.devenv.config-path']);
    }
  });
});

describe('review round 8 of unit 6: the restart and the stop of the services', () => {
  const up = (model: ComposeModel) => composeUpModel(model, { ...params(), image: `${PROJECT}:7` });

  it('S8-6: rewrites restart on-failure[:n] and the condition on-failure to no and none, and logs it', () => {
    const model = templateModel();
    model.services.db.restart = 'on-failure:5';
    model.services.app.deploy = { restart_policy: { condition: 'on-failure' } };
    const { model: result, rewrites } = up(model);
    // Before: kept, and Docker starts such a container again when the Docker daemon starts.
    expect(result.services.db.restart).toBe('no');
    expect(result.services.app.deploy).toEqual({ restart_policy: { condition: 'none' } });
    expect(rewrites).toContainEqual({ item: 'service db: restart on-failure:5', reason: 'Dev Environments starts the containers itself (no)' });
    expect(rewrites).toContainEqual({ item: 'service app: deploy.restart_policy.condition on-failure', reason: 'Dev Environments starts the containers itself (none)' });
    expect(composeBuildModel(model, params()).model.services.db.restart).toBe('no');
  });

  it('P8-1: removes max_attempts where the condition is none (Docker Engine 25 refuses a count with no), and keeps delay and window', () => {
    // The example of the Docker documentation.
    const model = templateModel();
    model.services.db.deploy = { restart_policy: { condition: 'on-failure', delay: '5s', max_attempts: 3, window: '120s' } };
    const { model: result, rewrites } = up(model);
    expect(result.services.db.deploy).toEqual({ restart_policy: { condition: 'none', delay: '5s', window: '120s' } });
    expect(rewrites).toContainEqual({
      item: 'service db: deploy.restart_policy.max_attempts 3',
      reason: 'removed: Docker refuses a count of restarts with the restart policy none',
    });
    const none = templateModel();
    none.services.db.deploy = { restart_policy: { condition: 'none', max_attempts: 0 } };
    expect(up(none).model.services.db.deploy).toEqual({ restart_policy: { condition: 'none' } });
  });

  it('caps a stop_grace_period over 20 s at 20 s, and logs it', () => {
    for (const [value, expected, logged] of [
      ['1m0s', '20s', true],
      ['20s', '20s', false],
      ['2s', '2s', false],
      ['1h', '20s', true],
      [90, '20s', true],
    ] as const) {
      const model = templateModel();
      model.services.db.stop_grace_period = value;
      const { model: result, rewrites } = up(model);
      expect(result.services.db.stop_grace_period, String(value)).toBe(expected);
      expect(rewrites.some((entry) => entry.item === `service db: stop_grace_period ${String(value)}`)).toBe(logged);
      expect(composeBuildModel(model, params()).model.services.db.stop_grace_period).toBe(expected);
    }
    const { rewrites } = up({ ...templateModel(), services: { ...templateModel().services, db: { ...templateModel().services.db, stop_grace_period: '1m0s' } } });
    expect(rewrites).toContainEqual({
      item: 'service db: stop_grace_period 1m0s',
      reason: 'the Session Monitor stops a container within 30 s (20s)',
    });
  });
});

describe('review round 8 of unit 6 (P8-2): a bind mount of a repository folder that does not exist yet', () => {
  const SOURCE = `${REPO}/data/postgres`;
  const entry = (bind: Record<string, unknown> = { create_host_path: true }) => ({ type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind });
  const context = (mountAncestors: Record<string, string | null> | undefined, realPaths: Record<string, string | null> = { [SOURCE]: null }): ComposeMountContext => ({
    isDev: false,
    repositoryFolder: REPO,
    volumeNames: new Map(),
    ownVolume: OWN,
    engineApiVersion: '1.47',
    realPaths,
    ...(mountAncestors !== undefined ? { mountAncestors } : {}),
  });

  it('mounts the folder of the workspace volume, and names it to be created before up', () => {
    // Before: refused (the path does not exist in the repository).
    expect(decideServiceMount(entry(), context({ [SOURCE]: REPO }))).toEqual({
      action: 'replace',
      value: { type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/var/lib/postgresql/data', volume: { nocopy: true, subpath: 'api/data/postgres' } },
      reason: 'the folder api/data/postgres of the workspace volume, created in the repository before the start (the service can read and change these files of the repository)',
      createFolder: SOURCE,
    });
    // A nearest folder that exists deeper in the repository (also through a link that stays in it).
    expect(decideServiceMount(entry({}), context({ [SOURCE]: `${REPO}/data` }))).toMatchObject({ action: 'replace', createFolder: SOURCE });
    const model = templateModel();
    model.services.db.volumes = [entry()];
    const result = composeUpModel(model, { ...params({ realPaths: { [SOURCE]: null }, mountAncestors: { [SOURCE]: REPO } }), image: `${PROJECT}:7` });
    expect(result.createFolders).toEqual([SOURCE]);
    expect(result.model.services.db.volumes).toEqual([{ type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/var/lib/postgresql/data', volume: { nocopy: true, subpath: 'api/data/postgres' } }]);
    expect(result.rewrites).toContainEqual({ item: `service db: bind mount ${SOURCE} → /var/lib/postgresql/data`, reason: expect.stringContaining('created in the repository before the start') });
    // The build model does not create it (no container).
    expect(composeBuildModel(model, params({ realPaths: { [SOURCE]: null }, mountAncestors: { [SOURCE]: REPO } }))).not.toHaveProperty('createFolders');
    // An existing folder is not created.
    expect(composeUpModel(templateModel(), { ...params(), image: `${PROJECT}:7` })).not.toHaveProperty('createFolders');
  });

  it.each<[string, Record<string, unknown>, Record<string, string | null> | undefined, ComposeEntryDecision]>([
    ['create_host_path false', { create_host_path: false }, { [SOURCE]: REPO }, { action: 'refuse', kind: 'unsupported', item: `bind mount ${SOURCE} → /var/lib/postgresql/data (the path does not exist in the repository)` }],
    ['no nearest folder known (an older helper)', { create_host_path: true }, undefined, { action: 'refuse', kind: 'unsupported', item: `bind mount ${SOURCE} → /var/lib/postgresql/data (the path does not exist in the repository)` }],
    ['a nearest path that is no folder, or odd', { create_host_path: true }, { [SOURCE]: null }, { action: 'refuse', kind: 'unsupported', item: `bind mount ${SOURCE} → /var/lib/postgresql/data (the path does not exist in the repository)` }],
    ['a nearest folder that is a link out of the repository', { create_host_path: true }, { [SOURCE]: '/etc' }, { action: 'refuse', kind: 'hostAccess', item: `bind mount ${SOURCE} → /var/lib/postgresql/data (a link to /etc, outside of the repository)`, guarded: true }],
    ['a nearest folder of the workspace helper', { create_host_path: true }, { [SOURCE]: '/workspaces/.devenv+' }, { action: 'refuse', kind: 'hostAccess', item: `bind mount ${SOURCE} → /var/lib/postgresql/data (a link to /workspaces/.devenv+, outside of the repository)`, guarded: true }],
    ['a nearest folder next to the repository', { create_host_path: true }, { [SOURCE]: '/workspaces/api-other' }, { action: 'refuse', kind: 'hostAccess', item: `bind mount ${SOURCE} → /var/lib/postgresql/data (a link to /workspaces/api-other, outside of the repository)`, guarded: true }],
  ])('refuses it with %s', (_name, bind, ancestors, expected) => {
    expect(decideServiceMount(entry(bind), context(ancestors))).toEqual(expected);
  });

  it('names the paths of the repository that other services mount, not those of the dev service nor the repository itself (review round 9, D9-1)', () => {
    const model = templateModel();
    model.services.db.volumes = [
      entry(),
      { type: 'bind', source: `${REPO}/seed`, target: '/seed', read_only: true, bind: {} },
      { type: 'bind', source: REPO, target: '/src', bind: {} },
      { type: 'volume', source: 'pgdata', target: '/data', volume: {} },
    ];
    model.volumes = { pgdata: { name: `${PROJECT}_pgdata` } };
    model.services.app.volumes = [...(model.services.app.volumes as unknown[]), { type: 'bind', source: `${REPO}/dev-only`, target: '/dev-only', bind: {} }];
    const result = composeUpModel(model, { ...params({ realPaths: { [SOURCE]: null }, mountAncestors: { [SOURCE]: REPO } }), image: `${PROJECT}:7` });
    // Review round 10, D10-3: without the read-only mount ./seed (before: [SOURCE, `${REPO}/seed`]); the owner restores give
    // it back when root rewrote it.
    expect(result.serviceFolders).toEqual([SOURCE]);
    expect(composeUpModel(templateModel(), { ...params(), image: `${PROJECT}:7` })).not.toHaveProperty('serviceFolders');
  });

  it('reads the nearest folders of the model run, and ignores values that are no paths', () => {
    const line = JSON.stringify({ version: '2.40.3', dollarEscaped: true, model: { services: {} }, dockerfiles: {}, realPaths: {}, mountAncestors: { [SOURCE]: REPO, a: null, b: 3 } });
    expect(parseComposeModelOutput(line)).toMatchObject({ mountAncestors: { [SOURCE]: REPO, a: null } });
    expect(parseComposeModelOutput(line)).not.toHaveProperty(['mountAncestors', 'b']);
  });
});

describe('review round 9 (S9-1): the bounds of the model in the extension host', () => {
  const REPO_FOLDER = '/workspaces/api';

  // A model with `count` bind mounts whose host folders have to be created, and the time of its rewrite (the least of
  // `runs`, so that one pause of the runner does not count).
  function folderModel(count: number): ComposeModel {
    const volumes = Array.from({ length: count }, (_, i) => ({ type: 'bind', source: `${REPO_FOLDER}/d/${i}`, target: `/m/${i}`, bind: { create_host_path: true } }));
    return { name: PROJECT, services: { app: { image: 'ubuntu', command: ['sleep'] }, db: { image: 'postgres:16', volumes } } } as unknown as ComposeModel;
  }
  function rewriteFolders(model: ComposeModel): ReturnType<typeof composeUpModel> {
    const volumes = (model.services.db as { volumes: Array<{ source: string }> }).volumes;
    return composeUpModel(model, {
      project: PROJECT,
      devService: 'app',
      environmentId: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d',
      containerName: 'c',
      volumeName: 'devenv-x',
      repositoryFolder: REPO_FOLDER,
      engineApiVersion: '1.47',
      realPaths: Object.fromEntries(volumes.map((v) => [v.source, null])),
      mountAncestors: Object.fromEntries(volumes.map((v) => [v.source, REPO_FOLDER])),
      image: 'img',
    });
  }
  function rewriteTime(model: ComposeModel, runs: number): number {
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < runs; run++) {
      const start = performance.now();
      rewriteFolders(model);
      least = Math.min(least, performance.now() - start);
    }
    return least;
  }

  it('rewrites a model with 40000 folders to create in time that grows linearly with the folders', () => {
    // Before: 3 s for 40000 folders (createFolders.includes for each mount: quadratic). Changed check (the absolute
    // bound of 1 s failed on slow CI runners, 1073 ms and 1101 ms): the time for 40000 folders against the time for
    // 4000, whatever the speed of the runner: about 10 for the linear rewrite, about 50 for the quadratic one (the linear
    // parts of the rewrite weigh on both).
    const small = folderModel(4_000);
    const large = folderModel(40_000);
    rewriteTime(small, 1);
    const ratio = rewriteTime(large, 2) / rewriteTime(small, 3);
    expect(ratio).toBeLessThan(20);
    const up = rewriteFolders(large);
    expect(up.createFolders).toHaveLength(40_000);
    // The pipeline refuses such a model before (MAX_COMPOSE_MOUNTS).
    expect(composeModelLimit(large)).toBe('40000 mounts (at most 5000)');
    // Time enough for a quadratic rewrite to fail by the ratio, not by the time limit of the test.
  }, 30_000);

  it('names a model beyond the limits of services and mounts', () => {
    const services = (n: number, mounts = 0) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { image: 'alpine', volumes: Array.from({ length: mounts }, () => ({ type: 'tmpfs', target: '/t' })) }]));
    expect(composeModelLimit({ services: services(500, 10) } as ComposeModel)).toBeUndefined();
    expect(composeModelLimit({ services: services(501) } as ComposeModel)).toBe('501 services (at most 500)');
    expect(composeModelLimit({ services: services(2, 2501) } as ComposeModel)).toBe('5002 mounts (at most 5000)');
  });
});

describe('review round 9 (S9-2): each Dockerfile once in the output of the model run', () => {
  it('gives each service the text of its file, and refuses a file without a text', () => {
    const base = { version: '2.40.3', dollarEscaped: true, model: { services: {} }, realPaths: {} };
    const line = JSON.stringify({ ...base, dockerfiles: { inline: 'FROM a' }, dockerfileFiles: { s0: '/r/D', s1: '/r/D' }, dockerfileTexts: { '/r/D': 'FROM b' } });
    const parsed = parseComposeModelOutput(line);
    expect(parsed).toMatchObject({ dockerfiles: { inline: 'FROM a', s0: 'FROM b', s1: 'FROM b' } });
    expect(() => parseComposeModelOutput(JSON.stringify({ ...base, dockerfiles: {}, dockerfileFiles: { s0: '/r/X' }, dockerfileTexts: {} }))).toThrow('invalid Compose model');
    expect(() => parseComposeModelOutput(JSON.stringify({ ...base, dockerfiles: {}, dockerfileFiles: { s0: '/r/D' }, dockerfileTexts: { '/r/D': 3 } }))).toThrow('invalid Compose model');
    expect(() => parseComposeModelOutput(JSON.stringify({ ...base, dockerfiles: {}, dockerfileFiles: [] }))).toThrow('invalid Compose model');
  });
});

describe('review round 10 (D10-2, D10-3): the recorded paths of the repository that other services mount', () => {
  const up = (volumes: unknown[], overrides: Partial<ComposeRewriteParams> = {}) => {
    const model = templateModel();
    model.services.db.volumes = volumes;
    return composeUpModel(model, { ...params(overrides), image: `${PROJECT}:7` });
  };
  const bind = (source: string, extra: Record<string, unknown> = {}) => ({ type: 'bind', source, target: `/t${source.length}`, bind: {}, ...extra });

  it('records the real path of a mount behind a link in the repository too (D10-2)', () => {
    const result = up([bind(`${REPO}/data`)], { realPaths: { [`${REPO}/data`]: `${REPO}/.local/pg` } });
    // Before: only ./data; Docker resolves the subpath through the link, and ./.local/pg got the dev user as its owner.
    expect(result.serviceFolders).toEqual([`${REPO}/data`, `${REPO}/.local/pg`]);
    // The real path only when it differs and is below the repository folder.
    expect(up([bind(`${REPO}/data`)], { realPaths: { [`${REPO}/data`]: `${REPO}/data` } }).serviceFolders).toEqual([`${REPO}/data`]);
    expect(up([bind(`${REPO}/data`)], { realPaths: { [`${REPO}/data`]: REPO } }).serviceFolders).toEqual([`${REPO}/data`]);
  });

  it('records where a created folder below a linked folder lands (D10-2)', () => {
    const source = `${REPO}/data/pg`;
    const result = up([bind(source, { bind: { create_host_path: true } })], {
      realPaths: { [source]: null },
      mountAncestors: { [source]: `${REPO}/.local` },
      mountCreateTargets: { [source]: `${REPO}/.local/pg` },
    });
    expect(result.createFolders).toEqual([source]);
    expect(result.serviceFolders).toEqual([source, `${REPO}/.local/pg`]);
    const line = JSON.stringify({ version: '2.40.3', dollarEscaped: true, model: { services: {} }, dockerfiles: {}, realPaths: {}, mountCreateTargets: { [source]: `${REPO}/.local/pg`, b: 3 } });
    expect((parseComposeModelOutput(line) as ComposeModelOutput).mountCreateTargets).toEqual({ [source]: `${REPO}/.local/pg` });
  });

  it('does not record read-only mounts, nor .git or a path below it (D10-3)', () => {
    const result = up([
      bind(`${REPO}/init.sql`, { read_only: true }),
      bind(`${REPO}/nginx`, { read_only: true }),
      bind(`${REPO}/.git`),
      bind(`${REPO}/.git/hooks`),
      bind(`${REPO}/sub/.git`),
      bind(`${REPO}/frontend`),
      bind(`${REPO}/link`),
    ], { realPaths: { [`${REPO}/link`]: `${REPO}/.git/objects` } });
    // Before: every one of them, so the owner restores left the files that root rewrote to root.
    // 2026-10-01: the Switch branch command was dropped (user decision).
    expect(result.serviceFolders).toEqual([`${REPO}/frontend`, `${REPO}/link`]);
  });
});

describe('review round 10 (S10-1, S10-2): the bounds of the model in the extension host', () => {
  it('hashes one Dockerfile text that many services share once, and refuses a model whose Dockerfiles are too large together (S10-2)', () => {
    const text = `FROM alpine\nRUN echo ${'a'.repeat(1024 * 1024)}`;
    const services: Record<string, unknown> = { app: { image: 'alpine:3.22' } };
    const dockerfiles: Record<string, string> = {};
    for (let i = 0; i < 499; i++) {
      services[`s${i}`] = { build: { context: REPO, dockerfile: 'Dockerfile' } };
      dockerfiles[`s${i}`] = text;
    }
    // Before: no limit; 3 s and 1.7 GB in the extension host for the hashes, before the job size check of the worker.
    expect(composeModelLimit({ services } as unknown as ComposeModel, dockerfiles)).toBe(`more than ${32 * 1024 * 1024} characters of Dockerfiles of the services`);
    expect(composeModelLimit({ services } as unknown as ComposeModel, { s0: text })).toBeUndefined();
    // Within the limit (30 services with 1 MiB each): each distinct text is turned into JSON once.
    const some = Object.fromEntries(Object.entries(dockerfiles).slice(0, 30));
    const start = performance.now();
    const digest = composeInputsHash('{}', '', some);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rewrites a model with many services and top-level volumes in linear time, and caps the top-level maps (S10-1)', () => {
    const services: Record<string, unknown> = { app: { image: 'alpine:3.22' } };
    for (let i = 0; i < 499; i++) services[`s${i}`] = { image: 'alpine:3.22' };
    const volumes = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`v${i}`, { name: `x_v${i}` }]));
    const model = { services, volumes } as unknown as ComposeModel;
    expect(composeModelLimit(model)).toBeUndefined();
    const start = performance.now();
    composeBuildModel(model, params({ realPaths: {}, mountAncestors: {} }));
    // Before: the volume map was built once per service (500 x 5000).
    expect(performance.now() - start).toBeLessThan(500);
    const many = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`k${i}`, {}]));
    expect(composeModelLimit({ services: {}, volumes: many } as unknown as ComposeModel)).toBe('5001 top-level volumes (at most 5000)');
    expect(composeModelLimit({ services: {}, networks: many } as unknown as ComposeModel)).toBe('5001 top-level networks (at most 5000)');
    expect(composeModelLimit({ services: {}, configs: many } as unknown as ComposeModel)).toBe('5001 top-level configs (at most 5000)');
    expect(composeModelLimit({ services: {}, secrets: many } as unknown as ComposeModel)).toBe('5001 top-level secrets (at most 5000)');
  });
});

describe('decideServiceMount: the extension\'s internal folder (review round 14, S14-1)', () => {
  const INTERNAL = "mounts into the extension's internal folder are not supported";
  const context = (isDev: boolean): ComposeMountContext => ({
    isDev,
    repositoryFolder: REPO,
    volumeNames: new Map([
      ['pgdata', `${PROJECT}_pgdata`],
      ['ws', OWN],
    ]),
    ownVolume: OWN,
    engineApiVersion: '1.47',
  });
  const refused = (target: string) => ({ action: 'refuse', kind: 'unsupported', item: `mount at ${target} (${INTERNAL})` });

  it.each<[string, unknown, string]>([
    ['repository data (the probe of r14-S)', { type: 'bind', source: `${REPO}/pgdata`, target: '/workspaces/.devenv+/pg' }, '/workspaces/.devenv+/pg'],
    ['a .. alias', { type: 'bind', source: `${REPO}/`, target: '/workspaces/.devenv+/repo' }, '/workspaces/.devenv+/repo'],
    ['the parent of the repository', { type: 'bind', source: '/workspaces', target: '/workspaces/.devenv+/all' }, '/workspaces/.devenv+/all'],
    ['a named volume', { type: 'volume', source: 'pgdata', target: '/workspaces/.devenv+' }, '/workspaces/.devenv+'],
    ['the workspace volume', { type: 'volume', source: 'ws', target: '/workspaces/.devenv+/w' }, '/workspaces/.devenv+/w'],
    ['an anonymous volume, written with dots and slashes', { type: 'volume', target: '/workspaces/api/..//.devenv+/./x/' }, '/workspaces/.devenv+/x'],
    ['a tmpfs', { type: 'tmpfs', target: '/workspaces/.devenv+/gh' }, '/workspaces/.devenv+/gh'],
  ])('refuses %s in the dev service', (_name, entry, target) => {
    expect(decideServiceMount(entry, context(true))).toEqual(refused(target));
  });

  it('keeps /workspaces/.cache and /workspaces/.devenv+x in the dev service, and the folder in another service', () => {
    expect(decideServiceMount({ type: 'volume', source: 'pgdata', target: '/workspaces/.cache' }, context(true))).toEqual({ action: 'keep' });
    expect(decideServiceMount({ type: 'volume', source: 'pgdata', target: '/workspaces/.devenv+x' }, context(true))).toEqual({ action: 'keep' });
    expect(decideServiceMount({ type: 'tmpfs', target: '/workspaces/.devenv+x/y' }, context(true))).toEqual({ action: 'keep' });
    expect(decideServiceMount({ type: 'volume', source: 'pgdata', target: '/workspaces/.devenv+/pg' }, context(false))).toEqual({ action: 'keep' });
  });
});

describe('unit 15: the tmpfs of the token (/run/devenv) in the Docker Compose up model', () => {
  const INTERNAL = "mounts into the extension's internal folder are not supported";
  const context = (isDev: boolean): ComposeMountContext => ({
    isDev,
    repositoryFolder: REPO,
    volumeNames: new Map([['pgdata', `${PROJECT}_pgdata`]]),
    ownVolume: OWN,
    engineApiVersion: '1.47',
  });
  const up = (model: ComposeModel) => composeUpModel(model, { ...params(), image: `${PROJECT}:7` }).model;

  it('adds the tmpfs to the dev service only, after its own tmpfs entries (a text or a list)', () => {
    const model = templateModel();
    expect(up(model).services.app.tmpfs).toEqual([TOKEN_TMPFS]);
    expect(up(model).services.db.tmpfs).toBeUndefined();
    const withList = templateModel();
    withList.services.app.tmpfs = ['/tmp:size=64m'];
    expect(up(withList).services.app.tmpfs).toEqual(['/tmp:size=64m', TOKEN_TMPFS]);
    const withText = templateModel();
    withText.services.app.tmpfs = '/run';
    expect(up(withText).services.app.tmpfs).toEqual(['/run', TOKEN_TMPFS]);
  });

  it('does not add it to the build model', () => {
    expect(composeBuildModel(templateModel(), params()).model.services.app.tmpfs).toBeUndefined();
  });

  it.each<[string, unknown, string]>([
    ['a named volume', { type: 'volume', source: 'pgdata', target: '/run/devenv' }, '/run/devenv'],
    ['a tmpfs below it', { type: 'tmpfs', target: '/run/devenv/gh' }, '/run/devenv/gh'],
    ['a bind mount of repository data', { type: 'bind', source: `${REPO}/x`, target: '/run//devenv/' }, '/run/devenv'],
  ])('decideServiceMount refuses %s at or below it in the dev service', (_name, entry, target) => {
    expect(decideServiceMount(entry, context(true))).toEqual({ action: 'refuse', kind: 'unsupported', item: `mount at ${target} (${INTERNAL})` });
  });

  it('decideServiceMount keeps /run and /run/devenvx in the dev service, and the folder in another service', () => {
    expect(decideServiceMount({ type: 'tmpfs', target: '/run' }, context(true))).toEqual({ action: 'keep' });
    expect(decideServiceMount({ type: 'volume', source: 'pgdata', target: '/run/devenvx' }, context(true))).toEqual({ action: 'keep' });
    expect(decideServiceMount({ type: 'volume', source: 'pgdata', target: '/run/devenv' }, context(false))).toEqual({ action: 'keep' });
  });
});

describe('review round 20 (P20-1): the Dockerfile of a local build of the dev service is always the checked text', () => {
  const TEXT = 'FROM mcr.microsoft.com/devcontainers/base:bookworm\nRUN echo $HOME\n';
  /** A model as COMPOSE_MODEL_SCRIPT returns it (unescaped texts), whose dev service builds a file of the repository. */
  function fileBuild(build: Record<string, unknown>): ComposeModel {
    const source = templateModel();
    source.services.app.build = build;
    return source;
  }

  it('writes the checked text to COMPOSE_DEV_DOCKERFILE for a Dockerfile or context with a $, whatever Compose prints', () => {
    // Review round 22, H22-7: the rewrite has no parameter dollarEscaped any more.
    const source = fileBuild({ context: `${REPO}/c$d`, dockerfile: `${REPO}/c$d/D$x`, args: { A: '1' } });
    const built = composeBuildModel(source, params({ dockerfiles: { app: TEXT } }));
    expect(built.devDockerfile).toBe(TEXT);
    // The context stays (escaped once, as every text); the Dockerfile is ours.
    // User decisions 2026-10-03: changed expectation, every built image carries the environment ID (build.labels).
    expect(built.model.services.app.build).toEqual({ context: `${REPO}/c$$d`, dockerfile: COMPOSE_DEV_DOCKERFILE, args: { A: '1' }, labels: { 'nimblescape.devenv.environment-id': ID } });
  });

  it('writes it for a plain Dockerfile too (no gap between the check and the read of the CLI and of BuildKit)', () => {
    const built = composeBuildModel(templateModel(), params({ dockerfiles: { app: TEXT, db: 'FROM x\n' } }));
    expect(built.devDockerfile).toBe(TEXT);
    // User decisions 2026-10-03: changed expectation, every built image carries the environment ID (build.labels).
    expect(built.model.services.app.build).toEqual({ context: `${REPO}/.devcontainer`, dockerfile: COMPOSE_DEV_DOCKERFILE, labels: { 'nimblescape.devenv.environment-id': ID } });
  });

  it('throws for a local build of the dev service whose Dockerfile the model run did not read (fail closed)', () => {
    expect(() => composeBuildModel(templateModel(), params({ dockerfiles: { db: TEXT } }))).toThrow(/service app: build/);
    expect(() => composeBuildModel(templateModel(), params({ dockerfiles: undefined }))).toThrow(/service app: build/);
  });
});

describe('review round 20 (D20-1): keys with a $', () => {
  it('are written as they are, the values escaped', () => {
    const source = templateModel();
    source.services.db.environment = { a$b: 'c$d' };
    source.services.db.labels = { 'k$': 'v$w' };
    const up = composeUpModel(source, { ...params(), image: `${PROJECT}:7` }).model;
    for (const written of [up, composeBuildModel(source, params()).model]) {
      expect(written.services.db.environment).toEqual({ a$b: 'c$$d' });
      expect(written.services.db.labels).toMatchObject({ 'k$': 'v$$w' });
    }
  });
});
