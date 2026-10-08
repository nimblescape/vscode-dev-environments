// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import type { BuildOptions, Plugin } from 'esbuild';

export const WORKER_SCRIPT_ENTRIES: Record<'devenv:monitor-script' | 'devenv:analysis-script', string[]>;
export function workerScriptsPlugin(root: string, define: Record<string, string>, onScriptInputs?: (script: string, inputs: string[]) => void): Plugin;
export function workerBundleOptions(
  root: string,
  shared: BuildOptions & { define: Record<string, string>; plugins: Plugin[] },
  onScriptInputs?: (script: string, inputs: string[]) => void,
): BuildOptions;
