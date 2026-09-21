# PlanFloorViewer

A local-only desktop app for documenting **what is inside your walls and floors** during a
renovation — pipes, cables, conduit, junction boxes — before they get covered up again.

Load a floor plan, click the exact spot where something runs, and attach photos, notes and
measurements to that point. When the wall is closed and you need to drill two years later,
the record is still there.

> **Status: setup phase.** The environment has been audited and the architecture chosen.
> No application code exists yet. Progress is tracked on the build sheet (see below).

---

## Why this exists

During a renovation everything interesting is visible for a few days and then permanently
hidden. Photographs alone lose their context — a picture of an open wall is useless if you
cannot tell *which* wall, or how far the pipe sat from the corner. Pinning each photo to an
exact point on the floor plan, with measurements relative to real reference points, keeps
that context.

Fully offline by design. No account, no cloud, no network calls. The data is a SQLite file
and a folder of photos on your own disk.

---

## Architecture

| Layer | Choice | Why |
| --- | --- | --- |
| App shell | **Tauri v2** (Rust) | Native window, small binaries, builds for Linux/macOS/Windows. Not Electron. |
| Frontend | Plain HTML / CSS / JS | No framework until the core interaction is proven. |
| Plan view | **Leaflet** with `L.CRS.Simple` | Treats a plain image as the map — pixel coordinates instead of latitude/longitude. Zoom, pan and clickable markers come for free. |
| Database | **SQLite** via `rusqlite` (`bundled`) | One file, no server. `bundled` compiles SQLite into the binary, so the app carries its own engine. |
| Photos | Files on disk, paths in the DB | Blobs in SQLite would bloat the database and make backup harder. |
| Networking | None | Deliberate. |

### Data model

```
floors (id, name, image_path, sort_order)
pins   (id, floor_id, x, y, label, notes, created_at)
photos (id, pin_id, file_path, caption, created_at)
```

`pins.x` / `pins.y` are **pixel coordinates on the floor plan image**, which is what
Leaflet's `L.CRS.Simple` works in natively.

### Where your data lives

| OS | Path |
| --- | --- |
| Linux | `~/.local/share/com.planfloorviewer.app/` |
| macOS | `~/Library/Application Support/com.planfloorviewer.app/` |
| Windows | `%APPDATA%\com.planfloorviewer.app\` |

Resolved through Tauri's path API — never hardcoded.

---

## Development

### Prerequisites (Fedora)

All prerequisite commands below are location-independent — run them from any directory.

```bash
# Rust toolchain. rustup-init comes from Fedora's signed repository rather than
# a piped install script; it then installs the toolchain into your home directory.
sudo dnf install rustup
rustup-init                    # choose option 1, standard installation
source "$HOME/.cargo/env"

# System headers Tauri compiles against
sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel \
  openssl-devel librsvg2-devel libappindicator-gtk3-devel file wget
```

On non-Fedora systems, get `rustup` from <https://www.rust-lang.org/tools/install>.

Node 20+ and a C/C++ toolchain (`gcc`, `make`, `pkg-config`) are also required.

`sqlite-devel` is deliberately **not** needed — `rusqlite`'s `bundled` feature compiles
SQLite from source into the binary.

### Running

All commands below run **from the repository root**.

```bash
npm install          # first time only
npm run tauri dev    # dev build with hot reload
npm run tauri build  # production bundle
```

The first `tauri dev` compiles several hundred Rust crates and takes roughly 3–10 minutes.
Every build after that is seconds.

**GNOME / Wayland note:** if the window renders black or flickers, prefix with
`WEBKIT_DISABLE_DMABUF_RENDERER=1`.

---

## Conventions

- `main` always builds. Feature work happens on `feat/…`, `fix/…`, `chore/…` branches.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`,
  `docs:`, `refactor:`.
- Pin categories follow the **APWA uniform utility colour code**, so anyone in the trades
  reads the plan without a legend:

  | Colour | Meaning |
  | --- | --- |
  | Red | Electric power, cables, conduit |
  | Yellow | Gas, oil, steam, petroleum |
  | Orange | Communications, alarm, signal |
  | Blue | Potable water |
  | Purple | Reclaimed water, irrigation |
  | Green | Sewer and drain lines |
  | Pink | Temporary survey markings |
  | White | Proposed excavation |

---

## Verified development environment

Confirmed working on the primary development machine:

| Component | Version |
| --- | --- |
| Fedora | 44 (kernel 7.2.4), GNOME / Wayland |
| Node / npm | 24.18.0 / 11.16.0 |
| Rust / Cargo | 1.98.1 (via `rustup` 1.29.0) |
| GCC / Make | 16.2.1 / 4.4.1 |
| WebKitGTK | 2.52.5 (`webkit2gtk-4.1`) |
| libsoup | 3.6.6 |

---

## Roadmap

**Skeleton (in progress)** — image loads, zoom/pan works, one clickable pin, one verified
round-trip from JavaScript to Rust to SQLite and back.

**MVP** — click to drop pins, pin editor with notes and measurements, photo attachment and
gallery, utility categories, multiple floors, edit/delete.

**Later** — importing architects' drawings (PDF raster, SVG layers, DXF/DWG), scale
calibration so distances read in centimetres, backup/restore bundles, search, printable
per-room reports, Windows and macOS builds.

---

## License

Not yet chosen — private personal project.
