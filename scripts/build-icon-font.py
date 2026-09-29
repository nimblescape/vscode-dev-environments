# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

"""Builds resources/icons/devenv-icons.woff, the icon font of the monitors of the sidebar (package.json contributes.icons).

User requests 2026-09-28: a monitor for the states of a window, all on the frame of the codicon `vm` at the same place:
switched off (the silhouette) while stopped, switched on (the screen filled inside a line of 1) in another window,
switched on with a smaller connection sign (of `vm-connect`) in this window; the header row of the Docker host shows the
monitor switched off, with the sign for a remote host. An icon font instead of SVG files (review
round 2 of PR #59, K1): VS Code colors its glyphs like the codicons (theme, selected row, high contrast).

Needs `pip install fonttools skia-pathops`. Run: python3 scripts/build-icon-font.py (writes the font and, for review,
scripts/icons/<name>.svg of each glyph).
"""

import os

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The monitor, stand and base of the codicon `vm` (16 × 16, y down).
FRAME = (
    "M3 1C1.895 1 1 1.895 1 3V10C1 11.105 1.895 12 3 12H5V14H3.5C3.224 14 3 14.224 3 14.5C3 14.776 3.224 15 3.5 15H12.5"
    "C12.776 15 13 14.776 13 14.5C13 14.224 12.776 14 12.5 14H11V12H13C14.105 12 15 11.105 15 10V3C15 1.895 14.105 1 13 1"
    "H3ZM10 12V14H6V12H10ZM2 3C2 2.448 2.448 2 3 2H13C13.552 2 14 2.448 14 3V10C14 10.552 13.552 11 13 11H3C2.448 11 2"
    " 10.552 2 10V3Z"
)
# The screen switched on: 1 inside the inner edge of the frame (x 2..14, y 2..11), on whole pixels, so the line between
# frame and screen is equally wide on light and dark themes (user request 2026-09-28).
SCREEN = "M3.5 3H12.5C12.776 3 13 3.224 13 3.5V9.5C13 9.776 12.776 10 12.5 10H3.5C3.224 10 3 9.776 3 9.5V3.5C3 3.224 3.224 3 3.5 3Z"
# The connection sign of `vm-connect` (a circle of radius 4.5 at 11.5/11.5 with two arrows cut out).
BADGE = (
    "M16 11.5C16 13.985 13.985 16 11.5 16C9.015 16 7 13.985 7 11.5C7 9.015 9.015 7 11.5 7C13.985 7 16 9.015 16 11.5Z"
    "M11.501 12.5C11.501 12.434 11.488 12.369 11.463 12.308C11.438 12.247 11.401 12.192 11.354 12.146L9.854 10.646"
    "C9.76 10.552 9.633 10.499 9.5 10.499C9.367 10.499 9.24 10.552 9.146 10.646C9.052 10.74 8.999 10.867 8.999 11"
    "C8.999 11.133 9.052 11.26 9.146 11.354L10.293 12.5L9.146 13.646C9.052 13.74 8.999 13.867 8.999 14C8.999 14.133 9.052"
    " 14.26 9.146 14.354C9.24 14.448 9.367 14.501 9.5 14.501C9.633 14.501 9.76 14.448 9.854 14.354L11.354 12.854C11.401"
    " 12.808 11.437 12.752 11.463 12.692C11.488 12.631 11.501 12.566 11.501 12.5Z"
    "M12.707 10.5L13.854 9.354C13.948 9.26 14.001 9.133 14.001 9C14.001 8.867 13.948 8.74 13.854 8.646C13.76 8.552"
    " 13.633 8.499 13.5 8.499C13.367 8.499 13.24 8.552 13.146 8.646L11.646 10.146C11.599 10.192 11.563 10.248 11.537"
    " 10.308C11.512 10.369 11.499 10.434 11.499 10.5C11.499 10.566 11.512 10.631 11.537 10.692C11.562 10.753 11.599"
    " 10.808 11.646 10.854L13.146 12.354C13.24 12.448 13.367 12.501 13.5 12.501C13.633 12.501 13.76 12.448 13.854 12.354"
    "C13.948 12.26 14.001 12.133 14.001 12C14.001 11.867 13.948 11.74 13.854 11.646L12.707 10.5Z"
)
# The badges of the codicons `vm-running` (play), `vm-pending` (clock) and `vm-outline` (ring), in the circle of `vm-connect`.
BADGE_PLAY = (
    "M16 11.5C16 12.39 15.736 13.26 15.242 14C14.748 14.74 14.045 15.317 13.222 15.657C12.4 15.998 11.495 16.087 10.6"
    "22 15.913C9.749 15.739 8.947 15.311 8.318 14.681C7.689 14.052 7.26 13.25 7.086 12.377C6.912 11.504 7.001 10.599 "
    "7.342 9.777C7.683 8.955 8.259 8.252 8.999 7.757C9.739 7.264 10.609 7 11.499 7C12.692 7 13.837 7.474 14.681 8.318"
    "C15.525 9.162 16 10.307 16 11.5ZM13.97 11.499C13.97 11.41 13.946 11.323 13.901 11.246C13.856 11.17 13.791 11.106"
    " 13.713 11.063L10.743 9.413C10.667 9.371 10.581 9.349 10.494 9.35C10.407 9.351 10.322 9.375 10.247 9.419C10.171 "
    "9.463 10.109 9.526 10.066 9.602C10.023 9.677 10 9.763 10 9.85V13.15C10 13.237 10.023 13.322 10.066 13.398C10.11 "
    "13.474 10.172 13.537 10.247 13.581C10.322 13.625 10.407 13.649 10.494 13.65C10.581 13.65 10.667 13.629 10.743 13"
    ".587L13.713 11.937C13.791 11.892 13.856 11.829 13.901 11.752C13.946 11.676 13.97 11.588 13.97 11.499Z"
)
BADGE_CLOCK = (
    "M16 11.5C16 13.985 13.985 16 11.5 16C9.015 16 7 13.985 7 11.5C7 9.015 9.015 7 11.5 7C13.985 7 16 9.015 16 11.5ZM"
    "14 11.5C14 11.224 13.776 11 13.5 11H12V9C12 8.724 11.776 8.5 11.5 8.5C11.224 8.5 11 8.724 11 9V11.5C11 11.776 11"
    ".224 12 11.5 12H13.5C13.776 12 14 11.776 14 11.5Z"
)
BADGE_RING = (
    "M16 11.5C16 13.981 13.981 16 11.5 16C9.019 16 7 13.981 7 11.5C7 9.019 9.019 7 11.5 7C13.981 7 16 9.019 16 11.5ZM"
    "15 11.5C15 9.57 13.43 8 11.5 8C9.57 8 8 9.57 8 11.5C8 13.43 9.57 15 11.5 15C13.43 15 15 13.43 15 11.5Z"
)
# A warning badge in the same circle: an exclamation mark cut out.
BADGE_WARNING = (
    "M16 11.5C16 13.985 13.985 16 11.5 16C9.015 16 7 13.985 7 11.5C7 9.015 9.015 7 11.5 7C13.985 7 16 9.015 16 11.5Z"
    "M11.5 8.5C11.776 8.5 12 8.724 12 9V11.75C12 12.026 11.776 12.25 11.5 12.25C11.224 12.25 11 12.026 11 11.75V9C11 8.724 11.224 8.5 11.5 8.5Z"
    "M12.15 13.6C12.15 13.959 11.859 14.25 11.5 14.25C11.141 14.25 10.85 13.959 10.85 13.6C10.85 13.241 11.141 12.95 11.5 12.95C11.859 12.95 12.15 13.241 12.15 13.6Z"
)
# User request 2026-09-28 ("a smaller diameter"): radius 3.5 instead of 4.5, in the corner (centre 12.5/12.5); the monitor
# is cut free 1 around it.
BADGE_RADIUS = 3.5
BADGE_CENTRE = 12.5
CLEARANCE = BADGE_RADIUS + 1

# Glyph name, character (Private Use Area), contributed icon id.
GLYPHS = [
    ("monitorOff", 0xE001, "devenv-monitor-off"),
    ("monitorOn", 0xE002, "devenv-monitor-on"),
    ("monitorConnected", 0xE003, "devenv-monitor-connected"),
    # User request 2026-09-28: the header row of a remote Docker host, the monitor switched off with the connection sign.
    ("monitorRemote", 0xE004, "devenv-monitor-remote"),
    # User request 2026-09-28 ("align all the icons used with the new icon set"): the other states of an environment.
    ("monitorRunning", 0xE005, "devenv-monitor-running"),
    ("monitorUpdating", 0xE006, "devenv-monitor-updating"),
    ("monitorNoContainer", 0xE007, "devenv-monitor-no-container"),
    ("monitorWarning", 0xE008, "devenv-monitor-warning"),
]
UNITS_PER_EM = 1000
# Seconds since 1904-01-01 (the epoch of the head table): 2026-09-28 00:00 UTC.
FIXED_TIMESTAMP = 3873398400
SCALE = UNITS_PER_EM / 16


def path_of(d, fill_type=pathops.FillType.WINDING, transform=(1, 0, 0, 1, 0, 0)):
    path = pathops.Path(fillType=fill_type)
    parse_path(d, TransformPen(path.getPen(), transform))
    return pathops.simplify(path, fix_winding=True)


def circle(cx, cy, r):
    k = 0.5522847498 * r
    return (
        f"M{cx + r} {cy}C{cx + r} {cy + k} {cx + k} {cy + r} {cx} {cy + r}C{cx - k} {cy + r} {cx - r} {cy + k} {cx - r} {cy}"
        f"C{cx - r} {cy - k} {cx - k} {cy - r} {cx} {cy - r}C{cx + k} {cy - r} {cx + r} {cy - k} {cx + r} {cy}Z"
    )


def glyphs():
    frame = path_of(FRAME)
    on = pathops.op(frame, path_of(SCREEN), pathops.PathOp.UNION, fix_winding=True)
    s = BADGE_RADIUS / 4.5
    clearance = path_of(circle(BADGE_CENTRE, BADGE_CENTRE, CLEARANCE))

    def badged(monitor, d):
        """The monitor cut free around the badge, with the badge (the codicon circle, smaller, in the corner)."""
        badge = path_of(d, pathops.FillType.EVEN_ODD, (s, 0, 0, s, BADGE_CENTRE - 11.5 * s, BADGE_CENTRE - 11.5 * s))
        cut = pathops.op(monitor, clearance, pathops.PathOp.DIFFERENCE, fix_winding=True)
        return pathops.op(cut, badge, pathops.PathOp.UNION, fix_winding=True)

    return {
        "monitorOff": frame,
        "monitorOn": on,
        "monitorConnected": badged(on, BADGE),
        "monitorRemote": badged(frame, BADGE),
        # Switched off: no window uses it (user, 2026-09-26: a running environment must not look like a connected one).
        "monitorRunning": badged(frame, BADGE_PLAY),
        "monitorUpdating": badged(frame, BADGE_CLOCK),
        "monitorNoContainer": badged(frame, BADGE_RING),
        "monitorWarning": badged(frame, BADGE_WARNING),
    }


def svg_of(path):
    pen_d = []

    class Pen:
        def moveTo(self, p):
            pen_d.append(f"M{p[0]:g} {p[1]:g}")

        def lineTo(self, p):
            pen_d.append(f"L{p[0]:g} {p[1]:g}")

        def curveTo(self, *ps):
            pen_d.append("C" + " ".join(f"{x:g} {y:g}" for x, y in ps))

        def qCurveTo(self, *ps):
            pen_d.append("Q" + " ".join(f"{x:g} {y:g}" for x, y in ps))

        def closePath(self):
            pen_d.append("Z")

        def endPath(self):
            pass

    path.draw(Pen())
    return (
        '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">'
        f'<path d="{"".join(pen_d)}"/></svg>\n'
    )


def main():
    paths = glyphs()
    fb = FontBuilder(UNITS_PER_EM, isTTF=False)
    order = [".notdef"] + [name for name, _, _ in GLYPHS]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({code: name for name, code, _ in GLYPHS})
    charstrings = {".notdef": T2CharStringPen(UNITS_PER_EM, None).getCharString()}
    os.makedirs(os.path.join(ROOT, "scripts", "icons"), exist_ok=True)
    for name, _, icon_id in GLYPHS:
        pen = T2CharStringPen(UNITS_PER_EM, None)
        # Font coordinates: y up, the 16 × 16 box on the em square.
        paths[name].draw(TransformPen(pen, (SCALE, 0, 0, -SCALE, 0, UNITS_PER_EM)))
        charstrings[name] = pen.getCharString()
        with open(os.path.join(ROOT, "scripts", "icons", f"{icon_id}.svg"), "w") as out:
            out.write(svg_of(paths[name]))
    fb.setupCFF("DevEnvironmentsIcons", {"FullName": "Dev Environments Icons"}, charstrings, {})
    fb.setupHorizontalMetrics({name: (UNITS_PER_EM, 0) for name in order})
    fb.setupHorizontalHeader(ascent=UNITS_PER_EM, descent=0)
    fb.setupNameTable({"familyName": "Dev Environments Icons", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=UNITS_PER_EM, sTypoDescender=0, usWinAscent=UNITS_PER_EM, usWinDescent=0)
    fb.setupPost()
    # Review round 3 of PR #59 (L4): a fixed time in the head table, so a rebuild of the same glyphs gives the same file.
    fb.font["head"].created = fb.font["head"].modified = FIXED_TIMESTAMP
    fb.font.recalcTimestamp = False
    fb.font.flavor = "woff"
    fb.save(os.path.join(ROOT, "resources", "icons", "devenv-icons.woff"))


if __name__ == "__main__":
    main()
