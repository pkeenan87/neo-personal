//! Neo: the per-user tray app of the desktop agent (`_specs/desktop-agent.md`). It shows status,
//! runs enrollment, shows warnings and checks links. It talks to the `neo-agent` service through
//! the pipe and never holds the device token.

// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod ipc;
mod logic;

fn main() {
    app::run();
}
