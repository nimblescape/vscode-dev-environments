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

/** Where a Dockerfile names an image (extractImageReferences). */
export type ImageReferenceKind = 'FROM' | 'COPY --from' | 'RUN --mount from' | 'syntax';

/** An image that a Dockerfile names (extractImageReferences). */
export interface DockerfileImageReference {
  /** As expanded; still with `$` where a variable could not be resolved. */
  reference: string;
  kind: ImageReferenceKind;
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
  const globalLookup: Lookup = (name) => {
    if (PLATFORM_ARGS.has(name)) return override(name) !== undefined ? { value: override(name) } : 'unresolved';
    if (!globals.has(name)) return { value: undefined };
    return { value: override(name) ?? globals.get(name) };
  };
  // The variables of the current stage; `null`: declared, but its value is not known here (a platform ARG).
  let stage = new Map<string, string | undefined | null>();
  const stageLookup: Lookup = (name) => {
    if (!stage.has(name)) return 'unresolved';
    const value = stage.get(name);
    return value === null ? 'unresolved' : { value };
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
  const add = (reference: string, kind: ImageReferenceKind): void => {
    const text = reference.trim();
    const key = text.toLowerCase();
    const isStage = kind === 'FROM' ? earlier.has(key) : stages.has(key);
    if (text === '' || key === 'scratch' || isStage || (kind !== 'FROM' && /^\d+$/.test(text)) || seen.has(`${kind} ${text}`)) return;
    seen.add(`${kind} ${text}`);
    result.push({ reference: text, kind });
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
        if (!ARG_NAME.test(name)) continue;
        if (!fromSeen) {
          const defaultValue = equals < 0 ? undefined : expand(word.slice(equals + 1), globalLookup, escape);
          globals.set(name, override(name) ?? defaultValue);
          continue;
        }
        const defaultValue = equals < 0 ? undefined : expand(word.slice(equals + 1), stageLookup, escape);
        if (override(name) !== undefined) stage.set(name, override(name));
        else if (defaultValue !== undefined) stage.set(name, defaultValue);
        else if (PLATFORM_ARGS.has(name)) stage.set(name, null);
        else stage.set(name, globals.get(name));
      }
      continue;
    }
    if (instruction.keyword === 'FROM') {
      if (targetDone) break;
      fromSeen = true;
      stage = new Map();
      const words = instruction.args.split(/\s+/).filter((word) => word !== '');
      while (words.length > 0 && words[0].startsWith('--')) words.shift();
      if (words.length === 0) continue;
      add(expand(words[0], globalLookup, escape), 'FROM');
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
        stage.set(words[0], expand(words.slice(1).join(' '), stageLookup, escape));
      } else {
        for (const word of words) {
          const equals = word.indexOf('=');
          if (equals > 0) stage.set(word.slice(0, equals), expand(word.slice(equals + 1), stageLookup, escape));
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
      if (instruction.keyword === 'COPY' && flag === '--from') add(expand(value, stageLookup, escape), 'COPY --from');
      if (instruction.keyword === 'RUN' && flag === '--mount') {
        for (const field of csvFields(value)) {
          const index = field.indexOf('=');
          if (index > 0 && field.slice(0, index).trim().toLowerCase() === 'from') add(expand(field.slice(index + 1), stageLookup, escape), 'RUN --mount from');
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

/** Splits the text into instructions: directives, comments, continuation lines, and heredoc bodies are handled here. */
function parseInstructions(text: string): { escape: string; syntax?: string; instructions: Instruction[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\r|\n/);
  let escape = '\\';
  let syntax: string | undefined;
  let index = 0;

  // Parser directives are only recognized at the very top of the file.
  for (; index < lines.length; index++) {
    const match = /^\s*#\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+?)\s*$/.exec(lines[index]);
    if (!match || !KNOWN_DIRECTIVES.has(match[1].toLowerCase())) break;
    if (match[1].toLowerCase() === 'escape' && (match[2] === '`' || match[2] === '\\')) escape = match[2];
    if (match[1].toLowerCase() === 'syntax' && syntax === undefined) syntax = match[2];
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
