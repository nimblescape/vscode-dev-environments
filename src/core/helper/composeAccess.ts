// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Host access policy for Docker Compose configurations (concept section 9 "Host access", implementation notes section
// "Docker Compose"): the rules of hostAccess.ts for every service of the merged model that `docker compose config`
// prints (all profiles), not only for the dev service, because Compose starts them all with the Docker engine of the
// computer. An allow-list, like RUN_FLAGS: a key that the policy does not know is refused as not supported, because a
// new key of Compose can reach the computer. The mounts and the ports are decided by the functions of compose.ts that
// the rewrite uses too, so the check and the model that runs cannot disagree. Each refused item has the class of the
// switch of the host access checks (HostAccessClass of hostAccess.ts, container-restrictions.md section 12), as the same
// setting has for a single container: with the checks off for the repository, only the class `computer` is lifted.
// Pure functions, no I/O.
import * as path from 'path';
import { isOciFeatureReference } from '../imageCheck/reference';
import {
  composeNetworkNames,
  composeVolumeNames,
  decideServiceMount,
  decideServicePort,
  isOtherEnvironmentProjectName,
  WORKSPACE_VOLUME_KEY,
  type ComposeModel,
  type ComposeMountContext,
} from './compose';
import {
  LOG_DRIVERS,
  LOG_OPTIONS,
  MAX_STOP_TIMEOUT_SECONDS,
  RESERVED_COMPOSE_LABEL,
  RESERVED_LABEL,
  RESTART_POLICY,
  capabilityProblems,
  dockerfileImageFindings,
  dockerfileImageReferences,
  foreignNetworkItem,
  imageReferenceFinding,
  isHelperPath,
  localContextPath,
  refusedVariableItem,
  securityOptionProblems,
  volumeNameFindings,
  type HostAccessClass,
  type HostAccessFinding,
  type HostAccessReport,
  type NamedImageReference,
  type VolumeInput,
} from './hostAccess';

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
  /**
   * ComposeModelOutput.dockerfiles: the FROM images of each local build are checked (no image of another environment),
   * and a local build whose Dockerfile could not be read is refused (its images would escape the image check).
   * Without it, neither is checked.
   */
  dockerfiles?: Readonly<Record<string, string>>;
  /**
   * ComposeModelOutput.missing (review round 3, P3-1): a build context or Dockerfile in the repository that does not
   * exist is no refusal of the policy: composeMissingBuildPaths names it for a plain error of the configuration.
   */
  missing?: readonly string[];
}

interface Problem {
  item: string;
  class: HostAccessClass;
}

/** Access to the computer: lifted while the host access checks are off (HostAccessClass `computer`). */
const access = (item: string): Problem => ({ item, class: 'computer' });
/** Refused whatever the switch says (HostAccessClass `protected`): account separation, the token, the owner account. */
const guarded = (item: string): Problem => ({ item, class: 'protected' });
const unsupported = (item: string): Problem => ({ item, class: 'unsupported' });

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
    .filter((key) => RESERVED_LABEL.test(key) || RESERVED_COMPOSE_LABEL.test(key))
    .map((key) => unsupported(`${where}label ${key}`));
}

/** imageReferenceFinding of hostAccess.ts as a problem: the image of another environment (D-17), or an image ID. */
function imageProblems(reference: string, what: string): Problem[] {
  const finding = imageReferenceFinding(reference, what);
  return finding ? [finding] : [];
}

/** A Go duration (`20s`, `1m30s`, `500ms`) in seconds; `undefined` when it is none. */
export function durationSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^(\d+(\.\d+)?(h|m|s|ms|us|µs|ns))+$/.test(value.trim())) return undefined;
  const factors: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, µs: 1e-6, ns: 1e-9 };
  let seconds = 0;
  for (const match of value.trim().matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) seconds += Number(match[1]) * factors[match[2]];
  return seconds;
}

function isInside(file: string, folder: string): boolean {
  return file === folder || file.startsWith(`${folder}/`);
}

/** A path of the model (absolute, as `docker compose config` resolves it) strictly below the repository folder. */
function isRepositoryPath(file: string, repositoryFolder: string): boolean {
  return file.startsWith('/') && !file.split('/').includes('..') && isInside(path.posix.normalize(file), repositoryFolder);
}

/** A remote build context: a URL of Git or HTTP(S). */
function isRemoteContext(context: string): boolean {
  return /^(https?:\/\/|git@|git:\/\/|ssh:\/\/)/i.test(context);
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
  // The image of another environment is refused (D-17): account separation. The images of built services are renamed
  // (rewrite).
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
      const item = refusedVariableItem(name.trim(), 'environment');
      return item === undefined ? [] : [guarded(item)];
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
  // Other containers, whose volumes, environment, and network would join this one.
  volumes_from: refuseAccess('volumes_from'),
  links: refuseAccess('links'),
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
  pid: namespaceRule('pid', []),
  ipc: namespaceRule('ipc', ['private', 'shareable', 'none']),
  uts: namespaceRule('uts', []),
  userns_mode: namespaceRule('userns_mode', []),
  cgroup: namespaceRule('cgroup', ['private']),
  // Docker accepts only settings of the namespaces of the container (as --sysctl, D-13).
  sysctls: allow,
  logging: loggingProblems,
  storage_opt: (value) => (isRecord(value) ? Object.keys(value).filter((key) => key !== 'size').map((key) => unsupported(`storage_opt ${key}`)) : []),
  // `always` and `unless-stopped` would start the container together with Docker, outside the Session Monitor (D-14).
  restart: (value) => (isUnset(value) || RESTART_POLICY.test(String(value)) ? [] : [unsupported(`restart ${String(value)}`)]),
  stop_grace_period: (value) => {
    if (isUnset(value)) return [];
    const seconds = durationSeconds(value);
    return seconds !== undefined && seconds <= MAX_STOP_TIMEOUT_SECONDS ? [] : [unsupported(`stop_grace_period ${String(value)}`)];
  },
  stop_signal: allow,
  deploy: deployProblems,
  // Rewritten (D-16).
  pull_policy: allow,
  // Mounts the Docker socket and the registry credentials of the computer.
  use_api_socket: refuseAccess('the Docker socket (use_api_socket)'),
  // Files of the computer, mounted by Compose.
  secrets: refuseAccess('secrets'),
  configs: refuseAccess('configs'),
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
  tmpfs: allow,
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
 * `deploy` (Swarm, out of scope): only limits of resources and the restart conditions `none`/`on-failure`; a GPU or
 * another device (`resources.reservations.devices`) is access to the computer.
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
        if (name !== 'condition' || !['none', 'on-failure'].includes(String(setting))) {
          problems.push(unsupported(`deploy.restart_policy.${name} ${String(setting)}`));
        }
      }
    } else {
      problems.push(unsupported(`deploy.${key}`));
    }
  }
  return problems;
}

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
  // Review round 5 (S5-4): the Dockerfile of a remote context is not read, so its images cannot be checked (until each
  // build has a builder of its own).
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
    // A Dockerfile that the model run could not read: its FROM images would escape the image check and the rule on the
    // images of other environments (a refusal that the switch lifts does not excuse it).
    const dockerfiles = ctx.input.dockerfiles;
    const refused = [...contextProblems, ...fileProblems].some((problem) => problem.class !== 'computer');
    if (dockerfiles !== undefined && !refused && !Object.prototype.hasOwnProperty.call(dockerfiles, ctx.name)) {
      problems.push(unsupported(`Dockerfile ${file} (it could not be read, so its images cannot be checked)`));
    }
  }
  // The images that the build uses (FROM and the others of the Dockerfile or of `dockerfile_inline`). Review round 5
  // (S5-4): `dockerfile_inline` whatever the context.
  const text = ctx.input.dockerfiles?.[ctx.name];
  if (text !== undefined) {
    const args: Record<string, string> = {};
    if (isRecord(value.args)) {
      for (const [arg, setting] of Object.entries(value.args)) {
        if (typeof setting === 'string' || typeof setting === 'number' || typeof setting === 'boolean') args[arg] = String(setting);
      }
    }
    const target = typeof value.target === 'string' && value.target !== '' ? value.target : undefined;
    // Every image that the Dockerfile names: FROM, COPY --from, RUN --mount from, `# syntax` (review round 2, S2-02).
    problems.push(...dockerfileImageFindings(text, args, target));
  }
  problems.push(...labelProblems(value.labels, 'build '));
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

/** The Dockerfile of a local build, as the model run resolves it (absolute). */
function dockerfilePath(context: string, build: Record<string, unknown>): string {
  return path.posix.resolve(context, typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile');
}

/** Whether `file` is a missing path of the repository (ComposeAccessInput.missing, review round 3, P3-1). */
function isMissing(file: string, ctx: ServiceContext): boolean {
  return (ctx.input.missing ?? []).includes(file) && isRepositoryPath(file, ctx.input.repositoryFolder);
}

/**
 * Review round 3 (P3-1): the local build contexts and Dockerfiles of the model that do not exist in the repository
 * (ComposeAccessInput.missing), each named with its service. Not a refusal of the policy (composeAccessReport leaves
 * them out): the pipeline reports them as an error of the configuration, which still starts the existing environment,
 * and builds nothing. A link that leads out of the repository, or nowhere, is no missing path: the policy refuses it.
 */
export function composeMissingBuildPaths(input: Pick<ComposeAccessInput, 'model' | 'missing' | 'repositoryFolder'>): string[] {
  const missing = input.missing ?? [];
  const items: string[] = [];
  if (missing.length === 0) return items;
  for (const [name, service] of Object.entries(isRecord(input.model.services) ? input.model.services : {})) {
    const build = isRecord(service) && isRecord(service.build) ? service.build : undefined;
    const context = build !== undefined && typeof build.context === 'string' ? build.context : undefined;
    if (build === undefined || context === undefined || isRemoteContext(context)) continue;
    const inRepository = (file: string): boolean => missing.includes(file) && isRepositoryPath(file, input.repositoryFolder);
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
    if (!isUnset(volume.driver) && String(volume.driver) !== 'local') problems.push(access(`${at}driver ${String(volume.driver)}`));
    if (!isUnset(volume.driver_opts)) problems.push(access(`${at}driver options`));
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
    // Compose mounts file secrets and configs as bind mounts of the computer.
    if (key === 'secrets' || key === 'configs') problems.push(access(key));
    else problems.push(unsupported(key));
  }
  problems.push(...topLevelVolumeProblems(input), ...topLevelNetworkProblems(input));
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Report

/**
 * The problems without duplicates: an item that two rules name keeps the class that the switch does not lift (as
 * hostAccessFindings does).
 */
function findings(problems: readonly Problem[]): Problem[] {
  const result: Problem[] = [];
  for (const problem of problems) {
    const known = result.find((other) => other.item === problem.item);
    if (!known) result.push({ ...problem });
    else if (known.class === 'computer' && problem.class !== 'computer') known.class = problem.class;
  }
  return result;
}

/**
 * The settings of the merged model of a Docker Compose configuration that need access to the computer, or that the
 * policy does not know (implementation notes, section "Docker Compose", rule table), in two lists as hostAccessReport:
 * the top level (project name, volumes, networks, secrets, configs, unknown keys), then each service, its items
 * prefixed `service <name>: `. The dev service must be in the model, and so must each name of `runServices`.
 * `checksOn`: the switch of the repository (../hostAccessChecks.ts); `false` leaves out the items of the class
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
  for (const [name, service] of Object.entries(services)) {
    const isDev = name === input.devService;
    const ctx: ServiceContext = {
      name,
      isDev,
      input,
      services: names,
      mounts: {
        isDev,
        repositoryFolder: input.repositoryFolder,
        volumeNames,
        ownVolume: input.ownVolume,
        engineApiVersion: input.engineApiVersion,
        realPaths: input.realPaths,
      },
    };
    for (const problem of serviceProblems(service, ctx)) problems.push({ ...problem, item: `service ${name}: ${problem.item}` });
  }
  return findings(problems);
}

/**
 * The image references of the merged model (review round 2, S2-05), for the question whether Docker takes one of them
 * for an image ID (resolvedByImageId): the `image` of each service without a build, the images of the Dockerfile of each
 * service with a local build (`dockerfiles`, with `build.args` and `build.target`), and the images of
 * `additional_contexts`. Each named with its service, as composeAccessReport names its items.
 */
export function composeImageReferences(model: ComposeModel, dockerfiles: Readonly<Record<string, string>>): NamedImageReference[] {
  const references: NamedImageReference[] = [];
  for (const [name, service] of Object.entries(isRecord(model.services) ? model.services : {})) {
    if (!isRecord(service)) continue;
    const at = `service ${name}: `;
    const build = isRecord(service.build) ? service.build : undefined;
    if (!build) {
      if (typeof service.image === 'string' && service.image.trim() !== '') references.push({ reference: service.image.trim(), what: `${at}image` });
      continue;
    }
    const text = dockerfiles[name];
    if (text !== undefined) {
      const args: Record<string, string> = {};
      if (isRecord(build.args)) {
        for (const [arg, setting] of Object.entries(build.args)) {
          if (typeof setting === 'string' || typeof setting === 'number' || typeof setting === 'boolean') args[arg] = String(setting);
        }
      }
      const target = typeof build.target === 'string' && build.target !== '' ? build.target : undefined;
      for (const reference of dockerfileImageReferences(text, args, target)) references.push({ ...reference, what: `${at}${reference.what}` });
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
