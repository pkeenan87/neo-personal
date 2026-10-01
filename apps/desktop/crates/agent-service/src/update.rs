//! Service-driven updates: a Tauri-format `latest.json`, a minisign signature checked against the
//! compiled-in public key, and the MSI's Authenticode signer. The OS-specific steps (reading the
//! signer, running `msiexec`) sit behind [`Installer`]; everything else is tested on Linux.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;

/// An update MSI larger than this is refused.
pub const MAX_MSI_BYTES: u64 = 200 * 1024 * 1024;
/// A manifest larger than this is refused.
const MAX_MANIFEST_BYTES: usize = 256 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UpdateError {
    #[error("updates are not configured in this build")]
    NotConfigured,
    #[error("could not fetch the update manifest: {0}")]
    Fetch(String),
    #[error("the update manifest is not valid: {0}")]
    Manifest(String),
    #[error("the update URL is not allowed")]
    BadUrl,
    #[error("download failed: {0}")]
    Download(String),
    #[error("the update signature is not valid: {0}")]
    Signature(String),
    #[error("the update installer is not signed by the same publisher as this program")]
    Signer,
    #[error("could not start the installer: {0}")]
    Install(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Platform {
    pub url: String,
    /// Base64 of the whole `.sig` file text (Tauri's format).
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub pub_date: Option<String>,
    pub platforms: BTreeMap<String, Platform>,
}

/// An update worth installing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Available {
    pub version: String,
    pub url: String,
    pub signature: String,
}

pub fn parse_manifest(json: &str) -> Result<Manifest, UpdateError> {
    if json.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::Manifest("too large".into()));
    }
    serde_json::from_str(json).map_err(|e| UpdateError::Manifest(e.to_string()))
}

/// `1.2.3`, `v1.2.3`, `1.2.3-rc.1` -> (1, 2, 3, is_prerelease).
fn parse_version(v: &str) -> Option<(u64, u64, u64, bool)> {
    let v = v.trim().trim_start_matches('v');
    let v = v.split('+').next()?;
    let (core, pre) = match v.split_once('-') {
        Some((c, _)) => (c, true),
        None => (v, false),
    };
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((major, minor, patch, pre))
}

/// Whether `candidate` is strictly newer than `current`. An unparsable version is never newer.
pub fn version_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => {
            // A prerelease sorts before its release.
            (a.0, a.1, a.2, !a.3) > (b.0, b.1, b.2, !b.3)
        }
        _ => false,
    }
}

/// HTTPS, or HTTP on the loopback interface (CI serves the test manifest that way; the signature,
/// not the transport, is the trust anchor).
pub fn url_allowed(url: &str) -> bool {
    let u = url.trim();
    if u.contains(char::is_whitespace) {
        return false;
    }
    u.starts_with("https://")
        || ["http://127.0.0.1", "http://localhost", "http://[::1]"].iter().any(|p| {
            u.strip_prefix(p)
                .is_some_and(|r| r.is_empty() || r.starts_with(':') || r.starts_with('/'))
        })
}

/// The update for `platform` when it is newer than `current`.
pub fn pick_update(manifest: &Manifest, current: &str, platform: &str) -> Result<Option<Available>, UpdateError> {
    if !version_newer(&manifest.version, current) {
        return Ok(None);
    }
    let p = manifest
        .platforms
        .get(platform)
        .ok_or_else(|| UpdateError::Manifest(format!("no build for {platform}")))?;
    if !url_allowed(&p.url) {
        return Err(UpdateError::BadUrl);
    }
    Ok(Some(Available {
        version: manifest.version.clone(),
        url: p.url.clone(),
        signature: p.signature.clone(),
    }))
}

/// Fetches and parses the manifest and returns the update, if any.
pub fn check<D: Downloader>(downloader: &D, manifest_url: &str, current: &str, platform: &str) -> Result<Option<Available>, UpdateError> {
    if !url_allowed(manifest_url) {
        return Err(UpdateError::BadUrl);
    }
    let bytes = downloader.fetch(manifest_url, MAX_MANIFEST_BYTES as u64)?;
    let text = String::from_utf8(bytes).map_err(|_| UpdateError::Manifest("not UTF-8".into()))?;
    pick_update(&parse_manifest(&text)?, current, platform)
}

/// Verifies `data` against a Tauri-format signature (`signature_b64`: base64 of the `.sig` file) and
/// a Tauri-format public key (`pubkey_b64`: base64 of the `.pub` file).
pub fn verify_signature(pubkey_b64: &str, signature_b64: &str, data: &[u8]) -> Result<(), UpdateError> {
    let err = |what: &str, e: &dyn std::fmt::Display| UpdateError::Signature(format!("{what}: {e}"));
    let pub_text =
        String::from_utf8(STANDARD.decode(pubkey_b64.trim()).map_err(|e| err("public key", &e))?).map_err(|e| err("public key", &e))?;
    let sig_text =
        String::from_utf8(STANDARD.decode(signature_b64.trim()).map_err(|e| err("signature", &e))?).map_err(|e| err("signature", &e))?;
    let key = minisign_verify::PublicKey::decode(&pub_text).map_err(|e| err("public key", &e))?;
    let sig = minisign_verify::Signature::decode(&sig_text).map_err(|e| err("signature", &e))?;
    key.verify(data, &sig, true).map_err(|e| err("verify", &e))
}

/// The signer rule for an update MSI. A signed agent accepts only an MSI with the identical
/// signer subject. An unsigned agent (a CI build) accepts an unsigned MSI only when built with
/// `NEO_ALLOW_UNSIGNED_UPDATE`.
pub fn signer_policy(own: Option<&str>, msi: Option<&str>, allow_unsigned: bool) -> Result<(), UpdateError> {
    match (
        own.map(str::trim).filter(|s| !s.is_empty()),
        msi.map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (Some(a), Some(b)) if a == b => Ok(()),
        (Some(_), _) => Err(UpdateError::Signer),
        (None, None) if allow_unsigned => Ok(()),
        (None, _) => Err(UpdateError::Signer),
    }
}

/// Downloads a file into memory.
pub trait Downloader {
    fn fetch(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>, UpdateError>;
}

/// The OS-specific installer steps.
pub trait Installer {
    /// The Authenticode signer subject of the running agent, `None` when unsigned.
    fn own_signer(&self) -> Option<String>;
    /// The Authenticode signer subject of `msi`, `None` when unsigned or untrusted.
    fn signer_of(&self, msi: &Path) -> Option<String>;
    /// Starts `msiexec /i <msi> /qn` detached. Windows Installer stops this service, replaces the
    /// files and starts the new one.
    fn install(&self, msi: &Path) -> Result<(), UpdateError>;
}

/// Downloads, verifies and starts the install. Returns the staged MSI path. Nothing is written to
/// disk, and nothing runs, unless the minisign signature is valid.
pub fn apply<D: Downloader, I: Installer>(
    update: &Available,
    pubkey_b64: &str,
    stage_dir: &Path,
    allow_unsigned: bool,
    downloader: &D,
    installer: &I,
) -> Result<PathBuf, UpdateError> {
    if !url_allowed(&update.url) {
        return Err(UpdateError::BadUrl);
    }
    let bytes = downloader.fetch(&update.url, MAX_MSI_BYTES)?;
    verify_signature(pubkey_b64, &update.signature, &bytes)?;
    std::fs::create_dir_all(stage_dir).map_err(|e| UpdateError::Download(e.to_string()))?;
    let version: String = update.version.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
    let path = stage_dir.join(format!("neo-{version}.msi"));
    std::fs::write(&path, &bytes).map_err(|e| UpdateError::Download(e.to_string()))?;
    let checked = signer_policy(
        installer.own_signer().as_deref(),
        installer.signer_of(&path).as_deref(),
        allow_unsigned,
    );
    if let Err(e) = checked {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    installer.install(&path)?;
    Ok(path)
}

/// What the agent calls: look for an update and apply it.
pub trait Updater: Send + Sync {
    fn check(&self, current: &str) -> Result<Option<Available>, UpdateError>;
    fn apply(&self, update: &Available) -> Result<(), UpdateError>;
}

/// The real updater: manifest URL and public key from the build, staging in the data directory.
pub struct StandardUpdater<D, I> {
    pub manifest_url: String,
    /// `None` = updates are off in this build.
    pub pubkey: Option<String>,
    pub platform: String,
    pub stage_dir: PathBuf,
    pub allow_unsigned: bool,
    pub downloader: D,
    pub installer: I,
}

impl<D: Downloader + Send + Sync, I: Installer + Send + Sync> Updater for StandardUpdater<D, I> {
    fn check(&self, current: &str) -> Result<Option<Available>, UpdateError> {
        if self.pubkey.is_none() {
            return Err(UpdateError::NotConfigured);
        }
        check(&self.downloader, &self.manifest_url, current, &self.platform)
    }

    fn apply(&self, update: &Available) -> Result<(), UpdateError> {
        let key = self.pubkey.as_deref().ok_or(UpdateError::NotConfigured)?;
        apply(update, key, &self.stage_dir, self.allow_unsigned, &self.downloader, &self.installer).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    // A real minisign key pair and signature of b"hello msi" (generated with `tauri signer`,
    // no password), so these tests exercise the actual verification path.
    const PUBKEY: &str = include_str!("../tests/fixtures/update/test.pub");
    const SIG: &str = include_str!("../tests/fixtures/update/hello.msi.sig");
    const DATA: &[u8] = b"hello msi";

    #[test]
    fn version_compare() {
        assert!(version_newer("0.2.0", "0.1.9"));
        assert!(version_newer("v1.0.0", "0.9.9"));
        assert!(version_newer("0.1.10", "0.1.9"));
        assert!(!version_newer("0.1.0", "0.1.0"));
        assert!(!version_newer("0.0.9", "0.1.0"));
        assert!(version_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!version_newer("1.0.0-rc.1", "1.0.0"));
        assert!(!version_newer("garbage", "1.0.0"));
        assert!(!version_newer("1.0.0", "garbage"));
        assert!(!version_newer("1.0.0.1", "1.0.0"));
    }

    fn manifest(version: &str, url: &str) -> String {
        format!(
            r#"{{"version":"{version}","notes":"n","pub_date":"2026-10-01T00:00:00Z","platforms":{{"windows-x86_64":{{"url":"{url}","signature":"{}"}}}}}}"#,
            SIG.trim()
        )
    }

    #[test]
    fn picks_only_newer_with_allowed_url() {
        let m = parse_manifest(&manifest("0.2.0", "https://example.com/neo.msi")).unwrap();
        let a = pick_update(&m, "0.1.0", "windows-x86_64").unwrap().unwrap();
        assert_eq!(a.version, "0.2.0");
        assert_eq!(pick_update(&m, "0.2.0", "windows-x86_64"), Ok(None));
        assert!(matches!(pick_update(&m, "0.1.0", "linux-x86_64"), Err(UpdateError::Manifest(_))));
        let bad = parse_manifest(&manifest("0.2.0", "ftp://example.com/neo.msi")).unwrap();
        assert_eq!(pick_update(&bad, "0.1.0", "windows-x86_64"), Err(UpdateError::BadUrl));
        let lo = parse_manifest(&manifest("0.2.0", "http://127.0.0.1:8000/neo.msi")).unwrap();
        assert!(pick_update(&lo, "0.1.0", "windows-x86_64").unwrap().is_some());
        assert!(matches!(parse_manifest("{"), Err(UpdateError::Manifest(_))));
        assert!(!url_allowed("http://127.0.0.1.evil.com/x"));
        assert!(!url_allowed("http://example.com/x"));
    }

    struct FakeDl(Vec<u8>);
    impl Downloader for FakeDl {
        fn fetch(&self, _url: &str, _max: u64) -> Result<Vec<u8>, UpdateError> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn check_fetches_the_manifest() {
        let t = FakeDl(manifest("0.2.0", "https://example.com/neo.msi").into_bytes());
        let a = check(&t, "https://example.com/latest.json", "0.1.0", "windows-x86_64").unwrap();
        assert!(a.is_some());
        assert!(
            check(
                &FakeDl(b"nope".to_vec()),
                "https://example.com/latest.json",
                "0.1.0",
                "windows-x86_64"
            )
            .is_err()
        );
        assert_eq!(
            check(&t, "http://example.com/latest.json", "0.1.0", "windows-x86_64"),
            Err(UpdateError::BadUrl)
        );
    }

    #[test]
    fn minisign_verification() {
        verify_signature(PUBKEY.trim(), SIG.trim(), DATA).unwrap();
        assert!(matches!(
            verify_signature(PUBKEY.trim(), SIG.trim(), b"tampered"),
            Err(UpdateError::Signature(_))
        ));
        assert!(matches!(
            verify_signature(PUBKEY.trim(), "bm90IGEgc2ln", DATA),
            Err(UpdateError::Signature(_))
        ));
        assert!(matches!(verify_signature("!!!", SIG.trim(), DATA), Err(UpdateError::Signature(_))));
    }

    #[test]
    fn verifies_a_signature_made_by_the_real_tauri_cli() {
        // `tauri signer generate` + `tauri signer sign` on the file "hello\n".
        let pubkey = include_str!("../tests/fixtures/update/tauri-cli.pub");
        let sig = include_str!("../tests/fixtures/update/tauri-cli-hello.sig");
        verify_signature(pubkey.trim(), sig.trim(), b"hello\n").unwrap();
        assert!(verify_signature(pubkey.trim(), sig.trim(), b"hello").is_err());
        // A signature from another key is refused even for the right data.
        assert!(verify_signature(PUBKEY.trim(), sig.trim(), b"hello\n").is_err());
    }

    #[test]
    fn signer_rules() {
        assert!(signer_policy(Some("Neo"), Some("Neo"), false).is_ok());
        assert_eq!(signer_policy(Some("Neo"), Some("Evil"), false), Err(UpdateError::Signer));
        assert_eq!(signer_policy(Some("Neo"), None, true), Err(UpdateError::Signer));
        assert_eq!(signer_policy(None, Some("Evil"), true), Err(UpdateError::Signer));
        assert_eq!(signer_policy(None, None, false), Err(UpdateError::Signer));
        assert!(signer_policy(None, None, true).is_ok());
    }

    struct FakeInst {
        own: Option<String>,
        msi: Option<String>,
        installed: RefCell<Vec<PathBuf>>,
    }
    impl Installer for FakeInst {
        fn own_signer(&self) -> Option<String> {
            self.own.clone()
        }
        fn signer_of(&self, _msi: &Path) -> Option<String> {
            self.msi.clone()
        }
        fn install(&self, msi: &Path) -> Result<(), UpdateError> {
            self.installed.borrow_mut().push(msi.to_path_buf());
            Ok(())
        }
    }

    fn avail() -> Available {
        Available {
            version: "0.2.0".into(),
            url: "https://example.com/neo.msi".into(),
            signature: SIG.trim().into(),
        }
    }

    #[test]
    fn apply_installs_only_when_signature_and_signer_pass() {
        let tmp = tempfile::tempdir().unwrap();
        let ok = FakeInst {
            own: Some("Neo".into()),
            msi: Some("Neo".into()),
            installed: RefCell::new(vec![]),
        };
        let path = apply(&avail(), PUBKEY.trim(), tmp.path(), false, &FakeDl(DATA.to_vec()), &ok).unwrap();
        assert!(path.exists());
        assert_eq!(ok.installed.borrow().len(), 1);

        // Bad minisign signature: nothing is written or run.
        let bad = FakeInst {
            own: None,
            msi: None,
            installed: RefCell::new(vec![]),
        };
        let tmp2 = tempfile::tempdir().unwrap();
        let r = apply(&avail(), PUBKEY.trim(), tmp2.path(), true, &FakeDl(b"other".to_vec()), &bad);
        assert!(matches!(r, Err(UpdateError::Signature(_))));
        assert!(bad.installed.borrow().is_empty());
        assert_eq!(std::fs::read_dir(tmp2.path()).unwrap().count(), 0);

        // Valid signature but the wrong Authenticode signer: removed, not installed.
        let wrong = FakeInst {
            own: Some("Neo".into()),
            msi: Some("Someone else".into()),
            installed: RefCell::new(vec![]),
        };
        let tmp3 = tempfile::tempdir().unwrap();
        let r = apply(&avail(), PUBKEY.trim(), tmp3.path(), false, &FakeDl(DATA.to_vec()), &wrong);
        assert_eq!(r, Err(UpdateError::Signer));
        assert!(wrong.installed.borrow().is_empty());
        assert_eq!(std::fs::read_dir(tmp3.path()).unwrap().count(), 0);
    }
}
