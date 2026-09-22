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
mod photos;
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

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

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
        guard
            .as_ref()
            .map(|p| p.dir == state.projects_dir.join(&slug))
            .unwrap_or(false)
    };
    if is_open {
        *state.current.lock().map_err(s)? = None; // drops the connection before the move
    }
    projects::delete(&state.projects_dir, &slug)
}

#[tauri::command]
fn rename_project(state: State<AppState>, slug: String, name: String) -> R<ProjectInfo> {
    projects::rename(&state.projects_dir, &slug, &name)
}

#[tauri::command]
fn project_stats(state: State<AppState>) -> R<projects::ProjectStats> {
    with_project(&state, |conn, dir| projects::stats(dir, conn))
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
        Ok(db::list_levels(conn)
            .map_err(s)?
            .into_iter()
            .map(|l| with_file(dir, l))
            .collect())
    })
}

#[tauri::command]
fn rename_level(state: State<AppState>, level_id: i64, name: String) -> R<db::Level> {
    if name.trim().is_empty() {
        return Err("a floor needs a name".into());
    }
    with_project_mut(&state, |conn, dir| {
        db::rename_level(conn, level_id, &name)
            .map_err(s)?
            .map(|l| with_file(dir, l))
            .ok_or_else(|| format!("floor {level_id} does not exist"))
    })
}

/// Calibration: the user measures one real distance and clicks its two ends on
/// the plan, giving centimetres per pixel for this level. Pass None to clear it.
#[tauri::command]
fn set_level_scale(state: State<AppState>, level_id: i64, cm_per_px: Option<f64>) -> R<db::Level> {
    if let Some(v) = cm_per_px {
        if !v.is_finite() || v <= 0.0 {
            return Err("the measured distance must be a positive number".into());
        }
    }
    with_project_mut(&state, |conn, dir| {
        db::set_level_scale(conn, level_id, cm_per_px)
            .map_err(s)?
            .map(|l| with_file(dir, l))
            .ok_or_else(|| format!("level {level_id} does not exist"))
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
fn add_pin(
    state: State<AppState>,
    level_id: i64,
    x: f64,
    y: f64,
    label: String,
    notes: String,
    category: String,
) -> R<db::Pin> {
    with_project_mut(&state, |conn, _| {
        db::add_pin(conn, level_id, x, y, &label, &notes, &category).map_err(s)
    })
}

#[tauri::command]
fn update_pin(
    state: State<AppState>,
    id: i64,
    label: String,
    notes: String,
    category: String,
    room_id: Option<i64>,
) -> R<db::Pin> {
    with_project_mut(&state, |conn, _| {
        db::update_pin(conn, id, &label, &notes, &category, room_id)
            .map_err(s)?
            .ok_or_else(|| format!("pin {id} does not exist"))
    })
}

#[tauri::command]
fn move_pin(state: State<AppState>, id: i64, x: f64, y: f64) -> R<db::Pin> {
    with_project_mut(&state, |conn, _| {
        db::move_pin(conn, id, x, y)
            .map_err(s)?
            .ok_or_else(|| format!("pin {id} does not exist"))
    })
}

#[tauri::command]
fn restore_pin(state: State<AppState>, pin: db::Pin) -> R<db::Pin> {
    with_project_mut(&state, |conn, _| db::restore_pin(conn, &pin).map_err(s))
}

#[tauri::command]
fn delete_pin(state: State<AppState>, id: i64) -> R<bool> {
    with_project_mut(&state, |conn, _| {
        Ok(db::delete_pin(conn, id).map_err(s)? > 0)
    })
}

// ---------------------------------------------------------------------------
// measurements
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_measurements(state: State<AppState>, pin_id: i64) -> R<Vec<db::Measurement>> {
    with_project(&state, |conn, _| {
        db::list_measurements(conn, pin_id).map_err(s)
    })
}

#[tauri::command]
fn set_measurements(
    state: State<AppState>,
    pin_id: i64,
    list: Vec<db::Measurement>,
) -> R<Vec<db::Measurement>> {
    for m in &list {
        if !["height", "depth", "distance"].contains(&m.kind.as_str()) {
            return Err(format!("unknown measurement kind {}", m.kind));
        }
        if !m.value_cm.is_finite() || m.value_cm < 0.0 {
            return Err("a measurement must be a non-negative number".into());
        }
    }
    with_project_mut(&state, |conn, _| {
        db::set_measurements(conn, pin_id, &list).map_err(s)
    })
}

/// Everything needed to search the open project: every pin with its floor,
/// room, photo captions and counts. Fetched once when the search opens.
#[tauri::command]
fn search_context(state: State<AppState>) -> R<Vec<db::SearchHit>> {
    with_project(&state, |conn, _| db::search_context(conn).map_err(s))
}

// ---------------------------------------------------------------------------
// rulers
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_rulers(state: State<AppState>, level_id: i64) -> R<Vec<db::Ruler>> {
    with_project(&state, |conn, _| db::list_rulers(conn, level_id).map_err(s))
}

#[tauri::command]
fn add_ruler(
    state: State<AppState>,
    level_id: i64,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
) -> R<db::Ruler> {
    with_project_mut(&state, |conn, _| {
        db::add_ruler(conn, level_id, x1, y1, x2, y2).map_err(s)
    })
}

#[tauri::command]
fn restore_ruler(state: State<AppState>, ruler: db::Ruler) -> R<db::Ruler> {
    with_project_mut(&state, |conn, _| db::restore_ruler(conn, &ruler).map_err(s))
}

#[tauri::command]
fn delete_ruler(state: State<AppState>, id: i64) -> R<bool> {
    with_project_mut(&state, |conn, _| {
        Ok(db::delete_ruler(conn, id).map_err(s)? > 0)
    })
}

// ---------------------------------------------------------------------------
// rooms
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_rooms(state: State<AppState>, level_id: i64) -> R<Vec<db::Room>> {
    with_project(&state, |conn, _| db::list_rooms(conn, level_id).map_err(s))
}

#[tauri::command]
fn add_room(
    state: State<AppState>,
    level_id: i64,
    name: String,
    ceiling_cm: Option<f64>,
    x: f64,
    y: f64,
) -> R<db::Room> {
    with_project_mut(&state, |conn, _| {
        db::add_room(conn, level_id, &name, ceiling_cm, x, y).map_err(s)
    })
}

#[tauri::command]
fn update_room(
    state: State<AppState>,
    id: i64,
    name: String,
    ceiling_cm: Option<f64>,
    x: f64,
    y: f64,
) -> R<db::Room> {
    with_project_mut(&state, |conn, _| {
        db::update_room(conn, id, &name, ceiling_cm, x, y)
            .map_err(s)?
            .ok_or_else(|| format!("room {id} does not exist"))
    })
}

#[tauri::command]
fn restore_room(state: State<AppState>, room: db::Room) -> R<db::Room> {
    with_project_mut(&state, |conn, _| db::restore_room(conn, &room).map_err(s))
}

#[tauri::command]
fn delete_room(state: State<AppState>, id: i64) -> R<bool> {
    with_project_mut(&state, |conn, _| {
        Ok(db::delete_room(conn, id).map_err(s)? > 0)
    })
}

// ---------------------------------------------------------------------------
// photos
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_photos(state: State<AppState>, pin_id: i64) -> R<Vec<db::Photo>> {
    with_project(&state, |conn, dir| {
        Ok(db::list_photos(conn, pin_id)
            .map_err(s)?
            .into_iter()
            .map(|p| photos::with_files(dir, p))
            .collect())
    })
}

/// Copy the picked files into the project and attach them to the pin.
#[tauri::command]
fn add_photos(state: State<AppState>, pin_id: i64, paths: Vec<String>) -> R<Vec<db::Photo>> {
    with_project_mut(&state, |conn, dir| {
        paths
            .iter()
            .map(|p| {
                photos::add(dir, conn, pin_id, Path::new(p)).map(|ph| photos::with_files(dir, ph))
            })
            .collect()
    })
}

#[tauri::command]
fn remove_photo(state: State<AppState>, id: i64) -> R<db::Photo> {
    with_project_mut(&state, |conn, dir| {
        photos::remove(dir, conn, id).map(|p| photos::with_files(dir, p))
    })
}

#[tauri::command]
fn restore_photo(state: State<AppState>, photo: db::Photo) -> R<db::Photo> {
    with_project_mut(&state, |conn, dir| {
        photos::restore(dir, conn, &photo).map(|p| photos::with_files(dir, p))
    })
}

/// Images for the printed report, as self-contained data URIs.
#[tauri::command]
fn report_image(state: State<AppState>, path: String) -> R<String> {
    with_project(&state, |_, dir| photos::report_image(dir, &path))
}

#[tauri::command]
fn plan_image(state: State<AppState>, path: String) -> R<String> {
    with_project(&state, |_, dir| photos::plan_image(dir, &path))
}

#[tauri::command]
fn set_photo_caption(state: State<AppState>, id: i64, caption: String) -> R<db::Photo> {
    with_project_mut(&state, |conn, dir| {
        db::set_caption(conn, id, &caption)
            .map_err(s)?
            .map(|p| photos::with_files(dir, p))
            .ok_or_else(|| "photo not found".to_string())
    })
}

// ---------------------------------------------------------------------------

/// The app was called PlanFloorViewer before 0.2.0 and kept its data under
/// `com.planfloorviewer.app`. On the first launch after the rename, move that
/// projects folder into the new location so nothing the user made is lost.
/// Silent no-op once done or when there is nothing to adopt.
fn adopt_previous_data_dir(app_data: &Path, projects_dir: &Path) {
    let Some(parent) = app_data.parent() else {
        return;
    };
    let old_projects = parent.join("com.planfloorviewer.app").join("projects");
    let new_is_empty = std::fs::read_dir(projects_dir)
        .map(|mut d| d.next().is_none())
        .unwrap_or(true);
    if !old_projects.is_dir() || !new_is_empty {
        return;
    }
    if std::fs::create_dir_all(app_data).is_err() {
        return;
    }
    let _ = std::fs::remove_dir(projects_dir); // exists but empty; rename needs it absent
    match std::fs::rename(&old_projects, projects_dir) {
        Ok(()) => eprintln!("adopted projects from com.planfloorviewer.app"),
        Err(e) => eprintln!("could not adopt previous projects folder: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Runs once, before the window appears.
            //   Linux   ~/.local/share/com.restructura.app/projects/
            //   macOS   ~/Library/Application Support/com.restructura.app/projects/
            //   Windows %APPDATA%\com.restructura.app\projects\
            let app_data = app.path().app_data_dir()?;
            let projects_dir = app_data.join("projects");
            adopt_previous_data_dir(&app_data, &projects_dir);
            std::fs::create_dir_all(&projects_dir)?;

            // One-time: adopt the pre-projects database, or seed a demo on a fresh install.
            if let Some(p) = projects::migrate_legacy(&app_data, &projects_dir)? {
                eprintln!("migrated legacy database into project '{}'", p.slug);
            } else if projects::list(&projects_dir)?.is_empty() {
                projects::create_demo(&projects_dir)?;
            }

            app.manage(AppState {
                projects_dir,
                current: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            open_project,
            current_project,
            close_project,
            delete_project,
            rename_project,
            project_stats,
            export_project,
            import_project,
            projects_dir,
            set_colour_scheme,
            list_levels,
            import_plan,
            set_level_scale,
            rename_level,
            list_pins,
            add_pin,
            update_pin,
            move_pin,
            restore_pin,
            delete_pin,
            list_measurements,
            set_measurements,
            search_context,
            list_rulers,
            add_ruler,
            restore_ruler,
            delete_ruler,
            list_rooms,
            add_room,
            update_room,
            restore_room,
            delete_room,
            list_photos,
            add_photos,
            remove_photo,
            restore_photo,
            set_photo_caption,
            report_image,
            plan_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
