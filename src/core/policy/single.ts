// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The container policy for a single container (concept section 9 "Host access"): a dev container may use the network,
// and nothing else of the computer. Its published ports reach the computer only on localhost (not with `--network host`,
// where the ports of the container are ports of the computer on the addresses that it listens on). The open pipeline
// checks the configuration before every build and before every `devcontainer up` (checkContainer, ./index.ts), and
// refuses a configuration that needs more; it never changes one silently: the flags that it removes from `runArgs`
// (overrideRunArgs, ./rewrites.ts) are named in the log (removedRunArgs). With the checks off for a repository
// (./hostAccessChecks.ts) only the refusals of access to the computer (class `computer`) are lifted, and published ports
// keep the address that the configuration gives them. The rules: ./rules.ts and ./flags.ts. Pure functions, no I/O.
import * as path from 'path';
import { MAX_DOCKERFILE_LENGTH } from '../imageCheck/dockerfile';
import {
  COMPOSE_CLEARED_LABELS,
  LABEL_CONFIG_PATH,
  TOKEN_TMPFS,
  WORKSPACES_ROOT,
  isConfigPathLabelValue,
} from '../names';
import { exposingLocalPortHostValues, LOCAL_PORT_HOST_SETTING } from '../devContainers';
import {
  DEVCONTAINER_ID_PLACEHOLDER,
  HELPER_KNOWN_ENV,
  MAX_CLI_SOURCE_LENGTH,
  MAX_CLI_TEXT_LENGTH,
  SECOND_PASS_VARIABLE_NAMES,
  containsText,
  mayBeSetInHelper,
  resolveCliVariables,
  textLengths,
  unresolvedCliVariables,
  withDevcontainerIdPlaceholder,
  type CliVariables,
} from '../helper/cliVariables';
import {
  checksValue,
  cliList,
  imageContext,
  isPathSource,
  mountType,
  takesValue,
  networkNames,
  objectMountText,
  parseFlags,
  parseMountEntry,
  parseMountString,
  shownBindSource,
  volumeFlagOptions,
  volumeFlagSource,
  volumeFlagTarget,
  isDockerNetworkMode,
  type MountSpec,
} from './dockerFlags';
import { BUILD_FLAGS, RUN_FLAGS, flagProblems, networkProblems, portProblems } from './flags';
import { imageReferenceFinding, type NamedImageReference } from './images';
import { overrideRunArgs } from './rewrites';
import {
  access,
  accessAll,
  capped,
  guarded,
  unsupported,
  type HostAccessFinding,
  type HostAccessReport,
  type Problem,
} from './report';
import {
  capabilityProblems,
  configFolderMountItem,
  configFolderTarget,
  isHelperPath,
  isSharedPropagation,
  refusedVariable,
  securityOptionProblems,
  sharedPropagationItem,
  tokenPropagationTarget,
} from './rules';
import { volumeContext, volumeNameProblems, type VolumeContext, type VolumeInput } from './volumes';

export interface HostAccessInput extends VolumeInput {
  /** The repository configuration, as `devcontainer read-configuration` resolved it (`configuration`). */
  config?: Record<string, unknown>;
  /** `mergedConfiguration` of `devcontainer read-configuration --include-merged-configuration`. */
  merged?: Record<string, unknown>;
  /** Entries of the label devcontainer.metadata of the environment image: base image, Features, configuration. */
  metadata?: readonly unknown[];
  /**
   * The folder of the configuration in the workspace helper (for example `/workspaces/api/.devcontainer`), against which
   * the CLI resolves `build.context` and `build.dockerfile` of a single container. Without it, they are not checked.
   */
  configFolder?: string;
  /** The folder of the repository in the workspace helper (for example `/workspaces/api`), for isHelperPath. */
  repositoryFolder?: string;
  /**
   * The length of the Dockerfile of a single container, read at the path that the configuration names after the CLI
   * resolved its variables (review round 2, S2-01), at most MAX_DOCKERFILE_LENGTH + 1 characters (READ_FILES_SCRIPT).
   * A longer Dockerfile is refused as not supported (U1): the configuration hash would see only its start. Its content
   * is not checked (Dockerfile refusals removed, user decision 2026-09-27).
   */
  dockerfileLength?: number;
  /**
   * The Dockerfile that the configuration of a single container names (as written), when it exists but could not be
   * read (U2): a link out of the repository (for example into the internal folder or the cache volume), a real
   * path outside of it, or a path with a variable that is not resolved. Refused whatever the switch says (`protected`):
   * the CLI and BuildKit in the workspace helper would read that file as the Dockerfile.
   */
  dockerfileUnreadable?: string;
  /**
   * `config` is the override configuration of `up` (the final check of its runArgs, review round 2, D2-1): its runArgs
   * may carry the labels of Docker Compose with empty values that the override configuration adds (COMPOSE_CLEARED_LABELS).
   * The runArgs of the repository configuration may not.
   */
  overrideConfiguration?: boolean;
  /**
   * Review round 15 (K1, K2): the `mounts` of the sources belong to a Docker Compose configuration. The Dev Container CLI
   * does not give them to `docker run --mount` then: it reads a text with its own parser and writes each mount into the
   * compose file that it generates as `<source>:<target>` (composeCliMountProblems). They are checked in that reading
   * too.
   */
  composeMounts?: boolean;
  /**
   * The variables of the Dev Container CLI at `up` (helperCliVariables in ./cliVariables.ts): the image metadata is
   * checked as the CLI substitutes it before it passes it to Docker, with the repository folder for
   * `${localWorkspaceFolder}`, as `up` uses it for every repository name (hotfix review 5, A5-1). `config` and `merged`
   * are the output of read-configuration, substituted once already (for a repository named `*.code-workspace` with
   * `/workspaces`, read-configuration's folder), and are checked as they are (hotfix review 1). Without it, the
   * workspace folders are not known, and the variables of the process are those of the workspace helper
   * (HELPER_KNOWN_ENV, mayBeSetInHelper).
   */
  variables?: CliVariables;
}

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
 * hostAccessReport splits them. `checksOn`: the switch of the repository (./hostAccessChecks.ts); `false` leaves out
 * the items of the class `computer` (hostAccessClassification), and the published ports keep their address.
 */
export function hostAccessProblems(input: HostAccessInput, checksOn = true): string[] {
  return capped(applicable(hostAccessFindings(input, checksOn), checksOn).map((problem) => problem.item));
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
  return { hostAccess: capped(report.hostAccess), unsupported: capped(report.unsupported) };
}

/** The expressions of a leftover list for an item: at most MAX_LISTED_ITEMS, each at most MAX_ITEM_LENGTH characters, then `and <n> more`. */
function listedVariables(expressions: readonly string[]): string {
  return capped(expressions).join(', ');
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

function hostAccessFindings(original: HostAccessInput, checksOn: boolean): Problem[] {
  // First, and alone (hotfix review 2, P2): the other checks take more than linear time on some texts.
  const tooLong = textLengthProblems(original);
  if (tooLong.length > 0) return tooLong;
  const reserved = reservedTextProblems(original);
  if (reserved.length > 0) return reserved;
  const input = resolvedInput(original);
  // By item (hotfix review 2, P2: a Map, not a search of the list).
  const problems = new Map<string, Problem>();
  const add = (found: readonly Problem[]): void => {
    for (const problem of found) {
      // The placeholder of an ID is named as the configuration writes it (resolvedInput).
      const item = problem.item.includes(DEVCONTAINER_ID_PLACEHOLDER) ? problem.item.split(DEVCONTAINER_ID_PLACEHOLDER).join('${devcontainerId}') : problem.item;
      const known = problems.get(item);
      if (!known) problems.set(item, { item, class: problem.class });
      // The same text from two rules (for example the options of two mounts of one volume): the one that the switch does
      // not lift counts.
      else if (known.class === 'computer' && problem.class !== 'computer') known.class = problem.class;
    }
  };
  const volumes = volumeContext(input);
  for (const { source, raw } of configurationSources(input, original)) {
    // Read as the Dev Container CLI merges them: any true-like `privileged`, and a single value in place of a list.
    for (const { entry, leftovers } of mountEntries(source.mounts, raw, input.variables ?? {})) {
      add(mountEntryProblems(entry, leftovers, volumes));
      // Review round 15 (K1, K2): what the Dev Container CLI writes into its compose file, as Compose reads it. Checked on
      // the substituted entry (resolvedInput), as mountEntryProblems checks it; a mount with leftovers is refused there
      // already (merge of #27: the raw label of the image metadata no longer reaches this check, review round 16, L3).
      if (input.composeMounts === true && leftovers.length === 0) add(composeCliMountProblems(entry, volumes));
    }
    if (source.privileged) add([access('privileged mode')]);
    add(accessAll(capabilityProblems(cliList(source.capAdd))));
    add(accessAll(securityOptionProblems(cliList(source.securityOpt))));
    // Review round 16 (L1): what the Dev Container CLI writes as text into its compose file, whatever the switch says.
    if (input.composeMounts === true) add(composeTextProblems(source));
    const gpu = isRecord(source.hostRequirements) ? source.hostRequirements.gpu : undefined;
    if (gpu !== undefined && gpu !== false && gpu !== null) add([access('GPU access (hostRequirements.gpu)')]);
    // It would run in the workspace helper, which has the Docker socket (not on the computer): the integrity of the
    // extension, so it stays refused with the checks off.
    if (hasCommand(source.initializeCommand)) add([guarded('initializeCommand')]);
    add(accessAll(portHostProblems(source.customizations)));
  }
  for (const [source, written] of [
    [input.config, original.config],
    [input.merged, original.merged],
  ] as const) {
    if (!source || !written) continue;
    if (Array.isArray(source.runArgs) && Array.isArray(written.runArgs)) {
      // The CLI substitutes the runArgs again at `up` (secondPassProblems, on the entries as read-configuration returned
      // them); without a variable left, the list is what Docker gets, up to the ID of the container (resolvedInput), and
      // so is the list of the override configuration.
      const left = secondPassProblems('runArgs', written.runArgs);
      if (left.length > 0) add(left);
      else {
        // The labels of Docker Compose with empty values: only those that the override configuration adds (D2-1), which
        // the merged configuration of an existing container holds too.
        const cleared = source === input.merged || input.overrideConfiguration === true;
        add(runArgsFindings(source.runArgs, volumes, cleared));
        // What Docker gets: the same list without the removed flags, and (checks on) with 127.0.0.1 for published ports.
        add(runArgsFindings(overrideRunArgs(source.runArgs, checksOn), volumes, cleared));
      }
    }
    if (source.appPort !== undefined) {
      const ports = Array.isArray(written.appPort) ? written.appPort : [written.appPort];
      const left = secondPassProblems('appPort', ports);
      add(left.length > 0 ? left : appPortProblems(source.appPort));
    }
    const build = isRecord(source.build) ? source.build : undefined;
    if (build && Array.isArray(build.options)) add(buildOptionFindings(build.options));
  }
  // Not the merged configuration: for an existing container, it holds the values of the override configuration, also of
  // an earlier version of the extension. The image metadata has none of them (the build runs without it). The identity
  // of the owner account: stays refused with the checks off.
  for (const source of [input.config, ...(input.metadata ?? [])]) if (isRecord(source)) add(environmentProblems(source));
  // The build of a single container: no folder of the workspace helper as its context or Dockerfile, and no image ID
  // (as image, or additional context; an image of another account is refused by its ID in the pipeline). Not the merged
  // configuration: it holds the values of the configuration, and the image of an existing container.
  if (input.config) add(singleBuildProblems(input.config, input));
  return [...problems.values()];
}

/**
 * The entries of runArgs or appPort (`what`) of the output of read-configuration that still hold a variable that the Dev
 * Container CLI resolves (unresolvedCliVariables; `${devcontainerId}` is allowed): the CLI substitutes them a second
 * time at `up`, when it reads the override configuration, so what Docker gets is not what the checks see (for example
 * `${localEnv:A:$}{localEnv:B:8080}` is `${localEnv:B:8080}` after read-configuration and `8080` at `up`). Not
 * supported, whatever the switch says (hotfix review 1). Without such an entry, the list is what Docker gets.
 */
function secondPassProblems(what: string, entries: readonly unknown[]): Problem[] {
  const problems: Problem[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    // Not `${containerEnv:…}`: the CLI does not resolve it in the arguments of `docker run` (hotfix review 2, P4).
    const left = unresolvedCliVariables(entry, SECOND_PASS_VARIABLE_NAMES);
    if (left.length > 0) problems.push(unsupported(`${what} ${JSON.stringify(entry)} uses ${listedVariables(left)}, which cannot be checked`));
  }
  return problems;
}

/**
 * `build.context` and `build.dockerfile` (and the older `context` and `dockerFile`) of a single container, resolved as
 * the Dev Container CLI resolves them (against the folder of the configuration): a path of the workspace helper
 * (isHelperPath) stays refused whatever the switch says; the CLI builds in the helper, where the cache volume, the
 * workspace volume with the internal folder (CONFIG_FOLDER), and the Docker socket are mounted. Review round 3 (S3-1):
 * a build context outside of the repository folder is refused whatever the switch says too: it can only be a folder of
 * the workspace helper (never one of the computer), and the check does not resolve its links. `image`: no image ID
 * (imageReferenceFinding); an image of the environments of another account is refused by its ID in the pipeline
 * (otherAccountImageItems). The content of the Dockerfile is not checked (Dockerfile refusals removed, user decision
 * 2026-09-27): it runs as trusted code. The Dockerfile itself is: a Dockerfile that is a link out of the repository or
 * could not be read is refused whatever the switch says (dockerfileUnreadable, U2), and one longer than
 * MAX_DOCKERFILE_LENGTH is not supported (dockerfileLength, U1).
 */
function singleBuildProblems(config: Record<string, unknown>, input: HostAccessInput): Problem[] {
  const problems: Problem[] = [];
  const build = isRecord(config.build) ? config.build : {};
  let dockerfileRefused = false;
  if (input.configFolder !== undefined && input.repositoryFolder !== undefined) {
    const repository = input.repositoryFolder;
    const context = typeof build.context === 'string' ? build.context : typeof config.context === 'string' ? config.context : undefined;
    const dockerfile = typeof build.dockerfile === 'string' ? build.dockerfile : typeof config.dockerFile === 'string' ? config.dockerFile : undefined;
    for (const [what, value] of [['build context', context], ['Dockerfile', dockerfile]] as const) {
      // Review round 4 (S4-2): no exception for a value that looks like a URL. The CLI 0.89.0 resolves it as a path
      // (path.posix.resolve against the folder of the configuration), so `x://../../devenv-cache` is a folder.
      if (value === undefined || value.trim() === '') continue;
      const resolved = path.posix.resolve(input.configFolder, value.trim());
      if (isHelperPath(resolved, repository)) {
        problems.push(guarded(`${what} ${value} (a folder of the workspace helper)`));
        if (what === 'Dockerfile') dockerfileRefused = true;
      }
      else if (what === 'build context' && resolved !== repository && !resolved.startsWith(`${repository}/`)) {
        problems.push(guarded(`${what} ${value} (outside of the repository)`));
      }
    }
  }
  // U2: a Dockerfile that exists but could not be read (a link out of the repository, a real path outside of it), unless
  // its path as written is refused already. Checked on the path that the CLI resolved, whatever the switch says.
  if (input.dockerfileUnreadable !== undefined && !dockerfileRefused) {
    problems.push(guarded(`Dockerfile ${input.dockerfileUnreadable} (the Dockerfile is a link out of the repository or could not be read)`));
  }
  // U1: a size limit, not a check of the content: the configuration hash sees at most MAX_DOCKERFILE_LENGTH + 1
  // characters, so an edit after them would offer no rebuild.
  if (input.dockerfileLength !== undefined && input.dockerfileLength > MAX_DOCKERFILE_LENGTH) {
    problems.push(unsupported(`the Dockerfile (longer than ${MAX_DOCKERFILE_LENGTH} characters; the Dockerfile is too large)`));
  }
  if (typeof config.image === 'string') {
    const finding = imageReferenceFinding(config.image);
    if (finding) problems.push(finding);
  }
  // Review round 5 (S5-2): the CLI passes an object as `[object Object]`; the check refuses it.
  if (isRecord(build.args)) {
    for (const [name, value] of Object.entries(build.args)) {
      if (isRecord(value)) problems.push(unsupported(`build.args ${name} (an object; the value of a build argument is a text)`));
    }
  }
  return problems;
}

/**
 * The image references of a single container (review round 2, S2-05): `image`, and the images of `--build-context` of
 * `build.options`. The images of its Dockerfile are not asked about (Dockerfile refusals removed, user decision
 * 2026-09-27).
 */
export function singleImageReferences(config: Readonly<Record<string, unknown>>): NamedImageReference[] {
  const references: NamedImageReference[] = [];
  if (typeof config.image === 'string' && config.image.trim() !== '') references.push({ reference: config.image.trim(), what: 'image' });
  const build = isRecord(config.build) ? config.build : {};
  if (Array.isArray(build.options)) {
    for (const flag of parseFlags(build.options, BUILD_FLAGS)) {
      if (flag.name !== '--build-context' || flag.value === undefined) continue;
      const image = imageContext(flag.value.slice(flag.value.indexOf('=') + 1));
      if (image !== undefined) references.push({ reference: image.trim(), what: 'build option --build-context image' });
    }
  }
  return references;
}

/**
 * Texts that are too long for the checks and the Dev Container CLI (MAX_CLI_TEXT_LENGTH, MAX_CLI_SOURCE_LENGTH; hotfix
 * review 1, N5): not supported, whatever the switch says.
 */
/**
 * DEVCONTAINER_ID_PLACEHOLDER in a text of the configuration, the merged configuration, or the image metadata, as it is
 * written or after the first pass of the CLI: not supported, whatever the switch says (hotfix review 2, P6). The checks
 * put it in place of `${devcontainerId}`, and skip the names of volumes with it (mountedVolumeNames).
 */
function reservedTextProblems(input: HostAccessInput): Problem[] {
  const variables = cliVariablesOf(input);
  const written = [input.config, input.merged, input.metadata];
  const resolved = (input.metadata ?? []).map((entry) => resolveCliVariables(entry, variables).value);
  if (![...written, resolved].some((value) => value !== undefined && containsText(value, DEVCONTAINER_ID_PLACEHOLDER))) return [];
  return [unsupported(`the text ${DEVCONTAINER_ID_PLACEHOLDER.slice(0, 25)}…, which Dev Environments uses in place of \${devcontainerId}`)];
}

function textLengthProblems(input: HostAccessInput): Problem[] {
  const problems: Problem[] = [];
  const sources: Array<[string, unknown]> = [
    ['the configuration', input.config],
    ['the merged configuration', input.merged],
    ['the image metadata', input.metadata],
  ];
  for (const [name, value] of sources) {
    if (value === undefined) continue;
    const { longest, total } = textLengths(value);
    if (longest > MAX_CLI_TEXT_LENGTH) problems.push(unsupported(`a text longer than ${MAX_CLI_TEXT_LENGTH / 1024} KB in ${name}`));
    else if (total > MAX_CLI_SOURCE_LENGTH) problems.push(unsupported(`more than ${MAX_CLI_SOURCE_LENGTH / 1024 / 1024} MB of text in ${name}`));
  }
  return problems;
}

/**
 * `input` as Dev Container CLI 0.89.0 passes it to Docker at `up` (concept section 9 "Host access"): each entry of the
 * image metadata with the variables `${…}` resolved (resolveCliVariables), because the CLI substitutes every entry of
 * the label devcontainer.metadata once at `up`, also one that the Dockerfile of the repository set with LABEL. A
 * variable of the process whose value is not known stays as written (a leftover, mountEntries). The configuration and
 * the merged configuration are the output of read-configuration, which the CLI has substituted already: they stay as
 * they are (hotfix review 1). Their runArgs and appPort, which the CLI substitutes again at `up`, may hold no variable
 * (secondPassProblems). Then, in all of them, every expression named `devcontainerId` (also with arguments) is
 * DEVCONTAINER_ID_PLACEHOLDER, as the second pass of the CLI (tg) makes it the ID of the container (hotfix review 2, P6).
 */
function resolvedInput(input: HostAccessInput): HostAccessInput {
  const variables = cliVariablesOf(input);
  return {
    ...input,
    variables,
    config: input.config && withDevcontainerIdPlaceholder(input.config),
    merged: input.merged && withDevcontainerIdPlaceholder(input.merged),
    metadata: input.metadata && input.metadata.map((entry) => withDevcontainerIdPlaceholder(resolveCliVariables(entry, variables).value)),
  };
}

/** The variables of the CLI for `input`: those of the workspace helper (HELPER_KNOWN_ENV, mayBeSetInHelper), and the given ones. */
function cliVariablesOf(input: HostAccessInput): CliVariables {
  return { env: HELPER_KNOWN_ENV, mayBeSet: mayBeSetInHelper, ...input.variables };
}

/**
 * The repository configuration, the merged configuration, and the entries of the image metadata that are objects, as
 * resolvedInput made them (`source`), each metadata entry with the entry as the label writes it (`raw`, from
 * `original`, at the same index).
 */
function configurationSources(input: HostAccessInput, original: HostAccessInput): Array<{ source: Record<string, unknown>; raw?: Record<string, unknown> }> {
  const sources: Array<{ source: Record<string, unknown>; raw?: Record<string, unknown> }> = [];
  if (input.config) sources.push({ source: input.config });
  if (input.merged) sources.push({ source: input.merged });
  (input.metadata ?? []).forEach((entry, index) => {
    const raw = original.metadata?.[index];
    if (isRecord(entry) && isRecord(raw)) sources.push({ source: entry, raw });
  });
  return sources;
}

/**
 * The mounts of a source (cliList), each with its leftovers: for an entry of the image metadata (`raw` given), the
 * leftovers of the first pass of the CLI on the raw strings (resolveCliVariables), those of the string, or, for the
 * object form, the union over its fields `type`, `source`, and `target`, each on its own, never of the joined text
 * (hotfix review 2, P1). substituteCliVariables keeps the structure of the entry, so the raw mount is at the same index.
 * For the configuration and the merged configuration, which the CLI has substituted already and passes on as they are,
 * the variables of the text (unresolvedCliVariables).
 */
function mountEntries(mounts: unknown, raw: Record<string, unknown> | undefined, variables: CliVariables): Array<{ entry: unknown; leftovers: string[] }> {
  const entries = cliList(mounts);
  if (raw === undefined) return entries.map((entry) => ({ entry, leftovers: unresolvedCliVariables(mountText(entry)) }));
  const written = Array.isArray(raw.mounts) ? raw.mounts : [raw.mounts];
  return entries.map((entry, index) => {
    const rawEntry = written[index];
    const fields = isRecord(rawEntry) ? [rawEntry.type, rawEntry.source, rawEntry.target] : [rawEntry];
    const leftovers = new Set<string>();
    for (const field of fields) for (const expression of resolveCliVariables(field, variables).leftovers) leftovers.add(expression);
    return { entry, leftovers: [...leftovers] };
  });
}

function hasCommand(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * The variables of container-only Git and of the account of the GitHub CLI in `containerEnv` and `remoteEnv` of the
 * configuration or of an entry of the image metadata (refusedVariable): the override configuration would replace
 * those that it sets without a word, because its values win, the others (for example GIT_CONFIG_PARAMETERS) would
 * change the configuration of Git in the container, and a token or host of the GitHub CLI would win over the sign-in of
 * the owner account.
 */
function environmentProblems(config: Record<string, unknown>): Problem[] {
  const problems: Problem[] = [];
  for (const property of ['containerEnv', 'remoteEnv']) {
    const env = config[property];
    if (!isRecord(env)) continue;
    for (const name of Object.keys(env)) {
      const problem = refusedVariable(name, property);
      if (problem !== undefined) problems.push(problem);
    }
  }
  return problems;
}

/** Review round 16 (L1): a user name or ID, optionally with a group name or ID (`containerUser` for Docker Compose). */
const COMPOSE_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*(:[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;
/** Review round 16 (L1): the name of a variable of `containerEnv` for Docker Compose. */
const COMPOSE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/**
 * Review round 16 (L1): what an `entrypoint` may not hold for Docker Compose: quotes, a backslash, `$`, and line breaks
 * and other control characters (`\p{Cc}` holds `\n`, `\r`, `\t`, and NEL; the parser of Compose also breaks lines at
 * U+2028 and U+2029).
 */
const COMPOSE_ENTRYPOINT_REFUSED = /["'\\$\p{Cc}\u2028\u2029]/u;
/** Review round 16 (L1): a capability of `capAdd` for Docker Compose. */
const COMPOSE_CAPABILITY = /^[A-Za-z0-9_]+$/;
/**
 * Review round 16 (L1): an option of `securityOpt` for Docker Compose (for example `seccomp=/etc/p.json`, `label=disable`,
 * `no-new-privileges:true`). Not with `:` at its end: YAML would read `- <option>:` as a mapping.
 */
const COMPOSE_SECURITY_OPTION = /^[A-Za-z0-9_](?:[A-Za-z0-9_.:=/,+@-]*[A-Za-z0-9_.=/,+@-])?$/;
const COMPOSE_TEXT = 'the Dev Container CLI writes it into its compose file as it is';

/**
 * Review round 16 (L1 = D16-1 = S16-1): the values of `source` (the configuration, the merged configuration, or an entry
 * of the image metadata, substituted as the CLI substitutes it) that the Dev Container CLI 0.89.0 writes as text into
 * the compose file that it generates for the dev service of a Docker Compose configuration (function `iW`), without
 * escaping them: `user: <containerUser>`, the names of `containerEnv` inside `- '<name>=<value>'` (the values are
 * escaped), each `entrypoint` (the `entrypoints` of the merged configuration) inside a double-quoted string, and each
 * `capAdd` and `securityOpt` as `- <value>`. A value that is not a plain token could add keys to the dev service (for
 * example `privileged: true`), or Compose would interpolate its `$`: not supported, whatever the switch says. A value
 * that is not a text is refused too: the CLI writes it with String(), and a list of one text is that text. A single
 * container does not need this: the CLI passes these values to `docker run` as separate arguments.
 */
function composeTextProblems(source: Record<string, unknown>): Problem[] {
  const problems: Problem[] = [];
  const user = source.containerUser;
  if (user !== undefined && user !== null && user !== '' && !(typeof user === 'string' && COMPOSE_USER.test(user))) {
    problems.push(unsupported(`containerUser ${JSON.stringify(user)} (${COMPOSE_TEXT}: only a user name or ID, optionally with a group, is supported)`));
  }
  if (isRecord(source.containerEnv)) {
    for (const name of Object.keys(source.containerEnv)) {
      if (COMPOSE_ENV_NAME.test(name)) continue;
      problems.push(unsupported(`containerEnv variable ${JSON.stringify(name)} (the Dev Container CLI writes its name into its compose file as it is: only letters, digits, _, ., and - are supported)`));
    }
  }
  for (const entrypoint of [...cliList(source.entrypoint), ...cliList(source.entrypoints)]) {
    if (typeof entrypoint === 'string' && !COMPOSE_ENTRYPOINT_REFUSED.test(entrypoint)) continue;
    problems.push(unsupported(`entrypoint ${JSON.stringify(entrypoint)} (${COMPOSE_TEXT}: quotes, backslashes, $, line breaks, and control characters are not supported)`));
  }
  for (const capability of cliList(source.capAdd)) {
    if (typeof capability === 'string' && COMPOSE_CAPABILITY.test(capability)) continue;
    problems.push(unsupported(`capability ${JSON.stringify(capability)} (${COMPOSE_TEXT}: only a plain name is supported)`));
  }
  for (const option of cliList(source.securityOpt)) {
    if (typeof option === 'string' && COMPOSE_SECURITY_OPTION.test(option)) continue;
    problems.push(unsupported(`security option ${JSON.stringify(option)} (${COMPOSE_TEXT}: only a plain option is supported)`));
  }
  return problems;
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
  // Review round 14 (S14-1): whatever the type, and whatever the switch says. Review of unit 15: so is a shared
  // propagation where the tmpfs of the token would reach the computer.
  const internal = [...targetProblems(mount.target), ...propagationProblems(mount.target, mount.propagation === undefined ? [] : [mount.propagation])];
  if (type === 'tmpfs') return internal;
  return [...internal, ...mountTypeProblems(mount, type, source, volumes)];
}

/** Review round 14 (S14-1): a mount target in the extension's internal folder (configFolderTarget). */
function targetProblems(target: string | undefined): Problem[] {
  const internal = target === undefined ? undefined : configFolderTarget(target);
  return internal === undefined ? [] : [unsupported(configFolderMountItem(internal))];
}

/** Review of unit 15: a shared propagation (isSharedPropagation) at tokenPropagationTarget `target`. */
function propagationProblems(target: string | undefined, options: readonly string[]): Problem[] {
  if (target === undefined || !options.some(isSharedPropagation)) return [];
  const shared = tokenPropagationTarget(target);
  return shared === undefined ? [] : [guarded(sharedPropagationItem(shared))];
}

function mountTypeProblems(mount: MountSpec, type: string, source: string, volumes: VolumeContext): Problem[] {
  if (type === 'bind' || (type === 'volume' && isPathSource(source))) return [access(source ? `bind mount ${shownBindSource(source)}` : 'bind mount')];
  if (type === 'npipe') return [access(`mount of the type ${type}`)];
  if (type !== 'volume') return [guarded(`mount of the type ${type}`)];
  const options: Problem[] = [];
  if (mount.volumeOptions) {
    const item = `volume options of the mount ${source || '(anonymous volume)'}`;
    options.push(mount.otherVolumeOptions ? guarded(item) : access(item));
  }
  return [...options, ...volumeNameProblems(source, volumes)];
}

/**
 * Review round 15 (K1, K2): the keys of a `mounts` text that the Dev Container CLI 0.89.0 renames (table `cj` of its
 * function `lQ`); every other key keeps its spelling.
 */
const CLI_MOUNT_KEYS: ReadonlyMap<string, string> = new Map([
  ['src', 'source'],
  ['destination', 'target'],
  ['dst', 'target'],
]);

/** The properties of a mount that the CLI writes into its compose file (function `nW`) or that decide how (`type`). */
const CLI_MOUNT_PROPERTIES: ReadonlySet<string> = new Set(['source', 'target', 'type']);

/**
 * The variable that the CLI resolves in `mounts` before it writes the compose file (`${devcontainerId}`, a number in
 * base 32), and what the characters of the text are checked with in its place.
 */
const CLI_RESOLVED_VARIABLE = /\$\{devcontainerId\}/g;
const CLI_RESOLVED_PLACEHOLDER = '0'.repeat(52);

/** A first character that YAML reads as an indicator in a plain scalar (a list item `- <text>` or a key `<text>:`). */
const YAML_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** Characters that change what Compose reads from `- <source>:<target>` (besides the indicators and `$`). */
const COMPOSE_SHORT_SYNTAX_SPECIAL = /[\s"'`#:]/;

/**
 * Review round 15 (K1, K2): a `mounts` entry as the Dev Container CLI 0.89.0 reads it for Docker Compose (function `iW`
 * with `lQ`): a text is split at `,` and each field at `=` (only the part before a second `=` is the value), the keys
 * are case-sensitive, and only `src`, `dst`, and `destination` are renamed; an object is taken as it is. `undefined` when
 * the text does not round-trip safely: a field of `source`, `target`, or `type` (also a variant by case or space, for
 * example `SRC` or ` src`, which the CLI keeps under that key) that is not `<key>=<value>` with exactly one `=`, a
 * variant, or such a property twice. Fields of other options (for example `readonly`) are not written by the CLI.
 */
function cliComposeMount(entry: unknown): { type: unknown; source: unknown; target: unknown } | undefined {
  if (isRecord(entry)) return { type: entry.type, source: entry.source, target: entry.target };
  if (typeof entry !== 'string') return undefined;
  const read: Record<string, string> = {};
  for (const field of entry.split(',')) {
    const parts = field.split('=');
    const key = parts[0];
    const normal = key.trim().toLowerCase();
    if (!CLI_MOUNT_KEYS.has(normal) && !CLI_MOUNT_PROPERTIES.has(normal)) continue;
    const property = CLI_MOUNT_KEYS.get(key) ?? key;
    if (!CLI_MOUNT_PROPERTIES.has(property) || parts.length !== 2 || Object.prototype.hasOwnProperty.call(read, property)) return undefined;
    read[property] = parts[1];
  }
  return { type: read.type, source: read.source, target: read.target };
}

/** Review round 15 (K1, K2): the item of a mount that the CLI writes otherwise than the policy reads it. */
function cliRewrittenMountItem(entry: unknown): Problem {
  return unsupported(`mount ${JSON.stringify(entry)} is written differently by the Dev Container CLI and is not supported`);
}

/** Whether `text` (a source or a target after `${devcontainerId}`) is written by the CLI so that Compose reads it back. */
function roundTrips(text: string): boolean {
  return !text.includes('$') && !COMPOSE_SHORT_SYNTAX_SPECIAL.test(text) && !YAML_INDICATOR.test(text);
}

/**
 * Review round 15 (K1 = S15-1, K2 = S15-2): a `mounts` entry of a Docker Compose configuration as it reaches the dev
 * container. The Dev Container CLI 0.89.0 reads it with its own parser (cliComposeMount) and writes it unquoted as the
 * list item `- <source>:<target>` (function `nW`, the type is dropped) into the `volumes` of the dev service of the
 * compose file that it generates, which Compose reads (and interpolates) in the short syntax. mountProblems checks the
 * entry as `docker run --mount` would read it; this checks the CLI's reading:
 * - not supported (whatever the switch says), when it does not round-trip safely: a text that the CLI cannot read as
 *   Docker does (cliComposeMount), a source, target, or type that is no text, any difference from Docker's reading
 *   (parseMountEntry) in source, target, or type (also by case), `$` (Compose interpolation; `${devcontainerId}` is
 *   resolved by the CLI before), white space, quotes, `#`, `:`, or a leading YAML indicator in the source or the target,
 *   a target that is not absolute, and a source of a mount whose type is not `volume` (a path of any type is a bind
 *   mount below; a name with another type would not be a declared volume, and a tmpfs mount with a source is a bind
 *   mount in Compose);
 * - a path source (isPathSource): Compose mounts it as a bind mount (access to the computer, like other bind mounts);
 * - a name: a named volume, with the rules of volumeNameProblems;
 * - no source: an anonymous volume (also for `tmpfs`, which the CLI writes without its type);
 * - the target, as the dev service's mounts (decideServiceMount): not at or below CONFIG_FOLDER (configFolderTarget),
 *   and not at WORKSPACES_ROOT, where the workspace volume is mounted.
 * A text that Docker cannot read is refused by mountProblems already.
 */
function composeCliMountProblems(entry: unknown, volumes: VolumeContext): Problem[] {
  const docker = parseMountEntry(entry);
  if (docker.unreadable !== undefined) return [];
  const cli = cliComposeMount(entry);
  if (cli === undefined) return [cliRewrittenMountItem(entry)];
  const { type, source, target } = cli;
  if ((type !== undefined && typeof type !== 'string') || (source && typeof source !== 'string') || typeof target !== 'string') {
    return [cliRewrittenMountItem(entry)];
  }
  const cliSource = typeof source === 'string' ? source : '';
  if (type !== docker.type || cliSource !== (docker.source ?? '') || target !== docker.target) return [cliRewrittenMountItem(entry)];
  const writtenSource = cliSource.replace(CLI_RESOLVED_VARIABLE, CLI_RESOLVED_PLACEHOLDER);
  const writtenTarget = target.replace(CLI_RESOLVED_VARIABLE, CLI_RESOLVED_PLACEHOLDER);
  if (!writtenTarget.startsWith('/') || !roundTrips(writtenTarget) || (writtenSource !== '' && !roundTrips(writtenSource))) {
    return [cliRewrittenMountItem(entry)];
  }
  const problems: Problem[] = [...targetProblems(writtenTarget)];
  const normal = path.posix.normalize(writtenTarget).replace(/(.)\/+$/, '$1');
  if (normal === WORKSPACES_ROOT) problems.push(unsupported(`mount at ${WORKSPACES_ROOT}`));
  if (writtenSource === '') return problems;
  if (isPathSource(writtenSource)) {
    if (type !== undefined && type !== 'bind' && type !== 'volume') return [...problems, cliRewrittenMountItem(entry)];
    return [...problems, access(`bind mount ${shownBindSource(cliSource)}`)];
  }
  if (type !== 'volume') return [...problems, cliRewrittenMountItem(entry)];
  return [...problems, ...volumeNameProblems(cliSource, volumes)];
}

/**
 * A mount of `mounts` (string or object) or of `--mount`, after the substitution of the variables (resolvedInput), with
 * its leftovers (mountEntries; for `--mount` of runArgs, the variables of its text): a variable of the Dev Container CLI
 * that the substitution keeps as written (a variable of the process of the workspace helper whose value is not known,
 * such as `${localEnv:HOSTNAME}` or `${localEnv:TERM}`, `${containerEnv:…}`, or a workspace folder that is not known)
 * makes the name of a volume, the target, or the fields of the mount unknown: such a mount is not supported, whatever
 * the switch says, also a bind mount (hotfix review 1, N1: a default such as `${localEnv:TERM:type=volume}` can add a
 * field that makes it a volume). For the image metadata, the leftovers come from the raw strings, never from a scan of
 * the substituted text (hotfix review 2, P1). `${localEnv:HOME}` is known (/root), so the usual bind mounts of
 * `${localEnv:HOME}/.ssh` stay access to the computer. An object is read as the `--mount` text that the CLI makes of it
 * (objectMountText), and named so.
 */
function mountEntryProblems(entry: unknown, leftovers: readonly string[], volumes: VolumeContext): Problem[] {
  if (leftovers.length === 0) return mountProblems(parseMountEntry(entry), volumes);
  return [unsupported(`mount ${JSON.stringify(mountText(entry))} uses ${listedVariables(leftovers)}, which cannot be checked`)];
}

/** The text of a mount of `mounts`: the string, the `--mount` text of the object form (objectMountText), or its JSON. */
function mountText(entry: unknown): string {
  return typeof entry === 'string' ? entry : isRecord(entry) ? objectMountText(entry) : String(JSON.stringify(entry));
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
export function mountedVolumeNames(original: HostAccessInput): string[] {
  // Nothing for a configuration that is refused for its size (hotfix review 2, P2): its volumes are not inspected.
  if (textLengthProblems(original).length > 0) return [];
  // The names that Docker gets: the image metadata resolved as the CLI resolves it (resolvedInput).
  const input = resolvedInput(original);
  const names = new Set<string>();
  const add = (name: string | undefined): void => {
    // Not a name with the ID of the container (DEVCONTAINER_ID_PLACEHOLDER): Docker gets it only at `up` (hotfix review
    // 2, P6).
    if (name !== undefined && name !== input.ownVolume && VOLUME_NAME.test(name) && !name.includes(DEVCONTAINER_ID_PLACEHOLDER)) names.add(name);
  };
  for (const { source } of configurationSources(input, original)) {
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

function volumeFlagProblems(value: string, volumes: VolumeContext): Problem[] {
  // As in mountEntryProblems: a variable that is left makes the volume or the target unknown, also of a bind mount.
  const left = unresolvedCliVariables(value);
  if (left.length > 0) return [unsupported(`volume ${JSON.stringify(value)} uses ${listedVariables(left)}, which cannot be checked`)];
  const internal = [...targetProblems(volumeFlagTarget(value)), ...propagationProblems(volumeFlagTarget(value), volumeFlagOptions(value))];
  const source = volumeFlagSource(value);
  if (source === undefined) return internal;
  if (isPathSource(source)) return [...internal, access(`bind mount ${shownBindSource(source)}`)];
  return [...internal, ...volumeNameProblems(source, volumes)];
}

/** Review round 14 (S14-1): `--tmpfs <target>[:options]`. */
function tmpfsFlagProblems(value: string): Problem[] {
  const index = value.indexOf(':');
  return targetProblems(index >= 0 ? value.slice(0, index) : value);
}

// ---------------------------------------------------------------------------------------------------------------------
// runArgs, appPort, and build.options

/**
 * The networks that `runArgs` names (`--network`/`--net`, also the long form `name=…`), other than the modes of Docker
 * (`host`, `none`, `bridge`, `default`, `container:…`): the networks whose labels and containers the check reads.
 */
export function runArgsNetworks(runArgs: unknown): string[] {
  if (!Array.isArray(runArgs)) return [];
  const names = new Set<string>();
  for (const flag of parseFlags(runArgs, RUN_FLAGS)) {
    if ((flag.name !== '--network' && flag.name !== '--net') || flag.value === undefined) continue;
    for (const name of networkNames(flag.value) ?? []) {
      const network = name.trim();
      if (network !== '' && !isDockerNetworkMode(network)) names.add(network);
    }
  }
  return [...names];
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

function uniqueItems(problems: readonly Problem[]): string[] {
  return [...new Set(problems.map((problem) => problem.item))];
}

/**
 * `runArgs` (`docker run` arguments of the output of read-configuration), with the rules of RUN_FLAGS. An entry with a
 * variable that the Dev Container CLI resolves again at `up` is not supported (secondPassProblems); otherwise the list
 * is what Docker gets. `foreignVolumes`: as in HostAccessInput.
 */
export function runArgsProblems(runArgs: readonly unknown[], ownVolume: string, foreignVolumes: readonly string[] = []): string[] {
  const left = secondPassProblems('runArgs', runArgs);
  return uniqueItems(left.length > 0 ? left : runArgsFindings(runArgs, volumeContext({ ownVolume, foreignVolumes })));
}

/**
 * The label nimblescape.devenv.config-path of the override configuration, with a configuration path (review round 4,
 * D4-2).
 */
function isOwnConfigPathLabel(value: string): boolean {
  const prefix = `${LABEL_CONFIG_PATH}=`;
  return value.startsWith(prefix) && isConfigPathLabelValue(value.slice(prefix.length));
}

/**
 * `cleared`: the labels of Docker Compose with empty values that the override configuration adds
 * (COMPOSE_CLEARED_LABELS, review round 2, D2-1) are allowed, exactly as written there, the label
 * nimblescape.devenv.config-path of the override configuration (review round 4, D4-2), and (unit 15) its `--tmpfs
 * TOKEN_TMPFS`.
 */
function runArgsFindings(runArgs: readonly unknown[], volumes: VolumeContext, cleared = false): Problem[] {
  const problems: Problem[] = [];
  for (const flag of parseFlags(runArgs, RUN_FLAGS)) {
    const rule = flag.rule;
    // At the end, without its value, the flag would take the next argument that the extension or the CLI adds.
    const last = flag.index === runArgs.length - 1 && flag.value === undefined;
    if (last && rule !== undefined && (rule.kind === 'allow' || checksValue(rule)) && takesValue(rule)) {
      problems.push(unsupported(`${flag.raw} without a value`));
    } else if (cleared && (flag.name === '--label' || flag.name === '-l') && flag.value !== undefined && COMPOSE_CLEARED_LABELS.includes(flag.value)) {
      continue;
    } else if (cleared && (flag.name === '--label' || flag.name === '-l') && flag.value !== undefined && isOwnConfigPathLabel(flag.value)) {
      // Review round 4 (D4-2): the label nimblescape.devenv.config-path that the override configuration adds.
      continue;
    } else if (cleared && flag.name === '--tmpfs' && flag.value === TOKEN_TMPFS) {
      // Unit 15: the tmpfs of the token that the override configuration adds, exactly as written there.
      continue;
    } else if (flag.name === '-v' || flag.name === '--volume') {
      problems.push(...volumeFlagProblems(flag.value ?? '', volumes));
    } else if (flag.name === '--mount') {
      // The text that Docker gets (its variables: as in mountEntries for the configuration).
      problems.push(...mountEntryProblems(flag.value ?? '', unresolvedCliVariables(flag.value ?? ''), volumes));
    } else if (flag.name === '--tmpfs' && flag.value !== undefined) {
      problems.push(...tmpfsFlagProblems(flag.value));
    } else if (flag.name === '--network' || flag.name === '--net') {
      problems.push(...networkProblems(flag.value ?? '', volumes));
    } else {
      problems.push(...flagProblems(flag, (text) => text));
    }
  }
  return problems;
}

/** `build.options` (`docker build` options of the configuration), with the rules of BUILD_FLAGS. */
function buildOptionFindings(options: readonly unknown[]): Problem[] {
  const problems: Problem[] = [];
  for (const flag of parseFlags(options, BUILD_FLAGS)) {
    if (flag.rule?.kind === 'check') problems.push(...flag.rule.check(flag.value ?? ''));
    else problems.push(...flagProblems({ ...flag, value: undefined }, (text) => `build option ${text}`));
  }
  return problems;
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
