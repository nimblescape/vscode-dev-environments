// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devcontainerCliVersion } from '../../../scripts/cliVersion.mjs';
import type { ImageInfo } from '../docker/containerAdapter';
import { CommandError } from '../errors';
import type { HttpTransport } from '../http';
import { IMAGE_CHECK_TIMEOUT_MS } from '../imageCheck/imageCheck';
import { RegistryClient, type DigestResult } from '../imageCheck/registryClient';
import type { ImageReference } from '../imageCheck/reference';
import { abortError, type Logger } from '../ports';
import {
  DEVCONTAINER_CLI_VERSION,
  HELPER_CHECK_INTERVAL_MS,
  HELPER_CLEANUP_INTERVAL_MS,
  HELPER_GENERATION,
  HELPER_LAST_USED_INTERVAL_MS,
  HELPER_RETRY_INTERVAL_MS,
  HELPER_TOMBSTONE_MS,
  HELPER_UNUSED_LIMIT_MS,
  ensureHelperImage,
  ensureHelperImageUse,
  helperImageTag,
  recordHelperImageUse,
  registryBaseDigest,
  type BaseDigestLookup,
  type EnsureHelperImageOptions,
  type HelperImageDocker,
} from './helperImage';
import type { HelperImageRecord, HelperState } from './helperState';

const ROOT = path.resolve(__dirname, '../../..');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dockerfile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'Dockerfile');
  fs.writeFileSync(file, content);
  return file;
}

type BuildOptions = Parameters<HelperImageDocker['buildImage']>[0];

interface FakeImage {
  id: string;
  tags: string[];
  /** Carries the label nimblescape.devenv.helper=true. */
  helper: boolean;
}

/** Local images by ID, with the tag and removal rules of Docker. */
class FakeDocker implements HelperImageDocker {
  readonly images = new Map<string, FakeImage>();
  readonly builds: BuildOptions[] = [];
  /** References passed to removeImage, in order. */
  readonly removals: string[] = [];
  readonly labelQueries: string[] = [];
  /** References that Docker refuses to remove, because a container uses the image. */
  readonly inUse = new Set<string>();
  /** References whose removal fails with another error. */
  readonly failingRemovals = new Set<string>();
  buildHandler: (options: BuildOptions) => Promise<void> = async () => undefined;
  listError: Error | undefined;
  imageIdError: Error | undefined;
  /**
   * Review round 3 of PR #64 (P4): the build returns the ID of its image, as ContainerAdapter.buildImage finds it by its
   * build label (review round 4 of PR #64, R4-2/R4-3); with this flag it returns none (a lookup that failed).
   */
  builtIdMissing = false;
  /** Review round 3 of PR #64 (P4): runs after a successful build (after the tag moved), before buildImage returns. */
  afterBuild: () => void = () => undefined;
  private counter = 0;

  /** Adds an image with these tags (moving them from other images, as a build does) and returns its ID. */
  addImage(tags: string[], options: { helper?: boolean } = {}): string {
    const id = `sha256:${(++this.counter).toString(16).padStart(64, '0')}`;
    for (const image of this.images.values()) image.tags = image.tags.filter((tag) => !tags.includes(tag));
    this.images.set(id, { id, tags: [...tags], helper: options.helper ?? true });
    return id;
  }

  idOf(reference: string): string | undefined {
    if (this.images.has(reference)) return reference;
    for (const image of this.images.values()) if (image.tags.includes(reference)) return image.id;
    return undefined;
  }

  async imageExists(reference: string): Promise<boolean> {
    return this.idOf(reference) !== undefined;
  }

  async imageId(reference: string): Promise<string | undefined> {
    if (this.imageIdError) throw this.imageIdError;
    return this.idOf(reference);
  }

  async buildImage(options: BuildOptions): Promise<string | undefined> {
    this.builds.push(options);
    // Docker moves the tag only after a successful build.
    await this.buildHandler(options);
    const id = this.addImage([options.tag], { helper: options.labels?.['nimblescape.devenv.helper'] === 'true' });
    this.afterBuild();
    return this.builtIdMissing ? undefined : id;
  }

  async listImagesByLabel(label: string): Promise<ImageInfo[]> {
    this.labelQueries.push(label);
    if (this.listError) throw this.listError;
    return [...this.images.values()]
      .filter((image) => label === 'nimblescape.devenv.helper=true' && image.helper)
      .map((image) => ({ id: image.id, tags: [...image.tags], createdAt: '2026-09-01 10:00:00 +0200 CEST' }));
  }

  /** Like `docker image rm` without force: a tag is untagged (the image goes with its last tag). */
  async removeImage(reference: string): Promise<boolean> {
    this.removals.push(reference);
    const id = this.idOf(reference);
    if (id === undefined) return false;
    if (this.failingRemovals.has(reference)) throw new CommandError(`docker image rm ${reference}`, 1, '', 'Cannot connect to the Docker daemon');
    const image = this.images.get(id)!;
    // Review round 1 of PR #101 (A-M1): like Docker, an image in use refuses only the removal of its last reference (its
    // ID, or its only tag); another tag is untagged.
    if ((this.inUse.has(reference) || this.inUse.has(id)) && (reference === id || image.tags.length <= 1)) return false;
    if (reference === id) {
      if (image.tags.length > 1) throw new CommandError(`docker image rm ${id}`, 1, '', 'conflict: unable to delete (must be forced)');
      this.images.delete(id);
    } else {
      image.tags = image.tags.filter((tag) => tag !== reference);
      if (image.tags.length === 0) this.images.delete(id);
    }
    return true;
  }
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(text: string): void {
    this.lines.push(`output ${text}`);
  }
}

describe('DEVCONTAINER_CLI_VERSION', () => {
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('is the exact devDependency of package.json and the version of the installed CLI package', () => {
    expect(DEVCONTAINER_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DEVCONTAINER_CLI_VERSION).toBe(readJson(path.join(ROOT, 'package.json')).devDependencies['@devcontainers/cli']);
    // The contract tests (devcontainerCli.contract.test.ts) check this package, so it must be the same version.
    expect(DEVCONTAINER_CLI_VERSION).toBe(readJson(path.join(ROOT, 'node_modules/@devcontainers/cli/package.json')).version);
    expect(devcontainerCliVersion()).toBe(DEVCONTAINER_CLI_VERSION);
  });

  it('must be pinned: devcontainerCliVersion refuses a missing entry and a range', () => {
    const manifest = (devDependencies?: Record<string, string>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
      tempDirs.push(dir);
      const file = path.join(dir, 'package.json');
      fs.writeFileSync(file, JSON.stringify({ name: 'x', devDependencies }));
      return file;
    };
    expect(devcontainerCliVersion(manifest({ '@devcontainers/cli': '0.90.1' }))).toBe('0.90.1');
    expect(() => devcontainerCliVersion(manifest())).toThrow(/"@devcontainers\/cli" with an exact version x\.y\.z.*it is missing/);
    expect(() => devcontainerCliVersion(manifest({ typescript: '5.9.3' }))).toThrow(/it is missing/);
    for (const range of ['^0.89.0', '~0.89.0', '0.89', 'latest', '>=0.89.0', '0.89.0-beta.1', '01.2.3']) {
      expect(() => devcontainerCliVersion(manifest({ '@devcontainers/cli': range }))).toThrow(`found "${range}"`);
    }
  });
});

describe('helperImageTag', () => {
  it('is devenv-helper:<12 hex characters>', () => {
    expect(helperImageTag('FROM x\n')).toMatch(/^devenv-helper:[0-9a-f]{12}$/);
  });

  it('depends on the Dockerfile and the CLI version, not on line endings', () => {
    const tag = helperImageTag('FROM x\nRUN y\n', '0.89.0');
    expect(helperImageTag('FROM x\nRUN y\n', '0.89.0')).toBe(tag);
    expect(helperImageTag('FROM x\r\nRUN y\r\n', '0.89.0')).toBe(tag);
    expect(helperImageTag('FROM x\nRUN z\n', '0.89.0')).not.toBe(tag);
    expect(helperImageTag('FROM x\nRUN y\n', '0.90.0')).not.toBe(tag);
    expect(helperImageTag('FROM x\nRUN y\n')).toBe(helperImageTag('FROM x\nRUN y\n', DEVCONTAINER_CLI_VERSION));
  });

  it('matches the hash of the file content plus the version plus the helper generation', () => {
    // Changed expectation (review round 3 of PR #64, P5): the helper generation is part of the hash.
    // sha256('abc' + '1' + '\ngeneration 1')
    expect(helperImageTag('abc', '1', 1)).toBe('devenv-helper:cdcde07033de');
    expect(helperImageTag('abc', '1')).toBe(helperImageTag('abc', '1', HELPER_GENERATION));
  });

  it('changes with the helper generation, so raising it builds a new current tag (review round 3 of PR #64, P5)', () => {
    expect(helperImageTag('FROM x\n', '0.89.0', 2)).not.toBe(helperImageTag('FROM x\n', '0.89.0', 1));
    expect(helperImageTag('FROM x\n', '0.89.0', HELPER_GENERATION + 1)).not.toBe(helperImageTag('FROM x\n', '0.89.0'));
  });
});

describe('ensureHelperImage', () => {
  it('builds the image when the tag is missing', async () => {
    const file = dockerfile('FROM node:22-bookworm-slim\n');
    const docker = new FakeDocker();
    const output: string[] = [];
    const tag = await ensureHelperImage(docker, file, { onOutput: (text) => output.push(text) });
    expect(tag).toBe(helperImageTag('FROM node:22-bookworm-slim\n'));
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({
      tag,
      dockerfile: file,
      context: path.dirname(file),
      labels: { 'nimblescape.devenv.helper': 'true' },
      buildArgs: { DEVCONTAINER_CLI_VERSION },
    });
    expect(docker.builds[0].onOutput).toBeTypeOf('function');
    // Without a state file, the build is the one of before: no --pull, no --no-cache.
    expect(docker.builds[0].pull).toBeUndefined();
    expect(docker.builds[0].noCache).toBeUndefined();
  });

  it('does not build when the tag exists', async () => {
    const file = dockerfile('FROM x\n');
    const docker = new FakeDocker();
    docker.addImage([helperImageTag('FROM x\n')]);
    await ensureHelperImage(docker, file);
    expect(docker.builds).toHaveLength(0);
  });

  it('builds the real Dockerfile of the extension with a stable tag', async () => {
    const file = path.resolve(__dirname, '../../../resources/helper/Dockerfile');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toMatch(/^ARG BASE_IMAGE=node:24-trixie-slim$/m);
    expect(content).toMatch(/^FROM \$\{BASE_IMAGE\}$/m);
    expect(content).toMatch(/^ARG DEVCONTAINER_CLI_VERSION$/m);
    expect(content).toMatch(/^LABEL nimblescape\.devenv\.helper=true$/m);
    // The Docker CLI with the buildx and the Compose plugins from download.docker.com (Compose configurations, spec u6).
    expect(content).toMatch(/apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin;/);
    expect(content).toMatch(/^\s*docker compose version; \\$/m);
    // Classic builder compatibility: no syntax directive, no heredoc, no RUN --mount.
    expect(content).not.toMatch(/^#\s*syntax=/m);
    expect(content).not.toMatch(/^[^#]*<</m);
    expect(content).not.toMatch(/^\s*RUN\s+--mount/m);
    const docker = new FakeDocker();
    expect(await ensureHelperImage(docker, file)).toBe(helperImageTag(content));
  });
});

const BASE = 'node:24-trixie-slim';
const HELPER_DOCKERFILE = `ARG BASE_IMAGE=${BASE}\nFROM \${BASE_IMAGE}\nLABEL nimblescape.devenv.helper=true\n`;
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const START = Date.parse('2026-09-24T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OLD_TAG = 'devenv-helper:0123456789ab';
const OTHER_TAG = 'devenv-helper:abcdef012345';
/** Plan step 11D3: a time relative to START, as Harness.iso gives it before a harness exists. */
const h0iso = (offsetMs: number): string => new Date(START + offsetMs).toISOString();

type LookupAnswer = string | 'unreachable' | undefined;

/** ensureHelperImage with a state file, a fake Docker, a fake clock, and a fake digest lookup. */
class Harness {
  readonly docker = new FakeDocker();
  readonly logger = new RecordingLogger();
  readonly file = dockerfile(HELPER_DOCKERFILE);
  readonly statePath = path.join(path.dirname(this.file), 'storage', 'helper.json');
  readonly tag = helperImageTag(HELPER_DOCKERFILE);
  readonly lookups: Array<{ reference: string; signal?: AbortSignal }> = [];
  /** Checks of the base image that ensure started in the background, not awaited yet. */
  readonly checks: Array<Promise<void>> = [];
  now = START;
  answer: (signal?: AbortSignal) => Promise<LookupAnswer> = async () => DIGEST_A;
  readonly clock = { now: () => this.now };
  readonly baseDigest: BaseDigestLookup = (reference, signal) => {
    this.lookups.push({ reference, signal });
    return this.answer(signal);
  };

  ensure(options: Partial<EnsureHelperImageOptions> = {}): Promise<string> {
    return ensureHelperImage(this.docker, this.file, {
      statePath: this.statePath,
      baseDigest: this.baseDigest,
      clock: this.clock,
      logger: this.logger,
      onBaseImageCheck: (check) => this.checks.push(check),
      ...options,
    });
  }

  /** Waits for the checks of the base image that ensure started in the background. */
  async settled(): Promise<void> {
    await Promise.all(this.checks.splice(0));
  }

  advance(ms: number): void {
    this.now += ms;
  }

  /** ISO time `offsetMs` from now. */
  iso(offsetMs = 0): string {
    return new Date(this.now + offsetMs).toISOString();
  }

  state(): HelperState {
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as HelperState;
  }

  writeState(state: HelperState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state));
  }

  warnings(): string[] {
    return this.logger.lines.filter((line) => line.startsWith('warn'));
  }
}

describe('ensureHelperImage with a state file: new helper image', () => {
  it('builds a missing tag with --pull and records the digest of the base image read before the build', async () => {
    const h = new Harness();
    expect(await h.ensure()).toBe(h.tag);
    expect(h.lookups.map((lookup) => lookup.reference)).toEqual([BASE]);
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.builds[0]).toMatchObject({ tag: h.tag, pull: true, labels: { 'nimblescape.devenv.helper': 'true' } });
    expect(h.docker.builds[0].noCache).toBeUndefined();
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the build records the helper generation.
    expect(h.state()).toEqual({
      version: 1,
      images: {
        [h.tag]: {
          baseImage: BASE,
          baseDigest: DIGEST_A,
          builtAt: h.iso(),
          checkedAt: h.iso(),
          lastUsedAt: h.iso(),
          imageId: h.docker.idOf(h.tag),
          generation: HELPER_GENERATION,
        },
      },
      lastCleanupAt: h.iso(),
    });
  });

  it('builds without --pull when the registry does not answer, and builds again from the current base image after the next check', async () => {
    const h = new Harness();
    h.answer = async () => 'unreachable';
    await h.ensure();
    expect(h.docker.builds[0].pull).toBe(false);
    // No digest and no checkedAt, but the mark: the image may come from an old local base image.
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the build records the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      builtAt: h.iso(),
      builtWithoutPull: h.iso(),
      attemptedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
    const firstId = h.docker.idOf(h.tag);

    // The registry answers again: the check is tried again after a day.
    h.answer = async () => DIGEST_A;
    h.advance(HOUR);
    await h.ensure();
    expect(h.lookups).toHaveLength(1);
    h.advance(HELPER_RETRY_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(2);
    // The digest is not taken over as the digest of the image: the next ensure builds it again.
    expect(h.docker.builds).toHaveLength(1);
    expect(h.state().images[h.tag]).toMatchObject({ latestBaseDigest: DIGEST_A, checkedAt: h.iso(), builtWithoutPull: h.iso(-DAY - HOUR) });
    expect(h.state().images[h.tag].baseDigest).toBeUndefined();

    h.advance(HOUR);
    await h.ensure();
    expect(h.docker.builds).toHaveLength(2);
    expect(h.docker.builds[1]).toMatchObject({ pull: true, noCache: true });
    expect(h.docker.idOf(h.tag)).not.toBe(firstId);
    expect(h.logger.lines.join('\n')).toContain('was built from the local base image. It is built again from the current base image');
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the build and the rebuild record the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
    await h.ensure();
    await h.settled();
    expect(h.docker.builds).toHaveLength(2);
    expect(h.lookups).toHaveLength(2);
  });

  it('keeps the mark of a build without --pull when the rebuild fails, and tries again after the next weekly check', async () => {
    const h = new Harness();
    h.answer = async () => 'unreachable';
    await h.ensure();
    const firstId = h.docker.idOf(h.tag);
    h.answer = async () => DIGEST_A;
    h.advance(DAY);
    await h.ensure();
    await h.settled();
    h.docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'toomanyrequests: You have reached your pull rate limit');
    };
    h.advance(HOUR);
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds.map((build) => [build.pull, build.noCache])).toEqual([
      [false, undefined],
      [true, true],
    ]);
    expect(h.docker.idOf(h.tag)).toBe(firstId);
    const record = h.state().images[h.tag];
    expect(record).toMatchObject({ builtWithoutPull: h.iso(-DAY - HOUR), checkedAt: h.iso() });
    expect(record.latestBaseDigest).toBeUndefined();
    expect(record.baseDigest).toBeUndefined();

    // No new attempt at each open; the next weekly check asks for the rebuild again.
    h.docker.buildHandler = async () => undefined;
    h.advance(HOUR);
    await h.ensure();
    expect(h.docker.builds).toHaveLength(2);
    h.advance(HELPER_CHECK_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    await h.ensure();
    expect(h.docker.builds).toHaveLength(3);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A });
    expect(h.state().images[h.tag].builtWithoutPull).toBeUndefined();
  });

  it('builds with --pull without a digest lookup', async () => {
    const h = new Harness();
    await h.ensure({ baseDigest: undefined });
    expect(h.docker.builds[0]).toMatchObject({ pull: true });
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the build records the helper generation.
    expect(h.state().images[h.tag]).toEqual({ baseImage: BASE, builtAt: h.iso(), lastUsedAt: h.iso(), imageId: h.docker.idOf(h.tag), generation: HELPER_GENERATION });
  });

  it('replaces the record of a tag whose image was removed', async () => {
    const h = new Harness();
    h.writeState({
      version: 1,
      images: { [h.tag]: { baseImage: BASE, baseDigest: DIGEST_B, builtAt: h.iso(-30 * DAY), checkedAt: h.iso(-DAY) } },
    });
    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the build and the rebuild record the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
  });

  it('throws when a missing tag cannot be built, also not without --pull, and records nothing', async () => {
    const h = new Harness();
    h.docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'network error');
    };
    await expect(h.ensure()).rejects.toBeInstanceOf(CommandError);
    expect(h.docker.builds.map((build) => build.pull)).toEqual([true, false]);
    expect(fs.existsSync(h.statePath)).toBe(false);
  });

  it('builds a missing tag from the local base image when the build with --pull fails', async () => {
    // The request of the extension host got a digest, but the pull of the daemon fails (for example the pull limit).
    const h = new Harness();
    h.docker.buildHandler = async (options) => {
      if (options.pull) throw new CommandError('docker build', 1, '', 'toomanyrequests: You have reached your pull rate limit');
    };
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds.map((build) => build.pull)).toEqual([true, false]);
    expect(h.docker.idOf(h.tag)).toBeDefined();
    expect(h.warnings().join('\n')).toMatch(/could not be built with a fresh base image\. It is built from the local base image: .*toomanyrequests/);
    // The digest of the registry is not the digest of the image, so it is not recorded; the mark asks for a rebuild.
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the build records the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      builtAt: h.iso(),
      builtWithoutPull: h.iso(),
      attemptedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });

    // The next check (a day later) asks for a build with a fresh base image, and the next ensure runs it.
    h.docker.buildHandler = async () => undefined;
    h.advance(HELPER_RETRY_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    await h.ensure();
    expect(h.docker.builds).toHaveLength(3);
    expect(h.docker.builds[2]).toMatchObject({ pull: true, noCache: true });
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the build and the rebuild record the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
  });

  it('does not build again without --pull after an abort, or after a build that already ran without --pull', async () => {
    const h = new Harness();
    h.docker.buildHandler = async () => {
      throw abortError();
    };
    await expect(h.ensure()).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.docker.builds).toHaveLength(1);

    const offline = new Harness();
    offline.answer = async () => 'unreachable';
    offline.docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'pull access denied');
    };
    await expect(offline.ensure()).rejects.toBeInstanceOf(CommandError);
    expect(offline.docker.builds.map((build) => build.pull)).toEqual([false]);
    expect(fs.existsSync(offline.statePath)).toBe(false);
  });

  it('rejects with an AbortError when the signal aborts during the lookup before the build of a missing tag', async () => {
    const h = new Harness();
    const controller = new AbortController();
    // review, CI race: the abort comes from inside the lookup (it has started for sure), not from a 5 ms timer that could
    // fire before the lookup starts (the per-engine step before it takes a variable time).
    h.answer = () => {
      setTimeout(() => controller.abort(), 0);
      return new Promise<LookupAnswer>(() => {});
    };
    await expect(h.ensure({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.lookups[0].signal?.aborted).toBe(true);
    expect(h.docker.builds).toHaveLength(0);
    expect(fs.existsSync(h.statePath)).toBe(false);
  });

  it('rejects with an AbortError without a lookup and without a build when the signal aborted before the lookup', async () => {
    // review, CI race: the case that the old timer could hit.
    const h = new Harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.ensure({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.lookups).toHaveLength(0);
    expect(h.docker.builds).toHaveLength(0);
    expect(fs.existsSync(h.statePath)).toBe(false);
  });

  it('builds a missing tag with --pull and without a lookup when the check of the base image is off', async () => {
    const h = new Harness();
    await h.ensure({ checkBaseImage: false });
    await h.settled();
    expect(h.lookups).toHaveLength(0);
    expect(h.docker.builds[0]).toMatchObject({ pull: true });
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the build records the helper generation.
    expect(h.state().images[h.tag]).toEqual({ baseImage: BASE, builtAt: h.iso(), lastUsedAt: h.iso(), imageId: h.docker.idOf(h.tag), generation: HELPER_GENERATION });
  });

  it('checks the base image of the real Dockerfile of the extension', async () => {
    const h = new Harness();
    const file = path.resolve(__dirname, '../../../resources/helper/Dockerfile');
    const docker = new FakeDocker();
    await ensureHelperImage(docker, file, { statePath: h.statePath, baseDigest: h.baseDigest, clock: h.clock });
    expect(h.lookups.map((lookup) => lookup.reference)).toEqual(['node:24-trixie-slim']);
  });
});

describe('ensureHelperImage with a state file: weekly check of the base image', () => {
  /** An existing helper image whose base image digest was recorded `checkedAgoMs` ago. */
  function existing(checkedAgoMs: number): { h: Harness; oldId: string } {
    const h = new Harness();
    const oldId = h.docker.addImage([h.tag]);
    h.writeState({
      version: 1,
      images: {
        [h.tag]: {
          baseImage: BASE,
          baseDigest: DIGEST_A,
          builtAt: h.iso(-30 * DAY),
          checkedAt: h.iso(-checkedAgoMs),
          lastUsedAt: h.iso(-2 * HOUR),
          // Review round 2 of PR #64 (A-N3): the ID that the build of this installation recorded. Before, the ensure
          // filled it in for a record without one; it no longer does.
          imageId: oldId,
        },
      },
      // The cleanup ran today: these tests see the refresh alone.
      lastCleanupAt: h.iso(),
    });
    return { h, oldId };
  }

  /** An existing helper image whose check (8 days ago) is due, and whose base image changed to DIGEST_B. */
  async function changed(): Promise<{ h: Harness; oldId: string }> {
    const result = existing(8 * DAY);
    result.h.answer = async () => DIGEST_B;
    await result.h.ensure();
    await result.h.settled();
    return result;
  }

  it('does not check within 7 days', async () => {
    const { h } = existing(HELPER_CHECK_INTERVAL_MS - HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(0);
    expect(h.docker.builds).toHaveLength(0);
  });

  it('only updates checkedAt when the digest is unchanged', async () => {
    const { h, oldId } = existing(HELPER_CHECK_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    expect(h.lookups.map((lookup) => lookup.reference)).toEqual([BASE]);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.docker.idOf(h.tag)).toBe(oldId);
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 2 of PR #64,
    // A-N3; comment corrected in review round 25, A-R25-1): the record keeps the ID of the image of the earlier build of this
    // installation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(-30 * DAY),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
    });

    h.advance(HELPER_CHECK_INTERVAL_MS - HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(1);
  });

  it('records the digest of a helper image built before the state existed, without a rebuild', async () => {
    const h = new Harness();
    const id = h.docker.addImage([h.tag]);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(1);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.docker.idOf(h.tag)).toBe(id);
    expect(h.state().images[h.tag]).toEqual({ baseImage: BASE, baseDigest: DIGEST_A, checkedAt: h.iso(), lastUsedAt: h.iso() });
  });

  it('does not wait for the check: a registry that does not answer never delays the ensure', async () => {
    const { h } = existing(8 * DAY);
    h.answer = () => new Promise<LookupAnswer>(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(await h.ensure()).toBe(h.tag);
      // The ensure returned while the lookup still runs: it waited neither for the registry nor for the time limit.
      expect(h.lookups).toHaveLength(1);
      expect(h.lookups[0].signal?.aborted).toBe(false);
      expect(h.checks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(IMAGE_CHECK_TIMEOUT_MS);
      await h.settled();
    } finally {
      vi.useRealTimers();
    }
    // The time limit of the check ended the lookup.
    expect(h.lookups[0].signal?.aborted).toBe(true);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ checkedAt: h.iso(-8 * DAY), attemptedAt: h.iso() });
  });

  it('asks the next ensure to rebuild the same tag with --pull --no-cache when the base image changed, and removes the previous image', async () => {
    const { h, oldId } = await changed();
    // The check itself builds nothing: the ensure that started it did not wait for it.
    expect(h.docker.builds).toHaveLength(0);
    expect(h.logger.lines.join('\n')).toContain(`has changed. The image ${h.tag} is built again at the next open.`);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B, checkedAt: h.iso() });

    const output: string[] = [];
    const builds: string[] = [];
    h.docker.buildHandler = async (options) => options.onOutput?.('#1 building\n');
    expect(await h.ensure({ onOutput: (text) => output.push(text), onBuild: (kind) => builds.push(kind) })).toBe(h.tag);

    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.builds[0]).toMatchObject({ tag: h.tag, pull: true, noCache: true, labels: { 'nimblescape.devenv.helper': 'true' } });
    // The build output reaches onOutput, and onBuild tells that an existing helper is updated.
    expect(output).toEqual(['#1 building\n']);
    expect(builds).toEqual(['refresh']);
    const newId = h.docker.idOf(h.tag);
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    expect(h.docker.removals).toEqual([oldId]);
    expect(h.docker.images.has(oldId)).toBe(false);
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    // Changed expectation (review round 2 of PR #64, A-N2): the rebuild records the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_B,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
    await h.settled();
    expect(h.lookups).toHaveLength(1);
  });

  it('drops the recorded image ID when the ID of the rebuilt image cannot be read (review round 1 of PR #64, L3)', async () => {
    const { h, oldId } = await changed();
    expect(h.state().images[h.tag]?.imageId).toBe(oldId);
    // The build succeeds, but Docker does not answer for the ID of the new image. Review round 3 of PR #64 (P4): the ID
    // comes from the build now (its build label); it is unavailable here too.
    h.docker.builtIdMissing = true;
    h.docker.buildHandler = async () => {
      h.docker.imageIdError = new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
    };
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(1);
    // The old ID is not the image of the tag any more: no ID is better than a wrong one.
    // Changed expectation (review round 2 of PR #64, A-N2): the rebuild records the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_B,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      generation: HELPER_GENERATION,
    });
  });

  it('records the ID of the rebuilt image from the build, not the image that the tag has afterwards (review round 3 of PR #64, P4)', async () => {
    const { h } = await changed();
    let builtId: string | undefined;
    let otherId: string | undefined;
    h.docker.afterBuild = () => {
      h.docker.afterBuild = () => undefined;
      builtId = h.docker.idOf(h.tag);
      // Another installation on the same engine builds the tag right after this build.
      otherId = h.docker.addImage([h.tag]);
    };
    const use = await ensureHelperImageUse(h.docker, h.file, { statePath: h.statePath, baseDigest: h.baseDigest, clock: h.clock, logger: h.logger });
    expect(builtId).toBeDefined();
    expect(otherId).not.toBe(builtId);
    expect(h.state().images[h.tag]?.imageId).toBe(builtId);
    expect(use).toEqual({ tag: h.tag, id: builtId });
  });

  it('records no image ID read back by the tag when the build gave none (review round 3 of PR #64, P4)', async () => {
    const { h } = await changed();
    h.docker.builtIdMissing = true;
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(1);
    // The tag has an image, but it may be one of another build: it is no image ID of this installation.
    expect(h.docker.idOf(h.tag)).toBeDefined();
    expect(h.state().images[h.tag]?.imageId).toBeUndefined();
    const fresh = new Harness();
    fresh.docker.builtIdMissing = true;
    const use = await ensureHelperImageUse(fresh.docker, fresh.file, { statePath: fresh.statePath, clock: fresh.clock, logger: fresh.logger });
    expect(fresh.state().images[fresh.tag]?.imageId).toBeUndefined();
    // The open still runs the image of the tag by its ID.
    expect(use).toEqual({ tag: fresh.tag, id: fresh.docker.idOf(fresh.tag) });
  });

  it('runs the rebuilt image by the ID of its tag and removes the previous image when the rebuild gave no ID (review round 17 of PR #64, R17-1)', async () => {
    const { h, oldId } = await changed();
    h.docker.builtIdMissing = true;
    const use = await ensureHelperImageUse(h.docker, h.file, { statePath: h.statePath, baseDigest: h.baseDigest, clock: h.clock, logger: h.logger });
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.builds[0]).toMatchObject({ pull: true, noCache: true });
    // The open runs the image by its ID, so a rebuild by another window cannot change it mid-open.
    expect(use).toEqual({ tag: h.tag, id: h.docker.idOf(h.tag) });
    expect(use.id).not.toBe(oldId);
    // The ID read back by the tag is not recorded, but the previous image without a tag is removed.
    expect(h.state().images[h.tag]?.imageId).toBeUndefined();
    expect(h.docker.removals).toEqual([oldId]);
    expect(h.docker.images.has(oldId)).toBe(false);
  });

  it('keeps the previous image when it still has another tag', async () => {
    const { h, oldId } = await changed();
    h.docker.images.get(oldId)!.tags.push('mine:backup');
    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.removals).toEqual([]);
    expect(h.docker.images.get(oldId)?.tags).toEqual(['mine:backup']);
  });

  it('plan step 11D3: a rebuild removes the previous image whose only tag left is its monitor tag', async () => {
    const { h, oldId } = existing(8 * DAY);
    const monitorTag = h.tag.replace('devenv-helper:', 'devenv-monitor:');
    h.docker.images.get(oldId)!.tags.push(monitorTag);
    h.answer = async () => DIGEST_B;
    await h.ensure();
    await h.settled();
    // The check asks the next ensure to rebuild.
    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.removals).toEqual([monitorTag]);
    expect(h.docker.images.has(oldId)).toBe(false);
  });

  it('plan step 11D3: keeps a previous image with its monitor tag while the monitor runs, and removes it at a later cleanup', async () => {
    const { h, oldId } = existing(8 * DAY);
    const monitorTag = h.tag.replace('devenv-helper:', 'devenv-monitor:');
    h.docker.images.get(oldId)!.tags.push(monitorTag);
    h.docker.inUse.add(oldId);
    h.answer = async () => DIGEST_B;
    await h.ensure();
    await h.settled();
    // The check asks the next ensure to rebuild.
    await h.ensure();
    expect(h.docker.removals).toEqual([monitorTag]);
    expect(h.docker.images.get(oldId)?.tags).toEqual([monitorTag]);
    h.docker.inUse.clear();
    h.advance(HELPER_CLEANUP_INTERVAL_MS);
    await h.ensure();
    expect(h.docker.images.has(oldId)).toBe(false);
    // Never a tag of the current image.
    expect(h.docker.images.get(h.docker.idOf(h.tag)!)?.tags).toEqual([h.tag]);
  });

  it('plan step 11D3: a previous image with a monitor tag and another tag keeps both', async () => {
    const { h, oldId } = existing(8 * DAY);
    h.docker.images.get(oldId)!.tags.push('devenv-monitor:fedcba987654', 'mine:backup');
    h.answer = async () => DIGEST_B;
    await h.ensure();
    await h.settled();
    // The check asks the next ensure to rebuild.
    await h.ensure();
    expect(h.docker.removals).toEqual([]);
    expect(h.docker.images.get(oldId)?.tags).toEqual(['devenv-monitor:fedcba987654', 'mine:backup']);
  });

  it('keeps a previous image that a running helper uses, and removes it at the next cleanup', async () => {
    const { h, oldId } = await changed();
    h.docker.inUse.add(oldId);
    await h.ensure();
    expect(h.docker.removals).toEqual([oldId]);
    expect(h.docker.images.get(oldId)?.tags).toEqual([]);

    h.docker.inUse.clear();
    h.advance(HELPER_CLEANUP_INTERVAL_MS);
    await h.ensure();
    expect(h.docker.images.has(oldId)).toBe(false);
    expect(h.docker.idOf(h.tag)).toBeDefined();
  });

  it('keeps the existing image when the rebuild fails, and checks again in a week', async () => {
    const { h, oldId } = await changed();
    h.docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
    };
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.idOf(h.tag)).toBe(oldId);
    expect(h.docker.removals).toEqual([]);
    expect(h.warnings().join('\n')).toMatch(/could not be built again\. The existing image is used: .*Temporary failure/);
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 2 of PR #64,
    // A-N3; comment corrected in review round 25, A-R25-1): the record keeps the ID of the image of the earlier build of this
    // installation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(-30 * DAY),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
    });

    // Not at each open: the next check, a week later, asks for the rebuild again.
    h.docker.buildHandler = async () => undefined;
    h.advance(HELPER_CHECK_INTERVAL_MS - HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(1);
    expect(h.docker.builds).toHaveLength(1);
    h.advance(HOUR);
    await h.ensure();
    await h.settled();
    await h.ensure();
    expect(h.lookups).toHaveLength(2);
    expect(h.docker.builds).toHaveLength(2);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_B });
  });

  it('keeps the image and tries again after a day, not at each open, when the registry cannot be reached', async () => {
    const { h, oldId } = existing(8 * DAY);
    h.answer = async () => 'unreachable';
    expect(await h.ensure()).toBe(h.tag);
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.docker.idOf(h.tag)).toBe(oldId);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, checkedAt: h.iso(-8 * DAY), attemptedAt: h.iso() });
    expect(h.logger.lines.join('\n')).toContain('the registry did not answer. It is checked again in a day.');

    // Opens within the day do not check again.
    h.answer = async () => DIGEST_A;
    h.advance(HELPER_RETRY_INTERVAL_MS - HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(1);

    h.advance(HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(2);
    expect(h.state().images[h.tag].checkedAt).toBe(h.iso());
    expect(h.state().images[h.tag].attemptedAt).toBeUndefined();
  });

  it('counts a lookup without an answer in time as unreachable', async () => {
    const { h } = existing(8 * DAY);
    h.answer = () => new Promise<LookupAnswer>(() => {});
    expect(await h.ensure({ baseDigestTimeoutMs: 20 })).toBe(h.tag);
    await h.settled();
    expect(h.lookups[0].signal?.aborted).toBe(true);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ checkedAt: h.iso(-8 * DAY), attemptedAt: h.iso() });
  });

  it('counts a failing lookup as unreachable, also one that throws at once', async () => {
    const { h } = existing(8 * DAY);
    h.answer = async () => {
      throw new Error('socket hang up');
    };
    expect(await h.ensure()).toBe(h.tag);
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ checkedAt: h.iso(-8 * DAY), attemptedAt: h.iso() });
    expect(h.warnings().join('\n')).toContain('socket hang up');

    const throwing: BaseDigestLookup = () => {
      throw new Error('not a promise');
    };
    h.advance(HELPER_RETRY_INTERVAL_MS);
    expect(await h.ensure({ baseDigest: throwing })).toBe(h.tag);
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.warnings().join('\n')).toContain('not a promise');
  });

  it('checks again in a week when the registry returns no digest (for example a sign-in is required)', async () => {
    const { h } = existing(8 * DAY);
    h.answer = async () => undefined;
    await h.ensure();
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, checkedAt: h.iso() });
  });

  it('is not stopped by an abort of the open: the check runs in the background with its own time limit', async () => {
    const { h } = existing(8 * DAY);
    let answer: (value: LookupAnswer) => void = () => undefined;
    h.answer = () => new Promise<LookupAnswer>((resolve) => (answer = resolve));
    const controller = new AbortController();
    expect(await h.ensure({ signal: controller.signal })).toBe(h.tag);
    controller.abort();
    expect(h.lookups[0].signal).not.toBe(controller.signal);
    expect(h.lookups[0].signal?.aborted).toBe(false);
    answer(DIGEST_A);
    await h.settled();
    expect(h.state().images[h.tag].checkedAt).toBe(h.iso());
  });

  it('passes an abort during the rebuild through, and builds again at the next ensure', async () => {
    const { h, oldId } = await changed();
    const abort = new Error('The operation was cancelled.');
    abort.name = 'AbortError';
    h.docker.buildHandler = async () => {
      throw abort;
    };
    await expect(h.ensure()).rejects.toBe(abort);
    expect(h.docker.idOf(h.tag)).toBe(oldId);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B });

    h.docker.buildHandler = async () => undefined;
    await h.ensure();
    expect(h.docker.builds).toHaveLength(2);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_B });
  });

  it('neither checks nor rebuilds when the check of the base image is off, and rebuilds when it is on again', async () => {
    const { h } = existing(8 * DAY);
    await h.ensure({ checkBaseImage: false });
    await h.settled();
    expect(h.lookups).toHaveLength(0);

    // A rebuild that an earlier check asked for waits, too.
    const pending = await changed();
    await pending.h.ensure({ checkBaseImage: false });
    expect(pending.h.docker.builds).toHaveLength(0);
    await pending.h.ensure();
    expect(pending.h.docker.builds).toHaveLength(1);
  });

  it('leaves the check, the rebuild, and the cleanup to the next ensure with maintenance when `maintain` is false', async () => {
    const { h } = await changed();
    h.writeState({ ...h.state(), lastCleanupAt: h.iso(-2 * DAY) });
    h.advance(HELPER_CHECK_INTERVAL_MS);
    h.docker.addImage([]);
    await h.ensure({ maintain: false });
    await h.settled();
    expect(h.lookups).toHaveLength(1);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.docker.labelQueries).toEqual([]);
    expect(h.state().images[h.tag].lastUsedAt).toBe(h.iso());

    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.labelQueries.length).toBeGreaterThan(0);
  });

  it('builds a missing tag also when `maintain` is false', async () => {
    const h = new Harness();
    await h.ensure({ maintain: false });
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.builds[0]).toMatchObject({ pull: true });
    expect(h.docker.labelQueries).toEqual([]);
  });
});

describe('ensureHelperImage with a state file: lastUsedAt and the state file', () => {
  it('writes lastUsedAt at most once per hour', async () => {
    const h = new Harness();
    h.docker.addImage([h.tag]);
    h.writeState({
      version: 1,
      images: { [h.tag]: { baseImage: BASE, baseDigest: DIGEST_A, checkedAt: h.iso(), lastUsedAt: h.iso(-2 * HOUR) } },
      lastCleanupAt: h.iso(),
    });
    await h.ensure();
    expect(h.state().images[h.tag].lastUsedAt).toBe(h.iso());
    const written = h.iso();

    h.advance(HELPER_LAST_USED_INTERVAL_MS / 2);
    await h.ensure();
    expect(h.state().images[h.tag].lastUsedAt).toBe(written);

    h.advance(HELPER_LAST_USED_INTERVAL_MS / 2);
    await h.ensure();
    expect(h.state().images[h.tag].lastUsedAt).toBe(h.iso());
  });

  it('treats an invalid state file as empty', async () => {
    const h = new Harness();
    fs.mkdirSync(path.dirname(h.statePath), { recursive: true });
    fs.writeFileSync(h.statePath, '{ not json');
    h.docker.addImage([h.tag]);
    expect(await h.ensure()).toBe(h.tag);
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, checkedAt: h.iso() });
  });

  it('works when the state file cannot be written', async () => {
    const h = new Harness();
    const blocker = path.join(path.dirname(h.file), 'not-a-folder');
    fs.writeFileSync(blocker, '');
    const statePath = path.join(blocker, 'helper.json');
    expect(await h.ensure({ statePath })).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(1);
    expect(h.warnings().join('\n')).toContain('could not be written');
  });

  it('recordHelperImageUse writes lastUsedAt at most once per hour and never throws', async () => {
    const h = new Harness();
    await recordHelperImageUse(h.statePath, OTHER_TAG, { clock: h.clock });
    expect(h.state().images[OTHER_TAG]).toEqual({ lastUsedAt: h.iso() });
    const written = h.iso();
    h.advance(HELPER_LAST_USED_INTERVAL_MS - 1);
    await recordHelperImageUse(h.statePath, OTHER_TAG, { clock: h.clock });
    expect(h.state().images[OTHER_TAG].lastUsedAt).toBe(written);
    h.advance(1);
    await recordHelperImageUse(h.statePath, OTHER_TAG, { clock: h.clock });
    expect(h.state().images[OTHER_TAG].lastUsedAt).toBe(h.iso());

    const blocker = path.join(path.dirname(h.file), 'not-a-folder');
    fs.writeFileSync(blocker, '');
    await expect(
      recordHelperImageUse(path.join(blocker, 'helper.json'), OTHER_TAG, { clock: h.clock, logger: h.logger }),
    ).resolves.toBeUndefined();
    expect(h.warnings().join('\n')).toContain('could not be written');
  });
});

describe('ensureHelperImage with a state file: cleanup of other helper images', () => {
  /** The current helper image exists and was checked today; only the cleanup has work. */
  function current(records: Record<string, HelperState['images'][string]> = {}, lastCleanupAt?: string) {
    const h = new Harness();
    const currentId = h.docker.addImage([h.tag]);
    const state: HelperState = {
      version: 1,
      images: { [h.tag]: { baseImage: BASE, baseDigest: DIGEST_A, checkedAt: h.iso(), lastUsedAt: h.iso() }, ...records },
    };
    if (lastCleanupAt) state.lastCleanupAt = lastCleanupAt;
    h.writeState(state);
    return { h, currentId };
  }

  it('removes dangling helper images and helper tags unused for 7 days, and nothing else', async () => {
    const { h, currentId } = current();
    const oldId = h.docker.addImage([OLD_TAG]);
    const recentId = h.docker.addImage([OTHER_TAG]);
    const danglingId = h.docker.addImage([]);
    const unlabeledId = h.docker.addImage(['devenv-helper:fedcba987654'], { helper: false });
    const unlabeledDanglingId = h.docker.addImage([], { helper: false });
    // An image of another repository that inherited the label (built FROM a helper image).
    const derivedId = h.docker.addImage(['mine:1']);
    h.writeState({
      ...h.state(),
      images: {
        ...h.state().images,
        [OLD_TAG]: { lastUsedAt: h.iso(-HELPER_UNUSED_LIMIT_MS) },
        [OTHER_TAG]: { lastUsedAt: h.iso(-HELPER_UNUSED_LIMIT_MS + HOUR) },
      },
    });

    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.labelQueries).toEqual(['nimblescape.devenv.helper=true']);
    expect([...h.docker.removals].sort()).toEqual([OLD_TAG, danglingId].sort());
    expect(h.docker.images.has(oldId)).toBe(false);
    expect(h.docker.images.has(danglingId)).toBe(false);
    for (const id of [currentId, recentId, unlabeledId, unlabeledDanglingId, derivedId]) expect(h.docker.images.has(id)).toBe(true);
    const state = h.state();
    expect(Object.keys(state.images).sort()).toEqual([OLD_TAG, OTHER_TAG, h.tag].sort());
    // A tombstone: if the tag comes back, another installation uses it.
    expect(state.images[OLD_TAG]).toEqual({ removedAt: h.iso() });
    expect(state.lastCleanupAt).toBe(h.iso());

    // Tags of other repositories are never removed, however long ago they were used.
    h.advance(30 * DAY);
    await h.ensure();
    expect(h.docker.images.has(derivedId)).toBe(true);
    expect(h.docker.removals).not.toContain('mine:1');
  });

  it('never removes the image of the current tag, also when it has another expired helper tag', async () => {
    const { h, currentId } = current({ [OLD_TAG]: { lastUsedAt: '2026-01-01T00:00:00.000Z' } });
    h.docker.images.get(currentId)!.tags.push(OLD_TAG);
    await h.ensure();
    expect(h.docker.removals).toEqual([]);
    expect(h.docker.images.get(currentId)?.tags).toEqual([h.tag, OLD_TAG]);
  });

  it('plan step 11D3: removes the monitor tag with its helper tag, and a monitor tag without its helper tag; keeps the others', async () => {
    const { h, currentId } = current({ [OLD_TAG]: { lastUsedAt: h0iso(-HELPER_UNUSED_LIMIT_MS) }, [OTHER_TAG]: { lastUsedAt: h0iso(-HOUR) } });
    const oldMonitor = OLD_TAG.replace('devenv-helper:', 'devenv-monitor:');
    const otherMonitor = OTHER_TAG.replace('devenv-helper:', 'devenv-monitor:');
    const oldId = h.docker.addImage([OLD_TAG, oldMonitor]);
    const otherId = h.docker.addImage([OTHER_TAG, otherMonitor]);
    const orphanId = h.docker.addImage(['devenv-monitor:fedcba987654', 'mine:keep']);
    h.docker.images.get(currentId)!.tags.push(h.tag.replace('devenv-helper:', 'devenv-monitor:'));
    await h.ensure();
    // Review round 1 of PR #101 (A-M1): the monitor tag first, then its helper tag.
    expect(h.docker.removals).toEqual([oldMonitor, OLD_TAG, 'devenv-monitor:fedcba987654']);
    expect(h.docker.images.has(oldId)).toBe(false);
    expect(h.docker.images.get(otherId)?.tags).toEqual([OTHER_TAG, otherMonitor]);
    expect(h.docker.images.get(orphanId)?.tags).toEqual(['mine:keep']);
    expect(h.docker.images.get(currentId)?.tags).toEqual([h.tag, h.tag.replace('devenv-helper:', 'devenv-monitor:')]);
    expect(h.state().images[OLD_TAG]).toEqual({ removedAt: h.iso() });
    // Monitor tags are no records of the state.
    expect(Object.keys(h.state().images).some((tag) => tag.startsWith('devenv-monitor:'))).toBe(false);
  });

  it('plan step 11D3: a helper tag whose removal fails stays, without its monitor tag (only a name; review round 1 of PR #101, A-M1)', async () => {
    const { h } = current({ [OLD_TAG]: { lastUsedAt: h0iso(-HELPER_UNUSED_LIMIT_MS) } });
    const oldMonitor = OLD_TAG.replace('devenv-helper:', 'devenv-monitor:');
    const oldId = h.docker.addImage([OLD_TAG, oldMonitor]);
    h.docker.failingRemovals.add(OLD_TAG);
    await h.ensure();
    expect(h.docker.removals).toEqual([oldMonitor, OLD_TAG]);
    expect(h.docker.images.get(oldId)?.tags).toEqual([OLD_TAG]);
    expect(h.state().images[OLD_TAG]?.removedAt).toBeUndefined();
  });

  it('review round 1 of PR #101 (A-M1): removes the monitor tag but keeps its helper tag while a container uses its image', async () => {
    const { h } = current({ [OLD_TAG]: { lastUsedAt: h0iso(-HELPER_UNUSED_LIMIT_MS) } });
    const oldMonitor = OLD_TAG.replace('devenv-helper:', 'devenv-monitor:');
    const oldId = h.docker.addImage([OLD_TAG, oldMonitor]);
    h.docker.inUse.add(oldId);
    await h.ensure();
    // Docker untags the monitor tag (not the last reference) and refuses the helper tag (the last one).
    expect(h.docker.removals).toEqual([oldMonitor, OLD_TAG]);
    expect(h.docker.images.get(oldId)?.tags).toEqual([OLD_TAG]);
    // Not removed: no tombstone; a later cleanup tries again.
    expect(h.state().images[OLD_TAG]?.removedAt).toBeUndefined();
    h.docker.inUse.clear();
    h.advance(HELPER_CLEANUP_INTERVAL_MS);
    await h.ensure();
    expect(h.docker.images.has(oldId)).toBe(false);
  });

  it('review round 2 of PR #101 (A2-L1): a monitor tag whose removal fails keeps its helper tag, without a tombstone, until a later cleanup', async () => {
    const { h } = current({ [OLD_TAG]: { lastUsedAt: h0iso(-HELPER_UNUSED_LIMIT_MS) } });
    const oldMonitor = OLD_TAG.replace('devenv-helper:', 'devenv-monitor:');
    const oldId = h.docker.addImage([OLD_TAG, oldMonitor]);
    h.docker.inUse.add(oldId);
    h.docker.failingRemovals.add(oldMonitor);
    await h.ensure();
    expect(h.docker.removals).toEqual([oldMonitor]);
    expect(h.docker.images.get(oldId)?.tags).toEqual([OLD_TAG, oldMonitor]);
    expect(h.state().images[OLD_TAG]?.removedAt).toBeUndefined();
    h.docker.failingRemovals.clear();
    h.docker.inUse.clear();
    h.advance(HELPER_CLEANUP_INTERVAL_MS);
    await h.ensure();
    expect(h.docker.images.has(oldId)).toBe(false);
    expect(h.state().images[OLD_TAG]).toEqual({ removedAt: h.iso() });
  });

  it('review round 1 of PR #101: an orphan monitor tag that is the only tag of an image in use stays, and goes at a later cleanup', async () => {
    const { h } = current();
    const orphanId = h.docker.addImage(['devenv-monitor:fedcba987654']);
    h.docker.inUse.add(orphanId);
    await h.ensure();
    expect(h.docker.removals).toEqual(['devenv-monitor:fedcba987654']);
    expect(h.docker.images.get(orphanId)?.tags).toEqual(['devenv-monitor:fedcba987654']);
    h.docker.inUse.clear();
    h.advance(HELPER_CLEANUP_INTERVAL_MS);
    await h.ensure();
    expect(h.docker.images.has(orphanId)).toBe(false);
  });

  it('gives an unknown helper tag a grace period of 7 days, then removes it', async () => {
    const { h } = current();
    const otherId = h.docker.addImage([OTHER_TAG]);
    await h.ensure();
    expect(h.docker.removals).toEqual([]);
    expect(h.state().images[OTHER_TAG]).toEqual({ foreignSince: h.iso(), lastUsedAt: h.iso() });

    h.advance(HELPER_UNUSED_LIMIT_MS - HOUR);
    await h.ensure();
    expect(h.docker.images.has(otherId)).toBe(true);

    // The next daily cleanup, after the 7 days.
    h.advance(HELPER_CLEANUP_INTERVAL_MS);
    await h.ensure();
    expect(h.docker.removals).toEqual([OTHER_TAG]);
    expect(h.docker.images.has(otherId)).toBe(false);
    expect(h.state().images[OTHER_TAG]).toEqual({ removedAt: h.iso() });
  });

  it('keeps a helper tag that another window used within 7 days', async () => {
    const { h } = current();
    const otherId = h.docker.addImage([OTHER_TAG]);
    await h.ensure();
    // Another window with that extension version uses its helper.
    h.advance(5 * DAY);
    await recordHelperImageUse(h.statePath, OTHER_TAG, { clock: h.clock });
    h.advance(5 * DAY);
    await h.ensure();
    expect(h.docker.images.has(otherId)).toBe(true);
    expect(h.docker.removals).toEqual([]);
  });

  it('gives a helper tag with a lastUsedAt in the future (the clock was set back) a new grace period', async () => {
    const { h } = current({ [OTHER_TAG]: { lastUsedAt: '2027-01-01T00:00:00.000Z' } });
    h.docker.addImage([OTHER_TAG]);
    await h.ensure();
    expect(h.state().images[OTHER_TAG].lastUsedAt).toBe(h.iso());
  });

  it('runs at most once per day', async () => {
    const { h } = current();
    await h.ensure();
    expect(h.docker.labelQueries).toHaveLength(1);
    h.advance(HELPER_CLEANUP_INTERVAL_MS - HOUR);
    await h.ensure();
    expect(h.docker.labelQueries).toHaveLength(1);
    h.advance(HOUR);
    await h.ensure();
    expect(h.docker.labelQueries).toHaveLength(2);
  });

  it('logs removals that fail, keeps their records, and tries again at the next cleanup', async () => {
    const { h } = current({ [OLD_TAG]: { lastUsedAt: h0(-8 * DAY) }, [OTHER_TAG]: { lastUsedAt: h0(-8 * DAY) } });
    const oldId = h.docker.addImage([OLD_TAG]);
    const otherId = h.docker.addImage([OTHER_TAG]);
    const danglingId = h.docker.addImage([]);
    h.docker.inUse.add(OLD_TAG);
    h.docker.failingRemovals.add(OTHER_TAG);
    h.docker.failingRemovals.add(danglingId);
    expect(await h.ensure()).toBe(h.tag);
    expect([...h.docker.removals].sort()).toEqual([OLD_TAG, OTHER_TAG, danglingId].sort());
    expect(h.warnings().join('\n')).toContain(`${OTHER_TAG} could not be removed`);
    expect(Object.keys(h.state().images).sort()).toEqual([OLD_TAG, OTHER_TAG, h.tag].sort());

    h.docker.inUse.clear();
    h.docker.failingRemovals.clear();
    h.advance(HELPER_CLEANUP_INTERVAL_MS);
    await h.ensure();
    for (const id of [oldId, otherId, danglingId]) expect(h.docker.images.has(id)).toBe(false);
    expect(h.state().images).toEqual({
      [h.tag]: expect.objectContaining({ baseDigest: DIGEST_A }),
      [OLD_TAG]: { removedAt: h.iso() },
      [OTHER_TAG]: { removedAt: h.iso() },
    });
  });

  it('skips the cleanup when the images cannot be listed, and tries again at the next job', async () => {
    const { h } = current();
    h.docker.addImage([]);
    h.docker.listError = new CommandError('docker image ls', 1, '', 'Cannot connect to the Docker daemon');
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.removals).toEqual([]);
    expect(h.state().lastCleanupAt).toBeUndefined();

    h.docker.listError = undefined;
    h.advance(HOUR);
    await h.ensure();
    expect(h.docker.labelQueries).toHaveLength(2);
    expect(h.docker.removals).toHaveLength(1);
  });

  it('removes nothing when the ID of the current image cannot be read after a build', async () => {
    const h = new Harness();
    const danglingId = h.docker.addImage([]);
    // Review round 3 of PR #64 (P4): the ID comes from the build now (its build label); it is unavailable here too.
    h.docker.builtIdMissing = true;
    h.docker.buildHandler = async () => {
      h.docker.imageIdError = new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
    };
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.labelQueries).toEqual([]);
    expect(h.docker.images.has(danglingId)).toBe(true);
  });

  it('forgets old records of tags that do not exist anymore', async () => {
    const { h } = current({
      [OLD_TAG]: { builtAt: h0(-30 * DAY), lastUsedAt: h0(-8 * DAY) },
      [OTHER_TAG]: { lastUsedAt: h0(-DAY) },
    });
    await h.ensure();
    expect(h.docker.removals).toEqual([]);
    expect(Object.keys(h.state().images).sort()).toEqual([OTHER_TAG, h.tag].sort());
  });
});

describe('ensureHelperImage with a state file: two installations on one Docker engine', () => {
  // VS Code and VS Code Insiders have their own global storage folder (so their own helper.json) and share one Docker
  // engine. With different extension versions, each one's helper tag is foreign to the other.
  const DOCKERFILE_A = `${HELPER_DOCKERFILE}RUN echo a\n`;
  const DOCKERFILE_B = `${HELPER_DOCKERFILE}RUN echo b\n`;

  function installations() {
    const h = new Harness();
    const install = (name: string, content: string) => {
      const file = path.join(path.dirname(h.file), name, 'Dockerfile');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      const statePath = path.join(path.dirname(h.file), name, 'storage', 'helper.json');
      return {
        tag: helperImageTag(content),
        statePath,
        ensure: async () => {
          const checks: Array<Promise<void>> = [];
          const options = { statePath, baseDigest: h.baseDigest, clock: h.clock, logger: h.logger };
          await ensureHelperImage(h.docker, file, { ...options, onBaseImageCheck: (check) => checks.push(check) });
          await Promise.all(checks);
        },
        state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState,
      };
    };
    return { h, stable: install('stable', DOCKERFILE_A), insiders: install('insiders', DOCKERFILE_B) };
  }

  it('removes the helper of the other installation at most once, and keeps it when it comes back', async () => {
    const { h, stable, insiders } = installations();
    expect(stable.tag).not.toBe(insiders.tag);
    for (let day = 0; day < 40; day++) {
      await stable.ensure();
      h.advance(2 * HOUR);
      await insiders.ensure();
      h.advance(DAY - 2 * HOUR);
    }
    const removals = (tag: string) => h.docker.removals.filter((reference) => reference === tag).length;
    expect(removals(insiders.tag)).toBe(1);
    expect(removals(stable.tag)).toBe(1);
    // Each one built its helper twice: at the first open, and once after the other one removed it.
    expect(h.docker.builds.filter((build) => build.tag === stable.tag)).toHaveLength(2);
    expect(h.docker.builds.filter((build) => build.tag === insiders.tag)).toHaveLength(2);
    expect(h.docker.idOf(stable.tag)).toBeDefined();
    expect(h.docker.idOf(insiders.tag)).toBeDefined();
    expect(stable.state().images[insiders.tag]?.removedAt).toBeDefined();
    expect(h.logger.lines.join('\n')).toContain(`${insiders.tag} was built again after its removal: another installation uses it. It is kept.`);
  });
});

describe('ensureHelperImage with a state file: tombstones of removed helper tags', () => {
  function current(records: Record<string, HelperState['images'][string]> = {}) {
    const h = new Harness();
    h.docker.addImage([h.tag]);
    h.writeState({
      version: 1,
      images: { [h.tag]: { baseImage: BASE, baseDigest: DIGEST_A, checkedAt: h.iso(), lastUsedAt: h.iso() }, ...records },
    });
    return h;
  }

  it('still removes an old tag of this installation after 7 days without use, and keeps it when it comes back', async () => {
    const h = current({ [OLD_TAG]: { baseImage: BASE, builtAt: h0(-30 * DAY), lastUsedAt: h0(-HELPER_UNUSED_LIMIT_MS) } });
    h.docker.addImage([OLD_TAG]);
    await h.ensure();
    expect(h.docker.removals).toEqual([OLD_TAG]);
    expect(h.state().images[OLD_TAG]).toEqual({ removedAt: h.iso() });

    // Another installation with that extension version builds it again: it stays.
    h.docker.addImage([OLD_TAG]);
    for (let day = 0; day < 20; day++) {
      h.advance(DAY);
      await h.ensure();
    }
    expect(h.docker.removals).toEqual([OLD_TAG]);
    expect(h.docker.idOf(OLD_TAG)).toBeDefined();
  });

  it('keeps a tombstone through the pruning of old records, and drops it when it expires', async () => {
    const h = current({ [OLD_TAG]: { removedAt: h0(-30 * DAY) }, [OTHER_TAG]: { removedAt: h0(-HELPER_TOMBSTONE_MS) } });
    await h.ensure();
    expect(h.state().images[OLD_TAG]).toEqual({ removedAt: h0(-30 * DAY) });
    expect(h.state().images[OTHER_TAG]).toBeUndefined();
  });

  it('gives a tag whose tombstone expired a new grace period', async () => {
    const h = current({ [OTHER_TAG]: { removedAt: h0(-HELPER_TOMBSTONE_MS) } });
    const otherId = h.docker.addImage([OTHER_TAG]);
    await h.ensure();
    expect(h.docker.images.has(otherId)).toBe(true);
    expect(h.state().images[OTHER_TAG]).toEqual({ foreignSince: h.iso(), lastUsedAt: h.iso() });
  });

  it('drops the marks of the cleanup when the tag becomes the tag of this installation', async () => {
    const h = new Harness();
    h.docker.addImage([h.tag]);
    h.writeState({ version: 1, images: { [h.tag]: { foreignSince: h.iso(-DAY), lastUsedAt: h.iso(-DAY + HOUR) } }, lastCleanupAt: h.iso() });
    await h.ensure();
    await h.settled();
    expect(h.state().images[h.tag].foreignSince).toBeUndefined();

    h.writeState({ version: 1, images: { [OTHER_TAG]: { removedAt: h.iso(-DAY) } } });
    await recordHelperImageUse(h.statePath, OTHER_TAG, { clock: h.clock });
    expect(h.state().images[OTHER_TAG]).toEqual({ lastUsedAt: h.iso() });
  });
});

/** ISO time relative to START. */
function h0(offsetMs: number): string {
  return new Date(START + offsetMs).toISOString();
}

describe('ensureHelperImage with a state file: no previous helper image (user decision 2026-09-29)', () => {
  const offline = async (): Promise<void> => {
    throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
  };

  /** A helper image that this installation built for `tag` `builtAgoMs` ago, as recorded in the state. Returns its ID. */
  function ownOlder(h: Harness, tag: string, builtAgoMs: number, extra: Partial<HelperImageRecord> = {}): string {
    const id = h.docker.addImage([tag]);
    const state: HelperState = fs.existsSync(h.statePath) ? h.state() : { version: 1, images: {} };
    state.images[tag] = { builtAt: h.iso(-builtAgoMs), imageId: id, lastUsedAt: h.iso(-builtAgoMs), generation: HELPER_GENERATION, ...extra };
    h.writeState(state);
    return id;
  }

  it('fails when the current tag cannot be built, also when older helper images of this installation exist, and builds the current tag at the next ensure', async () => {
    const h = new Harness();
    ownOlder(h, OTHER_TAG, 60 * DAY);
    ownOlder(h, OLD_TAG, 10 * DAY);
    const before = h.state();
    h.docker.buildHandler = offline;
    // user decision 2026-09-29: no previous helper image. Changed expectation: before, the newest older helper image
    // (OLD_TAG) was returned, its use recorded, and the tag written as `previousTag`.
    await expect(h.ensure()).rejects.toBeInstanceOf(CommandError);
    // The build was tried with --pull and again without it.
    expect(h.docker.builds.map((build) => [build.tag, build.pull])).toEqual([
      [h.tag, true],
      [h.tag, false],
    ]);
    expect(h.warnings().join('\n')).not.toContain('previous helper');
    expect(h.state()).toEqual(before);
    expect(h.docker.removals).toEqual([]);

    // Online again: the next ensure builds the current tag, and the cleanup applies the usual rules.
    h.docker.buildHandler = async () => undefined;
    h.advance(HOUR);
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(3);
    expect(h.state().images[h.tag]?.imageId).toBe(h.docker.idOf(h.tag));
    // user decision 2026-09-29: no previous helper image. Changed expectation: before, OLD_TAG was kept for 7 days by
    // the use of the fallback; unused for 10 days, it is removed now, like OTHER_TAG.
    expect(h.docker.idOf(OLD_TAG)).toBeUndefined();
    expect(h.docker.removals).toContain(OLD_TAG);
    expect(h.docker.idOf(OTHER_TAG)).toBeUndefined();
  });

  it('throws the error of the build or the abort, with and without a state file, and lists no other helper image', async () => {
    const h = new Harness();
    ownOlder(h, OLD_TAG, DAY);
    h.docker.buildHandler = offline;
    // user decision 2026-09-29: no previous helper image. Changed expectation: the warning that there is no previous
    // helper image is gone, and no helper image is listed to find one.
    await expect(h.ensure()).rejects.toBeInstanceOf(CommandError);
    expect(h.warnings().join('\n')).not.toContain('there is no previous helper image');
    expect(h.docker.labelQueries).toEqual([]);
    await expect(ensureHelperImage(h.docker, h.file, { logger: h.logger })).rejects.toBeInstanceOf(CommandError);

    h.docker.buildHandler = async () => {
      throw abortError();
    };
    await expect(h.ensure()).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.docker.labelQueries).toEqual([]);
  });

  it('records no image ID for a current tag whose record is of another installation (review round 1 of PR #64, L3)', async () => {
    const h = new Harness();
    h.docker.addImage([h.tag]);
    h.writeState({ version: 1, images: { [h.tag]: { builtAt: h.iso(-DAY), foreignSince: h.iso(-DAY), lastUsedAt: h.iso(-DAY) } }, lastCleanupAt: h.iso() });
    await h.ensure({ baseDigest: undefined });
    expect(h.state().images[h.tag]).toEqual({ builtAt: h.iso(-DAY), lastUsedAt: h.iso() });
  });

  it('gives an older record without an image ID none (review round 2 of PR #64, A-N3)', async () => {
    const h = new Harness();
    h.docker.addImage([h.tag]);
    h.writeState({ version: 1, images: { [h.tag]: { builtAt: h.iso(-DAY), lastUsedAt: h.iso(-10 * HOUR) } }, lastCleanupAt: h.iso() });
    await h.ensure({ baseDigest: undefined });
    // Changed expectation (review round 2 of PR #64, A-N3): before, the ensure took the image of the tag as the one that
    // this installation built and recorded its ID; another installation may have built it, so the record gets none.
    expect(h.state().images[h.tag]).toEqual({ builtAt: h.iso(-DAY), lastUsedAt: h.iso() });
    // user decision 2026-09-29: no previous helper image. The part that checked that such a record is never used as a
    // previous helper after an extension update is gone with the previous helper.

    const other = new Harness();
    other.docker.addImage([other.tag]);
    other.writeState({ version: 1, images: { [other.tag]: { lastUsedAt: other.iso(-10 * HOUR) } }, lastCleanupAt: other.iso() });
    await other.ensure({ baseDigest: undefined });
    expect(other.state().images[other.tag]).toEqual({ lastUsedAt: other.iso() });
  });
});

describe('ensureHelperImageUse (review round 3 of PR #64, P1/P2/P4)', () => {
  const offline = async (): Promise<void> => {
    throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
  };

  function use(h: Harness, options: Partial<EnsureHelperImageOptions> = {}) {
    return ensureHelperImageUse(h.docker, h.file, { statePath: h.statePath, clock: h.clock, logger: h.logger, ...options });
  }

  it('returns the current tag with the ID of its image, and the ID of a build from the build, also when the tag moved right after it', async () => {
    const h = new Harness();
    let builtId: string | undefined;
    h.docker.afterBuild = () => {
      h.docker.afterBuild = () => undefined;
      builtId = h.docker.idOf(h.tag);
      h.docker.addImage([h.tag]);
    };
    expect(await use(h)).toEqual({ tag: h.tag, id: builtId });
    // helper.json records the ID of the build, never the one that the tag has now.
    expect(h.state().images[h.tag]?.imageId).toBe(builtId);
    expect(h.docker.idOf(h.tag)).not.toBe(builtId);
    // An existing tag: the ID of its image.
    expect(await use(h)).toEqual({ tag: h.tag, id: h.docker.idOf(h.tag) });
  });

  it('fails instead of returning an older helper image when the current tag cannot be built', async () => {
    const h = new Harness();
    const oldId = h.docker.addImage([OLD_TAG]);
    h.writeState({ version: 1, images: { [OLD_TAG]: { builtAt: h.iso(-DAY), imageId: oldId, lastUsedAt: h.iso(-DAY), generation: HELPER_GENERATION } } });
    h.docker.buildHandler = offline;
    // user decision 2026-09-29: no previous helper image. Changed expectation: before, { tag: OLD_TAG, id: oldId,
    // previous: true }.
    await expect(use(h)).rejects.toBeInstanceOf(CommandError);
  });

  it('returns the existing image with its ID when the rebuild that a check asked for fails (review round 4 of PR #64, R4-7 M7)', async () => {
    const h = new Harness();
    const oldId = h.docker.addImage([h.tag]);
    h.writeState({
      version: 1,
      images: {
        [h.tag]: {
          baseImage: BASE,
          baseDigest: DIGEST_A,
          latestBaseDigest: DIGEST_B,
          builtAt: h.iso(-30 * DAY),
          checkedAt: h.iso(-DAY),
          lastUsedAt: h.iso(-HOUR),
          imageId: oldId,
          generation: HELPER_GENERATION,
        },
      },
      lastCleanupAt: h.iso(),
    });
    h.docker.buildHandler = offline;
    expect(await use(h)).toEqual({ tag: h.tag, id: oldId });
    expect(h.docker.builds).toEqual([expect.objectContaining({ pull: true, noCache: true })]);
  });

  it('without a state file: the ID of the build, or of the existing tag, and the tag alone when the ID cannot be read', async () => {
    const h = new Harness();
    let builtId: string | undefined;
    h.docker.afterBuild = () => {
      builtId = h.docker.idOf(h.tag);
    };
    expect(await ensureHelperImageUse(h.docker, h.file)).toEqual({ tag: h.tag, id: builtId });
    expect(await ensureHelperImageUse(h.docker, h.file)).toEqual({ tag: h.tag, id: h.docker.idOf(h.tag) });
    h.docker.imageIdError = new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
    expect(await ensureHelperImageUse(h.docker, h.file, { logger: h.logger })).toEqual({ tag: h.tag });
    expect(h.warnings().join('\n')).toContain(`The ID of the workspace helper image ${h.tag} could not be read`);
  });
});

describe('registryBaseDigest', () => {
  it('maps the results of the registry client', async () => {
    const results: Record<string, DigestResult> = {
      'node:24-trixie-slim': { kind: 'digest', digest: DIGEST_A },
      'offline.example.com/a:1': { kind: 'unreachable', registry: 'offline.example.com', error: 'ENOTFOUND' },
      'ghcr.io/private/a:1': { kind: 'authRequired', registry: 'ghcr.io' },
      'ghcr.io/gone/a:1': { kind: 'notFound', registry: 'ghcr.io' },
      'ghcr.io/broken/a:1': { kind: 'error', registry: 'ghcr.io', error: 'HTTP 400' },
    };
    const requested: ImageReference[] = [];
    const lookup = registryBaseDigest({
      getDigest: async (reference) => {
        requested.push(reference);
        return results[reference.original];
      },
    });
    expect(await lookup('node:24-trixie-slim')).toBe(DIGEST_A);
    expect(requested[0]).toMatchObject({ registry: 'registry-1.docker.io', repository: 'library/node', tag: '24-trixie-slim' });
    expect(await lookup('offline.example.com/a:1')).toBe('unreachable');
    expect(await lookup('ghcr.io/private/a:1')).toBeUndefined();
    expect(await lookup('ghcr.io/gone/a:1')).toBeUndefined();
    expect(await lookup('ghcr.io/broken/a:1')).toBeUndefined();
    expect(await lookup('Not A Reference')).toBeUndefined();
    expect(requested).toHaveLength(5);
  });

  it('gives unreachable after the time limit, and when the signal aborts', async () => {
    const hanging: HttpTransport = { request: () => new Promise(() => {}) };
    const client = new RegistryClient(hanging, async () => undefined);
    const started = Date.now();
    expect(await registryBaseDigest(client, 20)('node:24-trixie-slim')).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(2000);

    const controller = new AbortController();
    const pending = registryBaseDigest(client, 60_000)('node:24-trixie-slim', controller.signal);
    controller.abort();
    expect(await pending).toBe('unreachable');
  });
});
