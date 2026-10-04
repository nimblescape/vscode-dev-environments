// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2: the module `devenv:monitor-script` in the unit tests (vitest.config.ts), which never start a real
// Session Monitor; the bundle of the worker holds the real script (scripts/monitorScript.mjs).
export default 'console.log("the Session Monitor of the unit tests");';
