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

    pub fn ensure(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.root)?;
        std::fs::create_dir_all(self.logs_dir())
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
        std::fs::create_dir_all(&self.root)?;
        let tmp = self.root.join(format!("{name}.tmp"));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, self.root.join(name))
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
}
