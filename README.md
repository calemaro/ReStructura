# ReStructura

A local-only desktop app for documenting **what is inside your walls and floors** during a
renovation — pipes, cables, conduit, junction boxes — before they get covered up again.

Load a floor plan, click the exact spot where something runs, and attach photos, notes and
measurements to that point. When the wall is closed and you need to drill two years later,
the record is still there.

> **Status: MVP complete (v0.2.0).** Projects with multiple levels, plan import, zip export/import,
> pins with notes, category, measurements and photos, undo/redo, copy/paste, right-click menus,
> English and Italian. Next: release packaging for Linux, macOS and Windows, then rooms, scale
> calibration and search.

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
| Frontend | Plain HTML / CSS / JS, served by Vite in development | No framework until the core interaction is proven. Vite gives instant reload while developing and produces the static files embedded in the release binary. |
| Plan view | **Leaflet** with `L.CRS.Simple` | Treats a plain image as the map — pixel coordinates instead of latitude/longitude. Zoom, pan and clickable markers come for free. |
| Database | **SQLite** via `rusqlite` (`bundled`) | One file, no server. `bundled` compiles SQLite into the binary, so the app carries its own engine. |
| Photos | Files on disk, paths in the DB | Blobs in SQLite would bloat the database and make backup harder. |
| Networking | None | Deliberate. |

### Data model

```
levels   (id, name, image_path, sort_order)
pins     (id, level_id, x, y, label, notes, created_at)
photos   (id, pin_id, file_path, caption, created_at)
settings (key, value)
```

A *level* is any plan of the same home — a floor, a mezzanine, a basement.
`pins.x` / `pins.y` are **pixel coordinates on the plan image, origin top-left, y downwards**,
which is what an image editor reports and what `L.CRS.Simple` maps onto directly.

### Projects

Each home is a **project**: one self-contained folder under the app's data directory.

```
projects/<slug>/
├── project.json   manifest — name, schemaVersion, colour scheme, timestamps
├── plan.db        this project's SQLite database
├── plans/         plan images, one per level
└── photos/        photos, one folder per pin
```

Every path stored in the database is relative to the project folder, so a project can be
**exported as a plain `.zip`** and imported on another computer unchanged. Deleting a
project moves its folder to the system trash.

| OS | Data directory |
| --- | --- |
| Linux | `~/.local/share/com.restructura.app/projects/` |
| macOS | `~/Library/Application Support/com.restructura.app/projects/` |
| Windows | `%APPDATA%\com.restructura.app\projects\` |

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
npm install     # first time only — also copies Leaflet into src/public/vendor
npm run dev     # development: Vite serves the frontend, Tauri opens the window, both reload on save
npm run build   # release: bundles the frontend into dist/ and builds native installers
```

Release packages land in `src-tauri/target/release/bundle/` — `.rpm`, `.deb` and `.AppImage`
on Linux. The build script sets `NO_STRIP=true`: the `strip` binary shipped inside
`linuxdeploy` predates the `.relr.dyn` section that Fedora's toolchain emits and aborts the
AppImage bundle otherwise.

To install the Fedora package after building:

```bash
sudo dnf install ./src-tauri/target/release/bundle/rpm/ReStructura-0.2.0-1.x86_64.rpm
```

Project layout:

```
src/main.js             the plan screen: Leaflet map, pins, panel, add-pin mode
src/projects.js         the main menu: list, create, import, export, delete projects
src/history.js          undo/redo command stack
src/api.js              every call into Rust, in one place
src/i18n.js, ui.js      translations; small shared helpers
src/public/             static files served as-is: locales/, assets/, vendor/ (Leaflet)
src-tauri/src/lib.rs    Tauri commands (the JavaScript ↔ Rust bridge) and app state
src-tauri/src/projects.rs  project folders, manifest, zip export/import, plan import
src-tauri/src/db.rs     SQLite schema and queries
scripts/              vendor.mjs (copies Leaflet), make_demo_plan.py (draws the sample plan)
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
- Every user-visible string comes from `src/public/locales/<lang>.json` — nothing is hardcoded.
  Adding a language is one file plus one entry in `SUPPORTED` in `src/i18n.js`.
- Pins store a semantic **category** (gas, cold water, hot water/heating, electric power,
  data/TV, alarm, intercom, multimedia, drain, other). Marker colours come from a selectable
  **colour scheme** in Settings, so anyone in the trades reads the plan without a legend:

  | Category | Italian / European (default) | APWA (US) |
  | --- | --- | --- |
  | Gas | Yellow (mandatory, UNI 5634) | Yellow |
  | Electric power | Black / grey (CEI 64-100/2) | Red |
  | Data, telephone, TV | Green | Orange |
  | Alarm / security | Brown | Orange |
  | Intercom | Light blue | Orange |
  | Multimedia / home automation | Violet | Orange |
  | Cold water | Blue | Blue |
  | Hot water / heating | Red | — |
  | Drain / sewer | — | Green |

  The two conventions disagree (green is *data* in Italy and *sewer* under APWA), which is
  why the category, never the colour, is what gets stored.

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

**Skeleton (done)** — plan loads with zoom/pan, pins are added and deleted from the UI and
persist in SQLite, interface in English and Italian.

**MVP (done, v0.2.0)** — projects, levels, plan import, zip export/import, pin editor with notes,
categories with selectable colour scheme, measurements, photos with gallery, undo/redo,
selection and copy/paste, edit mode, right-click menus.

**Later** — importing architects' drawings (PDF raster, SVG layers, DXF/DWG), scale
calibration so distances read in centimetres, backup/restore bundles, search, printable
per-room reports, Windows and macOS builds.

---

## License

Not yet chosen — private personal project.
