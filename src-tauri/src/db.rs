//! SQLite storage.
//!
//! One connection, opened once at startup, shared behind a Mutex. SQLite is
//! compiled into the binary (rusqlite's `bundled` feature), so the app carries
//! its own database engine and needs nothing installed on the machine.
//!
//! Coordinates are IMAGE PIXELS with the origin at the top-left of the plan
//! image, y downwards — the convention the frontend also uses.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
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
    pub image_path: String,
    pub sort_order: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub id: i64,
    pub level_id: i64,
    pub x: f64,
    pub y: f64,
    pub label: String,
    pub notes: String,
    pub created_at: String,
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
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         );
         CREATE TABLE IF NOT EXISTS photos (
            id          INTEGER PRIMARY KEY,
            pin_id      INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
            file_path   TEXT    NOT NULL,
            caption     TEXT    NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         );
         CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS pins_by_level ON pins(level_id);",
    )?;

    seed_if_empty(&conn)?;
    Ok(conn)
}

/// First launch only: register the demo plan and one example pin, so the app
/// opens showing something rather than an empty screen.
fn seed_if_empty(conn: &Connection) -> rusqlite::Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM levels", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO levels (name, image_path, sort_order) VALUES (?1, ?2, 0)",
        params!["Demo plan", "assets/demo-plan.png"],
    )?;
    let level_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO pins (level_id, x, y, label, notes) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            level_id,
            1010.0,
            300.0,
            "Cold water riser",
            "Copper 22 mm, runs vertically inside the kitchen wall. \
             Centre is 38 cm from the door frame, joint at 112 cm above finished floor."
        ],
    )?;
    Ok(())
}

pub fn list_levels(conn: &Connection) -> rusqlite::Result<Vec<Level>> {
    let mut stmt = conn.prepare("SELECT id, name, image_path, sort_order FROM levels ORDER BY sort_order, id")?;
    // query_map runs the statement and turns each row into a Level via the closure.
    // collect() gathers them into a Vec, stopping at the first error if any.
    let rows = stmt.query_map([], |r| {
        Ok(Level { id: r.get(0)?, name: r.get(1)?, image_path: r.get(2)?, sort_order: r.get(3)? })
    })?;
    rows.collect()
}

pub fn list_pins(conn: &Connection, level_id: i64) -> rusqlite::Result<Vec<Pin>> {
    let mut stmt = conn.prepare(
        "SELECT id, level_id, x, y, label, notes, created_at FROM pins WHERE level_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([level_id], row_to_pin)?;
    rows.collect()
}

pub fn get_pin(conn: &Connection, id: i64) -> rusqlite::Result<Option<Pin>> {
    conn.query_row(
        "SELECT id, level_id, x, y, label, notes, created_at FROM pins WHERE id = ?1",
        [id],
        row_to_pin,
    )
    .optional() // a missing row is `None`, not an error
}

pub fn add_pin(conn: &Connection, level_id: i64, x: f64, y: f64, label: &str, notes: &str) -> rusqlite::Result<Pin> {
    conn.execute(
        "INSERT INTO pins (level_id, x, y, label, notes) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![level_id, x, y, label, notes],
    )?;
    let id = conn.last_insert_rowid();
    // Read it back so the caller gets the server-side created_at, not a guess.
    Ok(get_pin(conn, id)?.expect("pin just inserted must exist"))
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
        created_at: r.get(6)?,
    })
}
