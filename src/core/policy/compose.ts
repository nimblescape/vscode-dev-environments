// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The container policy for Docker Compose configurations (concept section 9 "Host access", implementation notes section
// "Docker Compose"): the rules of ./single.ts for every service of the merged model that `docker compose config`
// prints (all profiles), not only for the dev service, because Compose starts them all with the Docker engine of the
// computer. An allow-list, like RUN_FLAGS (./flags.ts): a key that the policy does not know is refused as not supported,
// because a new key of Compose can reach the computer. The mounts and the ports are decided by the functions of
// ./rewrites.ts that the model rewrite (../helper/compose.ts) uses too, so the check and the model that runs cannot
// disagree. Each refused item has the class of the switch of the host access checks (HostAccessClass, ./report.ts,
// container-restrictions.md section 12), as the same setting has for a single container: with the checks off for the
// repository, only the class `computer` is lifted. Pure functions, no I/O.
import * as path from 'path';
import { MAX_DOCKERFILE_LENGTH } from '../imageCheck/dockerfile';
import { isOciFeatureReference } from '../imageCheck/reference';
import { WORKSPACES_ROOT } from '../names';
import {
  composeNetworkNames,
  composeVolumeNames,
  durationSeconds,
  WORKSPACE_VOLUME_KEY,
  type ComposeModel,
} from '../helper/composeModel';
import { localContextPath } from './dockerFlags';
import { imageReferenceFinding, type NamedImageReference } from './images';
import { access, guarded, unsupported, type HostAccessFinding, type HostAccessReport, type Problem } from './report';
import { decideServiceMount, decideServicePort, type ComposeMountContext } from './rewrites';
import {
  LOG_DRIVERS,
  LOG_OPTIONS,
  RESERVED_COMPOSE_LABEL,
  capabilityProblems,
  configFolderMountItem,
  configFolderTarget,
  isHelperPath,
  isReservedLabel,
  refusedVariable,
  securityOptionProblems,
} from './rules';
import { foreignNetworkItem, isOtherEnvironmentProjectName, volumeNameFindings, type VolumeInput } from './volumes';

export interface ComposeAccessInput extends VolumeInput {
  /** The merged model (ComposeModelOutput.model). */
  model: ComposeModel;
  /** `service` of devcontainer.json. */
  devService: string;
  /** `runServices` of devcontainer.json, when it has one. */
  runServices?: unknown;
  /** composeProjectName of the environment. */
  project: string;
  /** The folder of the repository in the helper, for example `/workspaces/api`. */
  repositoryFolder: string;
  /** The Docker Engine API version, for the bind mounts of repository files (supportsVolumeSubpath). */
  engineApiVersion?: string;
  /**
   * ComposeModelOutput.realPaths: bind mount sources, `env_file`s, build contexts, and Dockerfiles whose links lead out
   * of the repository are refused.
   */
  realPaths?: Readonly<Record<string, string | null>>;
  /** ComposeModelOutput.mountAncestors (review round 8, P8-2): the nearest folders of bind mount sources that do not exist. */
  mountAncestors?: Readonly<Record<string, string | null>>;
  /**
   * ComposeModelOutput.dockerfiles: the Dockerfile of the dev service, for the texts that the Dev Container CLI writes
   * into its compose file (devBuildTextProblems); the build of the dev service writes this text (composeBuildModel), so
   * a dev service whose Dockerfile could not be read is refused. A Dockerfile of any service longer than
   * MAX_DOCKERFILE_LENGTH is refused (U1: the configuration hash sees only the text that was read). The content of the
   * Dockerfiles is not checked (Dockerfile refusals removed, user decision 2026-09-27). The Dockerfile of another service
   * that could not be read is not refused for that (a link of it out of the repository is, by localPathProblems); the
   * update check and the configuration hash skip it. Without it, nothing of them is checked.
   */
  dockerfiles?: Readonly<Record<string, string>>;
  /**
   * ComposeModelOutput.missing (review round 3, P3-1): a build context or Dockerfile in the repository that does not
   * exist is no refusal of the policy: composeMissingBuildPaths names it for a plain error of the configuration.
   */
  missing?: readonly string[];
}

/** A refusal of decideServiceMount or decideServicePort as a problem with its class. */
function decisionProblem(decision: { item: string; kind: 'hostAccess' | 'unsupported'; guarded?: true }): Problem {
  if (decision.kind === 'unsupported') return unsupported(decision.item);
  return decision.guarded ? guarded(decision.item) : access(decision.item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value that `docker compose config` prints for a key that is not set, or that sets nothing. */
function isUnset(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/** Extension fields (`x-…`): no effect in Compose. */
const isExtension = (key: string): boolean => key.startsWith('x-');

function labelKeys(labels: unknown): string[] {
  if (isRecord(labels)) return Object.keys(labels);
  if (Array.isArray(labels)) return labels.map((entry) => String(entry).split('=')[0]);
  return [];
}

function labelProblems(labels: unknown, where: string): Problem[] {
  return labelKeys(labels)
    .map((key) => key.trim())
    .filter((key) => isReservedLabel(key) || RESERVED_COMPOSE_LABEL.test(key))
    .map((key) => unsupported(`${where}label ${key}`));
}

/** imageReferenceFinding of ./images.ts as a problem: an image ID (an image of another account: otherAccountImageItems). */
function imageProblems(reference: string, what: string): Problem[] {
  const finding = imageReferenceFinding(reference, what);
  return finding ? [finding] : [];
}

function isInside(file: string, folder: string): boolean {
  return file === folder || file.startsWith(`${folder}/`);
}

/** A path of the model (absolute, as `docker compose config` resolves it) strictly below the repository folder. */
function isRepositoryPath(file: string, repositoryFolder: string): boolean {
  return file.startsWith('/') && !file.split('/').includes('..') && isInside(path.posix.normalize(file), repositoryFolder);
}

/**
 * A remote build context: a URL of Git or HTTP(S), and (review round 6, P6-1) every value that Compose's absContextPath
 * leaves as it is: one that starts with `github.com/`, or holds `://` anywhere (for example `docker-image://…`).
 */
function isRemoteContext(context: string): boolean {
  return /^(https?:\/\/|git@|git:\/\/|ssh:\/\/|github\.com\/)/i.test(context) || context.includes('://');
}

// ---------------------------------------------------------------------------------------------------------------------
// Services

/** The context of the checks of one service. */
interface ServiceContext {
  name: string;
  isDev: boolean;
  input: ComposeAccessInput;
  mounts: ComposeMountContext;
  services: ReadonlySet<string>;
  /**
   * Review round 22 (H22-6): the services that share the pid namespace of the dev service through `pid: service:…`
   * (directly or through a chain, in either direction); empty when the dev service shares it with none.
   */
  devPidGroup: ReadonlySet<string>;
}

type KeyRule = (value: unknown, ctx: ServiceContext) => Problem[];

const allow: KeyRule = () => [];
/** Refused as access to the computer when set (a true-like value, a non-empty list or map). */
const refuseAccess =
  (item: string): KeyRule =>
  (value) =>
    isUnset(value) ? [] : [access(item)];
const refuseUnsupported =
  (item: string): KeyRule =>
  (value) =>
    isUnset(value) ? [] : [unsupported(item)];

/** A namespace mode (`pid`, `ipc`, `uts`, `userns_mode`, `cgroup`): the allowed values, `host`/`service:`/`container:` refused. */
function namespaceRule(key: string, allowed: readonly string[]): KeyRule {
  return (value) => {
    if (isUnset(value)) return [];
    const text = String(value).trim();
    if (allowed.includes(text)) return [];
    if (/^(host|service:|container:)/i.test(text)) return [access(`${key} ${text}`)];
    return [unsupported(`${key} ${text}`)];
  };
}

function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

const SERVICE_RULES: Readonly<Record<string, KeyRule>> = {
  // An image ID is refused; an image of the environments of another account by its ID in the pipeline
  // (otherAccountImageItems): account separation. The images of built services are renamed (rewrite).
  image: (value) => (typeof value === 'string' ? imageProblems(value, 'image') : []),
  build: buildProblems,
  // Rewritten: the dev container gets the name of the environment, the others none (D-12).
  container_name: allow,
  labels: (value) => labelProblems(value, ''),
  // A file of labels, read by Compose where it runs.
  label_file: refuseUnsupported('label_file'),
  // Only the dev container gets the token and the configuration of Git (D-5): the rules of containerEnv there, which
  // stay refused with the checks off (the identity of the owner account).
  environment: (value, ctx) => {
    if (!ctx.isDev) return [];
    const names = isRecord(value) ? Object.keys(value) : listOf(value).map((entry) => String(entry).split('=')[0]);
    return names.flatMap((name) => {
      // The rules of containerEnv (refusedVariable), also for the part of a name before a `=` (merge of #27).
      const problem = refusedVariable(String(name), 'environment');
      return problem === undefined ? [] : [problem];
    });
  },
  env_file: envFileProblems,
  ports: (value) =>
    listOf(value).flatMap((entry) => {
      const decision = decideServicePort(entry);
      return decision.action === 'refuse' ? [decisionProblem(decision)] : [];
    }),
  expose: allow,
  network_mode: networkModeProblems,
  networks: allow,
  volumes: (value, ctx) =>
    listOf(value).flatMap((entry) => {
      const decision = decideServiceMount(entry, ctx.mounts);
      return decision.action === 'refuse' ? [decisionProblem(decision)] : [];
    }),
  // Review round 22 (H22-2): the volumes of another service of the model (volumesFromProblems).
  volumes_from: volumesFromProblems,
  // Review round 22 (H22-1): another name of a service of the model in its network (Compose accepts only services of the
  // model).
  links: (value, ctx) =>
    listOf(value).flatMap((entry) => {
      const text = String(entry).trim();
      const parts = text.split(':');
      return parts.length <= 2 && ctx.services.has(parts[0]) ? [] : [unsupported(`links ${text} (not a service of the Docker Compose configuration)`)];
    }),
  // Containers that are not of the model, whose network would join this one.
  external_links: refuseAccess('external_links'),
  privileged: refuseAccess('privileged mode'),
  cap_add: (value) => capabilityProblems(listOf(value)).map(access),
  cap_drop: allow,
  security_opt: (value) => securityOptionProblems(listOf(value)).map(access),
  devices: refuseAccess('devices'),
  device_cgroup_rules: refuseAccess('device_cgroup_rules'),
  gpus: refuseAccess('GPU access (gpus)'),
  blkio_config: blkioProblems,
  // Another runtime can add devices of the computer; a control group of the computer; without the OOM killer, a
  // container can make the computer hang (as in RUN_FLAGS, where --oom-kill-disable and a negative --oom-score-adj stay
  // refused with the checks off: the safer choice).
  runtime: refuseAccess('runtime'),
  cgroup_parent: refuseAccess('cgroup_parent'),
  oom_kill_disable: (value) => (isUnset(value) ? [] : [guarded('oom_kill_disable')]),
  oom_score_adj: (value) => (value === undefined || value === null || (typeof value === 'number' && value >= 0) ? [] : [guarded(`oom_score_adj ${String(value)}`)]),
  pid: pidProblems,
  // Review round 22 (H22-6): the ipc namespace of another service of the model (which needs `ipc: shareable`, else
  // Docker refuses to start).
  ipc: (value, ctx) => {
    if (!isUnset(value) && otherService(String(value), ctx) !== undefined) return [];
    return namespaceRule('ipc', ['private', 'shareable', 'none'])(value, ctx);
  },
  uts: namespaceRule('uts', []),
  userns_mode: namespaceRule('userns_mode', []),
  cgroup: namespaceRule('cgroup', ['private']),
  // Docker accepts only settings of the namespaces of the container (as --sysctl, D-13).
  sysctls: allow,
  logging: loggingProblems,
  storage_opt: (value) => (isRecord(value) ? Object.keys(value).filter((key) => key !== 'size').map((key) => unsupported(`storage_opt ${key}`)) : []),
  // `always` and `unless-stopped` would start the container together with Docker, outside the Session Monitor (D-14):
  // review round 7, P7-1, rewritten to `no` (rewriteModel in compose.ts), not refused; a restart gives no access. Review
  // round 8, S8-6: `on-failure[:n]` too (Docker starts such a container again when the Docker daemon starts).
  restart: allow,
  // Review round 8 (orchestrator decision): a period over MAX_STOP_TIMEOUT_SECONDS is capped at it (rewriteModel), not
  // refused; one that cannot be read (or is negative) is.
  stop_grace_period: (value) => {
    if (isUnset(value)) return [];
    const seconds = durationSeconds(value);
    return seconds !== undefined && seconds >= 0 ? [] : [unsupported(`stop_grace_period ${String(value)}`)];
  },
  stop_signal: allow,
  deploy: deployProblems,
  // Rewritten (D-16).
  pull_policy: allow,
  // Mounts the Docker socket and the registry credentials of the computer.
  use_api_socket: refuseAccess('the Docker socket (use_api_socket)'),
  // Review round 22 (H22-4): the top-level secrets and configs decide (secretConfigProblems); here only the targets in
  // the dev service.
  secrets: (value, ctx) => secretTargetProblems('secret', value, ctx),
  configs: (value, ctx) => secretTargetProblems('config', value, ctx),
  models: refuseUnsupported('models'),
  provider: refuseUnsupported('provider'),
  credential_spec: refuseUnsupported('credential_spec'),
  scale: (value) => (value === undefined || value === null || value === 1 ? [] : [unsupported(`scale ${String(value)}`)]),
  extends: refuseUnsupported('extends'),
  post_start: hookProblems('post_start'),
  pre_stop: hookProblems('pre_stop'),
  // No access to the computer.
  entrypoint: allow,
  command: allow,
  working_dir: allow,
  user: allow,
  group_add: allow,
  hostname: allow,
  domainname: allow,
  mac_address: allow,
  dns: allow,
  dns_opt: allow,
  dns_search: allow,
  extra_hosts: allow,
  init: allow,
  tty: allow,
  stdin_open: allow,
  read_only: allow,
  // Review round 14 (S14-1): not in the extension's internal folder of the dev container (`<target>[:options]`).
  tmpfs: (value, ctx) =>
    !ctx.isDev
      ? []
      : listOf(value).flatMap((entry) => {
          const text = String(entry);
          const index = text.indexOf(':');
          const internal = configFolderTarget(index >= 0 ? text.slice(0, index) : text);
          return internal === undefined ? [] : [unsupported(configFolderMountItem(internal, 'tmpfs'))];
        }),
  shm_size: allow,
  ulimits: allow,
  cpu_count: allow,
  cpu_percent: allow,
  cpu_shares: allow,
  cpu_period: allow,
  cpu_quota: allow,
  cpu_rt_runtime: allow,
  cpu_rt_period: allow,
  cpus: allow,
  cpuset: allow,
  mem_limit: allow,
  mem_reservation: allow,
  mem_swappiness: allow,
  memswap_limit: allow,
  pids_limit: allow,
  healthcheck: allow,
  depends_on: allow,
  profiles: allow,
  platform: allow,
  isolation: allow,
  annotations: allow,
  attach: allow,
  develop: allow,
};

/** The service that `service:<name>` names, when it is another service of the model; `undefined` otherwise. */
function otherService(mode: string, ctx: ServiceContext): string | undefined {
  const text = mode.trim();
  if (!/^service:/i.test(text)) return undefined;
  const target = text.slice('service:'.length);
  return ctx.services.has(target) && target !== ctx.name ? target : undefined;
}

/**
 * Review round 22 (H22-6): `pid`. `service:<name>` of another service of the model is allowed, unless the dev service
 * shares the namespace (ServiceContext.devPidGroup): a process of the other container could read the files of the dev
 * container (the GitHub token) through /proc/<pid>/root, so that stays refused whatever the switch says; so does
 * `container:…` (another container, perhaps the dev container of another environment). `host`: access to the computer.
 */
function pidProblems(value: unknown, ctx: ServiceContext): Problem[] {
  if (isUnset(value)) return [];
  const text = String(value).trim();
  if (/^container:/i.test(text)) return [guarded(`pid ${text}`)];
  if (otherService(text, ctx) !== undefined) {
    return ctx.devPidGroup.has(ctx.name) ? [guarded(`pid ${text} (the processes of the dev container, which holds the GitHub token)`)] : [];
  }
  return namespaceRule('pid', [])(value, ctx);
}

/**
 * Review round 22 (H22-6): the services that share the pid namespace of the dev service (`pid: service:…` between
 * services of the model, followed in both directions); empty when there is none.
 */
function devPidGroup(services: Readonly<Record<string, unknown>>, devService: string): Set<string> {
  const edges = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    edges.set(a, [...(edges.get(a) ?? []), b]);
  };
  for (const [name, service] of Object.entries(services)) {
    const pid = isRecord(service) && typeof service.pid === 'string' ? service.pid.trim() : '';
    if (!/^service:/i.test(pid)) continue;
    const target = pid.slice('service:'.length);
    if (target === name || !Object.prototype.hasOwnProperty.call(services, target)) continue;
    link(name, target);
    link(target, name);
  }
  const group = new Set<string>();
  if (!edges.has(devService)) return group;
  const queue = [devService];
  group.add(devService);
  while (queue.length > 0) {
    for (const next of edges.get(queue.pop() as string) ?? []) {
      if (group.has(next)) continue;
      group.add(next);
      queue.push(next);
    }
  }
  return group;
}

/** Review round 22 (H22-2): an entry of `volumes_from`: `<service>[:ro|:rw]` or `container:<name>[:ro|:rw]`. */
function volumesFromEntry(entry: unknown): { container: boolean; name: string } | undefined {
  if (typeof entry !== 'string') return undefined;
  const text = entry.trim();
  const container = /^container:/i.test(text);
  const name = (container ? text.slice('container:'.length) : text).replace(/:(ro|rw)$/, '');
  if (name === '' || (!container && name.includes(':'))) return undefined;
  return { container, name };
}

/**
 * Review round 22 (H22-2): `volumes_from`. The volumes of another service of the model are allowed, except those of the
 * dev service (the workspace volume, with the repository and the Git configuration of the environment); a container (`container:…`, perhaps of another
 * environment) stays refused whatever the switch says. When the dev service takes the volumes of other services (also
 * through their own `volumes_from`), their mounts land in the dev container: the rules of its mounts apply to their
 * targets (not at WORKSPACES_ROOT, not in the internal folder with the token).
 */
function volumesFromProblems(value: unknown, ctx: ServiceContext): Problem[] {
  const services = isRecord(ctx.input.model.services) ? ctx.input.model.services : {};
  const problems: Problem[] = [];
  for (const entry of listOf(value)) {
    const text = String(entry).trim();
    const parsed = volumesFromEntry(entry);
    if (parsed === undefined) {
      problems.push(unsupported(`volumes_from ${text}`));
    } else if (parsed.container) {
      problems.push(guarded(`volumes_from ${text} (the volumes of another container)`));
    } else if (!ctx.services.has(parsed.name) || parsed.name === ctx.name) {
      problems.push(unsupported(`volumes_from ${text} (not a service of the Docker Compose configuration)`));
    } else if (parsed.name === ctx.input.devService) {
      problems.push(guarded(`volumes_from ${text} (the volumes of the dev container, with the workspace volume)`));
    } else if (ctx.isDev) {
      for (const target of volumesFromTargets(parsed.name, services)) {
        const internal = configFolderTarget(target);
        if (internal !== undefined) problems.push(unsupported(configFolderMountItem(internal, `volumes_from ${text}: mount at`)));
        else if (target === WORKSPACES_ROOT) problems.push(unsupported(`volumes_from ${text}: mount at ${WORKSPACES_ROOT}`));
      }
    }
  }
  return problems;
}

/**
 * Review round 22 (H22-2): the targets (normalized) of the mounts that `volumes_from: [<name>]` brings: the `volumes`,
 * `tmpfs`, `secrets`, and `configs` of the service, and those of the services whose volumes it takes in turn.
 */
function volumesFromTargets(name: string, services: Readonly<Record<string, unknown>>): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const service = services[current];
    if (!isRecord(service)) continue;
    for (const entry of listOf(service.volumes)) if (isRecord(entry) && typeof entry.target === 'string') targets.push(entry.target);
    for (const entry of listOf(service.tmpfs)) targets.push(String(entry).split(':')[0]);
    for (const entry of listOf(service.secrets)) targets.push(secretTarget('secret', entry));
    for (const entry of listOf(service.configs)) targets.push(secretTarget('config', entry));
    for (const entry of listOf(service.volumes_from)) {
      const parsed = volumesFromEntry(entry);
      if (parsed !== undefined && !parsed.container) queue.push(parsed.name);
    }
  }
  return targets.filter((target) => target.startsWith('/')).map((target) => path.posix.normalize(target).replace(/(.)\/+$/, '$1'));
}

/**
 * Review round 22 (H22-4): where Compose puts a secret (`/run/secrets/<target or source>`) or a config
 * (`/<target or source>`) of a service; an absolute target as it is.
 */
function secretTarget(kind: 'secret' | 'config', entry: unknown): string {
  const source = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.source === 'string' ? entry.source : '';
  const target = isRecord(entry) && typeof entry.target === 'string' && entry.target !== '' ? entry.target : source;
  if (target.startsWith('/')) return target;
  return kind === 'secret' ? `/run/secrets/${target}` : `/${target}`;
}

/**
 * Review round 22 (H22-4): the `secrets` and `configs` of a service. What they hold is decided at the top level
 * (secretConfigProblems); in the dev service, a target at WORKSPACES_ROOT or in the internal folder (the token) is not
 * supported, as a mount there.
 */
function secretTargetProblems(kind: 'secret' | 'config', value: unknown, ctx: ServiceContext): Problem[] {
  if (!ctx.isDev) return [];
  const problems: Problem[] = [];
  for (const entry of listOf(value)) {
    const source = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.source) : JSON.stringify(entry);
    const target = path.posix.normalize(secretTarget(kind, entry)).replace(/(.)\/+$/, '$1');
    const internal = configFolderTarget(target);
    if (internal !== undefined) problems.push(unsupported(configFolderMountItem(internal, `${kind} ${source} at`)));
    else if (target === WORKSPACES_ROOT) problems.push(unsupported(`${kind} ${source} at ${WORKSPACES_ROOT}`));
  }
  return problems;
}

/** `post_start`/`pre_stop`: commands in the container, but not with `privileged`. */
function hookProblems(key: string): KeyRule {
  return (value) => (listOf(value).some((hook) => isRecord(hook) && hook.privileged === true) ? [access(`privileged ${key}`)] : []);
}

/**
 * `env_file`: Compose reads the file where it runs, the workspace helper, which mounts the volume with the GitHub token.
 * Only a file below the repository folder (after links, with realPaths). A file of the workspace helper, not of the
 * computer: refused whatever the switch says, as `--env-file` of a single container.
 */
function envFileProblems(value: unknown, ctx: ServiceContext): Problem[] {
  const problems: Problem[] = [];
  for (const entry of listOf(value)) {
    const file = typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined;
    if (typeof file !== 'string') {
      problems.push(unsupported(`env_file ${JSON.stringify(entry)}`));
      continue;
    }
    const real = ctx.input.realPaths?.[file];
    const inRepository = isRepositoryPath(file, ctx.input.repositoryFolder) && (typeof real !== 'string' || isInside(real, ctx.input.repositoryFolder));
    if (!inRepository) problems.push(guarded(`env_file ${file}`));
  }
  return problems;
}

/**
 * `network_mode`: every network, also `host` (user decision), except the network of another container
 * (`container:…`), of a service that is not in this configuration (`service:…`, D-9), or of another environment.
 */
function networkModeProblems(value: unknown, ctx: ServiceContext): Problem[] {
  if (isUnset(value)) return [];
  const mode = String(value).trim();
  if (/^container:/i.test(mode)) return [access(`network of another container (${mode})`)];
  if (/^service:/i.test(mode)) {
    const target = mode.slice('service:'.length);
    return ctx.services.has(target) && target !== ctx.name ? [] : [access(`network of another container (${mode})`)];
  }
  // The network of another environment (by its name, its labels, or its containers): account separation.
  const foreign = isOtherEnvironmentProjectName(mode, ctx.input.project) || foreignNetworkItem(mode, ctx.input.networks?.[mode], ctx.input.environment?.id) !== undefined;
  return foreign ? [guarded(`network ${mode} of another environment`)] : [];
}

/** `blkio_config`: the weight only; the limits of devices name devices of the computer. */
function blkioProblems(value: unknown): Problem[] {
  if (!isRecord(value)) return [];
  const problems: Problem[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'weight' || isUnset(entry)) continue;
    if (/^(weight_device|device_(read|write)_(bps|iops))$/.test(key)) problems.push(access(`blkio_config ${key}`));
    else problems.push(unsupported(`blkio_config ${key}`));
  }
  return problems;
}

/**
 * `logging`: drivers that keep the log in files of the container (LOG_DRIVERS), and the options of LOG_OPTIONS. Other
 * drivers stay refused with the checks off, as `--log-driver` (user decision).
 */
function loggingProblems(value: unknown): Problem[] {
  if (!isRecord(value)) return [];
  const problems: Problem[] = [];
  const driver = value.driver;
  if (!isUnset(driver) && !LOG_DRIVERS.includes(String(driver).toLowerCase())) problems.push(guarded(`log driver ${String(driver)}`));
  if (isRecord(value.options)) {
    for (const key of Object.keys(value.options)) if (!LOG_OPTIONS.includes(key)) problems.push(unsupported(`log option ${key}`));
  }
  for (const key of Object.keys(value)) if (key !== 'driver' && key !== 'options') problems.push(unsupported(`logging ${key}`));
  return problems;
}

/**
 * `deploy` (Swarm, out of scope): only limits of resources, the restart policy (its condition rewritten, P7-1; review
 * round 8, P8-1: `delay`, `window`, and `max_attempts` too, which rewriteModel removes with the condition `none`), one
 * replica, and the mode `replicated` (the default); a GPU or another device (`resources.reservations.devices`) is access
 * to the computer.
 */
function deployProblems(value: unknown): Problem[] {
  if (!isRecord(value)) return [];
  const problems: Problem[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (isUnset(entry)) continue;
    if (key === 'resources' && isRecord(entry)) {
      for (const [kind, resources] of Object.entries(entry)) {
        if (isUnset(resources)) continue;
        const allowed = kind === 'limits' ? ['cpus', 'memory', 'pids'] : kind === 'reservations' ? ['cpus', 'memory'] : undefined;
        if (!allowed || !isRecord(resources)) {
          problems.push(unsupported(`deploy.resources.${kind}`));
          continue;
        }
        for (const [name, setting] of Object.entries(resources)) {
          if (allowed.includes(name) || isUnset(setting)) continue;
          if (kind === 'reservations' && name === 'devices') problems.push(access('GPU or device access (deploy.resources.reservations.devices)'));
          else problems.push(unsupported(`deploy.resources.${kind}.${name}`));
        }
      }
    } else if (key === 'restart_policy' && isRecord(entry)) {
      for (const [name, setting] of Object.entries(entry)) {
        if (isUnset(setting)) continue;
        // Review round 7, P7-1: every condition is allowed, rewriteModel makes it `none` (review round 8, S8-6: also
        // `on-failure`).
        if (!RESTART_POLICY_SETTINGS.includes(name)) {
          problems.push(unsupported(`deploy.restart_policy.${name} ${String(setting)}`));
        }
      }
    } else if (key === 'replicas' || key === 'mode') {
      // Review round 8, P8-1: one container per service, as without `deploy`.
      const allowed = key === 'replicas' ? entry === 1 || entry === '1' : entry === 'replicated';
      if (!allowed) problems.push(unsupported(`deploy.${key} ${String(entry)}`));
    } else {
      problems.push(unsupported(`deploy.${key}`));
    }
  }
  return problems;
}

/** The settings of `deploy.restart_policy` that the policy allows (review round 8, P8-1). */
const RESTART_POLICY_SETTINGS = ['condition', 'delay', 'window', 'max_attempts'];

const BUILD_ALLOWED = new Set([
  'context',
  'dockerfile',
  'dockerfile_inline',
  'args',
  'target',
  'network',
  'shm_size',
  'extra_hosts',
  'isolation',
  'platforms',
  'pull',
  'no_cache',
  'ulimits',
  'labels',
  'cache_from',
  'additional_contexts',
]);

/**
 * `build`: the context goes from the workspace helper to the builder, so only the repository folder (or a folder in it);
 * a remote context is not supported yet (review round 5, S5-4); the Dockerfile in the repository. Build secrets, SSH, entitlements, and privileged builds are
 * access to the computer; tags and exported caches could overwrite images or write files.
 */
function buildProblems(value: unknown, ctx: ServiceContext): Problem[] {
  if (isUnset(value)) return [];
  if (!isRecord(value)) return [unsupported(`build ${JSON.stringify(value)}`)];
  const problems: Problem[] = [];
  const context = typeof value.context === 'string' ? value.context : undefined;
  const remote = context !== undefined && isRemoteContext(context);
  // Review round 3 (P3-1): a missing context or Dockerfile of the repository is left to composeMissingBuildPaths.
  const contextMissing = context !== undefined && !remote && isMissing(context, ctx);
  const contextProblems =
    context === undefined ? [access(`build context ${String(value.context)}`)] : remote || contextMissing ? [] : localPathProblems(`build context ${context}`, context, ctx);
  problems.push(...contextProblems);
  // Review round 5 (S5-4): a remote context is not supported. Its Dockerfile is not checked either way (Dockerfile
  // refusals removed, user decision 2026-09-27), but the checks of the context value itself (for example
  // `docker-image://` or `oci-layout://` with a path of the workspace helper) and the build of the dev service from the
  // Dockerfile text that Dev Environments read (composeBuildModel) need a local context.
  if (remote) problems.push(unsupported(`build context ${context} (a remote build context is not supported yet)`));
  if (!remote && !contextMissing && context !== undefined && isUnset(value.dockerfile_inline) && !isMissing(dockerfilePath(context, value), ctx)) {
    const dockerfile = typeof value.dockerfile === 'string' ? value.dockerfile : undefined;
    const file = dockerfilePath(context, value);
    // The default Dockerfile of a context outside the repository is outside with it: named only when it is worse than
    // the context (a link of it to a path of the workspace helper, while the switch lifts the context).
    const contextGuarded = contextProblems.some((problem) => problem.class !== 'computer');
    const fileProblems = localPathProblems(`Dockerfile ${dockerfile ?? 'Dockerfile'}`, file, ctx).filter(
      (problem) => dockerfile !== undefined || contextProblems.length === 0 || (!contextGuarded && problem.class !== 'computer'),
    );
    problems.push(...fileProblems);
    // The Dockerfile of the dev service that the model run could not read: the build writes the text that was read
    // (composeBuildModel), and the texts that the CLI writes into its compose file come from it (devBuildTextProblems).
    // A refusal that the switch lifts does not excuse it. The Dockerfile of another service that could not be read is
    // not refused for that (Dockerfile refusals removed, user decision 2026-09-27): a link of it out of the repository is
    // refused by localPathProblems, and otherwise the update check and the configuration hash skip it.
    const dockerfiles = ctx.input.dockerfiles;
    const refused = [...contextProblems, ...fileProblems].some((problem) => problem.class !== 'computer');
    if (ctx.isDev && dockerfiles !== undefined && !refused && !Object.prototype.hasOwnProperty.call(dockerfiles, ctx.name)) {
      problems.push(unsupported(`Dockerfile ${file} (it could not be read, and the dev service is built from the text that Dev Environments read)`));
    }
  }
  // The Dockerfile (or `dockerfile_inline`) of the dev service, for devBuildTextProblems.
  const text = ctx.input.dockerfiles?.[ctx.name];
  // U1: a size limit for every service with a Dockerfile that was read, not a check of its content: the model run reads
  // at most one character more than MAX_DOCKERFILE_LENGTH, and the configuration hash sees only that text, so an edit
  // after it would offer no rebuild. The dev service has its own reason (devBuildTextProblems).
  if (!ctx.isDev && text !== undefined && text.length > MAX_DOCKERFILE_LENGTH) {
    problems.push(unsupported(`the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the Dockerfile is too large)`));
  }
  problems.push(...labelProblems(value.labels, 'build '));
  // Review round 16 (Dp): what the Dev Container CLI writes as text into its compose file for the build of the dev service.
  if (ctx.isDev) problems.push(...devBuildTextProblems(value, text));
  for (const [key, setting] of Object.entries(value)) {
    if (BUILD_ALLOWED.has(key) || isExtension(key) || isUnset(setting)) continue;
    if (['ssh', 'secrets', 'entitlements', 'privileged'].includes(key)) problems.push(access(`build ${key}`));
    else problems.push(unsupported(`build ${key}`));
  }
  // Review round 2 (S2-03): the files of `ssh` and `secrets` are read by the build client in the workspace helper.
  problems.push(...buildSshProblems(value.ssh, ctx), ...buildSecretProblems(value.secrets, ctx));
  for (const entry of listOf(value.cache_from)) {
    const text = String(entry).trim();
    if (text.includes('=') ? !/^type=registry(,|$)/.test(text) : text === '') problems.push(unsupported(`build cache_from ${text}`));
  }
  if (isRecord(value.additional_contexts)) {
    for (const [name, source] of Object.entries(value.additional_contexts)) {
      const image = /^docker-image:\/\/(.*)$/i.exec(String(source).trim());
      if (image) problems.push(...imageProblems(image[1], `build additional_contexts ${name} image`));
      else if (!/^https?:\/\//i.test(String(source))) {
        const item = `build additional_contexts ${name}=${String(source)}`;
        // Review round 2 (S2-03): a folder (also of `oci-layout://`) is read by the build client in the workspace helper.
        const folder = localContextPath(String(source));
        problems.push(access(item), ...(folder === undefined ? [] : helperInputProblems(item, folder, ctx)));
      }
    }
  } else if (!isUnset(value.additional_contexts)) {
    problems.push(unsupported('build additional_contexts'));
  }
  return problems;
}

/**
 * Review round 16 (Dp): a stage name as the Dev Container CLI writes it into its compose file for the build (the target
 * of the build of the dev service, or the name of its last stage): Docker takes only such names anyway.
 */
const BUILD_STAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Review round 16 (Dp): the last FROM line of a Dockerfile, and its stage name, read as the CLI 0.89.0 reads them (`yj`, `Fj`). */
const CLI_FROM_LINE = /^(?<line>\s*FROM.*)/gim;
const CLI_FROM = /FROM\s+(?<platform>--platform=\S+\s+)?(?<image>"?[^\s]+"?)(\s+AS\s+(?<label>[^\s]+))?/i;
const BUILD_TEXT = 'the Dev Container CLI writes it into its compose file for the build as it is';

/**
 * The stage name of the last FROM line of `dockerfile`, as the Dev Container CLI 0.89.0 reads it (function `DQ`), or
 * `undefined` without one.
 */
function lastStageName(dockerfile: string): string | undefined {
  const lines = [...dockerfile.matchAll(CLI_FROM_LINE)];
  const line = lines.length > 0 ? lines[lines.length - 1].groups?.line : undefined;
  return line === undefined ? undefined : CLI_FROM.exec(line)?.groups?.label;
}

/**
 * Review round 16 (Dp): the Dev Container CLI 0.89.0 writes a compose file for the build of the dev service (function
 * `Dp`) with `- _DEV_CONTAINERS_BASE_IMAGE=<stage>` in `build.args`, as text: the stage is `build.target`, or the name of
 * the last stage of the Dockerfile (`DQ`). It writes it with and without Features, so a stage name that is no plain name
 * and a Dockerfile with a line break of YAML that the CLI reads as part of a name or value (NEL) are refused, whatever
 * the switch says. A line break in such a text would add keys to the build or to the dev service (for example `ssh` with
 * a file of the workspace helper). A Dockerfile longer than MAX_DOCKERFILE_LENGTH is refused too: the model run reads
 * at most one character more, and the build writes the text that it read (composeBuildModel), which would be cut.
 */
function devBuildTextProblems(build: Record<string, unknown>, dockerfile: string | undefined): Problem[] {
  if (dockerfile !== undefined && dockerfile.length > MAX_DOCKERFILE_LENGTH) {
    return [unsupported(`the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the dev service is built from the text that Dev Environments read)`)];
  }
  const problems: Problem[] = [];
  const target = build.target;
  if (target !== undefined && target !== null && target !== '') {
    if (!(typeof target === 'string' && BUILD_STAGE_NAME.test(target))) {
      problems.push(unsupported(`build target ${JSON.stringify(target)} (${BUILD_TEXT}: only a plain stage name is supported)`));
    }
  } else if (dockerfile !== undefined) {
    // Review round 18 (P18-2): the expression of lastStageName takes time that grows with the square of a run of blank
    // lines.
    if (hasLongBlankRun(dockerfile)) {
      return [unsupported(`the Dockerfile (the Dockerfile has too many blank lines in a row, so the stage that ${BUILD_TEXT} cannot be checked)`)];
    }
    const stage = lastStageName(dockerfile);
    if (stage !== undefined && !BUILD_STAGE_NAME.test(stage)) {
      problems.push(unsupported(`the last stage ${JSON.stringify(stage)} of the Dockerfile (${BUILD_TEXT}: only a plain stage name is supported)`));
    }
  }
  if (dockerfile !== undefined && /[\u0085]/.test(dockerfile)) {
    problems.push(unsupported(`the Dockerfile, which holds the character U+0085 (${BUILD_TEXT}: a line break in a name or value is not supported)`));
  }
  return problems;
}

/** Review round 18 (P18-2): the most line breaks in a run of whitespace that lastStageName reads (hasLongBlankRun). */
export const MAX_BLANK_LINES = 200;

/**
 * Review round 18 (P18-2): whether `text` has a run of whitespace with more than MAX_BLANK_LINES line breaks (the line
 * terminators of JavaScript's `^`: LF, CR, U+2028, U+2029). Linear.
 */
function hasLongBlankRun(text: string): boolean {
  let breaks = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) {
      if (++breaks > MAX_BLANK_LINES) return true;
    } else if (!WHITESPACE.test(text[i])) {
      breaks = 0;
    }
  }
  return false;
}

const WHITESPACE = /^\s$/;

/** The Dockerfile of a local build, as the model run resolves it (absolute). */
function dockerfilePath(context: string, build: Record<string, unknown>): string {
  return path.posix.resolve(context, typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile');
}

/** Whether `file` is a missing path of the repository (ComposeAccessInput.missing, review round 3, P3-1). */
function isMissing(file: string, ctx: ServiceContext): boolean {
  return missingSet(ctx.input.missing).has(file) && isRepositoryPath(file, ctx.input.repositoryFolder);
}

/** Review round 9 (S9-1): ComposeAccessInput.missing as a Set (one per list), so that a lookup costs constant time. */
const missingSets = new WeakMap<readonly string[], ReadonlySet<string>>();
function missingSet(missing: readonly string[] | undefined): ReadonlySet<string> {
  if (missing === undefined) return new Set();
  let set = missingSets.get(missing);
  if (set === undefined) {
    set = new Set(missing);
    missingSets.set(missing, set);
  }
  return set;
}

/**
 * Review round 3 (P3-1): the local build contexts and Dockerfiles of the model that do not exist in the repository
 * (ComposeAccessInput.missing), each named with its service. Not a refusal of the policy (composeAccessReport leaves
 * them out): the pipeline reports them as an error of the configuration, which still starts the existing environment,
 * and builds nothing. A link that leads out of the repository, or nowhere, is no missing path: the policy refuses it.
 */
export function composeMissingBuildPaths(input: Pick<ComposeAccessInput, 'model' | 'missing' | 'repositoryFolder'>): string[] {
  const missing = missingSet(input.missing);
  const items: string[] = [];
  if (missing.size === 0) return items;
  for (const [name, service] of Object.entries(isRecord(input.model.services) ? input.model.services : {})) {
    const build = isRecord(service) && isRecord(service.build) ? service.build : undefined;
    const context = build !== undefined && typeof build.context === 'string' ? build.context : undefined;
    if (build === undefined || context === undefined || isRemoteContext(context)) continue;
    const inRepository = (file: string): boolean => missing.has(file) && isRepositoryPath(file, input.repositoryFolder);
    if (inRepository(context)) items.push(`service ${name}: build context ${context}`);
    else if (isUnset(build.dockerfile_inline) && inRepository(dockerfilePath(context, build))) items.push(`service ${name}: Dockerfile ${dockerfilePath(context, build)}`);
  }
  return items;
}

/**
 * A file or folder that the build client reads in the workspace helper besides the context and the Dockerfile (review
 * round 2, S2-03: a local additional context, the file of a build secret, an SSH key): refused whatever the switch says
 * when it is a path of the workspace helper or leads there through a link (localPathProblems), or when it is relative
 * (the folder that it is resolved against is not clear). Otherwise nothing: the rule of the setting itself decides (the
 * class `computer`).
 */
function helperInputProblems(item: string, file: string, ctx: ServiceContext): Problem[] {
  if (!file.startsWith('/')) return [guarded(`${item} (a relative path)`)];
  return localPathProblems(item, file, ctx).filter((problem) => problem.class !== 'computer');
}

/**
 * `build.ssh`: each key file (`id=<path>`, `{ id, path }`, or a map); `default` alone is the SSH agent (the rule of
 * `ssh`).
 */
function buildSshProblems(value: unknown, ctx: ServiceContext): Problem[] {
  const entries: Array<[string, unknown]> = isRecord(value)
    ? Object.entries(value)
    : listOf(value).map((entry): [string, unknown] => {
        if (isRecord(entry)) return [String(entry.id ?? ''), entry.path];
        const text = String(entry);
        const index = text.indexOf('=');
        return index < 0 ? [text, undefined] : [text.slice(0, index), text.slice(index + 1)];
      });
  const problems: Problem[] = [];
  for (const [id, paths] of entries) {
    for (const file of String(paths ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '')) {
      problems.push(...helperInputProblems(`build ssh ${id}=${file}`, file, ctx));
    }
  }
  return problems;
}

/** `build.secrets`: the `file` of each top-level secret that it names (a secret of `environment` is no file). */
function buildSecretProblems(value: unknown, ctx: ServiceContext): Problem[] {
  const secrets = isRecord(ctx.input.model.secrets) ? ctx.input.model.secrets : {};
  const problems: Problem[] = [];
  for (const entry of listOf(value)) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.source === 'string' ? entry.source : undefined;
    if (name === undefined) continue;
    const secret = secrets[name];
    if (isRecord(secret) && typeof secret.file === 'string') problems.push(...helperInputProblems(`build secret ${name} file ${secret.file}`, secret.file, ctx));
  }
  return problems;
}

/**
 * A local path of a build (its context or its Dockerfile, absolute as `docker compose config` prints it), which the
 * builder reads in the workspace helper, where the cache volume, the folder with the token, and the Docker socket are
 * mounted (S1):
 * - in the repository folder (lexically): allowed, unless its real path (ComposeModelOutput.realPaths) does not exist or
 *   is outside the repository (a link out): refused whatever the switch says, because BuildKit follows the link;
 * - outside the repository: a path of the workspace helper (isHelperPath, also after links) stays refused whatever the
 *   switch says, and so does a path whose real path is not known because it does not exist or its link leads nowhere
 *   (review round 3, S3-1: for example a link of /proc); any other one is access to the computer (lifted while the checks
 *   are off).
 */
function localPathProblems(item: string, file: string, ctx: ServiceContext): Problem[] {
  const repository = ctx.input.repositoryFolder;
  const realPaths = ctx.input.realPaths;
  const known = realPaths !== undefined && Object.prototype.hasOwnProperty.call(realPaths, file);
  const real = known ? realPaths[file] : undefined;
  if (isRepositoryPath(file, repository)) {
    if (known && real === null) {
      // Review round 4 (P4-1): with the list of the model run, a path of the repository that does not exist and whose
      // links stay in the repository is in `missing` (composeMissingBuildPaths); what is left is a link that leads out or
      // in a circle.
      return [guarded(ctx.input.missing !== undefined ? `${item} (a link that leads out of the repository or in a circle, to a path that does not exist)` : `${item} (the path does not exist in the repository)`)];
    }
    if (typeof real === 'string' && !isInside(real, repository)) return [guarded(`${item} (a link to ${real}, outside of the repository)`)];
    return [];
  }
  if (!file.startsWith('/')) return [access(item)];
  if (isHelperPath(file, repository) || (typeof real === 'string' && isHelperPath(real, repository))) return [guarded(item)];
  if (known && real === null) return [guarded(`${item} (the path does not exist)`)];
  return [access(item)];
}

function serviceProblems(service: unknown, ctx: ServiceContext): Problem[] {
  if (!isRecord(service)) return [unsupported('the service is no object')];
  const problems: Problem[] = [];
  for (const [key, value] of Object.entries(service)) {
    if (isExtension(key)) continue;
    const rule = Object.prototype.hasOwnProperty.call(SERVICE_RULES, key) ? SERVICE_RULES[key] : undefined;
    if (rule) problems.push(...rule(value, ctx));
    else if (value !== undefined && value !== null) problems.push(unsupported(key));
  }
  if (ctx.isDev && isUnset(service.image) && isUnset(service.build)) problems.push(unsupported('no image and no build'));
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Top level

/** Review round 22 (H22-5): the hint of a refused driver or driver options of a top-level volume. */
const VOLUME_DRIVER_HINT = 'Dev Environments creates the volumes with the local driver and without options; for a tmpfs, use the tmpfs option of the service';

const VOLUME_ALLOWED = new Set(['name', 'external', 'driver', 'driver_opts', 'labels']);

function topLevelVolumeProblems(input: ComposeAccessInput): Problem[] {
  const problems: Problem[] = [];
  const volumes = isRecord(input.model.volumes) ? input.model.volumes : {};
  const names = new Map(composeVolumeNames(input.model, input.project).map((volume) => [volume.key, volume.name]));
  for (const [key, volume] of Object.entries(volumes)) {
    const at = `volume ${key}: `;
    if (key === WORKSPACE_VOLUME_KEY) problems.push(unsupported(`volume key ${key} (Dev Environments uses it)`));
    const name = names.get(key) ?? key;
    if (isOtherEnvironmentProjectName(name, input.project)) problems.push(guarded(`volume ${name} of another environment`));
    else problems.push(...volumeNameFindings(name, input));
    if (!isRecord(volume)) continue;
    // Review round 22 (H22-5): the pipeline creates every volume itself (composeUpModel makes them external), with the
    // local driver and without options, so a driver or driver options would be dropped (for example a tmpfs volume would
    // become a volume on the disk): not supported, whatever the switch says.
    if (!isUnset(volume.driver) && String(volume.driver) !== 'local') problems.push(unsupported(`${at}driver ${String(volume.driver)} (${VOLUME_DRIVER_HINT})`));
    if (!isUnset(volume.driver_opts)) problems.push(unsupported(`${at}driver options (${VOLUME_DRIVER_HINT})`));
    problems.push(...labelProblems(volume.labels, at));
    for (const [option, value] of Object.entries(volume)) {
      if (!VOLUME_ALLOWED.has(option) && !isExtension(option) && value !== undefined && value !== null) problems.push(unsupported(`${at}${option}`));
    }
  }
  return problems;
}

const NETWORK_ALLOWED = new Set(['name', 'external', 'driver', 'driver_opts', 'ipam', 'internal', 'attachable', 'enable_ipv4', 'enable_ipv6', 'labels']);

/**
 * Top-level `networks`: the bridge driver only (macvlan and ipvlan put the containers on the network of the computer,
 * without the rule that ports reach it only on localhost), no driver options, and no network of another environment.
 */
function topLevelNetworkProblems(input: ComposeAccessInput): Problem[] {
  const problems: Problem[] = [];
  const networks = isRecord(input.model.networks) ? input.model.networks : {};
  const names = new Map(composeNetworkNames(input.model, input.project).map((network) => [network.key, network.name]));
  for (const [key, network] of Object.entries(networks)) {
    if (!isRecord(network)) continue;
    const at = `network ${key}: `;
    const name = names.get(key) ?? key;
    // A network of another environment (by its name, its labels, or its containers): account separation.
    if (isOtherEnvironmentProjectName(name, input.project) || foreignNetworkItem(name, input.networks?.[name], input.environment?.id) !== undefined) {
      problems.push(guarded(`network ${name} of another environment`));
    }
    if (!isUnset(network.driver) && String(network.driver) !== 'bridge') problems.push(access(`${at}driver ${String(network.driver)}`));
    if (!isUnset(network.driver_opts)) problems.push(access(`${at}driver options`));
    problems.push(...labelProblems(network.labels, at));
    for (const [option, value] of Object.entries(network)) {
      if (!NETWORK_ALLOWED.has(option) && !isExtension(option) && value !== undefined && value !== null) problems.push(unsupported(`${at}${option}`));
    }
  }
  return problems;
}

const TOP_LEVEL_ALLOWED = new Set(['name', 'services', 'volumes', 'networks', 'version']);

function topLevelProblems(input: ComposeAccessInput): Problem[] {
  const problems: Problem[] = [];
  const model = input.model;
  if (model.name !== undefined && model.name !== input.project) problems.push(unsupported(`project name ${String(model.name)}`));
  for (const [key, value] of Object.entries(model)) {
    if (TOP_LEVEL_ALLOWED.has(key) || isExtension(key) || isUnset(value)) continue;
    // Review round 22 (H22-4): secretConfigProblems.
    if (key === 'secrets' || key === 'configs') problems.push(...secretConfigProblems(key, value, input));
    else problems.push(unsupported(key));
  }
  problems.push(...topLevelVolumeProblems(input), ...topLevelNetworkProblems(input));
  return problems;
}

/**
 * Review round 22 (H22-4): the top-level `secrets` and `configs`. From the environment of Compose (`environment`) or,
 * for a config, the text in the file (`content`): allowed (Compose copies them into the container; the token is never a
 * variable of that environment). A `file` is a bind mount that the Docker Engine reads on the computer: one of the
 * repository is not supported (a bind mount of it, read-only, is rewritten to the workspace volume), one of the
 * workspace helper stays refused whatever the switch says, any other one is access to the computer. Everything else
 * (`external`, a driver, and unknown keys) is not supported.
 */
function secretConfigProblems(key: 'secrets' | 'configs', value: unknown, input: ComposeAccessInput): Problem[] {
  const kind = key === 'secrets' ? 'secret' : 'config';
  if (!isRecord(value)) return [unsupported(key)];
  const problems: Problem[] = [];
  for (const [name, entry] of Object.entries(value)) {
    const at = `${kind} ${name}: `;
    if (!isRecord(entry)) {
      problems.push(unsupported(`${at}${JSON.stringify(entry)}`));
      continue;
    }
    for (const [option, setting] of Object.entries(entry)) {
      if (isExtension(option) || setting === undefined || setting === null) continue;
      if (option === 'name' || option === 'environment' || (option === 'content' && kind === 'config')) continue;
      if (option !== 'file') {
        problems.push(unsupported(`${at}${option}`));
        continue;
      }
      const file = String(setting);
      if (isRepositoryPath(file, input.repositoryFolder)) {
        const target = kind === 'secret' ? `/run/secrets/${name}` : `/${name}`;
        problems.push(unsupported(`${at}file ${file} (a file of the repository is not supported; mount it read-only instead, for example ./${path.posix.basename(file)}:${target}:ro)`));
      } else if (!file.startsWith('/')) {
        problems.push(guarded(`${at}file ${file} (a relative path)`));
      } else if (isHelperPath(file, input.repositoryFolder)) {
        problems.push(guarded(`${at}file ${file}`));
      } else {
        problems.push(access(`${at}file ${file}`));
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Report

/**
 * The problems without duplicates: an item that two rules name keeps the class that the switch does not lift (as
 * hostAccessFindings does).
 */
function findings(problems: readonly Problem[]): Problem[] {
  // Review round 8 (S8-5): by a Map of the items, not a search of the list for each problem (quadratic time).
  const result = new Map<string, Problem>();
  for (const problem of problems) {
    const known = result.get(problem.item);
    if (!known) result.set(problem.item, { ...problem });
    else if (known.class === 'computer' && problem.class !== 'computer') known.class = problem.class;
  }
  return [...result.values()];
}

/**
 * The settings of the merged model of a Docker Compose configuration that need access to the computer, or that the
 * policy does not know (implementation notes, section "Docker Compose", rule table), in two lists as hostAccessReport:
 * the top level (project name, volumes, networks, secrets, configs, unknown keys), then each service, its items
 * prefixed `service <name>: `. The dev service must be in the model, and so must each name of `runServices`.
 * `checksOn`: the switch of the repository (./hostAccessChecks.ts); `false` leaves out the items of the class
 * `computer` (composeAccessClassification), exactly as hostAccessReport does for a single container.
 */
export function composeAccessReport(input: ComposeAccessInput, checksOn = true): HostAccessReport {
  const result: HostAccessReport = { hostAccess: [], unsupported: [] };
  for (const problem of composeFindings(input)) {
    if (!checksOn && problem.class === 'computer') continue;
    result[problem.class === 'unsupported' ? 'unsupported' : 'hostAccess'].push(problem.item);
  }
  return result;
}

/**
 * Every item that composeAccessReport refuses while the checks are on, with its class: which of them the switch lifts
 * (`computer`) and which stay refused (`protected`, `unsupported`). For the tests and the documentation of the switch.
 */
export function composeAccessClassification(input: ComposeAccessInput): HostAccessFinding[] {
  return composeFindings(input).map((problem) => ({ item: problem.item, class: problem.class }));
}

function composeFindings(input: ComposeAccessInput): Problem[] {
  return readComposeFindings(input);
}

function readComposeFindings(input: ComposeAccessInput): Problem[] {
  const problems: Problem[] = [];
  const services = isRecord(input.model.services) ? input.model.services : {};
  const names = new Set(Object.keys(services));
  if (!names.has(input.devService)) problems.push(unsupported(`service ${input.devService} (not in the Docker Compose configuration)`));
  if (input.runServices !== undefined) {
    if (!Array.isArray(input.runServices)) problems.push(unsupported(`runServices ${JSON.stringify(input.runServices)}`));
    else {
      for (const name of input.runServices) {
        if (typeof name !== 'string' || !names.has(name)) problems.push(unsupported(`runServices ${JSON.stringify(name)} (not in the Docker Compose configuration)`));
      }
    }
  }
  problems.push(...topLevelProblems(input));
  const volumeNames = new Map(composeVolumeNames(input.model, input.project).map((volume) => [volume.key, volume.name]));
  const pidGroup = devPidGroup(services, input.devService);
  for (const [name, service] of Object.entries(services)) {
    const isDev = name === input.devService;
    const ctx: ServiceContext = {
      name,
      isDev,
      input,
      services: names,
      devPidGroup: pidGroup,
      mounts: {
        isDev,
        repositoryFolder: input.repositoryFolder,
        volumeNames,
        ownVolume: input.ownVolume,
        engineApiVersion: input.engineApiVersion,
        realPaths: input.realPaths,
        mountAncestors: input.mountAncestors,
      },
    };
    for (const problem of serviceProblems(service, ctx)) problems.push({ ...problem, item: `service ${name}: ${problem.item}` });
  }
  return findings(problems);
}

/**
 * The image references of the merged model (review round 2, S2-05), for the question whether Docker takes one of them
 * for an image ID (resolvedByImageId): the `image` of each service without a build, and the images of
 * `additional_contexts`. Each named with its service, as composeAccessReport names its items. The images of the
 * Dockerfiles are not asked about (Dockerfile refusals removed, user decision 2026-09-27).
 */
export function composeImageReferences(model: ComposeModel): NamedImageReference[] {
  const references: NamedImageReference[] = [];
  for (const [name, service] of Object.entries(isRecord(model.services) ? model.services : {})) {
    if (!isRecord(service)) continue;
    const at = `service ${name}: `;
    const build = isRecord(service.build) ? service.build : undefined;
    if (!build) {
      if (typeof service.image === 'string' && service.image.trim() !== '') references.push({ reference: service.image.trim(), what: `${at}image` });
      continue;
    }
    if (isRecord(build.additional_contexts)) {
      for (const [key, source] of Object.entries(build.additional_contexts)) {
        const image = /^docker-image:\/\/(.*)$/i.exec(String(source).trim());
        if (image) references.push({ reference: image[1].trim(), what: `${at}build additional_contexts ${key} image` });
      }
    }
  }
  return references;
}

/**
 * The settings of devcontainer.json that a Docker Compose configuration does not support (beside the rules of
 * hostAccessReport, which apply as for a single container): a local Feature (`./…`). The CLI's `build` has no
 * `--override-config`, so the configuration is built from our copy in the helper (buildArgs), where a local Feature,
 * which the CLI resolves against the folder of the configuration, is not found.
 */
export function composeConfigurationReport(config: Readonly<Record<string, unknown>>): HostAccessReport {
  const features = isRecord(config.features) ? Object.keys(config.features) : [];
  const local = features.filter((key) => !isOciFeatureReference(key) && /^\.{1,2}\//.test(key.trim()));
  return { hostAccess: [], unsupported: local.map((key) => `local Feature ${key} in a Docker Compose configuration`) };
}

/**
 * The properties of devcontainer.json that the Dev Container CLI ignores for Docker Compose (D-18), for a log line:
 * `runArgs` and `appPort` (read only for a single container), `workspaceMount` (CLI 0.89.0: `if("dockerComposeFile"in
 * t)return{workspaceFolder:pp(t),workspaceMount:void 0,…}`), and `build.options`. The policy does not check them.
 */
export function composeIgnoredProperties(config: Readonly<Record<string, unknown>>): string[] {
  const ignored: string[] = [];
  for (const key of ['runArgs', 'appPort', 'workspaceMount']) if (config[key] !== undefined) ignored.push(key);
  if (isRecord(config.build) && config.build.options !== undefined) ignored.push('build.options');
  return ignored;
}

/**
 * A configuration without the properties that the Dev Container CLI ignores for Docker Compose (composeIgnoredProperties:
 * runArgs, appPort, workspaceMount, build.options): the host access policy does not refuse what has no effect.
 */
export function withoutComposeIgnored(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...config };
  delete result.runArgs;
  delete result.appPort;
  delete result.workspaceMount;
  if (isRecord(result.build) && 'options' in result.build) {
    const build = { ...result.build };
    delete build.options;
    result.build = build;
  }
  return result;
}
