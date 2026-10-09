// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// How Docker, the Dev Container CLI, and buildx read the texts of a configuration: the flags of `docker run` and
// `docker build` (parseFlags, with a table of rules: ./flags.ts), CSV fields, networks, mounts, `-v` values, published
// ports, and local build contexts. The container policy checks what these parsers read. Pure functions, no I/O.
import * as path from 'path';
import type { Problem } from './report';

/** How a flag of `docker run` or `docker build` is treated. */
export type FlagRule =
  | { kind: 'allow'; value: boolean }
  // Allowed, but not passed to Docker (overrideRunArgs); `reason` tells the log why (removedRunArgs). With `check`, its
  // value is checked first (review round 8, S8-6: `--restart`).
  | { kind: 'remove'; value: boolean; reason: string; check?: (value: string) => Problem[] }
  // `guarded`: refused whatever the switch of the host access checks says (HostAccessClass `protected`).
  | { kind: 'refuse'; value: boolean; item?: string; guarded?: boolean }
  | { kind: 'check'; check: (value: string) => Problem[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Flags

export interface ParsedFlag {
  /** Index of the flag in the arguments. The flags of a group of short flags (`-it`) have the same index. */
  index: number;
  /** The flag name, for example `--publish` or `-p`. `undefined` for an argument that is not a flag. */
  name: string | undefined;
  rule: FlagRule | undefined;
  value: string | undefined;
  /** `next`: the value is the next argument; `inline`: `--x=v`, `-xv`, or `-x=v`. */
  form: 'next' | 'inline' | 'none';
  raw: string;
}

/**
 * The rule of a flag, by its exact name only: a flag that is not in `rules` is unknown, also one that starts like a
 * known flag (for example `--dns-foo`), because the policy cannot tell whether it takes a value.
 */
function ruleOf(name: string, rules: Readonly<Record<string, FlagRule>>): FlagRule | undefined {
  return Object.prototype.hasOwnProperty.call(rules, name) ? rules[name] : undefined;
}

export function takesValue(rule: FlagRule): boolean {
  return rule.kind === 'check' || rule.value;
}

/** A rule whose value is checked: `check`, or `remove` with a check (review round 8, S8-6). */
export function checksValue(rule: FlagRule): boolean {
  return rule.kind === 'check' || (rule.kind === 'remove' && rule.check !== undefined);
}

/**
 * Splits arguments into flags with their values, following the rules for which flags take a value, as Docker reads
 * them: a flag that takes a value takes the next argument, also one that starts with `-`. An entry that is no text is
 * never a flag or a value (the Dev Container CLI would not pass it on as one): it is an argument of its own.
 */
export function parseFlags(args: readonly unknown[], rules: Readonly<Record<string, FlagRule>>): ParsedFlag[] {
  const flags: ParsedFlag[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (typeof arg !== 'string') {
      flags.push({ index: i, name: undefined, rule: undefined, value: undefined, form: 'none', raw: String(JSON.stringify(arg)) });
      continue;
    }
    const raw = arg;
    if (!raw.startsWith('-') || raw === '-' || raw === '--') {
      flags.push({ index: i, name: undefined, rule: undefined, value: undefined, form: 'none', raw });
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      name = eq < 0 ? raw : raw.slice(0, eq);
      inline = eq < 0 ? undefined : raw.slice(eq + 1);
    } else {
      name = raw.slice(0, 2);
      inline = raw.length > 2 ? raw.slice(2).replace(/^=/, '') : undefined;
    }
    const rule = ruleOf(name, rules);
    if (!rule) {
      // An unknown long flag without `=` probably takes the next argument as its value.
      const skipsNext = raw.startsWith('--') && inline === undefined && typeof next === 'string' && !next.startsWith('-');
      flags.push({ index: i, name, rule: undefined, value: undefined, form: 'none', raw });
      if (skipsNext) i++;
      continue;
    }
    if (!takesValue(rule)) {
      if (!raw.startsWith('--') && raw.length > 2 && raw[2] !== '=') {
        // A group of short flags (`-it`): Docker reads each letter as a flag. Each gets its own entry with the index of
        // the group when all of them are flags without a value; otherwise the group is not known here.
        const group = [...raw.slice(1)].map((letter) => `-${letter}`);
        const groupRules = group.map((member) => ruleOf(member, rules));
        if (groupRules.every((memberRule) => memberRule !== undefined && !takesValue(memberRule))) {
          group.forEach((member, n) => {
            flags.push({ index: i, name: member, rule: groupRules[n], value: undefined, form: 'none', raw });
          });
        } else {
          flags.push({ index: i, name, rule: undefined, value: undefined, form: 'none', raw });
        }
        continue;
      }
      flags.push({ index: i, name, rule, value: inline, form: inline === undefined ? 'none' : 'inline', raw });
      continue;
    }
    if (inline !== undefined) {
      flags.push({ index: i, name, rule, value: inline, form: 'inline', raw });
    } else if (typeof next === 'string') {
      flags.push({ index: i, name, rule, value: next, form: 'next', raw });
      i++;
    } else {
      // Without a value (the end of the list, or an entry that is no text, which is a problem of its own).
      flags.push({ index: i, name, rule, value: undefined, form: 'none', raw });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------------------------------
// CSV fields and lists

/**
 * The fields of the CSV syntax of `--mount`, for example `type=bind,"source=/a,b",target=/c`, as Docker reads them (Go
 * encoding/csv, only the first record). `undefined` for a text that Docker reads otherwise or not at all: a line break
 * (Docker reads only the first line, so fields after it would be checked but not used), or a quote that does not enclose
 * a whole field.
 */
export function csvFields(text: string): string[] | undefined {
  if (/[\r\n]/.test(text)) return undefined;
  const fields: string[] = [];
  let i = 0;
  for (;;) {
    let field = '';
    if (text[i] === '"') {
      for (i++; ; ) {
        if (i >= text.length) return undefined;
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break;
          i++;
        }
        field += text[i++];
      }
      i++;
      if (i < text.length && text[i] !== ',') return undefined;
    } else {
      for (; i < text.length && text[i] !== ','; i++) {
        if (text[i] === '"') return undefined;
        field += text[i];
      }
    }
    fields.push(field);
    if (i >= text.length) return fields;
    i++;
  }
}

/** The `key=value` fields of a value of `docker build` (CSV, as buildx reads them), by lower-case key. */
export function optionFields(value: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const field of csvFields(value) ?? value.split(',')) {
    const equals = field.indexOf('=');
    if (equals > 0) fields.set(field.slice(0, equals).trim().toLowerCase(), field.slice(equals + 1).trim());
  }
  return fields;
}

/**
 * `mounts`, `capAdd`, and `securityOpt` as the Dev Container CLI reads them from each metadata entry
 * (`[].concat(...entries.filter(Boolean))`): a list, or a single value in place of a list, which still reaches
 * `docker run`; nothing for a false-like value.
 */
export function cliList(value: unknown): unknown[] {
  return value ? ([] as unknown[]).concat(value) : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// Mounts

/** A mount of `mounts`, `--mount`, or `-v`. */
export interface MountSpec {
  /** Lower case. `undefined` when the entry names none. */
  type?: string;
  source?: string;
  /** Review round 14 (S14-1): the target (`target`, `dst`, or `destination`). */
  target?: string;
  /**
   * Options of the volume other than `volume-nocopy` and `volume-subpath`: `volume-driver` and `volume-opt` (a "volume"
   * that can be a folder of the computer) and `volume-label` (labels of a volume that the mount creates, for example the
   * labels by which the extension restores the environments of a lost registry).
   */
  volumeOptions: boolean;
  /**
   * Of `volumeOptions`: an option other than `volume-driver` and `volume-opt` (for example `volume-label`). Such a mount
   * stays refused with the host access checks off: the labels are those by which the extension tells the volumes of the
   * environments apart.
   */
  otherVolumeOptions?: boolean;
  /** The text, when it cannot be read as Docker reads it (csvFields). */
  unreadable?: string;
  /** Review of unit 15: `bind-propagation`, as written. */
  propagation?: string;
}

/** Parses the `--mount` syntax. The type stays `undefined` when the text names none. */
export function parseMountString(spec: string): MountSpec {
  const mount: MountSpec = { volumeOptions: false };
  const fields = csvFields(spec);
  if (!fields) return { volumeOptions: false, unreadable: spec };
  for (const field of fields) {
    const index = field.indexOf('=');
    const key = (index < 0 ? field : field.slice(0, index)).trim().toLowerCase();
    const value = index < 0 ? '' : field.slice(index + 1).trim();
    if (key === 'type') mount.type = value.toLowerCase();
    else if (key === 'source' || key === 'src') mount.source = value;
    else if (key === 'target' || key === 'dst' || key === 'destination') mount.target = value;
    else if (key === 'bind-propagation') mount.propagation = value;
    else if (key.startsWith('volume-') && key !== 'volume-nocopy' && key !== 'volume-subpath') {
      mount.volumeOptions = true;
      if (key !== 'volume-driver' && key !== 'volume-opt') mount.otherVolumeOptions = true;
    }
  }
  return mount;
}

/**
 * A mount of `mounts` in the string or the object form. The Dev Container CLI gives Docker an object as the text
 * `type=<type>,src=<source>,dst=<target>`, without quotes, so a comma in a value adds fields (for example a target
 * `/x,type=bind,src=/`): that text is checked.
 */
export function parseMountEntry(entry: unknown): MountSpec {
  if (typeof entry === 'string') return parseMountString(entry);
  if (!isRecord(entry)) return { type: 'unknown', volumeOptions: false };
  const mount = parseMountString(objectMountText(entry));
  const keys = Object.keys(entry).filter((key) => /^volume(-?(driver|opt|options|label|labels))$/i.test(key));
  if (keys.length > 0) mount.volumeOptions = true;
  if (keys.some((key) => !/^volume-?(driver|opt)$/i.test(key))) mount.otherVolumeOptions = true;
  return mount;
}

/** The `--mount` text that the Dev Container CLI makes of a mount in the object form: `type=…,src=…,dst=…`. */
export function objectMountText(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  if (entry.type !== undefined) parts.push(`type=${String(entry.type)}`);
  if (entry.source) parts.push(`src=${String(entry.source)}`);
  parts.push(`dst=${String(entry.target)}`);
  return parts.join(',');
}

/** A mount source is a folder of the computer when it looks like a path; otherwise it is the name of a volume. */
export function isPathSource(source: string): boolean {
  return /[\\/]/.test(source) || source.startsWith('.') || source.startsWith('~') || /^[A-Za-z]:/.test(source);
}

/**
 * The source of a bind mount as an item shows it (hotfix review 4, Q2): normalized (`.` and `..` resolved, repeated
 * separators joined), a drive path (`C:\…`) as on Windows, any other as on posix; a relative path keeps a leading `./`.
 * The item is truncated later (MAX_ITEM_LENGTH), which keeps only the start and the end: without the normalization, a
 * source such as `/Users/me/proj/./././…/../../../Users/me/.ssh/./././…` would hide in the middle what Docker mounts.
 */
export function shownBindSource(source: string): string {
  if (/^[A-Za-z]:/.test(source)) return path.win32.normalize(source);
  const normalized = path.posix.normalize(source);
  if (source.startsWith('/') || /^[./~]/.test(normalized)) return normalized;
  return `./${normalized}`;
}

/** The type of a mount: without a type, a path is a bind mount and a name a volume (Docker's default of --mount). */
export function mountType(mount: MountSpec): string {
  const source = mount.source ?? '';
  return mount.type ?? (source !== '' && isPathSource(source) ? 'bind' : 'volume');
}

/**
 * Source of a `-v`/`--volume` value `source:target[:options]`; `undefined` for an anonymous volume (only a target).
 * A colon of a Windows drive letter does not end the source.
 */
export function volumeFlagSource(spec: string): string | undefined {
  const start = /^[A-Za-z]:[\\/]/.test(spec) ? 2 : 0;
  const index = spec.indexOf(':', start);
  return index > 0 ? spec.slice(0, index) : undefined;
}

/**
 * Review round 14 (S14-1): the target of a `-v`/`--volume` value `source:target[:options]` (after volumeFlagSource, the
 * text up to the next colon), or `target[:options]` of an anonymous volume: without a colon, the value; when the text
 * after the first colon is no absolute path (for example `/data:ro`), the text before it, as Docker reads it.
 */
export function volumeFlagTarget(spec: string): string {
  const source = volumeFlagSource(spec);
  if (source === undefined) return spec;
  const rest = spec.slice(source.length + 1);
  const index = rest.indexOf(':');
  const target = index >= 0 ? rest.slice(0, index) : rest;
  return target.startsWith('/') ? target : source;
}

/**
 * Review of unit 15: the options of a `-v`/`--volume` value (after the target, volumeFlagTarget), comma-separated, for
 * example `ro,rshared`.
 */
export function volumeFlagOptions(spec: string): string[] {
  const source = volumeFlagSource(spec);
  if (source === undefined) return [];
  const rest = spec.slice(source.length + 1);
  // `/data:ro`: Docker reads the text before the colon as the target (volumeFlagTarget), and the rest as the options.
  const index = rest.startsWith('/') ? rest.indexOf(':') : -1;
  const options = rest.startsWith('/') ? (index < 0 ? '' : rest.slice(index + 1)) : rest;
  return options.split(',').filter((option) => option !== '');
}

// ---------------------------------------------------------------------------------------------------------------------
// Networks and ports

/**
 * The networks of a `--network` value as Docker reads it: the value itself, or, as soon as it has a `key=value` pair,
 * each `name` of its long form `name=<network>[,alias=…]` (CSV). `undefined` for a text that Docker would read otherwise
 * (csvFields).
 */
export function networkNames(value: string): string[] | undefined {
  if (!/\w+=\w+/.test(value)) return [value];
  const fields = csvFields(value);
  if (!fields) return undefined;
  const networks: string[] = [];
  for (const field of fields) {
    const index = field.indexOf('=');
    if (index > 0 && field.slice(0, index).trim().toLowerCase() === 'name') networks.push(field.slice(index + 1));
  }
  return networks;
}

/** The network modes of Docker that name no network of their own. */
export function isDockerNetworkMode(name: string): boolean {
  return /^(host|none|bridge|default)$/i.test(name) || /^(container|service):/i.test(name);
}

/** Loopback addresses: 127.0.0.0/8 and ::1. */
export function isLoopbackAddress(address: string): boolean {
  const plain = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain) || plain === '::1' || /^(0{1,4}:){7}0{0,3}1$/.test(plain);
}

/**
 * The address of a published port (`-p`, `appPort`): `[ip:]hostPort:containerPort[/protocol]`, `containerPort`, or
 * `[ipv6]:hostPort:containerPort`. `address` is `undefined` when the value names none, `''` for an empty address.
 */
export function splitPortAddress(spec: string): { address: string | undefined; ports: string } {
  if (spec.startsWith('[')) {
    const end = spec.indexOf(']');
    if (end > 0 && spec[end + 1] === ':') return { address: spec.slice(0, end + 1), ports: spec.slice(end + 2) };
  }
  const parts = spec.split(':');
  if (parts.length <= 2) return { address: undefined, ports: spec };
  return { address: parts.slice(0, -2).join(':'), ports: parts.slice(-2).join(':') };
}

/** `-p` and `appPort` values without an address get 127.0.0.1: `8080:80` → `127.0.0.1:8080:80`, `80` → `127.0.0.1::80`. */
export function withLoopbackAddress(spec: string): string {
  const trimmed = spec.trim();
  // The long syntax has no address (portProblems refuses it); a prefix would only hide it.
  if (trimmed.includes('=')) return trimmed;
  const { address, ports } = splitPortAddress(trimmed);
  if (address !== undefined && address !== '') return trimmed;
  return ports.includes(':') ? `127.0.0.1:${ports}` : `127.0.0.1::${ports}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Build contexts

/**
 * Review round 1 of PR #130 (A-F2): the image of a build context `docker-image://<image>`, by the exact lower-case
 * prefix that Buildx takes (no trimming: Buildx reads ` docker-image://…` or `DOCKER-IMAGE://…` as a path); else
 * `undefined`.
 */
export function imageContext(source: string): string | undefined {
  return source.startsWith('docker-image://') ? source.slice('docker-image://'.length) : undefined;
}

/** Review round 1 of PR #130 (A-F2): a build context that Buildx fetches as a URL (exact lower-case `http://`, `https://`). */
export function isUrlContext(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://');
}

/**
 * The folder of a local build context (`--build-context`, `additional_contexts`): the path itself, or the path of an
 * `oci-layout://<path>[:<tag>][@<digest>]` layout. `undefined` only for what Buildx never reads from the files of the
 * build client, each by its exact prefix: an image (`docker-image://`), a URL (`http://`, `https://`), and a target of
 * the build (`target:`, and `service:`, which Docker Compose makes a target). Review round 2 of PR #130 (D1): Buildx
 * reads every other value as a path (bake `cwd://<path>` as `<path>`; a Git reference that it cannot parse, another
 * scheme, or a prefix in another case or after a space, relative to its working folder), so it is checked as written:
 * a relative path, which the checks refuse whatever the switch says.
 */
export function localContextPath(source: string): string | undefined {
  if (imageContext(source) !== undefined || isUrlContext(source) || source.startsWith('target:') || source.startsWith('service:')) return undefined;
  const text = source.trim();
  const oci = /^oci-layout:\/\/(.*)$/i.exec(text);
  if (oci) {
    let folder = oci[1].replace(/@[a-z0-9]+:[0-9a-f]+$/i, '');
    const last = folder.lastIndexOf('/');
    const colon = folder.indexOf(':', last + 1);
    if (colon >= 0) folder = folder.slice(0, colon);
    return folder;
  }
  return text;
}
