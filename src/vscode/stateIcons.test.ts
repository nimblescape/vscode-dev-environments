// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User requests 2026-09-28: the monitor icons of the states of a window (resources/icons). They are drawn on the frame
// of the codicon `vm`, so the frame is at the same place in all of them ("the monitor icons are left aligned").
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { StateIconFile } from './treeModel';

const ROOT = path.resolve(__dirname, '..', '..');
const FILES: StateIconFile[] = ['monitor-off', 'monitor-on', 'monitor-connected'];
/** The monitor, stand and base of the codicon `vm` (16 × 16). */
const FRAME =
  'M3 1C1.895 1 1 1.895 1 3V10C1 11.105 1.895 12 3 12H5V14H3.5C3.224 14 3 14.224 3 14.5C3 14.776 3.224 15 3.5 15H12.5C12.776 15 13 14.776 13 14.5C13 14.224 12.776 14 12.5 14H11V12H13C14.105 12 15 11.105 15 10V3C15 1.895 14.105 1 13 1H3ZM10 12V14H6V12H10ZM2 3C2 2.448 2.448 2 3 2H13C13.552 2 14 2.448 14 3V10C14 10.552 13.552 11 13 11H3C2.448 11 2 10.552 2 10V3Z';
/** The screen filled (the monitor switched on). */
const FILLED = 'M3 1H13C14.105 1 15 1.895 15 3V10C15 11.105 14.105 12 13 12H3C1.895 12 1 11.105 1 10V3C1 1.895 1.895 1 3 1Z';
const COLORS = { light: '#424242', dark: '#C5C5C5' };

function read(file: StateIconFile, theme: 'light' | 'dark'): string {
  return fs.readFileSync(path.join(ROOT, 'resources', 'icons', `${file}-${theme}.svg`), 'utf8');
}

describe('the monitor icons of the states', () => {
  it.each(FILES.flatMap((file) => (['light', 'dark'] as const).map((theme) => [file, theme] as const)))(
    '%s (%s) is a 16 × 16 icon on the frame of the codicon vm, in the color of the codicons of its theme',
    (file, theme) => {
      const svg = read(file, theme);
      expect(svg.split('\n').slice(0, 3)).toEqual([
        '<!-- SPDX-License-Identifier: MIT -->',
        '<!-- © 2026 Hannes Stauss (scalarion@nimblescape.com) -->',
        '<!-- Licensed under the MIT License. See LICENSE in the repository root for details. -->',
      ]);
      expect(svg).toContain('viewBox="0 0 16 16"');
      expect(svg).toContain(`fill="${COLORS[theme]}"`);
      expect(svg).toContain(`d="${FRAME}"`);
      // No script, no external reference: the view shows it as an image.
      expect(svg).not.toMatch(/<script|href=|xlink/i);
    },
  );

  it('shows the silhouette when switched off, the filled screen when switched on, and the connection sign only in this window', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(read('monitor-off', theme)).not.toContain(FILLED);
      expect(read('monitor-on', theme)).toContain(FILLED);
      expect(read('monitor-connected', theme)).toContain(FILLED);
      // The connection sign of vm-connect, with the frame cut free around it (radius 5.5 around its centre).
      expect(read('monitor-connected', theme)).toContain('<circle cx="11.5" cy="11.5" r="5.5" fill="#000"/>');
      expect(read('monitor-connected', theme)).toContain('M16 11.5C16 13.985 13.985 16 11.5 16');
      expect(read('monitor-on', theme)).not.toContain('M16 11.5');
    }
  });

  it('are in the package', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((line) => line.trim());
    expect(ignore).toContain('!resources/**');
  });
});
