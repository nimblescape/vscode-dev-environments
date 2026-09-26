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
import { OVERRIDE_CONFIG_PATH, OVERRIDE_FOLDER, buildCommand, upCommand, writeAndRunCommand } from './scripts';

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
  const result = spawnSync(command[0] === 'node' ? process.execPath : command[0], command.slice(1), {
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

  // Docker Compose (implementation notes, section "Docker Compose"): the runs through WRITE_AND_RUN_SCRIPT. Its folder
  // argument is a temporary folder here, so the test writes nothing to OVERRIDE_FOLDER of this computer.
  function throughWriteAndRun(command: string[]): string[] {
    expect(command[3]).toBe(OVERRIDE_FOLDER);
    const local = [...command];
    local[3] = path.join(tempDir(), 'override');
    return argsThroughScript(local, JSON.stringify({ files: {} }));
  }

  it('read-configuration with --override-config, through WRITE_AND_RUN_SCRIPT', () => {
    const builderArgs = readConfigurationArgs({
      workspaceFolder: folder,
      configPath: `${folder}/.devcontainer/devcontainer.json`,
      idLabel,
      overrideConfigPath: OVERRIDE_CONFIG_PATH,
    });
    const args = throughWriteAndRun(writeAndRunCommand({}, builderArgs));
    expect(args).toEqual(builderArgs);
    expect(contractProblems(args, documentedOptions('read-configuration'))).toEqual([]);
  });

  it('build with our copy of the configuration as --config, through WRITE_AND_RUN_SCRIPT (build has no --override-config)', () => {
    const options = documentedOptions('build');
    expect(options.has('--override-config')).toBe(false);
    const repositoryConfig = path.join(tempDir(), 'repo', '.devcontainer', 'devcontainer.json');
    fs.mkdirSync(path.dirname(repositoryConfig), { recursive: true });
    fs.writeFileSync(repositoryConfig, '{}');
    const builderArgs = buildArgs({ workspaceFolder: folder, configPath: OVERRIDE_CONFIG_PATH, imageName: 'devenv-3f2a9c1e:2' });
    const args = throughWriteAndRun(writeAndRunCommand({ repositoryConfig }, builderArgs));
    expect(args.slice(0, builderArgs.length)).toEqual(builderArgs);
    expect(args).toContain('--no-lockfile');
    expect(contractProblems(args, options)).toEqual([]);
  });

  it('up, through WRITE_AND_RUN_SCRIPT', () => {
    const builderArgs = upArgs({ workspaceFolder: folder, overrideConfigPath: OVERRIDE_CONFIG_PATH, idLabel, removeExistingContainer: true });
    const args = throughWriteAndRun(writeAndRunCommand({}, builderArgs));
    expect(args).toEqual(builderArgs);
    expect(contractProblems(args, documentedOptions('up'))).toEqual([]);
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

describe('Docker Compose in the CLI bundle (implementation notes, section "Docker Compose")', () => {
  const bundle = fs.readFileSync(CLI_BUNDLE, 'utf8');

  // The texts of CLI 0.89.0 that the Compose support relies on. A CLI version that changes one of them fails here, and
  // the rule that depends on it must be checked again (compose.ts, devcontainerCli.ts).
  it.each<[string, string]>([
    // The project name: COMPOSE_PROJECT_NAME of the CLI process first (function yp), passed to Compose as --project-name.
    ['the project name from COMPOSE_PROJECT_NAME first', 'o=cg(r.env.COMPOSE_PROJECT_NAME||"",n);if(o)return o;'],
    ['the project name passed to Compose', 'let P=["--project-name",A,...n]'],
    // The override configuration replaces the configuration, whose path stays the base of relative paths.
    ['the override configuration replaces the configuration', 'readDocument(s??t)'],
    ['the configuration path stays', 'B.configFilePath=t'],
    ['dockerComposeFile relative to the configuration', 'function sg(e,A,t){return rj(e,A.configFilePath,t)}'],
    // workspaceMount is ignored for Compose (the model mounts the workspace volume).
    ['no workspaceMount for Compose', 'if("dockerComposeFile"in t)return{workspaceFolder:pp(t),workspaceMount:void 0'],
    // The model of `config` with all profiles.
    ['config with all profiles', 'push("--profile","*")'],
    // The dev container is found by the project and the service.
    ['the project label', 'kG="com.docker.compose.project"'],
    ['the generated compose file of the container', '"docker-compose.devcontainer.containerFeatures"'],
    ['an existing dev container is started without recreating', '"--no-recreate"'],
    // The result of `up` names the project, which the pipeline compares with the project of the environment (L-2).
    ['the project name in the result of up', '{containerId:g,composeProjectName:C,'],
    // `build --image-name` tags the built dev service image.
    ['the image name of the built dev service', 'OA=mA||RA.image||mp('],
    ['the tag of the built dev service', 'Oe(q,"tag",OA,bA)'],
    // The CLI reads the Dockerfile of the dev service itself (no dockerfile_inline), relative to the context.
    ['the build of a service', 'dockerfilePath:r.dockerfile??"Dockerfile"'],
    ['an absolute Dockerfile', 'f.path.isAbsolute(CA)?CA:SG.default.resolve(uA,CA)'],
    // The image of the Features of an image-only service: vsc-<folder name>-<hash> (D-8).
    ['the shared image name of an image-only service', 'return HN(`vsc-${i}-${t}`)'],
    // Named volumes of `mounts` become volumes of the project (composeMountVolumeName).
    ['the top-level volumes of mounts', 'c=u.filter(b=>b.type==="volume"&&b.source)'],
    // `build` has no override configuration.
    ['build without --override-config', 'configFile:v,overrideConfigFile:J'],
    // Review round 1 (D2, imageLabelItems): the only label that the CLI puts on the images that it builds; the other
    // `devcontainer.` labels of the CLI are labels of containers.
    ['the metadata label of images', 'var EI="devcontainer.metadata"'],
    ['the labels of containers', 'var hg="devcontainer.local_folder",lI="devcontainer.config_file"'],
    // Review round 3 (D3-2): with `--id-label`, the id labels replace devcontainer.local_folder and
    // devcontainer.config_file, so the containers of the extension do not name their configuration.
    ['the id labels replace the labels of the folder and the configuration', 'if(t)return{container:A?await Dr(e,A):await Tr(e,t),idLabels:t}'],
  ])('%s', (_name, text) => {
    expect(bundle.split(text).length - 1, text).toBe(1);
  });

  it('the build handler sets no override configuration', () => {
    expect(bundle).toMatch(/v=r\?Fe\.file\(Le\.resolve\(process\.cwd\(\),r\)\):void 0,J=void 0,/);
  });
});
