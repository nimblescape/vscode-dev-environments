// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Image references of a configuration (concept D-17): the image of another environment, an image ID in place of a name,
// references that Docker's grammar does not accept, and the labels of an image by which Dev Environments, the Dev
// Container CLI, and Docker Compose find containers. The pipeline asks Docker about the references
// (imageReferencesToInspect, inspectedImageItems). Pure functions, no I/O.
import { MAX_REFERENCE_LENGTH } from '../imageCheck/dockerfile';
import { isDockerHub, parseImageReference } from '../imageCheck/reference';
import type { HostAccessFinding } from './report';
import { isReservedLabel } from './rules';

/** An image reference of a configuration, and how an item names it (for example `FROM image`). */
export interface NamedImageReference {
  reference: string;
  what: string;
}

/**
 * An image ID in place of a name by its form alone: `sha256:<hex>`, or 64 hexadecimal characters. A shorter prefix of an
 * ID looks like a name (for example `a1b2c3d4`, which may also be the name of an image): the pipeline asks Docker which
 * image such a reference names (resolvedByImageId, review round 2, S2-05).
 */
const IMAGE_ID = /^(sha256:[0-9a-f]{1,64}|[0-9a-f]{64})$/i;

/**
 * The repository of an image reference as Docker names it locally: Docker Hub's names without the registry and
 * without `library/` (`docker.io/library/devenv-1:2`, `index.docker.io/devenv-1`, and `devenv-1` all give `devenv-1`),
 * others with the registry. Lower case.
 */
export function localImageRepository(reference: string): string {
  const text = reference.trim();
  const parsed = parseImageReference(text);
  if (parsed) return isDockerHub(parsed.registry) ? parsed.repository.replace(/^library\//, '') : `${parsed.registry}/${parsed.repository}`;
  // A reference that Docker would not accept either: read as it is written.
  return text
    .toLowerCase()
    .replace(/[@].*$/, '')
    .replace(/:[^/]*$/, '')
    .replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '')
    .replace(/^library\//, '');
}

/** Review round 6 (S6-1): a reference in an item, cut after 64 characters. */
function shortReference(reference: string): string {
  return reference.length > 64 ? `${reference.slice(0, 64)}…` : reference;
}

/** Review round 6 (S6-1): the finding of a reference longer than MAX_REFERENCE_LENGTH. */
function tooLongFinding(reference: string, what: string): HostAccessFinding {
  return { item: `${what} ${shortReference(reference.trim())} (the image reference is too long)`, class: 'unsupported' };
}

/**
 * An image reference that a configuration may not use, with its class: the image of another environment (a name of
 * the namespace `devenv-` of Dev Environments, also written with Docker Hub's registry or `library/`, D-17), perhaps of
 * another account: `protected`; an image ID in place of a name (it can name any local image, also one of another
 * environment): `unsupported`. `undefined` for any other reference. `what` names it in the item.
 */
export function imageReferenceFinding(reference: string, what = 'image'): HostAccessFinding | undefined {
  const text = reference.trim();
  // Review round 6 (S6-1).
  if (text.length > MAX_REFERENCE_LENGTH) return tooLongFinding(text, what);
  if (IMAGE_ID.test(text)) return { item: imageIdItem(text, what), class: 'unsupported' };
  if (/^devenv-/.test(localImageRepository(text))) return { item: `${what} ${text} of another environment`, class: 'protected' };
  return undefined;
}

/**
 * Whether Docker took `reference` for the ID (or a prefix of the ID) of the image that it inspected, not for its name
 * (review round 2, S2-05): neither the tags nor the digests of the image (`RepoTags`, `RepoDigests` of
 * `docker image inspect`) name it. Compared normalized (parseImageReference: `postgres` is
 * `docker.io/library/postgres:latest`); a reference with a digest by its digest. `false` for a reference that is no
 * image name (it cannot be compared).
 */
export function resolvedByImageId(reference: string, repoTags: readonly string[], repoDigests: readonly string[]): boolean {
  const parsed = parseImageReference(reference);
  if (!parsed) return false;
  const repository = `${parsed.registry}/${parsed.repository}`;
  const matches = (other: string, byDigest: boolean): boolean => {
    const name = parseImageReference(other);
    if (!name || `${name.registry}/${name.repository}` !== repository) return false;
    return byDigest ? name.digest === parsed.digest : name.tag === parsed.tag;
  };
  return parsed.digest !== undefined ? !repoDigests.some((other) => matches(other, true)) : !repoTags.some((other) => matches(other, false));
}

/**
 * Review round 9 (S9-3): of `references` (distinct), those that Docker resolves by the ID of an image, from the images
 * that one `docker image inspect` of all of them found (`found`, each with its ID, tags, and digests), as Docker resolves
 * a reference: by its name first (a tag, or a digest of the repository: resolvedByImageId is false for a found image),
 * else by the ID: a prefix of the hexadecimal ID (also with `sha256:`), or a digest that is the ID. A reference that
 * resolves to no found image is missing.
 */
export function imageIdResolvedReferences(
  references: readonly string[],
  found: ReadonlyArray<{ id: string; repoTags: readonly string[]; repoDigests: readonly string[] }>,
): string[] {
  const result: string[] = [];
  for (const reference of references) {
    if (found.some((image) => !resolvedByImageId(reference, image.repoTags, image.repoDigests))) continue;
    const text = reference.trim().toLowerCase();
    const hex = /^(sha256:)?([0-9a-f]+)$/.exec(text)?.[2];
    const digest = /@(sha256:[0-9a-f]{64})$/.exec(text)?.[1];
    const byId = found.some((image) => {
      const id = image.id.toLowerCase();
      return (hex !== undefined && id.startsWith(`sha256:${hex}`)) || (digest !== undefined && id === digest);
    });
    if (byId) result.push(reference);
  }
  return result;
}

/** The item of an image reference that Docker resolved by the ID of the image (resolvedByImageId): not supported. */
export function imageIdItem(reference: string, what = 'image'): string {
  return `${what} ${reference.trim()} (an image ID; name the image)`;
}

/**
 * Review round 10 (P10-1): the item of an image reference that Docker could not inspect (for another reason than a
 * missing image, for example "invalid reference format"): it cannot be told apart from an image ID, so it is not supported.
 */
export function imageUncheckedItem(reference: string, what = 'image'): string {
  return `${what} ${reference.trim()} (the image reference could not be checked)`;
}

/**
 * Review round 11 (G2): whether `reference` follows Docker's reference grammar (github.com/distribution/reference, as
 * parseImageReference reads it: lowercase path components, the separators `.`, `_`, `__`, and `-`, a tag of at most 128
 * characters, a digest), written without surrounding whitespace. Conservative: a reference that the grammar rejects is
 * never accepted, whatever Docker would make of it. Review round 12 (P12-1): also the rules of go-digest for the digest
 * (isValidDigest), and the bound of 255 characters on the normalized name (normalizedImageName), as Docker checks them.
 */
export function isValidImageReference(reference: string): boolean {
  if (reference !== reference.trim() || parseImageReference(reference) === undefined) return false;
  // Review round 12 (P12-1): what Docker checks beyond the grammar of parseImageReference (which other callers use).
  const at = reference.indexOf('@');
  if (at >= 0 && !isValidDigest(reference.slice(at + 1))) return false;
  let name = at >= 0 ? reference.slice(0, at) : reference;
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) name = name.slice(0, colon);
  return normalizedImageName(name).length <= IMAGE_NAME_MAX_LENGTH;
}

/** Review round 12 (P12-1): the most characters of the normalized name of an image (distribution/reference). */
const IMAGE_NAME_MAX_LENGTH = 255;

/**
 * Review round 12 (P12-1): the digest algorithms that Docker accepts (go-digest, with the lengths of their lowercase hex
 * encodings): any other algorithm, length, or uppercase hex is refused ("unsupported digest algorithm", "invalid checksum
 * digest length", "invalid checksum digest format").
 */
const DIGEST_HEX_LENGTHS: ReadonlyMap<string, number> = new Map([
  ['sha256', 64],
  ['sha384', 96],
  ['sha512', 128],
]);

function isValidDigest(digest: string): boolean {
  const colon = digest.indexOf(':');
  const length = colon > 0 ? DIGEST_HEX_LENGTHS.get(digest.slice(0, colon)) : undefined;
  const hex = digest.slice(colon + 1);
  return length !== undefined && hex.length === length && /^[0-9a-f]+$/.test(hex);
}

/**
 * Review round 12 (P12-1): the name of an image reference (without tag and digest) as Docker normalizes it before it
 * checks its length (distribution/reference ParseNormalizedNamed): a name without a registry, or on `docker.io` or
 * `index.docker.io`, becomes `docker.io/<path>`, with `library/` before a path of one component.
 */
function normalizedImageName(name: string): string {
  const slash = name.indexOf('/');
  let domain: string | undefined;
  let path = name;
  if (slash > 0) {
    const first = name.slice(0, slash);
    if (/[.:]/.test(first) || first === 'localhost' || first !== first.toLowerCase()) {
      domain = first;
      path = name.slice(slash + 1);
    }
  }
  if (domain !== undefined && domain !== 'docker.io' && domain !== 'index.docker.io') return `${domain}/${path}`;
  return `docker.io/${path.includes('/') ? path : `library/${path}`}`;
}

/** Review round 11 (G2): the item of an image reference that is not valid in Docker's grammar: not supported. */
export function imageInvalidReferenceItem(reference: string, what = 'image'): string {
  return `${what} ${reference.trim()} (not a valid image reference)`;
}

/**
 * The labels of an image that a container created from it would carry, and that Dev Environments, the Dev Container
 * CLI, and Docker Compose use to find and set up containers: the labels of the extension (EXTENSION_LABEL_KEYS),
 * `devcontainer.…`, and `com.docker.compose.…`, except `devcontainer.metadata`, the only label that the Dev Container
 * CLI puts on the images that it builds (CLI 0.89.0: `var EI="devcontainer.metadata"`; `devcontainer.local_folder` and
 * `devcontainer.config_file` are labels of containers). For example `LABEL nimblescape.devenv.compose-service=x` in a
 * Dockerfile would hide the container from the lookups of the extension. Refused whatever the switch says
 * (HostAccessClass `protected`). The labels of the extension are all those with LABEL_PREFIX (isReservedLabel); labels
 * with the prefix `devenv.` are allowed: other tools use it on their images, and the extension never reads them. The
 * labels of Docker Compose (`com.docker.compose.…`) are not refused (review round 2, D2-1): Compose puts them on each
 * image that it builds (an image built for another project inherits them through FROM), and it sets its own on the
 * containers that it creates; the override configuration of a single container sets them empty
 * (COMPOSE_CLEARED_LABELS), so that such an image does not make `docker compose -p <project> down` remove the dev
 * container.
 */
export function imageLabelItems(image: string, labels: Readonly<Record<string, string>>): string[] {
  return Object.keys(labels)
    .map((key) => key.trim())
    .filter((key) => key !== 'devcontainer.metadata' && isReservedLabel(key))
    .map((key) => `label ${key} of the image ${image}`);
}

/**
 * Review round 11 (G1, G2): of `references` (of a configuration, ImageReferences of the analysis), each once (by its
 * item), those that Docker is asked about (`named`), and the items of those that are not valid in Docker's grammar
 * (`invalid`, imageInvalidReferenceItem), which are refused before any inspect. A reference that imageReferenceFinding
 * refuses already (the image of another environment, an image ID) is left out: the check names it.
 */
export function imageReferencesToInspect(references: readonly NamedImageReference[]): { named: NamedImageReference[]; invalid: string[] } {
  const named: NamedImageReference[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of references) {
    if (seen.has(`${entry.what} ${entry.reference}`) || imageReferenceFinding(entry.reference, entry.what) !== undefined) continue;
    seen.add(`${entry.what} ${entry.reference}`);
    if (isValidImageReference(entry.reference)) named.push(entry);
    else invalid.push(imageInvalidReferenceItem(entry.reference, entry.what));
  }
  return { named, invalid };
}

/**
 * The items of the references `named` (imageReferencesToInspect) after one `docker image inspect` of their distinct
 * references: `images`, the images that Docker found, and `unchecked`, the references that it could not inspect
 * (`invalid`: a definitive answer; `transient`: a timeout, a daemon that cannot be reached). `items`: the references that
 * Docker resolves by the ID of an image (imageIdItem) and those with a definitive answer (imageUncheckedItem), in the
 * order of `named`; `transient` and `notChecked` (the references of each kind), for the log and the error of the pipeline.
 */
export function inspectedImageItems(
  named: readonly NamedImageReference[],
  images: ReadonlyArray<{ id: string; repoTags: readonly string[]; repoDigests: readonly string[] }>,
  unchecked: ReadonlyArray<{ reference: string; reason: 'invalid' | 'transient' }>,
): { items: string[]; transient: string[]; notChecked: string[] } {
  const distinct = [...new Set(named.map((entry) => entry.reference))];
  const transient = unchecked.filter((entry) => entry.reason === 'transient').map((entry) => entry.reference);
  // Review round 14 (P14-2): the ID test only over the references with a definitive answer: a transient one was never
  // inspected, so the images of the others (a batch before the failure) say nothing about it (for example `cafe`, with
  // a local cafe:latest, and another image whose ID starts with cafe). It takes the transient path of the pipeline.
  const transientSet = new Set(transient);
  const byId = new Set(imageIdResolvedReferences(distinct.filter((reference) => !transientSet.has(reference)), images));
  // Review round 13 (P13-1): only a definitive answer (`invalid`) becomes an item; a transient one never does.
  const notChecked = new Set(unchecked.filter((entry) => entry.reason === 'invalid').map((entry) => entry.reference));
  const items = named.flatMap((entry) => [
    ...(byId.has(entry.reference) ? [imageIdItem(entry.reference, entry.what)] : []),
    ...(notChecked.has(entry.reference) ? [imageUncheckedItem(entry.reference, entry.what)] : []),
  ]);
  return { items, transient, notChecked: [...notChecked] };
}
