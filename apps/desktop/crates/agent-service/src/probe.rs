//! What the service needs from the operating system. The Windows implementation is in
//! `windows::probe`; [`DevProbe`] replays a [`Snapshot`] JSON file for development on Linux.

use std::io;
use std::path::PathBuf;

use neo_agent_core::detect::ExeHint;
use neo_agent_core::lists::PathEnv;
use neo_agent_core::snapshot::{
    AppBundle, EventLogRecord, ExeFacts, ProcessInfo, ServiceInfo, Snapshot, TccSnapshot, UnifiedLogRecord, UninstallEntry,
};

/// Size and identity of a file (for the log cursors).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStat {
    pub len: u64,
    /// Changes when the file is replaced (creation time or file index).
    pub token: Option<String>,
}

pub trait SystemProbe: Send + Sync {
    /// The computer name (default device name).
    fn computer_name(&self) -> String;
    /// Expansion environment for session-log paths, including every profile's `%AppData%`.
    fn path_env(&self) -> PathEnv;
    /// Running processes, with `signer` filled in (cached by path, size and mtime).
    fn processes(&self) -> Vec<ProcessInfo>;
    fn uninstall_entries(&self) -> Vec<UninstallEntry>;
    fn services(&self) -> Vec<ServiceInfo>;
    fn file_stat(&self, path: &str) -> Option<FileStat>;
    fn read_range(&self, path: &str, start: u64, len: u64) -> io::Result<Vec<u8>>;
    /// Records in `channel` with one of `event_ids`, newer than `since_unix`.
    fn event_records(&self, channel: &str, event_ids: &[u32], since_unix: i64) -> Vec<EventLogRecord>;
    /// Hashes and signature-checks the main executables named by `hints` (only those the agent
    /// asked about, i.e. files inside a newly appeared program's own install location).
    fn exe_facts(&self, hints: &[ExeHint]) -> Vec<ExeFacts>;

    // ---- macOS. Defaults for the platforms that have nothing to report. ----------------------

    /// `windows`, `macos` or `linux` (development).
    fn platform(&self) -> &'static str {
        "windows"
    }
    /// Installed `.app` bundles with their code-signing facts.
    fn app_bundles(&self) -> Vec<AppBundle> {
        Vec::new()
    }
    /// Hashes and signature-checks the main executables of the bundles at `paths`.
    fn bundle_exe_facts(&self, _paths: &[String]) -> Vec<ExeFacts> {
        Vec::new()
    }
    /// Unified-log entries for the validated `predicates` over the last minute.
    fn unified_log(&self, _predicates: &[String]) -> Vec<UnifiedLogRecord> {
        Vec::new()
    }
    /// Whether the service can read the TCC database (Full Disk Access). `None` = not a macOS
    /// probe or unknown. Cheap: opens the system database and looks at the error.
    fn full_disk_access(&self) -> Option<bool> {
        None
    }
    /// Every TCC database that could be read now. `None` = nothing readable or the schema was not
    /// understood (state is then left alone).
    fn tcc(&self) -> Option<TccSnapshot> {
        None
    }
}

/// Linux development probe: reads a [`Snapshot`] from a JSON file on every call (edit the file to
/// "install" something). Logs and event records are not simulated.
pub struct DevProbe {
    pub snapshot_file: Option<PathBuf>,
}

impl DevProbe {
    fn snapshot(&self) -> Snapshot {
        self.snapshot_file
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}

impl SystemProbe for DevProbe {
    fn computer_name(&self) -> String {
        std::env::var("HOSTNAME").unwrap_or_else(|_| "DEV-COMPUTER".to_string())
    }
    fn path_env(&self) -> PathEnv {
        self.snapshot().env
    }
    fn processes(&self) -> Vec<ProcessInfo> {
        self.snapshot().processes
    }
    fn uninstall_entries(&self) -> Vec<UninstallEntry> {
        self.snapshot().uninstall_entries
    }
    fn services(&self) -> Vec<ServiceInfo> {
        self.snapshot().services
    }
    fn file_stat(&self, _path: &str) -> Option<FileStat> {
        None
    }
    fn read_range(&self, _path: &str, _start: u64, _len: u64) -> io::Result<Vec<u8>> {
        Err(io::Error::new(io::ErrorKind::NotFound, "not simulated"))
    }
    fn event_records(&self, _channel: &str, _ids: &[u32], _since: i64) -> Vec<EventLogRecord> {
        Vec::new()
    }
    fn exe_facts(&self, _hints: &[ExeHint]) -> Vec<ExeFacts> {
        self.snapshot().exe_facts
    }
    fn platform(&self) -> &'static str {
        "linux"
    }
    fn app_bundles(&self) -> Vec<AppBundle> {
        self.snapshot().app_bundles
    }
    fn unified_log(&self, _predicates: &[String]) -> Vec<UnifiedLogRecord> {
        self.snapshot().unified_log_records
    }
    fn full_disk_access(&self) -> Option<bool> {
        self.snapshot().tcc.is_some().then_some(true)
    }
    fn tcc(&self) -> Option<TccSnapshot> {
        self.snapshot().tcc
    }
}
