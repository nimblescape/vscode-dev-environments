// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (section 0 of the plan): the one registry of the scripts that run in a container, and the one primitive
// that runs them. Plan step 11I (PR B): every command of the pipeline in a container is an entry, run by the same
// primitive over the exec that the caller has (DockerEngine or EnvironmentDocker), and no call site builds one. Plan step
// 11I (U2, decision of 2026-10-08): the commands of the Session Monitor container are entries too, and only the entries
// that read a plain input get one.
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { EXISTING_PATHS_SCRIPT, GIT_BRANCH_SCRIPT, GIT_SUMMARY_SCRIPT, OWNERSHIP_FIX_SCRIPT } from '../git/gitSummary';
import { HOME_GIT_CONFIG_SCRIPT } from '../helper/containerGit';
import { TOKEN_REMOVE_SCRIPT, TOKEN_WRITE_SCRIPT } from '../helper/containerToken';
import { SECRET_REGISTRY, SECRET_TOKEN } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import { REMOTE_MONITOR_SCRIPT_PATH, isUnderRecordsLock } from '../remoteMonitor/protocol';
import { CONTAINER_SCRIPTS, runScript, scriptCommand, type ContainerScript, type ScriptEntry, type ScriptExec } from './containerScripts';
import { VSCODE_EXTENSION_SEED_SCRIPT } from './vscodeExtensionSeed';
import { VSCODE_SERVER_LINK_SCRIPT } from './vscodeServerLink';
import type { DockerEngine, EngineExecOptions } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker } from './engineDocker';

function fakeEngine() {
  const execs: { container: string; command: readonly string[]; options: EngineExecOptions }[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    container: async () => undefined,
    containers: async () => [],
    exec: async (container, command, options = {}) => {
      execs.push({ container, command, options });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    stop: async () => {},
    start: async () => {},
  };
  return { engine, execs };
}

/** Plan step 11I (PR B): the entries that are a program of the container itself, with their fixed arguments. */
const COMMAND_ENTRIES: Partial<Record<ContainerScript, readonly string[]>> = {
  check: ['/bin/sh', '-c', 'exit 0'],
  gitVersion: ['git', '--version'],
  mountInfo: ['cat', '/proc/self/mountinfo'],
  userId: ['id', '-u'],
  groupId: ['id', '-g'],
  monitorScriptHash: ['sha256sum', REMOTE_MONITOR_SCRIPT_PATH],
};

describe('the registry of the scripts that run in a container (plan step 11B1)', () => {
  it('names the scripts that the flows run, each with the text that is written and reviewed where it belongs', () => {
    // Review round 2 of PR #114 (A2-L1): changed expectation, no `configOwnershipFix` (it runs only in the batch helper,
    // whose image has GNU find for its `-execdir`; review round 15, K3: never in the dev container). Plan step 11I (PR B):
    // changed expectation, every command of the pipeline in a container is an entry now (branch, check, gitVersion,
    // groupId, mountInfo, monitorScriptHash, userId). Plan step 11I (U2, decision of 2026-10-08): changed expectation, the
    // commands of the Session Monitor are entries too (monitorForget, monitorHeartbeat, monitorImages, monitorSettings).
    // Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): changed expectation, the link of the shared
    // VS Code server in the dev container (vscodeServerLink). Plan step 11H3 (decision of 2026-10-09): changed
    // expectation, the seed of the shared extension cache in the dev container (vscodeExtensionSeed). The live check of
    // 2026-10-10: changed expectation, the check whether the container has the server of the window (vscodeServerPresent).
    expect(Object.keys(CONTAINER_SCRIPTS).sort()).toEqual([
      'branch',
      'check',
      'existingPaths',
      'gitSummary',
      'gitVersion',
      'groupId',
      'homeGitConfig',
      'monitorForget',
      'monitorHeartbeat',
      'monitorImages',
      'monitorScriptHash',
      'monitorSettings',
      'mountInfo',
      'ownershipFix',
      'tokenRemove',
      'tokenWrite',
      'userId',
      'vscodeExtensionSeed',
      'vscodeServerLink',
      'vscodeServerPresent',
    ]);
    expect(CONTAINER_SCRIPTS.tokenWrite.script).toBe(TOKEN_WRITE_SCRIPT);
    // Plan step 11H1: the text of its module, without a secret.
    expect(CONTAINER_SCRIPTS.vscodeServerLink.script).toBe(VSCODE_SERVER_LINK_SCRIPT);
    expect('secretInputName' in CONTAINER_SCRIPTS.vscodeServerLink).toBe(false);
    // Plan step 11H3: the text of its module, without a secret.
    expect(CONTAINER_SCRIPTS.vscodeExtensionSeed.script).toBe(VSCODE_EXTENSION_SEED_SCRIPT);
    expect('secretInputName' in CONTAINER_SCRIPTS.vscodeExtensionSeed).toBe(false);
    expect(CONTAINER_SCRIPTS.tokenRemove.script).toBe(TOKEN_REMOVE_SCRIPT);
    expect(CONTAINER_SCRIPTS.gitSummary.script).toBe(GIT_SUMMARY_SCRIPT);
    // Plan step 11I (PR B): the scripts of the pipeline, each the text of its module.
    expect(CONTAINER_SCRIPTS.branch.script).toBe(GIT_BRANCH_SCRIPT);
    expect(CONTAINER_SCRIPTS.homeGitConfig.script).toBe(HOME_GIT_CONFIG_SCRIPT);
    expect(CONTAINER_SCRIPTS.ownershipFix.script).toBe(OWNERSHIP_FIX_SCRIPT);
    expect(CONTAINER_SCRIPTS.existingPaths.script).toBe(EXISTING_PATHS_SCRIPT);
  });

  it('gives the arguments as positional parameters, never as part of the script', () => {
    expect(scriptCommand('gitSummary', ['/workspaces/app'])).toEqual(['sh', '-c', GIT_SUMMARY_SCRIPT, 'sh', '/workspaces/app']);
    expect(scriptCommand('tokenRemove', [])).toEqual(['sh', '-c', TOKEN_REMOVE_SCRIPT, 'sh']);
    for (const name of Object.keys(CONTAINER_SCRIPTS) as ContainerScript[]) {
      const command = scriptCommand(name, ['a b', '$(whoami)']);
      expect(command.slice(-2), name).toEqual(['a b', '$(whoami)']);
      // Plan step 11I (PR B): changed expectation, an entry of the kind `command` is its program and fixed arguments
      // (no script text); every other entry keeps its script at the third place.
      const entry = CONTAINER_SCRIPTS[name];
      if ('command' in entry) expect(command.slice(0, -2), name).toEqual(entry.command);
      else expect(command[2], name).toBe(entry.script);
    }
  });

  it('runs a script through the one primitive, and only the token script takes a secret', async () => {
    const { engine, execs } = fakeEngine();
    await runScript(engine, 'c1', 'gitSummary', ['/workspaces/app'], { user: 'dev', timeoutMs: 1_000 });
    await runScript(engine, 'c1', 'tokenWrite', ['dev', 'octocat'], { user: 'root' });
    expect(execs[0]).toMatchObject({ container: 'c1', command: scriptCommand('gitSummary', ['/workspaces/app']), options: { user: 'dev', timeoutMs: 1_000 } });
    expect(execs[0].options.secretInputName).toBeUndefined();
    expect(execs[1].options.secretInputName).toBe(SECRET_TOKEN);
    expect(JSON.stringify(execs)).not.toContain('"input"');
  });
});

describe('plan step 11I (PR B): every command of the pipeline in a container is an entry of the registry', () => {
  it('builds the command of each new entry as its call site ran it before', () => {
    // The scripts of the pipeline (before: gitSummaryCommand, homeGitConfigCommand, ownershipFixCommand,
    // existingPathsCommand, tokenWriteCommand), each `sh -c <script> sh <args…>`.
    expect(scriptCommand('branch', ['/workspaces/api'])).toEqual(['sh', '-c', GIT_BRANCH_SCRIPT, 'sh', '/workspaces/api']);
    expect(scriptCommand('homeGitConfig', ['vscode'])).toEqual(['sh', '-c', HOME_GIT_CONFIG_SCRIPT, 'sh', 'vscode']);
    expect(scriptCommand('ownershipFix', ['/workspaces/api', 'vscode', '-path', '/workspaces/api/db'])).toEqual([
      'sh',
      '-c',
      OWNERSHIP_FIX_SCRIPT,
      'sh',
      '/workspaces/api',
      'vscode',
      '-path',
      '/workspaces/api/db',
    ]);
    expect(scriptCommand('existingPaths', ['/workspaces/api/a', '/workspaces/api/b'])).toEqual(['sh', '-c', EXISTING_PATHS_SCRIPT, 'sh', '/workspaces/api/a', '/workspaces/api/b']);
    expect(scriptCommand('tokenWrite', ['vscode', 'octo'])).toEqual(['sh', '-c', TOKEN_WRITE_SCRIPT, 'sh', 'vscode', 'octo']);
    // The programs of the container (before: CONTAINER_CHECK_COMMAND, `git --version`, `cat /proc/self/mountinfo`,
    // `id -u|-g <user>`, `sha256sum REMOTE_MONITOR_SCRIPT_PATH`): exactly the same commands, without a shell.
    expect(scriptCommand('check', [])).toEqual(['/bin/sh', '-c', 'exit 0']);
    expect(scriptCommand('gitVersion', [])).toEqual(['git', '--version']);
    expect(scriptCommand('mountInfo', [])).toEqual(['cat', '/proc/self/mountinfo']);
    expect(scriptCommand('userId', ['vscode'])).toEqual(['id', '-u', 'vscode']);
    expect(scriptCommand('groupId', ['vscode'])).toEqual(['id', '-g', 'vscode']);
    expect(scriptCommand('monitorScriptHash', [])).toEqual(['sha256sum', '/opt/devenv/monitor.js']);
    for (const [name, command] of Object.entries(COMMAND_ENTRIES) as Array<[ContainerScript, readonly string[]]>) {
      expect(CONTAINER_SCRIPTS[name], name).toEqual({ command });
    }
  });

  it('gives a secret input to the token write only, by the name of the token, never as a value of the call', async () => {
    const secretScripts = (Object.keys(CONTAINER_SCRIPTS) as ContainerScript[]).filter((name) => 'secretInputName' in CONTAINER_SCRIPTS[name]);
    expect(secretScripts).toEqual(['tokenWrite']);
    const { engine, execs } = fakeEngine();
    for (const name of Object.keys(CONTAINER_SCRIPTS) as ContainerScript[]) await runScript(engine, 'c1', name, ['x']);
    expect(execs.filter((exec) => exec.options.secretInputName !== undefined).map((exec) => exec.command[2])).toEqual([TOKEN_WRITE_SCRIPT]);
    expect(execs.every((exec) => exec.options.input === undefined)).toBe(true);
  });

  it('passes on only the user, the time limit and the cancel of the caller, never an input or a secret of its own', async () => {
    const { engine, execs } = fakeEngine();
    const signal = new AbortController().signal;
    // A caller that passes more than ScriptOptions (only possible past the types) still runs the script with its entry.
    // Plan step 11I (U2, decision of 2026-10-08): changed fixture, without the input of the caller (`input: 'ghp_value'`
    // before, which runScript dropped); an input for these entries is refused now, below.
    const options = { user: 'root', timeoutMs: 5, signal, secretInputName: SECRET_REGISTRY, workdir: '/' } as unknown as Parameters<typeof runScript>[4];
    await runScript(engine, 'c1', 'gitVersion', [], options);
    await runScript(engine, 'c1', 'tokenWrite', ['dev', ''], options);
    expect(execs.map((exec) => exec.options)).toEqual([
      { user: 'root', timeoutMs: 5, signal },
      { user: 'root', timeoutMs: 5, signal, secretInputName: SECRET_TOKEN },
    ]);
    // Without options, none: the user of the container, the time limit of the port.
    await runScript(engine, 'c1', 'check', []);
    expect(execs[2].options).toEqual({});
    // Plan step 11I (U2, decision of 2026-10-08): changed expectation, an input of the caller for an entry that reads none
    // (before: dropped, and the script ran) rejects, and nothing runs; the token write keeps its secret by its name only.
    const withInput = { ...options, input: 'ghp_value' } as Parameters<typeof runScript>[4];
    await expect(runScript(engine, 'c1', 'gitVersion', [], withInput)).rejects.toThrow('The script gitVersion of the registry takes no input.');
    await expect(runScript(engine, 'c1', 'tokenWrite', ['dev', ''], withInput)).rejects.toThrow('takes no input');
    expect(execs).toHaveLength(3);
    expect(JSON.stringify(execs)).not.toContain('ghp_value');
  });

  it('runs over the exec of the pipeline (EnvironmentDocker, served by EngineDocker) as over the engine: the token by its name only', async () => {
    const { engine, execs } = fakeEngine();
    const docker: ScriptExec = new EngineDocker(engine, silentLogger, (name) => (name === SECRET_TOKEN ? 'ghp_operation' : undefined));
    await runScript(docker, 'c1', 'tokenWrite', ['vscode', 'octo'], { user: 'root', timeoutMs: 30_000 });
    expect(execs).toEqual([{ container: 'c1', command: scriptCommand('tokenWrite', ['vscode', 'octo']), options: { user: 'root', secretInputName: SECRET_TOKEN, timeoutMs: 30_000 } }]);
    expect(JSON.stringify(execs)).not.toContain('ghp_operation');
    // An operation without the token runs nothing (EngineDocker refuses before the engine is asked).
    const without: ScriptExec = new EngineDocker(engine);
    await expect(runScript(without, 'c1', 'tokenWrite', ['vscode', 'octo'], { user: 'root' })).rejects.toThrow('token secret of the operation');
    expect(execs).toHaveLength(1);
  });
});

/** The lock of the records as underRecordsLock of src/core/remoteMonitor/protocol.ts puts it before a command. */
const RECORDS_LOCK = ['flock', '-w', '5', '-E', '75', '/state/.heartbeats.lock', 'timeout', '-s', 'KILL', '10'];

describe('plan step 11I (U2, decision of 2026-10-08): the commands of the Session Monitor are entries of the registry', () => {
  const SOURCE = '0123456789abcdef0123456789abcdef';
  const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
  const HEARTBEAT = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: true, seq: 5 }] };

  // Moved from src/core/remoteMonitor/protocol.test.ts ('passes the heartbeat as one JSON argument, and the ids as
  // arguments': the lines of the removed heartbeatCommand and forgetCommand; 'names the reason of a failed command under
  // the lock of the records': which of them run under the lock) and from monitorFlow.test.ts (the lines of the removed
  // imageSettingsCommand and imagesCommand): the same command lines, built by the registry.
  it('builds exactly the command lines of the removed builders: a heartbeat and a forget under the lock of the records, the image settings and list without it', () => {
    expect(scriptCommand('monitorHeartbeat', [JSON.stringify(HEARTBEAT)])).toEqual([...RECORDS_LOCK, 'node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat', JSON.stringify(HEARTBEAT)]);
    expect(scriptCommand('monitorForget', [SOURCE, ID])).toEqual([...RECORDS_LOCK, 'node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID]);
    expect(scriptCommand('monitorSettings', [])).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'settings', '-']);
    expect(scriptCommand('monitorImages', [])).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'images', '-']);
    expect(isUnderRecordsLock(scriptCommand('monitorHeartbeat', [JSON.stringify(HEARTBEAT)]))).toBe(true);
    expect(isUnderRecordsLock(scriptCommand('monitorForget', [SOURCE, ID]))).toBe(true);
    expect(isUnderRecordsLock(scriptCommand('monitorSettings', []))).toBe(false);
    expect(isUnderRecordsLock(scriptCommand('monitorImages', []))).toBe(false);
  });

  it('gives a plain input only to the entries that read one, without a secret, and refuses one for every other entry before anything runs', async () => {
    const plain = (Object.keys(CONTAINER_SCRIPTS) as ContainerScript[]).filter((name) => 'plainInput' in CONTAINER_SCRIPTS[name]);
    expect(plain.sort()).toEqual(['monitorImages', 'monitorSettings']);
    const { engine, execs } = fakeEngine();
    const signal = new AbortController().signal;
    await runScript(engine, 'devenv-session-monitor', 'monitorSettings', [], { input: '{"prefixes":[]}', timeoutMs: 20_000, signal });
    await runScript(engine, 'devenv-session-monitor', 'monitorImages', [], { input: '{"repositories":[]}' });
    expect(execs).toEqual([
      { container: 'devenv-session-monitor', command: ['node', REMOTE_MONITOR_SCRIPT_PATH, 'settings', '-'], options: { input: '{"prefixes":[]}', timeoutMs: 20_000, signal } },
      { container: 'devenv-session-monitor', command: ['node', REMOTE_MONITOR_SCRIPT_PATH, 'images', '-'], options: { input: '{"repositories":[]}' } },
    ]);
    for (const name of Object.keys(CONTAINER_SCRIPTS) as ContainerScript[]) {
      if (plain.includes(name)) continue;
      await expect(runScript(engine, 'c1', name, ['x'], { input: '' }), name).rejects.toThrow(`The script ${name} of the registry takes no input.`);
    }
    expect(execs).toHaveLength(2);
  });

  // Review round 1 of PR #126 (F3): the type of an entry keeps a plain input and a secret apart; tsc (run with the unit
  // tests) refuses an entry with both, of either kind (each `@ts-expect-error` below fails tsc when the type accepts it,
  // as it did before F3). Either `never` field alone makes the union discriminated, which already refuses both.
  it('refuses an entry with both a plain input and a secret, in its type (review round 1 of PR #126, F3)', () => {
    // @ts-expect-error: a program of the container takes no secret
    const commandWithSecret: ScriptEntry = { command: ['cat'], plainInput: true, secretInputName: SECRET_TOKEN };
    // @ts-expect-error: a script takes no plain input
    const scriptWithInput: ScriptEntry = { program: 'sh', script: 'cat', secretInputName: SECRET_TOKEN, plainInput: true };
    // Each kind alone is an entry.
    const entries: ScriptEntry[] = [{ command: ['cat'], plainInput: true }, { program: 'sh', script: 'cat', secretInputName: SECRET_TOKEN }];
    expect([commandWithSecret, scriptWithInput, ...entries]).toHaveLength(4);
    for (const entry of Object.values(CONTAINER_SCRIPTS) as ScriptEntry[]) expect('plainInput' in entry && 'secretInputName' in entry).toBe(false);
  });
});

/**
 * Plan step 11I (PR B): `code` (JavaScript without comments) with the text of its strings, template literals (not their
 * `${…}`) and regular expressions blanked, so that only code is left to search. A `/` starts a regular expression where
 * no value ends before it (the characters and words of the language that can come before one, and the end of a block).
 * Known limit (review round 1 of PR #124, A, L-3): a regular expression right after `)` (`if (x) /re/`) is read as a
 * division, so a quote in it can blank the code after it.
 */
function blankLiterals(code: string): string {
  const out = code.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const beforeRegex = /(?:^|[(,=:[!&|?{};+\-*%<>~^}]|\b(?:return|typeof|case|do|else|in|instanceof|new|delete|void|throw|yield|await|of))\s*$/;
  // Scans code from `i` to the `}` that closes a `${` (when `inTemplate`), or to the end; answers the index after it.
  const scanCode = (start: number, inTemplate: boolean): number => {
    let depth = 0;
    let i = start;
    while (i < code.length) {
      const c = code[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
        blank(i + 1, j);
        i = j + 1;
      } else if (c === '`') {
        let j = i + 1;
        while (j < code.length && code[j] !== '`') {
          if (code[j] === '\\') {
            blank(j, j + 2);
            j += 2;
          } else if (code[j] === '$' && code[j + 1] === '{') {
            j = scanCode(j + 2, true);
          } else {
            blank(j, j + 1);
            j++;
          }
        }
        i = j + 1;
      } else if (c === '/' && beforeRegex.test(code.slice(Math.max(0, i - 12), i))) {
        let j = i + 1;
        let inClass = false;
        while (j < code.length && (inClass || code[j] !== '/')) {
          if (code[j] === '\\') j++;
          else if (code[j] === '[') inClass = true;
          else if (code[j] === ']') inClass = false;
          j++;
        }
        blank(i + 1, j);
        i = j + 1;
      } else {
        if (c === '{') depth++;
        if (c === '}') {
          if (depth === 0 && inTemplate) return i + 1;
          depth--;
        }
        i++;
      }
    }
    return i;
  };
  scanCode(0, false);
  return out.join('');
}

/**
 * Plan step 11I (PR B): the calls of `exec` in `code` (blankLiterals) that run a process in a container: two or more
 * arguments (the container, the command, the options; RegExp#exec takes one), and every indirect use (`exec.call`,
 * `exec.apply`, `exec.bind`), each with the code around it. Review round 1 of PR #124 (A, L-3): also an optional call
 * (`exec?.(`), a call whose first argument is spread (`exec(...args)`: its count is unknown), `exec` taken as a value
 * (`const run = docker.exec`), by a computed name (`docker['exec']`, read in `original`, the code before the blanking),
 * or by destructuring (`const { exec } = docker`).
 */
function containerExecs(code: string, original: string = code): string[] {
  const found: string[] = [];
  const around = (at: number) => code.slice(Math.max(0, at - 40), at + 80);
  for (const match of code.matchAll(/\.\s*exec\b\s*(\?\.\s*\(|\(|\.\s*(?:call|apply|bind)\b|)/g)) {
    const at = match.index ?? 0;
    if (!match[1].endsWith('(')) {
      // An indirect use, or `exec` as a value (no call).
      found.push(around(at));
      continue;
    }
    const first = at + match[0].length;
    if (code.slice(first).trimStart().startsWith('...')) {
      found.push(around(at));
      continue;
    }
    let depth = 0;
    let commas = 0;
    for (let i = first; i < code.length; i++) {
      const c = code[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) commas++;
    }
    if (commas > 0) found.push(around(at));
  }
  // A computed name: the brackets are code (they survive the blanking) and hold the string `exec`.
  for (const match of original.matchAll(/\[\s*(['"`])exec\1\s*\]/g)) {
    const at = match.index ?? 0;
    if (code[at] === '[' && code[at + match[0].length - 1] === ']') found.push(around(at));
  }
  // Destructuring: an object pattern with `exec` that is assigned (`{ exec } =`, `{ exec: run } =`).
  for (const match of code.matchAll(/\{(?:[^{}]*?[,\s])?exec\s*(?=[,}:=])[^{}]*\}\s*=(?![=>])/g)) found.push(around(match.index ?? 0));
  return found;
}

const SRC = path.resolve(__dirname, '..', '..');

/** The source files of the product (src/, without the tests and their kits). */
function productSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(entry.name)) files.push(full);
    }
  };
  walk(SRC);
  return files.sort();
}

/**
 * The files that may call `exec` of a port with a command: the registry's runner, and EngineDocker (the pipeline's port
 * over DockerEngine.exec, which passes the command of its caller on). Plan step 11I (U2, decision of 2026-10-08): changed
 * expectation, the commands of the Session Monitor container are entries of the registry (monitorFlow.ts runs them with
 * runScript), so monitorFlow.ts is no exception any more.
 */
const EXEC_CALLERS: Readonly<Record<string, number>> = {
  'core/worker/containerScripts.ts': 1,
  'core/worker/engineDocker.ts': 1,
  // Review round 1 of PR #124 (A, L-3): `exec` as a value is found too. The Session Monitor's process hands its own
  // execFile of its container (`deps.exec`, the removal of a record) to its loop: no exec of a container of the engine.
  'remoteMonitor/main.ts': 1,
};

describe('plan step 11I (PR B): no call site builds a command of its own (section 0 of the plan)', () => {
  it('finds a call of exec with a command, and none of RegExp#exec, in strings, comments or regular expressions', () => {
    const scan = (source: string) => containerExecs(blankLiterals(source), source);
    // The calls that the pipeline made before this step.
    expect(scan("const r = await this.deps.docker.exec(container.id, ['cat', '/proc/self/mountinfo'], { user: 'root' });")).toHaveLength(1);
    expect(scan('const r=await docker.exec(container,["git","-c","safe.directory=*","-C",folder,"branch","--show-current"],{user,timeoutMs:BRANCH_EXEC_TIMEOUT_MS,signal})')).toHaveLength(1);
    expect(scan('const run=this.deps.docker.exec.bind(this.deps.docker);')).toHaveLength(1);
    // RegExp#exec, also with commas and brackets in its argument, and text that only looks like a call.
    expect(scan('const m=/^(\\S+) (\\[.*\\])$/.exec(line.trim());const n=re.exec(text.slice(a,b));')).toEqual([]);
    expect(scan('const x=pattern.exec(s.replace(/[(,]/g,""));const t="docker.exec(a, b)";const u=`engine.exec(${"c"}, d)`;')).toEqual([]);
    expect(scan('if(a)return/,/.exec(b);const v=c/d.exec(e)')).toEqual([]);
    // Review round 1 of PR #124 (A, L-3): the other ways to run a command through exec.
    for (const call of [
      'await docker.exec?.(c,cmd);',
      'await docker?.exec(c,cmd);',
      'await docker["exec"](c,cmd);',
      "await docker['exec'](c,cmd);",
      'const{exec}=docker;await exec(c,cmd);',
      'const{exec:run}=this.deps.docker;',
      'const run=(...a)=>docker.exec(...a);',
      'const run=docker.exec;',
      'run(docker.exec);',
      // Review round 1 of PR #124 (B, B-L6, its mutant SCAN04).
      'await Reflect.apply(this.deps.docker.exec,this.deps.docker,[c,cmd,{user}]);',
    ]) {
      expect(scan(call), call).toHaveLength(1);
    }
    // Still no call: the text of a string, and an object or a pattern without `exec`.
    expect(scan('const t="docker[\'exec\'](c, cmd)";const{executable}=x;const o={exec:1};')).toEqual([]);
  });

  // Plan step 11I (U2, decision of 2026-10-08): the name no longer says "(and the commands of the monitor, pending U2)".
  it('src runs a process in a container only through the registry', async () => {
    const calls: Record<string, number> = {};
    const files = productSources();
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const { code } = await esbuild.transform(fs.readFileSync(file, 'utf8'), { loader: 'ts', minifyWhitespace: true, legalComments: 'none', target: 'es2022' });
      const found = containerExecs(blankLiterals(code), code);
      if (found.length > 0) calls[path.relative(SRC, file).split(path.sep).join('/')] = found.length;
    }
    expect(calls).toEqual(EXEC_CALLERS);
  });
});
