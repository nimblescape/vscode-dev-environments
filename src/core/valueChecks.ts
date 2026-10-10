// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR #142, B7): the checks of the shape of a value that is not trusted (JSON of a file, of the
// worker, of the engine, of a webview), one definition each; before, about 30 modules had a copy of their own. No import,
// so that each bundle that takes it takes only this module.

/** An object that is not null and not an array (a JSON object). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` has all `required` keys and no key beyond them and `optional`. */
export function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key));
}

/** True when the own keys of `value` are exactly `keys` (none missing, none more). */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
