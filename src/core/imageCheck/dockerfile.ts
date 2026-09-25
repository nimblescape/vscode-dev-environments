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
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Instruction {
  keyword: string;
  args: string;
}

/** Value of a variable: `{ value: undefined }` is unset; `'unresolved'` keeps the variable text in the result. */
type Lookup = (name: string) => { value: string | undefined } | 'unresolved';

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
        if (!ARG_NAME.test(name)) continue;
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
    if (image !== '' && !image.includes('$') && key !== 'scratch' && !stages.has(key) && !seen.has(image)) {
      seen.add(image);
      images.push(image);
    }
    if (stageName) stages.add(stageName);
    if (target && stageName === target) break;
  }
  return images;
}

/** Splits the text into instructions: directives, comments, continuation lines, and heredoc bodies are handled here. */
function parseInstructions(text: string): { escape: string; instructions: Instruction[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\r|\n/);
  let escape = '\\';
  let index = 0;

  // Parser directives are only recognized at the very top of the file.
  for (; index < lines.length; index++) {
    const match = /^\s*#\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+?)\s*$/.exec(lines[index]);
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

/** Word expansion as in the Dockerfile shell lexer: quotes, escapes, and variables. */
function expand(word: string, lookup: Lookup, escape: string): string {
  let result = '';
  let inDouble = false;
  let i = 0;
  while (i < word.length) {
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
  return result;
}

/** Expands the variable at `word[start] === '$'`. An unresolvable variable keeps its text, so the result contains `$`. */
function expandVariable(word: string, start: number, lookup: Lookup, escape: string): { text: string; end: number } {
  if (word[start + 1] !== '{') {
    const name = VARIABLE_NAME.exec(word.slice(start + 1))?.[0];
    if (!name) return { text: '$', end: start + 1 };
    const end = start + 1 + name.length;
    const found = lookup(name);
    return { text: found === 'unresolved' ? word.slice(start, end) : found.value ?? '', end };
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
  const name = VARIABLE_NAME.exec(inner)?.[0];
  if (!name) return { text: raw, end };
  const found = lookup(name);
  if (found === 'unresolved') return { text: raw, end };

  const value = found.value;
  const isSet = value !== undefined;
  const isNonEmpty = isSet && value !== '';
  const modifier = inner.slice(name.length);
  const operand = (length: number) => expand(modifier.slice(length), lookup, escape);

  if (modifier === '') return { text: value ?? '', end };
  if (modifier.startsWith(':-')) return { text: isNonEmpty ? value : operand(2), end };
  if (modifier.startsWith(':+')) return { text: isNonEmpty ? operand(2) : '', end };
  if (modifier.startsWith(':?')) return { text: isNonEmpty ? value : raw, end };
  if (modifier.startsWith('-')) return { text: isSet ? value : operand(1), end };
  if (modifier.startsWith('+')) return { text: isSet ? operand(1) : '', end };
  if (modifier.startsWith('?')) return { text: isSet ? value : raw, end };
  // Pattern operations (#, %, /) are not evaluated: the reference is skipped.
  return { text: raw, end };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
