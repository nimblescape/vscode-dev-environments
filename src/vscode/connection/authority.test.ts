// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  ATTACHED_CONTAINER,
  containerNameOfUri,
  decodeAuthority,
  encodeAuthority,
  folderUriParts,
  folderUriString,
  REMOTE_SCHEME,
} from './authority';

const NAME = 'devenv-acme-university-api-3f2a9c1e';
// hex of {"containerName":"/devenv-acme-university-api-3f2a9c1e"}, as Dev Containers 0.470.0 builds it.
const HEX =
  '7b22636f6e7461696e65724e616d65223a222f646576656e762d61636d652d756e69766572736974792d6170692d3366326139633165227d';

function hexOf(text: string): string {
  return Buffer.from(text, 'utf8').toString('hex');
}

describe('encodeAuthority', () => {
  it('builds the attached-container authority with the JSON of the container name and a leading slash', () => {
    expect(encodeAuthority(NAME)).toBe(`attached-container+${HEX}`);
  });

  it('does not double a leading slash', () => {
    expect(encodeAuthority(`/${NAME}`)).toBe(`attached-container+${HEX}`);
  });

  it('uses lower-case hex digits only', () => {
    expect(encodeAuthority(NAME).slice('attached-container+'.length)).toMatch(/^[0-9a-f]+$/);
  });

  it('rejects an empty name', () => {
    expect(() => encodeAuthority('')).toThrow();
    expect(() => encodeAuthority('/')).toThrow();
  });
});

describe('decodeAuthority', () => {
  it('returns the container name without the leading slash', () => {
    expect(decodeAuthority(`attached-container+${HEX}`)).toBe(NAME);
  });

  it('round-trips encodeAuthority', () => {
    for (const name of ['a', 'devenv-o-r-12345678', 'x.y_z-1', 'ünïcode-name']) {
      expect(decodeAuthority(encodeAuthority(name))).toBe(name);
    }
  });

  it('tolerates an @<parent authority> suffix', () => {
    expect(decodeAuthority(`attached-container+${HEX}@wsl+Ubuntu`)).toBe(NAME);
    expect(decodeAuthority(`attached-container+${HEX}@ssh-remote+my-host`)).toBe(NAME);
  });

  it('accepts upper-case hex digits and a percent-encoded authority', () => {
    expect(decodeAuthority(`attached-container+${HEX.toUpperCase()}`)).toBe(NAME);
    expect(decodeAuthority(`attached-container%2B${HEX}`)).toBe(NAME);
  });

  it('ignores additional JSON fields', () => {
    const json = JSON.stringify({ containerName: `/${NAME}`, settings: { context: 'desktop-linux' }, cwd: '/x' });
    expect(decodeAuthority(`attached-container+${hexOf(json)}`)).toBe(NAME);
  });

  it('accepts the older form with the plain container name', () => {
    expect(decodeAuthority(`attached-container+${hexOf(NAME)}`)).toBe(NAME);
    expect(decodeAuthority(`attached-container+${hexOf(`/${NAME}`)}`)).toBe(NAME);
  });

  it('returns undefined for other remote authorities', () => {
    expect(decodeAuthority(`dev-container+${HEX}`)).toBeUndefined();
    expect(decodeAuthority('ssh-remote+my-host')).toBeUndefined();
    expect(decodeAuthority('wsl+Ubuntu')).toBeUndefined();
    expect(decodeAuthority('codespaces+abc')).toBeUndefined();
    expect(decodeAuthority('')).toBeUndefined();
    expect(decodeAuthority(ATTACHED_CONTAINER)).toBeUndefined();
  });

  it('returns undefined for invalid hex', () => {
    expect(decodeAuthority('attached-container+')).toBeUndefined();
    expect(decodeAuthority(`attached-container+${HEX.slice(0, -1)}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${HEX}zz`)).toBeUndefined();
    expect(decodeAuthority('attached-container+@wsl+Ubuntu')).toBeUndefined();
    expect(decodeAuthority('attached-container%ZZ')).toBeUndefined();
  });

  it('returns undefined for JSON without a usable container name', () => {
    expect(decodeAuthority(`attached-container+${hexOf('{"containerName":""}')}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${hexOf('{"containerName":"/"}')}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${hexOf('{"containerName":42}')}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${hexOf('{"hostPath":"/x"}')}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${hexOf('["/x"]')}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${hexOf('null')}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${hexOf('"/x"')}`)).toBeUndefined();
  });

  it('returns undefined for text that is neither JSON nor a container name', () => {
    expect(decodeAuthority(`attached-container+${hexOf('{broken')}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${hexOf('name with spaces')}`)).toBeUndefined();
    expect(decodeAuthority(`attached-container+${hexOf('-leading-dash')}`)).toBeUndefined();
  });
});

describe('folder URI', () => {
  it('builds vscode-remote://<authority><folder>', () => {
    expect(folderUriString(NAME, '/workspaces/api')).toBe(`vscode-remote://attached-container+${HEX}/workspaces/api`);
  });

  it('adds a missing leading slash to the folder', () => {
    expect(folderUriString(NAME, 'workspaces/api')).toBe(`vscode-remote://attached-container+${HEX}/workspaces/api`);
    expect(folderUriParts(NAME, '').path).toBe('/');
  });

  it('percent-encodes characters that would end the path of the URI string', () => {
    expect(folderUriString(NAME, '/workspaces/my repo#1?')).toBe(
      `vscode-remote://attached-container+${HEX}/workspaces/my%20repo%231%3F`,
    );
  });

  it('gives the unencoded parts for vscode.Uri.from', () => {
    expect(folderUriParts(NAME, '/workspaces/my repo')).toEqual({
      scheme: REMOTE_SCHEME,
      authority: `attached-container+${HEX}`,
      path: '/workspaces/my repo',
    });
  });

  it('finds the container name of a folder URI and ignores other URIs', () => {
    expect(containerNameOfUri({ scheme: 'vscode-remote', authority: `attached-container+${HEX}` })).toBe(NAME);
    expect(containerNameOfUri({ scheme: 'file', authority: `attached-container+${HEX}` })).toBeUndefined();
    expect(containerNameOfUri({ scheme: 'vscode-remote', authority: 'ssh-remote+host' })).toBeUndefined();
  });

  it('parses back with the WHATWG URL parser to the same authority and path', () => {
    const url = new URL(folderUriString(NAME, '/workspaces/my repo'));
    expect(url.protocol).toBe('vscode-remote:');
    expect(decodeAuthority(url.host)).toBe(NAME);
    expect(decodeURIComponent(url.pathname)).toBe('/workspaces/my repo');
  });
});
