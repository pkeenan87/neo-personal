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
    /// macOS: the signing Team ID of the process's bundle or executable. `None` when unsigned,
    /// ad-hoc signed, Apple's own, or not checked yet.
    #[serde(default)]
    pub team_id: Option<String>,
    /// macOS: `CFBundleIdentifier` of the bundle the process runs from (after resolving App
    /// Translocation), when it runs from one.
    #[serde(default)]
    pub bundle_id: Option<String>,
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

/// One macOS `.app` bundle (the counterpart of [`UninstallEntry`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppBundle {
    /// Bundle path. Used to find the executable again; never sent anywhere.
    pub path: String,
    #[serde(default)]
    pub bundle_id: Option<String>,
    /// `CFBundleName` (display name).
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    /// Developer ID Team ID; `None` when unsigned, ad-hoc signed or Apple's own.
    #[serde(default)]
    pub team_id: Option<String>,
    /// Code-signing identifier. Apple-signed apps have `com.apple.*` here and no `team_id`; the
    /// service must report it only after the signature validated (see [`AppBundle::is_apple`]).
    #[serde(default)]
    pub signing_id: Option<String>,
    /// Signer name from the certificate chain (`Authority=Developer ID Application: <Name> (<ID>)`
    /// without the prefix and Team ID), for matching `pupPublishers`.
    #[serde(default)]
    pub signer: Option<String>,
}

impl AppBundle {
    /// Apple platform software (including App Store apps signed by Apple): no Team ID and a
    /// `com.apple.` signing identifier. Never reported as `unsigned_unknown`.
    pub fn is_apple(&self) -> bool {
        self.team_id.is_none() && self.signing_id.as_deref().is_some_and(|s| s.starts_with("com.apple."))
    }
}

/// One TCC `access` row (`kTCC...` service), read from the system or a user database.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TccRow {
    /// `"system"` or `"user:<uid>"`.
    pub db: String,
    pub service: String,
    pub client: String,
    /// 0 = bundle id, 1 = absolute path.
    pub client_type: i64,
    /// 2 = allowed.
    pub auth_value: i64,
}

/// One unified-log entry returned for a `unifiedlog` evidence predicate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnifiedLogRecord {
    /// The predicate that was queried, exactly as returned by `CompiledLists::unifiedlog_targets`.
    pub predicate: String,
    pub message: String,
    #[serde(with = "time::serde::rfc3339")]
    pub time: OffsetDateTime,
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
    /// macOS: the bundle path or its main executable (anything under the bundle path matches).
    pub path: String,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
    /// Authenticode signature present and trusted (macOS: a valid Developer ID signature).
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
    /// macOS: installed `.app` bundles.
    #[serde(default)]
    pub app_bundles: Vec<AppBundle>,
    /// macOS: unified-log entries for the verified `unifiedlog` evidence.
    #[serde(default)]
    pub unified_log_records: Vec<UnifiedLogRecord>,
    /// macOS: every readable TCC row. `None` = not readable (no Full Disk Access) or the schema
    /// was not understood; detection state is then left untouched.
    #[serde(default)]
    pub tcc: Option<Vec<TccRow>>,
    /// Expansion environment for session log paths.
    #[serde(default)]
    pub env: PathEnv,
}
