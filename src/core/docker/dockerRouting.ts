// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR A: which Docker calls of ContainerAdapter may go through the worker (the helper channel,
// src/core/helperChannel), and which of them only read. Pure functions; no I/O. No `vscode`.
//
// A call is routed only when it is plain: its arguments are all it has. Nothing with an input, an environment, a
// working folder, or streamed output is routed, and no call that names an environment variable (-e, --env, --env-file),
// so no token can go through the worker. No global option (-H, --context, --config, …): the worker has its own engine
// and no config folder of the user. Only the commands of the allowlist below; everything else (run, create, start,
// build, pull, push, cp, context, login, compose, buildx, logs, events, prune, …) stays direct.
import type { RunOptions } from '../ports';

// Plan step 11F2: the command words and the read-only calls moved to dockerCli.ts (the bootstrap's Docker CLI uses them).
import { dockerCommandWords, isReadOnlyDockerCall } from './dockerCli';

export { dockerCommandWords, isReadOnlyDockerCall };

/** The commands that may go through the worker: `docker <command>`, or `docker <object> <command>`. */
const ROUTABLE_COMMANDS = new Set(['ps', 'inspect', 'info', 'version', 'images', 'stop', 'rm', 'rmi', 'rename', 'exec']);
const ROUTABLE_OBJECT_COMMANDS: Record<string, readonly string[]> = {
  container: ['inspect', 'ls', 'ps', 'stop', 'rm', 'rename'],
  image: ['inspect', 'ls', 'rm'],
  volume: ['inspect', 'ls', 'rm', 'create'],
  network: ['inspect', 'ls', 'rm'],
};

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
  if (options.input !== undefined || options.env !== undefined || options.cwd !== undefined) return false;
  if (options.onStdout !== undefined || options.onStderr !== undefined) return false;
  const [command, subcommand] = args;
  // No global option before the command.
  if (command === undefined || command.startsWith('-')) return false;
  if (args.some(namesEnvironment)) return false;
  if (command === 'exec') return !args.some(isInteractive);
  if (ROUTABLE_COMMANDS.has(command)) return true;
  return ROUTABLE_OBJECT_COMMANDS[command]?.includes(subcommand ?? '') ?? false;
}
