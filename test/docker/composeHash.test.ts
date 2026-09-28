// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Recreate offer, review round 2 (E1–E3): the premise of the direct check before the Compose `up` of a recreation. The
// hash that COMPOSE_HASH_SCRIPT prints for a service (docker compose config --hash, without the engine) equals the
// label com.docker.compose.config-hash of the container that `up` created from the same model, also for a model file in
// another folder; a changed label of the service (for example nimblescape.devenv.host-access after the checks were
// turned off) changes it; and with equal hashes and image IDs, an `up` after the removal of the dev container creates
// only the dev container and keeps the container of the other service. Runs the Compose of this computer (the pipeline
// runs the same script in the workspace helper, whose Compose also runs `up`).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { COMPOSE_HASH_SCRIPT, parseComposeHashes } from '../../src/core/helper/scripts';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL } from './dockerRun';
import { dockerTestContext } from './harness';

describe('the configuration hash of Docker Compose (recreate offer, review round 2)', () => {
  const { run, env, cli, log } = dockerTestContext('composeHash');
  const project = `devenv-hash-${run.runId}`;
  const folder = path.join(run.runDir, 'compose-hash');
  const upFile = path.join(folder, 'up', 'compose.json');
  /** Anonymous volumes of removed containers, which `down -v` does not see. */
  const leftoverVolumes: string[] = [];

  function model(hostAccess: string): string {
    const labels = { [TEST_RUN_LABEL]: run.runId };
    return JSON.stringify({
      name: project,
      services: {
        app: { image: TEST_BASE_IMAGE, command: ['sleep', '600'], labels, volumes: [{ type: 'volume', target: '/cache' }] },
        db: {
          image: TEST_BASE_IMAGE,
          command: ['sleep', '601'],
          labels: { ...labels, 'nimblescape.devenv.host-access': hostAccess },
          volumes: [{ type: 'volume', source: 'data', target: '/data' }],
        },
        // Review round 3 (G1): a service of a profile (started through runServices).
        tools: { image: TEST_BASE_IMAGE, command: ['sleep', '602'], labels, profiles: ['debug'] },
      },
      volumes: { data: { name: `${project}_data`, labels } },
    });
  }

  function compose(...args: string[]): string {
    const result = cli.run(['compose', '--project-name', project, '--profile', '*', '-f', upFile, ...args]);
    log.info(`docker compose ${args.join(' ')}: ${result.code} ${result.err}`);
    expect(result.code, result.err).toBe(0);
    return result.out;
  }

  function hashes(text: string): Map<string, string> {
    const file = path.join(folder, 'elsewhere', 'compose.json');
    const result = spawnSync('node', ['-e', COMPOSE_HASH_SCRIPT, file, project], {
      input: text,
      encoding: 'utf8',
      env: { ...env, PATH: `${path.dirname(run.dockerPath)}${path.delimiter}${env.PATH ?? ''}` },
    });
    expect(result.status, result.stderr).toBe(0);
    return parseComposeHashes(result.stdout);
  }

  function container(service: string) {
    return cli.container(`${project}-${service}-1`);
  }

  afterAll(() => {
    cli.run(['compose', '--project-name', project, '--profile', '*', '-f', upFile, 'down', '-v']);
    for (const volume of leftoverVolumes) cli.run(['volume', 'rm', volume]);
  });

  it('equals the label of the container, changes with the model, and keeps the other service at an up without the dev container', () => {
    fs.mkdirSync(path.dirname(upFile), { recursive: true });
    fs.writeFileSync(upFile, model('restricted'));
    compose('up', '-d');
    const db = container('db');
    const app = container('app');
    expect(db?.State.Running).toBe(true);

    const computed = hashes(model('restricted'));
    expect(computed.get('db')).toBe(db?.Config.Labels?.['com.docker.compose.config-hash']);
    expect(computed.get('app')).toBe(app?.Config.Labels?.['com.docker.compose.config-hash']);
    // Review round 3 (G1): with all profiles, the service of a profile has its hash too, equal to its label.
    expect(computed.get('tools')).toBe(container('tools')?.Config.Labels?.['com.docker.compose.config-hash']);
    expect(computed.get('tools')).toMatch(/^[0-9a-f]{64}$/);
    expect(db?.Config.Labels?.['com.docker.compose.image']).toBe(cli.image(TEST_BASE_IMAGE)?.Id);
    // E1: another value of nimblescape.devenv.host-access gives another hash, so Compose would create the container
    // again.
    expect(hashes(model('unrestricted')).get('db')).not.toBe(computed.get('db'));

    // The recreation of the dev container: removed without its volumes, then `up` without --no-recreate.
    const anonymous = (app?.Mounts ?? []).filter((mount) => mount.Type === 'volume' && mount.Destination === '/cache').map((mount) => mount.Name ?? '');
    leftoverVolumes.push(...anonymous.filter((name) => name !== ''));
    const tools = container('tools')?.Id;
    expect(tools).toBeDefined();
    cli.ok(['rm', '-f', String(app?.Id)]);
    compose('up', '-d');
    expect(container('db')?.Id).toBe(db?.Id);
    expect(container('tools')?.Id).toBe(tools);
    expect(container('app')?.Id).not.toBe(app?.Id);
    // V1: the volume without a name of the removed dev container is not carried over; it stays.
    for (const name of anonymous) expect(cli.volume(name)).toBeDefined();
    expect(container('app')?.Mounts.find((mount) => mount.Destination === '/cache')?.Name).not.toBe(anonymous[0]);
  });
});
