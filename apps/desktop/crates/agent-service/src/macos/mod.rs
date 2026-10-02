//! The macOS daemon (spec `_specs/desktop-agent-macos.md`), mirroring `windows/`.
//!
//! Most of it is plain files, SQLite, plists and command output, so it builds and is tested on
//! Linux (`cfg(unix)`): the TCC reader, bundle and launchd scanning, `pkgutil` and unified-log
//! parsing, the Trash timer, the console-user notifier and the data-directory permissions. Only
//! the thin OS glue is `cfg(target_os = "macos")` and was written without a Mac to compile it on:
//! libproc process listing, the Security framework, `getpeereid`, and the daemon entry. The
//! `desktop-macos` CI job is its first real build.

pub mod bundles;
pub mod exec;
pub mod notify;
pub mod perms;
pub mod pkg;
pub mod tcc;
pub mod trash;
pub mod unifiedlog;

#[cfg(target_os = "macos")]
pub mod codesign;
#[cfg(target_os = "macos")]
pub mod daemon;
#[cfg(target_os = "macos")]
pub mod installer;
#[cfg(target_os = "macos")]
pub mod peer;
#[cfg(target_os = "macos")]
pub mod probe;
#[cfg(target_os = "macos")]
pub mod procs;
