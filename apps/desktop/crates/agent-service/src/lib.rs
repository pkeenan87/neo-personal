//! `neo-agent`: the Windows service of the Neo desktop agent (`_specs/desktop-agent.md`).
//!
//! Everything OS-independent lives here and is tested on Linux: the pipe protocol, scheduling,
//! scanning, local state, warnings, enrollment and updates. The Windows-only code is in
//! [`windows`] behind `cfg(windows)` and only turns the OS into the traits in [`probe`],
//! [`secrets`] and [`update`].

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

#[cfg(windows)]
pub mod windows;
