// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { namePair } from './namePairs';
import {
  EXTENSION_LABEL_KEYS,
  LABEL_PREFIX,
  composeProjectName,
  environmentImageName,
  environmentImageRepository,
  isEnvironmentResourceName,
  resourceName,
} from './names';

const ROOT = path.resolve(__dirname, '..', '..');

/** The TypeScript files of src and test (the Docker tests), with or without the unit tests. */
function codeFiles(tests: boolean): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && (tests || !entry.name.endsWith('.test.ts'))) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  if (tests && fs.existsSync(path.join(ROOT, 'test'))) walk(path.join(ROOT, 'test'));
  return files.sort();
}

/**
 * `source` without its comments: block comments, and line comments that start at the beginning of a line or after white
 * space (so `https://…` in a string stays). TypeScript 7 has no compiler API in its npm package, so the files are not
 * parsed; label keys contain dots and hyphens and never occur as identifiers, so the rest of the text is searched.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/**
 * The label keys with the prefix `prefix` in the code of `files` (not in comments), with the file. A key that the code
 * builds (`'devenv.' + name`, `devenv.${name}`) is the prefix alone.
 */
function labelKeysInCode(files: readonly string[], prefix: string): Array<{ key: string; file: string }> {
  const pattern = new RegExp(`(?<![\\w.-])${prefix.replace(/[.-]/g, '\\$&')}([a-z0-9._-]*)`, 'gi');
  const found: Array<{ key: string; file: string }> = [];
  for (const file of files) {
    for (const match of withoutComments(fs.readFileSync(file, 'utf8')).matchAll(pattern)) {
      found.push({ key: `${prefix}${match[1].replace(/\.+$/, '')}`, file: path.relative(ROOT, file) });
    }
  }
  return found;
}

/** The labels with the prefix devenv. (of other tools, or former ones of the extension) that tests allow. */
const FOREIGN_TEST_LABELS = new Set(['devenv.', 'devenv.fingerprint', 'devenv.inputs', 'devenv.environment-id', 'devenv.compose-service']);

describe('EXTENSION_LABEL_KEYS', () => {
  it('holds every label with LABEL_PREFIX of the code of src, and each of its keys is used there', () => {
    const found = labelKeysInCode(codeFiles(false), LABEL_PREFIX);
    // A new label of the extension belongs in the set (the policy refuses it by its prefix anyway).
    expect(found.filter(({ key, file }) => !EXTENSION_LABEL_KEYS.has(key) && !(key === LABEL_PREFIX && file === 'src/core/names.ts'))).toEqual([]);
    expect([...EXTENSION_LABEL_KEYS].filter((key) => !found.some((entry) => entry.key === key))).toEqual([]);
  });

  it('holds the keys in lower case, each with LABEL_PREFIX', () => {
    expect(LABEL_PREFIX).toBe('nimblescape.devenv.');
    for (const key of EXTENSION_LABEL_KEYS) expect(key).toMatch(/^nimblescape\.devenv\.[a-z0-9][a-z0-9-]*$/);
  });

  it('holds exactly the labels of the extension', () => {
    expect([...EXTENSION_LABEL_KEYS].map((key) => key.slice(LABEL_PREFIX.length)).sort()).toEqual([
      // Changed expectation (review round 4 of PR #64, R4-2/R4-3): the build label of BootstrapDocker.buildImage.
      'build-id',
      // User decisions 2026-10-03: the build record on the environment image (EngineDocker.labelImage).
      'build-record',
      // Review round 1 of the helper channel (S1): the label of the containers that a cancel of an operation removes.
      'channel-step',
      'compose-service',
      'config-path',
      'container-config',
      'container-version',
      'environment-id',
      'helper',
      // User request 2026-09-28 (the helper channel, step 1): the label of the container of a channel.
      'helper-channel',
      'helper-run',
      'host-access',
      // Review round 1 of PR #69 (A-R1-2): changed expectation (before: without it): the nonce label of each create of the
      // remote Session Monitor, by which a failed create removes only its own container.
      'monitor-create',
      'owner-id',
      'repository',
      'service-data',
      'session-monitor',
      'volume',
    ]);
  });

  it('leaves no label with the prefix devenv. in the code, only in the tests of labels of other tools', () => {
    // User report 2026-09-27: another tool named devenv labels its images devenv.…; the extension uses none of these.
    const found = labelKeysInCode(codeFiles(true), 'devenv.');
    expect(found.filter(({ file }) => !file.endsWith('.test.ts'))).toEqual([]);
    expect(found.filter(({ key }) => !FOREIGN_TEST_LABELS.has(key))).toEqual([]);
    expect(found.some(({ key }) => key === 'devenv.fingerprint')).toBe(true);
  });
});

// User decisions 2026-10-03: one name for every resource of an environment, devenv-<owner>-<repo>-<adjective>-<scientist>.
describe('resourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('is devenv-<owner>-<repository>-<pair of the environment ID>', () => {
    expect(resourceName('acme/api', ID)).toBe(`devenv-acme-api-${namePair(ID)}`);
    expect(resourceName('acme/api', ID)).toMatch(/^devenv-acme-api-[a-z]+-[a-z]+$/);
  });

  it('is the same for the same ID and differs by the ID and the repository', () => {
    expect(resourceName('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(resourceName('acme/web', ID)).not.toBe(resourceName('acme/api', ID));
    expect(resourceName('acme/api', '22222222-2222-4222-8222-222222222222')).toBe('devenv-acme-api-noble-berners');
  });

  it('is in lower case, each run of other characters than [a-z0-9] one -', () => {
    expect(resourceName('Acme/My.Repo_Name', ID)).toBe(`devenv-acme-my-repo-name-${namePair(ID)}`);
    expect(resourceName('o/name-with--dashes---', ID)).toBe(`devenv-o-name-with-dashes-${namePair(ID)}`);
    expect(resourceName('-x/._y', ID)).toBe(`devenv-x-y-${namePair(ID)}`);
  });

  it('has at most 63 characters: a long owner and repository are shortened, the pair is kept', () => {
    const name = resourceName(`${'a'.repeat(40)}/${'b'.repeat(40)}`, ID);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith(`devenv-${'a'.repeat(20)}`)).toBe(true);
    expect(name.endsWith(`-${namePair(ID)}`)).toBe(true);
    expect(isEnvironmentResourceName(name)).toBe(true);
    // A cut that ends in a separator drops it.
    const dashed = resourceName(`${'a'.repeat(30)}/${'-b'.repeat(30)}`, ID);
    expect(dashed.length).toBeLessThanOrEqual(63);
    expect(dashed).not.toMatch(/--/);
    expect(dashed.endsWith(`-${namePair(ID)}`)).toBe(true);
    expect(isEnvironmentResourceName(dashed)).toBe(true);
  });

  it('names an owner and repository of only separators `x` (review round 1 of PR #88, B-R1-8)', () => {
    expect(resourceName('-/_', ID)).toBe(`devenv-x-${namePair(ID)}`);
    expect(isEnvironmentResourceName(resourceName('-/_', ID))).toBe(true);
  });

  it('refuses a repository without owner or name', () => {
    expect(() => resourceName('api', ID)).toThrow();
    expect(() => resourceName('acme/', ID)).toThrow();
  });
});

describe('isEnvironmentResourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('refuses `_` and `.` in the name (review round 1 of PR #88, B-R1-7: resourceName never writes them)', () => {
    const name = resourceName('acme/api', ID);
    expect(isEnvironmentResourceName(name.replace('devenv-acme-', 'devenv-acme_'))).toBe(false);
    expect(isEnvironmentResourceName(name.replace('devenv-acme-', 'devenv-acme.'))).toBe(false);
  });

  it.each(['acme/api', 'Acme/My.Repo_Name', 'a/b', 'devenv/x', `${'a'.repeat(40)}/${'b'.repeat(40)}`])('takes the name of an environment of %s', (repository) => {
    expect(isEnvironmentResourceName(resourceName(repository, ID))).toBe(true);
  });

  it.each([
    'devenv-tools-node_modules',
    'devenv-tools',
    'devenv-cache',
    'devenv-helper-cache',
    'devenv-acme-api',
    'devenv-acme-api-3f2a9c1e',
    'devenv-acme-api-tidy',
    'devenv-acme-api-tidy-nobody',
    'devenv-acme-api-nobody-berners',
    'devenv-acme-api-tidy-berners_data',
    'acme-api-tidy-berners',
    'x-devenv-acme-api-tidy-berners',
    '',
  ])('does not take %j for one', (name) => {
    expect(isEnvironmentResourceName(name)).toBe(false);
  });

  it('ignores the case', () => {
    expect(isEnvironmentResourceName('DEVENV-ACME-API-TIDY-BERNERS')).toBe(true);
    expect(isEnvironmentResourceName(resourceName('acme/api', ID).toUpperCase())).toBe(true);
  });
});

describe('the names derived from resourceName', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('the Compose project and the repository of the environment image are resourceName', () => {
    expect(composeProjectName('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(environmentImageRepository('acme/api', ID)).toBe(resourceName('acme/api', ID));
    expect(composeProjectName('Acme/My.Repo', ID)).toBe(resourceName('Acme/My.Repo', ID));
  });

  it('the environment image is <resourceName>:<build number>', () => {
    expect(environmentImageName('acme/api', ID, 3)).toBe(`${resourceName('acme/api', ID)}:3`);
    expect(environmentImageName('acme/api', ID, 1)).toBe('devenv-acme-api-tidy-berners:1');
  });
});
