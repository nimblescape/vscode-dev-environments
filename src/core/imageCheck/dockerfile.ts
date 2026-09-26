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

interface Instruction {
  keyword: string;
  args: string;
}

/**
 * Value of a variable: `{ value: undefined }` is unset; `'unresolved'` keeps the variable text in the result. `unchecked`:
 * the value came from an expansion that could not be evaluated (Expansion.unchecked).
 */
type Lookup = (name: string) => { value: string | undefined; unchecked?: UncheckedClass } | 'unresolved';

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
}

function markUnchecked(state: Expansion | undefined, value: UncheckedClass | undefined): void {
  if (state === undefined || value === undefined) return;
  if (state.unchecked !== 'protected') state.unchecked = value;
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
}

/**
 * Every image that a Dockerfile names, for the rule on the images of other environments (D-17, review round 2, S2-02):
 * the FROM images (as extractBaseImages, but a reference with a variable that cannot be resolved is kept with its `$`),
 * the sources of `COPY --from=<ref>` and of `RUN --mount=…,from=<ref>` (BuildKit takes an image when the value names no
 * stage), and the frontend of the parser directive `# syntax=<ref>`. Stage names (of the whole file, case-insensitive)
 * and stage indexes (`--from=0`) are not images and are left out, and so is `scratch`. Variables of a stage: its ARGs
 * (with `buildArgs`) and ENVs; any other variable stays unresolved (the text keeps its `$`). `ADD` has no `--from`. With
 * `target`, the stages after the target stage are not included, as in extractBaseImages. In order, without duplicates.
 */
export function extractImageReferences(
  dockerfileText: string,
  buildArgs?: Record<string, string>,
  options: { target?: string } = {},
): DockerfileImageReference[] {
  const { escape, syntax, instructions } = parseInstructions(dockerfileText);
  const override = (name: string): string | undefined =>
    buildArgs && Object.prototype.hasOwnProperty.call(buildArgs, name) ? buildArgs[name] : undefined;
  const globals = new Map<string, string | undefined>();
  // Review round 4 (S4-3): the variables whose value came from an expansion that could not be evaluated.
  const globalUnchecked = new Map<string, UncheckedClass>();
  const globalLookup: Lookup = (name) => {
    if (PLATFORM_ARGS.has(name)) return override(name) !== undefined ? { value: override(name) } : 'unresolved';
    if (!globals.has(name)) return { value: undefined };
    if (override(name) !== undefined) return { value: override(name) };
    return withUnchecked(globals.get(name), globalUnchecked.get(name));
  };
  // The variables of the current stage; `null`: declared, but its value is not known here (a platform ARG).
  let stage = new Map<string, string | undefined | null>();
  let stageUnchecked = new Map<string, UncheckedClass>();
  const stageLookup: Lookup = (name) => {
    if (!stage.has(name)) return 'unresolved';
    const value = stage.get(name);
    return value === null ? 'unresolved' : withUnchecked(value, stageUnchecked.get(name));
  };
  /** Sets a variable of the current stage (or of the global scope) with what its expansion met. */
  const setVariable = (scope: 'global' | 'stage', name: string, value: string | undefined | null, state?: Expansion): void => {
    const values = scope === 'global' ? globals : stage;
    const unchecked = scope === 'global' ? globalUnchecked : stageUnchecked;
    if (scope === 'global') globals.set(name, value ?? undefined);
    else values.set(name, value);
    if (state?.unchecked !== undefined) unchecked.set(name, state.unchecked);
    else unchecked.delete(name);
  };

  const stages = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.keyword !== 'FROM') continue;
    const words = instruction.args.split(/\s+/).filter((word) => word !== '');
    while (words.length > 0 && words[0].startsWith('--')) words.shift();
    if (words.length >= 3 && words[1].toLowerCase() === 'as') stages.add(words[2].toLowerCase());
  }

  const result: DockerfileImageReference[] = [];
  const seen = new Set<string>();
  // FROM: only the stages before it, as in extractBaseImages (the conservative side for a later name).
  const earlier = new Set<string>();
  const add = (reference: string, kind: ImageReferenceKind, state?: Expansion): void => {
    const text = reference.trim();
    const key = text.toLowerCase();
    const isStage = kind === 'FROM' ? earlier.has(key) : stages.has(key);
    if (text === '' || key === 'scratch' || isStage || (kind !== 'FROM' && /^\d+$/.test(text))) return;
    const known = result.find((other) => other.kind === kind && other.reference === text);
    if (known) {
      if (state?.unchecked !== undefined && known.unchecked !== 'protected') known.unchecked = state.unchecked;
      return;
    }
    if (seen.has(`${kind} ${text}`)) return;
    seen.add(`${kind} ${text}`);
    result.push({ reference: text, kind, ...(state?.unchecked !== undefined ? { unchecked: state.unchecked } : {}) });
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
        else setVariable('stage', name, globals.get(name), globalUnchecked.has(name) ? { unchecked: globalUnchecked.get(name) } : undefined);
      }
      continue;
    }
    if (instruction.keyword === 'FROM') {
      if (targetDone) break;
      fromSeen = true;
      stage = new Map();
      stageUnchecked = new Map();
      const words = instruction.args.split(/\s+/).filter((word) => word !== '');
      while (words.length > 0 && words[0].startsWith('--')) words.shift();
      if (words.length === 0) continue;
      const from = reference(words[0], globalLookup);
      add(from.text, 'FROM', from.state);
      const name = words.length >= 3 && words[1].toLowerCase() === 'as' ? words[2].toLowerCase() : undefined;
      if (name !== undefined) earlier.add(name);
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
        add(from.text, 'COPY --from', from.state);
      }
      if (instruction.keyword === 'RUN' && flag === '--mount') {
        for (const field of csvFields(value)) {
          const index = field.indexOf('=');
          if (index > 0 && field.slice(0, index).trim().toLowerCase() === 'from') {
            const from = reference(field.slice(index + 1), stageLookup);
            add(from.text, 'RUN --mount from', from.state);
          }
        }
      }
    }
  }
  return result;
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

function withUnchecked(value: string | undefined, unchecked: UncheckedClass | undefined): { value: string | undefined; unchecked?: UncheckedClass } {
  return unchecked !== undefined ? { value, unchecked } : { value };
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
  return result;
}

/**
 * Expands the variable at `word[start] === '$'`. An unresolvable variable keeps its text, so the result contains `$`.
 * Review round 4 (S4-3): the pattern operators of BuildKit's shell lexer (`${VAR#p}`, `${VAR##p}`, `${VAR%p}`,
 * `${VAR%%p}`, `${VAR/p/r}`, `${VAR//p/r}`) are evaluated as BuildKit evaluates them (shellPatternRegex); a form that
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
    markUnchecked(state, found.unchecked);
    return { text: found.value ?? '', end };
  }

  let depth = 1;
  let j = start + 2;
  while (j < word.length) {
    if (word[j] === escape) {
      j += 2;
    } else if (word[j] === '$' && word[j + 1] === '{') {
      depth++;
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
  markUnchecked(state, found.unchecked);
  if (state?.keepPatterns === true && /^[#%/]/.test(modifier)) return { text: raw, end };

  const value = found.value;
  const isSet = value !== undefined;
  const isNonEmpty = isSet && value !== '';
  const operand = (length: number) => expand(modifier.slice(length), lookup, escape, state);
  /** A form that cannot be evaluated: refused as protected when the value holds `devenv`, else as unsupported. */
  const unevaluated = (): { text: string; end: number } => {
    markUnchecked(state, /devenv/i.test(value ?? '') ? 'protected' : 'unsupported');
    return { text: raw, end };
  };
  /** A pattern or a replacement as BuildKit reads it (escapes kept); `undefined` when a variable in it is not resolved. */
  const patternText = (text: string): string | undefined => {
    const own: Expansion = {};
    const result = expand(text, lookup, escape, own, true);
    markUnchecked(state, own.unchecked);
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
    const trimmed = operator === '#' ? trimPrefix(pattern, value ?? '', greedy) : trimSuffix(pattern, value ?? '', greedy);
    return trimmed === undefined ? unevaluated() : { text: trimmed, end };
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
    const replaced = replacePattern(pattern, replacement, value ?? '', all);
    return replaced === undefined ? unevaluated() : { text: replaced, end };
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
 * A shell pattern as a regular expression, as `convertShellPatternToRegex` of BuildKit's shell lexer converts it (review
 * round 4, S4-3): `*` any text (shortest unless `greedy`), `?` one character, `\*`, `\?`, `\\` the character itself,
 * `\}` and `\/` the character after the backslash; every other character stands for itself (also `[`: BuildKit has no
 * bracket expressions). `undefined` for a pattern that BuildKit refuses (another escape).
 */
export function shellPatternRegex(pattern: string, greedy: boolean, anchored: boolean): RegExp | undefined {
  const chars = Array.from(pattern);
  let out = anchored ? '^' : '';
  for (let i = 0; i < chars.length; i++) {
    let char = chars[i];
    if (char === '*') {
      out += greedy ? '.*' : '.*?';
      continue;
    }
    if (char === '?') {
      out += '.';
      continue;
    }
    if (char === '\\') {
      if (chars[i + 1] === '}' || chars[i + 1] === '/') continue;
      char = chars[++i];
      if (char !== '*' && char !== '?' && char !== '\\') return undefined;
      out += `\\${char}`;
      continue;
    }
    out += /[[\]{}.+()|^$]/.test(char) ? `\\${char}` : char;
  }
  try {
    return new RegExp(out, 'u');
  } catch {
    return undefined;
  }
}

/** `${VAR#pattern}` and `${VAR##pattern}` as BuildKit's `trimPrefix`. */
function trimPrefix(pattern: string, value: string, greedy: boolean): string | undefined {
  const regex = shellPatternRegex(pattern, greedy, true);
  if (regex === undefined) return undefined;
  const match = regex.exec(value);
  return match ? value.slice(match.index + match[0].length) : value;
}

/**
 * `${VAR%pattern}` and `${VAR%%pattern}` as BuildKit's `trimSuffix`: the prefix rule on the reversed value, with the
 * pattern reversed (an escape stays before its character).
 */
function trimSuffix(pattern: string, value: string, greedy: boolean): string | undefined {
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
  const trimmed = trimPrefix(reversed.join(''), Array.from(value).reverse().join(''), greedy);
  return trimmed === undefined ? undefined : Array.from(trimmed).reverse().join('');
}

/**
 * `${VAR/pattern/replacement}` (the first match) and `${VAR//pattern/replacement}` (every match, as Go's
 * `ReplaceAllString`: an empty match right after a match does not count), with a greedy pattern, as BuildKit does.
 */
function replacePattern(pattern: string, replacement: string, value: string, all: boolean): string | undefined {
  const regex = shellPatternRegex(pattern, true, false);
  if (regex === undefined) return undefined;
  const global = new RegExp(regex.source, `${regex.flags}g`);
  const width = (index: number): number => ((value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
  let result = '';
  let position = 0;
  let previousEnd = -1;
  let searchFrom = 0;
  while (searchFrom <= value.length) {
    global.lastIndex = searchFrom;
    const match = global.exec(value);
    if (match === null) break;
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (matchEnd === matchStart && matchStart === previousEnd) {
      searchFrom = matchStart + width(matchStart);
      continue;
    }
    result += value.slice(position, matchStart) + replacement;
    position = matchEnd;
    previousEnd = matchEnd;
    if (!all) break;
    searchFrom = matchEnd > matchStart ? matchEnd : matchStart + width(matchStart);
  }
  return result + value.slice(position);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
