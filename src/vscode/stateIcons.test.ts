// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User requests 2026-09-28: the monitors of the states of a window, as an icon font of the extension (review round 2 of
// PR #59, K1: VS Code colors its glyphs like the codicons). scripts/build-icon-font.py builds the font from the paths
// below; these tests check the contribution, the font file, and the geometry in the script.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { MonitorIcons } from './treeModel';

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'build-icon-font.py'), 'utf8');
const FONT = 'resources/icons/devenv-icons.woff';
/** The monitor, stand and base of the codicon `vm` (16 × 16). */
const VM_FRAME =
  'M3 1C1.895 1 1 1.895 1 3V10C1 11.105 1.895 12 3 12H5V14H3.5C3.224 14 3 14.224 3 14.5C3 14.776 3.224 15 3.5 15H12.5C12.776 15 13 14.776 13 14.5C13 14.224 12.776 14 12.5 14H11V12H13C14.105 12 15 11.105 15 10V3C15 1.895 14.105 1 13 1H3ZM10 12V14H6V12H10ZM2 3C2 2.448 2.448 2 3 2H13C13.552 2 14 2.448 14 3V10C14 10.552 13.552 11 13 11H3C2.448 11 2 10.552 2 10V3Z';

interface IconContribution {
  description: string;
  default: { fontPath: string; fontCharacter: string };
}

function contributedIcons(): Record<string, IconContribution> {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { icons: Record<string, IconContribution> } };
  return manifest.contributes.icons;
}

/** A Python string constant of the script, its adjacent literals joined. */
function constant(name: string): string {
  const match = new RegExp(`^${name} = \\(?\\n?((?:\\s*"[^"]*"\\n?)+)\\)?`, 'm').exec(SCRIPT);
  if (!match) throw new Error(`${name} not found`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map((part) => part[1]).join('');
}

describe('the monitor icons of the states', () => {
  it('are contributed with a character of the Private Use Area each, in the font of the package', () => {
    const icons = contributedIcons();
    expect(Object.keys(icons).sort()).toEqual(Object.values(MonitorIcons).sort());
    // User request 2026-09-28: a fourth monitor for the header row of a remote Docker host.
    // User request 2026-09-28 ("align all the icons used with the new icon set"): four more for the other states.
    expect(Object.values(icons).map((icon) => icon.default.fontCharacter)).toEqual(['\\E001', '\\E002', '\\E003', '\\E004', '\\E005', '\\E006', '\\E007', '\\E008']);
    for (const icon of Object.values(icons)) expect(icon.default.fontPath).toBe(`./${FONT}`);
    const font = fs.readFileSync(path.join(ROOT, FONT));
    expect(font.subarray(0, 4).toString('latin1')).toBe('wOFF');
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((line) => line.trim());
    expect(ignore).toContain('!resources/**');
  });

  it('builds each glyph on the frame of the codicon vm, with the screen on whole pixels and the smaller sign', () => {
    // "the monitor icons are left aligned": the same frame in all three glyphs.
    expect(constant('FRAME')).toBe(VM_FRAME);
    // User request 2026-09-28 (the line between frame and screen equally wide on light and dark themes): the screen
    // is 1 inside the inner edge of the frame (x 2..14, y 2..11), from 3 to 13 and from 3 to 10.
    expect(constant('SCREEN')).toMatch(/^M3\.5 3H12\.5C.* 13 3\.5V9\.5C.*H3\.5C.* 3 9\.5V3\.5C/);
    // User request 2026-09-28 ("a smaller diameter"): radius 3.5 instead of 4.5, the monitor cut free 1 around it.
    expect(SCRIPT).toMatch(/^BADGE_RADIUS = 3\.5$/m);
    expect(SCRIPT).toMatch(/^CLEARANCE = BADGE_RADIUS \+ 1$/m);
    expect(constant('BADGE').startsWith('M16 11.5C16 13.985 13.985 16 11.5 16')).toBe(true);
    for (const id of Object.values(MonitorIcons)) {
      expect(SCRIPT).toContain(`"${id}"`);
      expect(fs.existsSync(path.join(ROOT, 'scripts', 'icons', `${id}.svg`)), id).toBe(true);
    }
  });
});
