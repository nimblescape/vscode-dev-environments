// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11B3a (B-R2-16): the reading of the inspect JSON that EngineDocker and the engine client share.
// Plan step 11I2: the tests of this reading that ran through the removed CLI adapter ContainerAdapter (its `docker
// inspect` of containers, volumes and networks, containerAdapter.test.ts) moved here and read the same JSON directly.
import { describe, expect, it } from 'vitest';
import { mapContainerState, preferred, publicInfo, toContainerInfo, toLabels, toNetworkInfo, toVolumeInfo, type InspectedContainer } from './dockerObjects';

const container = (mounts: unknown[], hostMounts: unknown[] = []) => ({
  Id: 'c'.repeat(64),
  Name: '/c',
  Created: '2026-10-03T10:00:00Z',
  State: { Status: 'running', Running: true },
  Config: { Image: 'img', Labels: {} },
  Mounts: mounts,
  HostConfig: { Mounts: hostMounts },
});

describe('the subpath mounts of a container', () => {
  it('a mount that Mounts lists as not writable (RW false) is read-only; one that HostConfig.Mounts says so too', () => {
    const info = toContainerInfo(
      container(
        [
          { Type: 'volume', Name: 'v', RW: false, VolumeOptions: { Subpath: 'a' } },
          { Type: 'volume', Name: 'v', RW: true, VolumeOptions: { Subpath: 'b' } },
        ],
        [{ Type: 'volume', Source: 'w', ReadOnly: true, VolumeOptions: { Subpath: 'c' } }],
      ),
    );
    expect(info?.volumeSubpaths).toEqual([
      { volume: 'v', subpath: 'a', readOnly: true },
      { volume: 'v', subpath: 'b', readOnly: false },
      { volume: 'w', subpath: 'c', readOnly: true },
    ]);
  });
});

// Plan step 11I2: moved from containerAdapter.test.ts.
describe('mapContainerState', () => {
  it.each([
    ['running', 'running'],
    ['restarting', 'running'],
    ['paused', 'running'],
    ['created', 'stopped'],
    ['exited', 'stopped'],
    ['dead', 'stopped'],
    ['removing', 'stopped'],
    ['Running', 'running'],
  ] as const)('%s → %s', (raw, state) => {
    expect(mapContainerState(raw)).toBe(state);
  });
});

// Plan step 11I2: moved from containerAdapter.test.ts.
describe('toLabels', () => {
  it('keeps string values only and accepts null', () => {
    expect(toLabels({ a: 'b', c: 1, d: null })).toEqual({ a: 'b' });
    expect(toLabels(null)).toEqual({});
  });
});

/** The JSON of `docker container inspect` (and of `GET /containers/<id>/json`) of one container. */
function containerJson(p: {
  id: string;
  name: string;
  status: string;
  labels?: Record<string, string> | null;
  image?: string;
  created?: string;
}): Record<string, unknown> {
  return {
    Id: p.id,
    Created: p.created ?? '2026-09-24T10:00:00.000000000Z',
    Name: `/${p.name}`,
    State: { Status: p.status, Running: p.status === 'running' },
    Config: { Image: p.image ?? 'devenv-3f2a9c1e:1', Labels: p.labels === undefined ? {} : p.labels },
    Image: 'sha256:abc',
  };
}

/** A container as the pipeline gets it: read by toContainerInfo, without its creation time (publicInfo). */
function read(value: unknown) {
  const inspected = toContainerInfo(value);
  return inspected === undefined ? undefined : publicInfo(inspected);
}

// Plan step 11I2: moved from containerAdapter.test.ts ('containers', 'the objects of a Docker Compose project'); changed
// expectation only in that the inspect JSON is read directly (toContainerInfo, publicInfo), not through the `docker ps`
// and `docker container inspect` of the removed CLI adapter (the list and its batches were the adapter's own).
describe('the containers of `docker container inspect`', () => {
  const metadata = '[{"id":"ghcr.io/devcontainers/features/node:1","settings":{"a,b":"c=d"}}]';

  it('reads labels with commas', () => {
    const info = read(
      containerJson({
        id: 'c1',
        name: 'devenv-acme-api-3f2a9c1e',
        status: 'exited',
        labels: { 'nimblescape.devenv.environment-id': 'env-1', 'devcontainer.metadata': metadata },
      }),
    );
    expect(info).toEqual({
      id: 'c1',
      name: 'devenv-acme-api-3f2a9c1e',
      state: 'stopped',
      rawState: 'exited',
      labels: { 'nimblescape.devenv.environment-id': 'env-1', 'devcontainer.metadata': metadata },
      image: 'devenv-3f2a9c1e:1',
      // Review round 2 of PR #88 (B-R2-1): changed expectation, the ID of the image (`Image`) is passed on.
      imageId: 'sha256:abc',
    });
  });

  // Review round 2 of PR #88 (B-R2-1): the ID of the container's image (`Image` of `docker container inspect`) is read
  // into ContainerInfo.imageId next to its name (`Config.Image`); an empty or missing `Image` gives no imageId.
  describe('review round 2 of PR #88 (B-R2-1): imageId from `Image` of docker container inspect', () => {
    const imageId = `sha256:${'abc'.repeat(21)}d`;
    const inspected = (image: unknown): Record<string, unknown> => {
      const json: Record<string, unknown> = {
        Id: 'c1',
        Created: '2026-09-24T10:00:00.000000000Z',
        Path: '/bin/sh',
        Name: '/devenv-acme-api-3f2a9c1e',
        State: { Status: 'running', Running: true, Pid: 42 },
        Image: image,
        HostConfig: { NetworkMode: 'bridge' },
        Mounts: [],
        Config: { Image: 'devenv-acme-api-brave-noether:2', Labels: { 'nimblescape.devenv.environment-id': 'env-1' } },
      };
      if (image === undefined) delete json.Image;
      return json;
    };

    it('reads `Image` into imageId and `Config.Image` into image', () => {
      const info = read(inspected(imageId));
      expect(info?.imageId).toBe(imageId);
      expect(info?.image).toBe('devenv-acme-api-brave-noether:2');
    });

    it.each([
      ['an empty', ''],
      ['no', undefined],
      ['a non-string', 7],
    ])('gives no imageId for %s `Image`', (_name, image) => {
      const info = read(inspected(image));
      expect(info?.id).toBe('c1');
      expect(info?.image).toBe('devenv-acme-api-brave-noether:2');
      expect(info).not.toHaveProperty('imageId');
    });
  });

  it('skips a malformed entry, and reads a container without labels', () => {
    expect(read({ Id: 'broken' })).toBeUndefined();
    expect(read(containerJson({ id: 'c1', name: 'x', status: 'running', labels: null }))).toEqual({
      id: 'c1',
      name: 'x',
      state: 'running',
      rawState: 'running',
      labels: {},
      image: 'devenv-3f2a9c1e:1',
      imageId: 'sha256:abc',
    });
  });

  it('reads the named volumes that a container mounts', () => {
    const container = {
      ...containerJson({ id: 'c1', name: 'x', status: 'running' }),
      Mounts: [
        { Type: 'volume', Name: 'devenv-acme-api-3f2a9c1e', Destination: '/workspaces' },
        { Type: 'volume', Name: 'api-node_modules', Destination: '/workspaces/api/node_modules' },
        { Type: 'bind', Source: '/tmp', Destination: '/tmp' },
        { Type: 'tmpfs', Destination: '/run' },
      ],
    };
    expect(read(container)?.volumes).toEqual(['devenv-acme-api-3f2a9c1e', 'api-node_modules']);
  });

  it('prefers a running container, then the newest one', () => {
    const containers = [
      containerJson({ id: 'old', name: 'a', status: 'exited', created: '2026-01-01T00:00:00Z' }),
      containerJson({ id: 'new', name: 'b', status: 'exited', created: '2026-02-01T00:00:00Z' }),
      containerJson({ id: 'run', name: 'c', status: 'running', created: '2025-01-01T00:00:00Z' }),
    ].map((value) => toContainerInfo(value) as InspectedContainer);
    expect([...containers].sort(preferred).map((container) => container.id)).toEqual(['run', 'new', 'old']);
  });

  it('reads the subpaths of volumes that each container mounts (review round 11, G3, G4)', () => {
    const db = {
      ...containerJson({ id: 'db1', name: 'devenv-3f2a9c1e-db-1', status: 'running', labels: { 'com.docker.compose.project': 'devenv-3f2a9c1e' } }),
      // As Docker 27 prints a container that Compose created with a volume subpath: HostConfig.Mounts names the volume in
      // Source; Mounts (the mount points) has no subpath.
      HostConfig: {
        Mounts: [
          { Type: 'volume', Source: 'acme-api-3f2a9c1e', Target: '/var/lib/postgresql/data', VolumeOptions: { NoCopy: true, Subpath: 'api/data/pg' } },
          { Type: 'volume', Source: 'acme-api-3f2a9c1e', Target: '/init.sql', ReadOnly: true, VolumeOptions: { Subpath: 'api/init.sql' } },
          { Type: 'volume', Source: 'devenv-3f2a9c1e_cache', Target: '/cache', VolumeOptions: {} },
          { Type: 'bind', Source: '/etc/hosts', Target: '/x' },
        ],
      },
      Mounts: [{ Type: 'volume', Name: 'acme-api-3f2a9c1e', Source: '/var/lib/docker/volumes/acme-api-3f2a9c1e/_data', Destination: '/var/lib/postgresql/data', RW: true }],
    };
    expect(read(db)?.volumeSubpaths).toEqual([
      { volume: 'acme-api-3f2a9c1e', subpath: 'api/data/pg', readOnly: false },
      { volume: 'acme-api-3f2a9c1e', subpath: 'api/init.sql', readOnly: true },
    ]);
    expect(read(containerJson({ id: 'dev1', name: 'acme-api-3f2a9c1e', status: 'running' }))?.volumeSubpaths).toBeUndefined();
  });

  it('reads the targets of the mounts of a container (review round 12, D12-2)', () => {
    const dev = {
      ...containerJson({ id: 'dev1', name: 'acme-api-3f2a9c1e', status: 'running', labels: { 'com.docker.compose.project': 'devenv-3f2a9c1e' } }),
      HostConfig: { Tmpfs: { '/workspaces/api/tmp': 'rw' } },
      Mounts: [
        { Type: 'volume', Name: 'acme-api-3f2a9c1e', Source: '/var/lib/docker/volumes/acme-api-3f2a9c1e/_data', Destination: '/workspaces', RW: true },
        { Type: 'volume', Name: 'devenv-3f2a9c1e_pgdata', Source: '/var/lib/docker/volumes/devenv-3f2a9c1e_pgdata/_data', Destination: '/workspaces/api/.pgdata', RW: true },
        { Type: 'bind', Source: '/home/me/.ssh', Destination: '/home/vscode/.ssh', RW: false },
        { Type: 'tmpfs', Destination: '/run/x' },
        { Type: 'volume', Name: 'broken' },
      ],
    };
    expect(read(dev)?.mountTargets).toEqual([
      { type: 'volume', volume: 'acme-api-3f2a9c1e', target: '/workspaces' },
      { type: 'volume', volume: 'devenv-3f2a9c1e_pgdata', target: '/workspaces/api/.pgdata' },
      { type: 'bind', target: '/home/vscode/.ssh' },
      { type: 'tmpfs', target: '/run/x' },
      { type: 'tmpfs', target: '/workspaces/api/tmp' },
    ]);
  });

  it('reads the subpath of a volume mount from HostConfig.Mounts, matched by volume and target (review round 14, P14-1)', () => {
    const V = 'acme-api-3f2a9c1e';
    const source = `/var/lib/docker/volumes/${V}/_data`;
    const dev = {
      ...containerJson({ id: 'dev1', name: V, status: 'running', labels: { 'com.docker.compose.project': 'devenv-3f2a9c1e' } }),
      HostConfig: {
        Mounts: [
          { Type: 'volume', Source: V, Target: '/workspaces' },
          { Type: 'volume', Source: V, Target: '/workspaces/api/', VolumeOptions: { NoCopy: true, Subpath: 'api' } },
          { Type: 'volume', Source: V, Target: '/workspaces/api/src', VolumeOptions: { Subpath: 'api/src' } },
          // Another volume at the same target does not count; two different subpaths at one target: not known.
          { Type: 'volume', Source: 'other', Target: '/workspaces/api/pgview', VolumeOptions: { Subpath: 'x' } },
          { Type: 'volume', Source: V, Target: '/workspaces/api/twice', VolumeOptions: { Subpath: 'api/a' } },
          { Type: 'volume', Source: V, Target: '/workspaces/api/twice', VolumeOptions: { Subpath: 'api/b' } },
        ],
      },
      // The top-level Mounts have no VolumeOptions.
      Mounts: [
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces', RW: true },
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces/api', RW: true },
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces/api/src', RW: true },
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces/api/pgview', RW: true },
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces/api/twice', RW: true },
      ],
    };
    expect(read(dev)?.mountTargets).toEqual([
      { type: 'volume', volume: V, target: '/workspaces' },
      { type: 'volume', volume: V, target: '/workspaces/api', subpath: 'api' },
      { type: 'volume', volume: V, target: '/workspaces/api/src', subpath: 'api/src' },
      { type: 'volume', volume: V, target: '/workspaces/api/pgview' },
      { type: 'volume', volume: V, target: '/workspaces/api/twice' },
    ]);
  });
});

// Plan step 11I2: moved from containerAdapter.test.ts ('volumes'); the inspect JSON read directly (see above).
describe('the volumes and networks of `docker volume inspect` and `docker network inspect`', () => {
  it('reads volumes with their labels, and skips a malformed entry', () => {
    expect(toVolumeInfo({ Name: 'v1', Driver: 'local', Labels: { 'nimblescape.devenv.environment-id': 'e1', 'nimblescape.devenv.repository': 'acme/api' } })).toEqual({
      name: 'v1',
      labels: { 'nimblescape.devenv.environment-id': 'e1', 'nimblescape.devenv.repository': 'acme/api' },
    });
    expect(toVolumeInfo({ Name: 'v2', Driver: 'local', Labels: null })).toEqual({ name: 'v2', labels: {} });
    expect(toVolumeInfo({ Driver: 'broken' })).toBeUndefined();
  });

  it('reads networks with their labels and containers (review round 1, S2)', () => {
    // Review round 2 (S2-04): changed expectation, with the ID of each network (empty when Docker prints none).
    expect(toNetworkInfo({ Name: 'backend', Id: 'a1b2', Labels: { 'com.docker.compose.project': 'devenv-11111111' }, Containers: { c1: { Name: 'x' }, c2: { Name: 'y' } } })).toEqual({
      name: 'backend',
      id: 'a1b2',
      labels: { 'com.docker.compose.project': 'devenv-11111111' },
      containers: ['c1', 'c2'],
    });
    expect(toNetworkInfo({ Name: 'shared', Labels: null, Containers: {} })).toEqual({ name: 'shared', id: '', labels: {}, containers: [] });
    expect(toNetworkInfo({ Labels: {} })).toBeUndefined();
  });
});
