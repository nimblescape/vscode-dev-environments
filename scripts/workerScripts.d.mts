// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import type { Plugin } from 'esbuild';

export const WORKER_SCRIPT_ENTRIES: Record<'devenv:monitor-script' | 'devenv:analysis-script', string[]>;
export function workerScriptsPlugin(root: string, define: Record<string, string>): Plugin;
