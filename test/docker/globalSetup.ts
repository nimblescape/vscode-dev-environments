// Global setup of the Docker integration tests (npm run test:docker). It checks that Docker runs, prepares a Docker
// configuration without the credentials of the user, and records the containers, volumes, and images of the engine.
// The teardown removes what the run left behind, and fails when the run left a new object (except the workspace helper
// image and pulled base images) or removed an object of the baseline.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TestProject } from 'vitest/node';
import { devcontainerCliVersion } from '../../scripts/cliVersion.mjs';
import { findDockerCli } from '../../src/core/docker/dockerCli';
import { extractBaseImages } from '../../src/core/imageCheck/dockerfile';
import { HELPER_CACHE_VOLUME } from '../../src/core/names';
import {
  DockerCli,
  OLD_GIT_BASE_IMAGE,
  TEST_BASE_IMAGE,
  baselinePath,
  createDockerConfig,
  failureMarker,
  removeRunObjects,
  takeSnapshot,
  testDockerEnv,
  unexpectedChanges,
  type DockerTestRun,
} from './dockerRun';

const HELPER_DOCKERFILE = path.resolve(__dirname, '../../resources/helper/Dockerfile');

/** The endpoint of the current Docker context of the user; its configuration is read only for this. */
function contextEndpoint(dockerPath: string): string | undefined {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  const cli = new DockerCli(dockerPath, process.env);
  const result = cli.run(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']);
  if (result.code !== 0) return undefined;
  const host: unknown = JSON.parse(result.out);
  return typeof host === 'string' && host !== '' ? host : undefined;
}

export default async function setup(project: TestProject): Promise<() => void> {
  // Vitest sets the compile-time constants of vitest.docker.config.ts only in the test workers, not here.
  Object.assign(globalThis, { __DEVCONTAINER_CLI_VERSION__: devcontainerCliVersion() });
  const { helperImageTag } = await import('../../src/core/helper/helperImage');
  const dockerPath = findDockerCli(process.env, process.platform);
  if (!dockerPath) throw new Error('The Docker tests need the Docker CLI, and it was not found.');
  const runId = crypto.randomBytes(4).toString('hex');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-docker-tests-'));
  const run: DockerTestRun = {
    runId,
    runDir,
    dockerPath,
    dockerConfig: path.join(runDir, 'docker-config'),
    dockerHost: contextEndpoint(dockerPath),
  };
  createDockerConfig(run.dockerConfig, process.env);
  const cli = new DockerCli(dockerPath, testDockerEnv(run));
  const info = cli.run(['info', '--format', '{{json .ServerVersion}}']);
  if (info.code !== 0) throw new Error(`The Docker tests need a running Docker engine: ${info.err || info.out}`);

  const baseline = takeSnapshot(cli);
  fs.writeFileSync(baselinePath(run), JSON.stringify(baseline, null, 2));
  project.provide('dockerTest', run);
  console.log(`Docker tests: run ${runId}, engine ${info.out}, logs in ${runDir}`);

  const helperDockerfile = fs.readFileSync(HELPER_DOCKERFILE, 'utf8');
  const allowedTags = [helperImageTag(helperDockerfile), ...extractBaseImages(helperDockerfile), TEST_BASE_IMAGE, OLD_GIT_BASE_IMAGE];

  return () => {
    // The test files remove their objects themselves; this is the safety net after a crash.
    const removed = removeRunObjects(cli, runId);
    if (removed.length > 0) console.warn(`The teardown removed what the tests left: ${removed.join(', ')}`);
    if (!baseline.volumes.includes(HELPER_CACHE_VOLUME)) cli.run(['volume', 'rm', HELPER_CACHE_VOLUME]);
    const changes = unexpectedChanges(baseline, takeSnapshot(cli), allowedTags);
    const keep = changes.length > 0 || fs.existsSync(failureMarker(run)) || process.env.DEVENV_TEST_KEEP_LOGS === '1';
    if (!keep) {
      fs.rmSync(runDir, { recursive: true, force: true });
    } else {
      console.warn(`The logs of the Docker tests are in ${runDir}`);
    }
    if (changes.length > 0) {
      throw new Error(`The Docker tests left or removed Docker objects:\n${changes.map((change) => `- ${change}`).join('\n')}`);
    }
  };
}
