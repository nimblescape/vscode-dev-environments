// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3: the Docker of the pipeline over the port of the worker's engine answers as ContainerAdapter answers
// over the Docker CLI.
import { describe, expect, it } from 'vitest';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../names';
import { silentLogger, type Logger } from '../ports';
import { EngineError, type DockerEngine, type EngineContainer, type EngineImage } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker } from './engineDocker';

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
    const docker = new EngineDocker(engine);
    expect(await docker.exec('c', ['cat'], { user: 'root', secretInput: 'ghp_x', timeoutMs: 5 })).toEqual({ exitCode: 0, stdout: 'x', stderr: '', timedOut: false });
    expect(seen[0]).toEqual(['c', ['cat'], { user: 'root', input: 'ghp_x', timeoutMs: 5 }]);
    await expect(docker.exec('c', ['cat'], { input: 'a', secretInput: 'b' })).rejects.toThrow('either an input or a secret input');
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

  it('runOnVolume: the volume run, its failure with the output, and its time limit', async () => {
    let result = { exitCode: 0 as number | null, output: '', timedOut: false };
    const specs: unknown[] = [];
    const engine: DockerEngine = { ...unusedEngine(), runContainer: async (spec) => (specs.push(spec), result) };
    const docker = new EngineDocker(engine);
    const run = { image: 'img:1', volume: 'v', target: '/workspaces', entrypoint: 'sh', args: ['-c', 'x'], user: 'root', labels: { a: 'b' } };
    await docker.runOnVolume(run);
    expect(specs[0]).toEqual({ image: 'img:1', entrypoint: 'sh', args: ['-c', 'x'], user: 'root', labels: { a: 'b' }, volumes: [{ name: 'v', target: '/workspaces' }] });
    result = { exitCode: 2, output: 'chown: denied\n', timedOut: false };
    await expect(docker.runOnVolume(run)).rejects.toThrow('failed with exit code 2: chown: denied');
    result = { exitCode: null, output: '', timedOut: true };
    await expect(docker.runOnVolume(run)).rejects.toThrow('did not end in time');
  });
});
