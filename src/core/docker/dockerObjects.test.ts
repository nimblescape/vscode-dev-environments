// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11B3a (B-R2-16): the reading of the inspect JSON that ContainerAdapter and EngineDocker share.
import { describe, expect, it } from 'vitest';
import { toContainerInfo } from './dockerObjects';

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
