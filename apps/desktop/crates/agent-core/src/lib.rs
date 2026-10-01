//! `neo-agent-core`: the pure, OS-independent detection logic of the Neo desktop agent
//! (`_specs/desktop-agent.md`).
//!
//! The Windows service turns operating-system state into [`snapshot`] structs and calls
//! [`detect::detect`]; this crate never touches the OS. It also holds the event wire types
//! ([`events`]), local state ([`state`]), the outgoing [`queue`], local warning decisions
//! ([`warn`]) and the HTTP client ([`api`]). Time is always passed in (`now`), never read.

pub mod api;
pub mod detect;
pub mod events;
pub mod lists;
pub mod queue;
pub mod snapshot;
pub mod state;
pub mod warn;
