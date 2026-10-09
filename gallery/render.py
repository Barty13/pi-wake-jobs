#!/usr/bin/env python3
"""Draw the gallery image from a capture.

Input is the JSON that gallery/capture.ts prints, on stdin or at argv[1].
Output is a 1200 x 630 PNG, the size the Pi gallery and Open Graph use.
The text in the image is the text the extension drew, unchanged.

Needs Pillow:  python3 -m venv /tmp/imgvenv && /tmp/imgvenv/bin/pip install pillow
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

MENLO = "/System/Library/Fonts/Menlo.ttc"
WIDTH = 1200
HEIGHT = 630
PITCH = 140
BOX_TOP = 24
BOX_HEIGHT = 100
MARGIN = 56

BACK = "#0d1117"
CARD = "#151a20"
EDGE = "#232b34"
TEXT = "#d5dde6"
DIM = "#8b98a5"
FAINT = "#69757f"
ACCENT = "#7aa2f7"
STATE = {
    "running": "#e3b341",
    "ok": "#56d364",
    "fail": "#f47067",
    "stopped": "#79b8ff",
}


def font(size, bold=False):
    return ImageFont.truetype(MENLO, size, index=1 if bold else 0)


def state_colour(row):
    """Return the colour for the state in a row, or the plain colour."""
    for name, colour in STATE.items():
        if ("[" + name + "]") in row:
            return colour
    return DIM


def draw_row(draw, xy, row, regular):
    """Draw one row, with the state token in its own colour."""
    x, y = xy
    head, sep, rest = row.partition("[")
    if not sep:
        draw.text((x, y), row, font=regular, fill=state_colour(row))
        return
    state, _, tail = rest.partition("]")
    draw.text((x, y), head, font=regular, fill=TEXT)
    x += draw.textlength(head, font=regular)
    token = "[" + state + "]"
    draw.text((x, y), token, font=regular, fill=STATE.get(state, TEXT))
    x += draw.textlength(token, font=regular)
    draw.text((x, y), tail, font=regular, fill=FAINT)


def draw_frame(draw, y, label, view):
    """One screenshot block: a label, the footer text, then the table rows."""
    draw.text((MARGIN, y), label, font=font(16, True), fill=FAINT)
    footer = view["footer"]
    note = footer if footer else "footer cleared"
    fill = STATE["ok"] if footer else FAINT
    width = draw.textlength(note, font=font(16, True))
    draw.text((WIDTH - MARGIN - width, y), note, font=font(16, True), fill=fill)

    box = (MARGIN, y + BOX_TOP, WIDTH - MARGIN, y + BOX_TOP + BOX_HEIGHT)
    draw.rounded_rectangle(box, radius=10, fill=CARD, outline=EDGE)

    rows = view["table"] or ["(no table above the editor)"]
    small = font(18)
    for index, row in enumerate(rows[:4]):
        row_y = y + BOX_TOP + 14 + index * 22
        if index == 0:
            draw.text((MARGIN + 20, row_y), row, font=small, fill=DIM)
        else:
            draw_row(draw, (MARGIN + 20, row_y), row, small)


def main():
    raw = sys.stdin.read() if len(sys.argv) < 2 else open(sys.argv[1]).read()
    cap = json.loads(raw)
    out = sys.argv[2] if len(sys.argv) > 2 else "assets/gallery.png"

    image = Image.new("RGB", (WIDTH, HEIGHT), BACK)
    draw = ImageDraw.Draw(image)

    draw.text((MARGIN, 44), "pi-wake-jobs", font=font(40, True), fill=TEXT)
    draw.text(
        (MARGIN, 100),
        "job_start returns at once. The exit opens one turn. The table clears when the work ends.",
        font=font(18),
        fill=DIM,
    )

    labels = ["/jobs all, three jobs open", "/jobs all, one left", "the last job stopped"]
    views = [cap["started"], cap["midway"], cap["ended"]]
    for offset, (label, view) in enumerate(zip(labels, views)):
        draw_frame(draw, 148 + offset * PITCH, label, view)

    draw.text((MARGIN, 578), "$ pi install npm:pi-wake-jobs", font=font(20, True), fill=ACCENT)
    image.save(out)
    print(out, WIDTH, "x", HEIGHT)


if __name__ == "__main__":
    main()
