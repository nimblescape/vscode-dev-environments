// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Parser for JSON with comments and trailing commas, the format of devcontainer.json.

/** Removes comments and trailing commas outside of strings. */
export function stripJsonc(text: string): string {
  let result = '';
  let i = 0;
  const length = text.length;
  while (i < length) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      i++;
      while (i < length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      result += text.slice(start, i);
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < length && text[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (char === ',') {
      let j = i + 1;
      // Look ahead over whitespace and comments for a closing bracket.
      for (;;) {
        while (j < length && /\s/.test(text[j])) j++;
        if (text[j] === '/' && text[j + 1] === '/') {
          while (j < length && text[j] !== '\n') j++;
          continue;
        }
        if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < length && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    result += char;
    i++;
  }
  return result;
}

/** Parses JSON with comments. Throws a `SyntaxError` for invalid input. */
export function parseJsonc<T = unknown>(text: string): T {
  // Remove a byte order mark.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(stripJsonc(source)) as T;
}
