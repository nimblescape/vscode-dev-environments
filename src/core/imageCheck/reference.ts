// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Image and Feature references (concept 7.7, implementation notes 9).
// The grammar follows the Docker reference format (github.com/distribution/reference).

/** An image or Feature reference, normalized for requests to its registry. */
export interface ImageReference {
  /** The reference as written in the configuration. */
  original: string;
  /** Host (and port) for requests. Docker Hub is `registry-1.docker.io`. */
  registry: string;
  /** Repository path. Official Docker Hub images get the prefix `library/`. */
  repository: string;
  /** Tag. Default `latest`. */
  tag: string;
  /** Set for `…@sha256:…` references. These never change and are not checked. */
  digest?: string;
}

/** Host of the Docker Hub registry API. */
export const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';
/** Server name of Docker Hub in the Docker credential store (`docker login` without a server). */
export const DOCKER_HUB_CREDENTIAL_SERVER = 'https://index.docker.io/v1/';

const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}$/;
const DOMAIN_COMPONENT = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const DOMAIN = new RegExp(`^(?:\\[[0-9A-Fa-f:.]+\\]|${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*)(?::[0-9]{1,5})?$`);
const NAME_MAX_LENGTH = 255;

/** True for the host names of Docker Hub. */
export function isDockerHub(registry: string): boolean {
  return DOCKER_HUB_HOSTS.has(registry.toLowerCase());
}

/**
 * Parses and normalizes an image reference: `[registry/]path[:tag][@digest]`.
 * Returns `undefined` for an invalid reference, and for a reference with an unresolved variable (`${…}`).
 */
export function parseImageReference(reference: string): ImageReference | undefined {
  const text = reference.trim();
  if (!text || text.includes('${') || /\s/.test(text)) return undefined;

  let rest = text;
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return undefined;
  }

  let tag: string | undefined;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return undefined;
  }
  if (!rest || rest.length > NAME_MAX_LENGTH) return undefined;

  // The first component is a registry host if it looks like one (same rule as Docker).
  let domain: string | undefined;
  let path = rest;
  const slash = rest.indexOf('/');
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (/[.:]/.test(first) || first === 'localhost' || first !== first.toLowerCase()) {
      domain = first;
      path = rest.slice(slash + 1);
    }
  }
  if (domain !== undefined && !DOMAIN.test(domain)) return undefined;
  if (!path.split('/').every((component) => PATH_COMPONENT.test(component))) return undefined;

  let registry = domain === undefined ? DOCKER_HUB_REGISTRY : domain.toLowerCase();
  if (isDockerHub(registry)) {
    registry = DOCKER_HUB_REGISTRY;
    if (!path.includes('/')) path = `library/${path}`;
  }

  const result: ImageReference = { original: reference, registry, repository: path, tag: tag ?? 'latest' };
  if (digest !== undefined) result.digest = digest.toLowerCase();
  return result;
}

/**
 * Parses a Feature key the way the Dev Container CLI resolves it, so that the check asks for the artifact that the
 * build uses: the CLI lower-cases the whole key, and it redirects the owner `devcontainers-contrib` to
 * `devcontainers-extra` (the old packages are no longer public, so the check would report a sign-in there).
 */
export function parseFeatureReference(key: string): ImageReference | undefined {
  const parts = key.trim().toLowerCase().split('/');
  if (parts.length > 2 && parts[1] === 'devcontainers-contrib') parts[1] = 'devcontainers-extra';
  const parsed = parseImageReference(parts.join('/'));
  return parsed && { ...parsed, original: key };
}

/** True if the reference is pinned to a digest (`…@sha256:…`). Such references never change and are not checked. */
export function hasDigest(reference: string): boolean {
  const parsed = parseImageReference(reference);
  if (parsed) return parsed.digest !== undefined;
  return /@[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:/.test(reference);
}

/** Registry host as Docker's credential store names it (Docker Hub → `https://index.docker.io/v1/`). */
export function credentialServerName(registry: string): string {
  return isDockerHub(registry) ? DOCKER_HUB_CREDENTIAL_SERVER : registry.toLowerCase();
}

/** Registry name for messages and logs (Docker Hub → `docker.io`). */
export function registryDisplayName(registry: string): string {
  return isDockerHub(registry) ? 'docker.io' : registry;
}

/**
 * True if a Feature key of `devcontainer.json` is an OCI reference: not a local path (`./`, `../`, `/`),
 * not a URL (for example a tarball on `https://`), not a tarball, and with a registry host as first component
 * (the Dev Container CLI always reads the first component of an OCI Feature as the registry).
 */
export function isOciFeatureReference(key: string): boolean {
  const text = key.trim();
  if (!text.includes('/')) return false;
  if (/^(?:\.{1,2}[\\/]|[\\/])/.test(text)) return false;
  if (/^[A-Za-z]:[\\/]/.test(text)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return false;
  if (/\.(?:tgz|tar\.gz|tar)$/i.test(text)) return false;
  const first = text.slice(0, text.indexOf('/'));
  return /[.:]/.test(first) || first === 'localhost';
}
