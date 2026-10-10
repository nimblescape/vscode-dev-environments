// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Digest requests to image registries (concept 7.7, implementation notes 9), as defined by the
// OCI Distribution Specification, with the token authentication of the Docker registry API. Cleanup C5 (plan step 11J,
// C1; the user's decision of 2026-10-10): also the tag lists of the image maintenance of the Session Monitor
// (listTags), so that the monitor reads them over the transport of its caller (the proxy of the daemon) with the same
// challenge, token and redirect handling as the worker's image check.
import * as crypto from 'crypto';
import { errorMessage } from '../errors';
import type { HttpRequest, HttpResponse, HttpTransport } from '../http';
import { abortError, isAbortError, silentLogger, type Credentials, type Logger } from '../ports';
import { isDockerHub, registryDisplayName, type ImageReference } from './reference';

/** Common time limit of all requests of one image check (NFR-08), and of the check of the base image of the helper. */
export const IMAGE_CHECK_TIMEOUT_MS = 5000;

/** Manifest types in the `Accept` header: OCI index, Docker manifest list, Docker manifest v2, OCI manifest. */
export const MANIFEST_MEDIA_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
] as const;

export const MANIFEST_ACCEPT = MANIFEST_MEDIA_TYPES.join(', ');

const USER_AGENT = 'vscode-dev-environments';
/**
 * Default time limit for one credentials lookup (credential helper, GitHub session). It is shorter than the time limit
 * of the check (5 seconds), so that the registry can still be asked without credentials within the check.
 */
export const CREDENTIALS_TIMEOUT_MS = 2500;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DIGEST = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/;
/** A token of a token service: visible ASCII only (review round 1 of PR #141, A-L1). */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

export type DigestResult =
  | { kind: 'digest'; digest: string }
  /** DNS or connection failure, no answer in time (abort), or a server error (5xx). */
  | { kind: 'unreachable'; registry: string; error: string }
  /** 401/403 also with credentials, or no credentials for a private image. */
  | { kind: 'authRequired'; registry: string }
  /** 404. */
  | { kind: 'notFound'; registry: string }
  /** Anything else. */
  | { kind: 'error'; registry: string; error: string };

/**
 * Registry credentials for a registry host, or `undefined` if there are none. Must not throw.
 * `signal` aborts when the check ends or the lookup takes too long; a credential helper call must end when it aborts.
 */
export type CredentialsProvider = (registry: string, signal?: AbortSignal) => Promise<Credentials | undefined>;

/** One challenge of a `WWW-Authenticate` header. `scheme` is lower case, parameter names are lower case. */
export interface AuthChallenge {
  scheme: string;
  params: Record<string, string>;
  token68?: string;
}

/**
 * Parses a `WWW-Authenticate` header (RFC 7235), also with several challenges in one header, and quoted values
 * that contain commas, for example `Bearer realm="https://auth.example/token",scope="repository:a/b:pull,push"`.
 */
export function parseWwwAuthenticate(header: string): AuthChallenge[] {
  const challenges: AuthChallenge[] = [];
  const tokenChar = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;
  let i = 0;
  const length = header.length;
  const skip = (pattern: RegExp) => {
    while (i < length && pattern.test(header[i])) i++;
  };
  const readToken = () => {
    const start = i;
    while (i < length && tokenChar.test(header[i])) i++;
    return header.slice(start, i);
  };

  while (i < length) {
    skip(/[\s,]/);
    const scheme = readToken();
    if (!scheme) {
      i++;
      continue;
    }
    const challenge: AuthChallenge = { scheme: scheme.toLowerCase(), params: {} };
    challenges.push(challenge);
    skip(/[ \t]/);

    for (;;) {
      skip(/[\s,]/);
      const start = i;
      const name = readToken();
      if (!name) break;
      skip(/[ \t]/);
      if (header[i] !== '=') {
        // A token without '=' starts the next challenge.
        i = start;
        break;
      }
      i++;
      skip(/[ \t]/);
      if (Object.keys(challenge.params).length === 0 && challenge.token68 === undefined && (i >= length || header[i] === '=' || header[i] === ',')) {
        // token68, for example `Negotiate abc==`.
        while (i < length && header[i] === '=') i++;
        challenge.token68 = header.slice(start, i).trim();
        break;
      }
      let value = '';
      if (header[i] === '"') {
        i++;
        while (i < length && header[i] !== '"') {
          if (header[i] === '\\' && i + 1 < length) i++;
          value += header[i];
          i++;
        }
        i++;
      } else {
        const valueStart = i;
        while (i < length && header[i] !== ',' && !/\s/.test(header[i])) i++;
        value = header.slice(valueStart, i);
      }
      challenge.params[name.toLowerCase()] = value;
    }
  }
  return challenges;
}

/** Why a registry request gave no answer to use (every DigestResult but the digest). */
export type RegistryFailure = Exclude<DigestResult, { kind: 'digest' }>;

/** Cleanup C5 (plan step 11J, C1): the tags of a repository, or why they could not be read. */
export type TagListResult = { kind: 'tags'; tags: string[] } | RegistryFailure;

/** Cleanup C5 (plan step 11J, C1): at most this many pages of a tag list (as the monitor's own client read them). */
export const MAX_TAG_PAGES = 20;
/** Cleanup C5 (plan step 11J, C1): the longest page of a tag list that is read (as the monitor's own client). */
export const MAX_TAG_LIST_BYTES = 4 * 1024 * 1024;

/** The registry and the repository path of a request (a manifest, a tag list). */
type RepositoryRef = Pick<ImageReference, 'registry' | 'repository'>;

/** Thrown for a failed connection or a request without an answer in time. */
class TransportFailure extends Error {}

type AuthResult = { kind: 'ok'; authorization: string } | { kind: 'result'; result: RegistryFailure };
type TokenResult = { kind: 'token'; token: string } | { kind: 'denied'; status: number } | { kind: 'result'; result: RegistryFailure };

/** Client for the manifest digest of a tag (HEAD request). Talks HTTPS only. */
export class RegistryClient {
  /** Credentials per check (the signal of the check), so that one check calls a credential helper once per registry. */
  private readonly credentialCache = new WeakMap<AbortSignal, Map<string, Promise<Credentials | undefined>>>();

  private readonly credentialsTimeoutMs: number;
  private readonly onCredentialsRejected: ((registry: string, credentials: Credentials) => void) | undefined;

  /**
   * `onCredentialsRejected`: the token service of `registry` answered HTTP 401 for `credentials` (for ghcr.io with the
   * GitHub session: GitHub rejected its token).
   */
  constructor(
    private readonly transport: HttpTransport,
    private readonly credentials: CredentialsProvider,
    private readonly logger: Logger = silentLogger,
    options: { credentialsTimeoutMs?: number; onCredentialsRejected?: (registry: string, credentials: Credentials) => void } = {},
  ) {
    this.credentialsTimeoutMs = options.credentialsTimeoutMs ?? CREDENTIALS_TIMEOUT_MS;
    this.onCredentialsRejected = options.onCredentialsRejected;
  }

  /**
   * Current digest of the tag: `HEAD https://<registry>/v2/<repository>/manifests/<tag>` with the manifest types of
   * `MANIFEST_ACCEPT`. First without credentials; on 401 it follows the `WWW-Authenticate` challenge (Bearer: token
   * request, with Basic credentials if the provider has some; Basic: retry with Basic credentials). A 401 of another
   * host that the registry redirected to gives `authRequired` without credentials. The digest comes
   * from `Docker-Content-Digest`. If this header is missing, it reads the manifest with GET and computes its sha256,
   * except on Docker Hub, where a GET counts as a pull. A reference with a digest is returned without a request.
   * Never throws: an aborted signal gives `unreachable`.
   */
  async getDigest(reference: ImageReference, signal?: AbortSignal): Promise<DigestResult> {
    if (reference.digest) return { kind: 'digest', digest: reference.digest };
    try {
      return await this.resolve(reference, signal);
    } catch (error) {
      return failureOf(reference.registry, error);
    }
  }

  /**
   * Cleanup C5 (plan step 11J, C1; decision of 2026-10-10): the tags of `repository` at `registry`: `GET
   * https://<registry>/v2/<repository>/tags/list`, first without credentials; on 401 it follows the `WWW-Authenticate`
   * challenge as getDigest does (with the credentials of the provider, if it has some; a 401 of another host that the
   * registry redirected to gives `authRequired`), and keeps that authorization for the further pages. All pages (the
   * RFC 5988 `Link` with `rel="next"`, only on the same registry; at most MAX_TAG_PAGES, each at most
   * MAX_TAG_LIST_BYTES). Never throws: an aborted signal gives `unreachable`.
   */
  async listTags(registry: string, repository: string, signal?: AbortSignal): Promise<TagListResult> {
    try {
      return await this.tagPages({ registry, repository }, signal);
    } catch (error) {
      return failureOf(registry, error);
    }
  }

  private async tagPages(reference: RepositoryRef, signal: AbortSignal | undefined): Promise<TagListResult> {
    const registry = reference.registry;
    const base = `https://${registry}`;
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    // Review round 1 of PR #141 (B, defect 1): the origin as the URL parser writes it (host in lower case, without the
    // default port 443), so that a registry written as `Host:443` or in upper case pages on.
    const origin = new URL(base).origin;
    const tags: string[] = [];
    let url: string | undefined = `${base}/v2/${reference.repository}/tags/list`;
    for (let page = 0; url !== undefined && page < MAX_TAG_PAGES; page++) {
      const request: HttpRequest = { method: 'GET', url, headers, maxBodyBytes: MAX_TAG_LIST_BYTES };
      const first = await this.sendTracked(request, signal);
      let response = first.response;
      if (response.status === 401 && headers.Authorization === undefined) {
        if (first.url.host !== new URL(url).host) {
          this.logger.warn(
            `The registry ${registryDisplayName(registry)} redirected to ${first.url.host}, which asked for a sign-in. ` +
              'Registry credentials are not sent to another host.',
          );
          return { kind: 'authRequired', registry };
        }
        const auth = await this.authenticate(reference, response, signal);
        if (auth.kind === 'result') return auth.result;
        headers.Authorization = auth.authorization;
        response = await this.send({ ...request, headers }, signal);
      }
      if (response.status !== 200) return statusResult(registry, response.status);
      let body: unknown;
      try {
        body = JSON.parse(response.body);
      } catch {
        return { kind: 'error', registry, error: 'The registry sent an invalid tag list.' };
      }
      const listed = typeof body === 'object' && body !== null ? (body as { tags?: unknown }).tags : undefined;
      if (Array.isArray(listed)) for (const tag of listed) if (typeof tag === 'string') tags.push(tag);
      // The next page (RFC 5988 Link), only on the same registry.
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.link ?? '')?.[1];
      url = next === undefined ? undefined : new URL(next, base).origin === origin ? new URL(next, base).toString() : undefined;
    }
    if (url !== undefined) {
      // Review round 1 of PR #141 (B, defect 1): the list stays the partial one, and the log says so.
      this.logger.warn(
        `The tag list of ${reference.repository} at ${registryDisplayName(registry)} has more than ${MAX_TAG_PAGES} pages; only the first ${MAX_TAG_PAGES} were read.`,
      );
    }
    return { kind: 'tags', tags };
  }

  private async resolve(reference: ImageReference, signal: AbortSignal | undefined): Promise<DigestResult> {
    const url = `https://${reference.registry}/v2/${reference.repository}/manifests/${reference.tag}`;
    const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT, 'User-Agent': USER_AGENT };

    const first = await this.sendTracked({ method: 'HEAD', url, headers }, signal);
    let response = first.response;
    if (response.status === 401) {
      if (first.url.host !== new URL(url).host) {
        // Registry credentials are only for the registry of the image (concept section 9). Like Docker, the client
        // does not answer the sign-in request of a host that the registry redirected to.
        this.logger.warn(
          `The registry ${registryDisplayName(reference.registry)} redirected to ${first.url.host}, which asked for a sign-in. ` +
            'Registry credentials are not sent to another host.',
        );
        return { kind: 'authRequired', registry: reference.registry };
      }
      const auth = await this.authenticate(reference, response, signal);
      if (auth.kind === 'result') return auth.result;
      headers.Authorization = auth.authorization;
      response = await this.send({ method: 'HEAD', url, headers }, signal);
    }
    return this.interpret(reference, url, headers, response, signal);
  }

  private async interpret(
    reference: ImageReference,
    url: string,
    headers: Record<string, string>,
    response: HttpResponse,
    signal: AbortSignal | undefined,
  ): Promise<DigestResult> {
    const registry = reference.registry;
    // A registry without HEAD support (405) gets the GET fallback, too.
    const headUnsupported = response.status === 405;
    if (!headUnsupported && (response.status < 200 || response.status >= 300)) {
      // Assumption (V-9): a registry answers 401/403 for a private image without access. A registry that answers 404
      // instead gives `notFound`, and the reference then counts as unchanged.
      return statusResult(registry, response.status);
    }

    const digest = headUnsupported ? undefined : validDigest(response.headers['docker-content-digest']);
    if (digest) return { kind: 'digest', digest };
    if (isDockerHub(registry)) {
      // Docker Hub counts a GET of a manifest as a pull (concept 7.7), so there is no fallback here.
      return headUnsupported
        ? statusResult(registry, response.status)
        : { kind: 'error', registry, error: 'The registry did not return the digest of the image.' };
    }

    const get = await this.send({ method: 'GET', url, headers }, signal);
    if (get.status < 200 || get.status >= 300) return statusResult(registry, get.status);
    const getDigest = validDigest(get.headers['docker-content-digest']);
    if (getDigest) return { kind: 'digest', digest: getDigest };
    if (get.body === '') return { kind: 'error', registry, error: 'The registry returned an empty manifest.' };
    // Assumption (V-9): the manifest is UTF-8 JSON, so the sha256 of the UTF-8 text is the sha256 of the bytes the
    // registry sent, and it equals the digest that Docker records for this tag.
    return { kind: 'digest', digest: `sha256:${crypto.createHash('sha256').update(get.body, 'utf8').digest('hex')}` };
  }

  private async authenticate(
    reference: RepositoryRef,
    response: HttpResponse,
    signal: AbortSignal | undefined,
  ): Promise<AuthResult> {
    const registry = reference.registry;
    const challenges = parseWwwAuthenticate(response.headers['www-authenticate'] ?? '');
    const bearer = challenges.find((challenge) => challenge.scheme === 'bearer');
    if (bearer) return this.bearer(reference, bearer, signal);

    if (challenges.some((challenge) => challenge.scheme === 'basic')) {
      // The manifest URL is always HTTPS, so Basic credentials are sent over TLS only.
      const credentials = await this.credentialsFor(registry, signal);
      if (!credentials) return { kind: 'result', result: { kind: 'authRequired', registry } };
      return { kind: 'ok', authorization: `Basic ${basic(credentials)}` };
    }
    return { kind: 'result', result: { kind: 'authRequired', registry } };
  }

  private async bearer(reference: RepositoryRef, challenge: AuthChallenge, signal: AbortSignal | undefined): Promise<AuthResult> {
    const registry = reference.registry;
    let realm: URL;
    try {
      realm = new URL(challenge.params.realm ?? '');
    } catch {
      return { kind: 'result', result: { kind: 'error', registry, error: 'The registry sent an invalid authentication realm.' } };
    }
    if (realm.protocol !== 'https:') {
      // Credentials and tokens are never sent without TLS.
      return {
        kind: 'result',
        result: { kind: 'error', registry, error: `The registry requires an insecure token service (${realm.protocol}//${realm.host}).` },
      };
    }

    const tokenUrl = new URL(realm.toString());
    if (challenge.params.service) tokenUrl.searchParams.append('service', challenge.params.service);
    const scopes = (challenge.params.scope ?? `repository:${reference.repository}:pull`).split(' ').filter((scope) => scope !== '');
    for (const scope of scopes) tokenUrl.searchParams.append('scope', scope);

    const credentials = await this.credentialsFor(registry, signal);
    if (credentials) {
      const withCredentials = await this.requestToken(registry, tokenUrl, credentials, signal);
      if (withCredentials.kind === 'token') return { kind: 'ok', authorization: `Bearer ${withCredentials.token}` };
      if (withCredentials.kind === 'result') return withCredentials;
      if (withCredentials.status === 401) this.reportRejected(registry, credentials);
      // Rejected credentials (for example an expired password): a public image still works anonymously.
      this.logger.warn(`The stored credentials for ${registryDisplayName(registry)} were rejected. Trying without credentials.`);
    }
    const anonymous = await this.requestToken(registry, tokenUrl, undefined, signal);
    if (anonymous.kind === 'token') return { kind: 'ok', authorization: `Bearer ${anonymous.token}` };
    if (anonymous.kind === 'result') return anonymous;
    return { kind: 'result', result: { kind: 'authRequired', registry } };
  }

  private reportRejected(registry: string, credentials: Credentials): void {
    try {
      this.onCredentialsRejected?.(registry, credentials);
    } catch (error) {
      this.logger.warn(`The rejected credentials of ${registryDisplayName(registry)} could not be reported: ${errorMessage(error)}`);
    }
  }

  private async requestToken(
    registry: string,
    url: URL,
    credentials: Credentials | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TokenResult> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (credentials) headers.Authorization = `Basic ${basic(credentials)}`;
    // Review round 1 of PR #141 (A-L2): the token answer has the body limit of a tag list, as every answer of the
    // monitor's former client had (not the transport's 16 MiB).
    const response = await this.send({ method: 'GET', url: url.toString(), headers, maxBodyBytes: MAX_TAG_LIST_BYTES }, signal);
    if (response.status === 401 || response.status === 403) return { kind: 'denied', status: response.status };
    if (response.status !== 200) {
      const result = statusResult(registry, response.status);
      return { kind: 'result', result: result.kind === 'notFound' ? { kind: 'error', registry, error: 'The token service was not found (HTTP 404).' } : result };
    }
    let token: unknown;
    try {
      const body = JSON.parse(response.body) as { token?: unknown; access_token?: unknown };
      token = typeof body.token === 'string' && body.token !== '' ? body.token : body.access_token;
    } catch {
      token = undefined;
    }
    if (typeof token !== 'string' || token === '') {
      return { kind: 'result', result: { kind: 'error', registry, error: 'The token service returned no token.' } };
    }
    // Review round 1 of PR #141 (A-L1): a token goes into the Authorization header, so one with a character that is not
    // visible ASCII (CR, LF, a space, a control or non-ASCII character) is refused before any request carries it.
    if (!VISIBLE_ASCII.test(token)) {
      return { kind: 'result', result: { kind: 'error', registry, error: 'The token service returned an invalid token.' } };
    }
    return { kind: 'token', token };
  }

  /**
   * Credentials of the provider, once per registry and signal. The lookup has its own time limit: a credential helper
   * that waits for a prompt (keychain, GPG) or a slow GitHub session must not make a reachable registry count as
   * unreachable (concept 7.7). After the limit, the registry is asked without credentials.
   */
  private credentialsFor(registry: string, signal: AbortSignal | undefined): Promise<Credentials | undefined> {
    const load = async (): Promise<Credentials | undefined> => {
      const lookup = new AbortController();
      const onAbort = () => lookup.abort();
      if (signal?.aborted) lookup.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => lookup.abort(), this.credentialsTimeoutMs);
      try {
        return await raceAbort(this.credentials(registry, lookup.signal), lookup.signal);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        const name = registryDisplayName(registry);
        if (isAbortError(error)) {
          this.logger.warn(`Registry credentials for ${name} were not available in time. Trying without credentials.`);
        } else {
          this.logger.warn(`Registry credentials for ${name} could not be read: ${errorMessage(error)}`);
        }
        return undefined;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    };
    if (!signal) return load();
    let cache = this.credentialCache.get(signal);
    if (!cache) {
      cache = new Map();
      this.credentialCache.set(signal, cache);
    }
    let pending = cache.get(registry);
    if (!pending) {
      pending = load();
      cache.set(registry, pending);
    }
    return pending;
  }

  /** Sends a request over HTTPS and follows redirects. The Authorization header is not sent to another host. */
  private async send(request: HttpRequest, signal: AbortSignal | undefined): Promise<HttpResponse> {
    return (await this.sendTracked(request, signal)).response;
  }

  /** Like `send()`, and also returns the URL that gave the final response (after redirects). */
  private async sendTracked(request: HttpRequest, signal: AbortSignal | undefined): Promise<{ response: HttpResponse; url: URL }> {
    let current = request;
    for (let redirects = 0; ; redirects++) {
      const url = new URL(current.url);
      if (url.protocol !== 'https:') throw new Error(`The registry redirected to an insecure address (${url.protocol}//${url.host}).`);
      let response: HttpResponse;
      try {
        response = await raceAbort(this.transport.request(current, signal), signal);
      } catch (error) {
        throw new TransportFailure(isAbortError(error) ? 'No answer in time.' : errorMessage(error));
      }
      const location = response.headers.location;
      if (!REDIRECT_STATUS.has(response.status) || !location) return { response, url };
      if (redirects >= MAX_REDIRECTS) throw new Error('The registry sent too many redirects.');
      const next = new URL(location, url);
      const headers = { ...current.headers };
      if (next.host !== url.host) delete headers.Authorization;
      // Cleanup C5 (plan step 11J, C1): the body limit of the request (a tag list) stays for the redirected one.
      current = { ...current, url: next.toString(), headers };
    }
  }
}

/** The result of a request that threw: a transport failure or an abort is `unreachable`, anything else an `error`. */
function failureOf(registry: string, error: unknown): RegistryFailure {
  if (error instanceof TransportFailure) return { kind: 'unreachable', registry, error: error.message };
  if (isAbortError(error)) return { kind: 'unreachable', registry, error: 'No answer in time.' };
  return { kind: 'error', registry, error: errorMessage(error) };
}

function statusResult(registry: string, status: number): RegistryFailure {
  if (status === 401 || status === 403) return { kind: 'authRequired', registry };
  if (status === 404) return { kind: 'notFound', registry };
  if (status >= 500) return { kind: 'unreachable', registry, error: `The registry answered with HTTP ${status}.` };
  return { kind: 'error', registry, error: `The registry answered with HTTP ${status}.` };
}

function validDigest(value: string | undefined): string | undefined {
  const digest = value?.split(',')[0].trim().toLowerCase();
  return digest && DIGEST.test(digest) ? digest : undefined;
}

function basic(credentials: Credentials): string {
  return Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64');
}

/** Rejects with an AbortError when the signal aborts, also if `promise` ignores the signal. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
