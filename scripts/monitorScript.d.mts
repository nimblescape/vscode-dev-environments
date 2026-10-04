// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import type { Plugin } from 'esbuild';

export const MONITOR_SCRIPT_MODULE: string;
export function monitorScriptPlugin(root: string, define: Record<string, string>): Plugin;
