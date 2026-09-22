//! Application entry: manages the projects directory, keeps the currently open
//! project (its folder + SQLite connection) in shared state, and exposes the
//! commands the frontend calls with `invoke("name", { args })`.
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
mod projects;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{Manager, State};

use projects::ProjectInfo;

/// The project the user is working in right now.
pub struct OpenProject {
    dir: PathBuf,
    conn: Connection,
}

/// Shared application state. Tauri keeps one instance and hands a reference to
/// any command that asks for `State<AppState>`. The Mutex guarantees only one
/// command touches the open project at a time.
pub struct AppState {
    projects_dir: PathBuf,
    current: Mutex<Option<OpenProject>>,
}

type R<T> = Result<T, String>;

/// Run `f` against the open project's database, or fail with a clear message
/// if no project is open. Every pin/level command goes through here.
fn with_project<T>(state: &AppState, f: impl FnOnce(&Connection, &Path) -> R<T>) -> R<T> {
    let guard = state.current.lock().map_err(|e| e.to_string())?;
    let p = guard.as_ref().ok_or("no project is open")?;
    f(&p.conn, &p.dir)
}

/// Same, for commands that change data: also stamps the project's modified time.
fn with_project_mut<T>(state: &AppState, f: impl FnOnce(&Connection, &Path) -> R<T>) -> R<T> {
    let out = with_project(state, f)?;
    with_project(state, |_, dir| projects::touch(dir))?;
    Ok(out)
}

fn s<E: std::fmt::Display>(e: E) -> String { e.to_string() }

/// Levels leave Rust with their absolute image path filled in for this machine.
fn with_file(dir: &Path, mut l: db::Level) -> db::Level {
    l.image_file = dir.join(&l.image_path).display().to_string();
    l
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_projects(state: State<AppState>) -> R<Vec<ProjectInfo>> {
    projects::list(&state.projects_dir)
}

#[tauri::command]
fn create_project(state: State<AppState>, name: String) -> R<ProjectInfo> {
    let p = projects::create(&state.projects_dir, &name)?;
    open_project(state, p.slug.clone())
}

#[tauri::command]
fn open_project(state: State<AppState>, slug: String) -> R<ProjectInfo> {
    let dir = state.projects_dir.join(&slug);
    let info = projects::info(&dir)?;
    let conn = db::open(&dir.join("plan.db")).map_err(s)?;
    // Replacing the Option drops the previous OpenProject, which closes its connection.
    *state.current.lock().map_err(s)? = Some(OpenProject { dir, conn });
    Ok(info)
}

#[tauri::command]
fn current_project(state: State<AppState>) -> R<Option<ProjectInfo>> {
    let guard = state.current.lock().map_err(s)?;
    guard.as_ref().map(|p| projects::info(&p.dir)).transpose()
}

#[tauri::command]
fn close_project(state: State<AppState>) -> R<()> {
    *state.current.lock().map_err(s)? = None;
    Ok(())
}

/// Moves the project folder to the OS trash. If it is the open project, it is closed first.
#[tauri::command]
fn delete_project(state: State<AppState>, slug: String) -> R<()> {
    let is_open = {
        let guard = state.current.lock().map_err(s)?;
        guard.as_ref().map(|p| p.dir == state.projects_dir.join(&slug)).unwrap_or(false)
    };
    if is_open {
        *state.current.lock().map_err(s)? = None; // drops the connection before the move
    }
    projects::delete(&state.projects_dir, &slug)
}

#[tauri::command]
fn export_project(state: State<AppState>, slug: String, dest: String) -> R<()> {
    projects::export_zip(&state.projects_dir.join(slug), Path::new(&dest))
}

#[tauri::command]
fn import_project(state: State<AppState>, zip_path: String) -> R<ProjectInfo> {
    projects::import_zip(&state.projects_dir, Path::new(&zip_path))
}

/// Per-project setting: which convention maps categories to marker colours ("it" or "apwa").
#[tauri::command]
fn set_colour_scheme(state: State<AppState>, scheme: String) -> R<projects::ProjectInfo> {
    if !["it", "apwa"].contains(&scheme.as_str()) {
        return Err(format!("unknown colour scheme {scheme}"));
    }
    with_project(&state, |_, dir| {
        let mut m = projects::read_manifest(dir)?;
        m.colour_scheme = scheme.clone();
        projects::write_manifest(dir, &m)?;
        projects::info(dir)
    })
}

#[tauri::command]
fn projects_dir(state: State<AppState>) -> String {
    state.projects_dir.display().to_string()
}

// ---------------------------------------------------------------------------
// levels
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_levels(state: State<AppState>) -> R<Vec<db::Level>> {
    with_project(&state, |conn, dir| {
        Ok(db::list_levels(conn).map_err(s)?.into_iter().map(|l| with_file(dir, l)).collect())
    })
}

/// Copy a picked image into the project and register it as a new level.
#[tauri::command]
fn import_plan(state: State<AppState>, src_path: String, name: String) -> R<db::Level> {
    with_project_mut(&state, |conn, dir| {
        projects::import_plan(dir, conn, Path::new(&src_path), &name).map(|l| with_file(dir, l))
    })
}

// ---------------------------------------------------------------------------
// pins — every command returns Result<T, String>: Ok resolves the JS promise,
// Err rejects it with a message the UI can show.
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_pins(state: State<AppState>, level_id: i64) -> R<Vec<db::Pin>> {
    with_project(&state, |conn, _| db::list_pins(conn, level_id).map_err(s))
}

#[tauri::command]
fn add_pin(state: State<AppState>, level_id: i64, x: f64, y: f64, label: String, notes: String, category: String) -> R<db::Pin> {
    with_project_mut(&state, |conn, _| db::add_pin(conn, level_id, x, y, &label, &notes, &category).map_err(s))
}

#[tauri::command]
fn update_pin(state: State<AppState>, id: i64, label: String, notes: String, category: String) -> R<db::Pin> {
    with_project_mut(&state, |conn, _| {
        db::update_pin(conn, id, &label, &notes, &category).map_err(s)?.ok_or_else(|| format!("pin {id} does not exist"))
    })
}

#[tauri::command]
fn restore_pin(state: State<AppState>, pin: db::Pin) -> R<db::Pin> {
    with_project_mut(&state, |conn, _| db::restore_pin(conn, &pin).map_err(s))
}

#[tauri::command]
fn delete_pin(state: State<AppState>, id: i64) -> R<bool> {
    with_project_mut(&state, |conn, _| Ok(db::delete_pin(conn, id).map_err(s)? > 0))
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Runs once, before the window appears.
            //   Linux   ~/.local/share/com.planfloorviewer.app/projects/
            //   macOS   ~/Library/Application Support/com.planfloorviewer.app/projects/
            //   Windows %APPDATA%\com.planfloorviewer.app\projects\
            let app_data = app.path().app_data_dir()?;
            let projects_dir = app_data.join("projects");
            std::fs::create_dir_all(&projects_dir)?;

            // One-time: adopt the pre-projects database, or seed a demo on a fresh install.
            if let Some(p) = projects::migrate_legacy(&app_data, &projects_dir)? {
                eprintln!("migrated legacy database into project '{}'", p.slug);
            } else if projects::list(&projects_dir)?.is_empty() {
                projects::create_demo(&projects_dir)?;
            }

            app.manage(AppState { projects_dir, current: Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects, create_project, open_project, current_project, close_project, delete_project,
            export_project, import_project, projects_dir, set_colour_scheme,
            list_levels, import_plan,
            list_pins, add_pin, update_pin, restore_pin, delete_pin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
