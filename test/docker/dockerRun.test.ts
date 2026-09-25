// The check for leftovers of the Docker tests (unexpectedChanges), without Docker calls.
import { describe, expect, it } from 'vitest';
import { unexpectedChanges, type DockerSnapshot } from './dockerRun';

const ID_USER = `sha256:${'1'.repeat(64)}`;
const ID_PULLED = `sha256:${'2'.repeat(64)}`;

function snapshot(images: DockerSnapshot['images']): DockerSnapshot {
  return { containers: [], volumes: [], images };
}

describe('unexpectedChanges', () => {
  it('reports a tag of the baseline that is gone, also an allowed one, while its image stays', () => {
    // A pull moved the tag of the user to a newer image, and a removal of that image took the tag with it.
    const baseline = snapshot([{ id: ID_USER, tags: ['alpine:3.22'] }]);
    const current = snapshot([{ id: ID_USER, tags: [] }]);
    expect(unexpectedChanges(baseline, current, ['alpine:3.22'])).toEqual([`tag alpine:3.22 of the baseline image ${ID_USER.slice(7, 19)} is gone`]);
  });

  it('reports a tag of the baseline that moved to another image, unless it is allowed', () => {
    const baseline = snapshot([{ id: ID_USER, tags: ['alpine:3.22'] }]);
    const current = snapshot([
      { id: ID_USER, tags: [] },
      { id: ID_PULLED, tags: ['alpine:3.22'] },
    ]);
    expect(unexpectedChanges(baseline, current, [])).toEqual([
      `new image ${ID_PULLED.slice(7, 19)} alpine:3.22`,
      `tag alpine:3.22 of the baseline moved to ${ID_PULLED.slice(7, 19)}`,
    ]);
    // A pulled base image or a rebuilt helper image of the tests may take its tag.
    expect(unexpectedChanges(baseline, current, ['docker.io/library/alpine:3.22'])).toEqual([]);
  });

  it('reports nothing when the images and tags of the baseline are unchanged', () => {
    const baseline = snapshot([{ id: ID_USER, tags: ['alpine:3.22', 'mine:1'] }]);
    expect(unexpectedChanges(baseline, snapshot([{ id: ID_USER, tags: ['mine:1', 'alpine:3.22'] }]), [])).toEqual([]);
  });
});
