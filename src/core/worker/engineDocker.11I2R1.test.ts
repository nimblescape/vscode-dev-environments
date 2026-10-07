// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #120 (plan step 11I2, reviewer B): the tests of the removed ContainerAdapter were the only ones of
// these behaviours of EnvironmentDocker; EngineDocker, its one implementation now, gets them over the port.
import { describe, expect, it } from 'vitest';
import { LABEL_ENVIRONMENT_ID } from '../names';
import { EngineError, type DockerEngine, type EngineImage } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker } from './engineDocker';

const COMPOSE = 'com.docker.compose.project';

describe('EngineDocker: the behaviours that only the tests of ContainerAdapter covered (review round 1 of PR #120, B)', () => {
  it('listEnvironmentVolumes: only volumes with the environment label, each inspected once, missing ones left out, with labels; a cancel ends before the inspect', async () => {
    const filters: unknown[] = [];
    const inspected: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      volumeNames: async (given) => (filters.push(given), ['v1', 'v1', 'gone', 'v2']),
      inspect: async (kind, reference) => {
        inspected.push([kind, reference]);
        return reference === 'gone' ? undefined : { Name: reference, Labels: { [LABEL_ENVIRONMENT_ID]: `env-${reference}`, n: null } };
      },
    };
    const docker = new EngineDocker(engine);
    expect(await docker.listEnvironmentVolumes()).toEqual([
      { name: 'v1', labels: { [LABEL_ENVIRONMENT_ID]: 'env-v1' } },
      { name: 'v2', labels: { [LABEL_ENVIRONMENT_ID]: 'env-v2' } },
    ]);
    expect(filters).toEqual([{ label: [LABEL_ENVIRONMENT_ID] }]);
    expect(inspected).toEqual([
      ['volume', 'v1'],
      ['volume', 'gone'],
      ['volume', 'v2'],
    ]);
    const controller = new AbortController();
    const cancelling: DockerEngine = { ...engine, volumeNames: async () => (controller.abort(), ['v1']) };
    inspected.length = 0;
    await expect(new EngineDocker(cancelling).listEnvironmentVolumes(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(inspected).toEqual([]);
  });

  it('inspectNetworks: networks by their inspect, with labels and containers; missing ones left out', async () => {
    const kinds: string[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async (kind, reference) => {
        kinds.push(kind);
        return reference === 'gone' ? undefined : { Name: reference, Id: `id-${reference}`, Labels: { a: 'b' }, Containers: { c1: {}, c2: {} } };
      },
    };
    expect(await new EngineDocker(engine).inspectNetworks(['n1', 'gone', 'n1'])).toEqual([{ name: 'n1', id: 'id-n1', labels: { a: 'b' }, containers: ['c1', 'c2'] }]);
    expect(kinds).toEqual(['network', 'network']);
  });

  it('listProjectNetworks: only the networks of this Compose project (never those of every project)', async () => {
    const filters: unknown[] = [];
    const engine: DockerEngine = { ...unusedEngine(), networkNames: async (given) => (filters.push(given), ['p_default']) };
    expect(await new EngineDocker(engine).listProjectNetworks('p')).toEqual(['p_default']);
    expect(filters).toEqual([{ label: [`${COMPOSE}=p`] }]);
  });

  it('createVolume keeps the labels; removeVolume, removeContainer, removeNetwork and renameContainer reach the port with their names', async () => {
    const calls: unknown[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      createVolume: async (name, labels) => void calls.push(['createVolume', name, labels]),
      removeVolume: async (name) => void calls.push(['removeVolume', name]),
      removeContainer: async (name) => void calls.push(['removeContainer', name]),
      removeNetwork: async (name) => void calls.push(['removeNetwork', name]),
      renameContainer: async (name, newName) => void calls.push(['renameContainer', name, newName]),
    };
    const docker = new EngineDocker(engine);
    await docker.createVolume('v', { [LABEL_ENVIRONMENT_ID]: 'e', 'k=1': 'a,b' });
    await docker.removeVolume('v');
    await docker.removeContainer('c');
    await docker.removeNetwork('n');
    await docker.renameContainer('c', 'c-old');
    expect(calls).toEqual([
      ['createVolume', 'v', { [LABEL_ENVIRONMENT_ID]: 'e', 'k=1': 'a,b' }],
      ['removeVolume', 'v'],
      ['removeContainer', 'c'],
      ['removeNetwork', 'n'],
      ['renameContainer', 'c', 'c-old'],
    ]);
    // A volume in use stays a failure (as `docker volume rm`).
    const busy: DockerEngine = { ...engine, removeVolume: async () => Promise.reject(new EngineError('volume is in use', 409)) };
    await expect(new EngineDocker(busy).removeVolume('v')).rejects.toThrow('volume is in use');
  });

  it('removeImage: true only when the image was removed; missing and in use are false', async () => {
    let outcome: 'removed' | 'missing' | 'inUse' = 'removed';
    const engine: DockerEngine = { ...unusedEngine(), removeImage: async () => outcome };
    const docker = new EngineDocker(engine);
    expect(await docker.removeImage('i')).toBe(true);
    outcome = 'inUse';
    expect(await docker.removeImage('i')).toBe(false);
    outcome = 'missing';
    expect(await docker.removeImage('i')).toBe(false);
  });

  it('imageNames: tags and digests (only strings), undefined for a missing image', async () => {
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async (_kind, reference) => (reference === 'x' ? undefined : { Id: 'sha256:1', RepoTags: ['a:1', 7], RepoDigests: ['a@sha256:d'] }),
    };
    const docker = new EngineDocker(engine);
    expect(await docker.imageNames('a:1')).toEqual({ repoTags: ['a:1'], repoDigests: ['a@sha256:d'] });
    expect(await docker.imageNames('x')).toBeUndefined();
  });

  it('imageLabelsOf: labels by the lower-case full ID; missing images and answers without an ID left out; a cancel is an AbortError', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      inspect: async (_kind, reference, signal) => {
        signals.push(signal);
        if (reference === 'gone') return undefined;
        if (reference === 'noid') return { Config: { Labels: { a: 'b' } } };
        return { Id: `sha256:${reference.toUpperCase()}`, Config: { Labels: { r: reference } } };
      },
    };
    const docker = new EngineDocker(engine);
    const labels = await docker.imageLabelsOf(['ab', 'gone', 'noid', 'cd']);
    expect([...labels.entries()]).toEqual([
      ['sha256:ab', { r: 'ab' }],
      ['sha256:cd', { r: 'cd' }],
    ]);
    const controller = new AbortController();
    signals.length = 0;
    const cancelling: DockerEngine = { ...engine, inspect: async (_k, _r, signal) => (signals.push(signal), controller.abort(), { Id: 'sha256:1' }) };
    await expect(new EngineDocker(cancelling).imageLabelsOf(['a', 'b'], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    // The signal of the caller reaches the port, and nothing is asked after the cancel.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('the image lists leave out `<none>` tags and the images of other repositories', async () => {
    const image = (repoTags: string[], labels: Record<string, string> = {}): EngineImage => ({ id: `sha256:${repoTags.join()}`, repoTags, repoDigests: [], labels, created: 'c' });
    const engine: DockerEngine = {
      ...unusedEngine(),
      images: async (given) => {
        const reference = given.reference?.[0];
        if (reference === 'p-*') return [image(['p-app:<none>', 'p-app:1'])];
        if (reference === 'devenv-*') return [image(['devenv-a:<none>', 'other:1', 'devenv-a:1']), image(['other:2'])];
        return [image(['r:<none>', 'r:1', 'rx:2'])];
      },
    };
    const docker = new EngineDocker(engine);
    expect(await docker.listProjectImages('p')).toEqual(['p-app:1']);
    expect(await docker.listEnvironmentImages()).toEqual([{ id: 'sha256:devenv-a:<none>,other:1,devenv-a:1', tags: ['devenv-a:1'], createdAt: 'c' }]);
    expect(await docker.listImageTags('r')).toEqual(['r:1']);
    // A cancel of the list of the environment images is an AbortError.
    const controller = new AbortController();
    const cancelling: DockerEngine = { ...engine, images: async () => (controller.abort(), []) };
    await expect(new EngineDocker(cancelling).listEnvironmentImages(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
