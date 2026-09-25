// Clone of a public repository into a workspace volume with the real workspace helper (implementation notes 7), then
// the configuration files from the volume. Nothing of the repository is built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { WorkspaceHelper } from '../../src/core/helper/workspaceHelper';
import { parseJsonc } from '../../src/core/jsonc';
import { splitRepository } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { DUMMY_TOKEN, HELPER_DOCKERFILE, Timings, dockerTestContext } from './harness';

/** A small public repository with a Dev Container configuration. */
const REPOSITORY = process.env.DEVENV_TEST_REPOSITORY ?? 'microsoft/vscode-remote-try-node';
const FOLDER = `/workspaces/${splitRepository(REPOSITORY).name}`;

describe(`clone of ${REPOSITORY}`, () => {
  const { run, env, cli, log } = dockerTestContext('clone');
  const docker = new ContainerAdapter(new NodeProcessRunner(), run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const volumeName = `devenv-test-clone-${run.runId}`;
  const timings = new Timings();

  /** A command in the helper on the volume, without the Docker socket and without network. */
  async function inVolume(command: string[]): Promise<{ exitCode: number | null; stdout: string }> {
    const result = await helper.run(volumeName, command, { docker: false, network: false });
    return { exitCode: result.exitCode, stdout: result.stdout.trim() };
  }

  beforeAll(async () => {
    await timings.measure('workspace helper image ready', () => helper.ensureImage());
    cli.ok(['volume', 'create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, volumeName]);
  });

  afterAll(() => {
    timings.print(`Timings of the clone scenario (${REPOSITORY}):`);
    removeRunObjects(cli, run.runId);
    expect(cli.volume(volumeName)).toBeUndefined();
  });

  it('clones with a dummy token, then lists and reads the configurations', async () => {
    await timings.measure('clone', () => helper.clone({ volumeName, repository: REPOSITORY, token: DUMMY_TOKEN }));

    const remote = await inVolume(['git', '-C', FOLDER, 'remote', 'get-url', 'origin']);
    expect(remote).toEqual({ exitCode: 0, stdout: `https://github.com/${REPOSITORY}.git` });
    // The token is not in the volume (implementation notes 7 "Token for the clone"). grep ends with 1 when nothing matches.
    const token = await inVolume(['grep', '-rl', DUMMY_TOKEN, '/workspaces']);
    expect(token).toEqual({ exitCode: 1, stdout: '' });

    const configPaths = await timings.measure('list configurations', () =>
      helper.listConfigurations({ volumeName, repository: REPOSITORY }),
    );
    expect(configPaths.length).toBeGreaterThan(0);
    for (const configPath of configPaths) expect(configPath).toMatch(/(^|\/)\.?devcontainer\.json$/);
    if (process.env.DEVENV_TEST_REPOSITORY === undefined) expect(configPaths[0]).toBe('.devcontainer/devcontainer.json');

    const files = await timings.measure('read configuration files', () =>
      helper.readConfigFiles({ volumeName, repository: REPOSITORY, configPath: configPaths[0] }),
    );
    expect(files).toBeDefined();
    const config = parseJsonc<Record<string, unknown>>(files!.configText);
    expect(typeof config).toBe('object');
    expect(config.image !== undefined || config.build !== undefined || config.dockerFile !== undefined).toBe(true);
    if (files!.dockerfilePath !== undefined) expect(files!.dockerfileText).toMatch(/^\s*FROM\s/im);
    expect(await helper.readConfigFiles({ volumeName, repository: REPOSITORY, configPath: '.devcontainer/missing/devcontainer.json' })).toBeUndefined();
  });

  it('a second clone finds the repository and leaves it unchanged', async () => {
    const head = await inVolume(['git', '-C', FOLDER, 'rev-parse', 'HEAD']);
    const output: string[] = [];
    await timings.measure('second clone (idempotent)', () =>
      helper.clone({ volumeName, repository: REPOSITORY, token: DUMMY_TOKEN, onOutput: (text) => output.push(text) }),
    );
    expect(output.join('')).toContain('The repository is already in the volume.');
    expect(await inVolume(['git', '-C', FOLDER, 'rev-parse', 'HEAD'])).toEqual(head);
  });

  it('leaves no helper container and builds no image', () => {
    expect(cli.lines(['ps', '-a', '-q', '--filter', `volume=${volumeName}`])).toEqual([]);
    expect(cli.lines(['image', 'ls', '-q', '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`])).toEqual([]);
  });
});
