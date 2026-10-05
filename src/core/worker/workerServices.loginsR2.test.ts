// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #109 (plan step 11E3a), reviewer B: the probes of the mutation testing of registryLogins,
// hostRegistryCredentials and the default logins of workerImageChecker. No network: the registry client of the image
// check is recorded (vi.mock) and its credentials provider is called directly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { hostRegistryCredentials, registryLogins, workerImageChecker } from './workerServices';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import type { CredentialsProvider } from '../imageCheck/registryClient';

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

function hostOf(registry: (name: string) => Promise<unknown>): { host: HostSide; asked: string[] } {
  const asked: string[] = [];
  return { asked, host: { secrets: { registry: (name: string) => (asked.push(name), registry(name)) } } as unknown as HostSide };
}

describe('registryLogins and hostRegistryCredentials, review round 2 of PR #109 (B)', () => {
  afterEach(() => {
    providers.length = 0;
  });

  it('the secret is forgotten when `use` has ended, not before; the next login waits for that end', async () => {
    const { host, asked } = hostOf(async () => ({ username: 'octo', serveraddress: 'ghcr.io', password: 'p1' }));
    let forgotten = 0;
    const logins = registryLogins(host, () => void forgotten++, silentLogger);
    let finish: () => void = () => undefined;
    const during: number[] = [];
    const first = logins('a.example', async (login) => {
      during.push(forgotten);
      await new Promise<void>((resolve) => (finish = resolve));
      during.push(forgotten);
      return login?.password;
    });
    const second = logins('b.example', async (login) => login?.password);
    await settle();
    expect(during).toEqual([0]);
    expect(forgotten).toBe(0);
    expect(asked).toEqual(['a.example']);
    finish();
    expect(await first).toBe('p1');
    expect(during).toEqual([0, 0]);
    expect(await second).toBe('p1');
    expect(asked).toEqual(['a.example', 'b.example']);
    expect(forgotten).toBe(2);
  });

  it('a failed request: `use` still runs, without a login, its value is the answer, and the failure is logged', async () => {
    const warnings: string[] = [];
    const { host } = hostOf(async () => Promise.reject(new Error('channel closed')));
    let forgotten = 0;
    const logins = registryLogins(host, () => void forgotten++, { ...silentLogger, warn: (text: string) => void warnings.push(text) });
    const seen: unknown[] = [];
    expect(await logins('ghcr.io', async (login) => (seen.push(login), 'went on'))).toBe('went on');
    expect(seen).toEqual([undefined]);
    expect(forgotten).toBe(1);
    expect(warnings).toEqual(['The login of ghcr.io could not be asked: channel closed']);
  });

  it('hostRegistryCredentials never throws, also when the forget fails; the next login is still asked', async () => {
    const { host, asked } = hostOf(async () => ({ username: 'octo', serveraddress: 'ghcr.io', password: 'p1' }));
    const provider = hostRegistryCredentials(
      registryLogins(
        host,
        () => {
          throw new Error('forget failed');
        },
        silentLogger,
      ),
    );
    await expect(provider('ghcr.io')).resolves.toBeUndefined();
    await expect(provider('ghcr.io')).resolves.toBeUndefined();
    expect(asked).toEqual(['ghcr.io', 'ghcr.io']);
  });

  it('only `identityToken: true` makes the user IDENTITY_TOKEN_USER; `false` keeps the user name', async () => {
    const { host } = hostOf(async () => ({ username: 'octo', identityToken: false, serveraddress: 'ghcr.io', password: 'p1' }));
    const provider = hostRegistryCredentials(registryLogins(host, () => undefined, silentLogger));
    expect(await provider('ghcr.io')).toEqual({ username: 'octo', password: 'p1' });
  });

  it("the default logins of workerImageChecker log a failed request in the worker's log and forget the registry secret", async () => {
    const events: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (text: string) => void events.push(`warn ${text}`) };
    const { host } = hostOf(async () => Promise.reject(new Error('channel closed')));
    workerImageChecker({ host, engine: unusedEngine(), forgetSecret: (name) => void events.push(`forget ${name}`), logger });
    expect(providers).toHaveLength(1);
    expect(await (providers[0] as CredentialsProvider)('ghcr.io')).toBeUndefined();
    expect(events).toEqual(['warn The login of ghcr.io could not be asked: channel closed', `forget ${SECRET_REGISTRY}`]);
  });
});
