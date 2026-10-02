//! The device token store: `device.bin`. On Windows the file is protected with DPAPI at machine
//! scope; the tray app never reads it (it has no access to the data directory).

use std::io;

use serde::{Deserialize, Serialize};

use crate::persist::DataDir;

/// What `device.bin` holds. The token is bound to the server that issued it.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credentials {
    pub token: String,
    pub base_url: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("token", &"<redacted>")
            .field("base_url", &self.base_url)
            .finish()
    }
}

pub trait SecretStore: Send + Sync {
    fn load(&self) -> io::Result<Option<Credentials>>;
    fn save(&self, creds: &Credentials) -> io::Result<()>;
    fn clear(&self) -> io::Result<()>;
}

/// Encrypts and decrypts the file contents (DPAPI on Windows).
pub trait Protector: Send + Sync {
    fn protect(&self, plain: &[u8]) -> io::Result<Vec<u8>>;
    fn unprotect(&self, blob: &[u8]) -> io::Result<Vec<u8>>;
}

/// No encryption. For tests and the Linux `--dev-pipe` mode only.
pub struct PlainProtector;

impl Protector for PlainProtector {
    fn protect(&self, plain: &[u8]) -> io::Result<Vec<u8>> {
        Ok(plain.to_vec())
    }
    fn unprotect(&self, blob: &[u8]) -> io::Result<Vec<u8>> {
        Ok(blob.to_vec())
    }
}

pub const DEVICE_FILE: &str = "device.bin";
/// macOS has no DPAPI: the token is a root-only (`0600`, in a `0700` directory) JSON file.
pub const DEVICE_FILE_MACOS: &str = "device.json";

/// The device token file in the data directory.
pub struct FileSecretStore<P: Protector> {
    dir: DataDir,
    protector: P,
    file: &'static str,
}

impl<P: Protector> FileSecretStore<P> {
    pub fn new(dir: DataDir, protector: P) -> Self {
        FileSecretStore {
            dir,
            protector,
            file: DEVICE_FILE,
        }
    }

    /// Same, with another file name (`device.json` on macOS).
    pub fn named(dir: DataDir, protector: P, file: &'static str) -> Self {
        FileSecretStore { dir, protector, file }
    }
}

impl<P: Protector> SecretStore for FileSecretStore<P> {
    fn load(&self) -> io::Result<Option<Credentials>> {
        self.dir.enforce_private(self.file);
        let Some(blob) = self.dir.read_bytes(self.file)? else {
            return Ok(None);
        };
        let plain = self.protector.unprotect(&blob)?;
        serde_json::from_slice(&plain)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    fn save(&self, creds: &Credentials) -> io::Result<()> {
        let plain = serde_json::to_vec(creds).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.dir.write_atomic_bytes(self.file, &self.protector.protect(&plain)?)
    }

    fn clear(&self) -> io::Result<()> {
        self.dir.remove(self.file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Xor;
    impl Protector for Xor {
        fn protect(&self, plain: &[u8]) -> io::Result<Vec<u8>> {
            Ok(plain.iter().map(|b| b ^ 0x5a).collect())
        }
        fn unprotect(&self, blob: &[u8]) -> io::Result<Vec<u8>> {
            self.protect(blob)
        }
    }

    #[test]
    fn round_trip_is_not_plaintext_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = DataDir::new(tmp.path());
        let store = FileSecretStore::new(dir.clone(), Xor);
        assert_eq!(store.load().unwrap(), None);
        let c = Credentials {
            token: "neo_dt_secret".into(),
            base_url: "https://neo.example".into(),
        };
        store.save(&c).unwrap();
        let raw = std::fs::read(tmp.path().join(DEVICE_FILE)).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("neo_dt_secret"));
        assert_eq!(store.load().unwrap(), Some(c));
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
        store.clear().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn plain_json_file_is_root_only_and_loosened_files_are_tightened() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = DataDir::new(tmp.path());
        let store = FileSecretStore::named(dir, PlainProtector, DEVICE_FILE_MACOS);
        let c = Credentials {
            token: "neo_dt_secret".into(),
            base_url: "https://neo.example".into(),
        };
        store.save(&c).unwrap();
        let path = tmp.path().join(DEVICE_FILE_MACOS);
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(store.load().unwrap(), Some(c));
        assert_eq!(mode(&path), 0o600, "load tightens a loose file");
        store.clear().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn debug_hides_the_token() {
        let c = Credentials {
            token: "neo_dt_secret".into(),
            base_url: "x".into(),
        };
        assert!(!format!("{c:?}").contains("neo_dt_secret"));
    }
}
