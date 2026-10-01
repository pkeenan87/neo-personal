//! Inputs from the operating system. The service turns Windows state into these structs and calls
//! [`crate::detect::detect`]; nothing here touches the OS, and everything is JSON-serializable so
//! tests and the `simulate` example can replay fixtures.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::lists::PathEnv;

/// One running process.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    /// File name, e.g. `AnyDesk.exe`.
    pub image_name: String,
    /// Full image path. Used to find the process again; never sent anywhere.
    pub image_path: String,
    /// Authenticode signer subject, `None` when unsigned, untrusted or not checked yet.
    #[serde(default)]
    pub signer: Option<String>,
}

/// One uninstall registry entry (`DisplayName`, `Publisher`, ...).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UninstallEntry {
    pub display_name: String,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub install_location: Option<String>,
    #[serde(default)]
    pub display_icon: Option<String>,
    /// Which hive it came from (`HKLM64`, `HKLM32`, `HKU:<sid>`). Not used for matching.
    #[serde(default)]
    pub hive: String,
}

/// One Windows service.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceInfo {
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub binary_path: String,
}

/// New complete lines read from a session log (see [`crate::state::Cursors`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogChunk {
    /// The path that was read, as returned by `CompiledLists::log_targets`.
    pub path: String,
    pub lines: Vec<String>,
}

/// One event-log record since the last bookmark.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventLogRecord {
    pub channel: String,
    pub event_id: u32,
    #[serde(with = "time::serde::rfc3339")]
    pub time: OffsetDateTime,
}

/// Facts about a program's main executable, computed by the service for a new program (see
/// [`crate::detect::exe_hints`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExeFacts {
    pub path: String,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
    /// Authenticode signature present and trusted.
    pub signed_trusted: bool,
    #[serde(default)]
    pub signer: Option<String>,
}

/// Everything the service observed in one pass. Sources are polled at different intervals, so any
/// vector may be empty.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub processes: Vec<ProcessInfo>,
    #[serde(default)]
    pub uninstall_entries: Vec<UninstallEntry>,
    #[serde(default)]
    pub services: Vec<ServiceInfo>,
    #[serde(default)]
    pub log_chunks: Vec<LogChunk>,
    #[serde(default)]
    pub event_records: Vec<EventLogRecord>,
    #[serde(default)]
    pub exe_facts: Vec<ExeFacts>,
    /// Expansion environment for session log paths.
    #[serde(default)]
    pub env: PathEnv,
}
