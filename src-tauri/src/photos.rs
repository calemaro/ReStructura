//! Photo files inside a project.
//!
//! ```text
//! <project>/photos/<pinId>/<timestamp>-<name>.jpg          the copied original
//! <project>/photos/<pinId>/thumbs/<timestamp>-<name>.jpg   ~400 px thumbnail
//! <project>/.trash/photos/...                              removed photos (undo, recovery)
//! ```
//! Originals are copied, never referenced where they came from, so a project
//! stays self-contained. Thumbnails exist because phone photos are 4–12 MB
//! each and a panel of ten must not decode 100 MB to draw a strip.

use std::fs;
use std::path::Path;

use chrono::Local;
use rusqlite::Connection;

use crate::db;

type R<T> = Result<T, String>;
fn err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ { move |e| format!("{what}: {e}") }

const THUMB_PX: u32 = 400;
const ALLOWED: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

/// "IMG_2041.JPG" -> "img-2041"
fn stem_slug(src: &Path) -> String {
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
    let s = crate::projects::slugify(stem);
    if s.is_empty() { "photo".into() } else { s }
}

/// Copy one image into the project, make its thumbnail, record the row.
pub fn add(dir: &Path, conn: &Connection, pin_id: i64, src: &Path) -> R<db::Photo> {
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !ALLOWED.contains(&ext.as_str()) {
        return Err(format!("unsupported image type .{ext} — use JPEG, PNG or WebP"));
    }
    let folder = dir.join("photos").join(pin_id.to_string());
    fs::create_dir_all(folder.join("thumbs")).map_err(err("creating photo folder"))?;

    let stamp = Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let base = format!("{stamp}-{}", stem_slug(src));
    let mut name = format!("{base}.{ext}");
    let mut n = 2;
    while folder.join(&name).exists() { name = format!("{base}-{n}.{ext}"); n += 1; }

    fs::copy(src, folder.join(&name)).map_err(err("copying photo"))?;

    // Thumbnail: decode once, shrink so the longer side is THUMB_PX, save as JPEG.
    let thumb_name = format!("{}.jpg", name.rsplit_once('.').map(|(a, _)| a).unwrap_or(&name));
    let img = image::open(folder.join(&name)).map_err(err("reading image"))?;
    let thumb = img.thumbnail(THUMB_PX, THUMB_PX);
    thumb.to_rgb8().save_with_format(folder.join("thumbs").join(&thumb_name), image::ImageFormat::Jpeg)
        .map_err(err("writing thumbnail"))?;

    let rel = format!("photos/{pin_id}/{name}");
    let rel_thumb = format!("photos/{pin_id}/thumbs/{thumb_name}");
    db::insert_photo(conn, pin_id, &rel, &rel_thumb).map_err(err("recording photo"))
}

/// Move a photo's files into the project's .trash (recoverable), remove the row.
pub fn remove(dir: &Path, conn: &Connection, id: i64) -> R<db::Photo> {
    let photo = db::get_photo(conn, id).map_err(err("reading photo"))?.ok_or("photo not found")?;
    for rel in [&photo.file_path, &photo.thumb_path] {
        if rel.is_empty() { continue; }
        let from = dir.join(rel);
        let to = dir.join(".trash").join(rel);
        if from.exists() {
            if let Some(parent) = to.parent() { fs::create_dir_all(parent).map_err(err("creating trash folder"))?; }
            fs::rename(&from, &to).map_err(err("moving photo to trash"))?;
        }
    }
    db::delete_photo_row(conn, id).map_err(err("removing photo"))?;
    Ok(photo)
}

/// Undo of `remove`: move the files back and re-insert the row with its old id.
pub fn restore(dir: &Path, conn: &Connection, photo: &db::Photo) -> R<db::Photo> {
    for rel in [&photo.file_path, &photo.thumb_path] {
        if rel.is_empty() { continue; }
        let from = dir.join(".trash").join(rel);
        let to = dir.join(rel);
        if from.exists() {
            if let Some(parent) = to.parent() { fs::create_dir_all(parent).map_err(err("creating photo folder"))?; }
            fs::rename(&from, &to).map_err(err("restoring photo"))?;
        }
    }
    db::restore_photo(conn, photo).map_err(err("restoring photo row"))
}

/// Fill in absolute paths for display on this machine.
pub fn with_files(dir: &Path, mut p: db::Photo) -> db::Photo {
    p.file = dir.join(&p.file_path).display().to_string();
    p.thumb = if p.thumb_path.is_empty() { p.file.clone() } else { dir.join(&p.thumb_path).display().to_string() };
    p
}


