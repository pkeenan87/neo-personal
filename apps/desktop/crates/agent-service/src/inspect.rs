//! File inspection shared by the Windows probe and tests: hashing, finding a program's main
//! executable, and building [`ExeFacts`]. Only files inside a newly appeared program's own
//! install location are ever touched.

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use neo_agent_core::detect::ExeHint;
use neo_agent_core::snapshot::ExeFacts;
use sha2::{Digest, Sha256};

/// Files larger than this are not hashed.
pub const MAX_HASH_BYTES: u64 = 256 * 1024 * 1024;

/// Lowercase hex SHA-256 of a file.
pub fn hash_file(path: &Path) -> io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    if f.metadata()?.len() > MAX_HASH_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "file too large to hash"));
    }
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn is_uninstaller(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.starts_with("unins") || l.contains("uninstall") || l.contains("setup")
}

/// The file a hint points at: the named `.exe`, or the first `.exe` (by name, uninstallers last)
/// directly in the install directory.
pub fn resolve_hint(hint: &ExeHint) -> Option<PathBuf> {
    match hint {
        ExeHint::File(p) => {
            let path = PathBuf::from(p);
            path.is_file().then_some(path)
        }
        ExeHint::FirstExeIn(dir) => {
            let mut exes: Vec<PathBuf> = std::fs::read_dir(dir)
                .ok()?
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")))
                .collect();
            exes.sort_by_key(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                (is_uninstaller(&name), name)
            });
            exes.into_iter().next()
        }
    }
}

/// How a file's signature check came out.
pub struct SigCheck {
    pub trusted: bool,
    pub signer: Option<String>,
}

/// Hashes and signature-checks the executables named by `hints`, at most `max` of them.
pub fn exe_facts(hints: &[ExeHint], max: usize, verify: &dyn Fn(&Path) -> SigCheck) -> Vec<ExeFacts> {
    let mut out = Vec::new();
    for h in hints {
        if out.len() >= max {
            break;
        }
        let Some(path) = resolve_hint(h) else { continue };
        let Ok(sha256) = hash_file(&path) else { continue };
        let sig = verify(&path);
        out.push(ExeFacts {
            path: path.to_string_lossy().to_string(),
            sha256,
            signed_trusted: sig.trusted,
            signer: sig.signer,
        });
    }
    out
}

/// (size, modified time in unix seconds) of a file, for the signer cache key.
pub fn file_identity(path: &Path) -> Option<(u64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    let secs = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some((m.len(), secs))
}

/// Whether `path` is under the Windows directory (catalog-signed OS files; never a remote-access
/// tool, so the signature check is skipped).
pub fn is_under(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches(['\\', '/']).to_ascii_lowercase().replace('/', "\\");
    !root.is_empty() && path.to_ascii_lowercase().replace('/', "\\").starts_with(&format!("{root}\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.exe");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            hash_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn resolves_the_main_exe_and_skips_uninstallers() {
        let tmp = tempfile::tempdir().unwrap();
        for n in ["unins000.exe", "Zeta.exe", "alpha.EXE", "readme.txt"] {
            std::fs::write(tmp.path().join(n), b"x").unwrap();
        }
        let dir = tmp.path().to_string_lossy().to_string();
        let found = resolve_hint(&ExeHint::FirstExeIn(dir.clone())).unwrap();
        assert_eq!(found.file_name().unwrap(), "alpha.EXE");
        assert!(resolve_hint(&ExeHint::FirstExeIn(format!("{dir}/missing"))).is_none());
        assert!(resolve_hint(&ExeHint::File(format!("{dir}/Zeta.exe"))).is_some());
        assert!(resolve_hint(&ExeHint::File(format!("{dir}/nope.exe"))).is_none());
    }

    #[test]
    fn builds_facts_with_a_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let mut hints = Vec::new();
        for n in ["a.exe", "b.exe", "c.exe"] {
            let p = tmp.path().join(n);
            std::fs::write(&p, n.as_bytes()).unwrap();
            hints.push(ExeHint::File(p.to_string_lossy().to_string()));
        }
        hints.insert(0, ExeHint::File("/does/not/exist.exe".into()));
        let facts = exe_facts(&hints, 2, &|_| SigCheck {
            trusted: false,
            signer: None,
        });
        assert_eq!(facts.len(), 2);
        assert!(!facts[0].signed_trusted);
        assert_eq!(facts[0].sha256.len(), 64);
    }

    #[test]
    fn system_paths() {
        assert!(is_under(r"C:\Windows\System32\cmd.exe", r"C:\WINDOWS"));
        assert!(is_under(r"c:\windows\x.exe", r"C:\Windows\"));
        assert!(!is_under(r"C:\Windows2\x.exe", r"C:\Windows"));
        assert!(!is_under(r"C:\Users\x.exe", ""));
    }
}
