//! Projects: one self-contained folder per home / renovation.
//!
//! ```text
//! <app data>/projects/<slug>/
//! ├── project.json   manifest — name, schemaVersion, colourScheme, timestamps
//! ├── plan.db        this project's SQLite database
//! ├── plans/         plan images, one per level
//! └── photos/        photos, one sub-folder per pin
//! ```
//!
//! Everything the database stores about files is a path RELATIVE to the
//! project folder, so a project zipped on one machine opens unchanged on
//! another. Export is therefore just "zip the folder"; import is "unzip it".
//!
//! Errors are plain `String`s throughout this module: every failure here is
//! something the user should simply be shown ("could not create folder …").

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::db;

/// Bumped whenever the database schema or manifest layout changes, so an old
/// export can be recognised and migrated instead of failing mysteriously.
pub const SCHEMA_VERSION: u32 = 1;

/// The sample plan, compiled into the binary so a fresh install has something to show.
const DEMO_PLAN_PNG: &[u8] = include_bytes!("../../src/public/assets/demo-plan.png");

type R<T> = Result<T, String>;
fn io_err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{what}: {e}")
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub schema_version: u32,
    /// "it" (Italian / European conduit colours) or "apwa".
    #[serde(default = "default_scheme")]
    pub colour_scheme: String,
    pub created_at: String,
    pub modified_at: String,
}
fn default_scheme() -> String {
    "it".into()
}

/// What the frontend sees in the project chooser.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub slug: String,
    pub name: String,
    pub colour_scheme: String,
    pub created_at: String,
    pub modified_at: String,
    pub dir: String,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn read_manifest(dir: &Path) -> R<Manifest> {
    let text =
        fs::read_to_string(dir.join("project.json")).map_err(io_err("reading project.json"))?;
    serde_json::from_str(&text).map_err(io_err("parsing project.json"))
}

pub fn write_manifest(dir: &Path, m: &Manifest) -> R<()> {
    let text = serde_json::to_string_pretty(m).map_err(io_err("serialising manifest"))?;
    fs::write(dir.join("project.json"), text).map_err(io_err("writing project.json"))
}

/// Record that something in the project changed (shown in the chooser).
pub fn touch(dir: &Path) -> R<()> {
    let mut m = read_manifest(dir)?;
    m.modified_at = now();
    write_manifest(dir, &m)
}

pub fn info(dir: &Path) -> R<ProjectInfo> {
    let m = read_manifest(dir)?;
    Ok(ProjectInfo {
        slug: dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        name: m.name,
        colour_scheme: m.colour_scheme,
        created_at: m.created_at,
        modified_at: m.modified_at,
        dir: dir.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

/// "Via Monte Giordano int. 11" -> "via-monte-giordano-int-11".
/// Only used for the folder and the zip file name; the user sees the real name.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = true; // suppress a leading dash
    for ch in name.chars() {
        let c = ch.to_lowercase().next().unwrap_or(ch);
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "project".to_string()
    } else {
        out
    }
}

/// Keep slugs unique inside the projects directory: name, name-2, name-3, …
pub fn unique_slug(root: &Path, base: &str) -> String {
    if !root.join(base).exists() {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|s| !root.join(s).exists())
        .unwrap()
}

// ---------------------------------------------------------------------------
// listing / creating
// ---------------------------------------------------------------------------

pub fn list(root: &Path) -> R<Vec<ProjectInfo>> {
    fs::create_dir_all(root).map_err(io_err("creating projects directory"))?;
    let mut out = Vec::new();
    for entry in fs::read_dir(root).map_err(io_err("listing projects"))? {
        let entry = entry.map_err(io_err("listing projects"))?;
        let dir = entry.path();
        if dir.is_dir() && dir.join("project.json").is_file() {
            match info(&dir) {
                Ok(i) => out.push(i),
                Err(e) => eprintln!("skipping {}: {e}", dir.display()), // a broken folder must not hide the others
            }
        }
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at)); // most recent first
    Ok(out)
}

/// Make the folder, sub-folders, manifest and an empty database.
pub fn create(root: &Path, name: &str) -> R<ProjectInfo> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a project needs a name".into());
    }
    let slug = unique_slug(root, &slugify(name));
    let dir = root.join(&slug);
    fs::create_dir_all(dir.join("plans")).map_err(io_err("creating project folder"))?;
    fs::create_dir_all(dir.join("photos")).map_err(io_err("creating project folder"))?;
    let ts = now();
    write_manifest(
        &dir,
        &Manifest {
            name: name.to_string(),
            schema_version: SCHEMA_VERSION,
            colour_scheme: default_scheme(),
            created_at: ts.clone(),
            modified_at: ts,
        },
    )?;
    db::open(&dir.join("plan.db")).map_err(io_err("creating database"))?; // creates the schema
    info(&dir)
}

/// The project a fresh install opens with: the sample plan and one example pin.
pub fn create_demo(root: &Path) -> R<ProjectInfo> {
    let p = create(root, "Demo plan")?;
    let dir = PathBuf::from(&p.dir);
    fs::write(dir.join("plans/demo-plan.png"), DEMO_PLAN_PNG)
        .map_err(io_err("writing demo plan"))?;
    let conn = db::open(&dir.join("plan.db")).map_err(io_err("opening database"))?;
    db::seed_demo(&conn, "plans/demo-plan.png").map_err(io_err("seeding demo"))?;
    Ok(p)
}

/// Before projects existed the app kept one `plan.db` at the top of the app
/// data directory. Move it into a proper "Demo plan" project so nothing the
/// user entered is lost. Runs once; a no-op afterwards.
pub fn migrate_legacy(app_data: &Path, root: &Path) -> R<Option<ProjectInfo>> {
    let legacy = app_data.join("plan.db");
    if !legacy.is_file() {
        return Ok(None);
    }
    let slug = unique_slug(root, "demo-plan");
    let dir = root.join(&slug);
    fs::create_dir_all(dir.join("plans")).map_err(io_err("creating project folder"))?;
    fs::create_dir_all(dir.join("photos")).map_err(io_err("creating project folder"))?;

    // Fold any unflushed WAL pages into the main file, then move the database.
    {
        let c = Connection::open(&legacy).map_err(io_err("opening legacy database"))?;
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(io_err("checkpointing"))?;
    }
    fs::rename(&legacy, dir.join("plan.db")).map_err(io_err("moving legacy database"))?;
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(app_data.join(format!("plan.db{suffix}")));
    }
    fs::write(dir.join("plans/demo-plan.png"), DEMO_PLAN_PNG)
        .map_err(io_err("writing demo plan"))?;

    // The old level pointed at the bundled asset; point it at the project's own copy.
    let conn = db::open(&dir.join("plan.db")).map_err(io_err("opening database"))?;
    conn.execute(
        "UPDATE levels SET image_path = 'plans/demo-plan.png' WHERE image_path = 'assets/demo-plan.png'",
        [],
    )
    .map_err(io_err("updating level paths"))?;

    let ts = now();
    write_manifest(
        &dir,
        &Manifest {
            name: "Demo plan".into(),
            schema_version: SCHEMA_VERSION,
            colour_scheme: default_scheme(),
            created_at: ts.clone(),
            modified_at: ts,
        },
    )?;
    info(&dir).map(Some)
}

/// Change a project's display name. The folder and its slug stay as they are:
/// the slug is the project's identity, referenced by the last-opened setting and
/// by any zip already exported.
pub fn rename(root: &Path, slug: &str, name: &str) -> R<ProjectInfo> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a project needs a name".into());
    }
    let dir = root.join(slug);
    let mut m = read_manifest(&dir)?;
    m.name = name.to_string();
    m.modified_at = now();
    write_manifest(&dir, &m)?;
    info(&dir)
}

/// Counts and disk usage, for the project summary in Settings.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStats {
    pub levels: i64,
    pub pins: i64,
    pub photos: i64,
    pub rooms: i64,
    pub bytes: u64,
}

pub fn stats(dir: &Path, conn: &Connection) -> R<ProjectStats> {
    let count = |sql: &str| -> R<i64> {
        conn.query_row(sql, [], |r| r.get(0))
            .map_err(io_err("counting"))
    };
    Ok(ProjectStats {
        levels: count("SELECT COUNT(*) FROM levels")?,
        pins: count("SELECT COUNT(*) FROM pins")?,
        photos: count("SELECT COUNT(*) FROM photos")?,
        rooms: count("SELECT COUNT(*) FROM rooms")?,
        bytes: dir_size(dir),
    })
}

/// Total bytes under `dir`. Unreadable entries are skipped rather than failing:
/// a size readout must never stop the screen from opening.
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .map(|e| match e.file_type() {
            Ok(ft) if ft.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/// Remove a project. The folder goes to the operating system's trash / recycle
/// bin rather than being erased, so a mistaken delete is recoverable.
pub fn delete(root: &Path, slug: &str) -> R<()> {
    let dir = root.join(slug);
    if !dir.join("project.json").is_file() {
        return Err(format!("{slug} is not a project"));
    }
    trash::delete(&dir).map_err(io_err("moving project to trash"))
}

// ---------------------------------------------------------------------------
// plan images
// ---------------------------------------------------------------------------

/// Copy an image the user picked into `plans/` and register it as a level.
/// Returns the new level. The stored path is relative ("plans/kitchen.png").
pub fn import_plan(dir: &Path, conn: &Connection, src: &Path, level_name: &str) -> R<db::Level> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
        return Err(format!("unsupported image type .{ext} — use PNG or JPEG"));
    }
    let base = slugify(level_name);
    let mut file = format!("{base}.{ext}");
    let mut n = 2;
    while dir.join("plans").join(&file).exists() {
        file = format!("{base}-{n}.{ext}");
        n += 1;
    }
    fs::copy(src, dir.join("plans").join(&file)).map_err(io_err("copying plan image"))?;
    let rel = format!("plans/{file}");
    let order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM levels",
            [],
            |r| r.get(0),
        )
        .map_err(io_err("reading levels"))?;
    conn.execute(
        "INSERT INTO levels (name, image_path, sort_order) VALUES (?1, ?2, ?3)",
        params![level_name.trim(), rel, order],
    )
    .map_err(io_err("inserting level"))?;
    let id = conn.last_insert_rowid();
    db::get_level(conn, id)
        .map_err(io_err("reading level"))?
        .ok_or_else(|| "level vanished".to_string())
}

// ---------------------------------------------------------------------------
// export / import (plain zip of the folder)
// ---------------------------------------------------------------------------

pub fn export_zip(dir: &Path, dest: &Path) -> R<()> {
    // Make sure plan.db alone holds everything (WAL pages folded in), then skip -wal/-shm.
    {
        let c = Connection::open(dir.join("plan.db")).map_err(io_err("opening database"))?;
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(io_err("checkpointing"))?;
    }
    let file = File::create(dest).map_err(io_err("creating zip"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    fn walk(
        zip: &mut zip::ZipWriter<File>,
        opts: zip::write::SimpleFileOptions,
        root: &Path,
        cur: &Path,
    ) -> R<()> {
        for entry in fs::read_dir(cur).map_err(io_err("reading folder"))? {
            let path = entry.map_err(io_err("reading folder"))?.path();
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if name == ".trash" || name.starts_with(".trash/") {
                continue;
            } // removed photos stay behind
            if path.is_dir() {
                zip.add_directory(format!("{name}/"), opts)
                    .map_err(io_err("zip"))?;
                walk(zip, opts, root, &path)?;
            } else if !(name.ends_with("plan.db-wal")
                || name.ends_with("plan.db-shm")
                || name.ends_with(".bak"))
            {
                zip.start_file(&name, opts).map_err(io_err("zip"))?;
                let mut f = File::open(&path).map_err(io_err("reading file"))?;
                io::copy(&mut f, zip).map_err(io_err("zip"))?;
            }
        }
        Ok(())
    }
    walk(&mut zip, opts, dir, dir)?;
    zip.finish().map_err(io_err("finishing zip"))?;
    Ok(())
}

/// Unpack a project zip into the projects directory under a fresh slug.
/// Accepts both a zip of the folder's contents and a zip that wraps them in
/// one top-level folder (what most "compress this folder" tools produce).
pub fn import_zip(root: &Path, zip_path: &Path) -> R<ProjectInfo> {
    let file = File::open(zip_path).map_err(io_err("opening zip"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(io_err("reading zip"))?;

    // Find project.json; whatever precedes it is the prefix to strip.
    let manifest_entry = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .find(|n| n == "project.json" || n.ends_with("/project.json"))
        .ok_or("this zip does not contain a project (no project.json)")?;
    let prefix = manifest_entry.trim_end_matches("project.json").to_string();

    let manifest: Manifest = {
        let mut f = archive
            .by_name(&manifest_entry)
            .map_err(io_err("reading manifest"))?;
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(io_err("reading manifest"))?;
        serde_json::from_str(&s).map_err(io_err("parsing manifest"))?
    };
    if manifest.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "this project was made with a newer version of the app (schema {} > {})",
            manifest.schema_version, SCHEMA_VERSION
        ));
    }

    let slug = unique_slug(root, &slugify(&manifest.name));
    let dir = root.join(&slug);
    fs::create_dir_all(&dir).map_err(io_err("creating project folder"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(io_err("reading zip"))?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        }; // refuses "../" tricks
        let rel = rel.to_string_lossy().replace('\\', "/");
        let Some(rel) = rel.strip_prefix(&prefix) else {
            continue;
        };
        if rel.is_empty()
            || rel.ends_with("plan.db-wal")
            || rel.ends_with("plan.db-shm")
            || rel.starts_with(".trash/")
        {
            continue;
        }
        let out = dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(io_err("creating folder"))?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(io_err("creating folder"))?;
            }
            let mut f = File::create(&out).map_err(io_err("writing file"))?;
            io::copy(&mut entry, &mut f).map_err(io_err("writing file"))?;
            f.flush().map_err(io_err("writing file"))?;
        }
    }
    fs::create_dir_all(dir.join("plans")).map_err(io_err("creating folder"))?;
    fs::create_dir_all(dir.join("photos")).map_err(io_err("creating folder"))?;
    // Future: run schema migrations here when manifest.schema_version < SCHEMA_VERSION.
    info(&dir)
}
