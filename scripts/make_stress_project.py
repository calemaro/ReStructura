#!/usr/bin/env python3
"""Build a large, realistic ReStructura project for testing, as an exported .zip.

Import it in the app with Main menu -> Import project (.zip)...; the app copies it
into its own data folder like any other project. Nothing here writes anywhere but
the output folder you give.

What it contains (defaults):
  4 floors   two drawn in the editor (walls, doors, windows), one plan image that is
             calibrated and partly traced, one plan image left uncalibrated
  ~300 pins  every category, labels, notes, rooms, measurements, spread over months
  ~1000 photos  1600 x 1200 JPEGs with thumbnails, some with captions
  rooms, doors of every type, windows of every type, kept measurements

The database layout is read from src-tauri/src/db.rs at run time, so the file
matches the app exactly and this script does not go stale when the schema changes.

Usage:  python3 scripts/make_stress_project.py OUTPUT_DIR [--photos 1000] [--pins 300]
Needs:  Pillow (pip install pillow)
"""

import argparse
import json
import math
import random
import re
import shutil
import sqlite3
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
rng = random.Random(20260923)          # fixed seed: the same project every run

CATEGORIES = ["gas", "electric", "data", "alarm", "intercom", "multimedia",
              "cold_water", "hot_water", "drain", "other"]
CAT_WEIGHTS = [4, 30, 12, 5, 4, 3, 15, 15, 8, 4]
CAT_COLOUR = {"gas": (242, 195, 0), "electric": (43, 43, 43), "data": (230, 230, 230),
              "alarm": (122, 75, 42), "intercom": (110, 193, 228), "multimedia": (123, 63, 160),
              "cold_water": (27, 98, 181), "hot_water": (212, 43, 30), "drain": (46, 155, 79),
              "other": (138, 143, 138)}
LABELS = {
    "gas": ["Gas supply to boiler", "Gas pipe, kitchen hob", "Gas meter line"],
    "electric": ["Socket circuit", "Lighting circuit", "Junction box", "Conduit to switch",
                 "Oven line 6 mm²", "Consumer unit feed", "Bathroom fan supply"],
    "data": ["Ethernet run", "TV aerial coax", "Phone line", "Fibre to router"],
    "alarm": ["Alarm sensor cable", "Siren line", "PIR detector cable"],
    "intercom": ["Intercom riser", "Video door phone cable"],
    "multimedia": ["Speaker cable", "HDMI conduit", "Home automation bus"],
    "cold_water": ["Cold water riser", "Cold supply to sink", "Toilet cistern feed", "Washing machine inlet"],
    "hot_water": ["Radiator flow", "Radiator return", "Hot water to shower", "Underfloor heating loop"],
    "drain": ["Sink waste", "Shower drain", "Soil stack", "Condensate drain"],
    "other": ["Old nail plate", "Steel lintel", "Void behind plasterboard", "Unknown pipe"],
}
NOTES = [
    "Copper 22 mm, runs vertically inside the wall.",
    "PVC conduit 20 mm, horizontal at the height noted below.",
    "Found during demolition, photographed before closing the wall.",
    "Do not drill within 15 cm either side.",
    "Joint visible in the photos; the pipe turns towards the floor here.",
    "Electrician confirmed this circuit is on breaker 4.",
    "Multilayer 16 mm, insulated sheath.",
    "Runs under the screed to the next room.",
    "Replaced in this renovation; the old one was capped behind the plaster.",
]
REFS = ["left jamb of the door", "corner of the room", "window sill", "floor tile edge",
        "centre of the radiator", "kitchen worktop edge", "ceiling"]
ROOMS = [("Kitchen", 270), ("Living room", 300), ("Bathroom", 250), ("Bedroom", 280),
         ("Study", 270), ("Hall", 260), ("Storage", 240), ("Laundry", 250), ("Dining room", 290)]


def schema():
    """The CREATE TABLE block and the version number, taken from db.rs."""
    src = (ROOT / "src-tauri/src/db.rs").read_text()
    block = re.search(r'execute_batch\(\s*"(CREATE TABLE IF NOT EXISTS levels.*?)",\s*\)\?;', src, re.S)
    version = re.search(r"const DB_VERSION: i64 = (\d+);", src)
    schema_version = re.search(r"pub const SCHEMA_VERSION: u32 = (\d+);", (ROOT / "src-tauri/src/projects.rs").read_text())
    return block.group(1), int(version.group(1)), int(schema_version.group(1))


def font(size):
    for name in ["DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf", "Arial.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


# ---- floors drawn in the editor ----------------------------------------------------------
def grid_floor(ox, oy, cols, rows, cell_w, cell_h, outer=30, inner=10):
    """Walls of a building laid out as a grid of rooms, split at every junction so
    walls meet at shared corners exactly like walls drawn in the app."""
    walls = []
    xs = [ox + i * cell_w for i in range(cols + 1)]
    ys = [oy + j * cell_h for j in range(rows + 1)]
    for j, y in enumerate(ys):
        for i in range(cols):
            edge = j in (0, rows)
            walls.append((xs[i], y, xs[i + 1], y, outer if edge else inner, edge))
    for i, x in enumerate(xs):
        for j in range(rows):
            edge = i in (0, cols)
            walls.append((x, ys[j], x, ys[j + 1], outer if edge else inner, edge))
    rooms = [((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2) for j in range(rows) for i in range(cols)]
    return walls, rooms, (xs[0], ys[0], xs[-1], ys[-1])


def openings_for(walls_with_ids, px_per_cm=1.0):
    """A door in most inner walls, windows in most outer ones, every type represented."""
    out = []
    door_kinds = ["door"] * 6 + ["double_door", "pocket_door", "opening"]
    window_kinds = ["window"] * 5 + ["french_window", "french_window_2", "fixed_window"]
    for wid, (x1, y1, x2, y2, th, edge) in walls_with_ids:
        length = math.hypot(x2 - x1, y2 - y1)
        if edge and rng.random() < 0.7:
            kind = rng.choice(window_kinds)
            width = (120 if kind != "fixed_window" else 90) * px_per_cm
        elif not edge and rng.random() < 0.75:
            kind = rng.choice(door_kinds)
            width = (140 if kind == "double_door" else 80) * px_per_cm
        else:
            continue
        pocket = width if kind == "pocket_door" else 0
        if length < width + pocket + 60 * px_per_cm:
            continue
        offset = rng.uniform(30 * px_per_cm + pocket, length - width - 30 * px_per_cm)
        out.append((wid, kind, round(offset, 2), round(width, 2), rng.randint(0, 1), rng.choice([1, -1])))
    return out


def plan_image(path, walls, size, scale):
    """A plain black-on-white plan, like a scan, for the image floors."""
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    for x1, y1, x2, y2, th, _ in walls:
        d.line([(x1 * scale, y1 * scale), (x2 * scale, y2 * scale)], fill="black", width=max(2, int(th * scale)))
    d.text((40, size[1] - 70), "Stress test plan (1:100)", fill="black", font=font(36))
    img.save(path)


# ---- photos --------------------------------------------------------------------------------
def photo(path, thumb_path, text, category):
    """A 1600 x 1200 'site photo': a wall-coloured gradient, a pipe or cable in the
    category colour, and the pin and photo number written large."""
    w, h = 1600, 1200
    base = rng.randint(170, 215)
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(0, h, 8):
        c = base - y // 30
        d.rectangle([0, y, w, y + 8], fill=(c, c - 6, c - 14))
    colour = CAT_COLOUR[category]
    if rng.random() < 0.5:
        x = rng.randint(300, 1300)
        d.rectangle([x, 0, x + rng.randint(30, 70), h], fill=colour, outline=(20, 20, 20), width=3)
    else:
        y = rng.randint(300, 900)
        d.rectangle([0, y, w, y + rng.randint(30, 70)], fill=colour, outline=(20, 20, 20), width=3)
    for _ in range(12):
        x, y = rng.randint(0, w), rng.randint(0, h)
        d.ellipse([x, y, x + 18, y + 18], fill=(base - 50, base - 55, base - 60))
    d.rectangle([60, 60, 1000, 200], fill=(255, 255, 255))
    d.text((90, 90), text, fill=(20, 20, 20), font=font(64))
    img.save(path, "JPEG", quality=82)
    img.thumbnail((400, 400))
    img.save(thumb_path, "JPEG", quality=80)


# ---- the project -----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--photos", type=int, default=1000)
    ap.add_argument("--pins", type=int, default=300)
    args = ap.parse_args()

    ddl, db_version, schema_version = schema()
    work = args.out / "stress-test"
    if work.exists():
        shutil.rmtree(work)
    (work / "plans").mkdir(parents=True)
    (work / "photos").mkdir()
    db = sqlite3.connect(work / "plan.db")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(ddl)
    db.execute(f"PRAGMA user_version = {db_version}")

    floors = []   # (level_id, walls_with_ids, room_points, bbox, px_per_cm)

    def add_drawn(name, order, cols, rows, cw, ch, extra_diagonal=False):
        db.execute("INSERT INTO levels (name, image_path, sort_order, cm_per_px, width_px, height_px) VALUES (?, '', ?, 1.0, 4000, 3000)", (name, order))
        lid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        walls, rooms, bbox = grid_floor(700, 600, cols, rows, cw, ch)
        if extra_diagonal:
            x0, y0, x1, y1 = bbox
            walls.append((x1, y0 + ch, x1 + 400, y0 + ch + 300, 20, True))
        return lid, walls, rooms, bbox, 1.0

    def add_image(name, order, file, walls, size, scale, calibrated):
        plan_image(work / "plans" / file, walls, size, scale)
        db.execute("INSERT INTO levels (name, image_path, sort_order, cm_per_px) VALUES (?, ?, ?, ?)",
                   (name, f"plans/{file}", order, (1 / scale) if calibrated else None))
        return db.execute("SELECT last_insert_rowid()").fetchone()[0]

    specs = [add_drawn("Ground floor (drawn)", 0, 8, 5, 320, 300),
             add_drawn("First floor (drawn)", 1, 7, 4, 360, 330, extra_diagonal=True)]
    # image floors: coordinates in image pixels (scale px per cm)
    s_walls, s_rooms, s_bbox = grid_floor(120, 100, 4, 2, 300, 280)
    scale = 0.8
    img_walls = [(x1 * scale, y1 * scale, x2 * scale, y2 * scale, th, e) for x1, y1, x2, y2, th, e in s_walls]
    lid3 = add_image("Mezzanine (plan image)", 2, "mezzanine.png", s_walls, (1200, 700), scale, True)
    lid4 = add_image("Cellar (plan image, not calibrated)", 3, "cellar.png", s_walls, (1200, 700), scale, False)

    for lid, walls, rooms, bbox, k in specs:
        floors.append((lid, walls, rooms, bbox, k, True))
    floors.append((lid3, img_walls[: len(img_walls) // 2], [(x * scale, y * scale) for x, y in s_rooms],
                   tuple(v * scale for v in s_bbox), scale, True))    # calibrated, half traced
    floors.append((lid4, [], [(x * scale, y * scale) for x, y in s_rooms], tuple(v * scale for v in s_bbox), scale, False))

    # walls, openings, rooms, rulers
    counts = {"walls": 0, "openings": 0, "rooms": 0, "rulers": 0}
    room_ids = {}
    for lid, walls, rooms, bbox, k, calibrated in floors:
        with_ids = []
        for w in walls:
            thick_cm = w[4]
            db.execute("INSERT INTO walls (level_id, x1, y1, x2, y2, thickness_cm) VALUES (?, ?, ?, ?, ?, ?)",
                       (lid, round(w[0], 2), round(w[1], 2), round(w[2], 2), round(w[3], 2), thick_cm))
            with_ids.append((db.execute("SELECT last_insert_rowid()").fetchone()[0], w))
            counts["walls"] += 1
        for wid, kind, off, width, hinge, side in openings_for(with_ids, k):
            db.execute("INSERT INTO openings (level_id, wall_id, kind, offset_px, width_px, hinge, side) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (lid, wid, kind, off, width, hinge, side))
            counts["openings"] += 1
        room_ids[lid] = []
        for i, (rx, ry) in enumerate(rooms):
            name, ceiling = ROOMS[i % len(ROOMS)]
            n = i // len(ROOMS)
            db.execute("INSERT INTO rooms (level_id, name, ceiling_cm, x, y, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
                       (lid, name if n == 0 else f"{name} {n + 1}", ceiling, rx, ry, i))
            room_ids[lid].append((db.execute("SELECT last_insert_rowid()").fetchone()[0], rx, ry))
            counts["rooms"] += 1
        if calibrated:
            x0, y0, x1, y1 = bbox
            for _ in range(8):
                ax, ay = rng.uniform(x0, x1), rng.uniform(y0, y1)
                bx, by = (rng.uniform(x0, x1), ay) if rng.random() < 0.5 else (ax, rng.uniform(y0, y1))
                db.execute("INSERT INTO rulers (level_id, x1, y1, x2, y2) VALUES (?, ?, ?, ?, ?)", (lid, ax, ay, bx, by))
                counts["rulers"] += 1

    # pins, spread over the floors (more on the drawn ones)
    share = [0.36, 0.33, 0.2, 0.11]
    start = datetime(2026, 3, 1, 8, 0)
    pins = []
    for (lid, walls, rooms, bbox, k, _), part in zip(floors, share):
        x0, y0, x1, y1 = bbox
        for _ in range(round(args.pins * part)):
            cat = rng.choices(CATEGORIES, CAT_WEIGHTS)[0]
            if walls and rng.random() < 0.8:          # most things are in or on a wall
                x1w, y1w, x2w, y2w = walls[rng.randrange(len(walls))][:4]
                u = rng.random()
                x, y = x1w + (x2w - x1w) * u, y1w + (y2w - y1w) * u
            else:
                x, y = rng.uniform(x0, x1), rng.uniform(y0, y1)
            room = min(room_ids[lid], key=lambda r: (r[1] - x) ** 2 + (r[2] - y) ** 2)[0]
            when = start + timedelta(hours=rng.randint(0, 24 * 200))
            label = rng.choice(LABELS[cat]) + ("" if rng.random() < 0.6 else f" {rng.randint(2, 9)}")
            notes = " ".join(rng.sample(NOTES, rng.randint(0, 3)))
            db.execute("INSERT INTO pins (level_id, x, y, label, notes, category, room_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       (lid, round(x, 1), round(y, 1), label, notes, cat, room, when.strftime("%Y-%m-%dT%H:%M:%S.000Z")))
            pid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            pins.append((pid, cat, label))
            order = 0
            for kind, chance, lo, hi in (("height", 0.75, 10, 260), ("depth", 0.4, 2, 12)):
                if rng.random() < chance:
                    db.execute("INSERT INTO measurements (pin_id, kind, reference, value_cm, sort_order) VALUES (?, ?, '', ?, ?)",
                               (pid, kind, round(rng.uniform(lo, hi), 1), order))
                    order += 1
            for _ in range(rng.choices([0, 1, 2, 3], [4, 3, 2, 1])[0]):
                db.execute("INSERT INTO measurements (pin_id, kind, reference, value_cm, sort_order) VALUES (?, 'distance', ?, ?, ?)",
                           (pid, rng.choice(REFS), round(rng.uniform(5, 400), 1), order))
                order += 1

    # photos: uneven, like real life (a few pins with many, most with a handful, some none)
    weights = [rng.choice([0, 1, 1, 2, 3, 3, 4, 6, 12]) for _ in pins]
    total_w = sum(weights) or 1
    plan = [max(0, round(w * args.photos / total_w)) for w in weights]
    diff = args.photos - sum(plan)
    for i in range(abs(diff)):
        j = i % len(plan)
        plan[j] = max(0, plan[j] + (1 if diff > 0 else -1))
    n_photos = 0
    for (pid, cat, label), n in zip(pins, plan):
        if not n:
            continue
        folder = work / "photos" / str(pid)
        (folder / "thumbs").mkdir(parents=True)
        for i in range(n):
            name = f"2026-05-{(i % 28) + 1:02d}-1200{i:02d}-site-photo-{i + 1}.jpg"
            photo(folder / name, folder / "thumbs" / name, f"Pin {pid} · photo {i + 1}", cat)
            caption = rng.choice(["", "", f"{label}, close-up", "Before closing the wall", "With tape measure"])
            db.execute("INSERT INTO photos (pin_id, file_path, thumb_path, caption) VALUES (?, ?, ?, ?)",
                       (pid, f"photos/{pid}/{name}", f"photos/{pid}/thumbs/{name}", caption))
            n_photos += 1
            if n_photos % 100 == 0:
                print(f"  {n_photos} photos…", flush=True)

    db.commit()
    db.close()
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S.000Z")
    (work / "project.json").write_text(json.dumps({
        "name": "Stress test", "schemaVersion": schema_version, "colourScheme": "it",
        "createdAt": now, "modifiedAt": now}, indent=2))

    zip_path = args.out / "stress-test.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as z:     # JPEGs do not compress
        for f in sorted(work.rglob("*")):
            z.write(f, f.relative_to(work).as_posix())
    shutil.rmtree(work)
    print(f"{zip_path}  ({zip_path.stat().st_size / 1e6:.0f} MB): {len(floors)} floors, {len(pins)} pins, "
          f"{n_photos} photos, {counts['walls']} walls, {counts['openings']} doors and windows, "
          f"{counts['rooms']} rooms, {counts['rulers']} kept measurements")


if __name__ == "__main__":
    main()
