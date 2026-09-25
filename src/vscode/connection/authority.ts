// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The folder URI format of the Dev Containers extension for attached containers (concept 7.8, implementation notes 11).
// This module is the only place that knows the format (NFR-06, RK-1). It does not import `vscode`, so it is unit-tested.
//
// Assumption (V-2): Dev Containers 0.470.0 builds the authority as `attached-container+` followed by the hexadecimal
// encoding of the UTF-8 text of JSON.stringify({ containerName: '/<name>' }) (fields that are undefined are left out),
// optionally followed by `@<authority of a parent remote>`. It attaches to a container of this name, and the path of the
// URI is the folder inside the container.

/** Remote name of attached containers: `vscode.env.remoteName`, and the part of the authority before `+`. */
export const ATTACHED_CONTAINER = 'attached-container';
/** URI scheme of remote folders. */
export const REMOTE_SCHEME = 'vscode-remote';

const AUTHORITY_PREFIX = `${ATTACHED_CONTAINER}+`;
const HEX_PATTERN = /^(?:[0-9a-f]{2})+$/i;
/** Container names that Docker accepts (`[a-zA-Z0-9][a-zA-Z0-9_.-]+`), with the optional leading `/` of `docker inspect`. */
const CONTAINER_NAME_PATTERN = /^\/?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Container name without the leading `/` of `docker inspect`. */
function withoutLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/**
 * Authority for the container `containerName` (with or without a leading `/`):
 * `attached-container+` + hex(JSON.stringify({ containerName: '/' + name })). Throws for an empty name.
 */
export function encodeAuthority(containerName: string): string {
  const name = withoutLeadingSlash(containerName.trim());
  if (!name) throw new Error('The container name is empty.');
  const json = JSON.stringify({ containerName: `/${name}` });
  return `${AUTHORITY_PREFIX}${Buffer.from(json, 'utf8').toString('hex')}`;
}

/**
 * Container name (without the leading `/`) of an `attached-container+…` authority. Tolerates an `@<parent>` suffix, a
 * percent-encoded authority, upper-case hex digits, and additional JSON fields. Returns `undefined` for other authorities
 * and for invalid hex or JSON.
 *
 * Also accepts the older form whose hex part encodes the plain container name instead of JSON (it is still used in
 * `code --folder-uri` examples), as long as the text is a valid container name.
 */
export function decodeAuthority(authority: string): string | undefined {
  let text = authority;
  if (text.includes('%')) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return undefined;
    }
  }
  if (text.slice(0, AUTHORITY_PREFIX.length).toLowerCase() !== AUTHORITY_PREFIX) return undefined;
  let hex = text.slice(AUTHORITY_PREFIX.length);
  const at = hex.indexOf('@');
  if (at >= 0) hex = hex.slice(0, at);
  if (!HEX_PATTERN.test(hex)) return undefined;

  const decoded = Buffer.from(hex, 'hex').toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return CONTAINER_NAME_PATTERN.test(decoded) ? withoutLeadingSlash(decoded) : undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const containerName = (value as Record<string, unknown>).containerName;
  if (typeof containerName !== 'string') return undefined;
  const name = withoutLeadingSlash(containerName);
  return name ? name : undefined;
}

/** The folder inside the container as a URI path: POSIX, with a leading `/`. */
function normalizeFolder(remoteWorkspaceFolder: string): string {
  const folder = remoteWorkspaceFolder.trim();
  return folder.startsWith('/') ? folder : `/${folder}`;
}

/** Parts of the folder URI, for `vscode.Uri.from` (no string parsing, so no character of the path needs encoding). */
export function folderUriParts(
  containerName: string,
  remoteWorkspaceFolder: string,
): { scheme: string; authority: string; path: string } {
  return {
    scheme: REMOTE_SCHEME,
    authority: encodeAuthority(containerName),
    path: normalizeFolder(remoteWorkspaceFolder),
  };
}

/** `vscode-remote://attached-container+<hex><folder>`. Path segments are percent-encoded where needed. */
export function folderUriString(containerName: string, remoteWorkspaceFolder: string): string {
  const parts = folderUriParts(containerName, remoteWorkspaceFolder);
  const encodedPath = parts.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${parts.scheme}://${parts.authority}${encodedPath}`;
}

/**
 * Container name of a folder or workspace URI of an attached container window, or `undefined` for any other URI
 * (a local folder, another remote type).
 */
export function containerNameOfUri(uri: { scheme: string; authority: string }): string | undefined {
  if (uri.scheme !== REMOTE_SCHEME) return undefined;
  return decodeAuthority(uri.authority);
}
