// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run"; the live
// check 3 of the user: the VS Code server installs an extension from a `.vsix` that is already in
// `~/.vscode-server/extensionsCache/<cache name>`, and then downloads nothing): the pure rules of the shared extension
// cache. The open records the extension list of its environment (the configuration's `customizations.vscode.extensions`
// and the user's `dev.containers.defaultExtensions`) and seeds the `.vsix` files that the store has; the Session
// Monitor's background run downloads the newest compatible releases from the Marketplace into the store and cleans it
// up. The store layout (under the shared store, VSCODE_STORE_DIR in the worker and the monitor):
//   <store>/extensions/<universal|linux-x64|linux-arm64>/<cache name>   one `.vsix` (readable for all)
//   <store>/extensions/wanted/<environment-id>.json                     the recorded list of an environment's last open
//   <store>/extensions/tmp/<cache name>-<random>                         one download, renamed into place
//   <store>/extensions/failures.json                                     the monitor's failed entries (retried after a day)
//   <store>/locks/extension-<cache name>.lock                            the `flock` of one file (never removed)
// No I/O, no `vscode`.
import type { VscodePlatform } from './helperChannel/protocol';

/** Plan step 11H3: an extension of a list: its ID (`publisher.name`, lower case) and a pinned version (`@x.y.z`). */
export interface ExtensionRef {
  id: string;
  version?: string;
}

/** Plan step 11H3: the most entries of one list (the configuration's, the defaults, the record of an open). */
export const MAX_LISTED_EXTENSIONS = 100;
/** Plan step 11H3: the longest entry of a list (`publisher.name@x.y.z`). */
export const MAX_EXTENSION_ENTRY_LENGTH = 256;
/** Plan step 11H3: the most entries of the union of the recorded lists that the monitor keeps new. */
export const MAX_WANTED_EXTENSIONS = 200;

/**
 * Plan step 11H3: an extension ID as VS Code checks it (EXTENSION_IDENTIFIER_PATTERN: letters, digits and `-`, each part
 * starting with a letter or a digit), with an optional pinned version of three numbers.
 */
const ENTRY_PATTERN = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)(?:@(\d{1,9}\.\d{1,9}\.\d{1,9}))?$/i;

/** Plan step 11H3: one entry of a list, strictly; the ID in lower case (VS Code compares IDs without case). */
export function parseExtensionEntry(text: unknown): ExtensionRef | undefined {
  if (typeof text !== 'string' || text.length > MAX_EXTENSION_ENTRY_LENGTH) return undefined;
  const match = ENTRY_PATTERN.exec(text);
  if (match === null) return undefined;
  return match[2] !== undefined ? { id: match[1].toLowerCase(), version: match[2] } : { id: match[1].toLowerCase() };
}

/** Plan step 11H3: the text of an entry (`id` or `id@version`), as the record and the protocol hold it. */
export function extensionEntryText(ref: ExtensionRef): string {
  return ref.version !== undefined ? `${ref.id}@${ref.version}` : ref.id;
}

/**
 * Plan step 11H3: the strict check of a list as the protocol and the record carry it: an array of at most `max` entries,
 * each valid (parseExtensionEntry) and in its canonical text (the ID in lower case), no ID twice; undefined otherwise.
 */
export function parseExtensionList(value: unknown, max = MAX_LISTED_EXTENSIONS): ExtensionRef[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const refs: ExtensionRef[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const ref = parseExtensionEntry(entry);
    if (ref === undefined || extensionEntryText(ref) !== entry || ids.has(ref.id)) return undefined;
    ids.add(ref.id);
    refs.push(ref);
  }
  return refs;
}

/**
 * Plan step 11H3: the user's `dev.containers.defaultExtensions` (any value of the setting): the valid entries, each ID
 * once (the first one counts), at most MAX_LISTED_EXTENSIONS; anything else is left out (`dropped` counts it).
 */
export function defaultExtensionsOf(value: unknown): { list: ExtensionRef[]; dropped: number } {
  if (!Array.isArray(value)) return { list: [], dropped: value === undefined || value === null ? 0 : 1 };
  const list: ExtensionRef[] = [];
  const ids = new Set<string>();
  let dropped = 0;
  for (const entry of value) {
    const ref = parseExtensionEntry(entry);
    if (ref === undefined || ids.has(ref.id) || list.length >= MAX_LISTED_EXTENSIONS) {
      dropped++;
      continue;
    }
    ids.add(ref.id);
    list.push(ref);
  }
  return { list, dropped };
}

/**
 * Plan step 11H3 (the brief): the extensions of a configuration: `customizations.vscode.extensions` of the merged
 * configuration when the open has it (a list of one object per metadata entry there), else of the configuration's own
 * (one object). In order; each ID once (the first entry counts); an entry that starts with `-` is no extension to
 * install: it is left out and removes that ID from the entries before it (the Dev Containers extension removes an
 * extension of a Feature that way); invalid entries are left out; at most MAX_LISTED_EXTENSIONS.
 */
export function configurationExtensions(config: unknown, merged?: unknown): ExtensionRef[] {
  const source = merged !== undefined ? merged : config;
  const customizations = isRecord(source) ? source.customizations : undefined;
  const vscode = isRecord(customizations) ? customizations.vscode : undefined;
  const entries: unknown[] = [];
  for (const part of Array.isArray(vscode) ? vscode : [vscode]) {
    if (isRecord(part) && Array.isArray(part.extensions)) entries.push(...part.extensions);
  }
  const list: ExtensionRef[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.startsWith('-')) {
      const removed = parseExtensionEntry(entry.slice(1))?.id;
      if (removed !== undefined) {
        const at = list.findIndex((ref) => ref.id === removed);
        if (at >= 0) list.splice(at, 1);
      }
      continue;
    }
    const ref = parseExtensionEntry(entry);
    if (ref !== undefined && !list.some((known) => known.id === ref.id)) list.push(ref);
  }
  return list.slice(0, MAX_LISTED_EXTENSIONS);
}

/** Plan step 11H3: the list of an open: the configuration's, then the defaults; each ID once (the first counts), bounded. */
export function combinedExtensions(configuration: readonly ExtensionRef[], defaults: readonly ExtensionRef[]): ExtensionRef[] {
  const list: ExtensionRef[] = [];
  for (const ref of [...configuration, ...defaults]) {
    if (!list.some((known) => known.id === ref.id)) list.push(ref);
  }
  return list.slice(0, MAX_LISTED_EXTENSIONS);
}

// ---------------------------------------------------------------------------------------------------------------------
// The record of an open (`extensions/wanted/<environment-id>.json`)

/** Plan step 11H3: the largest record file. */
export const MAX_EXTENSION_RECORD_BYTES = 64 * 1024;

/** Plan step 11H3: the record of the extension list of an environment's last open. */
export interface ExtensionRecord {
  /** The time of the open (ms since the epoch). */
  at: number;
  /** The configuration's extensions (configurationExtensions). */
  configuration: ExtensionRef[];
  /** The user's defaults (defaultExtensionsOf). */
  defaults: ExtensionRef[];
}

/** Plan step 11H3: the text of a record (JSON). */
export function formatExtensionRecord(record: ExtensionRecord): string {
  return `${JSON.stringify({ at: record.at, configuration: record.configuration.map(extensionEntryText), defaults: record.defaults.map(extensionEntryText) })}\n`;
}

/** Plan step 11H3: a record, strictly (exactly its three fields, each of its shape); undefined for anything else. */
export function parseExtensionRecord(text: string): ExtensionRecord | undefined {
  if (Buffer.byteLength(text, 'utf8') > MAX_EXTENSION_RECORD_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'at,configuration,defaults') return undefined;
  const { at } = value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  const configuration = parseExtensionList(value.configuration);
  const defaults = parseExtensionList(value.defaults);
  if (configuration === undefined || defaults === undefined) return undefined;
  return { at, configuration, defaults };
}

/** Plan step 11H3 (the brief): a recorded list counts for the monitor's downloads and cleanup for this long. */
export const RECORDED_LIST_MS = 14 * 24 * 60 * 60_000;

/**
 * Plan step 11H3: the union of the lists recorded within RECORDED_LIST_MS of `now` (a time in the future counts as now):
 * each entry (an ID, or an ID with its pinned version) once, sorted, at most MAX_WANTED_EXTENSIONS.
 */
export function wantedExtensions(records: readonly ExtensionRecord[], now: number): ExtensionRef[] {
  const byText = new Map<string, ExtensionRef>();
  for (const record of records) {
    if (now - record.at >= RECORDED_LIST_MS) continue;
    for (const ref of combinedExtensions(record.configuration, record.defaults)) byText.set(extensionEntryText(ref), ref);
  }
  return [...byText.keys()]
    .sort()
    .slice(0, MAX_WANTED_EXTENSIONS)
    .map((text) => byText.get(text)!);
}

// ---------------------------------------------------------------------------------------------------------------------
// Cache names and the files of the store

/** Plan step 11H3: the folder of the `.vsix` files of a platform, or of those without a target platform. */
export type ExtensionFolder = 'universal' | VscodePlatform;
export const EXTENSION_FOLDERS: readonly ExtensionFolder[] = ['universal', 'linux-x64', 'linux-arm64'];

/**
 * Plan step 11H3 (live check 3 of 2026-10-09): the server's cache name of a version: `<publisher>.<name>-<version>` in
 * lower case, plus `-<targetPlatform>` when the Marketplace version has a target platform (for example
 * `redhat.vscode-yaml-1.24.0`, `rust-lang.rust-analyzer-0.3.2-linux-x64`).
 */
export function extensionCacheName(id: string, version: string, targetPlatform?: VscodePlatform): string {
  return `${id}-${version}${targetPlatform !== undefined ? `-${targetPlatform}` : ''}`.toLowerCase();
}

/** Plan step 11H3: the folder of the store of a version (its target platform, or `universal`). */
export function extensionFolderOf(targetPlatform: VscodePlatform | undefined): ExtensionFolder {
  return targetPlatform ?? 'universal';
}

/**
 * Plan step 11H3: the ID and the version of a file of the store folder `folder`, by its cache name (the name holds no
 * dot after the publisher, so the version is the first `-x.y.z` after it); a file of a platform folder ends in that
 * platform, one of `universal` in none. Undefined for any other name (left alone).
 */
export function parseCachedExtension(name: string, folder: ExtensionFolder): { id: string; version: string } | undefined {
  const match = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)-(\d{1,9}\.\d{1,9}\.\d{1,9})(?:-(linux-x64|linux-arm64))?$/.exec(name);
  if (match === null) return undefined;
  if ((match[3] ?? 'universal') !== folder) return undefined;
  return { id: match[1], version: match[2] };
}

/** Plan step 11H3: compares two versions `x.y.z` by their numbers (negative: `a` is older). */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Plan step 11H3 (the brief: "the newest cached `.vsix` in the store for the container's platform (or universal)"): the
 * files that the open seeds, as `<folder>/<name>`: for each entry of `wanted`, its pinned version, else its newest version
 * among the files of `universal` and of `platform` (the engine's; none: only `universal`); the same version in both: the
 * file of the platform (the server prefers it). An entry without a file is left out.
 */
export function seedSelection(
  wanted: readonly ExtensionRef[],
  files: Partial<Record<ExtensionFolder, readonly string[]>>,
  platform: VscodePlatform | undefined,
): string[] {
  const folders: ExtensionFolder[] = platform !== undefined ? [platform, 'universal'] : ['universal'];
  const chosen: string[] = [];
  for (const ref of wanted) {
    let best: { folder: ExtensionFolder; name: string; version: string } | undefined;
    for (const folder of folders) {
      for (const name of files[folder] ?? []) {
        const cached = parseCachedExtension(name, folder);
        if (cached === undefined || cached.id !== ref.id) continue;
        if (ref.version !== undefined && cached.version !== ref.version) continue;
        if (best === undefined || compareVersions(cached.version, best.version) > 0) best = { folder, name, version: cached.version };
      }
    }
    if (best !== undefined) chosen.push(`${best.folder}/${best.name}`);
  }
  return chosen;
}

/**
 * Plan step 11H3 (the brief, item 4): the files of one folder of the store that the cleanup removes: those that are not
 * the newest of their ID in that folder and whose version no recorded list of the last 14 days pins (`pinned`: the
 * entries `id@version` of wantedExtensions). A name of no cache name is left alone.
 */
export function extensionFilesToRemove(folder: ExtensionFolder, names: readonly string[], pinned: ReadonlySet<string>): string[] {
  const newest = new Map<string, string>();
  const parsed: { name: string; id: string; version: string }[] = [];
  for (const name of names) {
    const cached = parseCachedExtension(name, folder);
    if (cached === undefined) continue;
    parsed.push({ name, ...cached });
    const known = newest.get(cached.id);
    if (known === undefined || compareVersions(cached.version, known) > 0) newest.set(cached.id, cached.version);
  }
  return parsed
    .filter((file) => newest.get(file.id) !== file.version && !pinned.has(`${file.id}@${file.version}`))
    .map((file) => file.name)
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// The engine of an extension (`engines.vscode`)

/**
 * Plan step 11H3 (the brief: the engine rules of VS Code): whether an extension whose `engines.vscode` is `engine` runs
 * on the VS Code `vscodeVersion` (`x.y.z`). The rules of VS Code's isEngineValid / isValidVersion
 * (src/vs/platform/extensions/common/extensionValidator.ts, written down here from its source, which is not in this
 * repository's dependencies): `*` always; `>=x.y.z` the version or newer; `^x.y.z` the same major (for `^0.y.z` the same
 * minor) and not older; `x.y.z` exactly that version, where an `x` in a part leaves it free; an engine of a major 0
 * other than an exact one accepts every 1.y.z. A pre-release suffix of the engine is ignored (VS Code reads only its
 * not-before date `-yyyymmdd`, which needs the date of the build: left out here, so such an engine counts as
 * compatible). Anything else is not compatible.
 */
export function isEngineCompatible(engine: string, vscodeVersion: string): boolean {
  const text = engine.trim();
  if (text === '*') return true;
  const product = /^(\d+)\.(\d+)\.(\d+)/.exec(vscodeVersion.trim());
  const wanted = /^(\^|>=)?(\d+|x)\.(\d+|x)\.(\d+|x)(-.*)?$/.exec(text);
  if (product === null || wanted === null) return false;
  const [major, minor, patch] = [Number(product[1]), Number(product[2]), Number(product[3])];
  const part = (value: string) => (value === 'x' ? { base: 0, mustEqual: false } : { base: Number(value), mustEqual: true });
  let desiredMajor = part(wanted[2]);
  let desiredMinor = part(wanted[3]);
  let desiredPatch = part(wanted[4]);
  if (wanted[1] === '^') {
    if (desiredMajor.base === 0) desiredPatch = { ...desiredPatch, mustEqual: false };
    else {
      desiredMinor = { ...desiredMinor, mustEqual: false };
      desiredPatch = { ...desiredPatch, mustEqual: false };
    }
  }
  if (wanted[1] === '>=') {
    if (major !== desiredMajor.base) return major > desiredMajor.base;
    if (minor !== desiredMinor.base) return minor > desiredMinor.base;
    return patch >= desiredPatch.base;
  }
  // Anything below 1.0.0 is compatible with 1.y.z, except an exact match.
  if (major === 1 && desiredMajor.base === 0 && (!desiredMajor.mustEqual || !desiredMinor.mustEqual || !desiredPatch.mustEqual)) {
    desiredMajor = { base: 1, mustEqual: true };
    desiredMinor = { base: 0, mustEqual: false };
    desiredPatch = { base: 0, mustEqual: false };
  }
  if (major !== desiredMajor.base) return major > desiredMajor.base && !desiredMajor.mustEqual;
  if (minor !== desiredMinor.base) return minor > desiredMinor.base && !desiredMinor.mustEqual;
  if (patch !== desiredPatch.base) return patch > desiredPatch.base && !desiredPatch.mustEqual;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Marketplace

/** Plan step 11H3: the query endpoint of the Marketplace; the only host the monitor asks (never a parameter). */
export const MARKETPLACE_QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
/** Plan step 11H3: the largest answer of a query (the HTTPS transport reads at most 16 MiB). */
export const MAX_MARKETPLACE_ANSWER_BYTES = 16 * 1024 * 1024;

/**
 * Plan step 11H3: the flags of a query, as VS Code's gallery service names them: IncludeVersions (0x1), IncludeFiles
 * (0x2), IncludeVersionProperties (0x10: the engine and the pre-release mark), IncludeAssetUri (0x80), and, for the
 * entries without a pin, IncludeLatestPrereleaseAndStableVersionOnly (0x10000: the newest release and pre-release of each
 * target platform, which keeps the answer small; a pinned version needs all of them).
 */
export const MARKETPLACE_FLAGS = 0x1 | 0x2 | 0x10 | 0x80;
export const MARKETPLACE_LATEST_ONLY_FLAG = 0x10000;

/**
 * Plan step 11H3: the body of one query for the extensions `ids` (filter type 7, the full name; 8, the target VS Code;
 * 12 with 4096, no unpublished extension), one page of all of them.
 */
export function marketplaceQueryBody(ids: readonly string[], latestOnly: boolean): string {
  return JSON.stringify({
    filters: [
      {
        criteria: [...ids.map((id) => ({ filterType: 7, value: id })), { filterType: 8, value: 'Microsoft.VisualStudio.Code' }, { filterType: 12, value: '4096' }],
        pageNumber: 1,
        pageSize: ids.length,
        sortBy: 0,
        sortOrder: 0,
      },
    ],
    assetTypes: [],
    flags: MARKETPLACE_FLAGS | (latestOnly ? MARKETPLACE_LATEST_ONLY_FLAG : 0),
  });
}

/** Plan step 11H3: one version of an extension in an answer of the Marketplace. */
export interface MarketplaceVersion {
  version: string;
  /** Its target platform; none: universal. */
  targetPlatform?: string;
  preRelease: boolean;
  /** `Microsoft.VisualStudio.Code.Engine`. */
  engine?: string;
  /** The URL of its `.vsix` (the asset Microsoft.VisualStudio.Services.VSIXPackage), always `https:`. */
  vsix?: string;
}

const VSIX_ASSET = 'Microsoft.VisualStudio.Services.VSIXPackage';
/** The most versions of one extension that are read from an answer. */
const MAX_VERSIONS_PER_EXTENSION = 20_000;

/**
 * Plan step 11H3: the versions of each extension of an answer, by its ID (lower case), strictly: the answer must be
 * `{ results: [{ extensions: [...] }] }` with each extension's publisher and name valid; a version entry that does not
 * fit (no `x.y.z` version, a property or a file of another shape, a VSIX URL that is not `https:`) is left out;
 * undefined for an answer of any other shape or larger than MAX_MARKETPLACE_ANSWER_BYTES.
 */
export function parseMarketplaceAnswer(body: string): Map<string, MarketplaceVersion[]> | undefined {
  if (Buffer.byteLength(body, 'utf8') > MAX_MARKETPLACE_ANSWER_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.results)) return undefined;
  const found = new Map<string, MarketplaceVersion[]>();
  for (const result of value.results) {
    if (!isRecord(result) || !Array.isArray(result.extensions)) return undefined;
    for (const extension of result.extensions) {
      if (!isRecord(extension) || !isRecord(extension.publisher)) return undefined;
      const id = parseExtensionEntry(`${String(extension.publisher.publisherName)}.${String(extension.extensionName)}`)?.id;
      if (id === undefined || typeof extension.publisher.publisherName !== 'string' || typeof extension.extensionName !== 'string') return undefined;
      if (!Array.isArray(extension.versions) || extension.versions.length > MAX_VERSIONS_PER_EXTENSION) return undefined;
      const versions = found.get(id) ?? [];
      for (const entry of extension.versions) {
        const version = marketplaceVersion(entry);
        if (version !== undefined) versions.push(version);
      }
      found.set(id, versions);
    }
  }
  return found;
}

function marketplaceVersion(entry: unknown): MarketplaceVersion | undefined {
  if (!isRecord(entry) || typeof entry.version !== 'string' || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(entry.version)) return undefined;
  const { targetPlatform } = entry;
  if (targetPlatform !== undefined && (typeof targetPlatform !== 'string' || !/^[a-z0-9-]{1,32}$/.test(targetPlatform))) return undefined;
  const properties = entry.properties ?? [];
  if (!Array.isArray(properties) || !properties.every((p) => isRecord(p) && typeof p.key === 'string' && typeof p.value === 'string')) return undefined;
  const property = (key: string) => (properties as { key: string; value: string }[]).find((p) => p.key === key)?.value;
  const files = entry.files ?? [];
  if (!Array.isArray(files) || !files.every((f) => isRecord(f) && typeof f.assetType === 'string' && typeof f.source === 'string')) return undefined;
  const source = (files as { assetType: string; source: string }[]).find((f) => f.assetType === VSIX_ASSET)?.source;
  const vsix = source ?? (typeof entry.assetUri === 'string' ? `${entry.assetUri.replace(/\/+$/, '')}/${VSIX_ASSET}` : undefined);
  const engine = property('Microsoft.VisualStudio.Code.Engine');
  return {
    version: entry.version,
    ...(targetPlatform !== undefined ? { targetPlatform } : {}),
    preRelease: property('Microsoft.VisualStudio.Code.PreRelease') === 'true',
    ...(engine !== undefined ? { engine } : {}),
    ...(vsix !== undefined && isHttpsUrl(vsix) ? { vsix } : {}),
  };
}

/** Plan step 11H3: the version of an entry that the monitor keeps in the store. */
export interface ChosenExtension {
  version: string;
  targetPlatform?: VscodePlatform;
  vsix: string;
  folder: ExtensionFolder;
  cacheName: string;
}

/**
 * Plan step 11H3 (live check 3: the server installs the newest RELEASE version compatible with its VS Code version and
 * the container's platform; the brief): the version of `ref` among `versions` that the store keeps: with a pin, that
 * version as written (any engine, also a pre-release); otherwise the newest release (no pre-release) whose engine is
 * compatible with `vscodeVersion` (isEngineCompatible). Only versions without a target platform (universal) or with the
 * engine's `platform`, and with a VSIX URL; the same version for both: the one of the platform. Undefined when none fits.
 */
export function chooseExtensionVersion(ref: ExtensionRef, versions: readonly MarketplaceVersion[], vscodeVersion: string, platform: VscodePlatform): ChosenExtension | undefined {
  let best: ChosenExtension | undefined;
  for (const candidate of versions) {
    if (candidate.vsix === undefined) continue;
    if (candidate.targetPlatform !== undefined && candidate.targetPlatform !== platform) continue;
    if (ref.version !== undefined) {
      if (candidate.version !== ref.version) continue;
    } else if (candidate.preRelease || candidate.engine === undefined || !isEngineCompatible(candidate.engine, vscodeVersion)) {
      continue;
    }
    const targetPlatform = candidate.targetPlatform !== undefined ? platform : undefined;
    const order = best === undefined ? 1 : compareVersions(candidate.version, best.version);
    if (order > 0 || (order === 0 && targetPlatform !== undefined && best?.targetPlatform === undefined)) {
      best = {
        version: candidate.version,
        ...(targetPlatform !== undefined ? { targetPlatform } : {}),
        vsix: candidate.vsix,
        folder: extensionFolderOf(targetPlatform),
        cacheName: extensionCacheName(ref.id, candidate.version, targetPlatform),
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// The failures of the monitor (`extensions/failures.json`)

/** Plan step 11H3 (the brief: "a failed ID is retried after a day"). */
export const EXTENSION_RETRY_MS = 24 * 60 * 60_000;

/** Plan step 11H3: the failed entries (their text) and the time of their failure; anything invalid is left out. */
export function parseExtensionFailures(text: string): Map<string, number> {
  const failures = new Map<string, number>();
  if (Buffer.byteLength(text, 'utf8') > MAX_EXTENSION_RECORD_BYTES) return failures;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failures;
  }
  if (!isRecord(value)) return failures;
  for (const [entry, at] of Object.entries(value)) {
    const ref = parseExtensionEntry(entry);
    if (ref !== undefined && extensionEntryText(ref) === entry && typeof at === 'number' && Number.isSafeInteger(at) && at >= 0) failures.set(entry, at);
  }
  return failures;
}

/** Plan step 11H3: an entry that failed less than EXTENSION_RETRY_MS before `now` waits (a time ahead of `now` waits too, at most a day). */
export function extensionRetryWaits(failedAt: number | undefined, now: number): boolean {
  return failedAt !== undefined && Math.abs(now - failedAt) < EXTENSION_RETRY_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}
