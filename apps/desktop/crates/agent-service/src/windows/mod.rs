//! The Windows-only code: thin wrappers that turn the OS into the traits in `probe`, `secrets`
//! and `update`. Nothing here decides anything. It could not be compiled on the Linux machine it
//! was written on; the `desktop-windows` CI job is the first real build.

pub mod acl;
pub mod authenticode;
pub mod dpapi;
pub mod eventlog;
pub mod installer;
pub mod notify;
pub mod pipe;
pub mod probe;
pub mod service;

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

/// A NUL-terminated UTF-16 copy of `s`, for `PCWSTR` arguments (keep it alive across the call).
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// Decodes UTF-16 up to the first NUL.
pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}
