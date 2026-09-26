// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Base images of a Dockerfile (concept 7.7, implementation notes 9).
// Follows the Dockerfile parser of BuildKit where it matters for FROM: parser directives, line continuations,
// comments, heredocs, global ARGs, and variable substitution.

/** ARGs that BuildKit defines automatically in the global scope. Their values depend on the build platform. */
const PLATFORM_ARGS = new Set([
  'BUILDPLATFORM',
  'BUILDOS',
  'BUILDARCH',
  'BUILDVARIANT',
  'TARGETPLATFORM',
  'TARGETOS',
  'TARGETARCH',
  'TARGETVARIANT',
]);

const KNOWN_DIRECTIVES = new Set(['syntax', 'escape', 'check']);
const HEREDOC_INSTRUCTIONS = new Set(['RUN', 'COPY', 'ADD']);
/**
 * Review round 5 (S5-1): a variable name as `processName` of BuildKit's shell lexer reads it: a run of digits (a
 * positional parameter, `$1`), one special parameter of `@*#?-$!0`, or Unicode letters, digits, and `_` (not starting
 * with a digit). A name that is not set expands to the empty text.
 */
export const SHELL_NAME = /^(?:\p{Nd}+|[@*#?\-$!]|[\p{L}_][\p{L}\p{Nd}_]*)/u;
/** Review round 5 (S5-1): BuildKit takes any name that is not empty for an ARG (it refuses only a blank one). */
const isArgName = (name: string): boolean => name !== '';
/**
 * Review round 6 (S6-1): the longest image reference (and value of FROM, `--from`, or `from=`) that the check reads; a
 * longer one is refused as unsupported (the image reference is too long). Docker's own limit for a name is 255.
 */
export const MAX_REFERENCE_LENGTH = 1024;
/** Review round 6 (S6-1): the deepest nesting of `${…}` that the expansion evaluates; deeper is refused as unsupported. */
export const MAX_NESTING = 32;
/**
 * Review round 6 (S6-1): the longest text that one expansion (an ARG or ENV value, a reference) makes; a longer one is
 * cut and refused as unsupported (for example ARGs that double their value).
 */
export const MAX_EXPANDED_LENGTH = 64 * 1024;

interface Instruction {
  keyword: string;
  args: string;
}

/**
 * Value of a variable: `{ value: undefined }` is unset; `'unresolved'` keeps the variable text in the result. `unchecked`:
 * the value came from an expansion that could not be evaluated (Expansion.unchecked).
 */
type Lookup = (name: string) => LookupValue | 'unresolved';

/** A value of Lookup; `tooComplex`: its expansion ran out of the budget of the pattern matcher (review round 7, S7-1). */
interface LookupValue {
  value: string | undefined;
  unchecked?: UncheckedClass;
  tooComplex?: boolean;
}

/**
 * Review round 4 (S4-3): how a reference whose expansion could not be evaluated is refused. `protected`: the value of the
 * variable is not known or holds `devenv`; `unsupported`: any other value.
 */
export type UncheckedClass = 'protected' | 'unsupported';

/** What an expansion met besides its text: a variable form it could not evaluate, and variables it could not resolve. */
interface Expansion {
  unchecked?: UncheckedClass;
  unresolved?: boolean;
  /** extractBaseImages: the pattern operators stay unevaluated (the reference keeps its `$` and is skipped). */
  keepPatterns?: boolean;
  /**
   * Review round 7 (S7-1): a pattern form was not evaluated because the Dockerfile ran out of the budget of the pattern
   * matcher (MAX_PATTERN_STEPS); `unchecked` is set too.
   */
  tooComplex?: boolean;
}

function markUnchecked(state: Expansion | undefined, value: UncheckedClass | undefined): void {
  if (state === undefined || value === undefined) return;
  if (state.unchecked !== 'protected') state.unchecked = value;
}

/** What the value of a variable brings into an expansion: its class, and whether it was too complex (S7-1). */
function markFound(state: Expansion | undefined, found: LookupValue): void {
  markUnchecked(state, found.unchecked);
  if (state !== undefined && found.tooComplex === true) state.tooComplex = true;
}

/**
 * FROM images of a Dockerfile, deduplicated in order: line continuations, comments, parser directives (`escape`);
 * global ARG defaults (ARG before the first FROM), overridden by `buildArgs`; `${VAR}`, `$VAR`, `${VAR:-default}`,
 * `${VAR:+x}`; the `--platform=…` flag. Excludes references to earlier stages (case-insensitive) and `scratch`.
 * References that still contain `$` (for example `$TARGETARCH`, whose value depends on the platform) are skipped.
 * With `target`, stages after the target stage are not included, because they are not built.
 */
export function extractBaseImages(
  dockerfileText: string,
  buildArgs?: Record<string, string>,
  options: { target?: string } = {},
): string[] {
  const { escape, instructions } = parseInstructions(dockerfileText);
  const globals = new Map<string, string | undefined>();
  const lookup: Lookup = (name) => {
    const override = buildArgs && Object.prototype.hasOwnProperty.call(buildArgs, name) ? buildArgs[name] : undefined;
    if (PLATFORM_ARGS.has(name)) return override !== undefined ? { value: override } : 'unresolved';
    // Build arguments only apply to declared ARGs; an undeclared variable is empty, as in Docker.
    if (!globals.has(name)) return { value: undefined };
    return { value: override !== undefined ? override : globals.get(name) };
  };

  const stages = new Set<string>();
  const images: string[] = [];
  const seen = new Set<string>();
  const target = options.target?.trim().toLowerCase();
  let fromSeen = false;

  for (const instruction of instructions) {
    if (instruction.keyword === 'ARG' && !fromSeen) {
      for (const word of splitWords(instruction.args, escape)) {
        const equals = word.indexOf('=');
        const name = equals < 0 ? word : word.slice(0, equals);
        if (!isArgName(name)) continue;
        const defaultValue = equals < 0 ? undefined : expand(word.slice(equals + 1), lookup, escape, { keepPatterns: true });
        const override = buildArgs && Object.prototype.hasOwnProperty.call(buildArgs, name) ? buildArgs[name] : undefined;
        globals.set(name, override !== undefined ? override : defaultValue);
      }
      continue;
    }
    if (instruction.keyword !== 'FROM') continue;
    fromSeen = true;

    const words = instruction.args.split(/\s+/).filter((word) => word !== '');
    while (words.length > 0 && words[0].startsWith('--')) words.shift();
    if (words.length === 0) continue;
    const image = expand(words[0], lookup, escape, { keepPatterns: true }).trim();
    const stageName = words.length >= 3 && words[1].toLowerCase() === 'as' ? words[2].toLowerCase() : undefined;

    const key = image.toLowerCase();
    if (image !== '' && !image.includes('$') && key !== 'scratch' && !stages.has(key) && !seen.has(image)) {
      seen.add(image);
      images.push(image);
    }
    if (stageName) stages.add(stageName);
    if (target && stageName === target) break;
  }
  return images;
}

/** Where a Dockerfile names an image (extractImageReferences). */
export type ImageReferenceKind = 'FROM' | 'COPY --from' | 'RUN --mount from' | 'syntax';

/** An image that a Dockerfile names (extractImageReferences). */
export interface DockerfileImageReference {
  /** As expanded; still with `$` where a variable could not be resolved. */
  reference: string;
  kind: ImageReferenceKind;
  /**
   * Review round 4 (S4-3): the reference uses a variable form that could not be evaluated (a pattern of an unknown
   * value, an operator that BuildKit's shell lexer does not know, a pattern with a variable that is not resolved), and how
   * it is refused (UncheckedClass).
   */
  unchecked?: UncheckedClass;
  /**
   * Review round 6 (S6-1): the reference, or the value of FROM, `--from`, or `from=` that it came from, is longer than
   * MAX_REFERENCE_LENGTH (the reference is then that value).
   */
  tooLong?: true;
  /**
   * Review round 7 (S7-1): a pattern form of the reference (or of a variable that it uses) was not evaluated because the
   * Dockerfile ran out of the budget of the pattern matcher (MAX_PATTERN_STEPS); `unchecked` is set too.
   */
  tooComplex?: true;
  /**
   * Review round 6 (P6-2), with the option `withStages`, for a reference with a variable that is not resolved: the stage names that the reference names
   * as a stage instead of an image are the first `stagesBefore` entries of DockerfileImages.stageNames (for FROM the
   * earlier stages, else all). Review round 7 (S7-2): a count instead of a copy of the names for each reference.
   */
  stagesBefore?: number;
}

/**
 * Review round 7 (S7-2): the largest Dockerfile (in characters) and the most instructions that the check reads; a larger
 * one is refused as unsupported (the Dockerfile is too large to check).
 */
export const MAX_DOCKERFILE_LENGTH = 1024 * 1024;
export const MAX_DOCKERFILE_INSTRUCTIONS = 20_000;

/** The images of a Dockerfile (analyzeDockerfileImages). */
export interface DockerfileImages {
  references: DockerfileImageReference[];
  /** The stage names (lower case) of the FROM instructions with `AS`, in the order of the file (DockerfileImageReference.stagesBefore). */
  stageNames: string[];
  /** Review round 7 (S7-2): longer than MAX_DOCKERFILE_LENGTH or with more than MAX_DOCKERFILE_INSTRUCTIONS; no references. */
  tooLarge?: true;
}

/**
 * Every image that a Dockerfile names, for the rule on the images of other environments (D-17, review round 2, S2-02):
 * the FROM images (as extractBaseImages, but a reference with a variable that cannot be resolved is kept with its `$`),
 * the sources of `COPY --from=<ref>` and of `RUN --mount=…,from=<ref>` (BuildKit takes an image when the value names no
 * stage), and the frontend of the parser directive `# syntax=<ref>`. Stage names (of the whole file, case-insensitive)
 * and stage indexes (`--from=0`) are not images and are left out, and so is `scratch`. Variables of a stage: its ARGs
 * (with `buildArgs`) and ENVs; any other variable stays unresolved (the text keeps its `$`). `ADD` has no `--from`. With
 * `target`, the stages after the target stage are not included, as in extractBaseImages. In order, without duplicates.
 * A Dockerfile that is too large (analyzeDockerfileImages) gives no references.
 */
export function extractImageReferences(
  dockerfileText: string,
  buildArgs?: Record<string, string>,
  options: { target?: string; withStages?: boolean } = {},
): DockerfileImageReference[] {
  return analyzeDockerfileImages(dockerfileText, buildArgs, options).references;
}

/**
 * extractImageReferences with the stage names of the file (DockerfileImageReference.stagesBefore). Review round 7: a
 * Dockerfile longer than MAX_DOCKERFILE_LENGTH or with more instructions than MAX_DOCKERFILE_INSTRUCTIONS is not read
 * (`tooLarge`, S7-2); all pattern forms of the file share one budget of the matcher (MAX_PATTERN_STEPS, S7-1).
 */
export function analyzeDockerfileImages(
  dockerfileText: string,
  buildArgs?: Record<string, string>,
  options: { target?: string; withStages?: boolean } = {},
): DockerfileImages {
  if (dockerfileText.length > MAX_DOCKERFILE_LENGTH) return { references: [], stageNames: [], tooLarge: true };
  const { escape, syntax, instructions } = parseInstructions(dockerfileText);
  if (instructions.length > MAX_DOCKERFILE_INSTRUCTIONS) return { references: [], stageNames: [], tooLarge: true };
  return withPatternBudget(() => readImageReferences(escape, syntax, instructions, buildArgs, options));
}

function readImageReferences(
  escape: string,
  syntax: string | undefined,
  instructions: readonly Instruction[],
  buildArgs: Record<string, string> | undefined,
  options: { target?: string; withStages?: boolean },
): DockerfileImages {
  const override = (name: string): string | undefined =>
    buildArgs && Object.prototype.hasOwnProperty.call(buildArgs, name) ? buildArgs[name] : undefined;
  const globals = new Map<string, string | undefined>();
  // Review round 4 (S4-3): the variables whose value came from an expansion that could not be evaluated; review round 7
  // (S7-1): or that ran out of the budget of the pattern matcher.
  const globalUnchecked = new Map<string, UncheckedClass>();
  const globalComplex = new Set<string>();
  const globalLookup: Lookup = (name) => {
    if (PLATFORM_ARGS.has(name)) return override(name) !== undefined ? { value: override(name) } : 'unresolved';
    if (!globals.has(name)) return { value: undefined };
    if (override(name) !== undefined) return { value: override(name) };
    return withUnchecked(globals.get(name), globalUnchecked.get(name), globalComplex.has(name));
  };
  // The variables of the current stage; `null`: declared, but its value is not known here (a platform ARG).
  let stage = new Map<string, string | undefined | null>();
  let stageUnchecked = new Map<string, UncheckedClass>();
  let stageComplex = new Set<string>();
  const stageLookup: Lookup = (name) => {
    if (!stage.has(name)) return 'unresolved';
    const value = stage.get(name);
    return value === null ? 'unresolved' : withUnchecked(value, stageUnchecked.get(name), stageComplex.has(name));
  };
  /** Sets a variable of the current stage (or of the global scope) with what its expansion met. */
  const setVariable = (scope: 'global' | 'stage', name: string, value: string | undefined | null, state?: Expansion): void => {
    const unchecked = scope === 'global' ? globalUnchecked : stageUnchecked;
    const complex = scope === 'global' ? globalComplex : stageComplex;
    if (scope === 'global') globals.set(name, value ?? undefined);
    else stage.set(name, value);
    if (state?.unchecked !== undefined) unchecked.set(name, state.unchecked);
    else unchecked.delete(name);
    if (state?.tooComplex === true) complex.add(name);
    else complex.delete(name);
  };

  // The stage names in the order of the file (review round 7, S7-2: one list; a reference keeps a count of it).
  const stageNames: string[] = [];
  const stages = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.keyword !== 'FROM') continue;
    const words = instruction.args.split(/\s+/).filter((word) => word !== '');
    while (words.length > 0 && words[0].startsWith('--')) words.shift();
    if (words.length >= 3 && words[1].toLowerCase() === 'as') {
      const name = words[2].toLowerCase();
      stageNames.push(name);
      stages.add(name);
    }
  }

  const result: DockerfileImageReference[] = [];
  // Review round 7 (S7-2): the references by `${kind} ${text}`, instead of a search of the list for each one.
  const known = new Map<string, DockerfileImageReference>();
  // FROM: only the stages before it, as in extractBaseImages (the conservative side for a later name): the first
  // `earlierCount` entries of stageNames, whose names are in `earlier`.
  const earlier = new Set<string>();
  let earlierCount = 0;
  const add = (reference: string, kind: ImageReferenceKind, state?: Expansion, raw?: string): void => {
    // Review round 6 (S6-1): a value longer than MAX_REFERENCE_LENGTH is kept as it is written, as too long.
    const tooLong = (raw !== undefined && raw.length > MAX_REFERENCE_LENGTH) || reference.trim().length > MAX_REFERENCE_LENGTH;
    const text = raw !== undefined && raw.length > MAX_REFERENCE_LENGTH ? raw.trim() : reference.trim();
    const key = text.toLowerCase();
    const isStage = kind === 'FROM' ? earlier.has(key) : stages.has(key);
    if (!tooLong && (text === '' || key === 'scratch' || isStage || (kind !== 'FROM' && /^\d+$/.test(text)))) return;
    const tooComplex = state?.tooComplex === true;
    const entry = known.get(`${kind} ${text}`);
    if (entry) {
      if (state?.unchecked !== undefined && entry.unchecked !== 'protected') entry.unchecked = state.unchecked;
      if (tooLong) entry.tooLong = true;
      if (tooComplex) entry.tooComplex = true;
      return;
    }
    const created: DockerfileImageReference = {
      reference: text,
      kind,
      ...(state?.unchecked !== undefined ? { unchecked: state.unchecked } : {}),
      ...(tooLong ? { tooLong: true as const } : {}),
      ...(tooComplex ? { tooComplex: true as const } : {}),
      ...(options.withStages === true && text.includes('$') ? { stagesBefore: kind === 'FROM' ? earlierCount : stageNames.length } : {}),
    };
    known.set(`${kind} ${text}`, created);
    result.push(created);
  };
  /** Expands a reference, noting what the expansion met (review round 4, S4-3). */
  const reference = (word: string, lookup: Lookup): { text: string; state: Expansion } => {
    const state: Expansion = {};
    return { text: expand(word, lookup, escape, state), state };
  };
  if (syntax !== undefined) add(syntax, 'syntax');

  const target = options.target?.trim().toLowerCase();
  let fromSeen = false;
  let targetDone = false;
  for (const instruction of instructions) {
    if (instruction.keyword === 'ARG') {
      for (const word of splitWords(instruction.args, escape)) {
        const equals = word.indexOf('=');
        const name = equals < 0 ? word : word.slice(0, equals);
        if (!isArgName(name)) continue;
        const state: Expansion = {};
        if (!fromSeen) {
          const defaultValue = equals < 0 ? undefined : expand(word.slice(equals + 1), globalLookup, escape, state);
          if (override(name) !== undefined) setVariable('global', name, override(name));
          else setVariable('global', name, defaultValue, state);
          continue;
        }
        const defaultValue = equals < 0 ? undefined : expand(word.slice(equals + 1), stageLookup, escape, state);
        if (override(name) !== undefined) setVariable('stage', name, override(name));
        else if (defaultValue !== undefined) setVariable('stage', name, defaultValue, state);
        else if (PLATFORM_ARGS.has(name)) setVariable('stage', name, null);
        else {
          const inherited: Expansion = {};
          if (globalUnchecked.has(name)) inherited.unchecked = globalUnchecked.get(name);
          if (globalComplex.has(name)) inherited.tooComplex = true;
          setVariable('stage', name, globals.get(name), inherited);
        }
      }
      continue;
    }
    if (instruction.keyword === 'FROM') {
      if (targetDone) break;
      fromSeen = true;
      stage = new Map();
      stageUnchecked = new Map();
      stageComplex = new Set();
      const words = instruction.args.split(/\s+/).filter((word) => word !== '');
      while (words.length > 0 && words[0].startsWith('--')) words.shift();
      if (words.length === 0) continue;
      const from = reference(words[0], globalLookup);
      add(from.text, 'FROM', from.state, words[0]);
      const name = words.length >= 3 && words[1].toLowerCase() === 'as' ? words[2].toLowerCase() : undefined;
      if (name !== undefined) {
        earlier.add(name);
        earlierCount++;
      }
      if (target && name === target) targetDone = true;
      continue;
    }
    if (!fromSeen) continue;
    if (instruction.keyword === 'ENV') {
      const words = splitWords(instruction.args, escape);
      if (words.length > 0 && !words[0].includes('=')) {
        // The old form `ENV NAME value…`.
        const state: Expansion = {};
        setVariable('stage', words[0], expand(words.slice(1).join(' '), stageLookup, escape, state), state);
      } else {
        for (const word of words) {
          const equals = word.indexOf('=');
          const state: Expansion = {};
          if (equals > 0) setVariable('stage', word.slice(0, equals), expand(word.slice(equals + 1), stageLookup, escape, state), state);
        }
      }
      continue;
    }
    if (instruction.keyword !== 'COPY' && instruction.keyword !== 'RUN') continue;
    // Review round 3 (S3-5): the flags as BuildKit reads them, without their quotes (`--mount="from=…,target=/x"`).
    const words = extractBuilderFlags(instruction.args);
    for (let i = 0; i < words.length && words[i].startsWith('--'); i++) {
      const word = words[i];
      const equals = word.indexOf('=');
      const flag = (equals < 0 ? word : word.slice(0, equals)).toLowerCase();
      let value = equals < 0 ? undefined : word.slice(equals + 1);
      if (value === undefined && (flag === '--from' || flag === '--mount') && i + 1 < words.length) value = words[++i];
      if (value === undefined) continue;
      if (instruction.keyword === 'COPY' && flag === '--from') {
        const from = reference(value, stageLookup);
        add(from.text, 'COPY --from', from.state, value);
      }
      if (instruction.keyword === 'RUN' && flag === '--mount') {
        for (const field of csvFields(value)) {
          const index = field.indexOf('=');
          if (index > 0 && field.slice(0, index).trim().toLowerCase() === 'from') {
            const from = reference(field.slice(index + 1), stageLookup);
            add(from.text, 'RUN --mount from', from.state, field.slice(index + 1));
          }
        }
      }
    }
  }
  return { references: result, stageNames };
}

/**
 * The flag words at the start of the arguments of an instruction, as `extractBuilderFlags` of BuildKit's Dockerfile
 * parser reads them (review round 3, S3-5): words separated by white space outside quotes, single and double quotes
 * removed (a quoted part may hold spaces), and a backslash takes the next character as it is. The words end at the first
 * word that does not start with `--` (except the word after `--from` or `--mount` without `=`), or at `--` alone. The value of a flag is expanded afterwards (as BuildKit does).
 */
export function extractBuilderFlags(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let phase: 'spaces' | 'word' | 'quote' = 'spaces';
  let quote = '';
  let blankOk = false;
  for (let pos = 0; pos <= line.length; pos++) {
    const end = pos === line.length;
    const char = end ? '' : line[pos];
    if (phase === 'spaces') {
      if (end) break;
      if (/\s/.test(char)) continue;
      // A value after a flag without `=` (for example `--mount type=…`): BuildKit refuses it, the check reads it anyway.
      const previous = words.length > 0 ? words[words.length - 1].toLowerCase() : '';
      if ((char !== '-' || line[pos + 1] !== '-') && !(previous === '--from' || previous === '--mount')) break;
      phase = 'word';
    }
    if (end) {
      if (word !== '--' && (blankOk || word !== '')) words.push(word);
      break;
    }
    if (phase === 'word') {
      if (/\s/.test(char)) {
        if (word === '--') break;
        if (blankOk || word !== '') words.push(word);
        phase = 'spaces';
        word = '';
        blankOk = false;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        blankOk = true;
        phase = 'quote';
        continue;
      }
      if (char === '\\') {
        if (pos + 1 === line.length) continue;
        word += line[++pos];
        continue;
      }
      word += char;
      continue;
    }
    // In quotes.
    if (char === quote) {
      phase = 'word';
      continue;
    }
    if (char === '\\') {
      if (pos + 1 === line.length) {
        phase = 'word';
        continue;
      }
      word += line[++pos];
      continue;
    }
    word += char;
  }
  return words;
}

/**
 * The fields of a value that BuildKit reads as a line of CSV (the value of `RUN --mount`): separated by commas, a field
 * in double quotes may hold commas, and `""` in it is one quote. Review round 3 (S3-5).
 */
function csvFields(value: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) {
      if (char === '"' && value[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/** A parser directive `# name=value` (more lenient than BuildKit: white space before the `#`). */
const DIRECTIVE = /^\s*#\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+?)\s*$/;
/** A directive in the C form `// name=value` (DetectSyntax). */
const SLASH_DIRECTIVE = /^\s*\/\/\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+?)\s*$/;

/**
 * The frontend of a Dockerfile as `DetectSyntax` of BuildKit's Dockerfile parser finds it (review round 5, S5-3): after a
 * BOM, a first line that starts with `#!` is left out; then the directive `# syntax=…` at the top (with the directives
 * `escape` and `check` before it), else the directive `// syntax=…`, else the whole text as a JSON object with a text
 * `syntax`. BuildKit takes the value up to its first space (review round 5, P5-2: `# syntax=docker/dockerfile:1 # x`),
 * the check cuts the JSON value there too. `undefined` without one.
 */
export function detectSyntax(text: string): string | undefined {
  let source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const newline = source.indexOf('\n');
  if ((newline < 0 ? source : source.slice(0, newline)).startsWith('#!')) source = newline < 0 ? '' : source.slice(newline + 1);
  const lines = source.split(/\r\n|\r|\n/);
  for (const pattern of [DIRECTIVE, SLASH_DIRECTIVE]) {
    for (const line of lines) {
      const match = pattern.exec(line);
      if (!match || !KNOWN_DIRECTIVES.has(match[1].toLowerCase())) break;
      if (match[1].toLowerCase() === 'syntax') return cutAtSpace(match[2]);
    }
  }
  try {
    const json: unknown = JSON.parse(source);
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
      const value = (json as Record<string, unknown>).syntax;
      if (typeof value === 'string') return cutAtSpace(value);
    }
  } catch {
    // No JSON document.
  }
  return undefined;
}

/** The text up to its first ASCII space, as BuildKit's `strings.Cut(value, " ")` (review round 5, P5-2). */
export function cutAtSpace(value: string): string {
  const space = value.indexOf(' ');
  return space < 0 ? value : value.slice(0, space);
}

/** Splits the text into instructions: directives, comments, continuation lines, and heredoc bodies are handled here. */
function parseInstructions(text: string): { escape: string; syntax?: string; instructions: Instruction[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\r|\n/);
  let escape = '\\';
  // Review round 5 (S5-3): the frontend as BuildKit's DetectSyntax finds it.
  const syntax = detectSyntax(text);
  let index = 0;

  // Parser directives are only recognized at the very top of the file.
  for (; index < lines.length; index++) {
    const match = DIRECTIVE.exec(lines[index]);
    if (!match || !KNOWN_DIRECTIVES.has(match[1].toLowerCase())) break;
    if (match[1].toLowerCase() === 'escape' && (match[2] === '`' || match[2] === '\\')) escape = match[2];
  }

  const continuation = new RegExp(`${escapeRegExp(escape)}[ \\t]*$`);
  const isSkippable = (line: string) => {
    const trimmed = line.trimStart();
    return trimmed === '' || trimmed.startsWith('#');
  };
  const instructions: Instruction[] = [];

  while (index < lines.length) {
    if (isSkippable(lines[index])) {
      index++;
      continue;
    }
    let line = lines[index].trimStart();
    let full = '';
    for (;;) {
      const match = continuation.exec(line);
      if (!match) {
        full += line;
        break;
      }
      full += line.slice(0, match.index);
      index++;
      // Empty lines and comment lines inside a continued instruction are removed.
      while (index < lines.length && isSkippable(lines[index])) index++;
      if (index >= lines.length) break;
      line = lines[index];
    }
    index++;

    const match = /^(\S+)\s*([\s\S]*)$/.exec(full.trim());
    if (!match) continue;
    const keyword = match[1].toUpperCase();
    const args = match[2];
    instructions.push({ keyword, args });

    if (HEREDOC_INSTRUCTIONS.has(keyword)) {
      for (const heredoc of findHeredocs(args)) {
        while (index < lines.length) {
          const bodyLine = heredoc.stripTabs ? lines[index].replace(/^\t+/, '') : lines[index];
          index++;
          if (bodyLine.trimEnd() === heredoc.name) break;
        }
      }
    }
  }
  return { escape, ...(syntax !== undefined ? { syntax } : {}), instructions };
}

function findHeredocs(args: string): Array<{ name: string; stripTabs: boolean }> {
  const result: Array<{ name: string; stripTabs: boolean }> = [];
  const pattern = /(?:^|\s)<<(-?)(["']?)([A-Za-z0-9_.-]+)\2(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    result.push({ name: match[3], stripTabs: match[1] === '-' });
  }
  return result;
}

/** Splits ARG arguments at whitespace outside of quotes. Quotes and escapes stay in the words for `expand`. */
function splitWords(text: string, escape: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === escape && i + 1 < text.length && quote !== "'") {
      current += char + text[i + 1];
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '') words.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') words.push(current);
  return words;
}

function withUnchecked(value: string | undefined, unchecked: UncheckedClass | undefined, tooComplex = false): LookupValue {
  const found: LookupValue = unchecked !== undefined ? { value, unchecked } : { value };
  if (tooComplex) found.tooComplex = true;
  return found;
}

/**
 * Word expansion as in the Dockerfile shell lexer: quotes, escapes, and variables. `state` collects what the expansion
 * met (review round 4, S4-3). `rawEscapes`: the escape character stays in the result with the character after it, as
 * BuildKit keeps it in the pattern of `${VAR#pattern}` and `${VAR/pattern/replacement}`.
 */
function expand(word: string, lookup: Lookup, escape: string, state?: Expansion, rawEscapes = false): string {
  let result = '';
  let inDouble = false;
  let i = 0;
  while (i < word.length) {
    // Review round 6 (S6-1): a text longer than MAX_EXPANDED_LENGTH is cut and cannot be checked.
    if (result.length > MAX_EXPANDED_LENGTH) {
      markUnchecked(state, 'unsupported');
      return result.slice(0, MAX_EXPANDED_LENGTH + 1);
    }
    const char = word[i];
    if (char === escape && i + 1 < word.length) {
      result += rawEscapes ? word.slice(i, i + 2) : word[i + 1];
      i += 2;
      continue;
    }
    if (char === "'" && !inDouble) {
      const end = word.indexOf("'", i + 1);
      if (end < 0) {
        result += word.slice(i + 1);
        break;
      }
      result += word.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (char === '"') {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (char === '$') {
      const variable = expandVariable(word, i, lookup, escape, state);
      result += variable.text;
      i = variable.end;
      continue;
    }
    result += char;
    i++;
  }
  if (result.length > MAX_EXPANDED_LENGTH) {
    markUnchecked(state, 'unsupported');
    return result.slice(0, MAX_EXPANDED_LENGTH + 1);
  }
  return result;
}

/**
 * Expands the variable at `word[start] === '$'`. An unresolvable variable keeps its text, so the result contains `$`.
 * Review round 4 (S4-3): the pattern operators of BuildKit's shell lexer (`${VAR#p}`, `${VAR##p}`, `${VAR%p}`,
 * `${VAR%%p}`, `${VAR/p/r}`, `${VAR//p/r}`) are evaluated as BuildKit evaluates them (matchShellPattern); a form that
 * cannot be evaluated keeps its text and is marked in `state` (UncheckedClass).
 */
function expandVariable(word: string, start: number, lookup: Lookup, escape: string, state?: Expansion): { text: string; end: number } {
  if (word[start + 1] !== '{') {
    const name = SHELL_NAME.exec(word.slice(start + 1))?.[0];
    if (!name) return { text: '$', end: start + 1 };
    const end = start + 1 + name.length;
    const found = lookup(name);
    if (found === 'unresolved') {
      if (state) state.unresolved = true;
      // Review round 5 (S5-1): in braces when an escape or a quote comes next, whose character could otherwise read as a
      // part of the name (`dev$TARGETVARIANT\env` gives `dev${TARGETVARIANT}env`, see unresolvedVariants).
      const next = word[end];
      return { text: next === escape || next === '"' || next === "'" ? `\${${name}}` : word.slice(start, end), end };
    }
    markFound(state, found);
    return { text: found.value ?? '', end };
  }

  let depth = 1;
  let deepest = 1;
  let j = start + 2;
  while (j < word.length) {
    if (word[j] === escape) {
      j += 2;
    } else if (word[j] === '$' && word[j + 1] === '{') {
      depth++;
      deepest = Math.max(deepest, depth);
      j += 2;
    } else if (word[j] === '}') {
      depth--;
      if (depth === 0) break;
      j++;
    } else {
      j++;
    }
  }
  if (depth !== 0) return { text: word.slice(start), end: word.length };

  const raw = word.slice(start, j + 1);
  const end = j + 1;
  // Review round 6 (S6-1): a nesting deeper than MAX_NESTING is not evaluated (each nested operand expands on its own,
  // so its nesting is less than this one).
  if (deepest > MAX_NESTING) {
    markUnchecked(state, 'unsupported');
    return { text: raw, end };
  }
  const inner = word.slice(start + 2, j);
  const name = SHELL_NAME.exec(inner)?.[0];
  if (!name) {
    // `${}`, `${:x}`, `${.x}`: BuildKit refuses them; the check cannot read them either (review round 4, S4-3). Review
    // round 5 (S5-1): `${1}` and `${@}` are names (SHELL_NAME).
    markUnchecked(state, 'protected');
    return { text: raw, end };
  }
  const modifier = inner.slice(name.length);
  const found = lookup(name);
  if (found === 'unresolved') {
    if (state) state.unresolved = true;
    // The value is not known: a pattern or an unknown operator could make any reference of it (review round 4, S4-3).
    if (!/^(|:?[-+?][\s\S]*)$/.test(modifier)) markUnchecked(state, 'protected');
    return { text: raw, end };
  }
  markFound(state, found);
  if (state?.keepPatterns === true && /^[#%/]/.test(modifier)) return { text: raw, end };

  const value = found.value;
  const isSet = value !== undefined;
  const isNonEmpty = isSet && value !== '';
  const operand = (length: number) => expand(modifier.slice(length), lookup, escape, state);
  /**
   * A form that cannot be evaluated: refused as protected when the value holds `devenv`, else as unsupported. `result`
   * `'budget'`: the Dockerfile ran out of the budget of the pattern matcher (review round 7, S7-1).
   */
  const unevaluated = (result?: 'budget'): { text: string; end: number } => {
    markUnchecked(state, /devenv/i.test(value ?? '') ? 'protected' : 'unsupported');
    if (result === 'budget' && state !== undefined) state.tooComplex = true;
    return { text: raw, end };
  };
  /** A pattern or a replacement as BuildKit reads it (escapes kept); `undefined` when a variable in it is not resolved. */
  const patternText = (text: string): string | undefined => {
    const own: Expansion = {};
    const result = expand(text, lookup, escape, own, true);
    markUnchecked(state, own.unchecked);
    if (state !== undefined && own.tooComplex === true) state.tooComplex = true;
    return own.unresolved === true || own.unchecked !== undefined ? undefined : result;
  };

  if (modifier === '') return { text: value ?? '', end };
  if (modifier.startsWith(':-')) return { text: isNonEmpty ? value : operand(2), end };
  if (modifier.startsWith(':+')) return { text: isNonEmpty ? operand(2) : '', end };
  if (modifier.startsWith(':?')) return { text: isNonEmpty ? value : raw, end };
  if (modifier.startsWith('-')) return { text: isSet ? value : operand(1), end };
  if (modifier.startsWith('+')) return { text: isSet ? operand(1) : '', end };
  if (modifier.startsWith('?')) return { text: isSet ? value : raw, end };
  if (modifier.startsWith('#') || modifier.startsWith('%')) {
    const operator = modifier[0];
    let pattern = patternText(modifier.slice(1));
    if (pattern === undefined || (escape !== '\\' && pattern.includes(escape))) return unevaluated();
    const greedy = pattern.startsWith(operator);
    if (greedy) pattern = pattern.slice(1);
    // Review round 7 (S7-1): a linear matcher instead of a backtracking regular expression.
    const trimmed = operator === '#' ? trimShellPrefix(pattern, value ?? '', greedy) : trimShellSuffix(pattern, value ?? '', greedy);
    return trimmed === undefined || trimmed === 'budget' ? unevaluated(trimmed) : { text: trimmed, end };
  }
  if (modifier.startsWith('/')) {
    const all = modifier.startsWith('//');
    const rest = modifier.slice(all ? 2 : 1);
    const slash = topLevelIndex(rest, '/', escape);
    if (slash < 0) return unevaluated();
    const pattern = patternText(rest.slice(0, slash));
    const replacement = patternText(rest.slice(slash + 1));
    // Go's ReplaceAllString reads `$` in the replacement as a group; the escapes stay in it as BuildKit keeps them.
    if (pattern === undefined || replacement === undefined || replacement.includes('$') || (escape !== '\\' && pattern.includes(escape))) {
      return unevaluated();
    }
    const replaced = replaceShellPattern(pattern, replacement, value ?? '', all);
    return replaced === undefined || replaced === 'budget' ? unevaluated(replaced) : { text: replaced, end };
  }
  // An operator that BuildKit's shell lexer does not know (for example `${VAR:#x}` or `${VAR:1}`).
  return unevaluated();
}

/**
 * The index of `stop` in `text` outside quotes, escapes, and nested `${…}`, as BuildKit's `processStopOn` finds it; -1
 * without one.
 */
function topLevelIndex(text: string, stop: string, escape: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === escape) {
      i++;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '$' && text[i + 1] === '{') {
      depth++;
      i++;
    } else if (char === '}' && depth > 0) depth--;
    else if (char === stop && depth === 0) return i;
  }
  return -1;
}

/**
 * Review round 7 (S7-1): the most steps that the pattern matcher may take for one Dockerfile (all its `${VAR#p}`,
 * `${VAR%p}`, and `${VAR/p/r}` together): a step is one position of the value for one state of the pattern, so the sum of
 * value length × pattern length. Beyond it, the forms are not evaluated, and the reference is refused as unsupported
 * (the Dockerfile is too complex to check).
 */
export const MAX_PATTERN_STEPS = 10_000_000;

/** Review round 7 (S7-1): the steps that the pattern matcher has left for the Dockerfile that is being read. */
export interface PatternBudget {
  steps: number;
  exceeded?: boolean;
}

/** One element of a shell pattern: a character, `?` (any one character), or `*` (any text). */
type PatternToken = { kind: 'char'; char: string } | { kind: 'any' } | { kind: 'star' };

/**
 * A shell pattern as `convertShellPatternToRegex` of BuildKit's shell lexer reads it (review round 4, S4-3): `*` any
 * text, `?` one character, `\*`, `\?`, `\\` the character itself, `\}` and `\/` the character after the backslash;
 * every other character stands for itself (also `[`: BuildKit has no bracket expressions). `undefined` for a pattern that
 * BuildKit refuses (another escape). By code points, as Go's regexp reads UTF-8.
 */
export function parseShellPattern(pattern: string): PatternToken[] | undefined {
  const chars = Array.from(pattern);
  const tokens: PatternToken[] = [];
  for (let i = 0; i < chars.length; i++) {
    let char = chars[i];
    if (char === '*') {
      tokens.push({ kind: 'star' });
      continue;
    }
    if (char === '?') {
      tokens.push({ kind: 'any' });
      continue;
    }
    if (char === '\\') {
      if (chars[i + 1] === '}' || chars[i + 1] === '/') continue;
      char = chars[++i];
      if (char !== '*' && char !== '?' && char !== '\\') return undefined;
    }
    tokens.push({ kind: 'char', char });
  }
  return tokens;
}

/**
 * Review round 7 (S7-1): the match of a shell pattern (parseShellPattern) in `value` (code points) that Go's regexp
 * finds for the regular expression of BuildKit (`.*` for `*` when `greedy`, else `.*?`; `.` for `?`, which, as `.*`,
 * does not match a line feed): the leftmost match, and of the matches that start there the one that a backtracking
 * matcher takes first (leftmost-first, as Go and JavaScript choose). A simulation of the pattern's automaton with
 * threads in the order of their priority (Pike's VM), in O(value length × pattern length) steps, instead of a
 * backtracking regular expression, which needs exponential time for some patterns (`*a*a*a*b`). `anchored`: only a match
 * at `from`. `undefined`: no match; `'budget'`: the budget of steps ran out.
 */
export function matchShellPattern(
  tokens: readonly PatternToken[],
  value: readonly string[],
  from: number,
  greedy: boolean,
  anchored: boolean,
  budget: PatternBudget,
): { start: number; end: number } | undefined | 'budget' {
  const accept = tokens.length;
  interface Threads {
    /** The state of each thread: a token index, or `accept`. */
    states: number[];
    /** Where the match of each thread started. */
    starts: number[];
  }
  // Each state once per list: the first thread (of the highest priority) wins.
  const mark = new Int32Array(accept + 1).fill(-1);
  let generation = 0;
  const lazyStars: number[] = [];
  /** Adds the ε-closure of `state`: `*` either matches one more character (the state stays) or ends (the next state). */
  const add = (list: Threads, first: number, start: number): void => {
    let state = first;
    lazyStars.length = 0;
    while (state !== accept && tokens[state].kind === 'star' && mark[state] !== generation) {
      mark[state] = generation;
      if (greedy) {
        // One more character first, then the end of the star.
        list.states.push(state);
        list.starts.push(start);
      } else {
        lazyStars.push(state);
      }
      state++;
    }
    if (mark[state] !== generation) {
      mark[state] = generation;
      list.states.push(state);
      list.starts.push(start);
    }
    // Lazy: the end of each star first, then one more character, the innermost first.
    for (let i = lazyStars.length - 1; i >= 0; i--) {
      list.states.push(lazyStars[i]);
      list.starts.push(start);
    }
  };
  let current: Threads = { states: [], starts: [] };
  add(current, 0, from);
  let match: { start: number; end: number } | undefined;
  for (let position = from; ; position++) {
    budget.steps -= current.states.length + 1;
    if (budget.steps < 0) {
      budget.exceeded = true;
      return 'budget';
    }
    generation++;
    const next: Threads = { states: [], starts: [] };
    const char = position < value.length ? value[position] : undefined;
    for (let i = 0; i < current.states.length; i++) {
      const state = current.states[i];
      if (state === accept) {
        // The threads of lower priority are cut; those of higher priority may still find a match that wins.
        match = { start: current.starts[i], end: position };
        break;
      }
      if (char === undefined) continue;
      const token = tokens[state];
      if (token.kind === 'char' ? token.char !== char : char === '\n') continue;
      add(next, token.kind === 'star' ? state : state + 1, current.starts[i]);
    }
    if (char === undefined) break;
    // A new start at the next position, of the lowest priority, while no match was found.
    if (match === undefined && !anchored) add(next, 0, position + 1);
    if (next.states.length === 0) break;
    current = next;
  }
  return match;
}

/**
 * Review round 7 (S7-1): the budget of the Dockerfile that extractImageReferences reads (the expansion is synchronous, so
 * one at a time); outside of it, each pattern gets a budget of its own.
 */
let activeBudget: PatternBudget | undefined;

function patternBudget(): PatternBudget {
  return activeBudget ?? { steps: MAX_PATTERN_STEPS };
}

/** Runs `fn` with a fresh budget of MAX_PATTERN_STEPS for all patterns of one Dockerfile. */
function withPatternBudget<T>(fn: (budget: PatternBudget) => T): T {
  const previous = activeBudget;
  const budget: PatternBudget = { steps: MAX_PATTERN_STEPS };
  activeBudget = budget;
  try {
    return fn(budget);
  } finally {
    activeBudget = previous;
  }
}

/** The result of a pattern form: the text, `undefined` for a pattern that BuildKit refuses, or `'budget'` (S7-1). */
type PatternResult = string | undefined | 'budget';

/** `${VAR#pattern}` and `${VAR##pattern}` as BuildKit's `trimPrefix` (the shortest match, or the longest when `greedy`). */
export function trimShellPrefix(pattern: string, value: string, greedy: boolean, budget: PatternBudget = patternBudget()): PatternResult {
  const tokens = parseShellPattern(pattern);
  if (tokens === undefined) return undefined;
  const chars = Array.from(value);
  const match = matchShellPattern(tokens, chars, 0, greedy, true, budget);
  if (match === 'budget') return match;
  return match === undefined ? value : chars.slice(match.end).join('');
}

/**
 * `${VAR%pattern}` and `${VAR%%pattern}` as BuildKit's `trimSuffix`: the prefix rule on the reversed value, with the
 * pattern reversed (an escape stays before its character).
 */
export function trimShellSuffix(pattern: string, value: string, greedy: boolean, budget: PatternBudget = patternBudget()): PatternResult {
  const chars = Array.from(pattern);
  const reversed: string[] = new Array<string>(chars.length);
  const last = chars.length - 1;
  for (let i = 0; i <= last; ) {
    const out = last - i;
    if (chars[i] === '\\' && i !== last) {
      reversed[out - 1] = chars[i];
      reversed[out] = chars[i + 1];
      i += 2;
    } else {
      reversed[out] = chars[i];
      i++;
    }
  }
  const trimmed = trimShellPrefix(reversed.join(''), Array.from(value).reverse().join(''), greedy, budget);
  return trimmed === undefined || trimmed === 'budget' ? trimmed : Array.from(trimmed).reverse().join('');
}

/**
 * `${VAR/pattern/replacement}` (the first match) and `${VAR//pattern/replacement}` (every match, as Go's
 * `ReplaceAllString`: an empty match right after a match does not count), with a greedy pattern, as BuildKit does.
 */
export function replaceShellPattern(
  pattern: string,
  replacement: string,
  value: string,
  all: boolean,
  budget: PatternBudget = patternBudget(),
): PatternResult {
  const tokens = parseShellPattern(pattern);
  if (tokens === undefined) return undefined;
  const chars = Array.from(value);
  const parts: string[] = [];
  let position = 0;
  let previousEnd = -1;
  let searchFrom = 0;
  while (searchFrom <= chars.length) {
    const match = matchShellPattern(tokens, chars, searchFrom, true, false, budget);
    if (match === 'budget') return match;
    if (match === undefined) break;
    if (match.end === match.start && match.start === previousEnd) {
      searchFrom = match.start + 1;
      continue;
    }
    parts.push(chars.slice(position, match.start).join(''), replacement);
    position = match.end;
    previousEnd = match.end;
    if (!all) break;
    searchFrom = match.end > match.start ? match.end : match.start + 1;
  }
  parts.push(chars.slice(position).join(''));
  return parts.join('');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
