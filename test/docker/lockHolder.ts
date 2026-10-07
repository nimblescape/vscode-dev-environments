// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I1, PR A1 (review round 1, A-M1): the lock of an environment taken in a plain container of the helper
// image with the code of the worker and the Session Monitor (openLockFile, then `flock` on its file descriptor), for the
// Docker tests that need a holder without the `lock` operation of the worker. Bundled by workerLocks.ts and run with
// `node -e`; its arguments: `hold <environmentId> <waitSeconds>` (prints `held`, then keeps the lock until the container
// ends) or `try <environmentId> <waitSeconds>` (exits with 0 when it took the lock, which it lets go at once), and the
// state folder as an optional fourth argument (LOCK_STATE_DIR by default; another one for its unit test).
import { FLOCK_FD, openLockFile, startFlockProcess } from '../../src/core/helperChannel/lockFile';
import { LOCK_BUSY_EXIT, LOCK_STATE_DIR, flockArgs } from '../../src/core/helperChannel/protocol';

async function main(): Promise<void> {
  const [mode, environmentId, waitSeconds, stateDir = LOCK_STATE_DIR] = process.argv.slice(1);
  const fd = openLockFile(stateDir, environmentId);
  const result = await startFlockProcess(flockArgs(Number(waitSeconds), FLOCK_FD), fd).exited;
  if (result.exitCode === LOCK_BUSY_EXIT) process.exit(LOCK_BUSY_EXIT);
  if (result.exitCode !== 0) {
    console.error(`flock failed: ${result.error ?? result.stderr ?? result.exitCode}`);
    process.exit(1);
  }
  if (mode !== 'hold') process.exit(0);
  console.log('held');
  // The kernel lock lives with the open file of this process until the container ends.
  setInterval(() => {}, 1 << 30);
}

void main();
