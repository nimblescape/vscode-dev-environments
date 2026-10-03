// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 16 (L1 = D16-1 = S16-1): in a Docker Compose configuration, the Dev Container CLI 0.89.0 (function `iW`)
// writes values of the merged configuration into the compose file that it generates for the dev service as text,
// without escaping them: `user: <containerUser>`, the names of `containerEnv` inside `- '<name>=<value>'` (only the
// value is escaped), each `entrypoint` of the image metadata inside a double-quoted string, and each `capAdd` and
// `securityOpt` as `- <value>`. The policy refuses, for Compose, in the configuration, the merged configuration, and each
// entry of the image metadata, whatever the switch says, every value that could change what Compose reads.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import { resourceName } from '../names';
import { containerEnvironment } from './containerGit';
import { hostAccessReport, type HostAccessInput } from '../policy';

const ID = '3f2a9c1e-0000-4000-8000-000000000000';
// User decisions 2026-10-03: one name per environment (resourceName); the project, the volume, and the container share it.
const OWN = resourceName('acme/api', ID);
/** User decisions 2026-10-03: the name of an environment of another repository and ID (before: devenv-<8 hex>). */
const OTHER = resourceName('acme/web', '11111111-2222-4333-8444-555555555555');
type Where = 'config' | 'merged' | 'metadata';
const WHERE: readonly Where[] = ['config', 'merged', 'metadata'];

/** The report of a Compose configuration (composeMounts) whose `where` holds `entry`, with the checks on or off. */
function report(where: Where, entry: Record<string, unknown>, checksOn: boolean, composeMounts = true) {
  const input: HostAccessInput =
    where === 'metadata' ? { ownVolume: OWN, metadata: [entry] } : where === 'merged' ? { ownVolume: OWN, merged: entry } : { ownVolume: OWN, config: entry };
  return hostAccessReport(composeMounts ? { ...input, composeMounts: true } : input, checksOn);
}

/** The same value as a merged configuration names it: the entrypoints of the metadata are `entrypoints` there. */
function entryFor(where: Where, entry: Record<string, unknown>): Record<string, unknown> {
  if (where !== 'merged' || !('entrypoint' in entry)) return entry;
  const { entrypoint, ...rest } = entry;
  return { ...rest, entrypoints: [entrypoint] };
}

/** The vectors of findings-r16.md (D16-1, S16-1) and verdicts-r16.md (capAdd and securityOpt with the checks off). */
const VECTORS: Array<Record<string, unknown>> = [
  { containerUser: 'root\n    privileged: true\n    volumes:\n      - /:/host' },
  { containerUser: 'root\n    privileged: true' },
  { containerEnv: { "A'\n    privileged: true\n    x-a: 'b": '1' } },
  { entrypoint: 'echo hi", "x"]\n    privileged: true\n    x-y: ["' },
  { entrypoint: '/x.sh"]\n    privileged: true\n    cap_add: ["ALL"]\n    x-a: ["' },
  { capAdd: ['SYS_PTRACE\n    privileged: true'] },
  { capAdd: 'SYS_PTRACE\n    privileged: true' },
  { securityOpt: ['seccomp=unconfined\n    privileged: true'] },
  { securityOpt: 'seccomp=unconfined\n    volumes:\n      - /:/host' },
];

describe('review round 16, L1: Compose values that the Dev Container CLI writes as text', () => {
  for (const where of WHERE) {
    for (const vector of VECTORS) {
      it(`refuses ${JSON.stringify(vector)} in ${where}, with the checks on and off`, () => {
        const entry = entryFor(where, vector);
        for (const checksOn of [true, false]) expect(report(where, entry, checksOn).unsupported.length).toBeGreaterThan(0);
      });
    }
  }

  it('refuses every containerUser that is not a user name or ID, optionally with a group', () => {
    for (const user of ['root ', ' root', 'root:', ':root', 'a:b:c', 'root#x', 'ro ot', "o'x", 'a"b', '$USER', '${containerEnv:USER}', '-root', 'r\u0085x', 'r\u2028x', 'r\tx', 'rööt']) {
      expect(report('metadata', { containerUser: user }, false).unsupported, JSON.stringify(user)).toContain(
        `containerUser ${JSON.stringify(user)} (the Dev Container CLI writes it into its compose file as it is: only a user name or ID, optionally with a group, is supported)`,
      );
    }
    // Not a text: the CLI writes it with String(); a list of one text is that text.
    for (const user of [['root\n    privileged: true'], { a: 1 }, 1000]) {
      expect(report('metadata', { containerUser: user }, false).unsupported.length, JSON.stringify(user)).toBeGreaterThan(0);
    }
  });

  it('allows plain users', () => {
    for (const user of ['root', 'vscode', 'node', '1000', '1000:1000', 'dev-user.name', '_apt', 'user:group']) {
      for (const where of WHERE) expect(report(where, { containerUser: user }, true), `${where} ${user}`).toEqual({ hostAccess: [], unsupported: [] });
    }
  });

  it('refuses containerEnv names that are not plain variable names', () => {
    for (const name of ["A'", 'A B', 'A\nB', 'A$B', '1A', '-A', 'A=B', 'A:B', 'A#B', 'A"B', 'A\\B', 'A\u2028B', '']) {
      const items = report('metadata', { containerEnv: { [name]: '1' } }, false).unsupported;
      expect(items, JSON.stringify(name)).toContain(
        `containerEnv variable ${JSON.stringify(name)} (the Dev Container CLI writes its name into its compose file as it is: only letters, digits, _, ., and - are supported)`,
      );
    }
  });

  it('allows plain containerEnv names, and every value (the CLI escapes the values)', () => {
    const env = { PATH: '/x:${containerEnv:PATH}', A_B: "it's\n    privileged: true", 'a.b-c': '$HOME', _X: '"' };
    for (const where of WHERE) expect(report(where, { containerEnv: env }, true), where).toEqual({ hostAccess: [], unsupported: [] });
  });

  it("allows the extension's own containerEnv", () => {
    expect(report('merged', { containerEnv: containerEnvironment() }, true)).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('refuses entrypoints with quotes, backslashes, $, line breaks, and control characters', () => {
    for (const entrypoint of ['/a"b', "/a'b", '/a\\b', '/a$b', '/a\nb', '/a\rb', '/a\tb', '/a\u0000b', '/a\u0085b', '/a\u2028b', '/a\u2029b']) {
      for (const where of WHERE) {
        const items = report(where, entryFor(where, { entrypoint }), false).unsupported;
        expect(items, `${where} ${JSON.stringify(entrypoint)}`).toContain(
          `entrypoint ${JSON.stringify(entrypoint)} (the Dev Container CLI writes it into its compose file as it is: quotes, backslashes, $, line breaks, and control characters are not supported)`,
        );
      }
    }
    // Not a text: the CLI joins it with String().
    expect(report('metadata', { entrypoint: ['/a"]\n    privileged: true'] }, false).unsupported.length).toBeGreaterThan(0);
    expect(report('merged', { entrypoints: [['/a"]']] }, false).unsupported.length).toBeGreaterThan(0);
  });

  it('allows the entrypoints of the common Features', () => {
    for (const entrypoint of ['/usr/local/share/docker-init.sh', '/usr/local/share/ssh-init.sh', '/usr/local/share/nix-entrypoint.sh', 'sleep 1 && echo ok; true']) {
      for (const where of WHERE) expect(report(where, entryFor(where, { entrypoint }), true), where).toEqual({ hostAccess: [], unsupported: [] });
    }
  });

  it('refuses capAdd and securityOpt values that are no plain tokens, whatever the switch says', () => {
    const capabilities: unknown[] = ['SYS_PTRACE ', ' SYS_PTRACE', 'SYS PTRACE', 'SYS_PTRACE#x', '$CAP', 'SYS-PTRACE', ['SYS_PTRACE'], 7];
    for (const value of capabilities) {
      expect(report('metadata', { capAdd: [value] }, false).unsupported.length, JSON.stringify(value)).toBeGreaterThan(0);
    }
    expect(report('metadata', { capAdd: ['SYS_PTRACE\n    privileged: true'] }, false).unsupported).toContain(
      'capability "SYS_PTRACE\\n    privileged: true" (the Dev Container CLI writes it into its compose file as it is: only a plain name is supported)',
    );
    const options: unknown[] = ['seccomp=unconfined ', 'seccomp=un confined', 'seccomp=$X', "seccomp='x'", 'seccomp=#x', '-seccomp', 'seccomp=unconfined:', ['label=disable'], true];
    for (const value of options) {
      expect(report('metadata', { securityOpt: [value] }, false).unsupported.length, JSON.stringify(value)).toBeGreaterThan(0);
    }
    expect(report('metadata', { securityOpt: ['label=disable\n    privileged: true'] }, false).unsupported).toContain(
      'security option "label=disable\\n    privileged: true" (the Dev Container CLI writes it into its compose file as it is: only a plain option is supported)',
    );
  });

  it('lifts plain capAdd and securityOpt values with the checks off, as before', () => {
    const entry = { capAdd: ['SYS_ADMIN', 'NET_ADMIN'], securityOpt: ['apparmor=unconfined', 'label=disable', 'seccomp=/etc/docker/profile.json', 'no-new-privileges:true'] };
    for (const where of WHERE) {
      expect(report(where, entry, false), where).toEqual({ hostAccess: [], unsupported: [] });
      expect(report(where, entry, true).hostAccess.length, where).toBeGreaterThan(0);
    }
    expect(report('metadata', { capAdd: ['SYS_PTRACE'], securityOpt: ['seccomp=unconfined'] }, true)).toEqual({ hostAccess: [], unsupported: [] });
  });

  it('leaves single containers alone: the CLI passes these values to docker run as separate arguments', () => {
    const r = hostAccessReport({
      ownVolume: OWN,
      metadata: [{ containerUser: 'a b', containerEnv: { "A'": '1' }, entrypoint: '/a"b', capAdd: ['SYS_PTRACE '] }],
    });
    expect(r).toEqual({ hostAccess: [], unsupported: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Guard (review round 16, L1): the function `iW` of the vendored Dev Container CLI (with `lQ`, `nW`, and `oW`), which
// writes the compose file of `up`, runs on every value that the policy allows; its text, read as YAML, must give the dev
// service exactly the expected keys, with the values as given. A change of the CLI that the policy does not follow
// fails here.

const CLI_FILE = require.resolve('@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js');

/** The source of the function `name` of the CLI bundle, up to the next function. */
function cliFunction(bundle: string, name: string, keyword = 'function '): string {
  const start = bundle.indexOf(`${keyword}${name}(`);
  if (start < 0) throw new Error(`${name} is not in the vendored CLI`);
  const end = bundle.indexOf('function ', start + keyword.length + name.length);
  return bundle.slice(start, end).replace(/async\s*$/, '');
}

type Iw = (...args: unknown[]) => Promise<string>;
function vendoredIw(): Iw {
  const bundle = readFileSync(CLI_FILE, 'utf8');
  // The table `cj` of lQ, a stand-in for the shell parser `dp` (only for the entrypoint of a compose service, not used
  // here), and no GPU (the policy refuses hostRequirements.gpu).
  const source = [
    'var cj={src:"source",destination:"target",dst:"target"};',
    'var dp={parse:(s)=>s.split(" ")};',
    'async function NQ(){return false};',
    cliFunction(bundle, 'lQ'),
    cliFunction(bundle, 'nW'),
    cliFunction(bundle, 'oW'),
    cliFunction(bundle, 'iW', 'async function '),
    'return iW;',
  ].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(source)() as Iw;
}

// js-yaml is in package-lock.json (a dependency of @vscode/vsce) and in node_modules at the top.
const yaml = createRequire(__filename)('js-yaml') as { load(text: string): unknown };

/** The compose file that the CLI writes for the merged configuration `merged`, as `up` calls iW. */
async function composeText(iw: Iw, merged: Record<string, unknown>): Promise<string> {
  return iw(`${OWN}-image`, `${OWN}-image`, merged, { service: 'app' }, '', async () => ({ Config: { Entrypoint: [], Cmd: [] } }), {}, [], [], {});
}

/** Line breaks that the YAML parser of Compose (go-yaml) reads and js-yaml does not: none may reach the text. */
const OTHER_LINE_BREAKS = /[\r\u0085\u2028\u2029]/;

const INJECTIONS: readonly string[] = [
  '\n    privileged: true',
  "'\n    privileged: true\n    x-a: '",
  '"\n    privileged: true\n    x-a: "',
  '", "x"]\n    privileged: true\n    x-y: ["',
  '\r    privileged: true',
  '\u0085    privileged: true',
  '\u2028    privileged: true',
  '\\',
  '\\"',
  '$',
  '$$',
  '${X}',
  ' #c',
  '#',
  ': x',
  ':',
  "'",
  '"',
  '`',
  '{a: b}',
  '[a]',
  '&a',
  '*a',
  '!a',
  '|',
  '>',
  '%',
  '@',
  ',',
  '- x',
  '? x',
  '\t',
  '\u0000',
  ' ',
];

/** Every combination of the bases with the injections: before, after, and alone. */
function candidates(bases: readonly string[]): string[] {
  const all = new Set<string>(bases);
  for (const injection of INJECTIONS) {
    all.add(injection);
    for (const base of bases) {
      all.add(`${base}${injection}`);
      all.add(`${injection}${base}`);
    }
  }
  return [...all];
}

/** Whether the policy allows `entry` anywhere (configuration, merged configuration, image metadata) with the checks off. */
function allowedAnywhere(entry: Record<string, unknown>): boolean {
  return WHERE.some((where) => {
    const r = report(where, entryFor(where, entry), false);
    return r.hostAccess.length === 0 && r.unsupported.length === 0;
  });
}

/**
 * The keys of the dev service: `entrypoint` and `command` (the command of the image, here none) always, and the keys of
 * the values given.
 */
interface Service {
  [key: string]: unknown;
}

async function devService(iw: Iw, merged: Record<string, unknown>): Promise<{ text: string; top: string[]; service: Service }> {
  const text = await composeText(iw, merged);
  const parsed = yaml.load(text) as { services: Record<string, Service> };
  return { text, top: Object.keys(parsed), service: parsed.services.app };
}

describe('guard (review round 16, L1): the compose file of the vendored CLI for the values that the policy allows', () => {
  const iw = vendoredIw();

  it('reproduces the injection of the findings with the values that the policy now refuses', async () => {
    const { service } = await devService(iw, { containerUser: 'root\n    privileged: true' });
    expect(service.privileged).toBe(true);
    expect(allowedAnywhere({ containerUser: 'root\n    privileged: true' })).toBe(false);
  });

  it('containerUser', async () => {
    let allowed = 0;
    for (const user of candidates(['root', '1000:1000', 'vscode', 'a.b-c_d'])) {
      if (!allowedAnywhere({ containerUser: user })) continue;
      allowed++;
      const { text, top, service } = await devService(iw, { containerUser: user });
      expect(OTHER_LINE_BREAKS.test(text), JSON.stringify(user)).toBe(false);
      expect(top).toEqual(['services']);
      expect(Object.keys(service).sort(), JSON.stringify(user)).toEqual(['command', 'entrypoint', 'user']);
      expect(String(service.user)).toBe(user);
    }
    expect(allowed).toBeGreaterThanOrEqual(4);
  });

  it('containerEnv names and values', async () => {
    let allowed = 0;
    for (const name of candidates(['A', 'a.b-c', '_X1'])) {
      for (const value of ['1', "it's", '$HOME', 'a\nb', '"', '\\', '\u2028']) {
        if (!allowedAnywhere({ containerEnv: { [name]: value } })) continue;
        allowed++;
        const { text, top, service } = await devService(iw, { containerEnv: { [name]: value } });
        // The CLI writes a line break of a value as `\n`, and the others inside quotes; the name goes as it is.
        expect(/[\r\u0085]/.test(text), JSON.stringify(name)).toBe(false);
        expect(top).toEqual(['services']);
        expect(Object.keys(service).sort(), JSON.stringify(name)).toEqual(['command', 'entrypoint', 'environment']);
        expect(service.environment).toEqual([`${name}=${value.replace(/\n/g, '\\n').replace(/\$/g, '$$$$')}`]);
      }
    }
    expect(allowed).toBeGreaterThanOrEqual(3 * 7);
  });

  it('entrypoints', async () => {
    let allowed = 0;
    for (const entrypoint of candidates(['/usr/local/share/docker-init.sh', 'echo a && echo b'])) {
      if (!allowedAnywhere({ entrypoint })) continue;
      allowed++;
      const { text, top, service } = await devService(iw, { entrypoints: [entrypoint, '/second.sh'] });
      expect(OTHER_LINE_BREAKS.test(text), JSON.stringify(entrypoint)).toBe(false);
      expect(top).toEqual(['services']);
      expect(Object.keys(service).sort(), JSON.stringify(entrypoint)).toEqual(['command', 'entrypoint']);
      const command = service.entrypoint as string[];
      expect(command.length).toBe(4);
      expect(command.slice(0, 2)).toEqual(['/bin/sh', '-c']);
      expect(command[3]).toBe('-');
      // YAML folds the lines of the quoted text: compared with the spaces collapsed.
      const words = (text: string): string => text.replace(/\s+/g, ' ').trim();
      expect(words(command[2])).toContain(words(`trap "exit 0" 15 ${entrypoint} /second.sh exec "$$@"`));
    }
    expect(allowed).toBeGreaterThanOrEqual(2);
  });

  it('capAdd and securityOpt', async () => {
    let allowed = 0;
    for (const [property, key, bases] of [
      ['capAdd', 'cap_add', ['SYS_PTRACE', 'SYS_ADMIN']],
      ['securityOpt', 'security_opt', ['seccomp=unconfined', 'label=disable', 'seccomp=/etc/p.json', 'no-new-privileges:true']],
    ] as const) {
      for (const value of candidates(bases)) {
        if (!allowedAnywhere({ [property]: [value] })) continue;
        allowed++;
        const { text, top, service } = await devService(iw, { [property]: [value, bases[0]] });
        expect(OTHER_LINE_BREAKS.test(text), JSON.stringify(value)).toBe(false);
        expect(top).toEqual(['services']);
        expect(Object.keys(service).sort(), JSON.stringify(value)).toEqual(['command', 'entrypoint', key].sort());
        expect(service[key]).toEqual([value, bases[0]]);
      }
    }
    expect(allowed).toBeGreaterThanOrEqual(6);
  });

  it('all of them together, with a volume mount', async () => {
    const merged = {
      containerUser: '1000:1000',
      containerEnv: { A: 'x', B_C: "'" },
      entrypoints: ['/usr/local/share/docker-init.sh'],
      capAdd: ['SYS_PTRACE'],
      securityOpt: ['seccomp=unconfined'],
      mounts: [{ type: 'volume', source: 'cache', target: '/cache' }],
      init: true,
    };
    expect(allowedAnywhere({ ...merged, entrypoint: merged.entrypoints[0], entrypoints: undefined })).toBe(true);
    const { top, service } = await devService(iw, merged);
    expect(top).toEqual(['services', 'volumes']);
    expect(Object.keys(service).sort()).toEqual(['cap_add', 'command', 'entrypoint', 'environment', 'init', 'security_opt', 'user', 'volumes']);
    expect(service.command).toEqual([]);
  });
});
