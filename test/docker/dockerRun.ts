// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker objects of the integration tests (npm run test:docker): the Docker CLI with a configuration of its own, snapshots
// of the containers, volumes, and images of the engine, and the removal of what a test run created. Every object that a
// test creates carries the label devenv-test.run=<run ID>, or uses a volume that carries it, so the cleanup never touches
// other objects of the user. This module does not import vitest: the global setup uses it too.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Label on every container, volume, and image that the tests create. Its value is the run ID. Not a key with the prefix
 * `devenv.`: the host access policy refuses such labels in the runArgs of a configuration.
 */
export const TEST_RUN_LABEL = 'devenv-test.run';

/**
 * Base image of the test configurations: the official Alpine image, from the Docker Hub mirror of Google
 * (mirror.gcr.io). It answers anonymous clients without a token and without the pull limit of Docker Hub (Amazon ECR
 * Public answered bursts of the tests with HTTP 429). A developer machine hardly has an image of this name, so the pulls
 * and the removal of unused base images (concept 7.14) never change a local `alpine` image. The Dockerfiles of the
 * tests use `apk`: an override must be an Alpine image.
 */
export const TEST_BASE_IMAGE = process.env.DEVENV_TEST_BASE_IMAGE ?? 'mirror.gcr.io/library/alpine:3.22';

/**
 * Base image with a Git older than 2.32 (Alpine 3.13: Git 2.30), for container-only Git with a Git that ignores
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_COUNT (concept section 9). An override must be an Alpine image with such a Git.
 */
export const OLD_GIT_BASE_IMAGE = process.env.DEVENV_TEST_OLD_GIT_IMAGE ?? 'mirror.gcr.io/library/alpine:3.13';

/** What the global setup passes to the test files (vitest `provide`/`inject`). */
export interface DockerTestRun {
  /** Value of the label devenv-test.run on the objects of this run. */
  runId: string;
  /** Temporary folder of the run: storage folders, logs, the Docker configuration, the baseline. */
  runDir: string;
  dockerPath: string;
  /** DOCKER_CONFIG of every Docker call of the tests: a configuration without credentials, so none of the user are used. */
  dockerConfig: string;
  /** Endpoint of the Docker context of the user, passed as DOCKER_HOST (the configuration of the tests has no contexts). */
  dockerHost?: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    dockerTest: DockerTestRun;
  }
}

/** Environment of the Docker calls of the tests (the Docker CLI, the core modules, the credential store). */
export function testDockerEnv(run: DockerTestRun): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: run.dockerConfig };
  if (run.dockerHost) env.DOCKER_HOST = run.dockerHost;
  delete env.DOCKER_CONTEXT;
  return env;
}

/** Registry of the only `auths` entry of the Docker configuration of the tests: a name that never resolves (RFC 2606). */
export const NO_CREDENTIALS_REGISTRY = 'devenv-test.invalid';

/**
 * Creates a Docker configuration folder without credentials, credential helpers, or contexts. `docker build` needs the
 * buildx plugin: system plugin folders are found anyway, and a plugin in the configuration folder of the user (Docker
 * Desktop installs it there) is linked.
 */
export function createDockerConfig(dir: string, env: NodeJS.ProcessEnv): void {
  const plugins = path.join(dir, 'cli-plugins');
  fs.mkdirSync(plugins, { recursive: true });
  // An empty `{}` is not enough: without credsStore, credHelpers, or auths, the Docker CLI and buildx use the default
  // credential helper of the platform (osxkeychain, wincred, pass or secretservice) if it is on PATH, and so the logins
  // of the user. An auths entry for a registry that never resolves turns that off.
  const config = { auths: { [NO_CREDENTIALS_REGISTRY]: {} } };
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const userFolder = env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');
  const name = process.platform === 'win32' ? 'docker-buildx.exe' : 'docker-buildx';
  const buildx = path.join(userFolder, 'cli-plugins', name);
  if (fs.existsSync(buildx)) fs.symlinkSync(fs.realpathSync(buildx), path.join(plugins, name));
}

export interface DockerResult {
  code: number | null;
  out: string;
  err: string;
}

/** Synchronous Docker CLI calls for the arrangement and the assertions of the tests. */
export class DockerCli {
  constructor(
    readonly dockerPath: string,
    readonly env: NodeJS.ProcessEnv,
  ) {}

  run(args: readonly string[], input?: string): DockerResult {
    const result = spawnSync(this.dockerPath, [...args], { encoding: 'utf8', input, env: this.env, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
  }

  /** Like run, but throws on a non-zero exit code; returns stdout. */
  ok(args: readonly string[], input?: string): string {
    const result = this.run(args, input);
    if (result.code !== 0) throw new Error(`docker ${args.join(' ')} failed with exit code ${result.code}: ${result.err || result.out}`);
    return result.out;
  }

  /** Non-empty lines of stdout. */
  lines(args: readonly string[]): string[] {
    return this.ok(args)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  /** `docker container inspect`, or `undefined` if the container does not exist. */
  container(name: string): ContainerDetails | undefined {
    return this.inspect<ContainerDetails>('container', name);
  }

  /** `docker image inspect`, or `undefined` if the image does not exist. */
  image(reference: string): ImageDetails | undefined {
    return this.inspect<ImageDetails>('image', reference);
  }

  /** `docker volume inspect`, or `undefined` if the volume does not exist. */
  volume(name: string): VolumeDetails | undefined {
    return this.inspect<VolumeDetails>('volume', name);
  }

  private inspect<T>(kind: 'container' | 'volume' | 'image', name: string): T | undefined {
    const result = this.run([kind, 'inspect', name]);
    if (result.code !== 0) return undefined;
    return (JSON.parse(result.out) as T[])[0];
  }
}

/** The fields of `docker container inspect` that the tests read. */
export interface ContainerDetails {
  Id: string;
  /** With a leading `/`. */
  Name: string;
  State: { Status: string; Running: boolean };
  Config: { Image: string; Labels: Record<string, string> | null; Env?: string[] | null; Tty?: boolean; OpenStdin?: boolean };
  HostConfig: { AutoRemove?: boolean; CapDrop?: string[] | null };
  Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
}

/** The fields of `docker image inspect` that the tests read. */
export interface ImageDetails {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
  Architecture?: string;
  Config: { Labels: Record<string, string> | null };
}

/** The fields of `docker volume inspect` that the tests read. */
export interface VolumeDetails {
  Name: string;
  Labels: Record<string, string> | null;
}

export interface ImageSummary {
  id: string;
  /** `repository:tag`, without `<none>`. Empty for a dangling image. */
  tags: string[];
}

export interface DockerSnapshot {
  containers: Array<{ id: string; name: string }>;
  volumes: string[];
  images: ImageSummary[];
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** All containers, volumes, and images of the engine. */
export function takeSnapshot(docker: DockerCli): DockerSnapshot {
  const containers = jsonLines(docker.ok(['ps', '-a', '--no-trunc', '--format', '{{json .}}'])).map((item) => ({
    id: String(item.ID),
    name: String(item.Names),
  }));
  const volumes = docker.lines(['volume', 'ls', '-q']);
  const images = new Map<string, ImageSummary>();
  for (const item of jsonLines(docker.ok(['image', 'ls', '-a', '--no-trunc', '--format', '{{json .}}']))) {
    const id = String(item.ID);
    const image = images.get(id) ?? { id, tags: [] };
    images.set(id, image);
    if (item.Repository !== '<none>' && item.Tag !== '<none>') image.tags.push(`${item.Repository}:${item.Tag}`);
  }
  return { containers, volumes, images: [...images.values()] };
}

/** `docker.io/library/alpine:3.22` → `alpine:3.22`, the name that `docker image ls` shows. */
export function familiarName(reference: string): string {
  return reference.replace(/^docker\.io\/library\//, '').replace(/^docker\.io\//, '');
}

/**
 * Differences between two snapshots that the tests must not leave: containers, volumes, and images that are new, except
 * images whose tags are all in `allowedTags` (the workspace helper image, pulled base images); objects of the baseline
 * that are gone (the tests must never remove an object of the user); and tags of the baseline images that are gone (also
 * allowed ones), or that moved to another image (except allowed ones: a pull or a build of the tests may move them).
 */
export function unexpectedChanges(baseline: DockerSnapshot, current: DockerSnapshot, allowedTags: Iterable<string>): string[] {
  const allowed = new Set([...allowedTags].map(familiarName));
  const changes: string[] = [];
  const baselineContainers = new Set(baseline.containers.map((container) => container.id));
  const currentContainers = new Set(current.containers.map((container) => container.id));
  for (const container of current.containers) {
    if (!baselineContainers.has(container.id)) changes.push(`new container ${container.name} (${container.id.slice(0, 12)})`);
  }
  for (const container of baseline.containers) {
    if (!currentContainers.has(container.id)) changes.push(`container ${container.name} of the baseline is gone`);
  }
  const baselineVolumes = new Set(baseline.volumes);
  const currentVolumes = new Set(current.volumes);
  for (const volume of current.volumes) if (!baselineVolumes.has(volume)) changes.push(`new volume ${volume}`);
  for (const volume of baseline.volumes) if (!currentVolumes.has(volume)) changes.push(`volume ${volume} of the baseline is gone`);
  const baselineImages = new Set(baseline.images.map((image) => image.id));
  const currentImages = new Set(current.images.map((image) => image.id));
  for (const image of current.images) {
    if (baselineImages.has(image.id)) continue;
    if (image.tags.length > 0 && image.tags.every((tag) => allowed.has(familiarName(tag)))) continue;
    changes.push(`new image ${image.id.slice(7, 19)} ${image.tags.length > 0 ? image.tags.join(', ') : '(dangling)'}`);
  }
  const currentTags = new Map<string, string>();
  for (const image of current.images) for (const tag of image.tags) currentTags.set(familiarName(tag), image.id);
  for (const image of baseline.images) {
    if (!currentImages.has(image.id)) {
      changes.push(`image ${image.id.slice(7, 19)} ${image.tags.join(', ')} of the baseline is gone`);
      continue;
    }
    for (const tag of image.tags) {
      const id = currentTags.get(familiarName(tag));
      if (id === undefined) changes.push(`tag ${tag} of the baseline image ${image.id.slice(7, 19)} is gone`);
      else if (id !== image.id && !allowed.has(familiarName(tag))) changes.push(`tag ${tag} of the baseline moved to ${id.slice(7, 19)}`);
    }
  }
  return changes;
}

/**
 * Removes the objects of a test run: the containers with the label devenv-test.run=<runId> and the containers that use a
 * volume of the run (helper runs), then the images and the volumes with the label. Images are removed with force: they
 * are images of the run only. Returns a description of each removed object.
 */
export function removeRunObjects(docker: DockerCli, runId: string): string[] {
  const filter = `label=${TEST_RUN_LABEL}=${runId}`;
  const removed: string[] = [];
  const volumes = docker.lines(['volume', 'ls', '-q', '--filter', filter]);
  const containers = new Set(docker.lines(['ps', '-a', '-q', '--no-trunc', '--filter', filter]));
  for (const volume of volumes) {
    for (const id of docker.lines(['ps', '-a', '-q', '--no-trunc', '--filter', `volume=${volume}`])) containers.add(id);
  }
  for (const id of containers) {
    docker.ok(['rm', '-f', id]);
    removed.push(`container ${id.slice(0, 12)}`);
  }
  for (const id of new Set(docker.lines(['image', 'ls', '-a', '-q', '--no-trunc', '--filter', filter]))) {
    // An image that a removal before this one took with it (a parent) is gone already.
    const result = docker.run(['image', 'rm', '-f', id]);
    if (result.code !== 0 && !/no such image/i.test(result.err)) throw new Error(`docker image rm -f ${id} failed: ${result.err}`);
    removed.push(`image ${id.slice(7, 19)}`);
  }
  for (const volume of volumes) {
    docker.ok(['volume', 'rm', volume]);
    removed.push(`volume ${volume}`);
  }
  return removed;
}

export function baselinePath(run: DockerTestRun): string {
  return path.join(run.runDir, 'baseline.json');
}

export function readBaseline(run: DockerTestRun): DockerSnapshot {
  return JSON.parse(fs.readFileSync(baselinePath(run), 'utf8')) as DockerSnapshot;
}

/** Marker file: a test failed, so the teardown keeps the run folder with the logs. */
export function failureMarker(run: DockerTestRun): string {
  return path.join(run.runDir, 'failed');
}
