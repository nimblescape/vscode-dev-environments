// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  ImageMaintenance,
  highestMajorTag,
  imagePrefixesOf,
  isTimeZone,
  nextTimeOfDay,
  parseTimeOfDay,
  parseBearerChallenge,
  parseImageList,
  prefixesFromEnv,
  splitRepository,
  versionsOf,
  type HttpGet,
  type LocalImage,
} from './images';
import type { DockerResult } from './main';

const DEV = 'ghcr.io/majikmate/devcontainer-dev';
const WEB = 'ghcr.io/majikmate/devcontainer-classroom-web';
const PREFIXES = ['ghcr.io/majikmate/devcontainer-classroom', 'ghcr.io/majikmate/devcontainer-dev'];

function image(repository: string, tag: string, id: string, createdAt: string): string {
  return JSON.stringify({ Repository: repository, Tag: tag, ID: id, CreatedAt: createdAt });
}

/** A Docker CLI of the engine of the test: its images, the containers per image, and the calls. */
function fakeEngine(options: { images: string[]; usedBy?: Record<string, string>; failRemove?: string[] }) {
  const calls: string[][] = [];
  let images = [...options.images];
  const docker = async (args: readonly string[]): Promise<DockerResult> => {
    calls.push([...args]);
    if (args[0] === 'image' && args[1] === 'ls') return { code: 0, stdout: images.join('\n'), stderr: '' };
    if (args[0] === 'pull') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'ps') {
      const id = /ancestor=(.*)$/.exec(args[args.length - 1])?.[1] ?? '';
      return { code: 0, stdout: options.usedBy?.[id] ?? '', stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'rm') {
      const references = args.slice(2);
      if (references.some((reference) => options.failRemove?.includes(reference))) {
        return { code: 1, stdout: '', stderr: 'Error response from daemon: conflict: image has dependent child images' };
      }
      images = images.filter((line) => {
        const item = JSON.parse(line) as { Repository: string; Tag: string; ID: string };
        return !references.includes(`${item.Repository}:${item.Tag}`) && !references.includes(item.ID);
      });
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { docker, calls };
}

/** A registry that wants a token from its challenge, then lists `tags` per repository path. */
function fakeRegistry(tags: Record<string, string[]>) {
  const requests: Array<{ url: string; auth?: string }> = [];
  const httpGet: HttpGet = async (url, headers): ReturnType<HttpGet> => {
    requests.push({ url, auth: headers.authorization });
    if (url.startsWith('https://ghcr.io/token?')) return { status: 200, headers: {}, body: JSON.stringify({ token: 'anon-token' }) };
    const match = /^https:\/\/ghcr\.io\/v2\/(.+)\/tags\/list$/.exec(url);
    if (!match) return { status: 404, headers: {}, body: '' };
    if (headers.authorization !== 'Bearer anon-token') {
      return {
        status: 401,
        headers: { 'www-authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${match[1]}:pull"` },
        body: '',
      };
    }
    const list = tags[match[1]];
    return list ? { status: 200, headers: {}, body: JSON.stringify({ name: match[1], tags: list }) } : { status: 404, headers: {}, body: '' };
  };
  return { httpGet, requests };
}

describe('the images of the remote Session Monitor (user requests 2026-09-28)', () => {
  it('reads the prefixes of the setting: a trailing * dropped, invalid ones left out', () => {
    expect(imagePrefixesOf(['ghcr.io/majikmate/devcontainer-dev*', 'ghcr.io/majikmate/devcontainer-dev', 'no-registry*', 'GHCR.io/x*', 3])).toEqual([
      'ghcr.io/majikmate/devcontainer-dev',
    ]);
    expect(prefixesFromEnv({ DEVENV_IMAGE_PREFIXES: JSON.stringify(PREFIXES) })).toEqual(PREFIXES);
    expect(prefixesFromEnv({ DEVENV_IMAGE_PREFIXES: 'not json' })).toEqual([]);
    expect(prefixesFromEnv({})).toEqual([]);
  });

  it('takes the highest plain major tag (the registry has latest, 2, 2.0, 2.0.14, 2.0.14-amd64)', () => {
    expect(highestMajorTag(['latest', '2.0', '2', '2.0.14-amd64', '2.0.14', '1', '10'])).toBe('10');
    expect(highestMajorTag(['latest', '2.0.14'])).toBeUndefined();
    expect(highestMajorTag(['01', '2'])).toBe('2');
  });

  it('orders the versions of a repository newest first: version tags, then the creation time', () => {
    const images: LocalImage[] = parseImageList(
      [
        image(DEV, '2.0.13', 'sha256:b', '2026-09-01 10:00:00 +0000 UTC'),
        image(DEV, '2', 'sha256:c', '2026-09-20 10:00:00 +0000 UTC'),
        image(DEV, '2.0.14', 'sha256:c', '2026-09-20 10:00:00 +0000 UTC'),
        image(DEV, '1.9.0', 'sha256:a', '2026-10-01 10:00:00 +0000 UTC'),
        image(DEV, '<none>', 'sha256:d', '2026-09-25 10:00:00 +0000 UTC'),
        'not json',
      ].join('\n'),
    );
    expect(versionsOf(images).map((version) => [version.id, version.tags])).toEqual([
      ['sha256:c', ['2', '2.0.14']],
      ['sha256:b', ['2.0.13']],
      ['sha256:a', ['1.9.0']],
      ['sha256:d', []],
    ]);
  });

  it('splits a repository and reads a Bearer challenge', () => {
    expect(splitRepository(DEV)).toEqual({ registry: 'ghcr.io', path: 'majikmate/devcontainer-dev' });
    expect(splitRepository('library/ubuntu')).toBeUndefined();
    expect(parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"')).toEqual({
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:a/b:pull',
    });
    // Only https realms.
    expect(parseBearerChallenge('Bearer realm="http://evil/token"')).toBeUndefined();
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
  });

  it('pulls the latest major version of each repository on the host and of the list of the extension (all images)', async () => {
    const engine = fakeEngine({
      images: [image(DEV, '2', 'sha256:c', '2026-09-20'), image('ghcr.io/other/base', '1', 'sha256:x', '2026-09-20')],
    });
    const registry = fakeRegistry({ 'majikmate/devcontainer-dev': ['latest', '2', '2.0.14'], 'majikmate/devcontainer-classroom-web': ['1', '2', '3'] });
    const log: string[] = [];
    await new ImageMaintenance({
      docker: engine.docker,
      httpGet: registry.httpGet,
      log: (message) => log.push(message),
      prefixes: PREFIXES,
      // A repository that the host has no image of yet, and one of no prefix (left out).
      knownRepositories: async () => [WEB, 'ghcr.io/other/base'],
    }).pass();
    expect(engine.calls.filter((call) => call[0] === 'pull')).toEqual([
      ['pull', '--quiet', `${DEV}:2`],
      ['pull', '--quiet', `${WEB}:3`],
    ]);
    // The anonymous token of the challenge; the other repository is never asked.
    expect(registry.requests.some((request) => request.url.includes('other'))).toBe(false);
    expect(registry.requests.filter((request) => request.url.startsWith('https://ghcr.io/token?'))[0].url).toContain('scope=repository%3Amajikmate%2Fdevcontainer-dev%3Apull');
    expect(log).toEqual([]);
  });

  it('keeps the two newest versions; removes the older ones by their references, never with force, not when a container uses them', async () => {
    const engine = fakeEngine({
      images: [
        image(DEV, '2', 'sha256:new', '2026-09-20'),
        image(DEV, '2.0.14', 'sha256:new', '2026-09-20'),
        image(DEV, '2.0.13', 'sha256:prev', '2026-09-10'),
        image(DEV, '2.0.12', 'sha256:used', '2026-09-01'),
        image(DEV, '2.0.11', 'sha256:old', '2026-08-01'),
        image(DEV, '<none>', 'sha256:dangling', '2026-07-01'),
        image(DEV, '2.0.10', 'sha256:parent', '2026-06-01'),
      ],
      usedBy: { 'sha256:used': 'container-id\n' },
      failRemove: [`${DEV}:2.0.10`],
    });
    const registry = fakeRegistry({ 'majikmate/devcontainer-dev': ['2'] });
    const log: string[] = [];
    await new ImageMaintenance({ docker: engine.docker, httpGet: registry.httpGet, log: (message) => log.push(message), prefixes: PREFIXES, knownRepositories: async () => [] }).pass();
    const removals = engine.calls.filter((call) => call[0] === 'image' && call[1] === 'rm');
    expect(removals).toEqual([
      ['image', 'rm', `${DEV}:2.0.11`],
      ['image', 'rm', `${DEV}:2.0.10`],
      ['image', 'rm', 'sha256:dangling'],
    ]);
    expect(engine.calls.flat()).not.toContain('-f');
    expect(engine.calls.flat()).not.toContain('--force');
    expect(log).toEqual([
      `Removed the older image ${DEV} (2.0.11).`,
      `The older image ${DEV} (2.0.10) stays: Error response from daemon: conflict: image has dependent child images`,
      `Removed the older image ${DEV} (sha256:dangling).`,
    ]);
  });

  it('does not update a repository whose tags cannot be read, and still cleans it', async () => {
    const engine = fakeEngine({
      images: [image(DEV, '2.0.14', 'sha256:a', '2026-09-20'), image(DEV, '2.0.13', 'sha256:b', '2026-09-10'), image(DEV, '2.0.12', 'sha256:c', '2026-09-01')],
    });
    const log: string[] = [];
    const httpGet: HttpGet = async () => ({ status: 500, headers: {}, body: '' });
    await new ImageMaintenance({ docker: engine.docker, httpGet, log: (message) => log.push(message), prefixes: PREFIXES, knownRepositories: async () => [] }).pass();
    expect(engine.calls.some((call) => call[0] === 'pull')).toBe(false);
    expect(log[0]).toBe(`The tags of ${DEV} could not be read; it is not updated: HTTP 500`);
    expect(engine.calls.filter((call) => call[1] === 'rm')).toEqual([['image', 'rm', `${DEV}:2.0.12`]]);
  });

  // User request 2026-09-28: "1 minute after the monitor starts then in the morning again, at 6:07 CEST".
  it('finds the next 06:07 in Europe/Vienna: 04:07 UTC in summer, 05:07 UTC in winter, the next day after it', () => {
    const at = (iso: string) => Date.parse(iso);
    expect(new Date(nextTimeOfDay(at('2026-09-28T20:00:00Z'), 6, 7, 'Europe/Vienna')).toISOString()).toBe('2026-09-29T04:07:00.000Z');
    expect(new Date(nextTimeOfDay(at('2026-09-29T03:00:00Z'), 6, 7, 'Europe/Vienna')).toISOString()).toBe('2026-09-29T04:07:00.000Z');
    expect(new Date(nextTimeOfDay(at('2026-12-01T12:00:00Z'), 6, 7, 'Europe/Vienna')).toISOString()).toBe('2026-12-02T05:07:00.000Z');
    // The night of the change to winter time (25 October 2026): 06:07 is already CET.
    expect(new Date(nextTimeOfDay(at('2026-10-24T12:00:00Z'), 6, 7, 'Europe/Vienna')).toISOString()).toBe('2026-10-25T05:07:00.000Z');
    expect(new Date(nextTimeOfDay(at('2026-09-28T20:00:00Z'), 6, 7, 'UTC')).toISOString()).toBe('2026-09-29T06:07:00.000Z');
  });

  it('reads a time of day and a time zone strictly', () => {
    expect(parseTimeOfDay('06:07')).toEqual({ hour: 6, minute: 7 });
    for (const text of ['6:07', '24:00', '06:60', '', undefined]) expect(parseTimeOfDay(text), String(text)).toBeUndefined();
    expect(isTimeZone('Europe/Vienna')).toBe(true);
    expect(isTimeZone('Mars/Base')).toBe(false);
    expect(isTimeZone('Europe/Vienna; rm -rf /')).toBe(false);
  });

  it('does nothing without prefixes, and never throws when Docker does not answer', async () => {
    const calls: string[][] = [];
    const docker = async (args: readonly string[]): Promise<DockerResult> => {
      calls.push([...args]);
      return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    };
    const httpGet: HttpGet = async () => ({ status: 200, headers: {}, body: '{}' });
    await new ImageMaintenance({ docker, httpGet, log: () => {}, prefixes: [], knownRepositories: async () => [] }).pass();
    expect(calls).toEqual([]);
    const log: string[] = [];
    await new ImageMaintenance({ docker, httpGet, log: (message) => log.push(message), prefixes: PREFIXES, knownRepositories: async () => [] }).pass();
    expect(log).toEqual(['The images could not be maintained: docker image ls failed: Cannot connect to the Docker daemon']);
  });
});
