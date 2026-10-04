// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2: the script of the Session Monitor in the bundle of the worker (scripts/monitorScript.mjs); the unit
// tests get a stub of their own (vitest.config.ts).
declare module 'devenv:monitor-script' {
  const script: string;
  export default script;
}
