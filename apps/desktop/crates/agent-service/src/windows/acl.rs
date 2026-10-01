//! The data directory ACL: SYSTEM and Administrators full control, nobody else, inherited by every
//! file in it. Done with `icacls` and well-known SIDs (so it works on any Windows language).

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Replaces the directory's ACL with SYSTEM + Administrators, full control; children inherit it.
pub fn secure_dir(dir: &Path) -> std::io::Result<()> {
    let status = Command::new("icacls")
        .arg(dir)
        .args([
            // The folder only: its inheritable ACEs propagate to existing and new children. Walking
            // the files with `/T` stripped their inherited ACEs and left the service unable to read
            // its own state after a restart.
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F",
            "/Q",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("icacls exited with {status}")))
    }
}
