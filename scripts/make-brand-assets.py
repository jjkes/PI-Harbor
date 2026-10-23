#!/usr/bin/env python3
"""Draw this fork's own brand assets.

The upstream repository ships its own logo; a fork must not ship the upstream
mark. This script draws a distinct icon (a hub with three satellites — the
"subagent" motif) and a neutral DMG background, then leaves the platform icon
derivation to `scripts/make-icon.py`.

Run: python3 scripts/make-brand-assets.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"

BASE = 1024
TOP = (91, 91, 245)  # indigo
BOTTOM = (34, 211, 238)  # cyan


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
    scale = 4
    size = BASE * scale
    tile_mask = Image.new("L", (size, size), 0)
    inset = 64 * scale
    ImageDraw.Draw(tile_mask).rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=220 * scale,
        fill=255,
    )

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(gradient(size).convert("RGBA"), (0, 0), tile_mask)

    mark = Image.new("L", (size, size), 0)
    mark_draw = ImageDraw.Draw(mark)
    centre = (size // 2, int(size * 0.47))
    hub_radius = 96 * scale
    node_radius = 56 * scale
    orbit = 246 * scale
    stroke = 34 * scale

    satellites = []
    for degrees in (-90, 30, 150):
        radians = math.radians(degrees)
        satellites.append(
            (
                centre[0] + orbit * math.cos(radians),
                centre[1] + orbit * math.sin(radians),
            )
        )

    for node in satellites:
        mark_draw.line([centre, node], fill=255, width=stroke)
    mark_draw.ellipse(
        (
            centre[0] - hub_radius,
            centre[1] - hub_radius,
            centre[0] + hub_radius,
            centre[1] + hub_radius,
        ),
        fill=255,
    )
    for node in satellites:
        mark_draw.ellipse(
            (
                node[0] - node_radius,
                node[1] - node_radius,
                node[0] + node_radius,
                node[1] + node_radius,
            ),
            fill=255,
        )

    white = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    canvas.paste(white, (0, 0), Image.composite(mark, Image.new("L", (size, size), 0), tile_mask))
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
    label = "PI-Subagent Desktop"
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
