"""Draw the Earful icon: a pixel-art ear catching sound waves, in the app's colours.

The shapes are drawn smooth on a fine canvas, then snapped to a coarse pixel
grid, so the ear stays round while still looking like pixel art.

    uv run --with pillow python mac/make_icon.py out.png        # 1024px Mac icon
    uv run --with pillow python mac/make_icon.py out.png 128    # just the tile

The Mac icon keeps the margin macOS expects around the rounded square. Given a
size, it crops to the tile instead, for the browser extension and the page.
"""
import sys

from PIL import Image, ImageDraw

# The page's palette (app/index.html :root).
PANEL = (34, 31, 48)
SCAN = (29, 26, 41)
AMBER = (242, 179, 61)
AMBER_D = (201, 130, 27)
SHADOW = (11, 10, 17)
GREEN = (123, 200, 108)

GRID = 22          # pixels across the art
FINE = 40          # smooth-canvas resolution per grid pixel
SIZE = 1024
INSET = 100        # macOS icons leave a margin around the rounded square
CORNER = 185


def layer(draw_fn):
    """Draw a shape on the fine canvas and snap it to the grid."""
    m = Image.new("L", (GRID * FINE, GRID * FINE), 0)
    draw_fn(ImageDraw.Draw(m), lambda *v: [x * FINE for x in v])
    small = m.resize((GRID, GRID), Image.BOX)
    return [[small.getpixel((c, r)) > 127 for c in range(GRID)] for r in range(GRID)]


def ear(d, s):
    d.ellipse(s(9, 2, 19.2, 15.5), fill=255)          # upper ear
    d.ellipse(s(9.3, 10.5, 15.5, 20), fill=255)       # lobe


def ridge(d, s):
    # The inner curl: a "C" open towards the face, ending in a short hook.
    d.arc(s(11, 4.5, 17.3, 13), 200, 110, fill=255, width=int(1.4 * FINE))
    d.ellipse(s(12, 8.2, 14.2, 10.4), fill=255)       # ear canal


def waves(d, s):
    # ")" shapes travelling right, into the ear.
    cx, cy = -0.5, 10.5
    for r in (2.6, 5.2, 7.8):
        d.arc(s(cx - r, cy - r, cx + r, cy + r), -38, 38, fill=255, width=int(1.2 * FINE))


def main(out: str, size: int | None = None) -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    box = (INSET, INSET, SIZE - INSET, SIZE - INSET)

    # Background tile with faint scanlines, clipped to the rounded square.
    tile = Image.new("RGBA", (SIZE, SIZE), PANEL)
    td = ImageDraw.Draw(tile)
    for y in range(0, SIZE, 12):
        td.line([(0, y), (SIZE, y)], fill=SCAN, width=4)
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, CORNER, fill=255)
    img.paste(tile, (0, 0), mask)
    d.rounded_rectangle(box, CORNER, outline=SHADOW, width=18)

    e, r, w = layer(ear), layer(ridge), layer(waves)
    px = (SIZE - 2 * INSET - 110) // GRID
    o = (SIZE - GRID * px) // 2
    sh = px // 3

    def colour(row, col):
        if w[row][col] and not e[row][col]:
            return GREEN
        if e[row][col]:
            return AMBER_D if r[row][col] else AMBER
        return None

    # Hard offset shadow first, then the pixels, like the page's boxes.
    for pass_ in ("shadow", "fill"):
        for row in range(GRID):
            for col in range(GRID):
                c = colour(row, col)
                if not c:
                    continue
                x, y = o + col * px, o + row * px
                if pass_ == "shadow":
                    d.rectangle([x + sh, y + sh, x + px + sh - 1, y + px + sh - 1], fill=SHADOW)
                else:
                    d.rectangle([x, y, x + px - 1, y + px - 1], fill=c)
    if size:
        img = img.crop(box).resize((size, size), Image.LANCZOS)
    img.save(out)


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else None)
