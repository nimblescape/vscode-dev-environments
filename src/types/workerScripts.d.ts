// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scripts in the bundle of the worker (scripts/workerScripts.mjs); the unit tests get stubs of their own
// (vitest.config.ts). Plan step 11D2: the script of the Session Monitor.
declare module 'devenv:monitor-script' {
  const script: string;
  export default script;
}

// Plan step 11E2: the thread of the host access analysis.
declare module 'devenv:analysis-script' {
  const script: string;
  export default script;
}
