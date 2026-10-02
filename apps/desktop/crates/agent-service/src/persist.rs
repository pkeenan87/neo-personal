//! The data directory (`C:\ProgramData\Neo\`): small JSON files written atomically.

use std::io;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use neo_agent_core::warn::ExpectedTool;

pub const SEEN_FILE: &str = "seen.json";
pub const QUEUE_FILE: &str = "queue.json";
pub const CURSORS_FILE: &str = "cursors.json";
pub const LISTS_FILE: &str = "lists.json";
pub const META_FILE: &str = "agent.json";

#[derive(Debug, Clone)]
pub struct DataDir {
    root: PathBuf,
}

impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        DataDir { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    /// Where downloaded updates are staged (inside the protected data directory, so a user cannot
    /// swap the MSI between verification and install).
    pub fn updates_dir(&self) -> PathBuf {
        self.root.join("updates")
    }

    /// Creates the directory and `logs/`. On unix they are created `0700` (the macOS data directory
    /// is root-only; `perms::secure_data_dir` locks the root down before anything is put in it).
    pub fn ensure(&self) -> io::Result<()> {
        create_private_dirs(&self.root)?;
        create_private_dirs(&self.logs_dir())
    }

    pub fn read_bytes(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        match std::fs::read(self.root.join(name)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn read_string(&self, name: &str) -> Option<String> {
        self.read_bytes(name).ok().flatten().and_then(|b| String::from_utf8(b).ok())
    }

    pub fn write_atomic_bytes(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        create_private_dirs(&self.root)?;
        let tmp = self.root.join(format!("{name}.tmp"));
        write_private(&tmp, bytes)?;
        std::fs::rename(&tmp, self.root.join(name))
    }

    /// Unix: makes `name` owner-only (`0600`) if it is not. Used for `device.json`, which an old
    /// build or a careless copy may have left more open.
    pub fn enforce_private(&self, name: &str) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = self.root.join(name);
            if let Ok(m) = std::fs::metadata(&path)
                && m.permissions().mode() & 0o077 != 0
            {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
        #[cfg(not(unix))]
        let _ = name;
    }

    pub fn write_atomic(&self, name: &str, text: &str) -> io::Result<()> {
        self.write_atomic_bytes(name, text.as_bytes())
    }

    pub fn remove(&self, name: &str) -> io::Result<()> {
        match std::fs::remove_file(self.root.join(name)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    pub fn read_json<T: DeserializeOwned + Default>(&self, name: &str) -> T {
        self.read_string(name)
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn write_json<T: Serialize>(&self, name: &str, value: &T) -> io::Result<()> {
        let text = serde_json::to_string(value).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.write_atomic(name, &text)
    }
}

/// Creates `path` and its parents; on unix new directories are `0700`.
fn create_private_dirs(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// Writes `bytes` to `path`; on unix the file is created `0600`.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// `agent.json`: non-secret agent state. Names are shown in the tray; nothing here is sent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Meta {
    /// Server the device is (or was last) enrolled with. Empty = the build default.
    pub base_url: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub household_name: Option<String>,
    pub member_name: Option<String>,
    pub owner_name: Option<String>,
    /// The next full scan is the post-enrollment baseline.
    pub discovery_pending: bool,
    /// The server said 401: the token was cleared and detection stopped.
    pub disconnected: bool,
    /// Unix seconds.
    pub last_heartbeat: Option<i64>,
    pub last_warning: Option<i64>,
    pub lists_version: Option<String>,
    pub lists_etag: Option<String>,
    pub expected_tools: Vec<ExpectedTool>,
    /// Newest version seen in the update manifest that this build has not installed.
    pub update_available: Option<String>,
    /// macOS: unix seconds of the last time the daemon exited so that launchd would relaunch it to
    /// pick up a new Full Disk Access grant (a grant is only visible to a process started after it).
    pub fda_relaunch_at: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_json_round_trip_and_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = DataDir::new(tmp.path().join("Neo"));
        let m: Meta = dir.read_json(META_FILE);
        assert_eq!(m, Meta::default());
        let m = Meta {
            device_name: Some("PC".into()),
            discovery_pending: true,
            ..Meta::default()
        };
        dir.write_json(META_FILE, &m).unwrap();
        assert_eq!(dir.read_json::<Meta>(META_FILE), m);
        assert!(!dir.root().join("agent.json.tmp").exists());
        std::fs::write(dir.root().join(META_FILE), "{broken").unwrap();
        assert_eq!(dir.read_json::<Meta>(META_FILE), Meta::default());
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only_and_loose_ones_are_tightened() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let tmp = tempfile::tempdir().unwrap();
        let dir = DataDir::new(tmp.path().join("data"));
        dir.ensure().unwrap();
        dir.write_atomic("device.json", "{}").unwrap();
        assert_eq!(mode(dir.root()), 0o700);
        assert_eq!(mode(&dir.logs_dir()), 0o700);
        assert_eq!(mode(&dir.root().join("device.json")), 0o600);
        std::fs::set_permissions(dir.root().join("device.json"), std::fs::Permissions::from_mode(0o644)).unwrap();
        dir.enforce_private("device.json");
        assert_eq!(mode(&dir.root().join("device.json")), 0o600);
        dir.enforce_private("missing.json");
    }
}
