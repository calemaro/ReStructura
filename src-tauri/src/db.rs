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
    /// Absolute path on this machine, filled in when the level is handed to the frontend.
    /// Never stored: it would break the moment the project moves to another computer.
    #[serde(default)]
    pub image_file: String,
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
    pub created_at: String,
}
fn default_category() -> String { "other".into() }

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
            sort_order  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS pins (
            id          INTEGER PRIMARY KEY,
            level_id    INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
            x           REAL    NOT NULL,
            y           REAL    NOT NULL,
            label       TEXT    NOT NULL DEFAULT '',
            notes       TEXT    NOT NULL DEFAULT '',
            category    TEXT    NOT NULL DEFAULT 'other',
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
         CREATE TABLE IF NOT EXISTS measurements (
            id          INTEGER PRIMARY KEY,
            pin_id      INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
            kind        TEXT    NOT NULL,
            reference   TEXT    NOT NULL DEFAULT '',
            value_cm    REAL    NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS pins_by_level ON pins(level_id);
         CREATE INDEX IF NOT EXISTS measurements_by_pin ON measurements(pin_id);",
    )?;

    migrate(&conn)?;
    Ok(conn)
}

/// Bring an older database up to the current layout.
///
/// SQLite keeps a small integer in the file header (`PRAGMA user_version`)
/// that we use as the schema version. Each step below upgrades one version
/// and is applied in order, so a database from any earlier release ends up
/// current. `CREATE TABLE IF NOT EXISTS` above already handles brand-new
/// files, which is why a fresh database starts at the latest version.
const DB_VERSION: i64 = 4;

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
            conn.execute_batch("ALTER TABLE photos ADD COLUMN thumb_path TEXT NOT NULL DEFAULT '';")?;
        }
        v = 4;
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
    let mut stmt = conn.prepare("SELECT id, name, image_path, sort_order FROM levels ORDER BY sort_order, id")?;
    // query_map runs the statement and turns each row into a Level via the closure.
    // collect() gathers them into a Vec, stopping at the first error if any.
    let rows = stmt.query_map([], row_to_level)?;
    rows.collect()
}

pub fn get_level(conn: &Connection, id: i64) -> rusqlite::Result<Option<Level>> {
    conn.query_row("SELECT id, name, image_path, sort_order FROM levels WHERE id = ?1", [id], row_to_level)
        .optional()
}

fn row_to_level(r: &rusqlite::Row<'_>) -> rusqlite::Result<Level> {
    Ok(Level { id: r.get(0)?, name: r.get(1)?, image_path: r.get(2)?, sort_order: r.get(3)?, image_file: String::new() })
}

pub fn list_pins(conn: &Connection, level_id: i64) -> rusqlite::Result<Vec<Pin>> {
    let mut stmt = conn.prepare(
        "SELECT id, level_id, x, y, label, notes, category, created_at FROM pins WHERE level_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([level_id], row_to_pin)?;
    rows.collect()
}

pub fn get_pin(conn: &Connection, id: i64) -> rusqlite::Result<Option<Pin>> {
    conn.query_row(
        "SELECT id, level_id, x, y, label, notes, category, created_at FROM pins WHERE id = ?1",
        [id],
        row_to_pin,
    )
    .optional() // a missing row is `None`, not an error
}

pub fn add_pin(conn: &Connection, level_id: i64, x: f64, y: f64, label: &str, notes: &str, category: &str) -> rusqlite::Result<Pin> {
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
pub fn update_pin(conn: &Connection, id: i64, label: &str, notes: &str, category: &str) -> rusqlite::Result<Option<Pin>> {
    conn.execute(
        "UPDATE pins SET label = ?1, notes = ?2, category = ?3 WHERE id = ?4",
        params![label, notes, category, id],
    )?;
    get_pin(conn, id)
}

/// Move a pin to new plan-pixel coordinates (edit mode drag).
pub fn move_pin(conn: &Connection, id: i64, x: f64, y: f64) -> rusqlite::Result<Option<Pin>> {
    conn.execute("UPDATE pins SET x = ?1, y = ?2 WHERE id = ?3", params![x, y, id])?;
    get_pin(conn, id)
}

/// Re-insert a pin exactly as it was, keeping its original id and timestamp.
/// Used by undo: a restored pin must keep its identity so anything that
/// referenced it (photos, later) lines up again.
pub fn restore_pin(conn: &Connection, pin: &Pin) -> rusqlite::Result<Pin> {
    conn.execute(
        "INSERT OR REPLACE INTO pins (id, level_id, x, y, label, notes, category, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![pin.id, pin.level_id, pin.x, pin.y, pin.label, pin.notes, pin.category, pin.created_at],
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
        created_at: r.get(7)?,
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
        Ok(Measurement { id: r.get(0)?, pin_id: r.get(1)?, kind: r.get(2)?, reference: r.get(3)?, value_cm: r.get(4)?, sort_order: r.get(5)? })
    })?;
    rows.collect()
}

/// Replace a pin's measurements with `list`, in one transaction. Treating the
/// list as a single value keeps undo and copy/paste trivial: "before" and
/// "after" are just two lists.
pub fn set_measurements(conn: &Connection, pin_id: i64, list: &[Measurement]) -> rusqlite::Result<Vec<Measurement>> {
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
        Ok(v) => { conn.execute_batch("COMMIT;")?; Ok(v) }
        Err(e) => { let _ = conn.execute_batch("ROLLBACK;"); Err(e) }
    }
}

// ---------------------------------------------------------------------------
// photos
// ---------------------------------------------------------------------------

const PHOTO_COLS: &str = "id, pin_id, file_path, thumb_path, caption, created_at";

fn row_to_photo(r: &rusqlite::Row<'_>) -> rusqlite::Result<Photo> {
    Ok(Photo { id: r.get(0)?, pin_id: r.get(1)?, file_path: r.get(2)?, thumb_path: r.get(3)?, caption: r.get(4)?, created_at: r.get(5)?, file: String::new(), thumb: String::new() })
}

pub fn list_photos(conn: &Connection, pin_id: i64) -> rusqlite::Result<Vec<Photo>> {
    let mut stmt = conn.prepare(&format!("SELECT {PHOTO_COLS} FROM photos WHERE pin_id = ?1 ORDER BY id"))?;
    let rows = stmt.query_map([pin_id], row_to_photo)?;
    rows.collect()
}

pub fn get_photo(conn: &Connection, id: i64) -> rusqlite::Result<Option<Photo>> {
    conn.query_row(&format!("SELECT {PHOTO_COLS} FROM photos WHERE id = ?1"), [id], row_to_photo).optional()
}

pub fn insert_photo(conn: &Connection, pin_id: i64, file_path: &str, thumb_path: &str) -> rusqlite::Result<Photo> {
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
    conn.execute("UPDATE photos SET caption = ?1 WHERE id = ?2", params![caption, id])?;
    get_photo(conn, id)
}

pub fn delete_photo_row(conn: &Connection, id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM photos WHERE id = ?1", [id])
}
