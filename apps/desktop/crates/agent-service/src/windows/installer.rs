//! Applying an update: the MSI's Authenticode signer and `msiexec /i <msi> /qn`.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use crate::update::{Installer, UpdateError};

const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

pub struct MsiInstaller {
    /// Where `msiexec` writes its log.
    pub log_path: std::path::PathBuf,
}

impl Installer for MsiInstaller {
    fn own_signer(&self) -> Option<String> {
        std::env::current_exe().ok().and_then(|p| super::authenticode::signer(&p))
    }

    fn signer_of(&self, msi: &Path) -> Option<String> {
        super::authenticode::signer(msi)
    }

    fn install(&self, msi: &Path) -> Result<(), UpdateError> {
        // Detached: Windows Installer stops this service to replace it, and the installer must
        // outlive the process that started it.
        Command::new("msiexec")
            .arg("/i")
            .arg(msi)
            .args(["/qn", "/norestart", "/l*v"])
            .arg(&self.log_path)
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map(|_| ())
            .map_err(|e| UpdateError::Install(e.to_string()))
    }
}
