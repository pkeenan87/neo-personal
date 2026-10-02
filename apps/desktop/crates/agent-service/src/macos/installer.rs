//! Applying an update on macOS: `pkgutil --check-signature` for the signer policy, then
//! `installer -pkg <pkg> -target /`, detached. The policy itself (`update::signer_policy`) and the
//! output parsing (`pkg::parse_check_signature`) are tested on Linux.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::update::{Installer, UpdateError};

use super::{bundles, codesign, exec, pkg};

const PKGUTIL: &str = "/usr/sbin/pkgutil";
const INSTALLER: &str = "/usr/sbin/installer";

/// The Team ID of the running daemon: its own bundle's Developer ID signature, `None` when the
/// daemon is unsigned or ad-hoc signed (a CI build).
pub fn own_team_id() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let target = bundles::bundle_of(&exe).unwrap_or(exe);
    codesign::inspect(&target).team_id
}

pub struct PkgInstaller {
    /// Where `installer` writes its output.
    pub log_path: PathBuf,
}

impl Installer for PkgInstaller {
    fn own_signer(&self) -> Option<String> {
        own_team_id()
    }

    fn signer_of(&self, pkg_path: &Path) -> Option<String> {
        let args = vec!["--check-signature".to_string(), pkg_path.to_string_lossy().to_string()];
        let out = exec::run_capped(PKGUTIL, &args, Duration::from_secs(60), 64 * 1024).ok()?;
        pkg::parse_check_signature(&String::from_utf8_lossy(&out.stdout))
            .trusted_team_id()
            .map(str::to_string)
    }

    fn install(&self, pkg_path: &Path) -> Result<(), UpdateError> {
        let (log, log2) = (log_file(&self.log_path), log_file(&self.log_path));
        // Detached in its own process group: the pkg's preinstall boots this daemon out, and the
        // installer must outlive it (the launchd plist sets AbandonProcessGroup).
        let mut child = Command::new(INSTALLER)
            .arg("-pkg")
            .arg(pkg_path)
            .args(["-target", "/"])
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(log2)
            .process_group(0)
            .spawn()
            .map_err(|e| UpdateError::Install(e.to_string()))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    fn extension(&self) -> &'static str {
        "pkg"
    }
}

fn log_file(path: &Path) -> Stdio {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}
