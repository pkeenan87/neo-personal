//! The data directory's permissions: `/Library/Application Support/Neo/data` is root `0700`,
//! created and locked down **before** anything is written into it (the step 6 permissions lesson),
//! and every file in it is `0600`.

use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::Path;

/// Creates `dir` (and parents) `0700`, forces `0700` even if it already existed looser, and, when
/// `owner` is given, hands it to that (uid, gid). Fails if the result is still group- or
/// world-accessible, so the caller never writes secrets into an open directory.
pub fn secure_data_dir(dir: &Path, owner: Option<(u32, u32)>) -> io::Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    if let Some((uid, gid)) = owner {
        std::os::unix::fs::chown(dir, Some(uid), Some(gid))?;
    }
    let m = std::fs::metadata(dir)?;
    if m.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the data directory is still accessible to others",
        ));
    }
    if let Some((uid, _)) = owner
        && m.uid() != uid
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the data directory has the wrong owner",
        ));
    }
    Ok(())
}

/// Sets the process umask so every file the daemon creates (state, logs, the socket before its
/// explicit chmod) is owner-only.
pub fn private_umask() {
    // SAFETY: umask only changes this process's file-creation mask.
    unsafe {
        libc::umask(0o077);
    }
}

/// `(0, 0)` when running as root (the daemon), else `None` (tests and `--console` by hand).
pub fn root_owner() -> Option<(u32, u32)> {
    // SAFETY: geteuid has no preconditions.
    (unsafe { libc::geteuid() } == 0).then_some((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn creates_the_directory_0700_before_anything_else() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Neo").join("data");
        secure_data_dir(&dir, None).unwrap();
        assert_eq!(mode(&dir), 0o700);
    }

    #[test]
    fn tightens_a_directory_that_already_existed_open() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("data");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        secure_data_dir(&dir, None).unwrap();
        assert_eq!(mode(&dir), 0o700);
    }

    #[test]
    fn the_owner_is_checked_when_asked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("data");
        let me = std::fs::metadata(tmp.path()).unwrap();
        // Handing it to ourselves works without root.
        secure_data_dir(&dir, Some((me.uid(), me.gid()))).unwrap();
    }
}
