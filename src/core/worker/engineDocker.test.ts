// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3: the Docker of the pipeline over the port of the worker's engine answers as the Docker CLI answers (as
// the CLI adapter ContainerAdapter answered, until plan step 11I2 removed it).
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY, SECRET_TOKEN } from '../helperChannel/protocol';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../names';
import { silentLogger, type Logger } from '../ports';
import { EngineError, type DockerEngine, type EngineContainer, type EngineImage } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker, type PullLogins } from './engineDocker';
import { credentialServerName } from '../imageCheck/reference';
import { engineHijack } from '../../helperChannel/engineApi';
import { dockerEngine } from '../../helperChannel/engineClient';

const ENV = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devenv-acme-api-brave-noether';

function container(overrides: Partial<EngineContainer> = {}): EngineContainer {
  return { id: 'a'.repeat(64), name: NAME, state: 'running', rawState: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ENV }, image: `${NAME}:1`, created: '2026-10-03T10:00:00Z', ...overrides };
}

function recording(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { ...silentLogger, info: (text) => lines.push(`info ${text}`), warn: (text) => lines.push(`warn ${text}`) }, lines };
}

describe('the Docker of the pipeline over the port (plan step 11B3)', () => {
  it('findContainer: the dev container of the environment, the named one first, else running, else newest; warns about several', async () => {
    const service = container({ id: 's'.repeat(64), name: `${NAME}-db-1`, labels: { [LABEL_ENVIRONMENT_ID]: ENV, [LABEL_COMPOSE_SERVICE]: 'db' } });
    const old = container({ id: 'o'.repeat(64), name: 'old', state: 'stopped', rawState: 'exited', created: '2026-10-03T09:00:00Z' });
    const newer = container({ id: 'n'.repeat(64), name: 'newer', state: 'stopped', rawState: 'exited', created: '2026-10-03T11:00:00Z' });
    const named = container();
    const labels: string[] = [];
    let listed = [service, old, newer, named];
    const engine: DockerEngine = { ...unusedEngine(), containers: async (label) => (labels.push(label), listed) };
    const { logger, lines } = recording();
    const docker = new EngineDocker(engine, logger);
    expect((await docker.findContainer(ENV, NAME))?.id).toBe(named.id);
    expect(labels).toEqual([`${LABEL_ENVIRONMENT_ID}=${ENV}`]);
    expect(lines).toEqual([`warn 3 containers have the label ${LABEL_ENVIRONMENT_ID}=${ENV}: old, newer, ${NAME}`]);
    listed = [old, newer];
    expect((await docker.findContainer(ENV, NAME))?.id).toBe(newer.id);
    listed = [old, container({ id: 'r'.repeat(64), name: 'running', created: '2026-10-01T00:00:00Z' }), newer];
    expect((await docker.findContainer(ENV, NAME))?.id).toBe('r'.repeat(64));
    listed = [service];
    expect(await docker.findContainer(ENV, NAME)).toBeUndefined();
    // The public shape: without the time of the create.
    listed = [named];
    expect(await docker.findContainer(ENV, NAME)).not.toHaveProperty('created');
  });

  it('plan step 11I (U4, decision of 2026-10-08): findContainer takes the newest by the time of the create, never by its text, and logs one that is not the named one', async () => {
    // Half a second later than `text`, which sorts after it as text (the engine trims the zeros of a fraction).
    const later = container({ id: 'l'.repeat(64), name: 'later', state: 'stopped', rawState: 'exited', created: '2026-10-08T09:00:00.5Z' });
    const text = container({ id: 't'.repeat(64), name: 'text', state: 'stopped', rawState: 'exited', created: '2026-10-08T09:00:00Z' });
    let listed = [text, later];
    const engine: DockerEngine = { ...unusedEngine(), containers: async () => listed };
    const { logger, lines } = recording();
    const docker = new EngineDocker(engine, logger);
    expect((await docker.findContainer(ENV, NAME))?.id).toBe(later.id);
    expect(lines).toContain(`info There is no container ${NAME}; the container later of the environment is used.`);
    // The named one whatever its state, also while another runs; then nothing but the warning about several.
    listed = [container({ id: 'r'.repeat(64), name: 'running', created: '2026-10-08T10:00:00Z' }), container({ state: 'stopped', rawState: 'exited' })];
    lines.length = 0;
    expect((await docker.findContainer(ENV, NAME))?.id).toBe('a'.repeat(64));
    expect(lines).toEqual([`warn 2 containers have the label ${LABEL_ENVIRONMENT_ID}=${ENV}: running, ${NAME}`]);
  });

  it('plan step 11I (U4, decision of 2026-10-08): environmentContainers lists one environment by its label, with the times of the create, within the time limit', async () => {
    const asked: Array<{ label: string; signal?: AbortSignal }> = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      containers: async (label, signal) => (asked.push({ label, signal }), [container({ exitCode: 0, restartCount: 1 }), container({ id: 'b'.repeat(64), name: 'other', created: undefined })]),
    };
    const listed = await new EngineDocker(engine).environmentContainers(ENV);
    expect(asked).toHaveLength(1);
    expect(asked[0].label).toBe(`${LABEL_ENVIRONMENT_ID}=${ENV}`);
    // A request with a time limit (as every request of EngineDocker).
    expect(asked[0].signal).toBeInstanceOf(AbortSignal);
    expect(listed.map((each) => each.created)).toEqual(['2026-10-03T10:00:00Z', undefined]);
    expect(listed[0]).not.toHaveProperty('exitCode');
    expect(listed[0]).not.toHaveProperty('restartCount');
    expect(listed[1]).not.toHaveProperty('created');
  });

  it('containerState, imageExists, imageId, volumeExists: missing is an answer, not a failure', async () => {
    const engine: DockerEngine = {
      ...unusedEngine(),
      container: async (reference) => (reference === 'c' ? container({ rawState: 'paused', state: 'running' }) : undefined),
      inspect: async (kind, reference) => (reference === 'there' ? (kind === 'image' ? { Id: 'sha256:1', Config: { Labels: { a: 'b' } } } : { Name: 'there' }) : undefined),
    };
    const docker = new EngineDocker(engine);
    expect(await docker.containerState('c')).toBe('running');
    expect(await docker.containerState('x')).toBe('missing');
    expect([await docker.imageExists('there'), await docker.imageExists('x')]).toEqual([true, false]);
    expect([await docker.imageId('there'), await docker.imageId('x')]).toEqual(['sha256:1', undefined]);
    expect([await docker.volumeExists('there'), await docker.volumeExists('x')]).toEqual([true, false]);
    expect([await docker.imageLabels('there'), await docker.imageLabels('x')]).toEqual([{ a: 'b' }, undefined]);
    await expect(docker.imageConfig('x')).rejects.toThrow('No such image: x');
    expect(await docker.imageConfig('there')).toEqual({ Labels: { a: 'b' } });
  });

  it('stopContainer: a missing container is no failure; other failures are', async () => {
    let failure: Error = new EngineError('No such container', 404);
    const engine: DockerEngine = {
      ...unusedEngine(),
      stop: async () => {
        throw failure;
      },
    };
    const docker = new EngineDocker(engine);
    await docker.stopContainer('c');
    failure = new EngineError('the daemon is busy', 500);
    await expect(docker.stopContainer('c')).rejects.toThrow('the daemon is busy');
  });

  it('labelImage: labels without a build, and removes the previous image only when nothing names it', async () => {
    const removed: string[] = [];
    let names: unknown = { Id: 'sha256:old', RepoTags: [], RepoDigests: [] };
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async (_kind, reference) => (reference === 'img:1' ? { Id: 'sha256:old' } : names),
      labelImage: async () => 'sha256:new',
      removeImage: async (reference) => (removed.push(reference), 'removed'),
    };
    const docker = new EngineDocker(engine);
    await docker.labelImage('img:1', { a: 'b' });
    expect(removed).toEqual(['sha256:old']);
    names = { Id: 'sha256:old', RepoTags: ['other:1'], RepoDigests: [] };
    await docker.labelImage('img:1', { a: 'b' });
    expect(removed).toEqual(['sha256:old']);
    // Review round 2 of 11B3a (B-R2-11): an image that a digest still names is kept too.
    names = { Id: 'sha256:old', RepoTags: [], RepoDigests: [`r@sha256:${'d'.repeat(64)}`] };
    await docker.labelImage('img:1', { a: 'b' });
    expect(removed).toEqual(['sha256:old']);
    const missing: DockerEngine = { ...unusedEngine(), inspect: async () => undefined };
    await expect(new EngineDocker(missing).labelImage('img:1', {})).rejects.toThrow('The image img:1 does not exist.');
  });

  it('inspectImageNames: found ones, invalid references, and the rest transient after the first other failure', async () => {
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async (_kind, reference) => {
        if (reference === 'bad') throw new EngineError('invalid reference format', 400);
        if (reference === 'down') throw new EngineError('the daemon is busy', 500);
        return reference === 'gone' ? undefined : { Id: `sha256:${reference}`, RepoTags: [`${reference}:1`], RepoDigests: [] };
      },
    };
    const { logger, lines } = recording();
    const result = await new EngineDocker(engine, logger).inspectImageNames(['a', 'gone', 'bad', 'b', 'down', 'c']);
    expect(result.images.map((image) => image.id)).toEqual(['sha256:a', 'sha256:b']);
    expect(result.unchecked).toEqual([
      { reference: 'bad', reason: 'invalid' },
      { reference: 'down', reason: 'transient' },
      { reference: 'c', reason: 'transient' },
    ]);
    expect(lines).toEqual(['warn The inspect of the image down failed: the daemon is busy']);
  });

  it('the image lists: project images without those of another environment, environment images, sorted tags', async () => {
    const image = (repoTags: string[], labels: Record<string, string> = {}): EngineImage => ({ id: `sha256:${repoTags.join()}`, repoTags, repoDigests: [], labels, created: '2026-10-03T10:00:00.000Z' });
    const filters: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      images: async (given) => {
        filters.push(given);
        const reference = given.reference?.[0];
        if (reference === 'p-*') return [image(['p-app:latest'], { [LABEL_ENVIRONMENT_ID]: ENV }), image(['p-db:latest'], { [LABEL_ENVIRONMENT_ID]: 'other' })];
        if (reference === 'devenv-*') return [image(['devenv-a:1', 'devenv-a:2']), image([])];
        return [image(['devenv-a:10', 'devenv-a:2', 'devenv-ab:1'])];
      },
    };
    const docker = new EngineDocker(engine);
    expect(await docker.listProjectImages('p', ENV)).toEqual(['p-app:latest']);
    expect(await docker.listProjectImages('p')).toEqual(['p-app:latest', 'p-db:latest']);
    expect(await docker.listEnvironmentImages()).toEqual([{ id: 'sha256:devenv-a:1,devenv-a:2', tags: ['devenv-a:1', 'devenv-a:2'], createdAt: '2026-10-03T10:00:00.000Z' }]);
    expect(await docker.listImageTags('devenv-a')).toEqual(['devenv-a:2', 'devenv-a:10']);
    expect(filters).toContainEqual({ reference: ['devenv-a'] });
  });

  it('exec: the input or the secret input as standard input, never both', async () => {
    const seen: unknown[] = [];
    const engine: DockerEngine = { ...unusedEngine(), exec: async (c, command, options) => (seen.push([c, command, options]), { exitCode: 0, stdout: 'x', stderr: '', timedOut: false }) };
    const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_TOKEN ? 'ghp_x' : name === SECRET_REGISTRY ? 'registry-password' : undefined));
    // Plan step 11I (PR B): changed expectation, the secret input comes by its name (`secretInputName`, as the registry's
    // runScript gives it), no longer as its value (`secretInput: 'ghp_x'`, which had to be the token of the operation).
    expect(await docker.exec('c', ['cat'], { user: 'root', secretInputName: SECRET_TOKEN, timeoutMs: 5 })).toEqual({ exitCode: 0, stdout: 'x', stderr: '', timedOut: false });
    // Review round 1 of 11B3a (A-R1-9): the secret goes to the port by its name, never as its value.
    expect(seen[0]).toEqual(['c', ['cat'], { user: 'root', secretInputName: SECRET_TOKEN, timeoutMs: 5 }]);
    expect(JSON.stringify(seen[0])).not.toContain('ghp_x');
    await expect(docker.exec('c', ['cat'], { input: 'a', secretInputName: SECRET_TOKEN })).rejects.toThrow('either an input or a secret input');
    // A secret input that is not the token of the operation is refused before anything is sent. Plan step 11I (PR B):
    // changed expectation, by its name: another secret of the operation (its registry login) never goes into a container,
    // and the token is refused when the operation holds none.
    await expect(docker.exec('c', ['cat'], { secretInputName: SECRET_REGISTRY as typeof SECRET_TOKEN })).rejects.toThrow('token secret of the operation');
    await expect(new EngineDocker(engine).exec('c', ['cat'], { secretInputName: SECRET_TOKEN })).rejects.toThrow('token secret of the operation');
    // Review round 1 of PR #124 (A, L-1): the token that the operation holds is checked where it is sent: empty, or with
    // white space, it is refused before anything is sent.
    for (const held of ['', 'ghp_a b', 'ghp_x\n']) {
      await expect(new EngineDocker(engine, silentLogger, (name) => (name === SECRET_TOKEN ? held : undefined)).exec('c', ['cat'], { secretInputName: SECRET_TOKEN })).rejects.toThrow('token secret of the operation');
    }
    expect(seen).toHaveLength(1);
    await docker.exec('c', ['id'], { input: 'plain', workdir: '/w' });
    expect(seen).toEqual([seen[0], ['c', ['id'], { input: 'plain', workdir: '/w' }]]);
  });

  it('exec: a refusal of the engine is a result as `docker exec` gives it; a cancel and other failures stay failures (review round 1 of 11B3a, A-R1-3)', async () => {
    let failure: Error = new EngineError('unable to find user nobody2: no matching entries in passwd file', 400);
    const engine: DockerEngine = {
      ...unusedEngine(),
      exec: async () => {
        throw failure;
      },
    };
    const docker = new EngineDocker(engine);
    expect(await docker.exec('c', ['id'], { user: 'nobody2' })).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error response from daemon: unable to find user nobody2: no matching entries in passwd file\n',
      timedOut: false,
    });
    failure = new EngineError('container c is not running', 409);
    expect((await docker.exec('c', ['id'])).stderr).toBe('Error response from daemon: container c is not running\n');
    failure = new EngineError('The operation holds no secret token.', 0);
    await expect(docker.exec('c', ['id'])).rejects.toBe(failure);
    failure = new Error('socket hang up');
    await expect(docker.exec('c', ['id'])).rejects.toBe(failure);
    const controller = new AbortController();
    controller.abort();
    failure = new EngineError('cancelled while refused', 409);
    await expect(docker.exec('c', ['id'], { signal: controller.signal })).rejects.toBe(failure);
  });

  it('each request has a time limit; a cancel stays an AbortError (review round 1 of 11B3a, A-R1-2)', async () => {
    // As the port: a request ends with an AbortError when its signal aborts.
    const hanging = <T>(signal?: AbortSignal): Promise<T> =>
      new Promise((_resolve, reject) => {
        const fail = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) fail();
        signal?.addEventListener('abort', fail);
      });
    const signals: (AbortSignal | undefined)[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      // Plan step 11G1: imageFile (imageUserIds) in place of containerIds (containerIdsWithLabel, removed with the
      // ownership container of prepareOwnership).
      imageFile: (_image, _path, signal) => (signals.push(signal), hanging(signal)),
      inspect: (_kind, _reference, signal) => (signals.push(signal), hanging(signal)),
      start: (_id, signal) => (signals.push(signal), hanging(signal)),
    };
    const docker = new EngineDocker(engine);
    // Plan step 11G1: changed expectation, the time limit of imageUserIds (was: of containerIdsWithLabel).
    await expect(docker.imageUserIds('img', 'vscode', { timeoutMs: 20 })).rejects.toThrow(new EngineError('The engine did not answer the read of /etc/passwd of img within 0.02 s.', 0));
    await expect(docker.imageConfig('img', { timeoutMs: 20 })).rejects.toThrow('did not answer the inspect of img within 0.02 s');
    await expect(docker.startContainer('c', { timeoutMs: 20 })).rejects.toThrow('did not answer the start of c within 0.02 s');
    const controller = new AbortController();
    // Plan step 11G1: changed expectation, the cancel of imageUserIds (was: of containerIdsWithLabel).
    const cancelled = docker.imageUserIds('img', 'vscode', { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    // The signal of the caller reaches the port.
    const passed = docker.imageConfig('img', { signal: controller.signal });
    await expect(passed).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals.every((signal) => signal !== undefined)).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it('the signal and the filter of each list reach the port (review round 1 of 11B3a, mutation testing)', async () => {
    const seen: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      containerIds: async (filters, signal) => (seen.push(['ids', filters, signal?.aborted]), ['id1']),
      // Plan step 11I (U4): with the exit code and the restarts of the port, which no list of the pipeline carries.
      containers: async (label) => (seen.push(['containers', label]), [container({ exitCode: 3, restartCount: 2 })]),
      inspect: async (_kind, reference, signal) => (seen.push(['inspect', reference, signal?.aborted]), { Id: 'sha256:1' }),
      version: async (signal) => (seen.push(['version', signal?.aborted]), { apiVersion: '1.48', version: '29.0.0' }),
    };
    const docker = new EngineDocker(engine);
    const controller = new AbortController();
    // A signal that aborts later: the port gets one that follows it.
    const late = { aborted: false };
    controller.signal.addEventListener('abort', () => (late.aborted = true));
    // The image has no configuration: as `docker image inspect --format {{json .Config}}`, null.
    expect(await docker.imageConfig('img')).toBeNull();
    // Plan step 11I (U4, decision of 2026-10-08): changed expectation, the list of the environments carries the time of
    // the create of each container (before: without it), which the rule of the dev container (devContainerOf) needs; the
    // other fields of the port (the exit code, the restarts) stay out.
    expect(await docker.listEnvironmentContainers()).toEqual([expect.objectContaining({ created: '2026-10-03T10:00:00Z' })]);
    expect((await docker.listEnvironmentContainers())[0]).not.toHaveProperty('exitCode');
    expect((await docker.listEnvironmentContainers())[0]).not.toHaveProperty('restartCount');
    expect(seen).toContainEqual(['containers', LABEL_ENVIRONMENT_ID]);
    expect((await docker.listProjectContainers('acme'))[0]).not.toHaveProperty('created');
    expect(seen.at(-1)).toEqual(['containers', 'com.docker.compose.project=acme']);
    const signals: AbortSignal[] = [];
    const watching: DockerEngine = {
      ...engine,
      version: async (signal) => (signals.push(signal!), { apiVersion: '1.48', version: '29.0.0' }),
      inspect: async (_kind, _reference, signal) => (signals.push(signal!), { Id: 'sha256:1' }),
      // Plan step 11G1: imageFile (imageUserIds) in place of containerIds (containerIdsWithLabel, removed).
      imageFile: async (_image, _path, signal) => (signals.push(signal!), undefined),
    };
    const watched = new EngineDocker(watching);
    await watched.isRunning(controller.signal);
    await watched.engineApiVersion(controller.signal);
    await watched.imageConfig('img', { signal: controller.signal });
    // Plan step 11G1: changed expectation, the signal of imageUserIds reaches the port (was: of containerIdsWithLabel).
    await watched.imageUserIds('img', 'vscode', { signal: controller.signal });
    expect(signals).toHaveLength(4);
    controller.abort();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true, true]);
  });

  it('isRunning and engineApiVersion: a cancel is never an answer (review round 1 of 11B3a, mutation testing)', async () => {
    const abort = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });
    let answer: () => Promise<{ apiVersion: string; version: string }> = async () => {
      throw abort();
    };
    const engine: DockerEngine = { ...unusedEngine(), version: () => answer() };
    const { logger, lines } = recording();
    const docker = new EngineDocker(engine, logger);
    // An AbortError without a signal of the caller (the engine went away while asked) is no answer either.
    await expect(docker.isRunning()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(docker.engineApiVersion()).rejects.toMatchObject({ name: 'AbortError' });
    // A cancel of the caller while the engine fails otherwise.
    const controller = new AbortController();
    answer = async () => {
      controller.abort();
      throw new Error('connect ENOENT');
    };
    await expect(docker.isRunning(controller.signal)).rejects.toThrow('connect ENOENT');
    await expect(docker.engineApiVersion(controller.signal)).rejects.toThrow('connect ENOENT');
    expect(lines).toEqual([]);
    // Only a version `<major>.<minor>` is one; an empty one is named.
    for (const apiVersion of ['v1.48', '1.48-beta', '1.48.1', '']) {
      answer = async () => ({ apiVersion, version: '' });
      expect(await docker.engineApiVersion()).toBeUndefined();
    }
    expect(lines.at(-1)).toBe('warn The API version of the Docker Engine could not be read: none');
  });

  it('findContainer: the named one also when another one runs or is newer (review round 1 of 11B3a, mutation testing)', async () => {
    const named = container({ state: 'stopped', rawState: 'exited', created: '2026-10-01T00:00:00Z' });
    const other = container({ id: 'r'.repeat(64), name: 'running', created: '2026-10-03T12:00:00Z' });
    const engine: DockerEngine = { ...unusedEngine(), containers: async () => [other, named] };
    expect((await new EngineDocker(engine).findContainer(ENV, NAME))?.id).toBe(named.id);
  });

  describe('pullImage with the logins of the operation (plan step 11E3b, decision B1)', () => {
    /** Logins as registryLogins gives them: the secret slot holds the password only during `use`. */
    function logins(answers: Record<string, { username?: string; identityToken?: boolean; password: string } | undefined>) {
      const state = { slot: undefined as string | undefined, events: [] as string[] };
      const run: PullLogins = async (registry, use) => {
        state.events.push(`ask ${registry}`);
        const login = answers[registry];
        state.slot = login?.password;
        try {
          return await use(login);
        } finally {
          state.slot = undefined;
          state.events.push('forget');
        }
      };
      return { run, state };
    }

    function engineWith(state: { slot: string | undefined; events: string[] }) {
      const pulls: unknown[] = [];
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async (reference, options) => {
          // The header is sent while the operation still holds the login.
          state.events.push(`pull ${reference} ${options?.login ? `with ${state.slot}` : 'anonymous'}`);
          pulls.push([reference, options?.login]);
        },
      };
      return { engine, pulls };
    }

    it('asks for the login of the registry of the reference, pulls with it during its turn, and the operation forgets it after', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_x' }, 'registry-1.docker.io': { identityToken: true, password: 'tok_y' } });
      const { engine, pulls } = engineWith(state);
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {} });
      await docker.pullImage('node:22', { onOutput: () => {} });
      expect(state.events).toEqual(['ask ghcr.io', 'pull ghcr.io/o/i:1 with gho_x', 'forget', 'ask registry-1.docker.io', 'pull node:22 with tok_y', 'forget']);
      expect(pulls).toEqual([
        ['ghcr.io/o/i:1', { serveraddress: 'ghcr.io', username: 'octo', secretName: SECRET_REGISTRY }],
        ['node:22', { serveraddress: credentialServerName('registry-1.docker.io'), identityToken: true, secretName: SECRET_REGISTRY }],
      ]);
    });

    it('without a login anonymously; a reference that the parser refuses is not asked for; given credentials are used as they are (review round 1 of PR #110, A-L4: reworded)', async () => {
      const { run, state } = logins({});
      const { engine, pulls } = engineWith(state);
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? 'gho_given' : undefined), run);
      await docker.pullImage('r.example/i:1', { onOutput: () => {} });
      await docker.pullImage('UPPER/Case:1', { onOutput: () => {} });
      await docker.pullImage('ghcr.io/o/i:1', { credentials: { registry: 'ghcr.io', username: 'octo', password: 'gho_given' }, onOutput: () => {} });
      expect(state.events).toEqual(['ask r.example', 'pull r.example/i:1 anonymous', 'forget', 'pull UPPER/Case:1 anonymous', 'pull ghcr.io/o/i:1 with undefined']);
      expect(pulls[2]).toEqual(['ghcr.io/o/i:1', { serveraddress: 'ghcr.io', username: 'octo', secretName: SECRET_REGISTRY }]);
    });

    it('a login that the registry refuses: once more without it in the same turn, with a warning; any other failure is no retry (review round 1 of PR #110, A-M1)', async () => {
      for (const [refusal, retried] of [
        [new EngineError('unauthorized: incorrect username or password', 500), true],
        [new EngineError('Head "https://ghcr.io/v2/o/i/manifests/1": unauthorized', 500), true],
        [new EngineError('forbidden', 403), true],
        [new EngineError('pull access denied', 401), true],
        // Review round 2 of PR #110 (A2-L-3): the containerd image store, ghcr.io and ECR.
        [new EngineError('failed to resolve reference "ghcr.io/o/i:1": failed to authorize: failed to fetch oauth token: unexpected status from POST request to https://ghcr.io/token: 403 Forbidden', 500), true],
        [new EngineError('Head "https://ghcr.io/v2/o/i/manifests/1": denied', 500), true],
        [new EngineError('denied: Your authorization token has expired. Reauthenticate and try again.', 500), true],
        [new EngineError('manifest unknown', 404), false],
        [new EngineError('pull access for o/i is not possible: repository does not exist or may require login (denied later)', 500), false],
        [new Error('no space left on device'), false],
      ] as const) {
        const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_old' } });
        const warnings: string[] = [];
        const engine: DockerEngine = {
          ...unusedEngine(),
          pull: async (reference, options) => {
            state.events.push(`pull ${reference} ${options?.login ? `with ${state.slot}` : 'anonymous'}`);
            if (options?.login) throw refusal;
          },
        };
        const docker = new EngineDocker(engine, { ...silentLogger, warn: (text) => void warnings.push(text) }, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
        const pulled = docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {} });
        if (retried) {
          await pulled;
          expect(state.events).toEqual(['ask ghcr.io', 'pull ghcr.io/o/i:1 with gho_old', 'pull ghcr.io/o/i:1 anonymous', 'forget']);
          expect(warnings.join('\n')).toContain('refused the login of this computer for ghcr.io/o/i:1');
          expect(warnings.join('\n')).not.toContain('gho_old');
        } else {
          await expect(pulled).rejects.toThrow(refusal.message);
          expect(state.events).toEqual(['ask ghcr.io', 'pull ghcr.io/o/i:1 with gho_old', 'forget']);
        }
      }
    });

    it('a pull cancelled during its authenticated try is not tried again (review round 2 of PR #110)', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_old' } });
      const cancel = new AbortController();
      let pulls = 0;
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async () => {
          pulls++;
          cancel.abort();
          throw new EngineError('unauthorized', 401);
        },
      };
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await expect(docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {}, signal: cancel.signal })).rejects.toThrow('unauthorized');
      expect(pulls).toBe(1);
      expect(state.events.at(-1)).toBe('forget');
    });

    it('the pull without the refused login keeps the output and the signal of the pull (review round 1 of PR #110, B)', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_old' } });
      const seen: { login: boolean; signal: AbortSignal | undefined }[] = [];
      const engine: DockerEngine = {
        ...unusedEngine(),
        pull: async (_reference, options) => {
          seen.push({ login: options?.login !== undefined, signal: options?.signal });
          if (options?.login) throw new EngineError('unauthorized', 401);
          options?.onLine?.('done');
        },
      };
      const output: string[] = [];
      const signal = new AbortController().signal;
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await docker.pullImage('ghcr.io/o/i:1', { onOutput: (text) => void output.push(text), signal });
      expect(seen).toEqual([
        { login: true, signal },
        { login: false, signal },
      ]);
      expect(output).toEqual(['done\n']);
    });

    it('a login only for a registry that the daemon reads the same way; the Docker Hub aliases and a port (review round 1 of PR #110, A-L2)', async () => {
      const { run, state } = logins({ 'registry-1.docker.io': { username: 'hub', password: 'hub_x' }, 'localhost:5000': { username: 'local', password: 'local_x' } });
      const { engine, pulls } = engineWith(state);
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      // Review round 2 of PR #110 (A2-L-2): also an upper-case first part without a dot or a colon (a host to Docker).
      for (const reference of ['Docker.io/library/node:22', 'INDEX.DOCKER.IO/library/node:22', ' node:22', 'node:22 ', 'MyHost/img:1', 'LOCALHOST/img:1']) {
        await docker.pullImage(reference, { onOutput: () => {} }).catch(() => undefined);
      }
      expect(state.events.filter((event) => event.startsWith('ask'))).toEqual([]);
      for (const reference of ['docker.io/library/node:22', 'index.docker.io/library/node:22', 'localhost:5000/team/app:1']) {
        await docker.pullImage(reference, { onOutput: () => {} });
      }
      expect(state.events.filter((event) => event.startsWith('ask'))).toEqual(['ask registry-1.docker.io', 'ask registry-1.docker.io', 'ask localhost:5000']);
      expect(pulls.at(-1)).toEqual(['localhost:5000/team/app:1', { serveraddress: credentialServerName('localhost:5000'), username: 'local', secretName: SECRET_REGISTRY }]);
      expect(credentialServerName('localhost:5000')).toBe('localhost:5000');
    });

    it('a failed pull still ends its turn (the login is forgotten) and fails', async () => {
      const { run, state } = logins({ 'ghcr.io': { username: 'octo', password: 'gho_x' } });
      const engine: DockerEngine = { ...unusedEngine(), pull: async () => Promise.reject(new Error('manifest unknown')) };
      const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? state.slot : undefined), run);
      await expect(docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {} })).rejects.toThrow('manifest unknown');
      expect(state.events).toEqual(['ask ghcr.io', 'forget']);
      expect(state.slot).toBeUndefined();
    });
  });

  it('pullImage: anonymous, or with the registry secret that the operation holds, and the lines as output', async () => {
    const pulls: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      pull: async (reference, options) => {
        pulls.push([reference, options?.login]);
        options?.onLine?.('1: Pulling');
      },
    };
    const output: string[] = [];
    const docker = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_REGISTRY ? 'gho_x' : undefined));
    await docker.pullImage('alpine:1', { onOutput: (text) => output.push(text) });
    await docker.pullImage('ghcr.io/o/i:1', { credentials: { registry: 'ghcr.io', username: 'octo', password: 'gho_x' }, onOutput: () => {} });
    await docker.pullImage('r.example/i:1', { credentials: { registry: 'r.example', username: '<token>', password: 'gho_x' }, onOutput: () => {} });
    expect(pulls).toEqual([
      ['alpine:1', undefined],
      ['ghcr.io/o/i:1', { serveraddress: 'ghcr.io', username: 'octo', secretName: SECRET_REGISTRY }],
      ['r.example/i:1', { serveraddress: 'r.example', identityToken: true, secretName: SECRET_REGISTRY }],
    ]);
    expect(output).toEqual(['1: Pulling\n']);
    // Review round 2 of 11B3a (A-R2-1): a reference without a tag is pulled as `:latest`; one with a digest as it is.
    await docker.pullImage('node', { onOutput: () => {} });
    await docker.pullImage('ghcr.io/o/i', { onOutput: () => {} });
    await docker.pullImage(`node@sha256:${'a'.repeat(64)}`, { onOutput: () => {} });
    expect(pulls.slice(3).map((pull) => (pull as unknown[])[0])).toEqual(['node:latest', 'ghcr.io/o/i:latest', `node@sha256:${'a'.repeat(64)}`]);
    pulls.splice(3);
    // Review round 3 of 11B3a (missing test 2 of reviewer A): an empty tag stays one, and the port refuses it.
    const requests: string[] = [];
    const refusing = dockerEngine(async (request) => {
      requests.push(request.path);
      return { status: 200, body: '', truncated: false };
    }, engineHijack('/nonexistent/docker.sock'));
    await expect(new EngineDocker(refusing).pullImage('node:', { onOutput: () => {} })).rejects.toThrow('The pull of node: needs a tag or a digest.');
    expect(requests).toEqual([]);
    // A password that is not the secret of the operation is refused before anything is sent.
    await expect(docker.pullImage('ghcr.io/o/i:1', { credentials: { registry: 'ghcr.io', username: 'octo', password: 'other' } })).rejects.toThrow('registry secret of the operation');
    expect(pulls).toHaveLength(3);
  });

  it('isRunning and engineApiVersion from the version of the engine', async () => {
    let answer: () => Promise<{ apiVersion: string; version: string }> = async () => ({ apiVersion: '1.48', version: '29.0.0' });
    const engine: DockerEngine = { ...unusedEngine(), version: () => answer() };
    const { logger, lines } = recording();
    const docker = new EngineDocker(engine, logger);
    expect([await docker.isRunning(), await docker.engineApiVersion()]).toEqual([true, '1.48']);
    answer = async () => ({ apiVersion: 'x', version: '' });
    expect(await docker.engineApiVersion()).toBeUndefined();
    answer = async () => {
      throw new Error('connect ENOENT');
    };
    expect([await docker.isRunning(), await docker.engineApiVersion()]).toEqual([false, undefined]);
    expect(lines).toEqual(['warn The API version of the Docker Engine could not be read: x', 'warn The API version of the Docker Engine could not be read: connect ENOENT']);
    const controller = new AbortController();
    controller.abort();
    answer = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(docker.isRunning(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('plan step 11G1: imageUserIds reads /etc/passwd of the image through the port and resolves the user as `id` does', async () => {
    const reads: { image: string; path: string }[] = [];
    let passwd: string | undefined = 'root:x:0:0:root:/root:/bin/sh\nvscode:x:1000:1001::/home/vscode:/bin/bash\n';
    const engine: DockerEngine = { ...unusedEngine(), imageFile: async (image, path) => (reads.push({ image, path }), passwd) };
    const docker = new EngineDocker(engine);
    expect(await docker.imageUserIds('img:1', 'vscode')).toEqual({ uid: '1000', gid: '1001' });
    expect(reads).toEqual([{ image: 'img:1', path: '/etc/passwd' }]);
    expect(await docker.imageUserIds('img:1', '1000')).toEqual({ uid: '1000', gid: '1001' });
    expect(await docker.imageUserIds('img:1', 'node')).toBeUndefined();
    // No regular file at the path (missing, a link, too large): unknown.
    passwd = undefined;
    expect(await docker.imageUserIds('img:1', 'vscode')).toBeUndefined();
    // A failure of the engine stays a failure.
    const failing: DockerEngine = { ...unusedEngine(), imageFile: async () => Promise.reject(new EngineError('No such image: img:1', 404)) };
    await expect(new EngineDocker(failing).imageUserIds('img:1', 'vscode')).rejects.toMatchObject({ status: 404 });
  });
});
