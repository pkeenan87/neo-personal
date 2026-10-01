//! A small file logger: `logs\neo-agent-YYYY-MM-DD.log`, files older than 7 days are deleted.
//! Messages carry event types and tool ids only; nothing logs paths from user folders or tokens.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use log::{LevelFilter, Log, Metadata, Record};
use time::OffsetDateTime;

/// Log files older than this many days are removed.
pub const KEEP_DAYS: i64 = 7;

pub struct FileLogger {
    dir: PathBuf,
    state: Mutex<Option<(String, File)>>,
    also_stderr: bool,
}

fn day_stamp(t: OffsetDateTime) -> String {
    format!("{:04}-{:02}-{:02}", t.year(), t.month() as u8, t.day())
}

impl FileLogger {
    /// Installs the logger. `also_stderr` is for `--console`.
    pub fn init(dir: &Path, also_stderr: bool) {
        let _ = std::fs::create_dir_all(dir);
        prune(dir, OffsetDateTime::now_utc());
        let logger = FileLogger {
            dir: dir.to_path_buf(),
            state: Mutex::new(None),
            also_stderr,
        };
        if log::set_boxed_logger(Box::new(logger)).is_ok() {
            log::set_max_level(LevelFilter::Info);
        }
    }
}

impl Log for FileLogger {
    fn enabled(&self, m: &Metadata) -> bool {
        m.level() <= LevelFilter::Info
    }

    fn log(&self, r: &Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let now = OffsetDateTime::now_utc();
        let line = format!(
            "{} {:5} {}\n",
            now.format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
            r.level(),
            r.args()
        );
        if self.also_stderr {
            eprint!("{line}");
        }
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let stamp = day_stamp(now);
        if st.as_ref().is_none_or(|(d, _)| *d != stamp) {
            prune(&self.dir, now);
            *st = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(format!("neo-agent-{stamp}.log")))
                .ok()
                .map(|f| (stamp, f));
        }
        if let Some((_, f)) = st.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {}
}

/// Deletes `neo-agent-*.log` files older than [`KEEP_DAYS`].
pub fn prune(dir: &Path, now: OffsetDateTime) {
    let cutoff = day_stamp(now - time::Duration::days(KEEP_DAYS));
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(stamp) = name.strip_prefix("neo-agent-").and_then(|s| s.strip_suffix(".log"))
            && stamp < cutoff.as_str()
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_removes_only_old_agent_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let now = time::macros::datetime!(2026-10-10 12:00 UTC);
        for n in [
            "neo-agent-2026-10-01.log",
            "neo-agent-2026-10-03.log",
            "neo-agent-2026-10-09.log",
            "other.txt",
        ] {
            std::fs::write(tmp.path().join(n), "x").unwrap();
        }
        prune(tmp.path(), now);
        let mut left: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left, vec!["neo-agent-2026-10-03.log", "neo-agent-2026-10-09.log", "other.txt"]);
    }
}
