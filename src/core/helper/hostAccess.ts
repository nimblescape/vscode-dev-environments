// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Host access policy (concept section 9 "Host access"): a dev container may use the network, and nothing else of the
// computer. Its published ports reach the computer only on localhost (not with `--network host`, where the ports of the
// container are ports of the computer on the addresses that it listens on). The open pipeline checks the configuration
// before every build and before every `devcontainer up`, and refuses a configuration that needs more; it never changes
// one silently: the flags that it removes from `runArgs` (overrideRunArgs) are named in the log (removedRunArgs).
// The checks can be turned off per repository (setting devEnvLauncher.hostAccessChecksOff, ../hostAccessChecks.ts): the
// caller passes the switch, and with the checks off only the refusals of access to the computer (HostAccessClass
// `computer`) are lifted, and published ports keep the address that the configuration gives them. Account separation, the
// identity of the owner account, the integrity of the extension, and the options that the policy does not support stay
// refused (`protected` and `unsupported`); an item whose class is not clear stays refused too.
// Pure functions, no I/O.
import {
  CONTAINER_CONFIG_UNKNOWN_LABEL,
  CONTAINER_VERSION_LABEL,
  ENVIRONMENT_VOLUME_PATTERN,
  HELPER_CACHE_VOLUME,
  HOST_ACCESS_UNRESTRICTED_LABEL,
  LABEL_ENVIRONMENT_ID,
  LABEL_OWNER_ID,
  LABEL_VOLUME,
  VOLUME_KIND_ADDITIONAL,
  WORKSPACES_ROOT,
} from '../names';
import {
  DEV_CONTAINERS_VOLUMES,
  exposingLocalPortHostValues,
  hasDevContainersVolumeLabel,
  isDevContainersCloneVolumeName,
  LOCAL_PORT_HOST_SETTING,
} from '../devContainers';
import { GITHUB_CLI_ACCOUNT_REASON, isContainerGitVariable, isGitHubCliAccountVariable } from './containerGit';

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
  /**
   * Named volumes that environments of other GitHub accounts use (their additional volumes in the registry): a mount
   * may not use them, so that no container of one account shares a volume with a container of another account.
   */
  foreignVolumes?: readonly string[];
  /**
   * The labels of the volumes of mountedVolumeNames that exist, by name (`docker volume inspect`): a mount may not use
   * a volume that another program created (volumeLabelOwner).
   */
  volumeLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * The environment that is checked (its ID and the GitHub user ID of its owner): an existing volume whose devenv labels
   * name it is its own (isOwnVolume) and may be mounted, and so may an additional volume of another environment of the
   * same owner (isSameOwnerAdditionalVolume). Without it, every volume with devenv.environment-id is refused.
   */
  environment?: { id: string; ownerId?: string };
}

/**
 * The items of hostAccessProblems in two lists, each in order and without duplicates: `hostAccess`, settings that need
 * access to the computer (a rule of the policy refuses them), and `unsupported`, settings that the policy does not know
 * (unknown flags of `runArgs` and options of `build.options`, arguments that are no flag, and entries that are no text),
 * which it refuses because it cannot tell what they do, and values of known flags that Dev Environments does not
 * support because they work against how it runs the container (for example `--restart always`).
 */
export interface HostAccessReport {
  hostAccess: string[];
  unsupported: string[];
}

/**
 * The class of a refused item, for the switch of the host access checks (concept section 9 "Host access"):
 * - `computer`: access to the computer (its files, the Docker socket, privileges, devices, namespaces, ports on other
 *   addresses than localhost, volumes of other programs). Refused while the checks are on, allowed while they are off.
 * - `protected`: refused whatever the switch says: account separation (volumes of other environments and accounts, the
 *   cache volume of the workspace helper), the identity of the owner account (variables of container-only Git and of
 *   the GitHub CLI), the integrity of the extension (`initializeCommand`, which would run in the workspace helper next to
 *   the Docker socket), and items whose class is not clear. Reported as access to the computer (Messages.hostAccess).
 * - `unsupported`: options that the policy does not know or does not support (Messages.unsupportedOptions); refused
 *   whatever the switch says.
 */
export type HostAccessClass = 'computer' | 'protected' | 'unsupported';

/** A refused item with its class (hostAccessClassification). */
export interface HostAccessFinding {
  item: string;
  class: HostAccessClass;
}

/** A problem of the configuration: its text and its class. */
interface Problem {
  item: string;
  class: HostAccessClass;
}

/** Access to the computer: lifted while the host access checks are off. */
const access = (item: string): Problem => ({ item, class: 'computer' });
const accessAll = (items: readonly string[]): Problem[] => items.map(access);
/** Refused as access to the computer whatever the switch says (HostAccessClass `protected`). */
const guarded = (item: string): Problem => ({ item, class: 'protected' });
const guardedAll = (items: readonly string[]): Problem[] => items.map(guarded);
const unsupported = (item: string): Problem => ({ item, class: 'unsupported' });

/** How a flag of `docker run` or `docker build` is treated. */
type FlagRule =
  | { kind: 'allow'; value: boolean }
  // Allowed, but not passed to Docker (overrideRunArgs); `reason` tells the log why (removedRunArgs).
  | { kind: 'remove'; value: boolean; reason: string }
  // `guarded`: refused whatever the switch of the host access checks says (HostAccessClass `protected`).
  | { kind: 'refuse'; value: boolean; item?: string; guarded?: boolean }
  | { kind: 'check'; check: (value: string) => Problem[] };

const allowValue: FlagRule = { kind: 'allow', value: true };
const allowFlag: FlagRule = { kind: 'allow', value: false };
const refuseValue: FlagRule = { kind: 'refuse', value: true };

/** A check whose items all need access to the computer (HostAccessClass `computer`). */
function checkAccess(check: (value: string) => string[]): FlagRule {
  return { kind: 'check', check: (value) => accessAll(check(value)) };
}

/** A check whose items stay refused whatever the switch says (HostAccessClass `protected`). */
function checkGuarded(check: (value: string) => string[]): FlagRule {
  return { kind: 'check', check: (value) => guardedAll(check(value)) };
}

const REMOVED_NAME = 'the container gets the name of the environment';
const REMOVED_LIFE_CYCLE = 'Dev Environments stops, starts, and recreates the container; --rm would delete it at each stop';
const REMOVED_TERMINAL = 'the container runs without a terminal; -i with -t would make its start fail';
const REMOVED_DETACH = 'the Dev Container CLI stays attached to the container; -d would make its start fail';
const removeTerminal: FlagRule = { kind: 'remove', value: false, reason: REMOVED_TERMINAL };
const removeDetach: FlagRule = { kind: 'remove', value: false, reason: REMOVED_DETACH };

// Allowed: the network (every mode, also `host`, except the network of another container, see networkProblems), names
// and labels (except those of Dev Environments), environment variables (except those of container-only Git), limits,
// the platform, tmpfs mounts, the user, and flags that only take rights away. Everything that reaches files, devices,
// namespaces, or privileges of the computer is refused; an unknown flag too, because a new flag of Docker can reach the
// computer (for example `--use-api-socket` of Docker 28). The network stays as Docker gives it: the extension adds no
// `--network`, no DNS, and no rule for outgoing traffic, so a container reaches what the computer reaches, also through
// a VPN of the computer (concept section 9 "Host access").
// Assumption (V-7): with Docker Desktop on macOS, the outgoing traffic of containers goes through the network stack of
// the computer, so VPN routes and the DNS of the computer apply; this must be checked on Windows (WSL 2) and on Linux
// with Docker Engine (NAT through the routing table of the host).
// Assumption (V-10): Dev Container CLI 0.89.0 puts the runArgs into `docker run --sig-proxy=false -a STDOUT -a STDERR`
// before its own `--entrypoint /bin/sh`, and runs it without a terminal (no node-pty in the workspace helper).
const RUN_FLAGS: Readonly<Record<string, FlagRule>> = {
  '--network': { kind: 'check', check: networkProblems },
  '--net': { kind: 'check', check: networkProblems },
  '--add-host': allowValue,
  // An address or another name of the container in a network of Docker: network only.
  '--ip': allowValue,
  '--ip6': allowValue,
  '--network-alias': allowValue,
  '--net-alias': allowValue,
  // A note on the container only: nothing is published, because -P is refused.
  '--expose': allowValue,
  '--init': allowFlag,
  // Not a label by which Dev Environments and the Dev Container CLI find and set up the container (labelProblems).
  '--label': { kind: 'check', check: labelProblems },
  '-l': { kind: 'check', check: labelProblems },
  '--hostname': allowValue,
  '-h': allowValue,
  // Not a variable of container-only Git (envProblems).
  // The identity of the owner account: stays refused with the checks off.
  '--env': checkGuarded(envProblems),
  '-e': checkGuarded(envProblems),
  // docker run reads the file in the workspace helper: only a file of the workspace volume (envFileProblems).
  '--env-file': { kind: 'check', check: envFileProblems },
  '--shm-size': allowValue,
  '--ulimit': allowValue,
  '-m': allowValue,
  '--cpus': allowValue,
  // Limits of the CPU time, the CPUs, and the block I/O of the container: resources only.
  '--cpu-shares': allowValue,
  '-c': allowValue,
  '--cpu-period': allowValue,
  '--cpu-quota': allowValue,
  '--cpu-rt-period': allowValue,
  '--cpu-rt-runtime': allowValue,
  '--cpuset-cpus': allowValue,
  '--cpuset-mems': allowValue,
  '--blkio-weight': allowValue,
  // A limit of the number of processes in the container.
  '--pids-limit': allowValue,
  // Only 0 or more: a negative value makes the kernel end other processes of the computer first (oomScoreProblems).
  '--oom-score-adj': { kind: 'check', check: oomScoreProblems },
  // Only the size of the file system of the container (storageOptionProblems).
  '--storage-opt': { kind: 'check', check: storageOptionProblems },
  // For Windows containers; Docker accepts only `default` for a Linux container.
  '--isolation': allowValue,
  '--user': allowValue,
  '-u': allowValue,
  // More groups for the user inside the container; without devices and bind mounts, they open nothing of the computer.
  '--group-add': allowValue,
  '--workdir': allowValue,
  '-w': allowValue,
  // As in `build.options`: the platform of the image.
  '--platform': allowValue,
  // A file system in memory, as a mount of the type tmpfs.
  '--tmpfs': allowValue,
  // Only takes capabilities away from the container.
  '--cap-drop': allowValue,
  // Only makes the file system of the container read-only; volumes and tmpfs mounts stay writable.
  '--read-only': allowFlag,
  // Docker accepts only settings of the namespaces of the container (not `net.*` with --network host).
  '--sysctl': allowValue,
  // The name servers and search domains of the container: network only. `--dns-opt` is Docker's hidden older name of
  // `--dns-option`.
  '--dns': allowValue,
  '--dns-option': allowValue,
  '--dns-opt': allowValue,
  '--dns-search': allowValue,
  // Memory limits of the container: resources only.
  '--memory': allowValue,
  '--memory-reservation': allowValue,
  '--memory-swap': allowValue,
  '--memory-swappiness': allowValue,
  // The health check runs inside the container.
  '--health-cmd': allowValue,
  '--health-interval': allowValue,
  '--health-retries': allowValue,
  '--health-start-period': allowValue,
  '--health-start-interval': allowValue,
  '--health-timeout': allowValue,
  '--no-healthcheck': allowFlag,
  // The signal that `docker stop` sends to the container.
  '--stop-signal': allowValue,
  // Only up to MAX_STOP_TIMEOUT_SECONDS, so that a stop of the Session Monitor ends in time (stopTimeoutProblems).
  '--stop-timeout': { kind: 'check', check: stopTimeoutProblems },
  // Only `no` and `on-failure`: the others start the container together with Docker (restartProblems).
  '--restart': { kind: 'check', check: restartProblems },
  // Only drivers that keep the log in files of the container, or no log (logDriverProblems). Stays refused with the
  // checks off, like the other options of the log (user decision 2026-09-26).
  '--log-driver': checkGuarded(logDriverProblems),
  // Only options of the size, the rotation, and the content of the log (logOptionProblems).
  '--log-opt': { kind: 'check', check: logOptionProblems },
  // No effect: the CLI adds its own --entrypoint after the runArgs, and Docker uses the last one.
  '--entrypoint': allowValue,
  // No effect: the CLI attaches STDOUT and STDERR itself, and Docker connects STDIN only with -i, which is removed.
  '--attach': allowValue,
  '-a': allowValue,
  // Removed before `up` (overrideRunArgs), with a log line: the extension adds the name of the environment.
  '--name': { kind: 'remove', value: true, reason: REMOVED_NAME },
  // Removed: the extension stops, starts, and creates the container again itself; --rm would delete it at each stop.
  '--rm': { kind: 'remove', value: false, reason: REMOVED_LIFE_CYCLE },
  // Removed: the workspace helper has no terminal, so -it fails ("stdin is not a terminal"); alone, they do nothing.
  '--interactive': removeTerminal,
  '-i': removeTerminal,
  '--tty': removeTerminal,
  '-t': removeTerminal,
  // Removed: the CLI stays attached to the container, and Docker refuses -d together with -a.
  '--detach': removeDetach,
  '-d': removeDetach,
  '--cap-add': checkAccess((value) => capabilityProblems([value])),
  '--security-opt': checkAccess((value) => securityOptionProblems([value])),
  '-p': checkAccess(portProblems),
  '--publish': checkAccess(portProblems),
  '-P': { kind: 'refuse', value: false, item: 'publishing all ports (-P)' },
  '--publish-all': { kind: 'refuse', value: false, item: 'publishing all ports (--publish-all)' },
  '--privileged': { kind: 'refuse', value: false, item: 'privileged mode' },
  '--device': refuseValue,
  '--device-cgroup-rule': refuseValue,
  // Limits that name devices of the computer.
  '--device-read-bps': refuseValue,
  '--device-write-bps': refuseValue,
  '--device-read-iops': refuseValue,
  '--device-write-iops': refuseValue,
  '--blkio-weight-device': refuseValue,
  '--gpus': refuseValue,
  // Another runtime of Docker can add devices of the computer (for example `nvidia`).
  '--runtime': refuseValue,
  // A volume plugin decides what a volume is, which can be a folder of the computer.
  '--volume-driver': refuseValue,
  // Mounts the Docker socket and the registry credentials of the computer into the container.
  '--use-api-socket': { kind: 'refuse', value: false, item: 'the Docker socket (--use-api-socket)' },
  // A control group of the computer.
  '--cgroup-parent': refuseValue,
  // Without the OOM killer, a container without a memory limit can make the computer hang. Not named by the user
  // decision on the switch, so it stays refused with the checks off (the safer choice for an unclear item).
  '--oom-kill-disable': { kind: 'refuse', value: false, guarded: true },
  '--pid': refuseValue,
  '--ipc': refuseValue,
  '--uts': refuseValue,
  '--userns': refuseValue,
  '--cgroupns': refuseValue,
  '--volumes-from': refuseValue,
  // Another container, whose environment variables older versions of Docker copy into this one.
  '--link': refuseValue,
  // Checked in runArgsProblems with the rules of `mounts`: only volumes (not of another environment) and tmpfs.
  '-v': allowValue,
  '--volume': allowValue,
  '--mount': allowValue,
};

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
  '--build-context': checkAccess(buildContextProblems),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Items (for Messages.hostAccess) of everything in the configuration that needs access to the computer, or that the
 * policy does not know, in order and without duplicates. Empty when the configuration may be used. Checked: the
 * repository configuration (`runArgs`, as written and as the override configuration passes them to Docker, `appPort`,
 * `build.options`, and the properties below), the merged configuration (the same, except `containerEnv` and
 * `remoteEnv`), and the image metadata (`mounts`, `privileged`, `capAdd`, `securityOpt`, `hostRequirements.gpu`,
 * `initializeCommand`, `remote.localPortHost` of `customizations.vscode.settings`, `containerEnv`, `remoteEnv`).
 * hostAccessReport splits them. `checksOn`: the switch of the repository (../hostAccessChecks.ts); `false` leaves out
 * the items of the class `computer` (hostAccessClassification), and the published ports keep their address.
 */
export function hostAccessProblems(input: HostAccessInput, checksOn = true): string[] {
  return applicable(hostAccessFindings(input, checksOn), checksOn).map((problem) => problem.item);
}

/**
 * The items of hostAccessProblems, split into settings that need access to the computer (the classes `computer` and
 * `protected`) and unknown settings (`unsupported`). `checksOn` as in hostAccessProblems.
 */
export function hostAccessReport(input: HostAccessInput, checksOn = true): HostAccessReport {
  const report: HostAccessReport = { hostAccess: [], unsupported: [] };
  for (const problem of applicable(hostAccessFindings(input, checksOn), checksOn)) {
    report[problem.class === 'unsupported' ? 'unsupported' : 'hostAccess'].push(problem.item);
  }
  return report;
}

/**
 * Every item that the policy refuses while the checks are on, with its class: which of them the switch lifts
 * (`computer`) and which stay refused (`protected`, `unsupported`). For the tests and the documentation of the switch.
 */
export function hostAccessClassification(input: HostAccessInput): HostAccessFinding[] {
  return hostAccessFindings(input, true).map((problem) => ({ item: problem.item, class: problem.class }));
}

/** The problems that the policy refuses with the switch `checksOn`. */
function applicable(problems: readonly Problem[], checksOn: boolean): Problem[] {
  return checksOn ? [...problems] : problems.filter((problem) => problem.class !== 'computer');
}

function hostAccessFindings(input: HostAccessInput, checksOn: boolean): Problem[] {
  const problems: Problem[] = [];
  const add = (found: readonly Problem[]): void => {
    for (const problem of found) {
      const known = problems.find((other) => other.item === problem.item);
      if (!known) problems.push({ ...problem });
      // The same text from two rules (for example the options of two mounts of one volume): the one that the switch does
      // not lift counts.
      else if (known.class === 'computer' && problem.class !== 'computer') known.class = problem.class;
    }
  };
  const volumes = volumeContext(input);
  for (const source of configurationSources(input)) {
    // Read as the Dev Container CLI merges them: any true-like `privileged`, and a single value in place of a list.
    for (const mount of cliList(source.mounts)) add(mountProblems(parseMountEntry(mount), volumes));
    if (source.privileged) add([access('privileged mode')]);
    add(accessAll(capabilityProblems(cliList(source.capAdd))));
    add(accessAll(securityOptionProblems(cliList(source.securityOpt))));
    const gpu = isRecord(source.hostRequirements) ? source.hostRequirements.gpu : undefined;
    if (gpu !== undefined && gpu !== false && gpu !== null) add([access('GPU access (hostRequirements.gpu)')]);
    // It would run in the workspace helper, which has the Docker socket (not on the computer): the integrity of the
    // extension, so it stays refused with the checks off.
    if (hasCommand(source.initializeCommand)) add([guarded('initializeCommand')]);
    add(accessAll(portHostProblems(source.customizations)));
  }
  for (const source of [input.config, input.merged]) {
    if (!source) continue;
    if (Array.isArray(source.runArgs)) {
      add(runArgsFindings(source.runArgs, volumes));
      // What Docker gets: the same list without the removed flags, and (checks on) with 127.0.0.1 for published ports.
      add(runArgsFindings(overrideRunArgs(source.runArgs, checksOn), volumes));
    }
    if (source.appPort !== undefined) add(appPortProblems(source.appPort));
    const build = isRecord(source.build) ? source.build : undefined;
    if (build && Array.isArray(build.options)) add(buildOptionFindings(build.options));
  }
  // Not the merged configuration: for an existing container, it holds the values of the override configuration, also of
  // an earlier version of the extension. The image metadata has none of them (the build runs without it). The identity
  // of the owner account: stays refused with the checks off.
  for (const source of [input.config, ...(input.metadata ?? [])]) if (isRecord(source)) add(guardedAll(environmentProblems(source)));
  return problems;
}

/** The repository configuration, the merged configuration, and the entries of the image metadata that are objects. */
function configurationSources(input: HostAccessInput): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  if (input.config) sources.push(input.config);
  if (input.merged) sources.push(input.merged);
  for (const entry of input.metadata ?? []) if (isRecord(entry)) sources.push(entry);
  return sources;
}

function volumeContext(input: VolumeInput): VolumeContext {
  return {
    own: input.ownVolume,
    foreign: new Set(input.foreignVolumes ?? []),
    labels: input.volumeLabels ?? {},
    environment: input.environment,
  };
}

/** The part of HostAccessInput that decides which named volumes a mount may use. */
export type VolumeInput = Pick<HostAccessInput, 'ownVolume' | 'foreignVolumes' | 'volumeLabels' | 'environment'>;

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

/**
 * The item of a variable that a configuration may not set, or `undefined` when it may: a variable of container-only Git
 * (isContainerGitVariable), named alone, or a variable that chooses the account of the GitHub CLI
 * (isGitHubCliAccountVariable), with the reason. `where` is `containerEnv`, `remoteEnv`, or `runArgs`.
 */
export function refusedVariableItem(name: string, where: string): string | undefined {
  if (isContainerGitVariable(name)) return `variable ${name} in ${where}`;
  if (isGitHubCliAccountVariable(name)) return `variable ${name} in ${where} (${GITHUB_CLI_ACCOUNT_REASON})`;
  return undefined;
}

/**
 * The variables of container-only Git and of the account of the GitHub CLI in `containerEnv` and `remoteEnv` of the
 * configuration or of an entry of the image metadata (refusedVariableItem): the override configuration would replace
 * those that it sets without a word, because its values win, the others (for example GIT_CONFIG_PARAMETERS) would
 * change the configuration of Git in the container, and a token or host of the GitHub CLI would win over the sign-in of
 * the owner account.
 */
function environmentProblems(config: Record<string, unknown>): string[] {
  const items: string[] = [];
  for (const property of ['containerEnv', 'remoteEnv']) {
    const env = config[property];
    if (!isRecord(env)) continue;
    for (const name of Object.keys(env)) {
      const item = refusedVariableItem(name.trim(), property);
      if (item !== undefined) items.push(item);
    }
  }
  return items;
}

/**
 * `remote.localPortHost` other than `localhost` in the VS Code settings of a configuration (exposingLocalPortHostValues,
 * ../devContainers.ts: the window applies the settings of the container, and forwards ports on all addresses of the
 * computer for such a value).
 */
function portHostProblems(customizations: unknown): string[] {
  return exposingLocalPortHostValues(customizations).map((value) => `setting ${LOCAL_PORT_HOST_SETTING} ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Mounts

/** A mount of `mounts`, `--mount`, or `-v`. */
export interface MountSpec {
  /** Lower case. `undefined` when the entry names none. */
  type?: string;
  source?: string;
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
function parseMountEntry(entry: unknown): MountSpec {
  if (typeof entry === 'string') return parseMountString(entry);
  if (!isRecord(entry)) return { type: 'unknown', volumeOptions: false };
  const parts: string[] = [];
  if (entry.type !== undefined) parts.push(`type=${String(entry.type)}`);
  if (entry.source) parts.push(`src=${String(entry.source)}`);
  parts.push(`dst=${String(entry.target)}`);
  const mount = parseMountString(parts.join(','));
  const keys = Object.keys(entry).filter((key) => /^volume(-?(driver|opt|options|label|labels))$/i.test(key));
  if (keys.length > 0) mount.volumeOptions = true;
  if (keys.some((key) => !/^volume-?(driver|opt)$/i.test(key))) mount.otherVolumeOptions = true;
  return mount;
}

/** A mount source is a folder of the computer when it looks like a path; otherwise it is the name of a volume. */
export function isPathSource(source: string): boolean {
  return /[\\/]/.test(source) || source.startsWith('.') || source.startsWith('~') || /^[A-Za-z]:/.test(source);
}

/** What the mounts of an environment may use besides the rules of volumeNameProblems. */
interface VolumeContext {
  /** The workspace volume of the environment. */
  own: string;
  /** The named volumes of environments of other GitHub accounts (HostAccessInput.foreignVolumes). */
  foreign: ReadonlySet<string>;
  /** HostAccessInput.volumeLabels. */
  labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** HostAccessInput.environment. */
  environment: { id: string; ownerId?: string } | undefined;
}

/** The type of a mount: without a type, a path is a bind mount and a name a volume (Docker's default of --mount). */
function mountType(mount: MountSpec): string {
  const source = mount.source ?? '';
  return mount.type ?? (source !== '' && isPathSource(source) ? 'bind' : 'volume');
}

/**
 * Only `type=volume` (not a volume of something else, volumeNameProblems) and `type=tmpfs` are allowed. With the host
 * access checks off (class `computer`), also bind mounts, the named pipes of the computer (`npipe`), and the volume
 * options `volume-driver` and `volume-opt`; the name of the volume is still checked for account separation. A mount
 * that Docker would read otherwise, the types `image`, `cluster`, and unknown types, and other volume options stay
 * refused: what they reach is not clear.
 */
function mountProblems(mount: MountSpec, volumes: VolumeContext): Problem[] {
  if (mount.unreadable !== undefined) return [guarded(`mount ${JSON.stringify(mount.unreadable)}`)];
  const source = mount.source ?? '';
  const type = mountType(mount);
  if (type === 'tmpfs') return [];
  if (type === 'bind' || (type === 'volume' && isPathSource(source))) return [access(source ? `bind mount ${source}` : 'bind mount')];
  if (type === 'npipe') return [access(`mount of the type ${type}`)];
  if (type !== 'volume') return [guarded(`mount of the type ${type}`)];
  const options: Problem[] = [];
  if (mount.volumeOptions) {
    const item = `volume options of the mount ${source || '(anonymous volume)'}`;
    options.push(mount.otherVolumeOptions ? guarded(item) : access(item));
  }
  return [...options, ...volumeNameProblems(source, volumes)];
}

/** The name of the named volume of a mount; `undefined` for other mounts and anonymous volumes. */
function namedVolumeOf(mount: MountSpec): string | undefined {
  const source = mount.source ?? '';
  if (mount.unreadable !== undefined || mountType(mount) !== 'volume' || source === '' || isPathSource(source)) return undefined;
  return source;
}

/** Docker's rule for the name of a volume (local driver). */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;

/**
 * The named volumes that the mounts of the configuration use (`mounts` of every source, `-v`, `--volume`, and `--mount`
 * of runArgs), without the workspace volume and without names that Docker does not accept (for example
 * `${devcontainerId}-history`, which the CLI resolves only at `up`), each once: the volumes whose labels the pipeline
 * reads for HostAccessInput.volumeLabels.
 */
export function mountedVolumeNames(input: HostAccessInput): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined): void => {
    if (name !== undefined && name !== input.ownVolume && VOLUME_NAME.test(name)) names.add(name);
  };
  for (const source of configurationSources(input)) {
    for (const mount of cliList(source.mounts)) add(namedVolumeOf(parseMountEntry(mount)));
  }
  for (const source of [input.config, input.merged]) {
    if (!source || !Array.isArray(source.runArgs)) continue;
    for (const flag of parseFlags(source.runArgs, RUN_FLAGS)) {
      if (flag.value === undefined) continue;
      if (flag.name === '-v' || flag.name === '--volume') {
        const name = volumeFlagSource(flag.value);
        if (name !== undefined && !isPathSource(name)) add(name);
      } else if (flag.name === '--mount') {
        add(namedVolumeOf(parseMountString(flag.value)));
      }
    }
  }
  return [...names];
}

/** Docker's name of an anonymous volume: 64 hexadecimal characters. */
const ANONYMOUS_VOLUME_NAME = /^[0-9a-f]{64}$/;

/**
 * What a volume belongs to by its name alone, `undefined` for any other name: the workspace helper, another environment
 * (named like a workspace volume), another container (an anonymous volume; older Docker versions do not label it), or
 * the Dev Containers extension (DEV_CONTAINERS_VOLUMES). Only for the host access policy: whether a volume
 * is an environment's own is decided by its labels (isOwnVolume).
 */
export function foreignVolumeName(name: string): string | undefined {
  if (name === HELPER_CACHE_VOLUME) return 'the workspace helper';
  if (ENVIRONMENT_VOLUME_PATTERN.test(name)) return 'another environment';
  if (ANONYMOUS_VOLUME_NAME.test(name)) return 'another container';
  if (DEV_CONTAINERS_VOLUMES.includes(name)) return 'the Dev Containers extension';
  return undefined;
}

/**
 * True when the labels of a volume make it the own volume of the environment `environmentId`: devenv.environment-id is
 * that ID, and devenv.owner-id, when both the volume and the environment have an owner, is the owner of the
 * environment. The only rule by which the pipeline records an additional volume and Delete removes one: a volume
 * without these labels (for example one that a version before the labels created, one named with `${devcontainerId}`,
 * which Docker creates at `up`, or one of another program) is never the environment's.
 */
export function isOwnVolume(labels: Readonly<Record<string, string>>, environmentId: string, ownerId: string | undefined): boolean {
  if (labels[LABEL_ENVIRONMENT_ID] !== environmentId) return false;
  const volumeOwner = labels[LABEL_OWNER_ID];
  return volumeOwner === undefined || ownerId === undefined || volumeOwner === ownerId;
}

/**
 * The program that created an existing volume, by its labels, for a volume that a repository did not create by its
 * mounts (Docker gives such a volume no labels): Docker Compose (the volume of a project, for example the data of a
 * database), the Dev Containers extension (hasDevContainersVolumeLabel), Docker itself
 * (an anonymous volume of another container), or Dev Environments (a volume of an environment, devenv.environment-id).
 * `undefined` for a volume without such labels.
 */
export function volumeLabelOwner(labels: Readonly<Record<string, string>>): string | undefined {
  const keys = Object.keys(labels);
  // Before the labels of Docker Compose: a volume of the Compose project of an environment carries both (whether it is
  // the environment's own is decided by isOwnVolume first everywhere).
  if (keys.includes(LABEL_ENVIRONMENT_ID)) return 'another environment';
  if (keys.some((key) => key.startsWith('com.docker.compose.'))) {
    const project = labels['com.docker.compose.project'];
    return project ? `the Docker Compose project ${project}` : 'Docker Compose';
  }
  if (hasDevContainersVolumeLabel(labels)) return 'the Dev Containers extension';
  if (keys.includes('com.docker.volume.anonymous')) return 'another container';
  return undefined;
}

/**
 * True when the labels of a volume make it an additional volume (devenv.volume=additional) of an environment of the
 * GitHub user `ownerId`: devenv.environment-id is set, and devenv.owner-id is set and is that user. The environments of one account share such a volume,
 * for example `${localWorkspaceFolderBasename}-node_modules` of a fork and its upstream repository, or a fixed cache
 * name: each may mount it (mayMountEnvironmentVolume) and records it, so that the Delete of one keeps it while another
 * records it. A volume without the owner label, a workspace volume (no devenv.volume), and every volume when the
 * environment has no owner are not.
 */
export function isSameOwnerAdditionalVolume(labels: Readonly<Record<string, string>>, ownerId: string | undefined): boolean {
  const volumeOwner = labels[LABEL_OWNER_ID];
  return (
    labels[LABEL_ENVIRONMENT_ID] !== undefined &&
    labels[LABEL_VOLUME] === VOLUME_KIND_ADDITIONAL &&
    volumeOwner !== undefined &&
    ownerId !== undefined &&
    volumeOwner === ownerId
  );
}

/**
 * An existing volume with devenv labels that the environment may mount: its own (isOwnVolume), or an additional volume
 * of another environment of the same owner (isSameOwnerAdditionalVolume), whether that environment still exists or its
 * Delete kept the volume. A volume of another account, a volume without an owner label, a workspace volume, and every
 * such volume for an environment without owner are refused.
 */
function mayMountEnvironmentVolume(labels: Readonly<Record<string, string>>, volumes: VolumeContext): boolean {
  const environment = volumes.environment;
  if (!environment) return false;
  return isOwnVolume(labels, environment.id, environment.ownerId) || isSameOwnerAdditionalVolume(labels, environment.ownerId);
}

/**
 * A named volume that belongs to something else: the workspace helper, another environment (named like a workspace
 * volume, used by an environment of another account, or labeled with the ID of another environment that is not an
 * additional volume of the same owner, mayMountEnvironmentVolume), the Dev
 * Containers extension (by name, or an existing volume whose name ends in a hash and that is not the environment's
 * own), or another program that created the volume (its labels, volumeLabelOwner). Other named volumes, for example of
 * the repository (`${localWorkspaceFolderBasename}-node_modules`), are allowed: a volume that does not exist yet is
 * created with the labels of the environment before `up`.
 */
function volumeNameProblems(name: string, volumes: VolumeContext): Problem[] {
  if (name === '' || name === volumes.own) return [];
  // Account separation: the volumes of other environments and the cache volume of the workspace helper, which all
  // environments share, stay refused with the host access checks off. The volumes of other programs (another container,
  // the Dev Containers extension, Docker Compose) are access to the computer.
  if (volumes.foreign.has(name)) return [guarded(`volume ${name} of another environment`)];
  const byName = foreignVolumeName(name);
  if (byName !== undefined) {
    const item = `volume ${name} of ${byName}`;
    return [name === HELPER_CACHE_VOLUME || ENVIRONMENT_VOLUME_PATTERN.test(name) ? guarded(item) : access(item)];
  }
  const labels = volumes.labels[name];
  // Not known to exist.
  if (labels === undefined) return [];
  if (labels[LABEL_ENVIRONMENT_ID] !== undefined) {
    return mayMountEnvironmentVolume(labels, volumes) ? [] : [guarded(`volume ${name} of another environment`)];
  }
  const owner = volumeLabelOwner(labels);
  if (owner !== undefined) return [access(`volume ${name} of ${owner}`)];
  // An existing volume named like a clone volume of the Dev Containers extension (isDevContainersCloneVolumeName), which
  // older versions did not label.
  if (isDevContainersCloneVolumeName(name)) return [access(`volume ${name} of another program`)];
  return [];
}

/**
 * The items of a named volume that belongs to something else (the rules of `mounts`: the workspace helper, another
 * environment, the Dev Containers extension, or another program, by the name and the labels of the volume), for the
 * volumes of a Docker Compose configuration (composeAccess.ts). Empty for the workspace volume and a volume that may be
 * used.
 */
export function volumeNameItems(name: string, input: VolumeInput): string[] {
  return volumeNameProblems(name, volumeContext(input)).map((problem) => problem.item);
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

function volumeFlagProblems(value: string, volumes: VolumeContext): Problem[] {
  const source = volumeFlagSource(value);
  if (source === undefined) return [];
  if (isPathSource(source)) return [access(`bind mount ${source}`)];
  return volumeNameProblems(source, volumes);
}

// ---------------------------------------------------------------------------------------------------------------------
// Privileges and ports

/**
 * `--network container:<name>` shares the network namespace of another container, for example of an environment of
 * another account: its services on localhost. Every other network, also `host`, is allowed. With `host` (and macvlan or
 * ipvlan), Docker ignores `-p`, so the ports of the container are not limited to localhost (concept section 9 "Host
 * access", exception). Docker also reads the long form `name=<network>[,alias=…]`: as soon as the text has a
 * `key=value` pair, it reads the text as CSV with each field in lower case, and the last `name` is the network. Each
 * `name` is checked; a text that Docker would read otherwise (csvFields) is not supported.
 */
function networkProblems(value: string): Problem[] {
  let networks = [value];
  if (/\w+=\w+/.test(value)) {
    const fields = csvFields(value);
    if (!fields) return [unsupported(`network ${JSON.stringify(value)}`)];
    networks = [];
    for (const field of fields) {
      const index = field.indexOf('=');
      if (index > 0 && field.slice(0, index).trim().toLowerCase() === 'name') networks.push(field.slice(index + 1));
    }
  }
  const joined = networks.some((network) => /^container:/i.test(network.trim()));
  return joined ? [access(`network of another container (${value.trim()})`)] : [];
}

/** `capAdd`, `--cap-add`, and `cap_add`: every capability except SYS_PTRACE (for debuggers). */
export function capabilityProblems(values: readonly unknown[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    const name = String(value).trim();
    if (/^(CAP_)?SYS_PTRACE$/i.test(name)) continue;
    items.push(`capability ${name}`);
  }
  return items;
}

/** `securityOpt`, `--security-opt`, and `security_opt`: every option except seccomp=unconfined and no-new-privileges. */
export function securityOptionProblems(values: readonly unknown[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    const option = String(value).trim();
    // Without the seccomp filter (for debuggers); no-new-privileges only takes rights away, whatever its value.
    if (/^seccomp[=:]unconfined$/i.test(option)) continue;
    if (/^no-new-privileges([=:](true|false|1|0|t|f))?$/i.test(option)) continue;
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

/**
 * A port that names an address other than a loopback address. Without an address, the extension adds 127.0.0.1.
 * Docker's long syntax (`published=8080,target=80`: any value with `=`) has no key for the address, so Docker publishes
 * it on all addresses, and an address in front of it becomes part of an unknown key: it is refused.
 */
function portProblems(spec: string): string[] {
  if (spec.includes('=')) return [`published port ${spec.trim()}`];
  const { address } = splitPortAddress(spec.trim());
  if (address === undefined || address === '' || isLoopbackAddress(address)) return [];
  return [`published port ${spec.trim()}`];
}

function appPortProblems(appPort: unknown): Problem[] {
  const ports = Array.isArray(appPort) ? appPort : [appPort];
  const items: Problem[] = [];
  for (const port of ports) {
    // A number is published on 127.0.0.1 by the Dev Container CLI itself.
    if (typeof port === 'number') continue;
    if (typeof port === 'string') items.push(...accessAll(portProblems(port)));
    // Neither a number nor a text: what the Dev Container CLI makes of it is not clear, so it stays refused.
    else items.push(guarded(`published port ${JSON.stringify(port)}`));
  }
  return items;
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
// Values of flags of `docker run`

/** Label keys of Dev Environments (`devenv.`) and of the Dev Container CLI and the Dev Containers extension (`devcontainer.`). */
export const RESERVED_LABEL = /^(devenv|devcontainer)\./i;

/**
 * The labels that the override configuration adds to runArgs itself, with their values. The merged configuration of an
 * existing container holds them too, also `devenv.host-access=unrestricted` of a container created while the host
 * access checks were off, which must not block the open that creates it again once they are on.
 */
const OWN_LABELS: readonly string[] = [CONTAINER_VERSION_LABEL, CONTAINER_CONFIG_UNKNOWN_LABEL, HOST_ACCESS_UNRESTRICTED_LABEL];

/**
 * `--label`: no key of RESERVED_LABEL (compared without case and surrounding spaces), except the exact labels that the
 * override configuration adds itself (OWN_LABELS). In `docker run`, the runArgs come after the id label of the Dev
 * Container CLI (`devenv.environment-id`), and the last label of a key wins: the extension and the Session Monitor would
 * no longer find the container, or take it for another environment.
 */
function labelProblems(value: string): Problem[] {
  if (OWN_LABELS.includes(value)) return [];
  const index = value.indexOf('=');
  const key = (index < 0 ? value : value.slice(0, index)).trim();
  return RESERVED_LABEL.test(key) ? [unsupported(`label ${key}`)] : [];
}

/**
 * `-e`/`--env`: no variable of container-only Git and no variable of the account of the GitHub CLI
 * (refusedVariableItem), with or without a value. `docker run` gets the runArgs after the containerEnv of the override
 * configuration, so the value of the runArgs would win; a `-e NAME` without a value takes the value of the workspace
 * helper, or removes the variable.
 */
function envProblems(value: string): string[] {
  const index = value.indexOf('=');
  const name = (index < 0 ? value : value.slice(0, index)).trim();
  const item = refusedVariableItem(name, 'runArgs');
  return item === undefined ? [] : [item];
}

/**
 * `--env-file`: `docker run` reads the file in the workspace helper, whose working folder is `/`. Only a file of the
 * workspace volume is allowed: an absolute path below WORKSPACES_ROOT without `..`. Other files of the helper include
 * the cache volume that all environments share. Its content is not checked (it can change until the container starts):
 * Docker applies the `-e` values after those of the file, so the variables of the override configuration keep their
 * values; the other variables of Git's configuration in the file are a known limit (concept section 9 "Host access").
 */
function envFileProblems(value: string): Problem[] {
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.');
  const root = WORKSPACES_ROOT.split('/').filter((segment) => segment !== '');
  const inVolume =
    value.startsWith('/') &&
    !segments.includes('..') &&
    segments.length > root.length &&
    root.every((segment, index) => segments[index] === segment);
  // Files of the workspace helper, not of the computer (among them the cache volume that all environments share): stays
  // refused with the checks off.
  return inVolume ? [] : [guarded(`--env-file=${value}`)];
}

/**
 * The longest `--stop-timeout`, in seconds. The Session Monitor ends each of its Docker calls after 30 seconds
 * (MONITOR_DOCKER_TIMEOUT_MS), also `docker stop`, which waits up to the stop timeout of the container before it kills
 * the processes of the container.
 */
export const MAX_STOP_TIMEOUT_SECONDS = 20;

/** `--stop-timeout`: whole seconds up to MAX_STOP_TIMEOUT_SECONDS (-1 would make `docker stop` wait without end). */
function stopTimeoutProblems(value: string): Problem[] {
  const seconds = /^\d+$/.test(value) ? Number(value) : undefined;
  return seconds !== undefined && seconds <= MAX_STOP_TIMEOUT_SECONDS ? [] : [unsupported(`--stop-timeout=${value}`)];
}

/**
 * `--restart`: `no` and `on-failure[:<count>]`. `always` and `unless-stopped` would start the container together with
 * Docker, without a window and outside the Session Monitor (concept 7.9).
 */
function restartProblems(value: string): Problem[] {
  return RESTART_POLICY.test(value) ? [] : [unsupported(`--restart=${value}`)];
}

/** The restart policies that may be used (restartProblems): `no` and `on-failure[:<count>]`. */
export const RESTART_POLICY = /^(no|on-failure(:\d+)?)$/;

/**
 * `--oom-score-adj`: 0 or more, in decimal digits. A negative value makes the kernel end other processes of the
 * computer first when the memory runs out.
 */
function oomScoreProblems(value: string): Problem[] {
  // Not named by the user decision on the switch: stays refused with the checks off (the safer choice).
  return /^\d+$/.test(value) ? [] : [guarded(`--oom-score-adj=${value}`)];
}

/**
 * Log drivers that keep the log in files of the container, or keep none. Other drivers write to a socket or the journal
 * of the computer (syslog, journald, fluentd), or use credentials of Docker (awslogs, gcplogs).
 */
export const LOG_DRIVERS: readonly string[] = ['json-file', 'local', 'none'];

function logDriverProblems(value: string): string[] {
  return LOG_DRIVERS.includes(value.toLowerCase()) ? [] : [`--log-driver=${value}`];
}

/**
 * Keys of `--log-opt`: the size and the rotation of the log files, the mode, and what an entry contains. The options of
 * other drivers name sockets, files, or servers, and apply when Docker uses such a driver by default.
 */
export const LOG_OPTIONS: readonly string[] = [
  'max-size',
  'max-file',
  'compress',
  'mode',
  'max-buffer-size',
  'labels',
  'labels-regex',
  'env',
  'env-regex',
  'tag',
];

function logOptionProblems(value: string): Problem[] {
  const index = value.indexOf('=');
  return LOG_OPTIONS.includes(index < 0 ? value : value.slice(0, index)) ? [] : [unsupported(`--log-opt=${value}`)];
}

/** `--storage-opt`: only `size=<size>`, the size of the file system of the container. */
function storageOptionProblems(value: string): Problem[] {
  return value.startsWith('size=') ? [] : [unsupported(`--storage-opt=${value}`)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Flags of `docker run` and `docker build`

interface ParsedFlag {
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

function takesValue(rule: FlagRule): boolean {
  return rule.kind === 'check' || rule.value;
}

/**
 * Splits arguments into flags with their values, following the rules for which flags take a value, as Docker reads
 * them: a flag that takes a value takes the next argument, also one that starts with `-`. An entry that is no text is
 * never a flag or a value (the Dev Container CLI would not pass it on as one): it is an argument of its own.
 */
function parseFlags(args: readonly unknown[], rules: Readonly<Record<string, FlagRule>>): ParsedFlag[] {
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

function flagProblems(flag: ParsedFlag, label: (text: string) => string): Problem[] {
  if (flag.name === undefined) return [unsupported(label(`argument ${flag.raw}`))];
  const rule = flag.rule;
  if (!rule) return [unsupported(label(flag.name.startsWith('--') ? flag.name : flag.raw))];
  if (rule.kind === 'allow' || rule.kind === 'remove') return [];
  if (rule.kind === 'refuse') {
    const refused = rule.guarded ? guarded : access;
    if (rule.item) return [refused(rule.item)];
    return [refused(label(flag.value !== undefined ? `${flag.name}=${flag.value}` : flag.name))];
  }
  return rule.check(flag.value ?? '');
}

function uniqueItems(problems: readonly Problem[]): string[] {
  const items: string[] = [];
  for (const { item } of problems) if (!items.includes(item)) items.push(item);
  return items;
}

/**
 * `runArgs` (`docker run` arguments of the configuration), with the rules of RUN_FLAGS. `foreignVolumes`: as in
 * HostAccessInput.
 */
export function runArgsProblems(runArgs: readonly unknown[], ownVolume: string, foreignVolumes: readonly string[] = []): string[] {
  return uniqueItems(runArgsFindings(runArgs, volumeContext({ ownVolume, foreignVolumes })));
}

function runArgsFindings(runArgs: readonly unknown[], volumes: VolumeContext): Problem[] {
  const problems: Problem[] = [];
  for (const flag of parseFlags(runArgs, RUN_FLAGS)) {
    const rule = flag.rule;
    // At the end, without its value, the flag would take the next argument that the extension or the CLI adds.
    const last = flag.index === runArgs.length - 1 && flag.value === undefined;
    if (last && rule !== undefined && (rule.kind === 'allow' || rule.kind === 'check') && takesValue(rule)) {
      problems.push(unsupported(`${flag.raw} without a value`));
    } else if (flag.name === '-v' || flag.name === '--volume') {
      problems.push(...volumeFlagProblems(flag.value ?? '', volumes));
    } else if (flag.name === '--mount') {
      problems.push(...mountProblems(parseMountString(flag.value ?? ''), volumes));
    } else {
      problems.push(...flagProblems(flag, (text) => text));
    }
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
    if (flag.rule?.kind === 'check') problems.push(...flag.rule.check(flag.value ?? ''));
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
 * The user that `--user`/`-u` of `runArgs` gives the container, read as Docker reads the arguments (parseFlags, so a
 * `--user` that is the value of another flag does not count): the last one wins, as in `docker run`. `undefined`
 * without one, or when the last one is empty (Docker then uses the user of the image).
 */
export function runArgsUser(runArgs: unknown): string | undefined {
  if (!Array.isArray(runArgs)) return undefined;
  let user: string | undefined;
  for (const flag of parseFlags(runArgs, RUN_FLAGS)) {
    if ((flag.name === '--user' || flag.name === '-u') && flag.value !== undefined) user = flag.value;
  }
  return user === undefined || user.trim() === '' ? undefined : user;
}

/** A flag that overrideRunArgs removes from `runArgs`, for the log. */
export interface RemovedRunArg {
  /** The entry as the configuration writes it, with the next entry when that is its value (for example `--name x`). */
  arg: string;
  /** Why it is removed. */
  reason: string;
}

/**
 * The entries of `runArgs` that are removed (rule `remove`), by index, with their flags, read as the policy reads them
 * (parseFlags): a flag that is the value of another flag (for example `--label --rm`) stays, so the other arguments
 * keep their meaning for Docker. A group of short flags (`-it`) is removed only when each of its flags is. `names`:
 * only these flags.
 */
function removals(runArgs: readonly string[], names?: readonly string[]): Map<number, ParsedFlag[]> {
  const entries = new Map<number, ParsedFlag[]>();
  for (const flag of parseFlags(runArgs, RUN_FLAGS)) {
    entries.set(flag.index, [...(entries.get(flag.index) ?? []), flag]);
  }
  const removes = (flag: ParsedFlag): boolean =>
    flag.rule?.kind === 'remove' && (names === undefined || (flag.name !== undefined && names.includes(flag.name)));
  const removed = new Map<number, ParsedFlag[]>();
  for (const [index, flags] of entries) if (flags.every(removes)) removed.set(index, flags);
  return removed;
}

/** `runArgs` without the entries of `removed`, and without the next entry where it is the value of a removed flag. */
function withoutRemovals(runArgs: readonly string[], removed: ReadonlyMap<number, readonly ParsedFlag[]>): string[] {
  const dropped = new Set<number>();
  for (const [index, flags] of removed) {
    dropped.add(index);
    if (flags.some((flag) => flag.form === 'next')) dropped.add(index + 1);
  }
  return runArgs.filter((_arg, index) => !dropped.has(index));
}

/**
 * `runArgs` without `--name <value>` and `--name=<value>` (the override configuration adds the name of the environment).
 * The flags are read as the policy reads them (parseFlags), so a `--name` that is the value of another flag (for example
 * `--label --name`) stays, and the other arguments keep their meaning for Docker.
 */
export function withoutNameArgs(runArgs: readonly string[]): string[] {
  return withoutRemovals(runArgs, removals(runArgs, ['--name']));
}

/**
 * The flags of `runArgs` that the override configuration does not pass to Docker (overrideRunArgs), in order, for the
 * log: `--name` (the extension adds the name of the environment), `--rm` (the extension stops, starts, and recreates
 * the container itself), and `-i`, `-t`, and `-d`, also in a group such as `-it`: with the arguments of the Dev
 * Container CLI, they do nothing or make the start fail.
 */
export function removedRunArgs(runArgs: readonly string[]): RemovedRunArg[] {
  return [...removals(runArgs)].map(([index, flags]) => {
    const withValue = flags.some((flag) => flag.form === 'next');
    const reasons = flags.map((flag) => (flag.rule?.kind === 'remove' ? flag.rule.reason : ''));
    return {
      arg: withValue ? `${runArgs[index]} ${runArgs[index + 1]}` : runArgs[index],
      reason: [...new Set(reasons)].join('; '),
    };
  });
}

/**
 * The repository part of `runArgs` in the override configuration of `devcontainer up`, the list that Docker gets: the
 * entries that are text (the policy refuses a list with other entries), without the removed flags (removedRunArgs, read
 * with the parser of the policy), and with 127.0.0.1 for published ports without an address (loopbackRunArgs), unless
 * the host access checks are off (`checksOn` false: the ports keep the address that the configuration gives them).
 * hostAccessProblems checks this list too, and the pipeline checks the complete list of the override configuration
 * again before `up`.
 */
export function overrideRunArgs(runArgs: unknown, checksOn = true): string[] {
  const texts = Array.isArray(runArgs) ? runArgs.filter((arg): arg is string => typeof arg === 'string') : [];
  const kept = withoutRemovals(texts, removals(texts));
  return checksOn ? loopbackRunArgs(kept) : kept;
}

/**
 * `runArgs` with 127.0.0.1 for each `-p`/`--publish` that names no address (concept section 9 "Host access": the
 * published ports of a container reach the computer only on localhost). Other arguments stay as they are; `--network host`
 * is left unchanged, and Docker ignores `-p` there.
 */
export function loopbackRunArgs(runArgs: readonly string[]): string[] {
  const result = [...runArgs];
  for (const flag of parseFlags(runArgs, RUN_FLAGS)) {
    if ((flag.name !== '-p' && flag.name !== '--publish') || flag.value === undefined) continue;
    const value = withLoopbackAddress(flag.value);
    if (flag.form === 'next') result[flag.index + 1] = value;
    else result[flag.index] = flag.name === '--publish' ? `--publish=${value}` : `-p${value}`;
  }
  return result;
}
