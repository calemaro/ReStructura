//! Application entry: opens the database at startup and exposes a handful of
//! commands the frontend can call with `invoke("name", { args })`.
//!
//! How the bridge works
//! --------------------
//! A function marked `#[tauri::command]` becomes callable from JavaScript.
//! Tauri deserialises the JS arguments into the Rust parameter types, runs the
//! function, and serialises the return value back to JSON. Think of each one as
//! a Flask route whose transport is a direct function call instead of HTTP.
//!
//! Two things trip people up:
//!   * a command must be listed in `generate_handler![...]` below, or the
//!     frontend gets "command not found";
//!   * Rust `snake_case` parameters arrive from JS as `camelCase` keys
//!     (`level_id` here  <->  `{ levelId: 1 }` there).

mod db;

use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{Manager, State};

/// The shared database handle. Tauri keeps one instance of this and hands a
/// reference to any command that asks for `State<Db>`. The Mutex guarantees
/// only one command talks to SQLite at a time.
pub struct Db(Mutex<Connection>);

/// Every command returns `Result<T, String>`: `Ok(value)` resolves the JS
/// promise, `Err(message)` rejects it. `map_err(|e| e.to_string())` converts
/// rusqlite's error type into the plain string the frontend can display.
#[tauri::command]
fn list_levels(state: State<Db>) -> Result<Vec<db::Level>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_levels(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_pins(state: State<Db>, level_id: i64) -> Result<Vec<db::Pin>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_pins(&conn, level_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_pin(state: State<Db>, level_id: i64, x: f64, y: f64, label: String, notes: String) -> Result<db::Pin, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::add_pin(&conn, level_id, x, y, &label, &notes).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_pin(state: State<Db>, id: i64) -> Result<bool, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let n = db::delete_pin(&conn, id).map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Where the database lives, for display in the UI and for troubleshooting.
#[tauri::command]
fn db_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(database_file(&app)?.display().to_string())
}

fn database_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // Tauri resolves the per-OS application data directory:
    //   Linux   ~/.local/share/com.planfloorviewer.app/
    //   macOS   ~/Library/Application Support/com.planfloorviewer.app/
    //   Windows %APPDATA%\com.planfloorviewer.app\
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("plan.db"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Runs once, before the window appears.
            let path = database_file(app.handle())?;
            let conn = db::open(&path)?;
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_levels, list_pins, add_pin, delete_pin, db_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
