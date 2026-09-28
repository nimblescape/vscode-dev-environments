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
/**
 * The screen filled (the monitor switched on). User request 2026-09-28 ("an inner small line frame"): inset by 0.75 from
 * the inner edge of the frame, so a thin line of background stays between the frame and the screen.
 */
const FILLED = 'M3.5 2.75H12.5C12.914 2.75 13.25 3.086 13.25 3.5V9.5C13.25 9.914 12.914 10.25 12.5 10.25H3.5C3.086 10.25 2.75 9.914 2.75 9.5V3.5C2.75 3.086 3.086 2.75 3.5 2.75Z';
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
      // The connection sign of vm-connect, with the frame cut free around it. User request 2026-09-28 ("a smaller
      // diameter"): radius 3.5 instead of 4.5, in the corner (centre 12.5/12.5), the frame cut free 1 around it.
      expect(read('monitor-connected', theme)).toContain('<circle cx="12.5" cy="12.5" r="4.5" fill="#000"/>');
      expect(read('monitor-connected', theme)).toContain('transform="translate(12.5 12.5) scale(0.7778) translate(-11.5 -11.5)"');
      expect(read('monitor-connected', theme)).toContain('M16 11.5C16 13.985 13.985 16 11.5 16');
      expect(read('monitor-on', theme)).not.toContain('M16 11.5');
    }
  });

  it('are in the package', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((line) => line.trim());
    expect(ignore).toContain('!resources/**');
  });
});
