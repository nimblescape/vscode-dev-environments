// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review of unit 15 (T1, T2, P1): TOKEN_WRITE_SCRIPT and TOKEN_REMOVE_SCRIPT in real containers of the base image of the
// tests (BusyBox), with the tmpfs of the override configuration (TOKEN_TMPFS) and the mounts and rights that a
// configuration can add: the token lands only in that tmpfs, and root writes and removes it without CAP_DAC_OVERRIDE.
// No workspace helper image.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { tokenRunMessage } from '../../src/core/helper/containerToken';
import { SECRET_TOKEN } from '../../src/core/helperChannel/protocol';
import { GITHUB_TOKEN_FILE, LABEL_ENVIRONMENT_ID, TOKEN_FOLDER, TOKEN_TMPFS } from '../../src/core/names';
import type { Environment } from '../../src/core/types';
import { runScript } from '../../src/core/worker/containerScripts';
import { removeTokenFlow } from '../../src/core/worker/tokenRemoveFlow';
import { cliEngine } from './cliEngine';
import { DUMMY_TOKEN, dockerTestContext } from './harness';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL } from './dockerRun';

/** The remote user of the containers: a numeric user without an entry in /etc/passwd (the scripts take it as it is). */
const USER = '1000';
/** The environment that the containers of this file belong to (the flow of the removal finds them by its label). */
const ENVIRONMENT_ID = 'devenv-test-token-environment';

describe('the token in the memory of a real container (review of unit 15)', () => {
  const { run, cli } = dockerTestContext('containerToken');
  const created: { containers: string[]; volumes: string[] } = { containers: [], volumes: [] };

  afterAll(() => {
    for (const name of created.containers) cli.run(['rm', '-f', '-v', name]);
    for (const name of created.volumes) cli.run(['volume', 'rm', name]);
  });

  /** A running container of the base image with the tmpfs of the token and `args`, as the override configuration starts it. */
  function start(args: string[]): string {
    const name = `devenv-test-token-${crypto.randomBytes(4).toString('hex')}`;
    created.containers.push(name);
    cli.ok([
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'none',
      '--label',
      `${TEST_RUN_LABEL}=${run.runId}`,
      '--label',
      `${LABEL_ENVIRONMENT_ID}=${ENVIRONMENT_ID}`,
      ...args,
      '--tmpfs',
      TOKEN_TMPFS,
      TEST_BASE_IMAGE,
      'sleep',
      '600',
    ]);
    return name;
  }

  function volume(): string {
    const name = `devenv-test-token-${crypto.randomBytes(4).toString('hex')}`;
    created.volumes.push(name);
    cli.ok(['volume', 'create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, name]);
    return name;
  }

  /** The files that hold the token in the folders where a write could land (as root with all rights; not /dev, /proc, /sys). */
  function tokenFiles(container: string): string[] {
    const found = cli.run(['exec', '--privileged', '-u', 'root', container, 'sh', '-c', `grep -rl -s '${DUMMY_TOKEN}' /run /var /tmp /home /root /etc 2>/dev/null || true`]);
    return found.out.split('\n').filter((line) => line !== '');
  }

  // Plan step 11B1: the removal is a flow of the worker; here it runs against the real engine through the port of the tests.
  // Plan step 11I (PR B): the port holds the token as the secret of the operation, as the worker does.
  const engine = cliEngine(cli, { [SECRET_TOKEN]: DUMMY_TOKEN });
  /**
   * Plan step 11I (PR B): the write as the pipeline runs it (EnvironmentService.writeGitToken, in place of the removed
   * writeContainerToken): the script `tokenWrite` of the registry as root, the token as the secret of the operation by its
   * name (cliEngine writes it to the standard input of `docker exec -i`, as the worker does); a failure throws its reason
   * without the token.
   */
  const write = async (container: string): Promise<void> => {
    const result = await runScript(engine, container, 'tokenWrite', [USER, 'devenv-test'], { user: 'root', timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(tokenRunMessage(result, DUMMY_TOKEN));
  };
  const remove = (container: string) =>
    removeTokenFlow({
      environmentId: ENVIRONMENT_ID,
      containerName: container,
      engine,
      records: { get: async () => ({ id: ENVIRONMENT_ID, remoteUser: USER }) as Environment },
    });

  it.each<[string, string[]]>([
    ['--cap-drop DAC_OVERRIDE', ['--cap-drop', 'DAC_OVERRIDE']],
    ['--cap-drop ALL with CHOWN, SETUID, SETGID', ['--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID']],
  ])('P1: writes the token for the user without DAC_OVERRIDE of root (%s), again after the user took the rights away, and removes it', async (_name, args) => {
    const container = start(args);
    await write(container);
    expect(cli.ok(['exec', '-u', USER, container, 'cat', GITHUB_TOKEN_FILE])).toBe(DUMMY_TOKEN);
    // A second open.
    await write(container);
    expect(cli.ok(['exec', '-u', USER, container, 'cat', GITHUB_TOKEN_FILE])).toBe(DUMMY_TOKEN);
    // What the user may do in its folder: folders of mode 000, a link out of it, the folder itself of mode 000.
    cli.ok(['exec', '-u', USER, container, 'sh', '-c', `cd ${TOKEN_FOLDER} && mkdir -p x/y && echo x > x/y/f && ln -s / l && chmod 000 x/y x gh && chmod 000 ${TOKEN_FOLDER}`]);
    await write(container);
    expect(cli.ok(['exec', '-u', USER, container, 'cat', GITHUB_TOKEN_FILE])).toBe(DUMMY_TOKEN);
    expect(cli.ok(['exec', '--privileged', '-u', 'root', container, 'ls', '-A', TOKEN_FOLDER]).split('\n').sort()).toEqual(['gh', 'github-token']);
    // A sign-out.
    cli.ok(['exec', '-u', USER, container, 'sh', '-c', `cd ${TOKEN_FOLDER} && mkdir -p x/y && chmod 000 x/y x gh && chmod 000 ${TOKEN_FOLDER}`]);
    // Plan step 11B1: the flow reports the container that it emptied (its short ID).
    expect(await remove(container)).toEqual({ outcome: 'removed', container: cli.container(container)!.Id.slice(0, 12) });
    expect(tokenFiles(container)).toEqual([]);
    expect(cli.run(['exec', '--privileged', '-u', 'root', container, 'ls', '-A', TOKEN_FOLDER]).out).toBe('');
  });

  it('T1: writes nothing when a volume on /var/run (/run through the link of the image) hides the tmpfs; the volume keeps no token', async () => {
    expect(cli.ok(['run', '--rm', '--network', 'none', TEST_BASE_IMAGE, 'readlink', '/var/run'])).toMatch(/^(\.\.)?\/run$/);
    const hiding = volume();
    // The folder in the volume, as an image with /run/devenv would bring it there.
    cli.ok(['run', '--rm', '--network', 'none', '-v', `${hiding}:/v`, TEST_BASE_IMAGE, 'mkdir', '-m', '0700', '/v/devenv']);
    const container = start(['--mount', `type=volume,src=${hiding},dst=/var/run`]);
    await expect(write(container)).rejects.toThrow(/is not (a tmpfs mount|the tmpfs) of the container/);
    expect(tokenFiles(container)).toEqual([]);
    // The removal finds no tmpfs of the extension there and removes nothing (greenfield, user decision 2026-09-27:
    // changed expectation, exit code 3 like any other mount, before exit code 0 for a container of an earlier version).
    await expect(remove(container)).rejects.toThrow('is not the tmpfs of the container');
    cli.ok(['rm', '-f', container]);
    const inVolume = cli.run(['run', '--rm', '--network', 'none', '-v', `${hiding}:/v`, TEST_BASE_IMAGE, 'sh', '-c', `grep -rl '${DUMMY_TOKEN}' /v || true`]);
    expect(inVolume.out).toBe('');
  });

  it('T2: writes nothing into a tmpfs stacked on ours through /var/run/devenv', async () => {
    const container = start(['--mount', 'type=tmpfs,dst=/var/run/devenv,tmpfs-size=1048576,tmpfs-mode=0700']);
    await expect(write(container)).rejects.toThrow('is not the tmpfs of the container');
    expect(tokenFiles(container)).toEqual([]);
    await expect(remove(container)).rejects.toThrow('is not the tmpfs of the container');
  });

  it('T2: writes nothing when a file of the computer lies at /var/run/devenv/github-token', async () => {
    const file = path.join(run.runDir, `token-file-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(file, '');
    try {
      const container = start(['-v', `${file}:/var/run/devenv/github-token`]);
      await expect(write(container)).rejects.toThrow('is not the tmpfs of the container');
      cli.ok(['rm', '-f', container]);
      expect(fs.readFileSync(file, 'utf8')).toBe('');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
