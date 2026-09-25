// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { Credentials } from '../ports';
import { githubPackagesPullCredentials } from './pullCredentials';

const SESSION: Credentials = { username: 'octocat', password: 'gho_packages' };

function setup(options: { docker?: Credentials; session?: Credentials; sessionError?: Error } = {}) {
  const dockerCalls: string[] = [];
  const sessionCalls: boolean[] = [];
  const provider = githubPackagesPullCredentials(
    async (registry) => {
      dockerCalls.push(registry);
      return options.docker;
    },
    {
      getPackagesCredentials: async ({ interactive }) => {
        sessionCalls.push(interactive);
        if (options.sessionError) throw options.sessionError;
        return options.session;
      },
    },
  );
  return { provider, dockerCalls, sessionCalls };
}

describe('githubPackagesPullCredentials', () => {
  it('gives the GitHub session for an image on ghcr.io when Docker has no credentials, without a dialog', async () => {
    const { provider, dockerCalls, sessionCalls } = setup({ session: SESSION });
    expect(await provider('ghcr.io/acme/private-base:latest')).toEqual({ registry: 'ghcr.io', ...SESSION });
    expect(await provider('GHCR.IO/acme/private-base')).toEqual({ registry: 'ghcr.io', ...SESSION });
    expect(dockerCalls).toEqual(['ghcr.io', 'ghcr.io']);
    expect(sessionCalls).toEqual([false, false]);
  });

  it('gives nothing when Docker has its own credentials for ghcr.io', async () => {
    const { provider, sessionCalls } = setup({ docker: { username: 'me', password: 'pat' }, session: SESSION });
    expect(await provider('ghcr.io/acme/private-base:latest')).toBeUndefined();
    expect(sessionCalls).toEqual([]);
  });

  it('gives nothing for other registries, invalid references, and without a session', async () => {
    const { provider, dockerCalls } = setup({ session: SESSION });
    expect(await provider('mcr.microsoft.com/devcontainers/base:ubuntu')).toBeUndefined();
    expect(await provider('ubuntu:24.04')).toBeUndefined();
    expect(await provider('ghcr.io/acme/${VARIANT}')).toBeUndefined();
    expect(dockerCalls).toEqual([]);
    expect(await setup().provider('ghcr.io/acme/private-base')).toBeUndefined();
  });

  it('gives nothing when the session fails or the signal aborted', async () => {
    expect(await setup({ sessionError: new Error('no network') }).provider('ghcr.io/acme/x')).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    const { provider, dockerCalls } = setup({ session: SESSION });
    expect(await provider('ghcr.io/acme/x', controller.signal)).toBeUndefined();
    expect(dockerCalls).toEqual([]);
  });
});
