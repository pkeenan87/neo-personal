//! Acting on Windows: closing a program and locking the session (`_specs/v2-m2-child.md` section 7).
//! Both are one OS call after the checks below. **Verify on real hardware:** that disconnecting the
//! console session returns to the sign-in screen and that the person can sign back in to the same
//! session, and that `TerminateProcess` closes an app the person started.

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTS_CURRENT_SERVER_HANDLE, WTSDisconnectSession, WTSGetActiveConsoleSessionId,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
};
use windows::core::PWSTR;

use crate::actuator::{Actuator, Target};

pub struct WindowsActuator;

/// Closes the handle on every path.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle came from OpenProcess and is closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn image_path_of(h: HANDLE) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: the buffer outlives the call and `len` is its size in characters.
    unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

impl Actuator for WindowsActuator {
    fn terminate(&self, target: &Target) -> Result<(), String> {
        // Never the idle process, System, or the service itself (session 0 is checked below).
        if target.pid <= 4 || target.pid == std::process::id() {
            return Err("refused: not a program that may be closed".into());
        }
        // SAFETY: the handle is owned by `Owned` and closed when it goes out of scope.
        let process = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, target.pid) }
            .map_err(|e| format!("could not open the program: {e}"))?;
        let process = Owned(process);
        // A pid is reused after a process ends: close it only if it is still the program that was listed.
        match image_path_of(process.0) {
            Some(p) if p.eq_ignore_ascii_case(&target.image_path) => {}
            _ => return Err("the program has already ended or changed".into()),
        }
        let mut session = 0u32;
        // SAFETY: valid out-pointer.
        unsafe { ProcessIdToSessionId(target.pid, &mut session) }.map_err(|e| format!("could not read the session: {e}"))?;
        if session == 0 {
            return Err("refused: session 0 is the system's".into());
        }
        // SAFETY: the handle was opened with PROCESS_TERMINATE.
        unsafe { TerminateProcess(process.0, 1) }.map_err(|e| format!("could not close the program: {e}"))
    }

    fn lock_session(&self) -> Result<(), String> {
        // SAFETY: no arguments.
        let session = unsafe { WTSGetActiveConsoleSessionId() };
        if session == 0xFFFF_FFFF {
            return Err("no console session".into());
        }
        // Disconnecting returns the console to the sign-in screen; the session and its programs
        // stay, and the person signs back in to it. (A tray-driven LockWorkStation is the other
        // option; see the spec's Open Questions.)
        // SAFETY: the current server handle and a session id just read.
        unsafe { WTSDisconnectSession(Some(WTS_CURRENT_SERVER_HANDLE), session, false) }
            .map_err(|e| format!("could not disconnect the session: {e}"))
    }
}
