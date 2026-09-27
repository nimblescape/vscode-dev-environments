// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Base images of a Dockerfile (concept 7.7, implementation notes 9).
// Follows the Dockerfile parser of BuildKit where it matters for FROM: parser directives, line continuations,
// comments, heredocs, global ARGs, and variable substitution.
// The Dockerfile is not checked (user decision 2026-09-27, README "Security: what to expect"): it runs as trusted code.
// Its FROM lines are read only for the update notice (collectReferences, composeReferences) and the helper image; a
// reference that cannot be read is skipped, never refused.

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
 * Review round 6 (S6-1): the longest image reference that the update check reads; a longer one is skipped. Docker's own
 * limit for a name is 255. The check of an image reference of the configuration (imageReferenceFinding of hostAccess.ts)
 * refuses a longer one.
 */
export const MAX_REFERENCE_LENGTH = 1024;
/** Review round 6 (S6-1): the deepest nesting of `${…}` that the expansion evaluates; a deeper one stays unevaluated (skipped). */
export const MAX_NESTING = 32;
/**
 * Review round 6 (S6-1): the longest text that one expansion (an ARG value, a reference) makes; a longer one is cut (and
 * a reference of it is skipped, MAX_REFERENCE_LENGTH).
 */
export const MAX_EXPANDED_LENGTH = 64 * 1024;
/**
 * Review round 8 (S8-2): the most characters that all expansions of one Dockerfile may make together (each ARG and
 * reference; nested operands count again). Beyond it, extractBaseImages gives no base images: ARGs that each expand to
 * MAX_EXPANDED_LENGTH would otherwise hold gigabytes in the extension host.
 */
export const MAX_EXPANDED_CHARACTERS = 16 * 1024 * 1024;
/**
 * Review round 7 (S7-2): the largest Dockerfile (in characters) and the most instructions that extractBaseImages reads;
 * a larger one gives no base images (the update check skips it). The helper scripts read at most one character more
 * (readLimited of scripts.ts).
 */
export const MAX_DOCKERFILE_LENGTH = 1024 * 1024;
export const MAX_DOCKERFILE_INSTRUCTIONS = 20_000;

interface Instruction {
  keyword: string;
  args: string;
}

/** Value of a variable: `{ value: undefined }` is unset; `'unresolved'` keeps the variable text in the result. */
type Lookup = (name: string) => { value: string | undefined } | 'unresolved';

/**
 * Review round 18 (S18-1): the build arguments of a `build.args` object (of a Compose model or of devcontainer.json) as
 * texts: each value that is a text, a number, or a boolean, as `String(value)`; any other value is left out. Built with
 * own properties (Object.fromEntries), so that an argument named `__proto__` stays an argument, as the Dev Container CLI
 * and Docker keep it; an assignment would call the setter of Object.prototype and lose it.
 */
export function buildArgumentTexts(args: unknown): Record<string, string> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      .map(([name, value]) => [name, String(value)]),
  );
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
  // Review round 8 (S8-2): a Dockerfile beyond the limits gives no base images (the update check skips it).
  if (dockerfileText.length > MAX_DOCKERFILE_LENGTH) return [];
  const { escape, instructions } = parseInstructions(dockerfileText);
  if (instructions.length > MAX_DOCKERFILE_INSTRUCTIONS) return [];
  return withExpansionBudget((budget) => {
    const images = readBaseImages(escape, instructions, buildArgs, options);
    return budget.exceeded === true ? [] : images;
  });
}
function readBaseImages(
  escape: string,
  instructions: readonly Instruction[],
  buildArgs: Record<string, string> | undefined,
  options: { target?: string },
): string[] {
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
        const defaultValue = equals < 0 ? undefined : expand(word.slice(equals + 1), lookup, escape);
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
    const image = expand(words[0], lookup, escape).trim();
    const stageName = words.length >= 3 && words[1].toLowerCase() === 'as' ? words[2].toLowerCase() : undefined;

    const key = image.toLowerCase();
    // A reference longer than MAX_REFERENCE_LENGTH (for example a cut expansion) is skipped too.
    const readable = image !== '' && !image.includes('$') && image.length <= MAX_REFERENCE_LENGTH;
    if (readable && key !== 'scratch' && !stages.has(key) && !seen.has(image)) {
      seen.add(image);
      images.push(image);
    }
    if (stageName) stages.add(stageName);
    if (target && stageName === target) break;
  }
  return images;
}

/**
 * A parser directive `# name=value` (more lenient than BuildKit: white space before the `#`). Review round 8 (S8-3): the
 * value is taken as it is and trimmed afterwards (parseDirective); BuildKit's `\s*=\s*(.+?)\s*$` backtracks in quadratic
 * time on a value with many spaces.
 */
const DIRECTIVE = /^\s*#\s*([A-Za-z][A-Za-z0-9]*)\s*=(.*)$/;

/**
 * A directive line (DIRECTIVE) with its name and value, as BuildKit's `\s*=\s*(.+?)\s*$` gives
 * them: the value without the white space around it; a value of white space only is its last character (the lazy group
 * takes one); an empty value is no directive.
 */
function parseDirective(line: string, pattern: RegExp): { name: string; value: string } | undefined {
  const match = pattern.exec(line);
  if (!match || match[2] === '') return undefined;
  const trimmed = match[2].trim();
  return { name: match[1], value: trimmed !== '' ? trimmed : match[2].slice(-1) };
}

/** Splits the text into instructions: directives, comments, continuation lines, and heredoc bodies are handled here. */
function parseInstructions(text: string): { escape: string; instructions: Instruction[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\r|\n/);
  let escape = '\\';
  let index = 0;

  // Parser directives are only recognized at the very top of the file.
  for (; index < lines.length; index++) {
    const directive = parseDirective(lines[index], DIRECTIVE);
    if (!directive || !KNOWN_DIRECTIVES.has(directive.name.toLowerCase())) break;
    if (directive.name.toLowerCase() === 'escape' && (directive.value === '`' || directive.value === '\\')) escape = directive.value;
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
  return { escape, instructions };
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

/** The budget of the Dockerfile that extractBaseImages reads (review round 8, S8-2: MAX_EXPANDED_CHARACTERS). */
interface ExpansionBudget {
  characters: number;
  exceeded?: boolean;
}

/** The budget of the Dockerfile that is being read (the expansion is synchronous, so one at a time). */
let activeBudget: ExpansionBudget | undefined;

/** Runs `fn` with a fresh budget of MAX_EXPANDED_CHARACTERS for all expansions of one Dockerfile. */
function withExpansionBudget<T>(fn: (budget: ExpansionBudget) => T): T {
  const previous = activeBudget;
  const budget: ExpansionBudget = { characters: MAX_EXPANDED_CHARACTERS };
  activeBudget = budget;
  try {
    return fn(budget);
  } finally {
    activeBudget = previous;
  }
}

/** Word expansion as in the Dockerfile shell lexer: quotes, escapes, and variables. */
function expand(word: string, lookup: Lookup, escape: string): string {
  // Review round 8 (S8-2): after the Dockerfile ran out of MAX_EXPANDED_CHARACTERS, nothing is expanded any more.
  const budget = activeBudget;
  if (budget?.exceeded === true) return word;
  const text = expandWord(word, lookup, escape);
  if (budget !== undefined) {
    budget.characters -= text.length;
    if (budget.characters < 0) budget.exceeded = true;
  }
  return text;
}

function expandWord(word: string, lookup: Lookup, escape: string): string {
  let result = '';
  let inDouble = false;
  let i = 0;
  while (i < word.length) {
    // Review round 6 (S6-1): a text longer than MAX_EXPANDED_LENGTH is cut.
    if (result.length > MAX_EXPANDED_LENGTH) return result.slice(0, MAX_EXPANDED_LENGTH + 1);
    const char = word[i];
    if (char === escape && i + 1 < word.length) {
      result += word[i + 1];
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
      const variable = expandVariable(word, i, lookup, escape);
      result += variable.text;
      i = variable.end;
      continue;
    }
    result += char;
    i++;
  }
  return result.length > MAX_EXPANDED_LENGTH ? result.slice(0, MAX_EXPANDED_LENGTH + 1) : result;
}

/**
 * Expands the variable at `word[start] === '$'`. An unresolvable variable keeps its text, so the result contains `$`
 * (and extractBaseImages skips the reference). The forms `${VAR:-x}`, `${VAR-x}`, `${VAR:+x}`, `${VAR+x}`, `${VAR:?x}`,
 * and `${VAR?x}` are evaluated; any other form (the pattern operators `#`, `%`, `/`, or an operator that BuildKit does
 * not know) keeps its text.
 */
function expandVariable(word: string, start: number, lookup: Lookup, escape: string): { text: string; end: number } {
  if (word[start + 1] !== '{') {
    const name = SHELL_NAME.exec(word.slice(start + 1))?.[0];
    if (!name) return { text: '$', end: start + 1 };
    const end = start + 1 + name.length;
    const found = lookup(name);
    if (found === 'unresolved') return { text: word.slice(start, end), end };
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
  if (deepest > MAX_NESTING) return { text: raw, end };
  const inner = word.slice(start + 2, j);
  const name = SHELL_NAME.exec(inner)?.[0];
  if (!name) return { text: raw, end };
  const modifier = inner.slice(name.length);
  const found = lookup(name);
  if (found === 'unresolved') return { text: raw, end };

  const value = found.value;
  const isSet = value !== undefined;
  const isNonEmpty = isSet && value !== '';
  const operand = (length: number) => expand(modifier.slice(length), lookup, escape);

  if (modifier === '') return { text: value ?? '', end };
  if (modifier.startsWith(':-')) return { text: isNonEmpty ? value : operand(2), end };
  if (modifier.startsWith(':+')) return { text: isNonEmpty ? operand(2) : '', end };
  if (modifier.startsWith(':?')) return { text: isNonEmpty ? value : raw, end };
  if (modifier.startsWith('-')) return { text: isSet ? value : operand(1), end };
  if (modifier.startsWith('+')) return { text: isSet ? operand(1) : '', end };
  if (modifier.startsWith('?')) return { text: isSet ? value : raw, end };
  return { text: raw, end };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
