// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Contract of the Dev Container CLI (implementation notes 8), checked against the CLI package of the pinned version
// (devDependency @devcontainers/cli, the version of the helper image): the options that the helper passes, and the text
// of a failed lifecycle command. A CLI version that renames an option or changes that text fails here, before a release.
// helperImage.test.ts checks that node_modules holds the pinned version.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildArgs, isLifecycleCommandFailure, readConfigurationArgs, upArgs } from './devcontainerCli';
import { buildCommand, upCommand } from './scripts';

const CLI_FOLDER = path.resolve(__dirname, '../../../node_modules/@devcontainers/cli');
const CLI_SCRIPT = path.join(CLI_FOLDER, 'devcontainer.js');
const CLI_BUNDLE = path.join(CLI_FOLDER, 'dist/spec-node/devContainersSpecCLI.js');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  tempDirs.push(dir);
  return dir;
}

/** An option of `devcontainer <command> --help`: whether it is a flag, and its choices if the help lists any. */
interface DocumentedOption {
  boolean: boolean;
  choices?: string[];
}

function documentedOptions(command: string): Map<string, DocumentedOption> {
  const result = spawnSync(process.execPath, [CLI_SCRIPT, command, '--help'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  // The first line names the command, so a removed command does not pass with the general help.
  expect(result.stdout.trimStart().split('\n')[0]).toMatch(new RegExp(`^devcontainer ${command}\\b`));
  const options = new Map<string, DocumentedOption>();
  // Each option starts a line: `  --name  Description  [type] [choices: "a", "b"] [default: …]`. In a wide terminal, a
  // long line wraps, and the next line is indented to the description.
  for (const block of result.stdout.split(/\n(?= {2}--)/)) {
    const name = /^ {2}(--[a-z0-9-]+)\s/.exec(block)?.[1];
    if (!name) continue;
    const choices = /\[choices: ([^\]]*)\]/.exec(block)?.[1];
    options.set(name, {
      boolean: /\[boolean\]/.test(block),
      choices: choices === undefined ? undefined : [...choices.matchAll(/"([^"]*)"/g)].map((match) => match[1]),
    });
  }
  return options;
}

/**
 * The arguments that reach `devcontainer` when the helper runs `command` (`sh -c <script> …`): a fake `devcontainer`
 * on PATH prints them. So options that a script adds (BUILD_SCRIPT: `--no-lockfile`) are included.
 */
function argsThroughScript(command: string[], input = ''): string[] {
  const bin = path.join(tempDir(), 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'devcontainer'), `#!/bin/sh\nprintf '%s\\n' "$@"\n`, { mode: 0o755 });
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    input,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split('\n').slice(0, -1);
}

/**
 * Problems of `args` (the arguments of one CLI command) against the help of the command: an option that the help does
 * not document, a flag with a value, an option without a value, or a value that is not one of the choices.
 */
function contractProblems(args: readonly string[], options: Map<string, DocumentedOption>): string[] {
  const problems: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const [name, inlineValue] = args[i].split(/=(.*)/s, 2);
    const option = options.get(name);
    if (!option) {
      problems.push(`${name} is not documented`);
      continue;
    }
    const next = args[i + 1];
    const value = inlineValue ?? (next !== undefined && !next.startsWith('--') ? next : undefined);
    if (option.boolean) {
      if (value !== undefined) problems.push(`${name} is a flag, but gets the value ${JSON.stringify(value)}`);
    } else if (value === undefined) {
      problems.push(`${name} needs a value`);
    } else if (option.choices && !option.choices.includes(value)) {
      problems.push(`${name} does not accept ${JSON.stringify(value)} (choices: ${option.choices.join(', ')})`);
    }
  }
  return problems;
}

describe('options of the helper against `devcontainer <command> --help`', () => {
  const folder = '/workspaces/api';
  const idLabel = 'devenv.environment-id=3f2a9c1e-0000-4000-8000-000000000000';

  it('read-configuration', () => {
    // WorkspaceHelper.readConfiguration runs `devcontainer <args>` without a script.
    const args = readConfigurationArgs({ workspaceFolder: folder, configPath: `${folder}/.devcontainer/devcontainer.json`, idLabel });
    expect(args[0]).toBe('read-configuration');
    expect(contractProblems(args, documentedOptions('read-configuration'))).toEqual([]);
  });

  it('build, through BUILD_SCRIPT (with --no-lockfile, as for a repository without a lockfile)', () => {
    const config = path.join(tempDir(), 'repo', '.devcontainer', 'devcontainer.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, '{}');
    const builderArgs = buildArgs({ workspaceFolder: folder, configPath: config, imageName: 'devenv-3f2a9c1e:2' });
    const args = argsThroughScript(buildCommand(config, builderArgs));
    expect(args[0]).toBe('build');
    expect(contractProblems(args, documentedOptions('build'))).toEqual([]);
    // Without a lockfile, BUILD_SCRIPT adds its own option to the arguments of buildArgs.
    expect(args.slice(0, builderArgs.length)).toEqual(builderArgs);
    expect(args.length).toBeGreaterThan(builderArgs.length);
  });

  it('up, through UP_SCRIPT (without and with a container to replace)', () => {
    const override = path.join(tempDir(), 'override', 'devcontainer.json');
    const options = documentedOptions('up');
    for (const removeExistingContainer of [false, true]) {
      const builderArgs = upArgs({ workspaceFolder: folder, overrideConfigPath: override, idLabel, removeExistingContainer });
      const args = argsThroughScript(upCommand(override, builderArgs), '{}');
      expect(args[0]).toBe('up');
      expect(contractProblems(args, options)).toEqual([]);
      expect(args).toEqual(builderArgs);
    }
  });

  it('contractProblems finds each kind of problem', () => {
    const options = new Map<string, DocumentedOption>([
      ['--flag', { boolean: true }],
      ['--name', { boolean: false }],
      ['--mode', { boolean: false, choices: ['on', 'off'] }],
    ]);
    expect(contractProblems(['cmd', '--flag', '--name', 'x', '--mode', 'on', '--mode=off'], options)).toEqual([]);
    expect(contractProblems(['cmd', '--other', '--flag', 'x', '--name', '--mode', 'never'], options)).toEqual([
      '--other is not documented',
      '--flag is a flag, but gets the value "x"',
      '--name needs a value',
      '--mode does not accept "never" (choices: on, off)',
    ]);
  });
});

describe('text of a failed lifecycle command in the CLI bundle', () => {
  const bundle = fs.readFileSync(CLI_BUNDLE, 'utf8');

  // The CLI throws `new ContainerError({ description: `${name ? `${name} of ${command}` : command} from ${origin} failed.` })`
  // when a lifecycle command fails; `up` prints this description in its result. The bundle is minified, so the
  // variable names change between versions; the text between them must not.
  const templates = [
    ...bundle.matchAll(/description:`\$\{(\w+)\?`\$\{\1\}([^`$]*)\$\{(\w+)\}`:\3\}([^`$]*)\$\{\w+\}([^`$]*)`/g),
  ];
  // `origin` is `devcontainer.json` or `Feature '<id>'`.
  const origins = [...bundle.matchAll(/(\w+)==="devcontainer\.json"\?\1:`([^`$]*)\$\{\1\}([^`$]*)`/g)];

  it('has exactly one template of the description and of the origin', () => {
    expect(templates.map((match) => match[0])).toHaveLength(1);
    expect(origins.map((match) => match[0])).toHaveLength(1);
  });

  it('gives descriptions that isLifecycleCommandFailure recognizes', () => {
    const [, , of, , from, failed] = templates[0];
    const [, , featurePrefix, featureSuffix] = origins[0];
    const description = (command: string, origin: string, name?: string) =>
      `${name ? `${name}${of}${command}` : command}${from}${origin}${failed}`;
    const examples: string[] = [];
    for (const command of ['onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand']) {
      for (const origin of ['devcontainer.json', `${featurePrefix}ghcr.io/devcontainers/features/node:1${featureSuffix}`]) {
        examples.push(description(command, origin), description(command, origin, 'install'));
      }
    }
    expect(examples).toContain('postCreateCommand from devcontainer.json failed.');
    expect(examples).toContain("install of postStartCommand from Feature 'ghcr.io/devcontainers/features/node:1' failed.");
    for (const text of examples) {
      expect(isLifecycleCommandFailure({ outcome: 'error', containerId: 'c1', description: text }), text).toBe(true);
    }
  });
});
