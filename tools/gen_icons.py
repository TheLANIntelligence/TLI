#!/usr/bin/env python3
"""
tools/gen_icons.py — Generate TLI PNG icons from tli-icon.svg.

Run once after cloning or whenever the SVG changes:
    python tools/gen_icons.py

Outputs:
    frontend/tli-icon-192.png
    frontend/tli-icon-512.png

Requires:  pip install cairosvg
           (cairosvg needs libcairo — on Windows install via GTK3 runtime or
            use the Pillow fallback below by passing --pillow)
"""

import argparse
import os
import sys
from pathlib import Path

HERE    = Path(__file__).parent
ROOT    = HERE.parent
SVG_SRC = ROOT / "frontend" / "tli-icon.svg"
OUT_DIR = ROOT / "frontend"

SIZES = [192, 512]


def _gen_cairosvg():
    import cairosvg
    for size in SIZES:
        out = OUT_DIR / f"tli-icon-{size}.png"
        cairosvg.svg2png(
            url=str(SVG_SRC),
            write_to=str(out),
            output_width=size,
            output_height=size,
        )
        print(f"  wrote {out.relative_to(ROOT)}  ({size}×{size})")


def _gen_pillow():
    """
    Fallback: draw the icon manually with Pillow (no cairo required).
    Matches the SVG design: dark bg, emerald TLI monogram, accent bars.
    """
    from PIL import Image, ImageDraw, ImageFont

    BG      = (15,  23,  42)    # #0f172a
    ACCENT  = (16, 185, 129)    # #10b981
    ACCENT2 = (16, 185, 129, 64)

    for size in SIZES:
        img  = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Rounded background
        r = int(size * 0.157)   # ~80/512
        draw.rounded_rectangle([0, 0, size-1, size-1], radius=r, fill=BG)

        # Top accent bar
        bx1 = int(size * 0.125)
        bx2 = int(size * 0.875)
        by  = int(size * 0.140)
        bh  = max(3, int(size * 0.012))
        draw.rounded_rectangle([bx1, by, bx2, by + bh], radius=bh//2, fill=ACCENT)

        # Bottom accent bar
        by2 = int(size * 0.848)
        draw.rounded_rectangle([bx1, by2, bx2, by2 + bh], radius=bh//2, fill=ACCENT)

        # "TLI" text — try to load a monospace font, fall back to default
        font_size = int(size * 0.41)
        font = None
        for fname in ["cour.ttf", "CourierNew.ttf", "DejaVuSansMono.ttf", "LiberationMono-Bold.ttf"]:
            try:
                font = ImageFont.truetype(fname, font_size)
                break
            except Exception:
                pass
        if font is None:
            font = ImageFont.load_default()

        text = "TLI"
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        tx = (size - tw) // 2 - bbox[0]
        ty = (size - th) // 2 - bbox[1] - int(size * 0.03)
        draw.text((tx, ty), text, font=font, fill=ACCENT)

        # Dot accents
        dot_r = max(2, int(size * 0.008))
        dot_y = int(size * 0.688)
        for dx in [0.125, 0.164, 0.203, 0.789, 0.828, 0.867]:
            x = int(size * dx)
            draw.ellipse([x, dot_y, x+dot_r*2, dot_y+dot_r*2], fill=(*ACCENT, 64))

        out = OUT_DIR / f"tli-icon-{size}.png"
        img.save(str(out), "PNG")
        print(f"  wrote {out.relative_to(ROOT)}  ({size}×{size})  [Pillow]")


def main():
    parser = argparse.ArgumentParser(description="Generate TLI PNG icons")
    parser.add_argument("--pillow", action="store_true",
                        help="Use Pillow fallback instead of cairosvg")
    args = parser.parse_args()

    if not SVG_SRC.exists():
        print(f"Error: SVG source not found: {SVG_SRC}", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Generating icons from {SVG_SRC.name} …")

    if args.pillow:
        try:
            _gen_pillow()
        except ImportError:
            print("Error: pip install Pillow", file=sys.stderr)
            sys.exit(1)
    else:
        try:
            _gen_cairosvg()
        except ImportError:
            print("cairosvg not found — trying Pillow fallback …")
            try:
                _gen_pillow()
            except ImportError:
                print("Error: install cairosvg or Pillow\n  pip install cairosvg", file=sys.stderr)
                sys.exit(1)

    print("Done. Add frontend/tli-icon-192.png and tli-icon-512.png to version control.")


if __name__ == "__main__":
    main()
