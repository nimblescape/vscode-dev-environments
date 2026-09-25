// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortError, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { DockerCredentialStore, withGitHubPackagesFallback } from './credentials';

interface Call {
  file: string;
  args: readonly string[];
  options?: RunOptions;
}

function fakeRunner(respond: (call: Call) => Partial<RunResult> | Error): ProcessRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(file, args, options) {
      const call = { file, args, options };
      calls.push(call);
      const answer = respond(call);
      if (answer instanceof Error) throw answer;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...answer };
    },
  };
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('DockerCredentialStore', () => {
  let home: string;
  let dockerDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
    dockerDir = path.join(home, '.docker');
    fs.mkdirSync(dockerDir);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(config: unknown, folder = dockerDir): void {
    fs.writeFileSync(path.join(folder, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }

  function store(
    runner: ProcessRunner = fakeRunner(() => new Error('not expected')),
    options: Partial<ConstructorParameters<typeof DockerCredentialStore>[1]> = {},
  ): DockerCredentialStore {
    return new DockerCredentialStore(runner, {
      env: {},
      platform: 'linux',
      homeDir: home,
      findExecutable: (name) => `/usr/local/bin/${name}`,
      ...options,
    });
  }

  it('reads an auth entry (base64 user:password)', async () => {
    writeConfig({ auths: { 'ghcr.io': { auth: base64('octocat:pa:ss') } } });
    expect(await store().get('ghcr.io')).toEqual({ username: 'octocat', password: 'pa:ss' });
  });

  it('reads username and password fields', async () => {
    writeConfig({ auths: { 'registry.example.com': { username: 'u', password: 'p' } } });
    expect(await store().get('registry.example.com')).toEqual({ username: 'u', password: 'p' });
  });

  it('finds an entry that is stored with a scheme', async () => {
    writeConfig({ auths: { 'https://ghcr.io': { auth: base64('a:b') } } });
    expect(await store().get('ghcr.io')).toEqual({ username: 'a', password: 'b' });
  });

  it('looks up Docker Hub under https://index.docker.io/v1/', async () => {
    writeConfig({ auths: { 'https://index.docker.io/v1/': { auth: base64('hub:secret') } } });
    expect(await store().get('registry-1.docker.io')).toEqual({ username: 'hub', password: 'secret' });
  });

  it('also finds Docker Hub under index.docker.io and docker.io', async () => {
    writeConfig({ auths: { 'docker.io': { auth: base64('hub:secret') } } });
    expect(await store().get('registry-1.docker.io')).toEqual({ username: 'hub', password: 'secret' });
    writeConfig({ auths: { 'index.docker.io': { auth: base64('hub2:secret') } } });
    expect(await store().get('registry-1.docker.io')).toEqual({ username: 'hub2', password: 'secret' });
  });

  it('does not use credentials of another registry', async () => {
    writeConfig({ auths: { 'ghcr.io': { auth: base64('a:b') } } });
    expect(await store().get('registry-1.docker.io')).toBeUndefined();
    expect(await store().get('ghcr.io.evil.example')).toBeUndefined();
  });

  it('ignores identity tokens', async () => {
    writeConfig({ auths: { 'myregistry.azurecr.io': { auth: base64('<token>:x'), identitytoken: 'refresh' } } });
    expect(await store().get('myregistry.azurecr.io')).toBeUndefined();
  });

  it('calls credHelpers[server] with the server on standard input', async () => {
    writeConfig({ credHelpers: { 'gcr.io': 'gcloud' }, credsStore: 'desktop' });
    const runner = fakeRunner(() => ({ stdout: JSON.stringify({ ServerURL: 'gcr.io', Username: 'oauth2', Secret: 's3' }) }));
    const env = { PATH: '/usr/bin' };
    const signal = new AbortController().signal;
    const result = await store(runner, { env }).get('gcr.io', signal);
    expect(result).toEqual({ username: 'oauth2', password: 's3' });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].file).toBe('/usr/local/bin/docker-credential-gcloud');
    expect(runner.calls[0].args).toEqual(['get']);
    expect(runner.calls[0].options?.input).toBe('gcr.io');
    expect(runner.calls[0].options?.env).toBe(env);
    expect(runner.calls[0].options?.signal).toBe(signal);
    expect(runner.calls[0].options?.timeoutMs).toBeGreaterThan(0);
  });

  it('uses credsStore for Docker Hub with the index server name', async () => {
    writeConfig({ auths: { 'https://index.docker.io/v1/': {} }, credsStore: 'desktop' });
    const runner = fakeRunner(() => ({ stdout: JSON.stringify({ Username: 'hub', Secret: 'pw' }) }));
    expect(await store(runner).get('registry-1.docker.io')).toEqual({ username: 'hub', password: 'pw' });
    expect(runner.calls[0].file).toBe('/usr/local/bin/docker-credential-desktop');
    expect(runner.calls[0].options?.input).toBe('https://index.docker.io/v1/');
  });

  it('tries the spelling of the auths key when the helper does not know the host name', async () => {
    writeConfig({ auths: { 'https://ghcr.io': {} }, credsStore: 'osxkeychain' });
    const runner = fakeRunner((call) =>
      call.options?.input === 'https://ghcr.io'
        ? { stdout: JSON.stringify({ Username: 'u', Secret: 'p' }) }
        : { exitCode: 1, stdout: 'credentials not found in native keychain' },
    );
    expect(await store(runner).get('ghcr.io')).toEqual({ username: 'u', password: 'p' });
    expect(runner.calls.map((call) => call.options?.input)).toEqual(['ghcr.io', 'https://ghcr.io']);
  });

  it('returns undefined when the helper has no credentials', async () => {
    writeConfig({ credsStore: 'desktop' });
    const runner = fakeRunner(() => ({ exitCode: 1, stdout: 'credentials not found in native keychain' }));
    expect(await store(runner).get('ghcr.io')).toBeUndefined();
  });

  it('ignores identity tokens of a helper', async () => {
    writeConfig({ credsStore: 'desktop' });
    const runner = fakeRunner(() => ({ stdout: JSON.stringify({ Username: '<token>', Secret: 'refresh' }) }));
    expect(await store(runner).get('myregistry.azurecr.io')).toBeUndefined();
  });

  it('falls back to an auth entry when the helper program is missing', async () => {
    writeConfig({ auths: { 'ghcr.io': { auth: base64('a:b') } }, credsStore: 'missing' });
    const runner = fakeRunner(() => new Error('not expected'));
    expect(await store(runner, { findExecutable: () => undefined }).get('ghcr.io')).toEqual({ username: 'a', password: 'b' });
    expect(runner.calls).toHaveLength(0);
  });

  it('does not throw when the helper fails or returns invalid output', async () => {
    writeConfig({ credsStore: 'desktop' });
    expect(await store(fakeRunner(() => new Error('spawn failed'))).get('ghcr.io')).toBeUndefined();
    expect(await store(fakeRunner(() => ({ stdout: 'not json' }))).get('ghcr.io')).toBeUndefined();
    expect(await store(fakeRunner(() => abortError())).get('ghcr.io')).toBeUndefined();
  });

  it('rejects helper names that are not plain names', async () => {
    writeConfig({ credsStore: '../../bin/evil' });
    const runner = fakeRunner(() => ({ stdout: JSON.stringify({ Username: 'u', Secret: 'p' }) }));
    expect(await store(runner).get('ghcr.io')).toBeUndefined();
    expect(runner.calls).toHaveLength(0);
  });

  it('reads the folder of DOCKER_CONFIG', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
    try {
      writeConfig({ auths: { 'ghcr.io': { auth: base64('from:env') } } }, other);
      writeConfig({ auths: { 'ghcr.io': { auth: base64('from:home') } } });
      expect(await store(undefined, { env: { DOCKER_CONFIG: other } }).get('ghcr.io')).toEqual({ username: 'from', password: 'env' });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('reads DOCKER_CONFIG case-insensitively on Windows', () => {
    const windows = store(undefined, { env: { Docker_Config: path.join(home, 'x') }, platform: 'win32' });
    expect(windows.configFile()).toBe(path.join(home, 'x', 'config.json'));
    const linux = store(undefined, { env: { Docker_Config: path.join(home, 'x') }, platform: 'linux' });
    expect(linux.configFile()).toBe(path.join(home, '.docker', 'config.json'));
  });

  it('returns undefined without a config file or with invalid JSON', async () => {
    expect(await store().get('ghcr.io')).toBeUndefined();
    writeConfig('{ invalid');
    expect(await store().get('ghcr.io')).toBeUndefined();
    writeConfig('[]');
    expect(await store().get('ghcr.io')).toBeUndefined();
  });

  it('works as a CredentialsProvider', async () => {
    writeConfig({ auths: { 'ghcr.io': { auth: base64('a:b') } } });
    expect(await store().provider()('ghcr.io')).toEqual({ username: 'a', password: 'b' });
  });
});

describe('withGitHubPackagesFallback', () => {
  it('uses the GitHub session for ghcr.io without a dialog when Docker has no credentials', async () => {
    const github = { getPackagesCredentials: vi.fn(async () => ({ username: 'octocat', password: 'gho_x' })) };
    const provider = withGitHubPackagesFallback(async () => undefined, github);
    expect(await provider('ghcr.io')).toEqual({ username: 'octocat', password: 'gho_x' });
    expect(github.getPackagesCredentials).toHaveBeenCalledWith({ interactive: false });
  });

  it('prefers the Docker credentials and never asks GitHub for other registries', async () => {
    const github = { getPackagesCredentials: vi.fn(async () => ({ username: 'octocat', password: 'gho_x' })) };
    const docker = { username: 'docker', password: 'pw' };
    expect(await withGitHubPackagesFallback(async () => docker, github)('ghcr.io')).toBe(docker);
    expect(await withGitHubPackagesFallback(async () => undefined, github)('registry-1.docker.io')).toBeUndefined();
    expect(github.getPackagesCredentials).not.toHaveBeenCalled();
  });

  it('returns undefined when the GitHub session fails', async () => {
    const github = { getPackagesCredentials: vi.fn(async () => Promise.reject(new Error('no session'))) };
    expect(await withGitHubPackagesFallback(async () => undefined, github)('ghcr.io')).toBeUndefined();
  });
});
