#!/usr/bin/env python3
"""Build PI-Harbor Desktop brand assets.

``apps/desktop/build/brand-mark.png`` is the fixed, transparent white P
mark selected for the product identity. This script composites it over a
neutral graphite tile and draws the DMG background. Platform icon derivation
remains in ``scripts/make-icon.py``.

Run: python3 scripts/make-brand-assets.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
MARK = BUILD / "brand-mark.png"

BASE = 1024
TOP = (36, 36, 38)
BOTTOM = (69, 69, 72)


def gradient(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        # A slight horizontal shift keeps the ramp from looking like a flat band.
        ratio = y / (size - 1)
        colour = tuple(
            round(TOP[channel] + (BOTTOM[channel] - TOP[channel]) * ratio) for channel in range(3)
        )
        draw.line([(0, y), (size, y)], fill=colour)
    return image


def draw_icon() -> Image.Image:
    if not MARK.is_file():
        raise FileNotFoundError(f"brand mark is missing: {MARK}")
    with Image.open(MARK) as source:
        mark = source.convert("RGBA")

    scale = 3
    size = BASE * scale
    tile_mask = Image.new("L", (size, size), 0)
    inset = 64 * scale
    ImageDraw.Draw(tile_mask).rounded_rectangle(
        (inset, inset, size - inset, size - inset), radius=220 * scale, fill=255
    )
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(gradient(size).convert("RGBA"), (0, 0), tile_mask)

    # Keep the highlight subtle; the white letter remains the only strong mark.
    highlight = Image.new("L", (size, size), 0)
    highlight_draw = ImageDraw.Draw(highlight)
    for step in range(220):
        alpha = int(24 * (1 - step / 220) ** 2)
        highlight_draw.ellipse(
            (
                -size * 0.35 + step * 4,
                -size * 0.62 + step * 4,
                size * 1.35 - step * 4,
                size * 0.55 - step * 4,
            ),
            fill=alpha,
        )
    highlight = highlight.filter(ImageFilter.GaussianBlur(60 * scale))
    canvas.paste(
        Image.new("RGBA", (size, size), (255, 255, 255, 255)),
        (0, 0),
        Image.composite(highlight, Image.new("L", (size, size), 0), tile_mask),
    )

    target_height = 512 * scale
    target_width = round(mark.width * target_height / mark.height)
    resized = mark.resize((target_width, target_height), Image.LANCZOS)
    x = (size - target_width) // 2
    y = round(size * 0.49 - target_height / 2)
    canvas.paste(resized, (x, y), resized)
    return canvas.resize((BASE, BASE), Image.LANCZOS)


def scale_of(size: tuple[int, int]) -> int:
    """Render scale used for the background: 4x of the 720x440 layout."""
    return max(1, round(size[0] / 720))


def font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size)


def draw_dmg_background(width: int, height: int) -> Image.Image:
    """Draw at 4x for detail, then step down to the requested size."""
    size = (width * 4, height * 4)
    image = Image.new("RGB", size, (247, 248, 252))
    draw = ImageDraw.Draw(image)
    for y in range(size[1]):
        ratio = y / (size[1] - 1)
        colour = (
            round(247 - 12 * ratio),
            round(248 - 10 * ratio),
            round(252 - 6 * ratio),
        )
        draw.line([(0, y), (size[0], y)], fill=colour)
    label = "PI-Harbor Desktop"
    text_font = font(22 * scale_of(size))
    box = draw.textbbox((0, 0), label, font=text_font)
    draw.text(
        ((size[0] - (box[2] - box[0])) / 2, size[1] - 56 * scale_of(size)),
        label,
        font=text_font,
        fill=(108, 112, 128),
    )
    return image.resize((width, height), Image.LANCZOS)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    draw_icon().save(BUILD / "icon_1024.png")
    draw_dmg_background(720, 440).save(BUILD / "dmg-background.png")
    draw_dmg_background(1440, 880).save(BUILD / "dmg-background@2x.png")
    draw_icon().resize((512, 512), Image.LANCZOS).save(BUILD / "logo_dark.png")
    print("wrote icon_1024.png, dmg-background.png, dmg-background@2x.png, logo_dark.png")


if __name__ == "__main__":
    main()
