//! What Child mode needs to know about sessions and processes on Windows: whether someone is
//! signed in at the console and whether it is locked (WTS), and for the few processes the policy
//! might close, which session and which kind of account they run in. Thin wrappers; every decision
//! is made in `neo_agent_core`. **Verify on real hardware:** the lock flag and the sign-in test.

use std::mem::size_of;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    GetTokenInformation, IsWellKnownSid, TOKEN_QUERY, TOKEN_USER, TokenUser, WinLocalServiceSid, WinLocalSystemSid, WinNetworkServiceSid,
};
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTS_CURRENT_SERVER_HANDLE, WTS_SESSIONSTATE_LOCK, WTSActive, WTSConnectState, WTSFreeMemory,
    WTSGetActiveConsoleSessionId, WTSINFOEXW, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSUserName,
};
use windows::Win32::System::Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_INFORMATION};
use windows::core::PWSTR;

use neo_agent_core::ledger::Console;
use neo_agent_core::snapshot::ProcessInfo;

/// `WTSGetActiveConsoleSessionId` when no session is attached to the console.
const NO_SESSION: u32 = 0xFFFF_FFFF;

/// `WTSINFOEXW.SessionFlags` says locked. (`WTS_SESSIONSTATE_LOCK` is 0, `UNLOCK` is 1; any other
/// value, or a failed query, is "not known to be locked": time then counts, which errs toward the
/// parent's limit, never toward a lock.)
pub fn flags_say_locked(flags: i32) -> bool {
    flags as u32 == WTS_SESSIONSTATE_LOCK
}

/// A `WTSQuerySessionInformationW` result, freed on drop.
struct WtsBuffer(PWSTR, u32);

impl WtsBuffer {
    fn query(session: u32, class: windows::Win32::System::RemoteDesktop::WTS_INFO_CLASS) -> Option<WtsBuffer> {
        let mut buf = PWSTR::null();
        let mut len = 0u32;
        // SAFETY: out-pointers are valid; the buffer is freed by `Drop` with WTSFreeMemory.
        unsafe { WTSQuerySessionInformationW(Some(WTS_CURRENT_SERVER_HANDLE), session, class, &mut buf, &mut len) }.ok()?;
        (!buf.is_null()).then_some(WtsBuffer(buf, len))
    }

    fn as_string(&self) -> String {
        // SAFETY: for the string classes the buffer is a NUL-terminated UTF-16 string.
        unsafe { self.0.to_string() }.unwrap_or_default()
    }

    fn as_i32(&self) -> Option<i32> {
        // SAFETY: for `WTSConnectState` the buffer is a `WTS_CONNECTSTATE_CLASS` (an i32).
        (self.1 as usize >= size_of::<i32>()).then(|| unsafe { *(self.0.0 as *const i32) })
    }
}

impl Drop for WtsBuffer {
    fn drop(&mut self) {
        // SAFETY: the pointer came from WTSQuerySessionInformationW.
        unsafe { WTSFreeMemory(self.0.0 as *mut _) }
    }
}

/// The console session: someone signed in and attached (state `Active`, a user name), and whether the
/// screen is locked. Idle time is not available to a service (it is a per-session input counter), so
/// it is left unknown and time counts while the session is unlocked.
pub fn console() -> Console {
    // SAFETY: no arguments.
    let session = unsafe { WTSGetActiveConsoleSessionId() };
    if session == NO_SESSION {
        return Console::default();
    }
    let active = WtsBuffer::query(session, WTSConnectState).and_then(|b| b.as_i32()) == Some(WTSActive.0);
    let named = WtsBuffer::query(session, WTSUserName).is_some_and(|b| !b.as_string().is_empty());
    if !(active && named) {
        return Console::default();
    }
    let locked = WtsBuffer::query(session, WTSSessionInfoEx)
        .filter(|b| b.1 as usize >= size_of::<WTSINFOEXW>())
        .map(|b| {
            // SAFETY: the buffer holds a WTSINFOEXW (size checked); level 1 is the only level.
            let info = unsafe { &*(b.0.0 as *const WTSINFOEXW) };
            let flags = unsafe { info.Data.WTSInfoExLevel1.SessionFlags };
            flags_say_locked(flags)
        })
        .unwrap_or(false);
    Console {
        present: true,
        locked,
        idle_secs: None,
    }
}

/// Fills `session_id` and `system_owned` for each process. A process that cannot be opened keeps
/// `None` for what could not be read, which protects it.
pub fn fill_process_facts(procs: &mut [ProcessInfo]) {
    for p in procs {
        let mut sid = 0u32;
        // SAFETY: valid out-pointer.
        if unsafe { ProcessIdToSessionId(p.pid, &mut sid) }.is_ok() {
            p.session_id = Some(sid);
        }
        p.system_owned = runs_as_service_account(p.pid);
    }
}

/// Whether `pid` runs as LocalSystem, LocalService or NetworkService; `None` when its token cannot be read.
fn runs_as_service_account(pid: u32) -> Option<bool> {
    // SAFETY: handles are closed on every path; the token buffer is sized by the first call.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid).ok()?;
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
        let _ = CloseHandle(process);
        opened.ok()?;
        let mut need = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut need);
        let mut buf = vec![0u8; need as usize];
        let got = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr() as *mut _), need, &mut need);
        let result = got.ok().map(|_| {
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            [WinLocalSystemSid, WinLocalServiceSid, WinNetworkServiceSid]
                .into_iter()
                .any(|kind| IsWellKnownSid(user.User.Sid, kind).as_bool())
        });
        let _ = CloseHandle(token);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_flag_zero_is_locked() {
        assert!(flags_say_locked(0));
        assert!(!flags_say_locked(1));
        assert!(!flags_say_locked(-1)); // WTS_SESSIONSTATE_UNKNOWN
    }
}
