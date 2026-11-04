//! The two things Child mode makes the service do to the computer: close a program and lock the
//! session. This is the only acting code in the agent, so it is as thin as it can be: every
//! decision (what, when, whether it is allowed) is made in `neo_agent_core::enforce` and
//! `neo_agent_core::ledger`, and tested there. The Windows and macOS implementations are in
//! `windows::actuator` and `macos::actuator`; both are marked "verify on real hardware" in
//! `_specs/v2-m2-child.md`.

/// A process to close, as it was listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub pid: u32,
    /// The path the process had when it was listed. An implementation closes the process only if
    /// the pid still has this path (a pid is reused after a process ends).
    pub image_path: String,
}

pub trait Actuator: Send + Sync {
    /// Closes the process. An error means it was left running (it ended already, was not the same
    /// program any more, or the OS refused).
    fn terminate(&self, target: &Target) -> Result<(), String>;

    /// Locks the console session: Windows disconnects it (back to the sign-in screen), macOS
    /// locks it through the signed-in person's session. The programs in it keep running.
    fn lock_session(&self) -> Result<(), String>;
}

/// Development on Linux: records nothing, closes nothing.
pub struct NullActuator;

impl Actuator for NullActuator {
    fn terminate(&self, target: &Target) -> Result<(), String> {
        log::info!("would close pid {} (not on this platform)", target.pid);
        Ok(())
    }

    fn lock_session(&self) -> Result<(), String> {
        log::info!("would lock the session (not on this platform)");
        Ok(())
    }
}
