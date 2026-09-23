//! A plain-text error log that a user can find and send to the developer.
//!
//! On Windows and macOS a desktop app has no console, so anything that goes wrong
//! (a failed command, a JavaScript error, a crash) is written here instead. It sits
//! in each system's usual place for logs:
//!   Linux   ~/.local/share/com.restructura.app/logs/restructura.log
//!   macOS   ~/Library/Logs/com.restructura.app/restructura.log
//!   Windows %LOCALAPPDATA%\com.restructura.app\logs\restructura.log
//!
//! Deliberately tiny (no logging framework): one file, one line per event, and when
//! it passes 1 MB the previous file is kept as restructura.old.log and a new one begins.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PATH: OnceLock<PathBuf> = OnceLock::new();
const MAX_BYTES: u64 = 1_000_000;

/// Open (or start) the log in `dir` and record crashes in it too.
pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    let path = dir.join("restructura.log");
    if fs::metadata(&path)
        .map(|m| m.len() > MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::rename(&path, dir.join("restructura.old.log"));
    }
    let _ = PATH.set(path);
    write(
        "INFO",
        "app",
        &format!(
            "ReStructura {} started on {} {}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );
    // A panic aborts the app (release builds): write it down first.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write("PANIC", "rust", &info.to_string());
        previous(info);
    }));
}

pub fn path() -> Option<&'static PathBuf> {
    PATH.get()
}

/// Append one event. Never fails loudly: a log that cannot be written must not
/// become a second error.
pub fn write(level: &str, source: &str, message: &str) {
    let line = format!(
        "{} {level:<5} [{source}] {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        message.trim_end().replace('\n', "\n    ")
    );
    eprint!("{line}");
    if let Some(p) = PATH.get() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}
