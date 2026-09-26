// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Setting `devEnvLauncher.repositoryGroups` (concept 6.2, 8): regular expressions that filter the repository names of the
// sidebar and group them in levels. This module never imports `vscode`; it reads the raw entries of the setting, compiles
// them, and splits a repository name into its levels.

/** Flags that an entry may give; every other flag is ignored with a warning (`g` and `y` would make matching stateful). */
const ALLOWED_FLAGS = 'ius';

/** One valid entry of the setting, compiled. */
export interface RepositoryGroupPattern {
  /** Position of the entry in the setting (also for invalid entries before it); part of the tree item IDs. */
  index: number;
  /**
   * The `name` of the entry (trimmed, not empty): the label of the root node of the entry. Without a name, the entry has
   * no root node: its top level sits directly under the owner.
   */
  name?: string;
  /** The pattern text as the user wrote it. */
  source: string;
  regex: RegExp;
}

/** A problem with one entry of the setting; the sidebar shows each distinct message once per session. */
export interface RepositoryGroupProblem {
  index: number;
  /** Plain-language text that names the entry and the problem. */
  message: string;
}

export interface ParsedRepositoryGroups {
  patterns: RepositoryGroupPattern[];
  problems: RepositoryGroupProblem[];
}

// User-visible texts that messages.ts lacks; to be moved there.
export const RepositoryGroupTexts = {
  wrongType: (entry: string) =>
    `The repository group ${entry} in the setting devEnvLauncher.repositoryGroups is ignored: an entry must be a regular expression, or an object with "pattern" and optional "name" and "flags" texts.`,
  empty: (entry: string) =>
    `The repository group ${entry} in the setting devEnvLauncher.repositoryGroups is ignored: its regular expression is empty.`,
  invalid: (entry: string, error: string) =>
    `The repository group ${entry} in the setting devEnvLauncher.repositoryGroups is ignored: its regular expression is not valid (${error}).`,
  ignoredFlags: (entry: string, flags: string) =>
    `The repository group ${entry} in the setting devEnvLauncher.repositoryGroups uses the flags "${flags}", which are ignored. Only the flags i, u, and s are allowed.`,
  slow: (milliseconds: number) =>
    `Grouping the repositories took ${milliseconds} ms. A regular expression in the setting devEnvLauncher.repositoryGroups may be slow, for example one with a nested repetition such as (a+)+. If VS Code stops responding, remove that entry from your settings.json.`,
} as const;

/**
 * Reads the entries of the setting. An entry is a string (the pattern) or an object `{ name?, pattern, flags? }`. Entries
 * of the wrong type, with an empty pattern, or whose regular expression is not valid are left out with a problem; flags
 * other than `i`, `u`, and `s` are left out with a problem, and the entry is used without them.
 */
export function parseRepositoryGroups(entries: readonly unknown[] | undefined): ParsedRepositoryGroups {
  const patterns: RepositoryGroupPattern[] = [];
  const problems: RepositoryGroupProblem[] = [];
  (entries ?? []).forEach((entry, index) => {
    const checked = checkRepositoryGroupEntry(entry, index);
    for (const { message } of checked.issues) problems.push({ index, message });
    if (checked.pattern) patterns.push(checked.pattern);
  });
  return { patterns, problems };
}

/** A problem of one entry, with its kind, for the editor of the setting (repositoryGroupsEditorModel.ts). */
export interface RepositoryGroupIssue {
  /** `wrongType`, `empty`, and `invalid` leave the entry out; `ignoredFlags` keeps it without those flags. */
  kind: 'wrongType' | 'empty' | 'invalid' | 'ignoredFlags';
  /** `invalid`: the error of the regular expression; `ignoredFlags`: the ignored flags. */
  detail?: string;
  /** The text of RepositoryGroupTexts that parseRepositoryGroups reports. */
  message: string;
}

/**
 * Checks and compiles one entry of the setting, at position `index`: the rules of parseRepositoryGroups, which uses it
 * for each entry. `pattern` is missing when the entry is left out.
 */
export function checkRepositoryGroupEntry(
  entry: unknown,
  index: number,
): { pattern?: RepositoryGroupPattern; issues: RepositoryGroupIssue[] } {
  const shown = describeEntry(entry);
  const fields = entryFields(entry);
  if (!fields) return { issues: [{ kind: 'wrongType', message: RepositoryGroupTexts.wrongType(shown) }] };
  if (fields.pattern === '') return { issues: [{ kind: 'empty', message: RepositoryGroupTexts.empty(shown) }] };
  let flags = '';
  let ignored = '';
  for (const flag of fields.flags) {
    if (ALLOWED_FLAGS.includes(flag)) {
      if (!flags.includes(flag)) flags += flag;
    } else if (!ignored.includes(flag)) {
      ignored += flag;
    }
  }
  let regex: RegExp;
  try {
    regex = new RegExp(fields.pattern, flags);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { issues: [{ kind: 'invalid', detail, message: RepositoryGroupTexts.invalid(shown, detail) }] };
  }
  const issues: RepositoryGroupIssue[] =
    ignored !== '' ? [{ kind: 'ignoredFlags', detail: ignored, message: RepositoryGroupTexts.ignoredFlags(shown, ignored) }] : [];
  const name = fields.name?.trim();
  return { pattern: { index, ...(name ? { name } : {}), source: fields.pattern, regex }, issues };
}

/** Place of a repository in the groups: the pattern that matched, the group levels, and the label of the row. */
export interface RepositoryGroupMatch {
  pattern: RepositoryGroupPattern;
  /** Values of the group levels, from the top level down; empty when the row sits directly under the root. */
  levels: string[];
  /** Label of the row: the last capturing group, or the repository name. */
  label: string;
}

/**
 * The first pattern that matches the repository name (without owner), or `undefined`. With n ≥ 1 capturing groups,
 * groups 1..n-1 are the levels and group n is the label; with none, the row has no level and keeps its name. A group
 * that did not take part or is empty is skipped (the row moves up one level); an empty last group gives the name.
 */
export function matchRepositoryGroup(
  patterns: readonly RepositoryGroupPattern[],
  name: string,
): RepositoryGroupMatch | undefined {
  for (const pattern of patterns) {
    const match = pattern.regex.exec(name);
    if (!match) continue;
    const groups = match.slice(1);
    const last = groups.pop();
    const levels = groups.filter((value): value is string => value !== undefined && value !== '');
    return { pattern, levels, label: last !== undefined && last !== '' ? last : name };
  }
  return undefined;
}

function entryFields(entry: unknown): { name?: string; pattern: string; flags: string } | undefined {
  if (typeof entry === 'string') return { pattern: entry, flags: '' };
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const { name, pattern, flags } = entry as Record<string, unknown>;
  if (typeof pattern !== 'string') return undefined;
  if (name !== undefined && typeof name !== 'string') return undefined;
  if (flags !== undefined && typeof flags !== 'string') return undefined;
  return { name, pattern, flags: flags ?? '' };
}

/** The entry as the message names it: a string in quotes, anything else as JSON. */
function describeEntry(entry: unknown): string {
  if (typeof entry === 'string') return JSON.stringify(entry);
  try {
    return JSON.stringify(entry) ?? String(entry);
  } catch {
    return String(entry);
  }
}
