import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock, Logger } from '../ports';
import type { Environment, RegistryFile } from '../types';
import { StoragePaths } from './paths';
import { EnvironmentRegistry, REGISTRY_NEWER_VERSION_MESSAGE, RegistryVersionError } from './registry';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ID_B = '7c1d2e3f-0000-4000-8000-000000000002';
const T0 = Date.parse('2026-09-24T15:40:00.000Z');

function environment(id: string, repository: string, extra: Partial<Environment> = {}): Environment {
  const name = `devenv-${repository.replace('/', '-').toLowerCase()}-${id.slice(0, 8)}`;
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: name,
    containerName: name,
    createdAt: '2026-09-24T15:40:00.000Z',
    lastUsedAt: '2026-09-24T17:10:00.000Z',
    ...extra,
  };
}

function fixedClock(ms = T0): Clock {
  return { now: () => ms };
}

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (message) => warnings.push(message), error() {}, output() {} };
}

let root: string;
let paths: StoragePaths;

function writeRaw(value: unknown): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(paths.registry, typeof value === 'string' ? value : JSON.stringify(value));
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(paths.registry, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  paths = new StoragePaths(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('EnvironmentRegistry reading', () => {
  it('gives an empty registry for a missing file', async () => {
    const registry = new EnvironmentRegistry(paths);
    await expect(registry.exists()).resolves.toBe(false);
    await expect(registry.read()).resolves.toEqual({ version: 1, environments: [] });
    await expect(registry.list()).resolves.toEqual([]);
    await expect(registry.get(ID_A)).resolves.toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{"version": 1, "environments": ['],
    ['an empty file', ''],
    ['a list', '[]'],
    ['null', 'null'],
    ['version 0', { version: 0, environments: [environment(ID_A, 'o/r')] }],
    ['a text version', { version: '1', environments: [environment(ID_A, 'o/r')] }],
    ['environments that are not a list', { version: 1, environments: { a: 1 } }],
  ])('tolerates %s', async (_name, content) => {
    writeRaw(content);
    const registry = new EnvironmentRegistry(paths);
    await expect(registry.exists()).resolves.toBe(true);
    await expect(registry.read()).resolves.toEqual({ version: 1, environments: [] });
  });

  it('normalizes missing parts', async () => {
    writeRaw({});
    const registry = new EnvironmentRegistry(paths);
    await expect(registry.read()).resolves.toEqual({ version: 1, environments: [] });
    writeRaw({ environments: [environment(ID_A, 'o/r')] });
    await expect(registry.list()).resolves.toEqual([environment(ID_A, 'o/r')]);
  });

  it('ignores a byte order mark', async () => {
    writeRaw(`﻿${JSON.stringify({ version: 1, environments: [environment(ID_A, 'o/r')] })}`);
    await expect(new EnvironmentRegistry(paths).list()).resolves.toHaveLength(1);
  });

  it('leaves out unusable entries, fills defaults, and removes invalid optional fields', async () => {
    const valid = environment(ID_A, 'o/r', {
      gitSummary: { branch: null, uncommittedFiles: 1, unpushedCommits: 2, stashes: 0, recordedAt: 'x' },
      busy: { operation: 'rebuild', since: 'x', pid: 12, windowId: 'w' },
      owner: { id: '1001', login: 'octo' },
      refusedUpdate: { configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:1', images: { 'node:20': 'sha256:a' }, features: {}, items: 'privileged mode' },
    });
    writeRaw({
      version: 1,
      environments: [
        valid,
        { ...environment(ID_A, 'o/r'), repository: 'other/one' }, // repeated ID
        { id: ID_B, repository: 'o/b', volumeName: 'v', containerName: 'c' }, // defaults
        {
          ...environment('e3', 'o/c'),
          gitSummary: { branch: 'main', uncommittedFiles: -1, unpushedCommits: 0, stashes: 0, recordedAt: 'x' },
          buildRecord: { environmentImage: 'devenv-e3:1' },
          busy: { operation: 'rebuild', since: 'x', pid: 0, windowId: 'w' },
          remoteUser: 5,
          shutdownActionNone: 'yes',
          additionalVolumes: ['a', 3],
          lastBuildNumber: 1.5,
          owner: { id: '../1001', login: 'octo' },
          refusedUpdate: { configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:1', images: { 'node:20': 1 }, features: {}, items: 'x' },
        },
        // An owner restored from a volume label has no login yet; it stays.
        { ...environment('e7', 'o/d'), owner: { id: '1002', login: '' } },
        { ...environment('e8', 'o/e'), owner: { login: 'octo' } },
        { ...environment('e4', 'no-slash') },
        { ...environment('e5', 'o/r'), volumeName: '' },
        { ...environment('e6', 'o/r'), containerName: 7 },
        { ...environment('', 'o/r') },
        'text',
        null,
      ],
    });
    const list = await new EnvironmentRegistry(paths).list();
    expect(list.map((entry) => entry.id)).toEqual([ID_A, ID_B, 'e3', 'e7', 'e8']);
    expect(list[0]).toEqual(valid);
    expect(list[1]).toEqual({
      id: ID_B,
      repository: 'o/b',
      volumeName: 'v',
      containerName: 'c',
      configPath: '.devcontainer/devcontainer.json',
      createdAt: '1970-01-01T00:00:00.000Z',
      lastUsedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(list[2]).toEqual(environment('e3', 'o/c'));
    expect(list[3].owner).toEqual({ id: '1002', login: '' });
    // An invalid owner is removed: the entry counts as one of an older version, which only a claim makes available.
    expect(list[4]).toEqual(environment('e8', 'o/e'));
  });

  it('accepts busy marks with an operation of a newer version', async () => {
    const busy = { operation: 'migrate', since: 'x', pid: 12, windowId: 'w' };
    writeRaw({ version: 1, environments: [{ ...environment(ID_A, 'o/r'), busy }] });
    await expect(new EnvironmentRegistry(paths).get(ID_A)).resolves.toMatchObject({ busy });
  });

  it('finds environments by repository, ignoring case', async () => {
    writeRaw({ version: 1, environments: [environment(ID_A, 'Acme-University/API'), environment(ID_B, 'o/b')] });
    const registry = new EnvironmentRegistry(paths);
    await expect(registry.findByRepository('acme-university/api')).resolves.toMatchObject({ id: ID_A });
    await expect(registry.findByRepository('ACME-UNIVERSITY/API')).resolves.toMatchObject({ id: ID_A });
    await expect(registry.findByRepository('acme-university/web')).resolves.toBeUndefined();
    await expect(registry.get(ID_B)).resolves.toMatchObject({ repository: 'o/b' });
  });

  it('finds environments by container name, with or without the leading slash', async () => {
    const env = environment(ID_A, 'o/r');
    writeRaw({ version: 1, environments: [env, { ...environment(ID_B, 'o/b'), containerName: '/devenv-b' }] });
    const registry = new EnvironmentRegistry(paths);
    await expect(registry.findByContainerName(env.containerName)).resolves.toMatchObject({ id: ID_A });
    await expect(registry.findByContainerName(`/${env.containerName}`)).resolves.toMatchObject({ id: ID_A });
    await expect(registry.findByContainerName('devenv-b')).resolves.toMatchObject({ id: ID_B });
    await expect(registry.findByContainerName('/devenv-x')).resolves.toBeUndefined();
  });

  it('throws when the file exists but cannot be read', async () => {
    fs.mkdirSync(paths.registry, { recursive: true });
    await expect(new EnvironmentRegistry(paths).read()).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('EnvironmentRegistry.needsRestore (concept 7.5 "registry lost")', () => {
  const ENTRY = environment(ID_A, 'acme/api');
  const needsRestore = () => new EnvironmentRegistry(paths, fixedClock()).needsRestore();

  it('is true when registry.json is missing', async () => {
    expect(await needsRestore()).toBe(true);
  });

  it('is true when registry.json is not valid JSON, empty, or not an object', async () => {
    for (const content of ['{ "version": 1, "environments": [ {', '', '[]', 'null', '42']) {
      writeRaw(content);
      expect(await needsRestore(), JSON.stringify(content)).toBe(true);
    }
  });

  it('is true for an unknown older version and for environments that are not a list', async () => {
    writeRaw({ version: 0, environments: [ENTRY] });
    expect(await needsRestore()).toBe(true);
    writeRaw({ version: 'one', environments: [ENTRY] });
    expect(await needsRestore()).toBe(true);
    writeRaw({ version: 1, environments: { [ENTRY.id]: ENTRY } });
    expect(await needsRestore()).toBe(true);
  });

  it('is true when the registry leaves out invalid entries', async () => {
    writeRaw({ version: 1, environments: [ENTRY, { id: 'broken' }] });
    expect(await needsRestore()).toBe(true);
    writeRaw({ version: 1, environments: [ENTRY, ENTRY] });
    expect(await needsRestore()).toBe(true);
  });

  it('is false for a valid registry, also an empty one or one without a version', async () => {
    writeRaw({ version: 1, environments: [ENTRY] });
    expect(await needsRestore()).toBe(false);
    writeRaw({ version: 1, environments: [] });
    expect(await needsRestore()).toBe(false);
    writeRaw({ environments: [ENTRY] });
    expect(await needsRestore()).toBe(false);
    writeRaw({ version: 1 });
    expect(await needsRestore()).toBe(false);
  });

  it('is false for a registry of a newer version, which this version must not change', async () => {
    writeRaw({ version: 2, environments: [] });
    expect(await needsRestore()).toBe(false);
  });

  it('is false again after the registry was written (the invalid file is replaced)', async () => {
    writeRaw('not json');
    expect(await needsRestore()).toBe(true);
    await new EnvironmentRegistry(paths, fixedClock()).add({ ...ENTRY });
    expect(await needsRestore()).toBe(false);
  });
});

describe('EnvironmentRegistry changes', () => {
  it('adds, changes, and removes environments', async () => {
    const registry = new EnvironmentRegistry(paths);
    await registry.add(environment(ID_A, 'o/a'));
    await registry.add(environment(ID_B, 'o/b'));
    await expect(registry.exists()).resolves.toBe(true);
    expect(readRaw()).toEqual({ version: 1, environments: [environment(ID_A, 'o/a'), environment(ID_B, 'o/b')] });

    const changed = await registry.updateEnvironment(ID_A, (entry) => {
      entry.lastUsedAt = '2026-09-25T08:00:00.000Z';
      entry.lastBuildNumber = 3;
    });
    expect(changed).toMatchObject({ id: ID_A, lastUsedAt: '2026-09-25T08:00:00.000Z', lastBuildNumber: 3 });
    await expect(registry.get(ID_A)).resolves.toEqual(changed);
    await expect(registry.updateEnvironment('missing', () => {})).resolves.toBeUndefined();

    await registry.remove(ID_A);
    await registry.remove('missing');
    await expect(registry.list()).resolves.toEqual([environment(ID_B, 'o/b')]);
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('refuses a second environment with the same ID and leaves the file unchanged', async () => {
    const registry = new EnvironmentRegistry(paths);
    await registry.add(environment(ID_A, 'o/a'));
    const before = fs.readFileSync(paths.registry, 'utf8');
    await expect(registry.add(environment(ID_A, 'o/other'))).rejects.toThrow(/exists already/);
    expect(fs.readFileSync(paths.registry, 'utf8')).toBe(before);
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('refuses a second environment of the same repository, ignoring case (one environment per repository)', async () => {
    const registry = new EnvironmentRegistry(paths);
    await registry.add(environment(ID_A, 'Acme/API'));
    await expect(registry.add(environment(ID_B, 'acme/api'))).rejects.toThrow(/An environment of acme\/api exists already/);
    const results = await Promise.allSettled(
      [ID_B, 'c0ffee00-0000-4000-8000-000000000003'].map((id) =>
        new EnvironmentRegistry(paths).add(environment(id, 'o/same')),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(registry.list()).resolves.toHaveLength(2);
  });

  it('awaits an async mutator of updateEnvironment before it writes', async () => {
    const registry = new EnvironmentRegistry(paths);
    await registry.add(environment(ID_A, 'o/a'));
    await registry.updateEnvironment(ID_A, async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      entry.lastBuildNumber = 7;
    });
    await expect(registry.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 7 });
  });

  it('writes nothing when a mutator throws', async () => {
    const registry = new EnvironmentRegistry(paths);
    await registry.add(environment(ID_A, 'o/a'));
    const before = fs.readFileSync(paths.registry, 'utf8');
    await expect(
      registry.update((file) => {
        file.environments = [];
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(fs.readFileSync(paths.registry, 'utf8')).toBe(before);
  });

  it('does not write, or create, the file when nothing changed', async () => {
    const registry = new EnvironmentRegistry(paths);
    await expect(registry.update(() => 42)).resolves.toBe(42);
    await registry.remove(ID_A);
    await registry.clearBusy(ID_A);
    await expect(registry.exists()).resolves.toBe(false);

    await registry.add(environment(ID_A, 'o/a'));
    const mtime = fs.statSync(paths.registry).mtimeMs;
    const inode = fs.statSync(paths.registry).ino;
    await registry.updateEnvironment(ID_A, (entry) => {
      entry.lastUsedAt = `${entry.lastUsedAt}`; // same value
    });
    expect(fs.statSync(paths.registry).mtimeMs).toBe(mtime);
    expect(fs.statSync(paths.registry).ino).toBe(inode);
  });

  it('keeps unknown fields at every level', async () => {
    writeRaw({
      version: 1,
      futureTopLevel: { a: 1 },
      environments: [
        {
          ...environment(ID_A, 'o/a'),
          futureField: 'keep me',
          gitSummary: {
            branch: 'main',
            uncommittedFiles: 0,
            unpushedCommits: 0,
            stashes: 0,
            recordedAt: 'x',
            futureNested: true,
          },
        },
      ],
    });
    const registry = new EnvironmentRegistry(paths);
    await registry.updateEnvironment(ID_A, (entry) => {
      entry.lastBuildNumber = 1;
    });
    const raw = readRaw();
    expect(raw.futureTopLevel).toEqual({ a: 1 });
    const [entry] = raw.environments as Array<Record<string, unknown>>;
    expect(entry.futureField).toBe('keep me');
    expect(entry.lastBuildNumber).toBe(1);
    expect((entry.gitSummary as Record<string, unknown>).futureNested).toBe(true);
  });

  it('never overwrites a file of a newer version', async () => {
    const newer = { version: 2, environments: [{ id: ID_A, somethingNew: true }] };
    writeRaw(newer);
    const registry = new EnvironmentRegistry(paths);
    await expect(registry.read()).resolves.toEqual({ version: 1, environments: [] });
    const error = await registry.add(environment(ID_B, 'o/b')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryVersionError);
    expect((error as RegistryVersionError).version).toBe(2);
    expect((error as Error).message).toBe(REGISTRY_NEWER_VERSION_MESSAGE);
    await expect(registry.remove(ID_A)).rejects.toBeInstanceOf(RegistryVersionError);
    expect(readRaw()).toEqual(newer);
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('keeps a copy of an invalid file before it replaces it', async () => {
    writeRaw('{ broken');
    const logger = recordingLogger();
    const registry = new EnvironmentRegistry(paths, fixedClock(1234), { logger });
    await registry.add(environment(ID_A, 'o/a'));
    expect(readRaw()).toEqual({ version: 1, environments: [environment(ID_A, 'o/a')] });
    expect(fs.readFileSync(`${paths.registry}.backup-1234`, 'utf8')).toBe('{ broken');
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('was not valid');
  });

  it('keeps a copy when invalid entries would be lost', async () => {
    const content = { version: 1, environments: [environment(ID_A, 'o/a'), { id: 'x' }] };
    writeRaw(content);
    const logger = recordingLogger();
    const registry = new EnvironmentRegistry(paths, fixedClock(99), { logger });
    await registry.add(environment(ID_B, 'o/b'));
    expect(JSON.parse(fs.readFileSync(`${paths.registry}.backup-99`, 'utf8'))).toEqual(content);
    expect(readRaw()).toEqual({ version: 1, environments: [environment(ID_A, 'o/a'), environment(ID_B, 'o/b')] });
    expect(logger.warnings[0]).toContain('1 invalid environment entries');
  });

  it('does not change an invalid file when nothing is written', async () => {
    writeRaw('{ broken');
    await new EnvironmentRegistry(paths).remove(ID_A);
    expect(fs.readFileSync(paths.registry, 'utf8')).toBe('{ broken');
    expect(fs.readdirSync(root).filter((name) => name.includes('backup'))).toEqual([]);
  });

  it('sets and clears the busy mark', async () => {
    const registry = new EnvironmentRegistry(paths, fixedClock());
    await registry.add(environment(ID_A, 'o/a'));
    await registry.setBusy(ID_A, 'rebuild', { windowId: 'window-1', pid: 4321 });
    await expect(registry.get(ID_A)).resolves.toMatchObject({
      busy: { operation: 'rebuild', since: '2026-09-24T15:40:00.000Z', pid: 4321, windowId: 'window-1' },
    });
    await registry.setBusy(ID_A, 'delete', { windowId: 'window-2', pid: 99 });
    await expect(registry.get(ID_A)).resolves.toMatchObject({ busy: { operation: 'delete', windowId: 'window-2' } });
    await registry.clearBusy(ID_A);
    const cleared = await registry.get(ID_A);
    expect(cleared).toBeDefined();
    expect(cleared && 'busy' in cleared).toBe(false);
    await registry.clearBusy('missing');
    await expect(registry.setBusy('missing', 'update', { windowId: 'w', pid: 1 })).rejects.toThrow(/does not exist/);
  });

  it('applies all of 20 parallel changes', async () => {
    const registry = new EnvironmentRegistry(paths);
    await registry.add(environment(ID_A, 'o/a', { lastBuildNumber: 0 }));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        registry.updateEnvironment(ID_A, (entry) => {
          entry.lastBuildNumber = (entry.lastBuildNumber ?? 0) + 1;
        }),
      ),
    );
    await expect(registry.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 20 });
  });

  it('applies parallel changes of several registry instances (several windows), also with async mutators', async () => {
    await new EnvironmentRegistry(paths).add(environment(ID_A, 'o/a', { additionalVolumes: [] }));
    const registries = Array.from({ length: 5 }, () => new EnvironmentRegistry(paths));
    await Promise.all(
      registries.flatMap((registry, r) =>
        Array.from({ length: 4 }, (_, i) =>
          registry.update(async (file) => {
            const entry = file.environments[0];
            const volumes = [...(entry.additionalVolumes ?? [])];
            await new Promise((resolve) => setTimeout(resolve, 1));
            volumes.push(`v${r}-${i}`);
            entry.additionalVolumes = volumes;
          }),
        ),
      ),
    );
    const entry = await new EnvironmentRegistry(paths).get(ID_A);
    expect(entry?.additionalVolumes).toHaveLength(20);
    expect(new Set(entry?.additionalVolumes).size).toBe(20);
  });

  it('removes a stale lock of a crashed process', async () => {
    fs.mkdirSync(paths.registryLock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.registryLock, old, old);
    const registry = new EnvironmentRegistry(paths);
    const start = Date.now();
    await registry.add(environment(ID_A, 'o/a'));
    expect(Date.now() - start).toBeLessThan(2_000);
    await expect(registry.list()).resolves.toHaveLength(1);
    expect(fs.existsSync(paths.registryLock)).toBe(false);
  });

  it('gives a stale lock to only one of two waiters, also when one of them is slow to remove it', async () => {
    await new EnvironmentRegistry(paths).add(environment(ID_A, 'o/a', { lastBuildNumber: 0 }));
    fs.mkdirSync(paths.registryLock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.registryLock, old, old);
    // The first removal of the lock folder is slow: without protection, the slow waiter removes the new lock of the
    // other waiter, and both hold the lock.
    const realRm = fs.promises.rm;
    let delayed = false;
    const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (!delayed && target === paths.registryLock) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return realRm(target, options);
    });
    let active = 0;
    let maxActive = 0;
    try {
      await Promise.all(
        Array.from({ length: 2 }, () =>
          new EnvironmentRegistry(paths).update(async (file) => {
            active++;
            maxActive = Math.max(maxActive, active);
            const entry = file.environments[0];
            const value = entry.lastBuildNumber ?? 0;
            await new Promise((resolve) => setTimeout(resolve, 150));
            entry.lastBuildNumber = value + 1;
            active--;
          }),
        ),
      );
    } finally {
      rm.mockRestore();
    }
    expect(delayed).toBe(true);
    expect(maxActive).toBe(1);
    await expect(new EnvironmentRegistry(paths).get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 2 });
    expect(fs.readdirSync(root).filter((name) => name.includes('lock'))).toEqual([]);
  });

  it('removes a stale takeover guard of a process that crashed while it removed a stale lock', async () => {
    const old = new Date(Date.now() - 60_000);
    for (const dir of [paths.registryLock, `${paths.registryLock}.takeover`]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.utimesSync(dir, old, old);
    }
    await new EnvironmentRegistry(paths).add(environment(ID_A, 'o/a'));
    await expect(new EnvironmentRegistry(paths).list()).resolves.toHaveLength(1);
    expect(fs.readdirSync(root).filter((name) => name.includes('lock'))).toEqual([]);
  });

  it('does not remove a stale lock while another waiter holds the takeover guard', async () => {
    fs.mkdirSync(paths.registryLock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(paths.registryLock, old, old);
    fs.mkdirSync(`${paths.registryLock}.takeover`);
    const registry = new EnvironmentRegistry(paths, undefined, { lockTimeoutMs: 200 });
    await expect(registry.add(environment(ID_A, 'o/a'))).rejects.toThrow(/Timeout/);
    expect(fs.existsSync(paths.registryLock)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retries a lock folder that cannot be created for a moment, and reports a lasting error as it is',
    async () => {
      const registry = new EnvironmentRegistry(paths);
      fs.chmodSync(root, 0o555);
      try {
        const lasting = await registry.add(environment(ID_A, 'o/a')).catch((error: unknown) => error);
        expect(lasting).toMatchObject({ code: 'EACCES' });
        const added = registry.add(environment(ID_A, 'o/a'));
        await new Promise((resolve) => setTimeout(resolve, 100));
        fs.chmodSync(root, 0o755);
        await added;
      } finally {
        fs.chmodSync(root, 0o755);
      }
      await expect(registry.list()).resolves.toHaveLength(1);
    },
  );

  it('waits for a fresh lock and times out', async () => {
    fs.mkdirSync(paths.registryLock, { recursive: true });
    const registry = new EnvironmentRegistry(paths, undefined, { lockStaleMs: 60_000, lockTimeoutMs: 200 });
    await expect(registry.add(environment(ID_A, 'o/a'))).rejects.toThrow(/Timeout/);
    await expect(registry.exists()).resolves.toBe(false);
  });

  it('keeps its lock fresh while a slow mutator runs, so no other writer takes it for stale', async () => {
    const options = { lockStaleMs: 150, lockTimeoutMs: 5_000 };
    const first = new EnvironmentRegistry(paths, undefined, options);
    const second = new EnvironmentRegistry(paths, undefined, options);
    await first.add(environment(ID_A, 'o/a', { lastBuildNumber: 0 }));
    const order: string[] = [];
    const slow = first.update(async (file) => {
      order.push('slow start');
      const value = file.environments[0].lastBuildNumber ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 600));
      file.environments[0].lastBuildNumber = value + 1;
      order.push('slow end');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fast = second.update((file) => {
      order.push('fast');
      file.environments[0].lastBuildNumber = (file.environments[0].lastBuildNumber ?? 0) + 10;
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow start', 'slow end', 'fast']);
    await expect(first.get(ID_A)).resolves.toMatchObject({ lastBuildNumber: 11 });
  });

  it('lets a reader without the lock see complete content during many writes', async () => {
    const registry = new EnvironmentRegistry(paths);
    await registry.add(environment(ID_A, 'o/a', { lastBuildNumber: 0 }));
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 30; i++) {
        await registry.updateEnvironment(ID_A, (entry) => {
          entry.lastBuildNumber = i + 1;
          entry.additionalVolumes = Array.from({ length: 50 }, (_, n) => `volume-${i}-${n}`);
        });
      }
      writing = false;
    })();
    const reader = new EnvironmentRegistry(paths);
    let reads = 0;
    while (writing) {
      const list = await reader.list();
      expect(list).toHaveLength(1);
      reads++;
    }
    await writer;
    expect(reads).toBeGreaterThan(0);
  });
});

describe('EnvironmentRegistry across processes', () => {
  it('applies every change of several processes', async () => {
    const script = path.join(root, 'worker.js');
    const entry = path.join(root, 'worker-entry.ts');
    fs.writeFileSync(
      entry,
      [
        `import { StoragePaths } from ${JSON.stringify(path.join(__dirname, 'paths'))};`,
        `import { EnvironmentRegistry } from ${JSON.stringify(path.join(__dirname, 'registry'))};`,
        'const [storage, id, count] = process.argv.slice(2);',
        'const registry = new EnvironmentRegistry(new StoragePaths(storage));',
        'Promise.all(Array.from({ length: Number(count) }, () => registry.updateEnvironment(id, (e) => {',
        '  e.lastBuildNumber = (e.lastBuildNumber ?? 0) + 1;',
        '}))).catch((error) => { console.error(error); process.exitCode = 1; });',
      ].join('\n'),
    );
    buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: script, logLevel: 'silent' });

    const storage = path.join(root, 'storage');
    const storagePaths = new StoragePaths(storage);
    await new EnvironmentRegistry(storagePaths).add(environment(ID_A, 'o/a', { lastBuildNumber: 0 }));

    const processes = 4;
    const perProcess = 10;
    const exitCodes = await Promise.all(
      Array.from(
        { length: processes },
        () =>
          new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [script, storage, ID_A, String(perProcess)], { stdio: 'inherit' });
            child.on('error', reject);
            child.on('exit', resolve);
          }),
      ),
    );
    expect(exitCodes).toEqual(Array.from({ length: processes }, () => 0));
    const result: RegistryFile = await new EnvironmentRegistry(storagePaths).read();
    expect(result.environments[0].lastBuildNumber).toBe(processes * perProcess);
  }, 60_000);
});
