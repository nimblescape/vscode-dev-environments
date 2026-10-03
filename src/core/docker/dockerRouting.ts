// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR A: which Docker calls of ContainerAdapter may go through the worker (the helper channel,
// src/core/helperChannel), and which of them only read. Pure functions; no I/O. No `vscode`.
//
// A call is routed only when it is plain: its arguments are all it has. Nothing with an input, an environment, a
// working folder, or streamed output is routed, and no call that names an environment variable (-e, --env, --env-file),
// so no token can go through the worker. No global option (-H, --context, --config, …): the worker has its own engine
// and no config folder of the user. Only the commands of the allowlist below; everything else (create, start, build,
// pull, push, cp, context, login, compose, buildx, logs, events, prune, …) stays direct.
// Live check of 2026-10-03 (the first Start on a remote host): two calls of an open that went directly over SSH and
// took 16 of its 37 s go through the worker too: the label build of the environment image (labelBuildCall, the only
// call with an input, which is never a secret) and a helper run with a cleanup label (helperRunCleanup), whose cleanup
// label the worker gets, so that a cancel removes its container.
import { MAX_DOCKER_INPUT_LENGTH, isCleanupLabel } from '../helperChannel/protocol';
import { LABEL_CHANNEL_STEP } from '../names';
import type { RunOptions } from '../ports';

/** Options of the Docker CLI before the command that take a value (`docker -H ssh://box info`). */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-H', '--host', '-c', '--context', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);

/** Docker commands that only read: `docker <command>`, or `docker <object> <command>`. */
const READ_ONLY_COMMANDS = new Set(['info', 'version', 'ps', 'images', 'inspect']);
const READ_ONLY_OBJECT_COMMANDS: Record<string, readonly string[]> = {
  container: ['inspect', 'ls', 'list', 'ps'],
  image: ['inspect', 'ls', 'list', 'history'],
  volume: ['inspect', 'ls', 'list'],
  network: ['inspect', 'ls', 'list'],
  context: ['inspect', 'ls', 'list', 'show'],
  system: ['info', 'df'],
};

/** The commands that may go through the worker: `docker <command>`, or `docker <object> <command>`. */
// User decision 2026-10-03: `tag` and `image tag` too (the Session Monitor tag of the helper image).
const ROUTABLE_COMMANDS = new Set(['ps', 'inspect', 'info', 'version', 'images', 'stop', 'rm', 'rmi', 'rename', 'exec', 'tag']);
const ROUTABLE_OBJECT_COMMANDS: Record<string, readonly string[]> = {
  container: ['inspect', 'ls', 'ps', 'stop', 'rm', 'rename'],
  image: ['inspect', 'ls', 'rm', 'tag'],
  volume: ['inspect', 'ls', 'rm', 'create'],
  network: ['inspect', 'ls', 'rm'],
};

/** The first two words after the global options of the Docker CLI (`docker -H ssh://box image inspect x` → image inspect). */
export function dockerCommandWords(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += GLOBAL_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1;
  return args.slice(i, i + 2);
}

/**
 * True for a Docker call that only reads (inspect, ls, ps, info, version…), which may run again without any effect.
 * Everything else (create, run, exec, start, stop, rm, build, pull, …) is never repeated.
 */
export function isReadOnlyDockerCall(args: readonly string[]): boolean {
  const [command, subcommand] = dockerCommandWords(args);
  if (command === undefined) return false;
  if (READ_ONLY_COMMANDS.has(command)) return true;
  return READ_ONLY_OBJECT_COMMANDS[command]?.includes(subcommand ?? '') ?? false;
}

/** A group of short options (`-e`, `-it`, `-eKEY=value`, `-e=KEY`) whose letters before any `=` contain `letter`. */
function shortOptionsContain(arg: string, letter: string): boolean {
  return /^-[^-]/.test(arg) && arg.split('=')[0].includes(letter);
}

/**
 * -e, --env, --env=…, --env-file, --env-file=…, and any group of short options with an `e`: anywhere in the arguments
 * (also in the command of an exec; such a call just stays direct).
 */
function namesEnvironment(arg: string): boolean {
  return arg === '--env' || arg.startsWith('--env=') || arg === '--env-file' || arg.startsWith('--env-file=') || shortOptionsContain(arg, 'e');
}

/** -i, --interactive, or a group of short options with an `i` (-it). */
function isInteractive(arg: string): boolean {
  return arg === '--interactive' || arg.startsWith('--interactive=') || shortOptionsContain(arg, 'i');
}

/**
 * Plan step 5, PR A: true when `docker <args>` with `options` may go through the worker (see the module comment). A
 * call with any option but its time limit and its signal is never routed.
 */
export function isRoutableDockerCall(args: readonly string[], options: RunOptions = {}): boolean {
  if (options.env !== undefined || options.cwd !== undefined) return false;
  if (options.onStdout !== undefined || options.onStderr !== undefined) return false;
  const [command, subcommand] = args;
  // No global option before the command.
  if (command === undefined || command.startsWith('-')) return false;
  if (args.some(namesEnvironment)) return false;
  // Live check of 2026-10-03: the only call with an input that is routed.
  if (options.input !== undefined) return options.input.length <= MAX_DOCKER_INPUT_LENGTH && labelBuildCall(args);
  if (command === 'exec') return !args.some(isInteractive);
  if (command === 'run') return helperRunCleanup(args) !== undefined;
  if (ROUTABLE_COMMANDS.has(command)) return true;
  return ROUTABLE_OBJECT_COMMANDS[command]?.includes(subcommand ?? '') ?? false;
}

/**
 * Live check of 2026-10-03: the label build of an environment image (ContainerAdapter.labelImage), exactly
 * `docker build --quiet -t <image> [--label <key=value>]… -`, whose Dockerfile (`FROM <image>`) is the input.
 */
export function labelBuildCall(args: readonly string[]): boolean {
  if (args.length < 5 || args[0] !== 'build' || args[1] !== '--quiet' || args[2] !== '-t' || args[args.length - 1] !== '-') return false;
  if (args[3].startsWith('-')) return false;
  const labels = args.slice(4, -1);
  if (labels.length % 2 !== 0) return false;
  for (let i = 0; i < labels.length; i += 2) {
    if (labels[i] !== '--label' || labels[i + 1].startsWith('-') || !labels[i + 1].includes('=')) return false;
  }
  return true;
}

/** -d, --detach, -t, --tty, or a group of short options with a `d` or a `t`. */
function isDetachedOrTerminal(arg: string): boolean {
  return arg === '--detach' || arg.startsWith('--detach=') || arg === '--tty' || arg.startsWith('--tty=') || shortOptionsContain(arg, 'd') || shortOptionsContain(arg, 't');
}

/**
 * Live check of 2026-10-03: the cleanup label value of a helper run that may go through the worker, or undefined:
 * `docker run` with `--rm`, `--pull never`, and exactly one label `nimblescape.devenv.channel-step=<value>` (a valid
 * cleanup label, which the worker gets, so that a cancel removes the container), not interactive, not detached, and
 * without a terminal. A word of the command in the container that looks like such an option (`-path` of `find`) keeps
 * the call direct, as before.
 */
export function helperRunCleanup(args: readonly string[]): string | undefined {
  if (args[0] !== 'run' || !args.includes('--rm')) return undefined;
  if (args.some(isInteractive) || args.some(isDetachedOrTerminal)) return undefined;
  const pull = args.indexOf('--pull');
  if (pull < 0 || args[pull + 1] !== 'never') return undefined;
  const prefix = `${LABEL_CHANNEL_STEP}=`;
  const values: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const label = args[i] === '--label' || args[i] === '-l' ? args[i + 1] : args[i].startsWith('--label=') ? args[i].slice('--label='.length) : undefined;
    if (label !== undefined && label.startsWith(prefix)) values.push(label.slice(prefix.length));
  }
  if (values.length !== 1 || !isCleanupLabel(values[0])) return undefined;
  return values[0];
}
