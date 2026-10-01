//! `neo-agent`: the Windows service and macOS daemon of the Neo desktop agent
//! (`_specs/desktop-agent.md`, `_specs/desktop-agent-macos.md`).
//!
//! Everything OS-independent lives here and is tested on Linux: the pipe protocol, scheduling,
//! scanning, local state, warnings, enrollment and updates. The Windows-only code is in
//! [`windows`] behind `cfg(windows)` and the macOS code in [`macos`]; both only turn the OS into
//! the traits in [`probe`], [`secrets`] and [`update`].

pub mod agent;
#[cfg(feature = "http")]
pub mod bootstrap;
pub mod cli;
pub mod config;
pub mod hub;
pub mod inspect;
pub mod ipc;
pub mod logging;
#[cfg(feature = "http")]
pub mod net;
pub mod persist;
pub mod probe;
pub mod protocol;
pub mod runtime;
pub mod schedule;
pub mod secrets;
pub mod signer_cache;
pub mod text;
pub mod update;

#[cfg(unix)]
pub mod macos;
#[cfg(windows)]
pub mod windows;
