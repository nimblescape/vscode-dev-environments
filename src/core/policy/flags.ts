// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rules of the flags of `docker run` (`runArgs`) and `docker build` (`build.options`), flag by flag, with the checks
// of their values (RUN_FLAGS, BUILD_FLAGS). An allow-list: a flag that is not in a table is unknown and refused as not
// supported, because a new flag of Docker can reach the computer. Parsed with ./dockerFlags.ts. Pure functions, no I/O.
import { WORKSPACES_ROOT } from '../names';
import {
  csvFields,
  imageContext,
  isUrlContext,
  localContextPath,
  networkNames,
  optionFields,
  splitPortAddress,
  isLoopbackAddress,
  type FlagRule,
  type ParsedFlag,
} from './dockerFlags';
import { imageReferenceFinding } from './images';
import { access, accessAll, guarded, guardedAll, unsupported, type Problem } from './report';
import {
  LOG_DRIVERS,
  LOG_OPTIONS,
  MAX_STOP_TIMEOUT_SECONDS,
  OWN_LABELS,
  RESERVED_COMPOSE_LABEL,
  RESTART_POLICY,
  capabilityProblems,
  isHelperPath,
  isReservedLabel,
  refusedVariable,
  securityOptionProblems,
} from './rules';
import { foreignNetworkItem, type VolumeContext } from './volumes';

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
const REMOVED_RESTART =
  'Dev Environments starts and stops the container itself; Docker would start the container again when Docker starts, outside the Session Monitor';
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
export const RUN_FLAGS: Readonly<Record<string, FlagRule>> = {
  // Checked in runArgsFindings (networkProblems, with the labels of the networks).
  '--network': { kind: 'check', check: (value) => networkProblems(value) },
  '--net': { kind: 'check', check: (value) => networkProblems(value) },
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
  // Not a variable of container-only Git or of the account of the GitHub CLI, also not before a `=` of the name, and no
  // name with a space or a control character (envProblems). The identity of the owner account: stays refused with the
  // checks off.
  '--env': { kind: 'check', check: envProblems },
  '-e': { kind: 'check', check: envProblems },
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
  // Only `no` and `on-failure`: the others start the container together with Docker (restartProblems). Review round 8
  // (S8-6): removed before `up` too, with a log line: Docker would start a container with `on-failure` again when the
  // Docker daemon starts, outside the Session Monitor (D-14).
  '--restart': { kind: 'remove', value: true, reason: REMOVED_RESTART, check: restartProblems },
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
  // Review round 22 (H22-6): the processes of another container (for example a dev container, which holds the GitHub
  // token, or one of another environment) stay refused whatever the switch says.
  '--pid': { kind: 'check', check: (value) => [(/^container:/i.test(value.trim()) ? guarded : access)(`--pid=${value}`)] },
  '--ipc': refuseValue,
  '--uts': refuseValue,
  '--userns': refuseValue,
  '--cgroupns': refuseValue,
  // Review round 22 (H22-2): the volumes of another container (for example the workspace volume of a dev container, with
  // the GitHub token, or the volumes of another environment): refused whatever the switch says.
  '--volumes-from': { kind: 'refuse', value: true, guarded: true },
  // Another container, whose environment variables older versions of Docker copy into this one.
  '--link': refuseValue,
  // Checked in runArgsProblems with the rules of `mounts`: only volumes (not of another environment) and tmpfs.
  '-v': allowValue,
  '--volume': allowValue,
  '--mount': allowValue,
};

export const BUILD_FLAGS: Readonly<Record<string, FlagRule>> = {
  '--network': allowValue,
  '--add-host': allowValue,
  // Review round 4 (S4-1): not without a value (buildArgOptionProblems).
  '--build-arg': { kind: 'check', check: (value) => buildArgOptionProblems(value) },
  '--target': allowValue,
  '--label': allowValue,
  '--platform': allowValue,
  '--pull': allowFlag,
  '--no-cache': allowFlag,
  // Review round 3 (S3-6): the build client reads their files in the workspace helper (buildFileProblems).
  '--secret': { kind: 'check', check: (value) => buildSecretOptionProblems(value) },
  '--ssh': { kind: 'check', check: (value) => buildSshOptionProblems(value) },
  '--allow': refuseValue,
  '--output': { kind: 'check', check: (value) => buildOutputOptionProblems('--output', value) },
  '-o': { kind: 'check', check: (value) => buildOutputOptionProblems('-o', value) },
  '--build-context': { kind: 'check', check: buildContextProblems },
};

// ---------------------------------------------------------------------------------------------------------------------
// Values of flags of `docker run`

/**
 * `--network container:<name>` shares the network namespace of another container, for example of an environment of
 * another account: its services on localhost. Every other network, also `host`, is allowed. With `host` (and macvlan or
 * ipvlan), Docker ignores `-p`, so the ports of the container are not limited to localhost (concept section 9 "Host
 * access", exception). Docker also reads the long form `name=<network>[,alias=…]`: as soon as the text has a
 * `key=value` pair, it reads the text as CSV with each field in lower case, and the last `name` is the network. Each
 * `name` is checked; a text that Docker would read otherwise (csvFields) is not supported.
 */
export function networkProblems(value: string, volumes?: VolumeContext): Problem[] {
  const networks = networkNames(value);
  if (!networks) return [unsupported(`network ${JSON.stringify(value)}`)];
  const joined = networks.some((network) => /^container:/i.test(network.trim()));
  if (joined) return [access(`network of another container (${value.trim()})`)];
  // The network of another environment (its Compose project, perhaps of another account): account separation.
  const foreign: Problem[] = [];
  for (const network of networks.map((name) => name.trim())) {
    const item = foreignNetworkItem(network, volumes?.networks[network], volumes?.environment?.id, volumes?.own);
    if (item !== undefined) foreign.push(guarded(item));
  }
  return foreign;
}

/**
 * A port that names an address other than a loopback address. Without an address, the extension adds 127.0.0.1.
 * Docker's long syntax (`published=8080,target=80`: any value with `=`) has no key for the address, so Docker publishes
 * it on all addresses, and an address in front of it becomes part of an unknown key: it is refused.
 */
export function portProblems(spec: string): string[] {
  if (spec.includes('=')) return [`published port ${spec.trim()}`];
  const { address } = splitPortAddress(spec.trim());
  if (address === undefined || address === '' || isLoopbackAddress(address)) return [];
  return [`published port ${spec.trim()}`];
}

/**
 * `--label`: no reserved key (isReservedLabel, compared without case and surrounding spaces), except the exact labels
 * that the override configuration adds itself (OWN_LABELS). In `docker run`, the runArgs come after the id label of the
 * Dev Container CLI (`nimblescape.devenv.environment-id`), and the last label of a key wins: the extension and the
 * Session Monitor would no longer find the container, or take it for another environment. Other `devenv.…` keys are
 * allowed.
 */
function labelProblems(value: string): Problem[] {
  if (OWN_LABELS.includes(value)) return [];
  const index = value.indexOf('=');
  const key = (index < 0 ? value : value.slice(0, index)).trim();
  // Docker Compose too: a label com.docker.compose.project would make Delete of that project remove the container.
  return isReservedLabel(key) || RESERVED_COMPOSE_LABEL.test(key) ? [unsupported(`label ${key}`)] : [];
}

/**
 * `-e`/`--env`: no variable of container-only Git and no variable of the account of the GitHub CLI
 * (refusedVariable), with or without a value. `docker run` gets the runArgs after the containerEnv of the override
 * configuration, so the value of the runArgs would win; a `-e NAME` without a value takes the value of the workspace
 * helper, or removes the variable.
 */
function envProblems(value: string): Problem[] {
  const problem = refusedVariable(value, 'runArgs');
  return problem === undefined ? [] : [problem];
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

/**
 * `--oom-score-adj`: 0 or more, in decimal digits. A negative value makes the kernel end other processes of the
 * computer first when the memory runs out.
 */
function oomScoreProblems(value: string): Problem[] {
  // Not named by the user decision on the switch: stays refused with the checks off (the safer choice).
  return /^\d+$/.test(value) ? [] : [guarded(`--oom-score-adj=${value}`)];
}

function logDriverProblems(value: string): string[] {
  return LOG_DRIVERS.includes(value.toLowerCase()) ? [] : [`--log-driver=${value}`];
}

function logOptionProblems(value: string): Problem[] {
  const index = value.indexOf('=');
  return LOG_OPTIONS.includes(index < 0 ? value : value.slice(0, index)) ? [] : [unsupported(`--log-opt=${value}`)];
}

/** `--storage-opt`: only `size=<size>`, the size of the file system of the container. */
function storageOptionProblems(value: string): Problem[] {
  return value.startsWith('size=') ? [] : [unsupported(`--storage-opt=${value}`)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Values of options of `docker build`

/**
 * `--build-context name=value`: an image or a URL is allowed, a folder of the computer is not; an image ID stays
 * refused (imageReferenceFinding), and the pipeline refuses an image of the environments of another account by its ID
 * (otherAccountImageItems). The build client reads a folder (also of `oci-layout://`) in the workspace helper (review
 * round 2, S2-03): a path of the workspace helper (isHelperPath; the workspace volume holds only the repository besides
 * the internal folder CONFIG_FOLDER) or a relative path (resolved against the working folder of the build in the
 * helper, which the check does not know) stays refused whatever the switch says.
 */
function buildContextProblems(value: string): Problem[] {
  const index = value.indexOf('=');
  const source = index < 0 ? value : value.slice(index + 1);
  // Review round 1 of PR #130 (A-F2): an image or a URL only by the exact lower-case prefix that Buildx takes; `HTTPS://…`
  // or ` docker-image://…` is a path that the build client reads.
  const image = imageContext(source);
  if (image !== undefined) {
    const finding = imageReferenceFinding(image, 'build option --build-context image');
    return finding ? [finding] : [];
  }
  if (isUrlContext(source)) return [];
  const item = `build option --build-context=${value}`;
  const folder = localContextPath(source);
  if (folder === undefined) return [access(item)];
  if (!folder.startsWith('/')) return [guarded(item)];
  if (isHelperPath(folder, WORKSPACES_ROOT)) return [guarded(item)];
  return [access(item)];
}

/**
 * A file or folder of `build.options` that the build client reads or writes in the workspace helper (review round 3,
 * S3-6, the rule of the Compose build files, review round 2, S2-03): a path of the workspace helper (isHelperPath) or a
 * relative path (resolved against the working folder of the build in the helper, which the check does not know) stays
 * refused whatever the switch says. Otherwise nothing: the rule of the option itself decides (the class `computer`).
 */
function buildFileProblems(item: string, file: string): Problem[] {
  if (!file.startsWith('/')) return [guarded(`${item} (a relative path)`)];
  if (isHelperPath(file, WORKSPACES_ROOT)) return [guarded(item)];
  return [];
}

/**
 * `--secret id=…[,src=<file>|,env=<variable>]`: without `src`/`source` and `env` (and not of `type=env`), buildx reads
 * the variable of the name `id` of the helper, or else the file `id`.
 */
function buildSecretOptionProblems(value: string): Problem[] {
  const fields = optionFields(value);
  const file = fields.get('src') ?? fields.get('source') ?? (fields.has('env') || fields.get('type') === 'env' ? undefined : fields.get('id'));
  return [access('build option --secret'), ...(file === undefined || file === '' ? [] : buildFileProblems(`build option --secret ${value}`, file))];
}

/** `--ssh default|<id>[=<socket>|<key>[,<key>]]`: the files after `=`. */
function buildSshOptionProblems(value: string): Problem[] {
  const equals = value.indexOf('=');
  const files = equals < 0 ? [] : value.slice(equals + 1).split(',').map((file) => file.trim()).filter((file) => file !== '');
  return [access('build option --ssh'), ...files.flatMap((file) => buildFileProblems(`build option --ssh ${value}`, file))];
}

/**
 * `--build-arg NAME` without a value (review round 4, S4-1): buildx takes the value of the variable NAME of the workspace
 * helper, and drops the argument when the helper has none, so the value of `build.args` or the default of the ARG
 * applies. Which one the build gets cannot be told here: refused.
 */
function buildArgOptionProblems(value: string): Problem[] {
  if (value.includes('=')) return [];
  return [
    unsupported(
      `build option --build-arg ${value} without a value (the value would come from the environment of the workspace helper, or the argument would be dropped, so Dev Environments cannot check it)`,
    ),
  ];
}

/**
 * `--output`/`-o` `type=…,dest=<path>`, or `<path>` alone (a local export); `-` is the standard output. Review round 4
 * (S4-5): read as buildx reads it: a value whose CSV fields are one field that does not start with `type=` is the
 * destination as a whole (also with `=` in it); otherwise the field `dest=`.
 */
function buildOutputOptionProblems(name: string, value: string): Problem[] {
  const fields = csvFields(value) ?? value.split(',');
  const dest = fields.length === 1 && !fields[0].startsWith('type=') ? value.trim() : optionFields(value).get('dest');
  return [access(`build option ${name}`), ...(dest === undefined || dest === '' || dest === '-' ? [] : buildFileProblems(`build option ${name} ${value}`, dest))];
}

// ---------------------------------------------------------------------------------------------------------------------
// A parsed flag

export function flagProblems(flag: ParsedFlag, label: (text: string) => string): Problem[] {
  if (flag.name === undefined) return [unsupported(label(`argument ${flag.raw}`))];
  const rule = flag.rule;
  if (!rule) return [unsupported(label(flag.name.startsWith('--') ? flag.name : flag.raw))];
  if (rule.kind === 'allow') return [];
  if (rule.kind === 'remove') return rule.check !== undefined ? rule.check(flag.value ?? '') : [];
  if (rule.kind === 'refuse') {
    const refused = rule.guarded ? guarded : access;
    if (rule.item) return [refused(rule.item)];
    return [refused(label(flag.value !== undefined ? `${flag.name}=${flag.value}` : flag.name))];
  }
  return rule.check(flag.value ?? '');
}
