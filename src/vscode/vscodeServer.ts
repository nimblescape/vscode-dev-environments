// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): the VS Code server of this window, which an
// open sends to the worker (OpenParams.vscodeServer): the commit and the quality of `product.json` under
// `vscode.env.appRoot`, read once. Only a build of the Microsoft update service qualifies (its `updateUrl` exactly
// MICROSOFT_UPDATE_URL, the quality `stable` or `insider`, a commit of 40 lower-case hexadecimal characters); any other
// build (VSCodium, a build of the sources, a product.json that cannot be read) sends none, and its open runs as before.
// The URL itself is never sent: the worker has the host of the download fixed.
import * as path from 'path';
import { parseVscodeServerRef, type VscodeServerRef } from '../core/helperChannel/protocol';
import { defaultExtensionsOf, extensionEntryText } from '../core/vscodeExtensions';

/** Plan step 11H1: the update service of the builds of Microsoft, the only `updateUrl` whose server the worker fetches. */
export const MICROSOFT_UPDATE_URL = 'https://update.code.visualstudio.com';

/** Plan step 11H1: the VscodeServerRef of the content of `product.json`, or `undefined` when the build does not qualify. */
export function vscodeServerOf(product: unknown): VscodeServerRef | undefined {
  if (typeof product !== 'object' || product === null || Array.isArray(product)) return undefined;
  const { commit, quality, updateUrl } = product as { commit?: unknown; quality?: unknown; updateUrl?: unknown };
  if (updateUrl !== MICROSOFT_UPDATE_URL) return undefined;
  return parseVscodeServerRef({ commit, quality });
}

/**
 * Plan step 11H1: the VscodeServerRef of this window, from `<appRoot>/product.json` (read once, by the first caller); a
 * file that cannot be read or parsed gives none (logged once by `onError`).
 */
export function windowVscodeServer(appRoot: string, readFile: (file: string) => Promise<string>, onError: (message: string) => void): () => Promise<VscodeServerRef | undefined> {
  let read: Promise<VscodeServerRef | undefined> | undefined;
  return () =>
    (read ??= (async () => {
      const file = path.join(appRoot, 'product.json');
      try {
        return vscodeServerOf(JSON.parse(await readFile(file)));
      } catch (error) {
        onError(`The product.json of VS Code (${file}) could not be read, so the opens run without the shared VS Code server: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    })());
}

/**
 * Plan step 11H3 (decision of 2026-10-09; live check 3): the user's `dev.containers.defaultExtensions` (the value of the
 * setting of the Dev Containers extension) as the entries that an open carries (OpenParams.defaultExtensions): the valid
 * ones (`publisher.name` or `publisher.name@x.y.z`), the ID in lower case, each ID once, at most MAX_LISTED_EXTENSIONS
 * (defaultExtensionsOf); the others are left out, with one line through `onDropped`.
 */
export function defaultExtensionEntries(value: unknown, onDropped: (message: string) => void): string[] {
  const { list, dropped } = defaultExtensionsOf(value);
  if (dropped > 0) {
    onDropped(`${dropped} value(s) of dev.containers.defaultExtensions are no extension ID (publisher.name, optionally @x.y.z), are named twice or are too many; the shared extension cache leaves them out.`);
  }
  return list.map(extensionEntryText);
}
