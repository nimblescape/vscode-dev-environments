// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Host access policy (concept section 9 "Host access"): a dev container may use the network, and nothing else of the
// computer. Its published ports reach the computer only on localhost (not with `--network host`, where the ports of the
// container are ports of the computer on the addresses that it listens on). The open pipeline checks the configuration
// before every build and before every `devcontainer up`, and refuses a configuration that needs more; it never changes
// one silently. Pure functions, no I/O.
import { ENVIRONMENT_VOLUME_PATTERN, HELPER_CACHE_VOLUME } from '../names';

export interface HostAccessInput {
  /** The repository configuration, as `devcontainer read-configuration` resolved it (`configuration`). */
  config?: Record<string, unknown>;
  /** `mergedConfiguration` of `devcontainer read-configuration --include-merged-configuration`. */
  merged?: Record<string, unknown>;
  /** Entries of the label devcontainer.metadata of the environment image: base image, Features, configuration. */
  metadata?: readonly unknown[];
  /**
   * The workspace volume of the environment: the only volume named like the workspace volume of an environment
   * (ENVIRONMENT_VOLUME_PATTERN) that a mount may use.
   */
  ownVolume: string;
}

/**
 * The items of hostAccessProblems in two lists, each in order and without duplicates: `hostAccess`, settings that need
 * access to the computer (a rule of the policy refuses them), and `unsupported`, settings that the policy does not know
 * (unknown flags of `runArgs` and options of `build.options`, arguments that are no flag, and entries that are no text),
 * which it refuses because it cannot tell what they do.
 */
export interface HostAccessReport {
  hostAccess: string[];
  unsupported: string[];
}

/** A problem of the configuration: its text, and whether it needs access to the computer or is not supported. */
interface Problem {
  item: string;
  kind: 'hostAccess' | 'unsupported';
}

const access = (item: string): Problem => ({ item, kind: 'hostAccess' });
const accessAll = (items: readonly string[]): Problem[] => items.map(access);
const unsupported = (item: string): Problem => ({ item, kind: 'unsupported' });

/** How a flag of `docker run` or `docker build` is treated. */
type FlagRule =
  | { kind: 'allow'; value: boolean }
  | { kind: 'refuse'; value: boolean; item?: string }
  | { kind: 'check'; check: (value: string) => string[] };

const allowValue: FlagRule = { kind: 'allow', value: true };
const allowFlag: FlagRule = { kind: 'allow', value: false };
const refuseValue: FlagRule = { kind: 'refuse', value: true };

// Allowed: the network (every mode, also `host`, except the network of another container, see networkProblems), names,
// environment variables, limits, the platform, tmpfs mounts, and the user. Everything that reaches files, devices,
// namespaces, or privileges of the computer is refused; an unknown flag too. The network stays as Docker gives it: the
// extension adds no `--network`, no DNS, and no rule for outgoing traffic, so a container reaches what the computer
// reaches, also through a VPN of the computer (concept section 9 "Host access").
// Assumption (V-7): with Docker Desktop on macOS, the outgoing traffic of containers goes through the network stack of
// the computer, so VPN routes and the DNS of the computer apply; this must be checked on Windows (WSL 2) and on Linux
// with Docker Engine (NAT through the routing table of the host).
const RUN_FLAGS: Readonly<Record<string, FlagRule>> = {
  '--network': { kind: 'check', check: (value) => networkProblems(value) },
  '--net': { kind: 'check', check: (value) => networkProblems(value) },
  '--add-host': allowValue,
  '--init': allowFlag,
  '--label': allowValue,
  '-l': allowValue,
  '--hostname': allowValue,
  '-h': allowValue,
  '--env': allowValue,
  '-e': allowValue,
  // docker run reads it in the workspace helper, where it is a file of the volume.
  '--env-file': allowValue,
  '--shm-size': allowValue,
  '--ulimit': allowValue,
  '-m': allowValue,
  '--cpus': allowValue,
  '--user': allowValue,
  '-u': allowValue,
  '--workdir': allowValue,
  '-w': allowValue,
  // As in `build.options`: the platform of the image.
  '--platform': allowValue,
  // A file system in memory, as a mount of the type tmpfs.
  '--tmpfs': allowValue,
  // Replaced by the name of the environment (withoutNameArgs).
  '--name': allowValue,
  '--cap-add': { kind: 'check', check: (value) => capabilityProblems([value]) },
  '--security-opt': { kind: 'check', check: (value) => securityOptionProblems([value]) },
  '-p': { kind: 'check', check: (value) => portProblems(value) },
  '--publish': { kind: 'check', check: (value) => portProblems(value) },
  '-P': { kind: 'refuse', value: false, item: 'publishing all ports (-P)' },
  '--publish-all': { kind: 'refuse', value: false, item: 'publishing all ports (--publish-all)' },
  '--privileged': { kind: 'refuse', value: false, item: 'privileged mode' },
  '--device': refuseValue,
  '--device-cgroup-rule': refuseValue,
  '--gpus': refuseValue,
  '--pid': refuseValue,
  '--ipc': refuseValue,
  '--uts': refuseValue,
  '--userns': refuseValue,
  '--cgroupns': refuseValue,
  '--volumes-from': refuseValue,
  // Checked in runArgsProblems with the rules of `mounts`: only volumes (not of another environment) and tmpfs.
  '-v': allowValue,
  '--volume': allowValue,
  '--mount': allowValue,
};

/** `--dns*` and `--memory*`: all of these flags take a value and are allowed. */
const RUN_FLAG_PREFIXES: readonly string[] = ['--dns', '--memory'];

const BUILD_FLAGS: Readonly<Record<string, FlagRule>> = {
  '--network': allowValue,
  '--add-host': allowValue,
  '--build-arg': allowValue,
  '--target': allowValue,
  '--label': allowValue,
  '--platform': allowValue,
  '--pull': allowFlag,
  '--no-cache': allowFlag,
  '--secret': refuseValue,
  '--ssh': refuseValue,
  '--allow': refuseValue,
  '--output': refuseValue,
  '-o': refuseValue,
  '--build-context': { kind: 'check', check: (value) => buildContextProblems(value) },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Items (for Messages.hostAccess) of everything in the configuration that needs access to the computer, or that the
 * policy does not know, in order and without duplicates. Empty when the configuration may be used. Checked: the
 * repository configuration (`runArgs`, as written and as the override configuration passes them to Docker, `appPort`,
 * `build.options`, and the properties below), the merged configuration, and the image metadata (`mounts`,
 * `privileged`, `capAdd`, `securityOpt`, `hostRequirements.gpu`, `initializeCommand`). hostAccessReport splits them.
 */
export function hostAccessProblems(input: HostAccessInput): string[] {
  return hostAccessFindings(input).map((problem) => problem.item);
}

/** The items of hostAccessProblems, split into settings that need access to the computer and unknown settings. */
export function hostAccessReport(input: HostAccessInput): HostAccessReport {
  const report: HostAccessReport = { hostAccess: [], unsupported: [] };
  for (const problem of hostAccessFindings(input)) report[problem.kind].push(problem.item);
  return report;
}

function hostAccessFindings(input: HostAccessInput): Problem[] {
  const problems: Problem[] = [];
  const add = (found: readonly Problem[]): void => {
    for (const problem of found) if (!problems.some((known) => known.item === problem.item)) problems.push(problem);
  };
  const sources: Record<string, unknown>[] = [];
  if (input.config) sources.push(input.config);
  if (input.merged) sources.push(input.merged);
  for (const entry of input.metadata ?? []) if (isRecord(entry)) sources.push(entry);

  for (const source of sources) {
    // Read as the Dev Container CLI merges them: any true-like `privileged`, and a single value in place of a list.
    for (const mount of cliList(source.mounts)) add(accessAll(mountProblems(parseMountEntry(mount), input.ownVolume)));
    if (source.privileged) add([access('privileged mode')]);
    add(accessAll(capabilityProblems(cliList(source.capAdd))));
    add(accessAll(securityOptionProblems(cliList(source.securityOpt))));
    const gpu = isRecord(source.hostRequirements) ? source.hostRequirements.gpu : undefined;
    if (gpu !== undefined && gpu !== false && gpu !== null) add([access('GPU access (hostRequirements.gpu)')]);
    // It would run in the workspace helper, which has the Docker socket.
    if (hasCommand(source.initializeCommand)) add([access('initializeCommand')]);
  }
  for (const source of [input.config, input.merged]) {
    if (!source) continue;
    if (Array.isArray(source.runArgs)) {
      add(runArgsFindings(source.runArgs, input.ownVolume));
      // What Docker gets: the same list without `--name`, and with 127.0.0.1 for published ports.
      add(runArgsFindings(overrideRunArgs(source.runArgs), input.ownVolume));
    }
    if (source.appPort !== undefined) add(accessAll(appPortProblems(source.appPort)));
    const build = isRecord(source.build) ? source.build : undefined;
    if (build && Array.isArray(build.options)) add(buildOptionFindings(build.options));
  }
  return problems;
}

/**
 * `mounts`, `capAdd`, and `securityOpt` as the Dev Container CLI reads them from each metadata entry
 * (`[].concat(...entries.filter(Boolean))`): a list, or a single value in place of a list, which still reaches
 * `docker run`; nothing for a false-like value.
 */
function cliList(value: unknown): unknown[] {
  return value ? ([] as unknown[]).concat(value) : [];
}

function hasCommand(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mounts

/** A mount of `mounts`, `--mount`, or `-v`. */
export interface MountSpec {
  /** Lower case. `undefined` when the entry names none. */
  type?: string;
  source?: string;
  /** `volume-driver` or `volume-opt` are set: a "volume" that can be a folder of the computer. */
  volumeOptions: boolean;
  /** The text, when it cannot be read as Docker reads it (csvFields). */
  unreadable?: string;
}

/**
 * The fields of the CSV syntax of `--mount`, for example `type=bind,"source=/a,b",target=/c`, as Docker reads them (Go
 * encoding/csv, only the first record). `undefined` for a text that Docker reads otherwise or not at all: a line break
 * (Docker reads only the first line, so fields after it would be checked but not used), or a quote that does not enclose
 * a whole field.
 */
function csvFields(text: string): string[] | undefined {
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
    else if (key === 'volume-driver' || key === 'volume-opt') mount.volumeOptions = true;
  }
  return mount;
}

/**
 * A mount of `mounts` in the string or the object form. The Dev Container CLI gives Docker an object as the text
 * `type=<type>,src=<source>,dst=<target>`, without quotes, so a comma in a value adds fields (for example a target
 * `/x,type=bind,src=/`): that text is checked.
 */
function parseMountEntry(entry: unknown): MountSpec {
  if (typeof entry === 'string') return parseMountString(entry);
  if (!isRecord(entry)) return { type: 'unknown', volumeOptions: false };
  const parts: string[] = [];
  if (entry.type !== undefined) parts.push(`type=${String(entry.type)}`);
  if (entry.source) parts.push(`src=${String(entry.source)}`);
  parts.push(`dst=${String(entry.target)}`);
  const mount = parseMountString(parts.join(','));
  if ('volumeDriver' in entry || 'volumeOptions' in entry || 'volume-driver' in entry || 'volume-opt' in entry) {
    mount.volumeOptions = true;
  }
  return mount;
}

/** A mount source is a folder of the computer when it looks like a path; otherwise it is the name of a volume. */
export function isPathSource(source: string): boolean {
  return /[\\/]/.test(source) || source.startsWith('.') || source.startsWith('~') || /^[A-Za-z]:/.test(source);
}

/** Only `type=volume` (not of another environment or the helper) and `type=tmpfs` are allowed. */
function mountProblems(mount: MountSpec, ownVolume: string): string[] {
  if (mount.unreadable !== undefined) return [`mount ${JSON.stringify(mount.unreadable)}`];
  const source = mount.source ?? '';
  // Without a type, a path is a bind mount, a name a volume (Docker's default of --mount).
  const type = mount.type ?? (source !== '' && isPathSource(source) ? 'bind' : 'volume');
  if (type === 'tmpfs') return [];
  if (type === 'bind' || (type === 'volume' && isPathSource(source))) return [source ? `bind mount ${source}` : 'bind mount'];
  if (type !== 'volume') return [`mount of the type ${type}`];
  if (mount.volumeOptions) return [`volume options of the mount ${source || '(anonymous volume)'}`];
  return volumeNameProblems(source, ownVolume);
}

function volumeNameProblems(name: string, ownVolume: string): string[] {
  if (name === '' || name === ownVolume) return [];
  if (name === HELPER_CACHE_VOLUME) return [`volume ${name} of the workspace helper`];
  if (ENVIRONMENT_VOLUME_PATTERN.test(name)) return [`volume ${name} of another environment`];
  return [];
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

function volumeFlagProblems(value: string, ownVolume: string): string[] {
  const source = volumeFlagSource(value);
  if (source === undefined) return [];
  if (isPathSource(source)) return [`bind mount ${source}`];
  return volumeNameProblems(source, ownVolume);
}

// ---------------------------------------------------------------------------------------------------------------------
// Privileges and ports

/**
 * `--network container:<name>` shares the network namespace of another container, for example of an environment of
 * another account: its services on localhost. Every other network, also `host`, is allowed. With `host` (and macvlan or
 * ipvlan), Docker ignores `-p`, so the ports of the container are not limited to localhost (concept section 9 "Host
 * access", exception).
 */
function networkProblems(value: string): string[] {
  const network = value.trim();
  return /^container:/i.test(network) ? [`network of another container (${network})`] : [];
}

function capabilityProblems(values: readonly unknown[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    const name = String(value).trim();
    if (/^(CAP_)?SYS_PTRACE$/i.test(name)) continue;
    items.push(`capability ${name}`);
  }
  return items;
}

function securityOptionProblems(values: readonly unknown[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    const option = String(value).trim();
    if (/^seccomp[=:]unconfined$/i.test(option)) continue;
    items.push(`security option ${option}`);
  }
  return items;
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

/** A port that names an address other than a loopback address. Without an address, the extension adds 127.0.0.1. */
function portProblems(spec: string): string[] {
  const { address } = splitPortAddress(spec.trim());
  if (address === undefined || address === '' || isLoopbackAddress(address)) return [];
  return [`published port ${spec.trim()}`];
}

function appPortProblems(appPort: unknown): string[] {
  const ports = Array.isArray(appPort) ? appPort : [appPort];
  const items: string[] = [];
  for (const port of ports) {
    // A number is published on 127.0.0.1 by the Dev Container CLI itself.
    if (typeof port === 'number') continue;
    if (typeof port === 'string') items.push(...portProblems(port));
    else items.push(`published port ${JSON.stringify(port)}`);
  }
  return items;
}

/** `-p` and `appPort` values without an address get 127.0.0.1: `8080:80` → `127.0.0.1:8080:80`, `80` → `127.0.0.1::80`. */
export function withLoopbackAddress(spec: string): string {
  const trimmed = spec.trim();
  const { address, ports } = splitPortAddress(trimmed);
  if (address !== undefined && address !== '') return trimmed;
  return ports.includes(':') ? `127.0.0.1:${ports}` : `127.0.0.1::${ports}`;
}

/**
 * `appPort` for the override configuration (concept section 9 "Host access"): each port on 127.0.0.1. A number `n` is
 * `127.0.0.1:n:n` (as the Dev Container CLI publishes it), a string gets 127.0.0.1 when it names no address.
 * `undefined` without ports.
 */
export function loopbackAppPorts(appPort: unknown): string[] | undefined {
  if (appPort === undefined || appPort === null) return undefined;
  const ports = Array.isArray(appPort) ? appPort : [appPort];
  const result: string[] = [];
  for (const port of ports) {
    if (typeof port === 'number') result.push(`127.0.0.1:${port}:${port}`);
    else if (typeof port === 'string' && port.trim() !== '') result.push(withLoopbackAddress(port));
  }
  return result.length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Flags of `docker run` and `docker build`

interface ParsedFlag {
  /** Index of the flag in the arguments. */
  index: number;
  /** The flag name, for example `--publish` or `-p`. `undefined` for an argument that is not a flag. */
  name: string | undefined;
  rule: FlagRule | undefined;
  value: string | undefined;
  /** `next`: the value is the next argument; `inline`: `--x=v`, `-xv`, or `-x=v`. */
  form: 'next' | 'inline' | 'none';
  raw: string;
}

function ruleOf(name: string, rules: Readonly<Record<string, FlagRule>>, prefixes: readonly string[]): FlagRule | undefined {
  if (Object.prototype.hasOwnProperty.call(rules, name)) return rules[name];
  return prefixes.some((prefix) => name.startsWith(prefix)) ? allowValue : undefined;
}

function takesValue(rule: FlagRule): boolean {
  return rule.kind === 'check' || rule.value;
}

/**
 * Splits arguments into flags with their values, following the rules for which flags take a value, as Docker reads
 * them: a flag that takes a value takes the next argument, also one that starts with `-`. An entry that is no text is
 * never a flag or a value (the Dev Container CLI would not pass it on as one): it is an argument of its own.
 */
function parseFlags(
  args: readonly unknown[],
  rules: Readonly<Record<string, FlagRule>>,
  prefixes: readonly string[] = [],
): ParsedFlag[] {
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
    const rule = ruleOf(name, rules, prefixes);
    if (!rule) {
      // An unknown long flag without `=` probably takes the next argument as its value.
      const skipsNext = raw.startsWith('--') && inline === undefined && typeof next === 'string' && !next.startsWith('-');
      flags.push({ index: i, name, rule: undefined, value: undefined, form: 'none', raw });
      if (skipsNext) i++;
      continue;
    }
    if (!takesValue(rule)) {
      // A short boolean flag with more letters (`-Pit`) is a group of flags: unknown here.
      const group = !raw.startsWith('--') && raw.length > 2;
      flags.push({ index: i, name, rule: group ? undefined : rule, value: inline, form: inline === undefined ? 'none' : 'inline', raw });
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

function flagProblems(flag: ParsedFlag, label: (text: string) => string): Problem[] {
  if (flag.name === undefined) return [unsupported(label(`argument ${flag.raw}`))];
  const rule = flag.rule;
  if (!rule) return [unsupported(label(flag.name.startsWith('--') ? flag.name : flag.raw))];
  if (rule.kind === 'allow') return [];
  if (rule.kind === 'refuse') {
    if (rule.item) return [access(rule.item)];
    return [access(label(flag.value !== undefined ? `${flag.name}=${flag.value}` : flag.name))];
  }
  return accessAll(rule.check(flag.value ?? ''));
}

function uniqueItems(problems: readonly Problem[]): string[] {
  const items: string[] = [];
  for (const { item } of problems) if (!items.includes(item)) items.push(item);
  return items;
}

/** `runArgs` (`docker run` arguments of the configuration), with the rules of RUN_FLAGS. */
export function runArgsProblems(runArgs: readonly unknown[], ownVolume: string): string[] {
  return uniqueItems(runArgsFindings(runArgs, ownVolume));
}

function runArgsFindings(runArgs: readonly unknown[], ownVolume: string): Problem[] {
  const problems: Problem[] = [];
  for (const flag of parseFlags(runArgs, RUN_FLAGS, RUN_FLAG_PREFIXES)) {
    if (flag.name === '-v' || flag.name === '--volume') problems.push(...accessAll(volumeFlagProblems(flag.value ?? '', ownVolume)));
    else if (flag.name === '--mount') problems.push(...accessAll(mountProblems(parseMountString(flag.value ?? ''), ownVolume)));
    else problems.push(...flagProblems(flag, (text) => text));
  }
  return problems;
}

/** `build.options` (`docker build` options of the configuration), with the rules of BUILD_FLAGS. */
export function buildOptionProblems(options: readonly unknown[]): string[] {
  return uniqueItems(buildOptionFindings(options));
}

function buildOptionFindings(options: readonly unknown[]): Problem[] {
  const problems: Problem[] = [];
  for (const flag of parseFlags(options, BUILD_FLAGS)) {
    if (flag.rule?.kind === 'check') problems.push(...accessAll(flag.rule.check(flag.value ?? '')));
    else problems.push(...flagProblems({ ...flag, value: undefined }, (text) => `build option ${text}`));
  }
  return problems;
}

/** `--build-context name=value`: an image or a URL is allowed, a folder of the computer is not. */
function buildContextProblems(value: string): string[] {
  const index = value.indexOf('=');
  const source = index < 0 ? value : value.slice(index + 1);
  if (/^(docker-image|https?):\/\//i.test(source)) return [];
  return [`build option --build-context=${value}`];
}

/**
 * `runArgs` without `--name <value>` and `--name=<value>` (the override configuration adds the name of the environment).
 * The flags are read as the policy reads them (parseFlags), so a `--name` that is the value of another flag (for example
 * `--label --name`) stays, and the other arguments keep their meaning for Docker.
 */
export function withoutNameArgs(runArgs: readonly string[]): string[] {
  const dropped = new Set<number>();
  for (const flag of parseFlags(runArgs, RUN_FLAGS, RUN_FLAG_PREFIXES)) {
    if (flag.name !== '--name') continue;
    dropped.add(flag.index);
    if (flag.form === 'next') dropped.add(flag.index + 1);
  }
  return runArgs.filter((_arg, index) => !dropped.has(index));
}

/**
 * The repository part of `runArgs` in the override configuration of `devcontainer up`, the list that Docker gets: the
 * entries that are text (the policy refuses a list with other entries), without `--name` (withoutNameArgs), and with
 * 127.0.0.1 for published ports without an address (loopbackRunArgs). hostAccessProblems checks this list too.
 */
export function overrideRunArgs(runArgs: unknown): string[] {
  const texts = Array.isArray(runArgs) ? runArgs.filter((arg): arg is string => typeof arg === 'string') : [];
  return loopbackRunArgs(withoutNameArgs(texts));
}

/**
 * `runArgs` with 127.0.0.1 for each `-p`/`--publish` that names no address (concept section 9 "Host access": the
 * published ports of a container reach the computer only on localhost). Other arguments stay as they are; `--network host`
 * is left unchanged, and Docker ignores `-p` there.
 */
export function loopbackRunArgs(runArgs: readonly string[]): string[] {
  const result = [...runArgs];
  for (const flag of parseFlags(runArgs, RUN_FLAGS, RUN_FLAG_PREFIXES)) {
    if ((flag.name !== '-p' && flag.name !== '--publish') || flag.value === undefined) continue;
    const value = withLoopbackAddress(flag.value);
    if (flag.form === 'next') result[flag.index + 1] = value;
    else result[flag.index] = flag.name === '--publish' ? `--publish=${value}` : `-p${value}`;
  }
  return result;
}
