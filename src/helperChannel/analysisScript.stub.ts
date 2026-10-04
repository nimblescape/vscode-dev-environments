// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E2: the module `devenv:analysis-script` in the unit tests (vitest.config.ts), which never start the
// analysis thread of a worker bundle; the bundle of the worker holds the real script (scripts/workerScripts.mjs), and the
// tests of the analysis build their own (configurationAnalysisRunner.test.ts).
export default 'throw new Error("the analysis thread of the unit tests");';
