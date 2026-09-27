// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 15 (K1 = S15-1, K2 = S15-2): in a Docker Compose configuration, the Dev Container CLI does not give the
// `mounts` of devcontainer.json, the Features, and the image metadata to `docker run --mount`: it reads a text with its
// own parser and writes each mount as a short-syntax entry `<source>:<target>` into the compose file that it generates
// (the type is dropped, nothing is quoted or escaped). The policy checks that reading too (HostAccessInput.composeMounts).
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_FOLDER } from '../names';
import { hostAccessReport, type HostAccessInput } from './hostAccess';

const OWN = 'devenv-api-12345678';

// A copy of the functions `lQ` (with its table `cj`) and `nW` of the Dev Container CLI 0.89.0
// (node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js): how the CLI reads a `mounts` text for Docker
// Compose, and the text that it writes for a mount into the `volumes` of the dev service of its generated compose file.
const CLI_LQ = 'function lQ(e){return e.split(",").map(A=>A.split("=")).reduce((A,[t,i])=>({...A,[cj[t]||t]:i}),{})}';
const CLI_NW = 'function nW(e){let A="";return e.source&&(A=`${e.source}:`),A+=e.target,A}';
const cj: Record<string, string> = { src: 'source', destination: 'target', dst: 'target' };
function lQ(e: string): Record<string, string | undefined> {
  return e
    .split(',')
    .map((A) => A.split('='))
    .reduce((A, [t, i]) => ({ ...A, [cj[t] || t]: i }), {});
}
function nW(e: Record<string, unknown>): string {
  let A = '';
  if (e.source) A = `${String(e.source)}:`;
  A += String(e.target);
  return A;
}

/** The report of a Compose configuration whose `mounts` (in `where`) hold `mount`, with the checks on or off. */
function report(where: 'metadata' | 'config' | 'merged', mount: unknown, checksOn = true) {
  const input: HostAccessInput =
    where === 'metadata'
      ? { ownVolume: OWN, metadata: [{ mounts: [mount] }], composeMounts: true }
      : { ownVolume: OWN, [where]: { mounts: [mount] }, composeMounts: true };
  return hostAccessReport(input, checksOn);
}

function refused(where: 'metadata' | 'config' | 'merged', mount: unknown, checksOn = true): boolean {
  const r = report(where, mount, checksOn);
  return r.hostAccess.length + r.unsupported.length > 0;
}

/** The probe vectors of findings-r15.md and verdicts-r15.md. */
const VECTORS: unknown[] = [
  { type: 'tmpfs', source: '/var/run/docker.sock', target: '/var/run/docker.sock' },
  { type: 'tmpfs', source: '/', target: '/host' },
  'type=tmpfs,src=/,dst=/host',
  'src=/,SRC=foo,dst=/host',
  'src=/var/run/docker.sock, src=foo,dst=/var/run/docker.sock',
  { type: 'volume', target: '/:/host' },
  'type=volume,dst=/var/run/docker.sock:/var/run/docker.sock',
  'type=tmpfs,dst=/var/run/docker.sock:/var/run/docker.sock',
  'type=volume,src=$HOME,dst=/h',
  'type=volume,src=${HOME},dst=/h',
  { type: 'tmpfs', source: '${HOME}', target: '/h' },
  // K2
  'type=volume,src=foo,dst=/workspaces/.devenv+=x',
  'type=volume,src=foo,dst=/workspaces/.devenv+/gh,Dst=/workspaces/api/x',
  { type: 'volume', source: 'foo', target: '/workspaces/.devenv+ #x' },
  'type=volume,src=foo,dst=/workspaces/.devenv+ #x',
];

describe('review round 15 (K1, K2): Compose `mounts` as the Dev Container CLI writes them', () => {
  for (const where of ['metadata', 'config', 'merged'] as const) {
    for (const mount of VECTORS) {
      it(`refuses ${JSON.stringify(mount)} in ${where}, with the checks on and off`, () => {
        expect(refused(where, mount, true)).toBe(true);
        // Whatever the switch says: what the CLI writes differs from what the policy read (unsupported).
        expect(report(where, mount, false).unsupported.length).toBeGreaterThan(0);
      });
    }
  }

  it('names the mount in a plain refusal text', () => {
    expect(report('metadata', 'type=tmpfs,src=/,dst=/host').unsupported).toContain(
      'mount "type=tmpfs,src=/,dst=/host" is written differently by the Dev Container CLI and is not supported',
    );
  });

  it('refuses each rule of the round trip', () => {
    const cases: unknown[] = [
      // `=` in a value, a key without a value, a key twice
      'type=volume,src=foo,dst=/a=b',
      'type=volume,src,dst=/a',
      'type=volume,src=foo,source=bar,dst=/a',
      'type=volume,source=foo,src=foo,dst=/a',
      // variants of the keys that the CLI does not map
      'type=volume,Source=foo,dst=/a',
      'type=volume,src=foo,TARGET=/a',
      'Type=volume,src=foo,dst=/a',
      'type=volume, source=foo,dst=/a',
      'type=volume,source =foo,dst=/a',
      // a type that the CLI keeps as written
      'type=Volume,src=foo,dst=/a',
      { type: 'VOLUME', source: 'foo', target: '/a' },
      // spaces, quotes, YAML indicators, `#`, `:`
      'type=volume,src=foo,dst=/a b',
      'type=volume,src= foo,dst=/a',
      'type=volume,"src=foo",dst=/a',
      "type=volume,src=foo,dst=/a'b",
      'type=volume,src=foo,dst=/a`b',
      'type=volume,src=&foo,dst=/a',
      'type=volume,src=*foo,dst=/a',
      'type=volume,src=!foo,dst=/a',
      'type=volume,src=foo,dst=/a#b',
      'type=volume,src=foo,dst=/a:ro',
      { type: 'volume', source: 'a:b', target: '/a' },
      { type: 'volume', source: 'foo', target: '/a\nb' },
      { type: 'volume', source: '|foo', target: '/a' },
      // `$` (Compose interpolates the generated file)
      'type=volume,src=foo,dst=/a$b',
      { type: 'volume', source: 'foo$$', target: '/a' },
      // a source of another type than volume, a name with another type than volume, no or a relative target
      { type: 'tmpfs', source: 'foo', target: '/a' },
      { type: 'bind', source: 'foo', target: '/a' },
      'src=foo,dst=/a',
      { type: 'volume', source: 'foo' },
      { type: 'volume', source: 'foo', target: '' },
      { type: 'volume', source: 'foo', target: 'a' },
      { type: 'volume', source: 5, target: '/a' },
      { type: 1, source: 'foo', target: '/a' },
    ];
    // Refused whatever the switch says (a line break already by the reading of Docker, as not clear).
    for (const mount of cases) expect(refused('config', mount, false), JSON.stringify(mount)).toBe(true);
  });

  it('refuses a named volume at the internal folder or at /workspaces by the target that the CLI writes', () => {
    expect(report('metadata', { type: 'volume', source: 'foo', target: `${CONFIG_FOLDER}/gh` }, false).unsupported).toEqual([
      `mount at ${CONFIG_FOLDER}/gh (mounts into the extension's internal folder are not supported)`,
    ]);
    expect(report('metadata', 'type=volume,src=foo,dst=/workspaces', false).unsupported).toEqual(['mount at /workspaces']);
    expect(report('metadata', 'type=volume,dst=/workspaces/', false).unsupported).toEqual(['mount at /workspaces']);
  });

  it('refuses a path source as a bind mount (access to the computer, lifted with the checks off)', () => {
    expect(report('config', 'type=bind,source=/home/me/x,target=/x').hostAccess).toEqual(['bind mount /home/me/x']);
    expect(report('config', 'type=bind,source=/home/me/x,target=/x', false)).toEqual({ hostAccess: [], unsupported: [] });
    expect(report('config', { source: './x', target: '/x' }).hostAccess).toEqual(['bind mount ./x']);
  });

  it('applies the rules of volume names to the source that the CLI writes', () => {
    expect(report('metadata', 'type=volume,src=devenv-other-87654321,dst=/data', false).hostAccess).toEqual([
      'volume devenv-other-87654321 of another environment',
    ]);
    expect(report('metadata', 'type=volume,src=vscode,dst=/data').hostAccess).toEqual(['volume vscode of the Dev Containers extension']);
  });

  it('still allows the usual mounts', () => {
    const allowed: unknown[] = [
      // `source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume`
      // after the CLI resolved its variables
      'source=api-node_modules,target=/workspaces/api/node_modules,type=volume',
      'source=cache,target=/cache,type=volume',
      'type=volume,src=cache,dst=/cache',
      'type=volume,source=cache,destination=/cache',
      // docker-in-docker (the CLI resolves ${devcontainerId} before it writes the compose file)
      { source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' },
      // shell history volumes of Features
      { source: '${devcontainerId}-shellhistory', target: '/commandhistory', type: 'volume' },
      'source=${devcontainerId}-bashhistory,target=/commandhistory,type=volume',
      // anonymous volumes and tmpfs without a source (the CLI writes an anonymous volume)
      { type: 'volume', target: '/var/cache/x' },
      'type=tmpfs,destination=/tmp/x',
      // the workspace volume, and other options that the CLI does not write
      `type=volume,source=${OWN},target=/w2`,
      'type=volume,source=cache,target=/cache,readonly',
    ];
    for (const where of ['metadata', 'config', 'merged'] as const) {
      for (const mount of allowed) expect(report(where, mount), `${where} ${JSON.stringify(mount)}`).toEqual({ hostAccess: [], unsupported: [] });
    }
  });

  it('leaves single containers alone: --mount reads the text itself', () => {
    const r = hostAccessReport({ ownVolume: OWN, metadata: [{ mounts: ['type=tmpfs,src=/x,dst=/y', { type: 'volume', target: '/a:b' }] }] });
    expect(r).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('guard: the copy of lQ and nW is the code of the vendored CLI', () => {
    const cli = readFileSync(require.resolve('@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js'), 'utf8');
    expect(cli).toContain(CLI_LQ);
    expect(cli).toContain(CLI_NW);
    expect(cli).toContain('cj={src:"source",destination:"target",dst:"target"}');
  });

  it('guard: whatever the CLI writes as a bind, or at the internal folder, is refused', () => {
    const vectors: unknown[] = [
      ...VECTORS,
      'type=volume,src=foo,dst=/workspaces/.devenv+',
      'type=tmpfs,src=/etc,dst=/etc2',
      'src=/,dst=/host,type=tmpfs',
      { type: 'npipe', source: '/var/run/docker.sock', target: '/s' },
      { type: 'image', source: '/x', target: '/s' },
    ];
    for (const mount of vectors) {
      const read = typeof mount === 'string' ? lQ(mount) : (mount as Record<string, unknown>);
      const text = nW(read);
      const colon = text.indexOf(':');
      const source = colon < 0 ? '' : text.slice(0, colon);
      const target = colon < 0 ? text : text.slice(colon + 1);
      const bind = /^[/.~$]/.test(source) || source.includes('$') || target.includes(':');
      const internal = target.startsWith(CONFIG_FOLDER);
      if (!bind && !internal) continue;
      for (const where of ['metadata', 'config'] as const) {
        expect(refused(where, mount, true), `${where} ${JSON.stringify(mount)} → ${text}`).toBe(true);
      }
    }
  });
});
