// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #110 (plan step 11E3b), reviewer B: the probes of the mutation testing of workerServiceDeps, the
// one queue of registry logins that the pulls of the pipeline and the image check share (review round 1 of PR #109,
// A-H1). No network: the registry client of the image check is recorded (vi.mock) and its credentials provider is called
// directly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import type { CredentialsProvider } from '../imageCheck/registryClient';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { workerServiceDeps } from './workerServices';

// The credentials provider that each RegistryClient gets (the real class, recorded).
const providers = vi.hoisted(() => [] as unknown[]);
vi.mock('../imageCheck/registryClient', async (importOriginal) => {
  const original = await importOriginal<typeof import('../imageCheck/registryClient')>();
  class RegistryClient extends original.RegistryClient {
    constructor(...args: ConstructorParameters<typeof original.RegistryClient>) {
      super(...args);
      providers.push(args[1]);
    }
  }
  return { ...original, RegistryClient };
});

/** Lets the pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('workerServiceDeps: one queue of registry logins, review round 1 of PR #110 (B)', () => {
  afterEach(() => {
    providers.length = 0;
  });

  it('the image check asks for its login only after a pull has ended its turn, and the reverse', async () => {
    const events: string[] = [];
    let slot: string | undefined;
    const host = {
      secrets: {
        registry: async (registry: string) => {
          events.push(`ask ${registry}`);
          slot = `pw-${registry}`;
          return { username: 'octo', serveraddress: registry, password: slot };
        },
      },
    } as unknown as HostSide;
    let release: () => void = () => undefined;
    const all = workerServiceDeps({
      host,
      engine: {
        ...unusedEngine(),
        pull: async (reference) => {
          events.push(`pull ${reference} with ${slot}`);
          await new Promise<void>((resolve) => (release = resolve));
          events.push(`pulled ${reference}`);
        },
      },
      secretOf: (name) => (name === SECRET_REGISTRY ? slot : undefined),
      forgetSecret: (name) => {
        events.push(`forget ${name}`);
        slot = undefined;
      },
      logger: silentLogger,
      ownHelper: { image: { tag: 'devenv-helper:abc', id: `sha256:${'f'.repeat(64)}` }, socket: '/s.sock' },
      dockerHost: '',
      owner: { windowId: 'w', pid: 1 },
      environmentLock: async () => Promise.reject(new Error('no lock in this test')),
    });
    expect(providers).toHaveLength(1);
    const provider = providers[0] as CredentialsProvider;

    // A pull holds the login; the check waits for its turn.
    const pull = all.docker.pullImage('ghcr.io/o/i:1', { onOutput: () => {} });
    await settle();
    const check = provider('r.example');
    await settle();
    expect(events).toEqual(['ask ghcr.io', 'pull ghcr.io/o/i:1 with pw-ghcr.io']);
    release();
    await pull;
    expect(await check).toEqual({ username: 'octo', password: 'pw-r.example' });
    expect(events).toEqual(['ask ghcr.io', 'pull ghcr.io/o/i:1 with pw-ghcr.io', 'pulled ghcr.io/o/i:1', `forget ${SECRET_REGISTRY}`, 'ask r.example', `forget ${SECRET_REGISTRY}`]);

    // The check holds the login (its use is the provider itself, so a held turn is a pending ask); the pull waits.
    events.length = 0;
    let answer: () => void = () => undefined;
    (host.secrets as { registry: (registry: string) => Promise<unknown> }).registry = async (registry: string) => {
      events.push(`ask ${registry}`);
      await new Promise<void>((resolve) => (answer = resolve));
      slot = `pw-${registry}`;
      return { username: 'octo', serveraddress: registry, password: slot };
    };
    const second = provider('r.example');
    await settle();
    const nextPull = all.docker.pullImage('ghcr.io/o/i:2', { onOutput: () => {} });
    await settle();
    expect(events).toEqual(['ask r.example']);
    answer();
    await second;
    await settle();
    answer();
    await settle();
    release();
    await nextPull;
    expect(events).toEqual(['ask r.example', `forget ${SECRET_REGISTRY}`, 'ask ghcr.io', 'pull ghcr.io/o/i:2 with pw-ghcr.io', 'pulled ghcr.io/o/i:2', `forget ${SECRET_REGISTRY}`]);
  });
});
