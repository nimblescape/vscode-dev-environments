// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the messages of the batch helper and the `docker run` of the helper (plan step 11G3: the spec of its
// run over the Engine API).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loaderCommand } from '../loader/pipeLoader';
import {
  BATCH_CHUNK_CHARACTERS,
  BATCH_DOCKER_SOCKET,
  BATCH_ENTRY,
  BATCH_GIT_UID,
  BATCH_SCRIPT_PATH,
  BATCH_SOCKET_FOLDER,
  batchContainerName,
  batchRunSpec,
  parseBatchChunkParams,
  parseBatchParams,
  parseBatchStepParams,
  parseBatchStepValue,
} from './batch';
import { MAX_OPERATION_TIMEOUT_MS } from './protocol';

const SESSION = '0a1b2c3d4e5f60718293a4b5';
const INPUT = 'ffeeddccbbaa998877665544';
const IMAGE = `sha256:${'0'.repeat(64)}`;

describe('the batch messages (plan step 6, PR B)', () => {
  it('checks the parameters of batch strictly', () => {
    const good = { session: SESSION, volume: 'devenv-v', image: IMAGE, socket: '/run/user/1000/docker.sock' };
    expect(parseBatchParams(good)).toEqual(good);
    for (const bad of [
      { ...good, session: 'x' },
      { ...good, volume: '-v' },
      { ...good, volume: 'a,b' },
      { ...good, image: 'devenv-helper:abc' },
      { ...good, image: `sha256:${'0'.repeat(63)}` },
      { ...good, socket: 'docker.sock' },
      { ...good, socket: '/a,dst=/etc' },
      { ...good, socket: '/a"b' },
      { ...good, env: { DOCKER_HOST: 'x' } },
      { ...good, command: ['sh'] },
      null,
    ]) {
      expect(parseBatchParams(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('checks a step: a known kind, either its parameters or the ID of its pieces, and a whole time limit', () => {
    expect(parseBatchStepParams({ session: SESSION, kind: 'clone', params: { repository: 'a/b' }, timeoutMs: 5 })).toEqual({ session: SESSION, kind: 'clone', params: { repository: 'a/b' }, timeoutMs: 5 });
    expect(parseBatchStepParams({ session: SESSION, kind: 'up', input: INPUT })).toEqual({ session: SESSION, kind: 'up', input: INPUT });
    for (const bad of [
      { session: SESSION, kind: 'docker', params: {} },
      { session: SESSION, kind: 'clone' },
      { session: SESSION, kind: 'clone', params: {}, input: INPUT },
      { session: SESSION, kind: 'clone', input: 'x' },
      { session: SESSION, kind: 'clone', params: {}, timeoutMs: 0 },
      { session: SESSION, kind: 'clone', params: {}, timeoutMs: 1.5 },
      { session: SESSION, kind: 'clone', params: {}, timeoutMs: MAX_OPERATION_TIMEOUT_MS + 1 },
      { session: SESSION, kind: 'clone', params: {}, command: 'id' },
    ]) {
      expect(parseBatchStepParams(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('checks a piece of input and the value of a step', () => {
    expect(parseBatchChunkParams({ session: SESSION, input: INPUT, data: 'x' })).toEqual({ session: SESSION, input: INPUT, data: 'x' });
    expect(parseBatchChunkParams({ session: SESSION, input: INPUT, data: '' })).toBeUndefined();
    expect(parseBatchChunkParams({ session: SESSION, input: INPUT, data: 'x'.repeat(BATCH_CHUNK_CHARACTERS + 1) })).toBeUndefined();
    expect(parseBatchStepValue({ exitCode: 0 })).toEqual({ exitCode: 0 });
    expect(parseBatchStepValue({ exitCode: null })).toEqual({ exitCode: null });
    expect(parseBatchStepValue({ exitCode: '0' })).toBeUndefined();
    expect(parseBatchStepValue({ exitCode: 0, stdout: 'x' })).toBeUndefined();
  });

  it('starts the helper without a variable, with the session label and the pipe loader', () => {
    // Plan step 11G3: changed expectation: the helper runs over the Engine API (DockerEngine.runAttached) instead of the
    // worker's own `docker run`, so the spec of its create replaces the arguments of that `docker run --rm -i --pull
    // never` (each option maps to one field; `--rm -i`, `--pull never` and `--log-driver none` are runAttached's own), and
    // the volume check is the inspect of the port instead of `docker volume inspect` (batchVolumeArgs is removed).
    expect(batchContainerName(SESSION)).toBe(`devenv-batch-${SESSION}`);
    expect(batchRunSpec({ session: SESSION, volume: 'devenv-v', image: IMAGE, socket: '/var/run/docker.sock', scriptHash: 'f'.repeat(64) })).toEqual({
      name: `devenv-batch-${SESSION}`,
      image: IMAGE,
      command: loaderCommand({ path: BATCH_SCRIPT_PATH, hash: 'f'.repeat(64), entry: BATCH_ENTRY }),
      labels: { 'nimblescape.devenv.helper-run': 'true', 'nimblescape.devenv.channel-step': SESSION },
      mounts: [
        { type: 'volume', source: 'devenv-v', target: '/workspaces' },
        { type: 'volume', source: 'devenv-helper-cache', target: '/devenv-cache' },
        { type: 'bind', source: '/var/run/docker.sock', target: BATCH_DOCKER_SOCKET },
      ],
      tmpfs: { '/run/devenv-secrets': 'rw,noexec,nosuid,nodev,size=1m,mode=0700' },
      securityOpt: ['no-new-privileges'],
    });
  });

  it('matches the user and the socket folder of the helper image', () => {
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../../../resources/helper/Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`useradd --system --uid ${BATCH_GIT_UID} --gid ${BATCH_GIT_UID} --no-create-home --home-dir /nonexistent`);
    expect(dockerfile).toContain(`install -d -m 0700 -o root -g root ${BATCH_SOCKET_FOLDER};`);
  });
});
