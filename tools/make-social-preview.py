#!/usr/bin/env python3
"""Render assets/social-preview.png — the 1280x640 link-preview / README banner card.

Not part of the shipped site: nothing in the browser ever loads this file.
It only exists so the banner can be regenerated instead of hand-edited.

Usage:
    pip install Pillow
    python3 tools/make-social-preview.py

Output: assets/social-preview.png (1280x640)
"""

import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1280, 640
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "social-preview.png")

BG       = (247, 248, 250)
INK      = (31, 35, 40)
MUTED    = (107, 114, 128)
ACCENT   = (59, 110, 245)
VIOLET   = (124, 58, 237)
PINK     = (236, 72, 153)
WHITE    = (255, 255, 255)
BORDER   = (227, 230, 234)

FONT_DIR = "/System/Library/Fonts"
SUPP     = os.path.join(FONT_DIR, "Supplemental")

BOLD    = os.path.join(SUPP, "Arial Bold.ttf")
REGULAR = os.path.join(SUPP, "Arial.ttf")
UNICODE = os.path.join(SUPP, "Arial Unicode.ttf")


def font(path, size):
    return ImageFont.truetype(path, size)


def soft_glow(base):
    """Ambient colour wash in the corners, blurred so it reads as light, not shapes."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for cx, cy, rx, ry, col, a in [
        (120,  40, 420, 300, ACCENT, 30),
        (1160, 70, 380, 280, VIOLET, 28),
        (1020, 620, 420, 300, PINK, 22),
        (240, 640, 360, 240, ACCENT, 18),
    ]:
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=col + (a,))
    layer = layer.filter(ImageFilter.GaussianBlur(110))
    return Image.alpha_composite(base.convert("RGBA"), layer)


# ---------------------------------------------------------------- glyph helpers
# Every glyph is drawn inside a square box (gx, gy, gs) using plain primitives.

def glyph_snake(d, x, y, s, c):
    u = s / 5.0
    path = [(0, 0), (1, 0), (2, 0), (2, 1), (2, 2), (3, 2), (4, 2)]
    for px, py in path:
        d.rounded_rectangle([x + px * u, y + py * u, x + px * u + u - u * .12, y + py * u + u - u * .12],
                            radius=u * .3, fill=c)
    d.ellipse([x, y, x + u * .5, y + u * .5], fill=(255, 255, 255))


def glyph_tetris(d, x, y, s, c):
    u = s / 4.0
    for px, py in [(0, 0), (1, 0), (2, 0), (1, 1)]:
        d.rounded_rectangle([x + px * u, y + py * u + u * .5, x + px * u + u - u * .1, y + py * u + u * 1.4],
                            radius=u * .16, fill=c)


def glyph_crate(d, x, y, s, c):
    d.rounded_rectangle([x, y, x + s, y + s], radius=s * .12, outline=c, width=max(3, int(s * .09)))
    i = s * .22
    d.line([x + i, y + i, x + s - i, y + s - i], fill=c, width=max(3, int(s * .09)))
    d.line([x + s - i, y + i, x + i, y + s - i], fill=c, width=max(3, int(s * .09)))


def glyph_sudoku(d, x, y, s, c):
    u = s / 3.0
    for r in range(3):
        for cc in range(3):
            col = c if (r, cc) in ((0, 1), (1, 1), (2, 0)) else (c[0], c[1], c[2], 70)
            d.rounded_rectangle([x + cc * u, y + r * u, x + cc * u + u * .74, y + r * u + u * .74],
                                radius=u * .14, fill=col)


def glyph_mine(d, x, y, s, c):
    cx, cy, r = x + s / 2, y + s / 2, s * .3
    for a in range(8):
        ang = a * math.pi / 4
        d.line([cx + math.cos(ang) * r * .8, cy + math.sin(ang) * r * .8,
                cx + math.cos(ang) * r * 1.65, cy + math.sin(ang) * r * 1.65],
               fill=c, width=max(3, int(s * .075)))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    d.ellipse([cx - r * .34, cy - r * .42, cx - r * .02, cy - r * .1], fill=(255, 255, 255))


def glyph_2048(d, x, y, s, c):
    d.rounded_rectangle([x, y, x + s, y + s], radius=s * .14, fill=c)
    f = font(BOLD, int(s * .34))
    t = "2048"
    tw = d.textlength(t, font=f)
    d.text((x + s / 2 - tw / 2, y + s / 2), t, font=f, fill=(255, 255, 255), anchor="lm")


def glyph_board(d, x, y, s, c):
    step = s / 3.0
    for i in range(4):
        d.line([x + i * step, y, x + i * step, y + s], fill=c + (140,), width=3)
        d.line([x, y + i * step, x + s, y + i * step], fill=c + (140,), width=3)
    d.ellipse([x + step * .35, y + step * .35, x + step * 1.1, y + step * 1.1], fill=(35, 38, 42))
    d.ellipse([x + step * 1.9, y + step * 1.55, x + step * 2.65, y + step * 2.3],
              fill=(255, 255, 255), outline=c + (200,), width=3)


def glyph_breakout(d, x, y, s, c):
    u = s / 4.0
    for i in range(3):
        d.rounded_rectangle([x + i * u, y, x + i * u + u * .82, y + u * .5], radius=u * .1, fill=c)
    d.ellipse([x + s * .58, y + s * .52, x + s * .58 + u * .52, y + s * .52 + u * .52], fill=PINK)
    d.rounded_rectangle([x + s * .12, y + s * .86, x + s * .88, y + s], radius=u * .12, fill=INK)


def glyph_fruit(d, x, y, s, c):
    cx, cy, r = x + s / 2, y + s * .38, s * .27
    d.line([cx, cy - r * .8, cx, cy - r * 1.5], fill=(101, 163, 13), width=max(3, int(s * .07)))
    d.ellipse([cx, cy - r * 1.75, cx + r * .6, cy - r * 1.15], fill=(101, 163, 13))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    d.rounded_rectangle([x + s * .04, y + s * .6, x + s * .96, y + s * .73],
                        radius=s * .06, fill=INK)
    d.polygon([(x + s * .14, y + s * .73), (x + s * .86, y + s * .73),
               (x + s * .74, y + s * .99), (x + s * .26, y + s * .99)], fill=INK)


TILES = [
    (glyph_snake,    (59, 110, 245)),
    (glyph_tetris,   (6, 148, 162)),
    (glyph_crate,    (180, 83, 9)),
    (glyph_sudoku,   (124, 58, 237)),
    (glyph_mine,     (220, 38, 38)),
    (glyph_2048,     (234, 88, 12)),
    (glyph_board,    (51, 65, 85)),
    (glyph_breakout, (37, 99, 235)),
    (glyph_fruit,    (225, 29, 72)),
]


def draw_grid(img):
    """A 3x3 wall of game tiles on the right — the visual "it is a games collection" cue."""
    size, gap = 140, 20
    x0 = W - 88 - (size * 3 + gap * 2)
    y0 = (H - (size * 3 + gap * 2)) / 2

    def tile_xy(i):
        r, c = divmod(i, 3)
        return x0 + c * (size + gap), y0 + r * (size + gap)

    # Shadows go on their own layer so only they get blurred.
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for i in range(len(TILES)):
        x, y = tile_xy(i)
        sd.rounded_rectangle([x + 2, y + 8, x + size + 2, y + size + 10],
                             radius=26, fill=(16, 24, 40, 30))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(9)))

    d = ImageDraw.Draw(img)
    for i, (fn, col) in enumerate(TILES):
        x, y = tile_xy(i)
        d.rounded_rectangle([x, y, x + size, y + size], radius=26,
                            fill=WHITE, outline=BORDER, width=2)
        inset = 34
        fn(d, x + inset, y + inset, size - inset * 2, col)


def main():
    img = soft_glow(Image.new("RGB", (W, H), BG))
    draw_grid(img)
    d = ImageDraw.Draw(img)

    x = 88

    # Eyebrow pill — the positioning claim, so it gets the accent treatment.
    eye = "100% AI-GENERATED   ·   0 HANDWRITTEN LINES"
    eye_size = 21
    f_eye = font(BOLD, eye_size)
    while d.textlength(eye, font=f_eye) > 560 and eye_size > 13:
        eye_size -= 1
        f_eye = font(BOLD, eye_size)
    ew = d.textlength(eye, font=f_eye)
    d.rounded_rectangle([x, 78, x + ew + 44, 122], radius=22,
                        fill=(245, 243, 255), outline=(221, 214, 254), width=2)
    d.text((x + 22, 88), eye, font=f_eye, fill=VIOLET)

    # Title
    d.text((x, 168), "litegame", font=font(BOLD, 104), fill=INK)

    # Subtitle
    d.text((x, 300), "HTML5 mini games in plain vanilla JavaScript",
           font=font(REGULAR, 31), fill=MUTED)

    # Rule
    d.line([x, 366, x + 520, 366], fill=BORDER, width=2)

    # Feature line (Arial Unicode so the CJK half renders too)
    f_feat = font(UNICODE, 23)
    feats = "13 games   ·   Zero dependencies   ·   Bilingual EN / 中文"
    d.text((x, 396), feats, font=f_feat, fill=INK)

    # Call to action
    d.text((x, 470), "litegame-hub.github.io", font=font(BOLD, 34), fill=ACCENT)
    d.text((x, 520), "MIT licensed  ·  no build step  ·  no ads, no tracking",
           font=font(REGULAR, 22), fill=MUTED)

    img.convert("RGB").save(OUT, "PNG", optimize=True)
    print("wrote", os.path.normpath(OUT), img.size)


if __name__ == "__main__":
    main()
