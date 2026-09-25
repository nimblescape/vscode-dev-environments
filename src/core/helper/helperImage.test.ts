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
  HELPER_LAST_USED_INTERVAL_MS,
  HELPER_RETRY_INTERVAL_MS,
  HELPER_TOMBSTONE_MS,
  HELPER_UNUSED_LIMIT_MS,
  ensureHelperImage,
  helperImageTag,
  recordHelperImageUse,
  registryBaseDigest,
  type BaseDigestLookup,
  type EnsureHelperImageOptions,
  type HelperImageDocker,
} from './helperImage';
import type { HelperState } from './helperState';

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
  /** Carries the label devenv.helper=true. */
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

  async buildImage(options: BuildOptions): Promise<void> {
    this.builds.push(options);
    // Docker moves the tag only after a successful build.
    await this.buildHandler(options);
    this.addImage([options.tag], { helper: options.labels?.['devenv.helper'] === 'true' });
  }

  async listImagesByLabel(label: string): Promise<ImageInfo[]> {
    this.labelQueries.push(label);
    if (this.listError) throw this.listError;
    return [...this.images.values()]
      .filter((image) => label === 'devenv.helper=true' && image.helper)
      .map((image) => ({ id: image.id, tags: [...image.tags], createdAt: '2026-09-01 10:00:00 +0200 CEST' }));
  }

  /** Like `docker image rm` without force: a tag is untagged (the image goes with its last tag). */
  async removeImage(reference: string): Promise<boolean> {
    this.removals.push(reference);
    const id = this.idOf(reference);
    if (id === undefined) return false;
    if (this.failingRemovals.has(reference)) throw new CommandError(`docker image rm ${reference}`, 1, '', 'Cannot connect to the Docker daemon');
    if (this.inUse.has(reference) || this.inUse.has(id)) return false;
    const image = this.images.get(id)!;
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

  it('matches the hash of the file content plus the version', () => {
    // sha256('abc' + '1') = sha256('abc1')
    expect(helperImageTag('abc', '1')).toBe('devenv-helper:dbfcfd0d8722');
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
      labels: { 'devenv.helper': 'true' },
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
    expect(content).toMatch(/^LABEL devenv\.helper=true$/m);
    // Classic builder compatibility: no syntax directive, no heredoc, no RUN --mount.
    expect(content).not.toMatch(/^#\s*syntax=/m);
    expect(content).not.toMatch(/^[^#]*<</m);
    expect(content).not.toMatch(/^\s*RUN\s+--mount/m);
    const docker = new FakeDocker();
    expect(await ensureHelperImage(docker, file)).toBe(helperImageTag(content));
  });
});

const BASE = 'node:24-trixie-slim';
const HELPER_DOCKERFILE = `ARG BASE_IMAGE=${BASE}\nFROM \${BASE_IMAGE}\nLABEL devenv.helper=true\n`;
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const START = Date.parse('2026-09-24T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OLD_TAG = 'devenv-helper:0123456789ab';
const OTHER_TAG = 'devenv-helper:abcdef012345';

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
    expect(h.docker.builds[0]).toMatchObject({ tag: h.tag, pull: true, labels: { 'devenv.helper': 'true' } });
    expect(h.docker.builds[0].noCache).toBeUndefined();
    expect(h.state()).toEqual({
      version: 1,
      images: { [h.tag]: { baseImage: BASE, baseDigest: DIGEST_A, builtAt: h.iso(), checkedAt: h.iso(), lastUsedAt: h.iso() } },
      lastCleanupAt: h.iso(),
    });
  });

  it('builds without --pull when the registry does not answer, and builds again from the current base image after the next check', async () => {
    const h = new Harness();
    h.answer = async () => 'unreachable';
    await h.ensure();
    expect(h.docker.builds[0].pull).toBe(false);
    // No digest and no checkedAt, but the mark: the image may come from an old local base image.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      builtAt: h.iso(),
      builtWithoutPull: h.iso(),
      attemptedAt: h.iso(),
      lastUsedAt: h.iso(),
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
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
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
    expect(h.state().images[h.tag]).toEqual({ baseImage: BASE, builtAt: h.iso(), lastUsedAt: h.iso() });
  });

  it('replaces the record of a tag whose image was removed', async () => {
    const h = new Harness();
    h.writeState({
      version: 1,
      images: { [h.tag]: { baseImage: BASE, baseDigest: DIGEST_B, builtAt: h.iso(-30 * DAY), checkedAt: h.iso(-DAY) } },
    });
    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
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
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      builtAt: h.iso(),
      builtWithoutPull: h.iso(),
      attemptedAt: h.iso(),
      lastUsedAt: h.iso(),
    });

    // The next check (a day later) asks for a build with a fresh base image, and the next ensure runs it.
    h.docker.buildHandler = async () => undefined;
    h.advance(HELPER_RETRY_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    await h.ensure();
    expect(h.docker.builds).toHaveLength(3);
    expect(h.docker.builds[2]).toMatchObject({ pull: true, noCache: true });
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
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
    h.answer = () => new Promise<LookupAnswer>(() => {});
    setTimeout(() => controller.abort(), 5);
    await expect(h.ensure({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.lookups[0].signal?.aborted).toBe(true);
    expect(h.docker.builds).toHaveLength(0);
    expect(fs.existsSync(h.statePath)).toBe(false);
  });

  it('builds a missing tag with --pull and without a lookup when the check of the base image is off', async () => {
    const h = new Harness();
    await h.ensure({ checkBaseImage: false });
    await h.settled();
    expect(h.lookups).toHaveLength(0);
    expect(h.docker.builds[0]).toMatchObject({ pull: true });
    expect(h.state().images[h.tag]).toEqual({ baseImage: BASE, builtAt: h.iso(), lastUsedAt: h.iso() });
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
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(-30 * DAY),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
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
    expect(h.docker.builds[0]).toMatchObject({ tag: h.tag, pull: true, noCache: true, labels: { 'devenv.helper': 'true' } });
    // The build output reaches onOutput, and onBuild tells that an existing helper is updated.
    expect(output).toEqual(['#1 building\n']);
    expect(builds).toEqual(['refresh']);
    const newId = h.docker.idOf(h.tag);
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    expect(h.docker.removals).toEqual([oldId]);
    expect(h.docker.images.has(oldId)).toBe(false);
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_B,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
    });
    await h.settled();
    expect(h.lookups).toHaveLength(1);
  });

  it('keeps the previous image when it still has another tag', async () => {
    const { h, oldId } = await changed();
    h.docker.images.get(oldId)!.tags.push('mine:backup');
    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.removals).toEqual([]);
    expect(h.docker.images.get(oldId)?.tags).toEqual(['mine:backup']);
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
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(-30 * DAY),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
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
    expect(h.docker.labelQueries).toEqual(['devenv.helper=true']);
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
