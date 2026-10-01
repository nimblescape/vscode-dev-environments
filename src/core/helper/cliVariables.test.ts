// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { isDevContainersCloneVolumeName } from '../devContainers';
import { ENVIRONMENT_VOLUME_PATTERN, HELPER_CACHE_VOLUME, environmentIdLabel } from '../names';
import {
  DEVCONTAINER_ID_PLACEHOLDER,
  HELPER_KNOWN_ENV,
  HELPER_PROCESS_ENV_NAMES,
  MAX_CLI_TEXT_LENGTH,
  SECOND_PASS_VARIABLE_NAMES,
  devcontainerIdOf,
  environmentDevcontainerId,
  helperCliVariables,
  mayBeSetInHelper,
  resolveCliVariables,
  substituteCliVariables,
  textLengths,
  unresolvedCliVariables,
  variableMatches,
  withDevcontainerIdPlaceholder,
  type CliVariables,
} from './cliVariables';
import { batchRunArgs } from '../helperChannel/batch';
import { batchStepCommand } from './batchSteps';
import { composeMountVolumes } from '../pipeline/pipelineRules';

// Guard (hotfix M1): the substitution functions of Dev Container CLI 0.89.0, copied verbatim from
// node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js (Fo, tg, Hr, za, a_, cN, lN, I_, C_, B_, E_, hN,
// Q_). The first test fails when the installed CLI no longer holds this text (another version, or a changed
// substitution): then substituteCliVariables must be checked against the new CLI, and this copy replaced.
const CLI_VERSION = '0.89.0';
const CLI_FOLDER = path.resolve(__dirname, '../../../node_modules/@devcontainers/cli');
const CLI_SUBSTITUTION_SOURCE =
  "function Fo(e,A){let t,i=e.platform===\"win32\",r={...e,get env(){return t||(t=cN(i,e.env))}},n=C_.bin" +
  "d(void 0,i,r);return e.containerWorkspaceFolder&&(r.containerWorkspaceFolder=lN(n,e.containerWorkspa" +
  "ceFolder)),za(n,A)}function tg(e,A){let t;return za(E_.bind(void 0,()=>t||e&&(t=Q_(e))),A)}function " +
  "Hr(e,A,t,i){let r=e===\"win32\";return za(B_.bind(void 0,r,A,cN(r,t)),i)}function za(e,A){if(typeof A=" +
  "=\"string\")return lN(e,A);if(Array.isArray(A))return A.map(t=>za(e,t));if(A&&typeof A==\"object\"&&!Fe." +
  "isUri(A)){let t=Object.create(null);return Object.keys(A).forEach(i=>{t[i]=za(e,A[i])}),t}return A}v" +
  "ar a_=/\\$\\{(.*?)\\}/g;function cN(e,A){if(e){let t=Object.create(null);return Object.keys(A).forEach(" +
  "i=>{t[i.toLowerCase()]=A[i]}),t}return A}function lN(e,A){return A.replace(a_,I_.bind(void 0,e))}fun" +
  "ction I_(e,A,t){let i=[],r=t.split(\":\");return r.length>1&&(t=r[0],i=r.slice(1)),e(A,t,i)}function C" +
  "_(e,A,t,i,r){switch(i){case\"env\":case\"localEnv\":return hN(e,A.env,r,t,A.configFile);case\"localWorksp" +
  "aceFolder\":return A.localWorkspaceFolder!==void 0?A.localWorkspaceFolder:t;case\"localWorkspaceFolder" +
  "Basename\":return A.localWorkspaceFolder!==void 0?(e?eg.win32:eg.posix).basename(A.localWorkspaceFold" +
  "er):t;case\"containerWorkspaceFolder\":return A.containerWorkspaceFolder!==void 0?A.containerWorkspace" +
  "Folder:t;case\"containerWorkspaceFolderBasename\":return A.containerWorkspaceFolder!==void 0?eg.posix." +
  "basename(A.containerWorkspaceFolder):t;default:return t}}function B_(e,A,t,i,r,n){return r===\"contai" +
  "nerEnv\"?hN(e,t,n,i,A):i}function E_(e,A,t){return t===\"devcontainerId\"&&e()||A}function hN(e,A,t,i,r" +
  "){if(t.length>0){let n=t[0];e&&(n=n.toLowerCase());let o=A[n];return typeof o==\"string\"?o:t.length>1" +
  "?t[1]:\"\"}throw new kA({description:`'${i}'${r?` in ${eg.posix.basename(r.path)}`:\"\"} can not be reso" +
  "lved because no environment variable name is given.`})}function Q_(e){let A=JSON.stringify(e,Object." +
  "keys(e).sort()),t=Buffer.from(A,\"utf-8\"),i=uN.createHash(\"sha256\").update(t).digest();return BigInt(" +
  "`0x${i.toString(\"hex\")}`).toString(32).padStart(52,\"0\")}";

interface CliSubstitution {
  Fo: (context: Record<string, unknown>, value: unknown) => unknown;
  tg: (idLabels: Record<string, string> | undefined, value: unknown) => unknown;
  Q_: (idLabels: Record<string, string>) => string;
}

/** The copied functions, with the modules that the bundle gives them (path, crypto, the URI check, the error class). */
function loadCli(): CliSubstitution {
  class KA extends Error {
    constructor(options: { description: string }) {
      super(options.description);
    }
  }
  const factory = new Function('eg', 'uN', 'Fe', 'kA', `${CLI_SUBSTITUTION_SOURCE}\nreturn { Fo, tg, Q_ };`) as (
    ...args: unknown[]
  ) => CliSubstitution;
  return factory(path, crypto, { isUri: () => false }, KA);
}

const cli = loadCli();
const REPOSITORY_FOLDER = '/workspaces/api';
const ID_LABELS = { 'nimblescape.devenv.environment-id': '3f2a9c1e-0000-4000-8000-000000000001' };
const ENV = { HOME: '/root', FOO: 'bar', EMPTY: '' };

/** What `devcontainer up` does with an entry of the image metadata: Fo (local variables), then tg (${devcontainerId}). */
function cliUp(value: unknown, context: { localWorkspaceFolder?: string; containerWorkspaceFolder?: string; env: Record<string, string> }, idLabels?: Record<string, string>): unknown {
  return JSON.parse(JSON.stringify(cli.tg(idLabels, cli.Fo({ platform: 'linux', ...context }, value))));
}

const CASES: Array<[string, unknown]> = [
  ['a default for an unset variable (M1)', 'source=${localEnv:NOPE:devenv-other-abcdef12},target=/x,type=volume'],
  ['env as an alias of localEnv (M1)', 'source=${env:NOPE:devenv-helper-cache},target=/c,type=volume'],
  ['the object form (M1)', { source: '${localEnv:NOPE:devenv-other-abcdef12}', target: '/x', type: 'volume' }],
  ['a foreign name built from the basename (M1)', 'source=devenv-${localWorkspaceFolderBasename}-abcdef12,target=/x,type=volume'],
  ['node_modules of the repository', 'source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume'],
  ['docker-in-docker', { source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' }],
  ['shell history', 'source=${devcontainerId}-bashhistory,target=/commandhistory,type=volume'],
  ['a set variable', '${localEnv:HOME}/.ssh'],
  ['a set variable with a default', '${env:FOO:other}'],
  ['an empty set variable with a default', '${localEnv:EMPTY:x}'],
  ['an unset variable without a default', 'a${localEnv:NOPE}b'],
  ['only the first argument after the name is the default', '${localEnv:NOPE:a:b}'],
  ['an empty variable name', '${localEnv:}'],
  ['the workspace folders', '${localWorkspaceFolder}|${localWorkspaceFolderBasename}|${containerWorkspaceFolder}|${containerWorkspaceFolderBasename}'],
  ['arguments after a workspace folder', '${localWorkspaceFolder:x}|${containerWorkspaceFolderBasename:y}'],
  ['an argument after devcontainerId', '${devcontainerId:x}'],
  ['containerEnv of a new container', '${containerEnv:PATH}'],
  ['unknown names', '${unknown}|${}|${UNKNOWN:x}'],
  ['no variable', 'type=tmpfs,target=/tmp'],
  ['a result is not substituted again in the same pass', '${localEnv:NOPE:$}{localEnv:NOPE:devenv-other-abcdef12}'],
  ['the non-greedy pattern', '${localEnv:NOPE:${localEnv:HOME}}'],
  ['a result that names devcontainerId is resolved by the second pass', '${localEnv:NOPE:$}{devcontainerId}|${localEnv:NOPE:${devcontainerId}}'],
  ['keys stay, values of objects and arrays are substituted', { '${localEnv:FOO}': ['${localEnv:FOO}', 1, true, null, { a: '${localWorkspaceFolderBasename}' }] }],
  ['other values stay', [42, false, null]],
];

describe(`cliVariables: as Dev Container CLI ${CLI_VERSION} substitutes (hotfix M1)`, () => {
  it('the copy of the substitution is the code of the installed CLI', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLI_FOLDER, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(CLI_VERSION);
    const bundle = fs.readFileSync(path.join(CLI_FOLDER, 'dist', 'spec-node', 'devContainersSpecCLI.js'), 'utf8');
    expect(bundle.includes(CLI_SUBSTITUTION_SOURCE)).toBe(true);
  });

  const context = { localWorkspaceFolder: REPOSITORY_FOLDER, containerWorkspaceFolder: REPOSITORY_FOLDER, env: ENV };

  it.each(CASES)('%s: as the CLI with a devcontainerId', (_name, value) => {
    const devcontainerId = cli.Q_(ID_LABELS);
    const ours = substituteCliVariables(value, { ...context, devcontainerId });
    expect(JSON.parse(JSON.stringify(ours))).toEqual(cliUp(value, context, ID_LABELS));
  });

  it.each(CASES)('%s: as the CLI without a devcontainerId (read-configuration before the container exists)', (_name, value) => {
    expect(JSON.parse(JSON.stringify(substituteCliVariables(value, context)))).toEqual(cliUp(value, context));
  });

  it.each(CASES)('%s: as the CLI without workspace folders', (_name, value) => {
    expect(JSON.parse(JSON.stringify(substituteCliVariables(value, { env: ENV })))).toEqual(cliUp(value, { env: ENV }));
  });

  it('substitutes the containerWorkspaceFolder itself first, as the CLI does', () => {
    const variables = { localWorkspaceFolder: REPOSITORY_FOLDER, containerWorkspaceFolder: '/w/${localWorkspaceFolderBasename}/${containerWorkspaceFolder}', env: ENV };
    const value = '${containerWorkspaceFolder}|${containerWorkspaceFolderBasename}';
    expect(substituteCliVariables(value, variables)).toBe(cliUp(value, variables));
    expect(substituteCliVariables(value, variables)).toBe('/w/api//w/${localWorkspaceFolderBasename}/${containerWorkspaceFolder}|${containerWorkspaceFolder}');
    // An empty workspaceFolder is used as it is.
    const empty = { containerWorkspaceFolder: '', env: ENV };
    expect(substituteCliVariables(value, empty)).toBe(cliUp(value, empty));
  });

  it('the concrete results of the M1 vectors and of the common patterns', () => {
    const variables = helperCliVariables('acme/api');
    expect(substituteCliVariables('source=${localEnv:NOPE:devenv-other-abcdef12},target=/x', variables)).toBe('source=devenv-other-abcdef12,target=/x');
    expect(substituteCliVariables('${env:NOPE:devenv-helper-cache}', variables)).toBe('devenv-helper-cache');
    expect(substituteCliVariables('devenv-${localWorkspaceFolderBasename}-abcdef12', variables)).toBe('devenv-api-abcdef12');
    expect(substituteCliVariables('source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/node_modules', variables)).toBe(
      'source=api-node_modules,target=/workspaces/api/node_modules',
    );
    expect(substituteCliVariables('dind-var-lib-docker-${devcontainerId}', variables)).toBe('dind-var-lib-docker-${devcontainerId}');
  });

  it('leaves ${env} and ${localEnv} without a variable name, where the CLI stops with an error', () => {
    for (const value of ['${env}', '${localEnv}']) {
      expect(() => cliUp(value, context)).toThrow('can not be resolved because no environment variable name is given');
      expect(substituteCliVariables(value, context)).toBe(value);
      expect(unresolvedCliVariables(value)).toEqual([value]);
    }
  });
});

describe('cliVariables: the process of the CLI in the workspace helper (hotfix M1)', () => {
  it('leaves the variables that may be set in the helper, whose values are not known', () => {
    const variables: CliVariables = helperCliVariables('acme/api');
    // hotfix review 1, N4: HOME is known (/root, HELPER_KNOWN_ENV), the others may be set.
    for (const name of ['PATH', 'HOSTNAME', 'NODE_VERSION', 'YARN_VERSION', 'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'HTTP_PROXY', 'no_proxy']) {
      expect(mayBeSetInHelper(name)).toBe(true);
      expect(substituteCliVariables(`\${localEnv:${name}:devenv-other-abcdef12}`, variables)).toBe(`\${localEnv:${name}:devenv-other-abcdef12}`);
      expect(substituteCliVariables(`\${env:${name}}`, variables)).toBe(`\${env:${name}}`);
    }
    expect(HELPER_PROCESS_ENV_NAMES).toContain('HOME');
    expect(mayBeSetInHelper('HOME')).toBe(true);
    expect(substituteCliVariables('${localEnv:HOME:devenv-other-abcdef12}|${env:HOME}', variables)).toBe('/root|/root');
  });

  it('resolves the other variables to their default or to an empty text, as the CLI does for a variable that is not set', () => {
    const variables = helperCliVariables('acme/api');
    expect(mayBeSetInHelper('NOPE')).toBe(false);
    // Case-sensitive, as on Linux.
    expect(mayBeSetInHelper('home')).toBe(false);
    expect(substituteCliVariables('${localEnv:NOPE:x}|${localEnv:USERPROFILE}|${localEnv:home:y}', variables)).toBe('x||y');
    // The common bind mount of the .ssh folder: HOME is /root (hotfix review 1, N4), USERPROFILE (Windows) is not set in
    // the helper.
    expect(substituteCliVariables('source=${localEnv:HOME}${localEnv:USERPROFILE}/.ssh', variables)).toBe('source=/root/.ssh');
  });

  it('uses the repository folder for both workspace folders, as the pipeline runs up', () => {
    expect(helperCliVariables('acme/api')).toMatchObject({ localWorkspaceFolder: '/workspaces/api', containerWorkspaceFolder: '/workspaces/api' });
  });
});

describe('unresolvedCliVariables (hotfix M1)', () => {
  it.each<[string, string[]]>([
    ['source=${localEnv:HOME}/.ssh', ['${localEnv:HOME}']],
    ['${env:HOSTNAME}-${env:HOSTNAME}', ['${env:HOSTNAME}']],
    ['${localWorkspaceFolderBasename}-x', ['${localWorkspaceFolderBasename}']],
    ['${containerWorkspaceFolder:x}', ['${containerWorkspaceFolder:x}']],
    ['${containerEnv:PATH}', ['${containerEnv:PATH}']],
    ['${env}', ['${env}']],
    // Resolved by the CLI to an opaque ID, or left as written for Docker.
    ['dind-var-lib-docker-${devcontainerId}', []],
    ['${devcontainerId:x}', []],
    ['${unknown}-${}', []],
    ['plain', []],
  ])('%s', (text, expected) => {
    expect(unresolvedCliVariables(text)).toEqual(expected);
  });
});

describe('resolveCliVariables: the leftovers of the raw strings (hotfix review 2, P1)', () => {
  const variables = helperCliVariables('acme/api');
  it.each<[string, unknown, string, string[]]>([
    ['none', 'source=${localEnv:HOME}/.ssh,${localEnv:NOPE:x}', 'source=/root/.ssh,x', []],
    ['a variable of the helper process', '${localEnv:TERM:x}-${env:PWD}', '${localEnv:TERM:x}-${env:PWD}', ['${localEnv:TERM:x}', '${env:PWD}']],
    ['a leftover that the result hides', 'dst=/y${localEnv:NOPE:$}{,src=${localEnv:TERM:v}', 'dst=/y${,src=${localEnv:TERM:v}', ['${localEnv:TERM:v}']],
    ['a result that only looks like a leftover', '${localEnv:NOPE:$}{localEnv:TERM}', '${localEnv:TERM}', []],
    ['${containerEnv:…} and ${env} without a name', '${containerEnv:A}${env}', '${containerEnv:A}${env}', ['${containerEnv:A}', '${env}']],
    ['not ${devcontainerId} and unknown names', '${devcontainerId:x}${unknown}', '${devcontainerId:x}${unknown}', []],
    ['the strings of an object, once each', { a: ['${env:TERM}', '${env:TERM}'], b: '${localWorkspaceFolderBasename}' }, '', ['${env:TERM}']],
  ])('%s', (_name, value, expected, leftovers) => {
    const result = resolveCliVariables(value, variables);
    if (typeof value === 'string') expect(result.value).toBe(expected);
    expect(result.value).toEqual(substituteCliVariables(value, variables));
    expect(result.leftovers).toEqual(leftovers);
  });

  it('counts the leftovers of the workspace folders that are not known, and of a workspaceFolder with a leftover', () => {
    expect(resolveCliVariables('${localWorkspaceFolder}${containerWorkspaceFolderBasename}', {}).leftovers).toEqual(['${localWorkspaceFolder}', '${containerWorkspaceFolderBasename}']);
    const folder = { ...variables, containerWorkspaceFolder: '/workspaces/${localEnv:TERM}' };
    expect(resolveCliVariables('${containerWorkspaceFolder}/x', folder)).toEqual({ value: '/workspaces/${localEnv:TERM}/x', leftovers: ['${localEnv:TERM}'] });
    expect(resolveCliVariables('plain', folder).leftovers).toEqual([]);
  });
});

describe('the placeholder of ${devcontainerId} (hotfix review 2, P6)', () => {
  it('is shaped like the ID of the CLI, and named like no volume of Dev Environments', () => {
    expect(DEVCONTAINER_ID_PLACEHOLDER).toMatch(/^[0-9a-v]{52}$/);
    expect(cli.Q_(ID_LABELS)).toMatch(/^[0-9a-v]{52}$/);
    for (const name of [DEVCONTAINER_ID_PLACEHOLDER, `x-${DEVCONTAINER_ID_PLACEHOLDER}`, `devenv-x-${DEVCONTAINER_ID_PLACEHOLDER}`]) {
      expect(ENVIRONMENT_VOLUME_PATTERN.test(name)).toBe(false);
      expect(isDevContainersCloneVolumeName(name)).toBe(false);
      expect(name).not.toBe(HELPER_CACHE_VOLUME);
    }
  });

  it('replaces every expression named devcontainerId as the second pass of the CLI does', () => {
    const text = 'a${devcontainerId}b${devcontainerId:,type=bind}c${devcontainerId:x:y}${other}';
    expect(withDevcontainerIdPlaceholder(text)).toBe(`a${DEVCONTAINER_ID_PLACEHOLDER}b${DEVCONTAINER_ID_PLACEHOLDER}c${DEVCONTAINER_ID_PLACEHOLDER}\${other}`);
    const id = cli.Q_(ID_LABELS);
    expect(withDevcontainerIdPlaceholder(text).split(DEVCONTAINER_ID_PLACEHOLDER).join(id)).toBe(cli.tg(ID_LABELS, text));
  });

  it('leaves ${containerEnv:…} out of the names of the second pass (hotfix review 2, P4)', () => {
    expect(SECOND_PASS_VARIABLE_NAMES).not.toContain('containerEnv');
    expect(unresolvedCliVariables('X=${containerEnv:PATH}${env:TERM}', SECOND_PASS_VARIABLE_NAMES)).toEqual(['${env:TERM}']);
  });
});

// Hotfix review 1, N5: the pattern /\$\{(.*?)\}/g of the CLI takes quadratic time on `${${${…` without `}`. The module
// finds the same matches with a linear scan.
describe('variableMatches: the matches of the pattern of the CLI in linear time (hotfix review 1, N5)', () => {
  const PATTERN = /\$\{(.*?)\}/g;
  const regexMatches = (text: string) => [...text.matchAll(PATTERN)].map((match) => ({ start: match.index, end: match.index + match[0].length, inner: match[1] }));
  // A small random generator with a fixed seed, so a failure can be repeated.
  let seed = 20260927;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const PIECES = ['$', '{', '}', '${', ':', 'env', 'localEnv', 'NOPE', 'HOME', 'x', '\n', '\r', '\u2028', '\u2029', 'devcontainerId', '$$', '}}', ' '];
  const randomText = (): string => Array.from({ length: random(24) }, () => PIECES[random(PIECES.length)]).join('');

  it('finds the matches of the pattern, for 20000 random texts', () => {
    for (let i = 0; i < 20000; i++) {
      const text = randomText();
      expect(variableMatches(text), JSON.stringify(text)).toEqual(regexMatches(text));
    }
  });

  it('substitutes as the CLI, for 5000 random texts', () => {
    const context = { localWorkspaceFolder: REPOSITORY_FOLDER, containerWorkspaceFolder: REPOSITORY_FOLDER, env: ENV };
    for (let i = 0; i < 5000; i++) {
      const text = randomText();
      let expected: unknown;
      try {
        expected = cliUp(text, context, ID_LABELS);
      } catch {
        // ${env} without a name: the CLI stops with an error (see above).
        continue;
      }
      expect(substituteCliVariables(text, { ...context, devcontainerId: cli.Q_(ID_LABELS) }), JSON.stringify(text)).toBe(expected);
    }
  });

  it.each<[string, string]>([
    ['${ without }', '${'.repeat(200_000)],
    ['${ with } after a line break', '${'.repeat(200_000) + '\n}'],
    ['$ and {', '${${$'.repeat(100_000)],
  ])('takes linear time: %s', (_name, text) => {
    const start = Date.now();
    variableMatches(text);
    unresolvedCliVariables(text);
    substituteCliVariables(text, helperCliVariables('acme/api'));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('textLengths (hotfix review 1, N5)', () => {
  it('counts string values and keys, without recursion', () => {
    expect(textLengths({ ab: ['cde', 1, null, { f: 'ghij' }] })).toEqual({ longest: 4, total: 10 });
    let deep: unknown = 'x';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(textLengths(deep)).toEqual({ longest: 1, total: 1 });
    expect(textLengths('y'.repeat(MAX_CLI_TEXT_LENGTH + 1)).longest).toBe(MAX_CLI_TEXT_LENGTH + 1);
  });
});

describe('the known variables of the helper process (hotfix review 1, N4)', () => {
  it('HOME is /root: the helper runs as root', () => {
    expect(HELPER_KNOWN_ENV).toEqual({ HOME: '/root' });
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../../../resources/helper/Dockerfile'), 'utf8');
    expect(dockerfile).not.toMatch(/^\s*USER\b/im);
    expect(dockerfile).not.toMatch(/^\s*ENV\s+HOME\b/im);
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the batch helper
    // container (batchRunArgs) gets no user and no HOME (was: helperRunArgs), and its steps of the Dev Container CLI run
    // as root with the variables of the helper (no owner, not the Git user).
    const args = batchRunArgs({ session: 'a'.repeat(24), volume: 'v', image: `sha256:${'1'.repeat(64)}`, socket: '/var/run/docker.sock', scriptHash: 'f'.repeat(64) });
    expect(args.filter((arg) => arg === '--user' || arg === '-u' || arg.startsWith('--user=') || arg.startsWith('HOME='))).toEqual([]);
    for (const step of [
      batchStepCommand('readConfiguration', { repository: 'o/r', configPath: 'a.json', environmentId: 'e', merged: true }),
      batchStepCommand('build', { repository: 'o/r', configPath: 'a.json', imageName: 'devenv-x:1' }),
      batchStepCommand('up', { repository: 'o/r', override: {}, environmentId: 'e', removeExistingContainer: false }),
      batchStepCommand('runUserCommands', { repository: 'o/r', override: {}, environmentId: 'e', containerId: 'c'.repeat(64) }),
    ]) {
      expect(step.owner).toBeUndefined();
      expect(step.git).toBe(false);
      expect(step.env.HOME).toBeUndefined();
    }
  });
});

// Guard (hotfix review 4, Q1; hotfix review 5, A5-1): the workspace folder of Dev Container CLI 0.89.0 at `up`.
// read-configuration and build call Ri on the folder of `--workspace-folder` itself: a folder whose posix extension is
// `.code-workspace` (case-sensitive) is read as a workspace file, and they use its parent folder. `up` (kW) calls Ri
// on `<folder>/<basename>` for such a folder, whose parent is the folder itself: at `up`, localWorkspaceFolder is the
// repository folder for every name. Both are sliced from the bundle and must still read as below.
const CLI_WORKSPACE_SOURCE =
  'function Ri(e,A){if(Rp(A)){let t=e.dirname(A);return{isWorkspaceFile:!0,workspaceOrFolderPath:A,rootFolderPath:t,configFolderPath:t}}' +
  'return{isWorkspaceFile:!1,workspaceOrFolderPath:A,rootFolderPath:A,configFolderPath:A}}function Rp(e){return TG.extname(e)===".code-workspace"}';
// kW (`up`): a = cliHost.cwd, the resolved `--workspace-folder`; A = { hostPath } of the same folder.
const CLI_UP_WORKSPACE_EXPRESSION = 'E=A&&Ri(g.path,Rp(A.hostPath)?g.path.join(a,OG.basename(A.hostPath)):a)';

type WorkspaceOf = (folder: string) => { rootFolderPath: string };

describe('helperCliVariables: the workspace folder as `devcontainer up` uses it (hotfix review 4, Q1; hotfix review 5, A5-1)', () => {
  const bundle = fs.readFileSync(path.join(CLI_FOLDER, 'dist', 'spec-node', 'devContainersSpecCLI.js'), 'utf8');
  // Ri and Rp, sliced from the bundle.
  const riStart = bundle.indexOf('function Ri(e,A)');
  const riEnd = bundle.indexOf('}', bundle.indexOf('function Rp(e)', riStart)) + 1;
  const riSource = bundle.slice(riStart, riEnd);
  const { Ri, Rp } = new Function('TG', `${riSource}\nreturn { Ri, Rp };`)(path.posix) as {
    Ri: (pathModule: typeof path.posix, folder: string) => { rootFolderPath: string };
    Rp: (folder: string) => boolean;
  };
  // The expression of kW, sliced from the bundle.
  const kwStart = bundle.indexOf('E=A&&Ri(g.path,');
  const kwSource = bundle.slice(kwStart, bundle.indexOf(':a)', kwStart) + 3);
  const upWorkspace: WorkspaceOf = (folder) =>
    new Function('Ri', 'Rp', 'OG', 'g', 'a', 'A', `let ${kwSource}; return E;`)(Ri, Rp, path.posix, { path: path.posix }, folder, { hostPath: folder });
  const readConfigurationWorkspace: WorkspaceOf = (folder) => Ri(path.posix, folder);

  it('the slices are the code of the installed CLI', () => {
    expect(riSource).toBe(CLI_WORKSPACE_SOURCE);
    expect(kwSource).toBe(CLI_UP_WORKSPACE_EXPRESSION);
    expect(bundle.includes(`a=g.cwd,${CLI_UP_WORKSPACE_EXPRESSION},`)).toBe(true);
  });

  it.each(['x.code-workspace', 'a.b.code-workspace', '.code-workspace', 'plain', 'x.CODE-WORKSPACE', 'a.code-workspace.git'])(
    'acme/%s: the same workspace folders and results as `up`',
    (name) => {
      const folder = `/workspaces/${name}`;
      const variables = helperCliVariables(`acme/${name}`);
      const up = upWorkspace(folder).rootFolderPath;
      expect(up).toBe(folder);
      expect(variables.localWorkspaceFolder).toBe(up);
      expect(variables.containerWorkspaceFolder).toBe(folder);
      const value = 'source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/x|${localWorkspaceFolder}|${containerWorkspaceFolderBasename}';
      const context = { localWorkspaceFolder: up, containerWorkspaceFolder: folder, env: { HOME: '/root' } };
      expect(substituteCliVariables(value, variables)).toBe(cliUp(value, context));
    },
  );

  it('read-configuration and build use /workspaces for a folder named *.code-workspace, `up` does not', () => {
    expect(readConfigurationWorkspace('/workspaces/x.code-workspace').rootFolderPath).toBe('/workspaces');
    expect(readConfigurationWorkspace('/workspaces/a.b.code-workspace').rootFolderPath).toBe('/workspaces');
    expect(readConfigurationWorkspace('/workspaces/x.CODE-WORKSPACE').rootFolderPath).toBe('/workspaces/x.CODE-WORKSPACE');
    expect(upWorkspace('/workspaces/x.code-workspace').rootFolderPath).toBe('/workspaces/x.code-workspace');
  });

  it('a repository named *.code-workspace: localWorkspaceFolderBasename is the repository name', () => {
    // hotfix review 5, A5-1: was `workspaces-node_modules` (read-configuration's folder); `up` uses the repository folder.
    expect(substituteCliVariables('${localWorkspaceFolderBasename}-node_modules', helperCliVariables('acme/x.code-workspace'))).toBe('x.code-workspace-node_modules');
    expect(substituteCliVariables('${localWorkspaceFolderBasename}', helperCliVariables('acme/.code-workspace'))).toBe('.code-workspace');
    expect(substituteCliVariables('${localWorkspaceFolderBasename}', helperCliVariables('acme/x.CODE-WORKSPACE'))).toBe('x.CODE-WORKSPACE');
  });
});

describe('devcontainerIdOf: `${devcontainerId}` as Dev Container CLI 0.89.0 computes it (review round 17, D17-1)', () => {
  // The CLI's function `ht`, which makes the object of the `--id-label` values for Q_, copied verbatim (checked below).
  const CLI_ID_LABELS_SOURCE = 'function ht(e){return(e||[]).reduce((A,t)=>{let i=t.indexOf("=");return i!==-1&&(A[t.substring(0,i)]=t.substring(i+1)),A},{})}';
  const ht = new Function(`${CLI_ID_LABELS_SOURCE}\nreturn ht;`)() as (labels: readonly string[]) => Record<string, string>;
  const cliId = (labels: readonly string[]): string => cli.Q_(ht(labels));

  it('the copy of `ht` is the code of the installed CLI', () => {
    const bundle = fs.readFileSync(path.join(CLI_FOLDER, 'dist', 'spec-node', 'devContainersSpecCLI.js'), 'utf8');
    expect(bundle.includes(CLI_ID_LABELS_SOURCE)).toBe(true);
  });

  it.each<[string, string[]]>([
    ['the id label of the pipeline', [environmentIdLabel('3f2a9c1e-0000-4000-8000-000000000001')]],
    ['another environment', [environmentIdLabel('7c1d2e3f-1111-4222-8333-444444444444')]],
    ['two labels, not sorted', ['z.label=1', 'a.label=2']],
    ['a value with `=`, quotes, and non-ASCII text', ['k=a=b"c\\d', 'ü=ß']],
    ['a label without `=` is dropped, a later one of the same name wins', ['nolabel', 'k=1', 'k=2']],
    ['no labels', []],
    ['an empty value', ['k=']],
  ])('%s', (_name, labels) => {
    const ours = devcontainerIdOf(labels);
    expect(ours).toBe(cliId(labels));
    expect(ours).toMatch(/^[0-9a-v]{52}$/);
  });

  it('environmentDevcontainerId: the ID for the single id label that the pipeline passes', () => {
    const id = '3f2a9c1e-0000-4000-8000-000000000001';
    expect(environmentDevcontainerId(id)).toBe(cli.Q_(ID_LABELS));
    expect(environmentDevcontainerId(id)).toBe(cliId([`nimblescape.devenv.environment-id=${id}`]));
    expect(environmentDevcontainerId(id)).not.toBe(DEVCONTAINER_ID_PLACEHOLDER);
    expect(environmentDevcontainerId(id)).not.toBe(environmentDevcontainerId('7c1d2e3f-1111-4222-8333-444444444444'));
  });
});

describe('helperCliVariables of a Docker Compose run (review round 18, D18-1)', () => {
  it('knows COMPOSE_PROJECT_NAME, which the pipeline passes to the CLI runs of Docker Compose, with its value', () => {
    const variables = helperCliVariables('acme/api', { COMPOSE_PROJECT_NAME: 'devenv-3f2a9c1e' });
    expect(variables.env).toEqual({ HOME: '/root', COMPOSE_PROJECT_NAME: 'devenv-3f2a9c1e' });
    expect(substituteCliVariables('source=cache${localEnv:COMPOSE_PROJECT_NAME},target=/c,type=volume', variables)).toBe('source=cachedevenv-3f2a9c1e,target=/c,type=volume');
    const { names } = composeMountVolumes('devenv-3f2a9c1e', [['source=cache${localEnv:COMPOSE_PROJECT_NAME},target=/c,type=volume']], variables);
    expect(names).toEqual(['devenv-3f2a9c1e_cachedevenv-3f2a9c1e']);
  });

  it('a single container: COMPOSE_PROJECT_NAME is not set, and no variable of the helper process', () => {
    expect(helperCliVariables('acme/api').env).toEqual({ HOME: '/root' });
    expect(substituteCliVariables('cache${localEnv:COMPOSE_PROJECT_NAME}', helperCliVariables('acme/api'))).toBe('cache');
    expect(HELPER_PROCESS_ENV_NAMES).not.toContain('COMPOSE_PROJECT_NAME');
  });
});
