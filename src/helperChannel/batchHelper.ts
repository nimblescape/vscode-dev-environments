// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the batch helper (src/core/helperChannel/batch.ts), a second ChannelServer in the helper container
// of one operation, loaded by the worker with the same script (main.ts, startBatchHelper). Its operations are the fixed
// step kinds of src/core/helper/batchSteps.ts: each step builds its command from the builders that WorkspaceHelper uses
// too and never runs a command line that it was sent (plan step 7: the only path of the volume steps). The steps run one at a time, each in a process group of its own; its time
// limit or its cancel ends that group alone (SIGTERM, then SIGKILL), and the session stays usable.
//
// Isolation in the one container (Q2 of 2026-10-01). The helper runs as root. The socket lies in BATCH_SOCKET_FOLDER,
// which only root can enter; /var/run/docker.sock links to it for the root steps (DOCKER_HOST is never set). Git (the
// clone) runs as BATCH_GIT_UID (`setpriv`, no groups, no capabilities, no new privileges, HOME=/nonexistent): it cannot
// reach the socket; CONFIG_FOLDER is closed to it for the step; the secrets tmpfs is its own only during its own step
// (its token); /workspaces is writable like /tmp (sticky) only during the step. After the step, every process of that
// user is killed, its files in /workspaces get root (as the clone of the per-step helper had), its files elsewhere in the
// container are removed, and the modes are restored. The variables of a step are set on its process only, after the
// variables of the container; the secret is only ever the standard input of a step, and is masked in all output.
//
// User decision of 2026-10-01 ("we shall run as the repo owner user. that is what a real user would do as well."): the
// Docker Compose read steps (composeModel, composeHash), and by the agreed extension of the same day readFiles,
// listConfigs and createFolders, run as the user that owns the repository folder (its uid:gid,
// read with lstat at step time; as root when root owns it), with HOME=/nonexistent. CONFIG_FOLDER is root's and 0700
// during the Compose steps (it belongs to that user otherwise; review round 1 of PR #84, A-R1-1: only those steps,
// closeConfigFolder); OVERRIDE_FOLDER is new, empty and that user's for the step, and
// is removed after it. After the step every process of that user is killed (not when it is root); its files elsewhere
// are legitimate and stay (no walk).
import { spawn } from 'child_process';
import * as fs from 'fs';
import { BATCH_DOCKER_SOCKET, BATCH_GIT_UID, BATCH_SOCKET_FOLDER } from '../core/helperChannel/batch';
import { BATCH_STEP_KINDS, BatchStepError, COMPOSE_REMOTE_OFF, batchStepCommand, type BatchStepCommand } from '../core/helper/batchSteps';
import { OVERRIDE_FOLDER, SECRETS_FOLDER } from '../core/helper/scripts';
import { CHANNEL_KILL_GRACE_MS, SECRET_TOKEN } from '../core/helperChannel/protocol';
import { CONFIG_FOLDER, HELPER_DOCKER_SOCKET, WORKSPACES_ROOT } from '../core/names';
import { OperationError, type OperationContext, type OperationHandler } from './server';

/** The HOME of the Git user: a path that does not exist and that it cannot create (no `~/.gitconfig` of its own). */
export const BATCH_GIT_HOME = '/nonexistent';
/** After a step ended, its pipes are closed after this time when a process outside its group still holds them. */
const PIPE_CLOSE_MS = 2_000;

/** The user and group nobody: a step for a repository folder that is not a real folder (asRepositoryOwner). */
const NOBODY_ID = 65534;

/** The arguments of `setpriv` before the command of a step that runs as `uid`:`gid` (no groups, capabilities, new privileges). */
export function privilegeArgs(uid: number, gid: number): string[] {
  return ['--reuid', String(uid), '--regid', String(gid), '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--'];
}

/** The arguments of `setpriv` before the command of a Git step. */
export function gitPrivilegeArgs(): string[] {
  return privilegeArgs(BATCH_GIT_UID, BATCH_GIT_UID);
}

/** The command that kills every process of the user of `args` (privilegeArgs), the helper's cleanup after a step. */
function killAllCommand(args: readonly string[]): string[] {
  return ['setpriv', ...args, 'sh', '-c', 'kill -9 -1 2>/dev/null; exit 0'];
}

/** A started step process (a process group of its own). */
export interface StepProcess {
  /** Signals the whole group of the step. */
  killGroup(signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Its exit code, or null after a signal; `error` when it could not be started. */
  readonly exited: Promise<{ exitCode: number | null; error?: string }>;
}

export interface BatchHelperDeps {
  /** Starts `command` (no shell) in a group of its own with `env` and writes `input` to it. */
  spawnStep(command: readonly string[], env: NodeJS.ProcessEnv, input: string | undefined, onStdout: (text: string) => void, onStderr: (text: string) => void): StepProcess;
  /** Runs a fixed command of the helper itself (no output, never fails). */
  runQuiet(command: readonly string[]): Promise<void>;
  /** The file system calls of the preparation of a Git step (the real `fs`). */
  fs: Pick<typeof fs, 'lstatSync' | 'chmodSync' | 'chownSync' | 'readdirSync' | 'rmSync' | 'mkdirSync'>;
  /** The environment of the helper process. */
  env: NodeJS.ProcessEnv;
  /** Why the helper is not safe to run steps (prepareBatchHelper), or undefined. */
  unsafe?: string;
  killGraceMs?: number;
}

/** The command line of a step for the log: the script of `sh -c` and `node -e` is left out (as describeCommand). */
export function describeStep(step: BatchStepCommand): string {
  const command = step.command;
  const shown =
    command[0] === 'sh' && command[1] === '-c'
      ? ['sh', '<script>', ...command.slice(4)]
      : command[0] === 'node' && command[1] === '-e'
        ? ['node', '<script>', ...command.slice(3)]
        : command;
  const user = step.git ? `(as ${BATCH_GIT_UID}) ` : step.owner !== undefined ? `(as the owner of ${step.owner}) ` : '';
  return `${user}${shown.join(' ')}`;
}

/**
 * The environment of a step process: the helper's, the step's, the Compose switches; for Git, and for a step as the
 * owner of the repository (user decision of 2026-10-01), HOME=/nonexistent (no configuration of root's HOME).
 */
export function stepEnvironment(base: NodeJS.ProcessEnv, step: BatchStepCommand): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...step.env, ...COMPOSE_REMOTE_OFF };
  // Never a variable that points the tools elsewhere, whatever the image set.
  delete env.DOCKER_HOST;
  if (step.git || step.owner !== undefined) {
    env.HOME = BATCH_GIT_HOME;
    delete env.XDG_CONFIG_HOME;
  }
  return env;
}

/**
 * Removes everything in the secrets tmpfs (as root; the token file of a step that was killed too), folders with what
 * they hold as well (review round 1 of PR #80, B-R1-4: the Git user owns the tmpfs during its step and may make one).
 */
function clearSecrets(deps: BatchHelperDeps): void {
  for (const name of deps.fs.readdirSync(SECRETS_FOLDER)) deps.fs.rmSync(`${SECRETS_FOLDER}/${name}`, { recursive: true, force: true });
}

/** The temporary folders of the clone in /workspaces (CLONE_SCRIPT's `mktemp -d`). */
const CLONE_WORK_NAME = '.devenv-clone.*';

/**
 * Review round 1 of PR #80 (A-R1-1, A-R1-2): what a Git step left when its cleanup was cut off (the whole helper killed
 * on a cancel of the batch, `docker rm -f`) is repaired before the next Git step, as root: the files of the Git user in
 * the volume get root, and the temporary folders of killed clones go after 60 minutes (as the clone of the per-step
 * helper removed them, which ran as root; the Git user cannot remove a folder of root in the sticky /workspaces).
 */
async function repairCutOffGitStep(deps: BatchHelperDeps, uid: string): Promise<void> {
  await deps.runQuiet(['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-exec', 'chown', '-h', '0:0', '{}', '+']);
  await deps.runQuiet(['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', CLONE_WORK_NAME, '-mmin', '+60', '-exec', 'rm', '-rf', '{}', '+']);
}

/**
 * Review round 1 of PR #82 (A-R1-2): the state of one helper process. A Git step is cut off only when the whole helper
 * was killed (its `finally` runs to its end otherwise, also after a cancel or the time limit of the step), and the next
 * helper is a new process: so repairCutOffGitStep runs once per process, before its first Git step, and never again.
 */
interface GitUserState {
  repaired: boolean;
}

/** Runs `run` with the folders of the Git user opened for the step, and cleans up after it (see the module comment). */
async function asGitUser<T>(deps: BatchHelperDeps, state: GitUserState, step: BatchStepCommand, run: () => Promise<T>): Promise<T> {
  const restores: Array<() => void> = [];
  const uid = String(BATCH_GIT_UID);
  try {
    // Review round 1 of PR #82 (A-R1-2): once per helper process (see GitUserState), so that no step of the Git user
    // finds files of its own in the volume that a killed helper left.
    if (!state.repaired) {
      await repairCutOffGitStep(deps, uid);
      state.repaired = true;
    }
    const config = lstatOrUndefined(deps, CONFIG_FOLDER);
    if (config?.isDirectory()) {
      deps.fs.chmodSync(CONFIG_FOLDER, 0o700);
      restores.push(() => deps.fs.chmodSync(CONFIG_FOLDER, config.mode & 0o7777));
    }
    const root = deps.fs.lstatSync(WORKSPACES_ROOT);
    deps.fs.chmodSync(WORKSPACES_ROOT, 0o1777);
    // Review round 1 of PR #80 (A-R1-1): never sticky or writable for others afterwards, also when a cut-off step left
    // it so (its 1777 would otherwise be taken for the mode to restore, for good).
    restores.push(() => deps.fs.chmodSync(WORKSPACES_ROOT, root.mode & 0o7777 & ~0o1022));
    if (step.secret === 'stdin') {
      deps.fs.chownSync(SECRETS_FOLDER, BATCH_GIT_UID, BATCH_GIT_UID);
      // Review round 2 of PR #80 (A-R2-3): its mode too, which the Git user could change while it owned the folder.
      restores.push(() => {
        deps.fs.chownSync(SECRETS_FOLDER, 0, 0);
        deps.fs.chmodSync(SECRETS_FOLDER, 0o700);
      });
    }
    return await run();
  } finally {
    // Nothing of the Git user outlives its step: its processes; then the modes are restored at once (review round 1 of
    // PR #80, A-R1-1: before the slow walks, which a kill of the whole helper may cut off); then the temporary folders
    // of its clone (A-R1-2: a clone whose own cleanup was cut off by its kill), and its files outside the volume; in the
    // volume its files get root, as the clone of the per-step helper (which ran as root) left them.
    await deps.runQuiet(killAllCommand(gitPrivilegeArgs()));
    try {
      for (const restore of restores.reverse()) restore();
    } finally {
      await removeGitUserLeftovers(deps, uid);
    }
  }
}

/**
 * The files of the Git user after its step (its processes are gone): see the comment in asGitUser. (User decision of
 * 2026-10-01: the Compose read steps no longer run as the Git user, so every step of it is the clone, a writing step.)
 */
async function removeGitUserLeftovers(deps: BatchHelperDeps, uid: string): Promise<void> {
  await deps.runQuiet(['find', WORKSPACES_ROOT, '-mindepth', '1', '-maxdepth', '1', '-name', CLONE_WORK_NAME, '-user', uid, '-exec', 'rm', '-rf', '{}', '+']);
  await deps.runQuiet(['find', WORKSPACES_ROOT, '-xdev', '-user', uid, '-exec', 'chown', '-h', '0:0', '{}', '+']);
  await deps.runQuiet(['find', '/', '/dev/shm', '-xdev', '-user', uid, '-prune', '-exec', 'rm', '-rf', '{}', '+']);
}

/**
 * User decision of 2026-10-01 ("we shall run as the repo owner user. that is what a real user would do as well."): runs
 * `run` as the owner of the repository folder `step.owner` (see the module comment). `run` gets the arguments of
 * `setpriv` for that user, or undefined when root owns the folder (then the step runs as root).
 */
async function asRepositoryOwner<T>(deps: BatchHelperDeps, step: BatchStepCommand, run: (privilege: string[] | undefined) => Promise<T>): Promise<T> {
  const folder = step.owner!;
  // At step time, the folder that the step reads: a real folder (no link), whose owner the step runs as.
  const repository = lstatOrUndefined(deps, folder);
  // Review round 5 of PR #82 (A-R5-1): a missing folder, a link or no folder runs the step as nobody (never as root), so
  // that its script reports it as before (readFiles: no configuration; listConfigs: none).
  const real = repository !== undefined && !repository.isSymbolicLink() && repository.isDirectory();
  const { uid, gid } = real ? repository : { uid: NOBODY_ID, gid: NOBODY_ID };
  const privilege = uid === 0 ? undefined : privilegeArgs(uid, gid);
  const restores: Array<() => void> = [];
  try {
    // CONFIG_FOLDER belongs to the owner of the repository (GIT_FILES_SCRIPT): for a step that follows references in
    // repository files (closeConfigFolder: Compose follows `env_file` and `include`) it is root's and 0700, so that the
    // step cannot read it. For a root owner this protects nothing (accepted, docs/implementation-notes.md §17).
    const config = lstatOrUndefined(deps, CONFIG_FOLDER);
    if (config?.isDirectory()) {
      // Review round 5 of PR #82 (A-R5-2): root:root 0700 is only what a killed step left (GIT_FILES_SCRIPT leaves 0755):
      // it goes back to the owner of a real repository folder, with 0755.
      const cutOff = config.uid === 0 && config.gid === 0 && (config.mode & 0o7777) === 0o700 && real;
      const back = cutOff ? { uid: repository.uid, gid: repository.gid, mode: 0o755 } : { uid: config.uid, gid: config.gid, mode: config.mode & 0o7777 };
      if (step.closeConfigFolder === true) {
        restores.push(() => {
          deps.fs.chownSync(CONFIG_FOLDER, back.uid, back.gid);
          deps.fs.chmodSync(CONFIG_FOLDER, back.mode);
        });
        deps.fs.chmodSync(CONFIG_FOLDER, 0o700);
        deps.fs.chownSync(CONFIG_FOLDER, 0, 0);
      } else if (cutOff) {
        // Review round 1 of PR #84, A-R1-1: the other owner steps leave CONFIG_FOLDER open (a running dev container
        // reads its Git configuration there during the step); only the leftover of a killed step is repaired, at once.
        deps.fs.chownSync(CONFIG_FOLDER, back.uid, back.gid);
        deps.fs.chmodSync(CONFIG_FOLDER, back.mode);
      }
    }
    // Review rounds 1 and 3 of PR #82 (B-R1-5, B-R3-2): the step starts without the files that root steps before it
    // left below OVERRIDE_FOLDER. The folder is new, empty, the owner's and 0700 (the Compose hash writes its model
    // there); after the step it is removed as root, so that no later root step writes into a folder of that user.
    deps.fs.rmSync(OVERRIDE_FOLDER, { recursive: true, force: true });
    restores.push(() => deps.fs.rmSync(OVERRIDE_FOLDER, { recursive: true, force: true }));
    deps.fs.mkdirSync(OVERRIDE_FOLDER, { mode: 0o700 });
    if (uid !== 0) deps.fs.chownSync(OVERRIDE_FOLDER, uid, gid);
    return await run(privilege);
  } finally {
    // No process of the owner outlives its step (never for root: that would end the helper; its group ends with the
    // step); then the modes are restored. The files of the owner elsewhere are its own (no walk, no removal).
    if (privilege !== undefined) await deps.runQuiet(killAllCommand(privilege));
    // Review round 5 of PR #82 (A-R5-3): each restore runs, also when one before it throws; the first error is rethrown.
    let failure: { error: unknown } | undefined;
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== undefined) throw failure.error;
  }
}

function lstatOrUndefined(deps: BatchHelperDeps, path: string): fs.Stats | undefined {
  try {
    return deps.fs.lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Runs one step process until it ends; the signal ends its group (SIGTERM, then SIGKILL). */
async function runStep(deps: BatchHelperDeps, step: BatchStepCommand, input: string | undefined, context: OperationContext, privilege?: readonly string[]): Promise<number | null> {
  const command = privilege !== undefined ? ['setpriv', ...privilege, ...step.command] : step.command;
  const started = Date.now();
  context.log(`$ ${describeStep(step)}`);
  let child: StepProcess;
  try {
    child = deps.spawnStep(command, stepEnvironment(deps.env, step), input, (text) => context.output('stdout', text), (text) => context.output('stderr', text));
  } catch (error) {
    throw new OperationError('failed', `The step could not be started: ${(error as Error).message}`);
  }
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    child.killGroup('SIGTERM');
    killTimer = setTimeout(() => child.killGroup('SIGKILL'), deps.killGraceMs ?? CHANNEL_KILL_GRACE_MS);
  };
  if (context.signal.aborted) end();
  else context.signal.addEventListener('abort', end, { once: true });
  const { exitCode, error } = await child.exited;
  context.signal.removeEventListener('abort', end);
  if (killTimer !== undefined) clearTimeout(killTimer);
  // What the step left in its group ends with it (as at the end of a per-step container).
  child.killGroup('SIGKILL');
  if (error !== undefined) throw new OperationError('failed', `The step could not be started: ${error}`);
  context.log(`${exitCode === null ? 'ended by a signal' : `exit code ${exitCode}`} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return exitCode;
}

/** The operations of the batch helper: one per step kind, one step at a time. */
export function batchHelperOperations(deps: BatchHelperDeps): Record<string, OperationHandler> {
  let running = false;
  const gitUser: GitUserState = { repaired: false };
  const handler: (kind: string) => OperationHandler = (kind) => async (params, context) => {
    let step: BatchStepCommand;
    try {
      step = batchStepCommand(kind, params);
    } catch (error) {
      throw new OperationError('invalid', error instanceof BatchStepError ? error.message : 'The parameters of the step are invalid.');
    }
    // Plan step 11A: a step takes at most the GitHub token (SECRET_TOKEN).
    const token = context.secrets[SECRET_TOKEN];
    if (step.secret === undefined && !context.hasNoSecret()) throw new OperationError('invalid', `The step ${kind} takes no secret.`);
    if (Object.keys(context.secrets).some((name) => name !== SECRET_TOKEN)) throw new OperationError('invalid', `The step ${kind} takes no secret but the token.`);
    if (step.secret === 'stdin' && token === undefined) throw new OperationError('invalid', `The step ${kind} needs a secret.`);
    if (deps.unsafe !== undefined) throw new OperationError('unsafe', `The batch helper cannot run steps: ${deps.unsafe}`);
    if (running) throw new OperationError('busy', 'Another step runs in the batch helper.');
    running = true;
    try {
      context.progress(kind);
      const input = step.secret === 'stdin' ? token : step.input;
      const exitCode = step.git
        ? await asGitUser(deps, gitUser, step, () => runStep(deps, step, input, context, gitPrivilegeArgs()))
        : step.owner !== undefined
          ? await asRepositoryOwner(deps, step, (privilege) => runStep(deps, step, input, context, privilege))
          : await runStep(deps, step, input, context);
      return { exitCode };
    } finally {
      // Review round 1 of PR #80 (B-R1-4): the slot is free again also when the secrets cannot be cleared (that step
      // fails with the error; the next one runs, and clears them again if it has a secret).
      try {
        if (step.secret === 'stdin') clearSecrets(deps);
      } finally {
        running = false;
      }
    }
  };
  return Object.fromEntries(BATCH_STEP_KINDS.map((kind) => [kind, handler(kind)]));
}

/**
 * The checks of the helper before its first step: it runs as root; the folder of the socket is a folder of root that
 * only root can enter; /var/run/docker.sock links to the socket; the secrets tmpfs is root's, 0700. Returns why the
 * helper is not safe (then every step is refused), or undefined.
 */
export function prepareBatchHelper(files: Pick<typeof fs, 'lstatSync' | 'chmodSync' | 'chownSync' | 'symlinkSync' | 'readlinkSync'> = fs, uid = process.getuid?.()): string | undefined {
  try {
    if (uid !== 0) return 'it does not run as root';
    for (const folder of [BATCH_SOCKET_FOLDER, SECRETS_FOLDER]) {
      if (!files.lstatSync(folder).isDirectory()) return `${folder} is not a folder`;
      files.chownSync(folder, 0, 0);
      files.chmodSync(folder, 0o700);
      if ((files.lstatSync(folder).mode & 0o777) !== 0o700) return `${folder} cannot be closed`;
    }
    let link: string | undefined;
    try {
      link = files.readlinkSync(HELPER_DOCKER_SOCKET);
    } catch {
      files.symlinkSync(BATCH_DOCKER_SOCKET, HELPER_DOCKER_SOCKET);
      link = files.readlinkSync(HELPER_DOCKER_SOCKET);
    }
    return link === BATCH_DOCKER_SOCKET ? undefined : `${HELPER_DOCKER_SOCKET} leads elsewhere`;
  } catch (error) {
    return (error as Error).message;
  }
}

/** spawnStep with child_process.spawn: no shell, a process group of its own (`detached`), the input, then closed. */
export function spawnStepProcess(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  input: string | undefined,
  onStdout: (text: string) => void,
  onStderr: (text: string) => void,
): StepProcess {
  const child = spawn(command[0], command.slice(1), { shell: false, detached: true, cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutDecoder = new TextDecoder('utf-8');
  const stderrDecoder = new TextDecoder('utf-8');
  child.stdout.on('data', (chunk: Buffer) => onStdout(stdoutDecoder.decode(chunk, { stream: true })));
  child.stderr.on('data', (chunk: Buffer) => onStderr(stderrDecoder.decode(chunk, { stream: true })));
  child.stdin.on('error', () => {});
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  const exited = new Promise<{ exitCode: number | null; error?: string }>((resolve) => {
    child.on('error', (error) => resolve({ exitCode: null, error: error.message }));
    // A process outside the group that holds the pipes must not hold the step.
    child.on('exit', () => setTimeout(() => (child.stdout.destroy(), child.stderr.destroy()), PIPE_CLOSE_MS).unref());
    child.on('close', (code) => {
      const restOut = stdoutDecoder.decode();
      const restErr = stderrDecoder.decode();
      if (restOut !== '') onStdout(restOut);
      if (restErr !== '') onStderr(restErr);
      resolve({ exitCode: code });
    });
  });
  return {
    exited,
    killGroup: (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group ended already.
      }
    },
  };
}

/** runQuiet with child_process.spawn: no shell, no output, never rejects. */
export function runQuietProcess(command: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command[0], command.slice(1), { shell: false, cwd: '/', stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    } catch {
      resolve();
    }
  });
}
