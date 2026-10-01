//! The fallback warning: a message box in the active console session, shown by the service itself
//! when no tray app is listening.

use windows::Win32::System::RemoteDesktop::{WTS_CURRENT_SERVER_HANDLE, WTSGetActiveConsoleSessionId, WTSSendMessageW};
use windows::Win32::UI::WindowsAndMessaging::{MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_SYSTEMMODAL, MESSAGEBOX_RESULT};
use windows::core::PCWSTR;

use crate::agent::Notifier;

pub struct WtsNotifier;

impl Notifier for WtsNotifier {
    fn fallback_warning(&self, title: &str, text: &str) {
        let (wtitle, wtext) = (super::wide(title), super::wide(text));
        // SAFETY: the wide buffers live across the call; the lengths are in bytes, without the NUL.
        unsafe {
            let session = WTSGetActiveConsoleSessionId();
            if session == u32::MAX {
                log::warn!("no console session to show the warning in");
                return;
            }
            let mut response = MESSAGEBOX_RESULT(0);
            let r = WTSSendMessageW(
                Some(WTS_CURRENT_SERVER_HANDLE),
                session,
                PCWSTR(wtitle.as_ptr()),
                ((wtitle.len() - 1) * 2) as u32,
                PCWSTR(wtext.as_ptr()),
                ((wtext.len() - 1) * 2) as u32,
                MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_SYSTEMMODAL,
                0,
                &mut response,
                false,
            );
            if let Err(e) = r {
                log::warn!("fallback warning failed: {e}");
            }
        }
    }
}
