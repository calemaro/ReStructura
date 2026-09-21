#!/usr/bin/env python3
"""Draws the sample floor plan that ships with the repository (src/public/assets/demo-plan.png).

The plan is fictional. It exists so the app runs for anyone who clones the repo
without needing a real drawing. Style follows a 1:100 architectural plan: thick
walls, window openings as triple lines, door swings, a scale bar and a north arrow.
Coordinates below are in centimetres; PX_PER_M sets the raster resolution.
"""
from PIL import Image, ImageDraw, ImageFont

PX_PER_M = 120                      # 1 m = 120 px  ->  a 12 m x 9 m flat fits 1600 x 1200
W_M, H_M = 12.0, 9.0
MARGIN = 100
W = int(W_M * PX_PER_M) + 2 * MARGIN
H = int(H_M * PX_PER_M) + 2 * MARGIN
WALL = 14                           # exterior wall thickness in px (~12 cm at this scale)
INNER = 8
INK = (28, 32, 30)
PAPER = (247, 248, 244)
FAINT = (205, 209, 200)

def m(x, y):
    """metres -> pixels (origin top-left of the flat)"""
    return MARGIN + x * PX_PER_M, MARGIN + y * PX_PER_M

img = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(img)

# faint 1 m grid, like drafting paper
for i in range(int(W_M) + 1):
    x, _ = m(i, 0); d.line([(x, MARGIN), (x, H - MARGIN)], fill=FAINT, width=1)
for j in range(int(H_M) + 1):
    _, y = m(0, j); d.line([(MARGIN, y), (W - MARGIN, y)], fill=FAINT, width=1)

def wall(x1, y1, x2, y2, t=WALL):
    d.line([m(x1, y1), m(x2, y2)], fill=INK, width=t)

# exterior envelope
wall(0, 0, W_M, 0); wall(W_M, 0, W_M, H_M); wall(W_M, H_M, 0, H_M); wall(0, H_M, 0, 0)
# interior partitions: living room left, kitchen top-right, bath + two bedrooms bottom-right
wall(6.5, 0, 6.5, 4.0, INNER)          # living | kitchen
wall(6.5, 4.0, W_M, 4.0, INNER)        # kitchen | corridor
wall(6.5, 4.0, 6.5, H_M, INNER)        # living | corridor+rooms
wall(6.5, 5.4, W_M, 5.4, INNER)        # corridor | bedrooms
wall(9.2, 5.4, 9.2, H_M, INNER)        # bedroom | bedroom
wall(9.6, 0, 9.6, 4.0, INNER)          # kitchen | bath

def opening(x1, y1, x2, y2, t=WALL):
    """erase a stretch of wall (door or window gap)"""
    d.line([m(x1, y1), m(x2, y2)], fill=PAPER, width=t + 2)

def window(x1, y1, x2, y2):
    opening(x1, y1, x2, y2)
    for k in (-4, 0, 4):
        if y1 == y2: d.line([(m(x1, y1)[0], m(x1, y1)[1] + k), (m(x2, y2)[0], m(x2, y2)[1] + k)], fill=INK, width=1)
        else:        d.line([(m(x1, y1)[0] + k, m(x1, y1)[1]), (m(x2, y2)[0] + k, m(x2, y2)[1])], fill=INK, width=1)

def door(x, y, w, direction):
    """door leaf + quarter-circle swing. direction: 'down','up','right','left' from hinge at (x,y)"""
    r = w * PX_PER_M
    hx, hy = m(x, y)
    if direction == "down":
        opening(x, y, x + w, y, INNER); d.line([(hx, hy), (hx, hy + r)], fill=INK, width=2)
        d.arc([hx - r, hy - r, hx + r, hy + r], 0, 90, fill=INK, width=1)
    elif direction == "up":
        opening(x, y, x + w, y, INNER); d.line([(hx, hy), (hx, hy - r)], fill=INK, width=2)
        d.arc([hx - r, hy - r, hx + r, hy + r], 270, 360, fill=INK, width=1)
    elif direction == "right":
        opening(x, y, x, y + w, INNER); d.line([(hx, hy), (hx + r, hy)], fill=INK, width=2)
        d.arc([hx - r, hy - r, hx + r, hy + r], 0, 90, fill=INK, width=1)
    elif direction == "left":
        opening(x, y, x, y + w, INNER); d.line([(hx, hy), (hx - r, hy)], fill=INK, width=2)
        d.arc([hx - r, hy - r, hx + r, hy + r], 90, 180, fill=INK, width=1)

# windows on the exterior
window(1.2, 0, 3.0, 0); window(3.8, 0, 5.6, 0); window(7.2, 0, 8.8, 0)
window(0, 2.0, 0, 4.0); window(0, 5.5, 0, 7.5)
window(7.0, H_M, 8.6, H_M); window(10.0, H_M, 11.4, H_M)
window(W_M, 1.0, W_M, 2.6)
# doors
door(6.5, 2.4, 0.9, "right")     # living -> kitchen
door(6.5, 4.4, 0.9, "right")     # living -> corridor
door(9.6, 2.6, 0.8, "right")     # kitchen -> bath
door(7.4, 5.4, 0.9, "down")      # corridor -> bedroom 1
door(10.0, 5.4, 0.9, "down")     # corridor -> bedroom 2
opening(0, 7.8, 0, 8.8, WALL); d.line([m(0, 7.8), m(0, 8.8)], fill=INK, width=2)   # entrance on the west wall
d.line([m(0, 7.8), (m(0, 7.8)[0] + 1.0 * PX_PER_M, m(0, 7.8)[1])], fill=INK, width=2)
d.arc([m(0, 7.8)[0] - PX_PER_M, m(0, 7.8)[1] - PX_PER_M, m(0, 7.8)[0] + PX_PER_M, m(0, 7.8)[1] + PX_PER_M], 0, 90, fill=INK, width=1)

# ceiling heights, written the way Italian cadastral plans do it
try:
    font = ImageFont.truetype("/usr/share/fonts/liberation-mono/LiberationMono-Regular.ttf", 26)
    small = ImageFont.truetype("/usr/share/fonts/liberation-mono/LiberationMono-Regular.ttf", 20)
except OSError:
    font = small = ImageFont.load_default()
for (x, y, txt) in [(3.0, 4.3, "H 3.00"), (8.0, 1.9, "H 2.70"), (10.7, 1.9, "H 2.70"),
                    (7.7, 7.2, "H 3.00"), (10.5, 7.2, "H 3.00"), (9.0, 4.6, "H 2.40")]:
    d.text(m(x, y), txt, fill=INK, font=font, anchor="mm")

# scale bar: 0 - 1 - 2 m, bottom left
bx, by = MARGIN, H - 60
seg = PX_PER_M
for i in range(2):
    d.rectangle([bx + i * seg, by - 6, bx + (i + 1) * seg, by + 6], outline=INK, fill=INK if i % 2 == 0 else PAPER, width=2)
for i, lab in enumerate(["0", "1", "2 m"]):
    d.text((bx + i * seg, by + 14), lab, fill=INK, font=small, anchor="ma")
d.text((bx + 2 * seg + 30, by), "SCALA 1:100", fill=INK, font=small, anchor="lm")

# north arrow, bottom right
nx, ny = W - MARGIN - 40, H - 70
d.polygon([(nx, ny - 40), (nx - 12, ny), (nx, ny - 10), (nx + 12, ny)], fill=INK)
d.text((nx, ny - 60), "N", fill=INK, font=small, anchor="ms")

d.text((W // 2, 40), "DEMO PLAN — fictional layout for testing", fill=(120, 126, 120), font=small, anchor="mm")

img.save("src/public/assets/demo-plan.png", optimize=True)
print(f"wrote src/public/assets/demo-plan.png  {W}x{H}px  ({PX_PER_M} px/m)")
