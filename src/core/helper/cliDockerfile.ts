// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 17 (P17-1, P17-2): how the Dev Container CLI 0.89.0 reads the Dockerfile of the dev service of a Docker
// Compose configuration for its build (devContainersSpecCLI.js, function `Tj` with `EG`, `Nj`, `CG`, `uG`, `QG`, `Cg`,
// `Lj`, `Gj`, `cG`): the one image whose configuration it inspects (uG: the external image at the root of the chain of
// the target stage, or of the last stage), and the user that it writes into its compose file for the build as
// `_DEV_CONTAINERS_IMAGE_USER` when the configuration has Features (QG: the last USER instruction of that chain, its
// variables resolved through the build arguments and the ARG and ENV instructions, then the environment of that image).
// A port of the CLI's own simple reader, not of Docker's: the CLI reads the text with regular expressions, whatever
// BuildKit would do with it. cliDockerfile.test.ts compares it with a verbatim copy of the CLI's functions.
//
// Pure functions, no I/O. The reader of the CLI takes time and memory that grow exponentially with some texts (a
// variable that names another one twice, over many lines) and recurses once per line; the port counts its steps and the
// characters that it makes (CLI_DOCKERFILE_BUDGET) and throws CliDockerfileError when they run out, and also where the
// CLI itself would throw (for example a stage named `constructor`, which its object of stage names finds on the
// prototype). Callers treat such an error as "cannot be checked".

/** An ARG, ENV, or USER instruction as the CLI reads it (`CG`). */
interface CliInstruction {
  instruction: string;
  name: string;
  value: string | undefined;
}

/** A stage: its FROM line (`Nj`) and its instructions. */
interface CliStage {
  from: { platform?: string; image: string; label?: string };
  instructions: CliInstruction[];
}

/** A Dockerfile as the CLI reads it (`EG`, without the directives, which the rules here do not use). */
export interface CliDockerfile {
  preamble: { instructions: CliInstruction[] };
  stages: CliStage[];
  /** A plain object, as in the CLI: a lookup also finds the names of Object.prototype. */
  stagesByLabel: Record<string, CliStage>;
}

/** Thrown when the CLI's reading cannot be followed: out of the budget, or where the CLI itself throws. */
export class CliDockerfileError extends Error {}

/** The most steps (variables resolved) and characters made by one evaluation (a few thousand in real Dockerfiles). */
export const CLI_DOCKERFILE_BUDGET = { steps: 100_000, characters: 1_000_000 };

// The regular expressions of the CLI, verbatim (Sj, Rj, Mj).
const CLI_FROM = /^\s*FROM\s+(?<platform>--platform=\S+\s+)?(?<image>"?[^\s]+"?)(\s+AS\s+(?<label>[^\s]+))?/im;
const CLI_INSTRUCTION = /^\s*(?<instruction>ARG|ENV|USER)\s+(?<name>[^\s=]+)([ =]+("(?<value1>\S+)"|(?<value2>\S+)))?/gim;
const CLI_VARIABLE = /\$\{?(?<variable>[a-zA-Z0-9_]+)(?<isVarExp>:(?<option>-|\+)(?<word>[^}]+))?\}?/g;

/**
 * Review round 18 (S18-2, P18-3): the platform variables of the CLI's `i` (function `Tj`). The CLI takes them from its
 * own Node process in the workspace helper, not from the Docker Engine: `{os: yo(process.platform), arch:
 * mo(process.arch)}` for the build and the target platform, without a variant, so the OS is `linux`, each VARIANT is
 * empty, the ARCH is the Node architecture of the helper (`x64` written `amd64`), and each PLATFORM is `linux/<arch>`.
 * cliPlatformVariables gives the exact values for an architecture (the runtime check, which knows the architecture of
 * the Docker Engine). CLI_PLATFORM_VARIABLES is for the check of the configuration, where the architecture is not known
 * yet: the OS and the VARIANTs are the CLI's constants; each ARCH (and the architecture in each PLATFORM) is written as
 * the variable itself, never empty (so `${TARGETARCH:+x}` gives `x`, as in the CLI), and a result that uses it holds a
 * `$` (CLI_ARCH_PLACEHOLDERS: the runtime check evaluates it with the real architecture).
 */
export const CLI_ARCH_PLACEHOLDERS: readonly string[] = ['${BUILDARCH}', '${TARGETARCH}'];

/** The platform variables of the CLI for the Node architecture `arch` as the CLI writes it (mo: `amd64` for `x64`). */
export function cliPlatformVariables(arch: string): Readonly<Record<string, string>> {
  return cliPlatform(arch, arch);
}

function cliPlatform(buildArch: string, targetArch: string): Readonly<Record<string, string>> {
  return {
    BUILDPLATFORM: `linux/${buildArch}`,
    BUILDOS: 'linux',
    BUILDARCH: buildArch,
    BUILDVARIANT: '',
    TARGETPLATFORM: `linux/${targetArch}`,
    TARGETOS: 'linux',
    TARGETARCH: targetArch,
    TARGETVARIANT: '',
  };
}

export const CLI_PLATFORM_VARIABLES: Readonly<Record<string, string>> = cliPlatform(CLI_ARCH_PLACEHOLDERS[0], CLI_ARCH_PLACEHOLDERS[1]);

/**
 * Review round 18 (P18-3): the architecture that the CLI in the workspace helper writes (mo(process.arch)) for the
 * architecture of the Docker Engine (`docker version`, Server.Arch, the GOARCH of the engine), on which the helper runs:
 * Node names `ia32` what Go names `386`, and `ppc64` what Go names `ppc64le`. `undefined` for any other architecture
 * (fail closed: its Node name is not known).
 */
export function cliArchitecture(engineArch: string): string | undefined {
  const known: Readonly<Record<string, string>> = { amd64: 'amd64', arm64: 'arm64', arm: 'arm', '386': 'ia32', ppc64le: 'ppc64', s390x: 's390x' };
  const arch = engineArch.trim();
  return Object.prototype.hasOwnProperty.call(known, arch) ? known[arch] : undefined;
}

/**
 * Review round 18 (P18-2): the most line breaks in one run of whitespace. The CLI's expressions start with `^\s*` in
 * multiline mode, which takes time that grows with the square of such a run (each line start in it scans the rest of
 * it); a Dockerfile with more (hundreds of blank lines in a row) is not read (CliDockerfileError). With the cap, one
 * reading costs at most this factor times the length of the text.
 */
export const CLI_MAX_BLANK_LINES = 200;

/**
 * Review round 18 (P18-2): throws CliDockerfileError when `text` has a run of whitespace with more than
 * CLI_MAX_BLANK_LINES line breaks (the line terminators of JavaScript's `^`: LF, CR, U+2028, U+2029). Linear.
 */
export function checkCliDockerfileText(text: string): void {
  let breaks = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) {
      if (++breaks > CLI_MAX_BLANK_LINES) throw new CliDockerfileError('the Dockerfile has too many blank lines in a row');
    } else if (!WHITESPACE.test(text[i])) {
      breaks = 0;
    }
  }
}

const WHITESPACE = /^\s$/;

/** `Nj`: the FROM line of a stage. */
function cliFrom(text: string): CliStage['from'] {
  const match = CLI_FROM.exec(text);
  if (!match) return { image: 'unknown' };
  const groups = match.groups ?? {};
  return { platform: groups.platform, image: (groups.image ?? '').replace(/^['"]|['"]$/g, ''), label: groups.label };
}

/** `CG`: the ARG, ENV, and USER instructions of a part of the text. */
function cliInstructions(text: string): CliInstruction[] {
  return [...text.matchAll(CLI_INSTRUCTION)].map((match) => {
    const groups = match.groups ?? {};
    return { instruction: (groups.instruction ?? '').toUpperCase(), name: groups.name ?? '', value: groups.value1 || groups.value2 };
  });
}

/**
 * `EG`: the text split before each FROM line; the part before the first is the preamble. Throws CliDockerfileError for a
 * text of checkCliDockerfileText.
 */
export function parseCliDockerfile(text: string): CliDockerfile {
  // Review round 18 (P18-2): not in quadratic time.
  checkCliDockerfileText(text);
  const split = /(?=^[\t ]*FROM)/gim;
  const parts = text.split(split);
  // As the CLI: the test runs on the same (global) expression after the split.
  const preamble = split.test(parts[0] || '') ? '' : (parts.shift() as string);
  const stages = parts.map((part) => ({ from: cliFrom(part), instructions: cliInstructions(part) }));
  const stagesByLabel: Record<string, CliStage> = {};
  for (const stage of stages) if (stage.from.label) stagesByLabel[stage.from.label] = stage;
  return { preamble: { instructions: cliInstructions(preamble) }, stages, stagesByLabel };
}

/** `ht`: the object of `KEY=value` entries (a later entry of the same name wins; one without `=` is dropped). */
export function cliEnvironment(entries: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!entries) return result;
  if (!Array.isArray(entries)) throw new CliDockerfileError('the environment of the image is no list');
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new CliDockerfileError('an entry of the environment of the image is no text');
    const index = entry.indexOf('=');
    if (index !== -1) result[entry.substring(0, index)] = entry.substring(index + 1);
  }
  return result;
}

/** One evaluation with its budget. */
class Evaluation {
  private steps = 0;
  private characters = 0;

  constructor(
    private readonly file: CliDockerfile,
    private readonly args: Readonly<Record<string, unknown>>,
    private readonly env: Readonly<Record<string, unknown>>,
    private readonly platform: Readonly<Record<string, unknown>>,
  ) {}

  private step(): void {
    if (++this.steps > CLI_DOCKERFILE_BUDGET.steps) throw new CliDockerfileError('the Dockerfile takes too many steps to evaluate');
  }

  private made(text: string): string {
    this.characters += text.length;
    if (this.characters > CLI_DOCKERFILE_BUDGET.characters) throw new CliDockerfileError('the Dockerfile makes too much text to evaluate');
    return text;
  }

  /** `Cg`: `text` with its variables resolved in `stage` before the instruction `index`. */
  substitute(text: string, stage: CliStage | CliDockerfile['preamble'], index: number): string {
    const replacements = [...text.matchAll(CLI_VARIABLE)].map((match) => {
      this.step();
      const groups = match.groups ?? {};
      let value = this.lookup(groups.variable ?? '', stage, index) || '';
      if (groups.isVarExp) value = cliExpansion(groups.option ?? '', value !== '', groups.word ?? '', value);
      return { begin: match.index ?? 0, end: (match.index ?? 0) + match[0].length, value };
    });
    let result = text;
    for (const { begin, end, value } of replacements.reverse()) result = this.made(result.substring(0, begin) + value + result.substring(end));
    return result;
  }

  /** `Lj`: the value of the variable `name` in `stage` before the instruction `index`, through the stages it builds on. */
  private lookup(name: string, start: CliStage | CliDockerfile['preamble'], index: number): string | undefined {
    let stage: CliStage | CliDockerfile['preamble'] = start;
    let before = index;
    let own = true;
    const seen = new Set<unknown>();
    for (;;) {
      this.step();
      if (seen.has(stage)) return undefined;
      seen.add(stage);
      const instructions = stage.instructions;
      if (!Array.isArray(instructions)) throw new CliDockerfileError('the Dev Container CLI cannot read a stage of the Dockerfile');
      const found = lastIndex(
        instructions,
        (instruction) =>
          instruction.name === name &&
          (instruction.instruction === 'ENV' || (own && typeof (this.args[instruction.name] ?? instruction.value) === 'string')),
        before - 1,
      );
      if (found !== -1) {
        const instruction = instructions[found];
        if (instruction.instruction === 'ENV') return this.substitute(stringOf(instruction.value), stage, found);
        if (instruction.instruction === 'ARG') return this.substitute(stringOf(this.args[instruction.name] ?? instruction.value), stage, found);
      }
      if (!('from' in stage) || !stage.from) {
        const value = this.env[name] ?? this.platform[name];
        return typeof value === 'string' ? value : undefined;
      }
      const image = this.substitute(stage.from.image, this.file.preamble, this.file.preamble.instructions.length);
      stage = this.file.stagesByLabel[image] || this.file.preamble;
      before = stage.instructions.length;
      own = stage === this.file.preamble;
    }
  }
}

/** A value that the CLI passes to `String.prototype.matchAll`: a text (other values throw there, or are not read). */
function stringOf(value: unknown): string {
  if (typeof value !== 'string') throw new CliDockerfileError('the Dev Container CLI cannot read a value of the Dockerfile');
  return value;
}

/** `Gj`: `${name:-word}` and `${name:+word}`, with the quotes around the result dropped. */
function cliExpansion(option: string, set: boolean, word: string, value: string): string {
  const result = option === '-' ? (set ? value : word) : set ? word : value;
  return result.replace(/^['"]|['"]$/g, '');
}

/** `cG`: the last index at or before `from` whose entry passes `test`, or -1. */
function lastIndex<T>(entries: readonly T[], test: (entry: T) => boolean, from = entries.length - 1): number {
  for (let index = from; index >= 0; index--) if (test(entries[index])) return index;
  return -1;
}

/** The stage that the build targets (`target`), or the last stage; a lookup on the plain object, as in the CLI. */
function targetStage(file: CliDockerfile, target: string | undefined): CliStage | undefined {
  const stage = target ? file.stagesByLabel[target] : file.stages[file.stages.length - 1];
  if (stage !== undefined && (typeof stage !== 'object' || stage === null || !Array.isArray((stage as Partial<CliStage>).instructions))) {
    throw new CliDockerfileError('the Dev Container CLI cannot read the target stage of the Dockerfile');
  }
  return stage;
}

/**
 * `uG`: the image whose configuration the CLI inspects for the build (the external image at the root of the chain of
 * the stage `target`, or of the last stage), with the build arguments `args` and the platform variables `platform`;
 * `undefined` when there is none (no such stage, or the chain loops). Throws CliDockerfileError (see the top).
 */
export function cliBaseImage(
  file: CliDockerfile,
  args: Readonly<Record<string, unknown>>,
  target: string | undefined,
  platform: Readonly<Record<string, unknown>> = CLI_PLATFORM_VARIABLES,
): string | undefined {
  const evaluation = new Evaluation(file, args, {}, platform);
  let stage = targetStage(file, target);
  const seen = new Set<CliStage>();
  while (stage) {
    if (seen.has(stage)) return undefined;
    seen.add(stage);
    if (!stage.from) throw new CliDockerfileError('the Dev Container CLI cannot read a stage of the Dockerfile');
    const image = evaluation.substitute(stage.from.image, file.preamble, file.preamble.instructions.length);
    const next = file.stagesByLabel[image];
    if (!next) return image;
    stage = next;
  }
  return undefined;
}

/**
 * `QG`: the user of the last USER instruction of the chain of the stage `target` (or of the last stage), its variables
 * resolved as the CLI resolves them (the build arguments `args`, the ARG and ENV instructions, then the environment
 * `env` of the image of cliBaseImage and the platform variables); `undefined` when the chain has none or it resolves to
 * an empty text (the CLI then takes the user of the image, or `root`). Throws CliDockerfileError (see the top).
 */
export function cliImageUser(
  file: CliDockerfile,
  args: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, unknown>>,
  target: string | undefined,
  platform: Readonly<Record<string, unknown>> = CLI_PLATFORM_VARIABLES,
): string | undefined {
  const evaluation = new Evaluation(file, args, env, platform);
  let stage = targetStage(file, target);
  const seen = new Set<CliStage>();
  while (stage) {
    if (seen.has(stage)) return undefined;
    seen.add(stage);
    if (!stage.from || !Array.isArray(stage.instructions)) throw new CliDockerfileError('the Dev Container CLI cannot read a stage of the Dockerfile');
    const index = lastIndex(stage.instructions, (instruction) => instruction.instruction === 'USER');
    if (index !== -1) return evaluation.substitute(stage.instructions[index].name, stage, index) || undefined;
    const image = evaluation.substitute(stage.from.image, file.preamble, file.preamble.instructions.length);
    stage = file.stagesByLabel[image];
    if (stage !== undefined && (typeof stage !== 'object' || stage === null)) throw new CliDockerfileError('the Dev Container CLI cannot read a stage of the Dockerfile');
  }
  return undefined;
}
