// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The report of the container policy (./index.ts): the refused items of a check in two lists, the class of each item
// for the per-repository switch (./hostAccessChecks.ts), and the limits of a listed item. Pure functions, no I/O.


/**
 * The items of hostAccessProblems in two lists, each in order and without duplicates: `hostAccess`, settings that need
 * access to the computer (a rule of the policy refuses them), and `unsupported`, settings that the policy does not know
 * (unknown flags of `runArgs` and options of `build.options`, arguments that are no flag, and entries that are no text),
 * which it refuses because it cannot tell what they do, and values of known flags that Dev Environments does not
 * support because they work against how it runs the container (for example `--restart always`).
 */
export interface HostAccessReport {
  hostAccess: string[];
  unsupported: string[];
}

/**
 * The class of a refused item, for the switch of the host access checks (concept section 9 "Host access"):
 * - `computer`: access to the computer (its files, the Docker socket, privileges, devices, namespaces, ports on other
 *   addresses than localhost, volumes of other programs). Refused while the checks are on, allowed while they are off.
 * - `protected`: refused whatever the switch says: account separation (volumes of other environments and accounts, the
 *   cache volume of the workspace helper), the identity of the owner account (variables of container-only Git and of
 *   the GitHub CLI), the integrity of the extension (`initializeCommand`, which would run in the workspace helper next to
 *   the Docker socket), and items whose class is not clear. Reported as access to the computer (Messages.hostAccess).
 * - `unsupported`: options that the policy does not know or does not support (Messages.unsupportedOptions); refused
 *   whatever the switch says.
 */
export type HostAccessClass = 'computer' | 'protected' | 'unsupported';

/** A refused item with its class (hostAccessClassification). */
export interface HostAccessFinding {
  item: string;
  class: HostAccessClass;
}

/** A problem of the configuration: its text and its class. */
export interface Problem {
  item: string;
  class: HostAccessClass;
}

/** Access to the computer: lifted while the host access checks are off. */
export const access = (item: string): Problem => ({ item, class: 'computer' });
export const accessAll = (items: readonly string[]): Problem[] => items.map(access);
/** Refused as access to the computer whatever the switch says (HostAccessClass `protected`). */
export const guarded = (item: string): Problem => ({ item, class: 'protected' });
export const guardedAll = (items: readonly string[]): Problem[] => items.map(guarded);
export const unsupported = (item: string): Problem => ({ item, class: 'unsupported' });

/**
 * The most items that a list of a refusal names (hotfix review 2, P2): a configuration with thousands of refused
 * entries would otherwise make a message and a log line of megabytes. The rest is counted.
 */
export const MAX_LISTED_ITEMS = 20;

/**
 * The most characters of one listed item or expression (hotfix review 3, C3-2): an item quotes its entry, which may be
 * up to MAX_CLI_TEXT_LENGTH long, and the substitution of the CLI makes it longer. The middle is `…` (truncated).
 */
export const MAX_ITEM_LENGTH = 200;

/**
 * `text` with at most `max` characters: its start and its end, with `…` for the middle (never half of a surrogate
 * pair). The end stays because it says why an item is refused (for example `, which cannot be checked`).
 */
export function truncated(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 2);
  let headEnd = max - tail;
  let tailStart = text.length - tail;
  if (/[\uD800-\uDBFF]/.test(text.charAt(headEnd - 1))) headEnd--;
  if (/[\uDC00-\uDFFF]/.test(text.charAt(tailStart))) tailStart++;
  return `${text.slice(0, headEnd)}…${text.slice(tailStart)}`;
}

/**
 * `items`, of which at most MAX_LISTED_ITEMS, and then `and <n> more`; each at most MAX_ITEM_LENGTH characters. Called
 * after the items are without duplicates and the placeholder of an ID is named as the configuration writes it (add in
 * hostAccessFindings), so that both see the whole text.
 */
export function capped(items: readonly string[]): string[] {
  const listed = items.slice(0, MAX_LISTED_ITEMS).map((item) => truncated(item, MAX_ITEM_LENGTH));
  return items.length <= MAX_LISTED_ITEMS ? listed : [...listed, `and ${items.length - MAX_LISTED_ITEMS} more`];
}

/** True if the host access policy refuses something of `report`. */
export function isRefused(report: HostAccessReport): boolean {
  return report.hostAccess.length > 0 || report.unsupported.length > 0;
}

/** Both lists of a report, for the log. */
export function describeRefusal(report: HostAccessReport): string {
  return [
    report.hostAccess.length > 0 ? `access to the computer: ${report.hostAccess.join('; ')}` : undefined,
    report.unsupported.length > 0 ? `not supported: ${report.unsupported.join('; ')}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' / ');
}

/**
 * Adds `items` to the list `list` of `report` (in place), each unless the list has it: the items that the pipeline finds
 * outside of the analysis worker (the labels of an image, imageLabelItems; the image references that Docker resolves by
 * the ID of an image, imageIdItem). Returns `report`.
 */
export function addRefusedItems(report: HostAccessReport, list: keyof HostAccessReport, items: readonly string[]): HostAccessReport {
  for (const item of items) if (!report[list].includes(item)) report[list].push(item);
  return report;
}

/**
 * The report of a Docker Compose configuration (checkContainer `composeModel`) with the items of its image references
 * that Docker resolves by the ID of an image (`imageIds`, not supported) and of those that name an image of the
 * environments of another account (`protectedImages`, otherAccountImageItems; refused whatever the switch says). Review
 * round 17 (P17-3): each list at most MAX_LISTED_ITEMS, each item at most MAX_ITEM_LENGTH characters, after the merge
 * and without duplicates (a model with hundreds of services would otherwise make a message of megabytes).
 */
export function cappedReport(report: HostAccessReport, imageIds: readonly string[] = [], protectedImages: readonly string[] = []): HostAccessReport {
  return {
    hostAccess: capped([...new Set([...report.hostAccess, ...protectedImages])]),
    unsupported: capped([...new Set([...report.unsupported, ...imageIds])]),
  };
}
