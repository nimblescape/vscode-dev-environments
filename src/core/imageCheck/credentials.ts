// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Registry credentials that Docker uses (concept 7.7 "Registry requires a sign-in", concept section 9,
// implementation notes 9): `~/.docker/config.json` with `auths`, `credsStore`, and `credHelpers`.
// Credentials are read only for the registry of an image, and never stored.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import { isAbortError, silentLogger, type Credentials, type GitHubAuth, type Logger, type ProcessRunner } from '../ports';
import { credentialServerName, isDockerHub, registryDisplayName } from './reference';
import type { CredentialsProvider } from './registryClient';

interface AuthEntry {
  auth?: unknown;
  username?: unknown;
  password?: unknown;
  identitytoken?: unknown;
}

interface DockerConfigFile {
  auths?: Record<string, AuthEntry>;
  credsStore?: unknown;
  credHelpers?: Record<string, unknown>;
}

export interface DockerCredentialStoreOptions {
  /** Environment for the credential helpers. Also the source of `DOCKER_CONFIG`. */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  /** Finds a program, for example `docker-credential-desktop` (with `.exe` on Windows). */
  findExecutable: (name: string) => string | undefined;
  logger?: Logger;
  /** Time limit for one credential helper call. Default: 10 seconds. */
  helperTimeoutMs?: number;
}

/** Identity tokens (OAuth refresh tokens of `docker login`) have this user name. They are not used. */
const IDENTITY_TOKEN_USER = '<token>';
const HELPER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_HELPER_CALLS = 3;

/** Reads the registry credentials that Docker has stored (`docker login`). */
export class DockerCredentialStore {
  private readonly logger: Logger;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: DockerCredentialStoreOptions,
  ) {
    this.logger = options.logger ?? silentLogger;
  }

  /** Path of the Docker configuration file: `$DOCKER_CONFIG/config.json`, or `~/.docker/config.json`. */
  configFile(): string {
    const folder = envValue(this.options.env, 'DOCKER_CONFIG', this.options.platform);
    return path.join(folder ? path.resolve(folder) : path.join(this.options.homeDir, '.docker'), 'config.json');
  }

  /**
   * Credentials for a registry host (`registry-1.docker.io` is looked up as `https://index.docker.io/v1/`).
   * Order as in the Docker CLI: `credHelpers[server]`, then `credsStore`, then an `auth` entry in `auths`.
   * Returns `undefined` if there are none, for identity tokens, on errors, and when `signal` aborts. Never throws.
   */
  async get(registry: string, signal?: AbortSignal): Promise<Credentials | undefined> {
    try {
      return await this.lookup(registry, signal);
    } catch (error) {
      if (!isAbortError(error)) {
        this.logger.warn(`Registry credentials for ${registryDisplayName(registry)} could not be read: ${errorMessage(error)}`);
      }
      return undefined;
    }
  }

  /** The store as a `CredentialsProvider` for the RegistryClient. */
  provider(): CredentialsProvider {
    return (registry, signal) => this.get(registry, signal);
  }

  private async lookup(registry: string, signal: AbortSignal | undefined): Promise<Credentials | undefined> {
    const config = await this.readConfig();
    if (!config) return undefined;

    const server = credentialServerName(registry);
    const hosts = registryHosts(registry);
    const auths = isRecord(config.auths) ? config.auths : {};
    // Exact server name first, then other spellings of the same host (for example `https://ghcr.io`).
    const authKeys = [
      ...(Object.prototype.hasOwnProperty.call(auths, server) ? [server] : []),
      ...Object.keys(auths).filter((key) => key !== server && hosts.has(serverHost(key))),
    ];

    const helper = this.helperFor(config, server, hosts);
    if (helper) {
      const servers = unique([server, ...authKeys]).slice(0, MAX_HELPER_CALLS);
      for (const candidate of servers) {
        const credentials = await this.fromHelper(helper, candidate, signal);
        if (credentials) return credentials;
      }
    }
    for (const key of authKeys) {
      const credentials = fromAuthEntry(auths[key]);
      if (credentials) return credentials;
    }
    return undefined;
  }

  private helperFor(config: DockerConfigFile, server: string, hosts: Set<string>): string | undefined {
    const helpers = isRecord(config.credHelpers) ? config.credHelpers : {};
    const exact = helpers[server];
    if (typeof exact === 'string' && exact !== '') return exact;
    for (const [key, value] of Object.entries(helpers)) {
      if (typeof value === 'string' && value !== '' && hosts.has(serverHost(key))) return value;
    }
    return typeof config.credsStore === 'string' && config.credsStore !== '' ? config.credsStore : undefined;
  }

  private async readConfig(): Promise<DockerConfigFile | undefined> {
    const file = this.configFile();
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      return isRecord(parsed) ? (parsed as DockerConfigFile) : undefined;
    } catch {
      this.logger.warn(`The Docker configuration file ${file} is not valid JSON.`);
      return undefined;
    }
  }

  /** `docker-credential-<helper> get` with the server name on standard input. */
  private async fromHelper(helper: string, server: string, signal: AbortSignal | undefined): Promise<Credentials | undefined> {
    if (!HELPER_NAME.test(helper)) {
      this.logger.warn(`Ignoring the Docker credential helper name "${helper}".`);
      return undefined;
    }
    const program = this.options.findExecutable(`docker-credential-${helper}`);
    if (!program) {
      this.logger.warn(`The Docker credential helper docker-credential-${helper} was not found.`);
      return undefined;
    }
    const result = await this.runner.run(program, ['get'], {
      input: server,
      env: this.options.env,
      signal,
      timeoutMs: this.options.helperTimeoutMs ?? 10_000,
    });
    // A non-zero exit code normally means "credentials not found".
    if (result.exitCode !== 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      this.logger.warn(`The Docker credential helper docker-credential-${helper} returned invalid output.`);
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    return credentials(parsed.Username, parsed.Secret);
  }
}

/**
 * Adds the GitHub session (scope `read:packages`) as fallback for ghcr.io (concept 7.7, implementation notes 9).
 * The session is only requested without a dialog, and only when the registry asks for credentials.
 */
export function withGitHubPackagesFallback(
  primary: CredentialsProvider,
  github: Pick<GitHubAuth, 'getPackagesCredentials'>,
): CredentialsProvider {
  return async (registry, signal) => {
    const found = await primary(registry, signal);
    if (found || registry.toLowerCase() !== 'ghcr.io' || signal?.aborted) return found;
    try {
      return await github.getPackagesCredentials({ interactive: false });
    } catch {
      return undefined;
    }
  };
}

function fromAuthEntry(entry: AuthEntry | undefined): Credentials | undefined {
  if (!isRecord(entry)) return undefined;
  if (typeof entry.auth === 'string' && entry.auth !== '') {
    const decoded = Buffer.from(entry.auth, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon > 0) return credentials(decoded.slice(0, colon), decoded.slice(colon + 1));
  }
  return credentials(entry.username, entry.password);
}

function credentials(username: unknown, password: unknown): Credentials | undefined {
  if (typeof username !== 'string' || typeof password !== 'string') return undefined;
  if (username === '' || password === '' || username === IDENTITY_TOKEN_USER) return undefined;
  return { username, password };
}

/** Host names under which Docker may have stored the credentials of a registry. */
function registryHosts(registry: string): Set<string> {
  if (isDockerHub(registry)) return new Set(['index.docker.io', 'docker.io', 'registry-1.docker.io']);
  return new Set([registry.toLowerCase()]);
}

/** `https://index.docker.io/v1/` → `index.docker.io`, `ghcr.io` → `ghcr.io`. */
function serverHost(server: string): string {
  const withoutScheme = server.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  const slash = withoutScheme.indexOf('/');
  return (slash < 0 ? withoutScheme : withoutScheme.slice(0, slash)).toLowerCase();
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[name];
  if (direct !== undefined || platform !== 'win32') return direct || undefined;
  // Environment variable names are case-insensitive on Windows, also in a copied environment object.
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return (key && env[key]) || undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
