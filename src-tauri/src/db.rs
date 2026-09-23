//! SQLite storage.
//!
//! One connection, opened once at startup, shared behind a Mutex. SQLite is
//! compiled into the binary (rusqlite's `bundled` feature), so the app carries
//! its own database engine and needs nothing installed on the machine.
//!
//! Coordinates are IMAGE PIXELS with the origin at the top-left of the plan
//! image, y downwards — the convention the frontend also uses.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A level of the home: the main floor, a mezzanine (soppalco), a basement…
/// `#[derive(Serialize)]` is what lets Tauri turn this struct into JSON for
/// the frontend. `rename_all = "camelCase"` makes `image_path` arrive in
/// JavaScript as `imagePath`, matching JS naming habits.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub id: i64,
    pub name: String,
    /// Relative to the project folder, e.g. "plans/kitchen.png". This is what is stored.
    pub image_path: String,
    pub sort_order: i64,
    /// Centimetres per image pixel, once the user has calibrated this level
    /// against a real measured distance. None = not calibrated; every feature
    /// that needs real-world lengths stays hidden until it is set.
    #[serde(default)]
    pub cm_per_px: Option<f64>,
    /// Absolute path on this machine, filled in when the level is handed to the frontend.
    /// Never stored: it would break the moment the project moves to another computer.
    #[serde(default)]
    pub image_file: String,
    /// Size of the drawing sheet for a floor drawn in the editor, which has no
    /// image to take a size from. None for floors made from an imported image.
    #[serde(default)]
    pub width_px: Option<f64>,
    #[serde(default)]
    pub height_px: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub id: i64,
    pub level_id: i64,
    pub x: f64,
    pub y: f64,
    pub label: String,
    pub notes: String,
    /// Semantic category id ("gas", "cold_water", …). The colour is NOT stored:
    /// the project's colour scheme maps category -> colour at display time.
    #[serde(default = "default_category")]
    pub category: String,
    /// Which room the user tagged this pin with, if any.
    #[serde(default)]
    pub room_id: Option<i64>,
    pub created_at: String,
}
fn default_category() -> String {
    "other".into()
}

/// A distance the user measured on the plan and kept: the two endpoints, in
/// image pixels. The length is derived from the level's calibration at display
/// time, so recalibrating updates every ruler at once.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ruler {
    #[serde(default)]
    pub id: i64,
    pub level_id: i64,
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// A room label the user places on the plan: a name, an optional ceiling
/// height, and the point the label sits at. It is annotation only — the plan
/// image is never touched and nothing is read out of it.
///
/// Deliberately NOT an outline: tracing every room on a drawing that already
/// shows them is work for no gain. A pin records which room it is in through
/// its own `room_id`, chosen in the pin panel.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    #[serde(default)]
    pub id: i64,
    pub level_id: i64,
    pub name: String,
    /// Ceiling height in centimetres, or None when not recorded.
    #[serde(default)]
    pub ceiling_cm: Option<f64>,
    /// Where the label sits, in image pixels (origin top-left, y down).
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub sort_order: i64,
}

/// A photo attached to a pin. Both paths are relative to the project folder
/// ("photos/12/2026-09-22-143012-wall.jpg"); `file`/`thumb` are filled in with
/// absolute paths for this machine when handed to the frontend, never stored.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub id: i64,
    pub pin_id: i64,
    pub file_path: String,
    pub thumb_path: String,
    pub caption: String,
    pub created_at: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub thumb: String,
}

/// One measured distance on a pin, always in centimetres.
/// `kind`: "height" (above finished floor), "depth" (from the finished wall
/// surface) or "distance" (horizontal, from the named `reference`).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub pin_id: i64,
    pub kind: String,
    #[serde(default)]
    pub reference: String,
    pub value_cm: f64,
    #[serde(default)]
    pub sort_order: i64,
}

/// Open (or create) the database file and make sure the schema exists.
///
/// `rusqlite::Result<Connection>` is Rust's way of saying "either a Connection,
/// or an error". The `?` operator after each call means: if this failed, stop
/// here and hand the error to whoever called us. No exceptions, no try/catch —
/// errors are ordinary values that the type system forces you to deal with.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // About to be upgraded to a newer layout: keep a copy of it as it was first, so
    // a failed upgrade can never cost the user their project.
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v > 0 && v < DB_VERSION {
        backup_before_upgrade(&conn, path, v)?;
    }
    init(&conn)?;
    Ok(conn)
}

/// `plan.db` → `plan.db.v8.bak` (the version it had), a complete and consistent copy
/// made by SQLite itself, even with unflushed changes in the WAL file.
fn backup_before_upgrade(conn: &Connection, path: &Path, from: i64) -> rusqlite::Result<()> {
    let bak = path.with_file_name(format!(
        "{}.v{from}.bak",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("plan.db")
    ));
    if bak.exists() {
        let _ = std::fs::remove_file(&bak); // VACUUM INTO refuses to overwrite
    }
    conn.execute("VACUUM INTO ?1", [bak.to_string_lossy()])?;
    Ok(())
}

/// Create any missing tables and bring an older layout up to date.
fn init(conn: &Connection) -> rusqlite::Result<()> {
    // Sensible SQLite defaults for a desktop app: crash-safe journaling,
    // and enforce the REFERENCES clauses below (SQLite ignores them otherwise).
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;",
    )?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS levels (
            id          INTEGER PRIMARY KEY,
            name        TEXT    NOT NULL,
            image_path  TEXT    NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            cm_per_px   REAL,
            width_px    REAL,
            height_px   REAL
         );
         CREATE TABLE IF NOT EXISTS pins (
            id          INTEGER PRIMARY KEY,
            level_id    INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
            x           REAL    NOT NULL,
            y           REAL    NOT NULL,
            label       TEXT    NOT NULL DEFAULT '',
            notes       TEXT    NOT NULL DEFAULT '',
            category    TEXT    NOT NULL DEFAULT 'other',
            room_id     INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         );
         CREATE TABLE IF NOT EXISTS photos (
            id          INTEGER PRIMARY KEY,
            pin_id      INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
            file_path   TEXT    NOT NULL,
            thumb_path  TEXT    NOT NULL DEFAULT '',
            caption     TEXT    NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         );
         CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS rooms (
            id          INTEGER PRIMARY KEY,
            level_id    INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
            name        TEXT    NOT NULL DEFAULT '',
            ceiling_cm  REAL,
            x           REAL    NOT NULL,
            y           REAL    NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS rulers (
            id          INTEGER PRIMARY KEY,
            level_id    INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
            x1          REAL    NOT NULL,
            y1          REAL    NOT NULL,
            x2          REAL    NOT NULL,
            y2          REAL    NOT NULL
         );
         CREATE TABLE IF NOT EXISTS measurements (
            id          INTEGER PRIMARY KEY,
            pin_id      INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
            kind        TEXT    NOT NULL,
            reference   TEXT    NOT NULL DEFAULT '',
            value_cm    REAL    NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS pins_by_level ON pins(level_id);
         CREATE INDEX IF NOT EXISTS measurements_by_pin ON measurements(pin_id);
         CREATE INDEX IF NOT EXISTS rooms_by_level ON rooms(level_id);
         CREATE TABLE IF NOT EXISTS walls (
            id           INTEGER PRIMARY KEY,
            level_id     INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
            x1           REAL    NOT NULL,
            y1           REAL    NOT NULL,
            x2           REAL    NOT NULL,
            y2           REAL    NOT NULL,
            thickness_cm REAL    NOT NULL
         );
         CREATE TABLE IF NOT EXISTS openings (
            id          INTEGER PRIMARY KEY,
            level_id    INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
            wall_id     INTEGER NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
            kind        TEXT    NOT NULL,
            offset_px   REAL    NOT NULL,
            width_px    REAL    NOT NULL,
            hinge       INTEGER NOT NULL DEFAULT 0,
            side        INTEGER NOT NULL DEFAULT 1
         );
         CREATE INDEX IF NOT EXISTS rulers_by_level ON rulers(level_id);
         CREATE INDEX IF NOT EXISTS walls_by_level ON walls(level_id);
         CREATE INDEX IF NOT EXISTS openings_by_level ON openings(level_id);",
    )?;

    migrate(conn)?;
    Ok(())
}

/// Bring an older database up to the current layout.
///
/// SQLite keeps a small integer in the file header (`PRAGMA user_version`)
/// that we use as the schema version. Each step below upgrades one version
/// and is applied in order, so a database from any earlier release ends up
/// current. `CREATE TABLE IF NOT EXISTS` above already handles brand-new
/// files, which is why a fresh database starts at the latest version.
const DB_VERSION: i64 = 10;

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v == 0 {
        // Version 0 means "created before versioning began" or "just created".
        // Tell the two apart by whether the category column already exists.
        let has_category: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('pins') WHERE name = 'category'")?
            .exists([])?;
        // A brand-new file has every column (created above) and is at the latest
        // version; an old file predates the category column and starts at 1.
        v = if has_category { DB_VERSION } else { 1 };
    }
    if v < 2 {
        conn.execute_batch("ALTER TABLE pins ADD COLUMN category TEXT NOT NULL DEFAULT 'other';")?;
        v = 2;
    }
    if v < 3 {
        // measurements table: created by the CREATE TABLE IF NOT EXISTS block above.
        v = 3;
    }
    if v < 4 {
        let has_thumb: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('photos') WHERE name = 'thumb_path'")?
            .exists([])?;
        if !has_thumb {
            conn.execute_batch(
                "ALTER TABLE photos ADD COLUMN thumb_path TEXT NOT NULL DEFAULT '';",
            )?;
        }
        v = 4;
    }
    if v < 5 {
        // rooms table: created by the CREATE TABLE IF NOT EXISTS block above.
        v = 5;
    }
    if v < 6 {
        // Rooms began as traced outlines and became labels at a point: tracing a
        // drawing that already shows the rooms was effort for no gain. The outline
        // version never shipped, so the table is simply rebuilt.
        let had_points: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('rooms') WHERE name = 'points'")?
            .exists([])?;
        if had_points {
            conn.execute_batch(
                "DROP TABLE rooms;
                 CREATE TABLE rooms (
                    id          INTEGER PRIMARY KEY,
                    level_id    INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
                    name        TEXT    NOT NULL DEFAULT '',
                    ceiling_cm  REAL,
                    x           REAL    NOT NULL,
                    y           REAL    NOT NULL,
                    sort_order  INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX IF NOT EXISTS rooms_by_level ON rooms(level_id);
         CREATE INDEX IF NOT EXISTS rulers_by_level ON rulers(level_id);",
            )?;
        }
        let has_room_id: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('pins') WHERE name = 'room_id'")?
            .exists([])?;
        if !has_room_id {
            conn.execute_batch(
                "ALTER TABLE pins ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;",
            )?;
        }
        v = 6;
    }
    if v < 7 {
        let has: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('levels') WHERE name = 'cm_per_px'")?
            .exists([])?;
        if !has {
            conn.execute_batch("ALTER TABLE levels ADD COLUMN cm_per_px REAL;")?;
        }
        v = 7;
    }
    if v < 8 {
        // rulers table: created by the CREATE TABLE IF NOT EXISTS block above.
        v = 8;
    }
    if v < 9 {
        // walls table: created above. Drawn floors need a sheet size.
        let has: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('levels') WHERE name = 'width_px'")?
            .exists([])?;
        if !has {
            conn.execute_batch(
                "ALTER TABLE levels ADD COLUMN width_px REAL;
                 ALTER TABLE levels ADD COLUMN height_px REAL;",
            )?;
        }
        v = 9;
    }
    if v < 10 {
        // openings table: created by the CREATE TABLE IF NOT EXISTS block above.
        v = 10;
    }
    conn.pragma_update(None, "user_version", v)?;
    Ok(())
}

/// Used by the demo project only: one level with the sample plan and one example pin.
pub fn seed_demo(conn: &Connection, image_path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO levels (name, image_path, sort_order) VALUES (?1, ?2, 0)",
        params!["Demo plan", image_path],
    )?;
    let level_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO pins (level_id, x, y, label, notes, category) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            level_id,
            1010.0,
            300.0,
            "Cold water riser",
            "Copper 22 mm, runs vertically inside the kitchen wall. \
             Centre is 38 cm from the door frame, joint at 112 cm above finished floor.",
            "cold_water"
        ],
    )?;
    Ok(())
}

pub fn list_levels(conn: &Connection) -> rusqlite::Result<Vec<Level>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, image_path, sort_order, cm_per_px, width_px, height_px FROM levels ORDER BY sort_order, id",
    )?;
    // query_map runs the statement and turns each row into a Level via the closure.
    // collect() gathers them into a Vec, stopping at the first error if any.
    let rows = stmt.query_map([], row_to_level)?;
    rows.collect()
}

pub fn get_level(conn: &Connection, id: i64) -> rusqlite::Result<Option<Level>> {
    conn.query_row(
        "SELECT id, name, image_path, sort_order, cm_per_px, width_px, height_px FROM levels WHERE id = ?1",
        [id],
        row_to_level,
    )
    .optional()
}

fn row_to_level(r: &rusqlite::Row<'_>) -> rusqlite::Result<Level> {
    Ok(Level {
        id: r.get(0)?,
        name: r.get(1)?,
        image_path: r.get(2)?,
        sort_order: r.get(3)?,
        cm_per_px: r.get(4)?,
        image_file: String::new(),
        width_px: r.get(5)?,
        height_px: r.get(6)?,
    })
}

pub fn list_pins(conn: &Connection, level_id: i64) -> rusqlite::Result<Vec<Pin>> {
    let mut stmt = conn.prepare(
        "SELECT id, level_id, x, y, label, notes, category, room_id, created_at FROM pins WHERE level_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([level_id], row_to_pin)?;
    rows.collect()
}

pub fn get_pin(conn: &Connection, id: i64) -> rusqlite::Result<Option<Pin>> {
    conn.query_row(
        "SELECT id, level_id, x, y, label, notes, category, room_id, created_at FROM pins WHERE id = ?1",
        [id],
        row_to_pin,
    )
    .optional() // a missing row is `None`, not an error
}

pub fn add_pin(
    conn: &Connection,
    level_id: i64,
    x: f64,
    y: f64,
    label: &str,
    notes: &str,
    category: &str,
) -> rusqlite::Result<Pin> {
    conn.execute(
        "INSERT INTO pins (level_id, x, y, label, notes, category) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![level_id, x, y, label, notes, category],
    )?;
    let id = conn.last_insert_rowid();
    // Read it back so the caller gets the server-side created_at, not a guess.
    Ok(get_pin(conn, id)?.expect("pin just inserted must exist"))
}

/// Change what a pin says. Position is deliberately not editable here — moving
/// a pin is a separate gesture (drag) with its own command later.
pub fn update_pin(
    conn: &Connection,
    id: i64,
    label: &str,
    notes: &str,
    category: &str,
    room_id: Option<i64>,
) -> rusqlite::Result<Option<Pin>> {
    conn.execute(
        "UPDATE pins SET label = ?1, notes = ?2, category = ?3, room_id = ?4 WHERE id = ?5",
        params![label, notes, category, room_id, id],
    )?;
    get_pin(conn, id)
}

/// Move a pin to new plan-pixel coordinates (edit mode drag).
pub fn move_pin(conn: &Connection, id: i64, x: f64, y: f64) -> rusqlite::Result<Option<Pin>> {
    conn.execute(
        "UPDATE pins SET x = ?1, y = ?2 WHERE id = ?3",
        params![x, y, id],
    )?;
    get_pin(conn, id)
}

/// Re-insert a pin exactly as it was, keeping its original id and timestamp.
/// Used by undo: a restored pin must keep its identity so anything that
/// referenced it (photos, later) lines up again.
pub fn restore_pin(conn: &Connection, pin: &Pin) -> rusqlite::Result<Pin> {
    conn.execute(
        "INSERT OR REPLACE INTO pins (id, level_id, x, y, label, notes, category, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            pin.id,
            pin.level_id,
            pin.x,
            pin.y,
            pin.label,
            pin.notes,
            pin.category,
            pin.created_at
        ],
    )?;
    Ok(get_pin(conn, pin.id)?.expect("pin just restored must exist"))
}

pub fn delete_pin(conn: &Connection, id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM pins WHERE id = ?1", [id])
}

fn row_to_pin(r: &rusqlite::Row<'_>) -> rusqlite::Result<Pin> {
    Ok(Pin {
        id: r.get(0)?,
        level_id: r.get(1)?,
        x: r.get(2)?,
        y: r.get(3)?,
        label: r.get(4)?,
        notes: r.get(5)?,
        category: r.get(6)?,
        room_id: r.get(7)?,
        created_at: r.get(8)?,
    })
}

// ---------------------------------------------------------------------------
// measurements
// ---------------------------------------------------------------------------

pub fn list_measurements(conn: &Connection, pin_id: i64) -> rusqlite::Result<Vec<Measurement>> {
    let mut stmt = conn.prepare(
        "SELECT id, pin_id, kind, reference, value_cm, sort_order FROM measurements WHERE pin_id = ?1 ORDER BY sort_order, id",
    )?;
    let rows = stmt.query_map([pin_id], |r| {
        Ok(Measurement {
            id: r.get(0)?,
            pin_id: r.get(1)?,
            kind: r.get(2)?,
            reference: r.get(3)?,
            value_cm: r.get(4)?,
            sort_order: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// Replace a pin's measurements with `list`, in one transaction. Treating the
/// list as a single value keeps undo and copy/paste trivial: "before" and
/// "after" are just two lists.
pub fn set_measurements(
    conn: &Connection,
    pin_id: i64,
    list: &[Measurement],
) -> rusqlite::Result<Vec<Measurement>> {
    conn.execute_batch("BEGIN;")?;
    let result = (|| {
        conn.execute("DELETE FROM measurements WHERE pin_id = ?1", [pin_id])?;
        for (i, m) in list.iter().enumerate() {
            conn.execute(
                "INSERT INTO measurements (pin_id, kind, reference, value_cm, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![pin_id, m.kind, m.reference.trim(), m.value_cm, i as i64],
            )?;
        }
        list_measurements(conn, pin_id)
    })();
    match result {
        Ok(v) => {
            conn.execute_batch("COMMIT;")?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// photos
// ---------------------------------------------------------------------------

const PHOTO_COLS: &str = "id, pin_id, file_path, thumb_path, caption, created_at";

fn row_to_photo(r: &rusqlite::Row<'_>) -> rusqlite::Result<Photo> {
    Ok(Photo {
        id: r.get(0)?,
        pin_id: r.get(1)?,
        file_path: r.get(2)?,
        thumb_path: r.get(3)?,
        caption: r.get(4)?,
        created_at: r.get(5)?,
        file: String::new(),
        thumb: String::new(),
    })
}

pub fn list_photos(conn: &Connection, pin_id: i64) -> rusqlite::Result<Vec<Photo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PHOTO_COLS} FROM photos WHERE pin_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([pin_id], row_to_photo)?;
    rows.collect()
}

pub fn get_photo(conn: &Connection, id: i64) -> rusqlite::Result<Option<Photo>> {
    conn.query_row(
        &format!("SELECT {PHOTO_COLS} FROM photos WHERE id = ?1"),
        [id],
        row_to_photo,
    )
    .optional()
}

pub fn insert_photo(
    conn: &Connection,
    pin_id: i64,
    file_path: &str,
    thumb_path: &str,
) -> rusqlite::Result<Photo> {
    conn.execute(
        "INSERT INTO photos (pin_id, file_path, thumb_path) VALUES (?1, ?2, ?3)",
        params![pin_id, file_path, thumb_path],
    )?;
    Ok(get_photo(conn, conn.last_insert_rowid())?.expect("photo just inserted"))
}

/// Re-insert a removed photo row with its original id (undo).
pub fn restore_photo(conn: &Connection, p: &Photo) -> rusqlite::Result<Photo> {
    conn.execute(
        "INSERT OR REPLACE INTO photos (id, pin_id, file_path, thumb_path, caption, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![p.id, p.pin_id, p.file_path, p.thumb_path, p.caption, p.created_at],
    )?;
    Ok(get_photo(conn, p.id)?.expect("photo just restored"))
}

pub fn set_caption(conn: &Connection, id: i64, caption: &str) -> rusqlite::Result<Option<Photo>> {
    conn.execute(
        "UPDATE photos SET caption = ?1 WHERE id = ?2",
        params![caption, id],
    )?;
    get_photo(conn, id)
}

pub fn delete_photo_row(conn: &Connection, id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM photos WHERE id = ?1", [id])
}

// ---------------------------------------------------------------------------
// rooms
// ---------------------------------------------------------------------------

const ROOM_COLS: &str = "id, level_id, name, ceiling_cm, x, y, sort_order";

fn row_to_room(r: &rusqlite::Row<'_>) -> rusqlite::Result<Room> {
    Ok(Room {
        id: r.get(0)?,
        level_id: r.get(1)?,
        name: r.get(2)?,
        ceiling_cm: r.get(3)?,
        x: r.get(4)?,
        y: r.get(5)?,
        sort_order: r.get(6)?,
    })
}

pub fn list_rooms(conn: &Connection, level_id: i64) -> rusqlite::Result<Vec<Room>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ROOM_COLS} FROM rooms WHERE level_id = ?1 ORDER BY sort_order, id"
    ))?;
    let rows = stmt.query_map([level_id], row_to_room)?;
    rows.collect()
}

pub fn get_room(conn: &Connection, id: i64) -> rusqlite::Result<Option<Room>> {
    conn.query_row(
        &format!("SELECT {ROOM_COLS} FROM rooms WHERE id = ?1"),
        [id],
        row_to_room,
    )
    .optional()
}

pub fn add_room(
    conn: &Connection,
    level_id: i64,
    name: &str,
    ceiling_cm: Option<f64>,
    x: f64,
    y: f64,
) -> rusqlite::Result<Room> {
    let order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM rooms WHERE level_id = ?1",
        [level_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO rooms (level_id, name, ceiling_cm, x, y, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![level_id, name.trim(), ceiling_cm, x, y, order],
    )?;
    Ok(get_room(conn, conn.last_insert_rowid())?.expect("room just inserted"))
}

pub fn update_room(
    conn: &Connection,
    id: i64,
    name: &str,
    ceiling_cm: Option<f64>,
    x: f64,
    y: f64,
) -> rusqlite::Result<Option<Room>> {
    conn.execute(
        "UPDATE rooms SET name = ?1, ceiling_cm = ?2, x = ?3, y = ?4 WHERE id = ?5",
        params![name.trim(), ceiling_cm, x, y, id],
    )?;
    get_room(conn, id)
}

/// Re-insert a deleted room with its original id (undo).
pub fn restore_room(conn: &Connection, r: &Room) -> rusqlite::Result<Room> {
    conn.execute(
        "INSERT OR REPLACE INTO rooms (id, level_id, name, ceiling_cm, x, y, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            r.id,
            r.level_id,
            r.name,
            r.ceiling_cm,
            r.x,
            r.y,
            r.sort_order
        ],
    )?;
    Ok(get_room(conn, r.id)?.expect("room just restored"))
}

pub fn delete_room(conn: &Connection, id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM rooms WHERE id = ?1", [id])
}

/// Rename a floor. The image file keeps the name it was imported under: the
/// floor's name is a label, not an identity.
pub fn rename_level(conn: &Connection, id: i64, name: &str) -> rusqlite::Result<Option<Level>> {
    conn.execute(
        "UPDATE levels SET name = ?1 WHERE id = ?2",
        params![name.trim(), id],
    )?;
    get_level(conn, id)
}

/// Record (or clear, with None) how many centimetres one image pixel represents.
pub fn set_level_scale(
    conn: &Connection,
    level_id: i64,
    cm_per_px: Option<f64>,
) -> rusqlite::Result<Option<Level>> {
    conn.execute(
        "UPDATE levels SET cm_per_px = ?1 WHERE id = ?2",
        params![cm_per_px, level_id],
    )?;
    get_level(conn, level_id)
}

// ---------------------------------------------------------------------------
// rulers — measured distances kept on the plan
// ---------------------------------------------------------------------------

const RULER_COLS: &str = "id, level_id, x1, y1, x2, y2";

fn row_to_ruler(r: &rusqlite::Row<'_>) -> rusqlite::Result<Ruler> {
    Ok(Ruler {
        id: r.get(0)?,
        level_id: r.get(1)?,
        x1: r.get(2)?,
        y1: r.get(3)?,
        x2: r.get(4)?,
        y2: r.get(5)?,
    })
}

pub fn list_rulers(conn: &Connection, level_id: i64) -> rusqlite::Result<Vec<Ruler>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RULER_COLS} FROM rulers WHERE level_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([level_id], row_to_ruler)?;
    rows.collect()
}

pub fn add_ruler(
    conn: &Connection,
    level_id: i64,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
) -> rusqlite::Result<Ruler> {
    conn.execute(
        "INSERT INTO rulers (level_id, x1, y1, x2, y2) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![level_id, x1, y1, x2, y2],
    )?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        &format!("SELECT {RULER_COLS} FROM rulers WHERE id = ?1"),
        [id],
        row_to_ruler,
    )
}

pub fn restore_ruler(conn: &Connection, r: &Ruler) -> rusqlite::Result<Ruler> {
    conn.execute(
        "INSERT OR REPLACE INTO rulers (id, level_id, x1, y1, x2, y2) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![r.id, r.level_id, r.x1, r.y1, r.x2, r.y2],
    )?;
    conn.query_row(
        &format!("SELECT {RULER_COLS} FROM rulers WHERE id = ?1"),
        [r.id],
        row_to_ruler,
    )
}

pub fn delete_ruler(conn: &Connection, id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM rulers WHERE id = ?1", [id])
}

// ---------------------------------------------------------------------------
// drawn floors and walls (the plan editor)
// ---------------------------------------------------------------------------

/// A floor drawn in the editor: no image, a fixed sheet, one pixel = one
/// centimetre, so it is calibrated by construction.
pub fn add_drawn_level(
    conn: &Connection,
    name: &str,
    width_cm: f64,
    height_cm: f64,
) -> rusqlite::Result<Level> {
    conn.execute(
        "INSERT INTO levels (name, image_path, sort_order, cm_per_px, width_px, height_px)
         VALUES (?1, '', (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM levels), 1.0, ?2, ?3)",
        params![name.trim(), width_cm, height_cm],
    )?;
    Ok(get_level(conn, conn.last_insert_rowid())?.expect("level just inserted must exist"))
}

/// One straight wall: its centre line in plan pixels, and its thickness in real
/// centimetres (so recalibrating an imported plan keeps walls the right width).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Wall {
    #[serde(default)]
    pub id: i64,
    pub level_id: i64,
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub thickness_cm: f64,
}

const WALL_COLS: &str = "id, level_id, x1, y1, x2, y2, thickness_cm";

fn row_to_wall(r: &rusqlite::Row<'_>) -> rusqlite::Result<Wall> {
    Ok(Wall {
        id: r.get(0)?,
        level_id: r.get(1)?,
        x1: r.get(2)?,
        y1: r.get(3)?,
        x2: r.get(4)?,
        y2: r.get(5)?,
        thickness_cm: r.get(6)?,
    })
}

fn get_wall(conn: &Connection, id: i64) -> rusqlite::Result<Option<Wall>> {
    conn.query_row(
        &format!("SELECT {WALL_COLS} FROM walls WHERE id = ?1"),
        [id],
        row_to_wall,
    )
    .optional()
}

pub fn list_walls(conn: &Connection, level_id: i64) -> rusqlite::Result<Vec<Wall>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {WALL_COLS} FROM walls WHERE level_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([level_id], row_to_wall)?;
    rows.collect()
}

pub fn add_wall(conn: &Connection, w: &Wall) -> rusqlite::Result<Wall> {
    conn.execute(
        "INSERT INTO walls (level_id, x1, y1, x2, y2, thickness_cm) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![w.level_id, w.x1, w.y1, w.x2, w.y2, w.thickness_cm],
    )?;
    Ok(get_wall(conn, conn.last_insert_rowid())?.expect("wall just inserted must exist"))
}

/// Replace a wall's geometry and thickness, or re-create a deleted wall with its
/// old id (undo). Both are the same statement.
///
/// An UPSERT, deliberately not `INSERT OR REPLACE`: REPLACE deletes the old row
/// first, and that delete would cascade to the doors and windows in the wall.
pub fn put_wall(conn: &Connection, w: &Wall) -> rusqlite::Result<Wall> {
    conn.execute(
        "INSERT INTO walls (id, level_id, x1, y1, x2, y2, thickness_cm)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET level_id = excluded.level_id,
            x1 = excluded.x1, y1 = excluded.y1, x2 = excluded.x2, y2 = excluded.y2,
            thickness_cm = excluded.thickness_cm",
        params![w.id, w.level_id, w.x1, w.y1, w.x2, w.y2, w.thickness_cm],
    )?;
    Ok(get_wall(conn, w.id)?.expect("wall just written must exist"))
}

pub fn delete_wall(conn: &Connection, id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM walls WHERE id = ?1", [id])
}

/// A door, window or plain opening in a wall. Positioned ALONG its wall — from the
/// wall's first end, in plan pixels — so it moves with the wall when a corner moves.
///
/// `kind`: door · double_door · pocket_door · opening · window · french_window ·
/// french_window_2 · fixed_window. `hinge` 0/1: the hinge (or the pocket) is at the
/// start or the end of the opening. `side` ±1: which face of the wall it opens to.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Opening {
    #[serde(default)]
    pub id: i64,
    pub level_id: i64,
    pub wall_id: i64,
    pub kind: String,
    pub offset_px: f64,
    pub width_px: f64,
    #[serde(default)]
    pub hinge: i64,
    #[serde(default = "default_side")]
    pub side: i64,
}
fn default_side() -> i64 {
    1
}

const OPENING_COLS: &str = "id, level_id, wall_id, kind, offset_px, width_px, hinge, side";

fn row_to_opening(r: &rusqlite::Row<'_>) -> rusqlite::Result<Opening> {
    Ok(Opening {
        id: r.get(0)?,
        level_id: r.get(1)?,
        wall_id: r.get(2)?,
        kind: r.get(3)?,
        offset_px: r.get(4)?,
        width_px: r.get(5)?,
        hinge: r.get(6)?,
        side: r.get(7)?,
    })
}

fn get_opening(conn: &Connection, id: i64) -> rusqlite::Result<Option<Opening>> {
    conn.query_row(
        &format!("SELECT {OPENING_COLS} FROM openings WHERE id = ?1"),
        [id],
        row_to_opening,
    )
    .optional()
}

pub fn list_openings(conn: &Connection, level_id: i64) -> rusqlite::Result<Vec<Opening>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {OPENING_COLS} FROM openings WHERE level_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([level_id], row_to_opening)?;
    rows.collect()
}

pub fn add_opening(conn: &Connection, o: &Opening) -> rusqlite::Result<Opening> {
    conn.execute(
        "INSERT INTO openings (level_id, wall_id, kind, offset_px, width_px, hinge, side)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            o.level_id,
            o.wall_id,
            o.kind,
            o.offset_px,
            o.width_px,
            o.hinge,
            o.side
        ],
    )?;
    Ok(get_opening(conn, conn.last_insert_rowid())?.expect("opening just inserted must exist"))
}

/// Update an opening, or bring a deleted one back with its old id (undo).
pub fn put_opening(conn: &Connection, o: &Opening) -> rusqlite::Result<Opening> {
    conn.execute(
        "INSERT INTO openings (id, level_id, wall_id, kind, offset_px, width_px, hinge, side)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET level_id = excluded.level_id, wall_id = excluded.wall_id,
            kind = excluded.kind, offset_px = excluded.offset_px, width_px = excluded.width_px,
            hinge = excluded.hinge, side = excluded.side",
        params![
            o.id,
            o.level_id,
            o.wall_id,
            o.kind,
            o.offset_px,
            o.width_px,
            o.hinge,
            o.side
        ],
    )?;
    Ok(get_opening(conn, o.id)?.expect("opening just written must exist"))
}

pub fn delete_opening(conn: &Connection, id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM openings WHERE id = ?1", [id])
}

// ---------------------------------------------------------------------------
// search — across every floor of the open project
// ---------------------------------------------------------------------------

/// One pin matched by a search, with the context needed to show and reach it.
/// `photo_count` and `measurement_count` also drive the "has photos" and
/// "has measurements" filters, so the frontend needs no extra round trips.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub pin: Pin,
    pub level_id: i64,
    pub level_name: String,
    pub room_name: Option<String>,
    pub photo_count: i64,
    pub measurement_count: i64,
    /// This pin's photo captions joined together, so a search can match them
    /// without a second query. The frontend decides which field matched.
    pub captions: String,
}

/// Every pin in the project, with its context. The caller filters and ranks:
/// a personal renovation has hundreds of pins, not millions, so one pass over
/// them in the frontend is simpler and more flexible than SQL for each query.
pub fn search_context(conn: &Connection) -> rusqlite::Result<Vec<SearchHit>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.level_id, p.x, p.y, p.label, p.notes, p.category, p.room_id, p.created_at,
                l.name,
                r.name,
                (SELECT COUNT(*) FROM photos       ph WHERE ph.pin_id = p.id),
                (SELECT COUNT(*) FROM measurements m  WHERE m.pin_id  = p.id),
                (SELECT COALESCE(GROUP_CONCAT(ph.caption, ' '), '') FROM photos ph WHERE ph.pin_id = p.id)
         FROM pins p
         JOIN levels l ON l.id = p.level_id
         LEFT JOIN rooms r ON r.id = p.room_id
         ORDER BY l.sort_order, l.id, p.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            Pin {
                id: r.get(0)?,
                level_id: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                label: r.get(4)?,
                notes: r.get(5)?,
                category: r.get(6)?,
                room_id: r.get(7)?,
                created_at: r.get(8)?,
            },
            r.get::<_, String>(9)?,
            r.get::<_, Option<String>>(10)?,
            r.get::<_, i64>(11)?,
            r.get::<_, i64>(12)?,
            r.get::<_, String>(13)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (pin, level_name, room_name, photo_count, measurement_count, captions) = row?;
        out.push(SearchHit {
            level_id: pin.level_id,
            pin,
            level_name,
            room_name,
            photo_count,
            measurement_count,
            captions,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    fn has_column(conn: &Connection, table: &str, col: &str) -> bool {
        conn.prepare(&format!(
            "SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{col}'"
        ))
        .unwrap()
        .exists([])
        .unwrap()
    }

    #[test]
    fn an_older_database_is_backed_up_before_the_upgrade() {
        // inside the build folder, never outside the project
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-tmp/backup");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("plan.db");
        {
            let c = Connection::open(&db).unwrap();
            c.execute_batch(
                "CREATE TABLE levels (id INTEGER PRIMARY KEY, name TEXT NOT NULL, image_path TEXT NOT NULL,
                                      sort_order INTEGER NOT NULL DEFAULT 0, cm_per_px REAL);
                 CREATE TABLE pins (id INTEGER PRIMARY KEY, level_id INTEGER NOT NULL, x REAL NOT NULL,
                                    y REAL NOT NULL, label TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
                                    category TEXT NOT NULL DEFAULT 'other', room_id INTEGER,
                                    created_at TEXT NOT NULL DEFAULT '');
                 CREATE TABLE photos (id INTEGER PRIMARY KEY, pin_id INTEGER NOT NULL, file_path TEXT NOT NULL,
                                      thumb_path TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '',
                                      created_at TEXT NOT NULL DEFAULT '');
                 INSERT INTO levels (name, image_path) VALUES ('Kept', 'plans/a.png');
                 PRAGMA user_version = 8;",
            )
            .unwrap();
        }
        let conn = open(&db).unwrap();
        let bak = dir.join("plan.db.v8.bak");
        assert!(bak.exists(), "the backup must exist");
        let old = Connection::open(&bak).unwrap();
        let v: i64 = old
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 8, "the backup is the database as it was");
        let name: String = old
            .query_row("SELECT name FROM levels", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Kept");
        let now: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(now, DB_VERSION);
        // opening an up-to-date database makes no new backup
        drop(conn);
        std::fs::remove_file(&bak).unwrap();
        open(&db).unwrap();
        assert!(!bak.exists());
    }

    #[test]
    fn a_new_database_is_at_the_latest_version() {
        let conn = fresh();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, DB_VERSION);
        assert!(has_column(&conn, "levels", "width_px"));
    }

    #[test]
    fn version_8_gains_walls_and_sheet_size() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE levels (id INTEGER PRIMARY KEY, name TEXT NOT NULL, image_path TEXT NOT NULL,
                                  sort_order INTEGER NOT NULL DEFAULT 0, cm_per_px REAL);
             CREATE TABLE pins (id INTEGER PRIMARY KEY, level_id INTEGER NOT NULL, x REAL NOT NULL,
                                y REAL NOT NULL, label TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
                                category TEXT NOT NULL DEFAULT 'other', room_id INTEGER,
                                created_at TEXT NOT NULL DEFAULT '');
             CREATE TABLE photos (id INTEGER PRIMARY KEY, pin_id INTEGER NOT NULL, file_path TEXT NOT NULL,
                                  thumb_path TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '',
                                  created_at TEXT NOT NULL DEFAULT '');
             INSERT INTO levels (name, image_path) VALUES ('Old', 'plans/old.png');
             PRAGMA user_version = 8;",
        )
        .unwrap();
        init(&conn).unwrap();
        assert!(has_column(&conn, "levels", "height_px"));
        let old = get_level(&conn, 1).unwrap().unwrap();
        assert_eq!(old.width_px, None);
        assert!(list_walls(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn walls_round_trip_and_follow_their_floor() {
        let conn = fresh();
        let lvl = add_drawn_level(&conn, " Soppalco ", 4000.0, 3000.0).unwrap();
        assert_eq!(lvl.name, "Soppalco");
        assert_eq!(lvl.image_path, "");
        assert_eq!(lvl.cm_per_px, Some(1.0));
        assert_eq!(lvl.width_px, Some(4000.0));

        let new = Wall {
            id: 0,
            level_id: lvl.id,
            x1: 100.0,
            y1: 100.0,
            x2: 450.5,
            y2: 100.0,
            thickness_cm: 12.0,
        };
        let w = add_wall(&conn, &new).unwrap();
        assert!(w.id > 0);
        assert_eq!(w.x2, 450.5);

        // put_wall replaces in place...
        let moved = put_wall(
            &conn,
            &Wall {
                y2: 300.0,
                ..w.clone()
            },
        )
        .unwrap();
        assert_eq!(moved.id, w.id);
        assert_eq!(list_walls(&conn, lvl.id).unwrap()[0].y2, 300.0);

        // ...and brings a deleted wall back with its old id (undo)
        assert_eq!(delete_wall(&conn, w.id).unwrap(), 1);
        assert!(list_walls(&conn, lvl.id).unwrap().is_empty());
        let back = put_wall(&conn, &moved).unwrap();
        assert_eq!(back.id, w.id);

        // deleting the floor deletes its walls
        conn.execute("DELETE FROM levels WHERE id = ?1", [lvl.id])
            .unwrap();
        assert!(list_walls(&conn, lvl.id).unwrap().is_empty());
    }

    #[test]
    fn openings_survive_moving_their_wall_and_go_with_it() {
        let conn = fresh();
        let lvl = add_drawn_level(&conn, "Main", 4000.0, 3000.0).unwrap();
        let w = add_wall(
            &conn,
            &Wall {
                id: 0,
                level_id: lvl.id,
                x1: 0.0,
                y1: 0.0,
                x2: 500.0,
                y2: 0.0,
                thickness_cm: 10.0,
            },
        )
        .unwrap();
        let door = add_opening(
            &conn,
            &Opening {
                id: 0,
                level_id: lvl.id,
                wall_id: w.id,
                kind: "door".into(),
                offset_px: 100.0,
                width_px: 80.0,
                hinge: 0,
                side: -1,
            },
        )
        .unwrap();
        assert_eq!(door.side, -1);

        // moving a corner rewrites the wall: its door must not be cascaded away
        put_wall(
            &conn,
            &Wall {
                x2: 600.0,
                ..w.clone()
            },
        )
        .unwrap();
        assert_eq!(list_openings(&conn, lvl.id).unwrap().len(), 1);

        let flipped = put_opening(
            &conn,
            &Opening {
                hinge: 1,
                ..door.clone()
            },
        )
        .unwrap();
        assert_eq!(flipped.id, door.id);
        assert_eq!(flipped.hinge, 1);

        // deleting the wall takes its openings with it
        delete_wall(&conn, w.id).unwrap();
        assert!(list_openings(&conn, lvl.id).unwrap().is_empty());
    }
}
