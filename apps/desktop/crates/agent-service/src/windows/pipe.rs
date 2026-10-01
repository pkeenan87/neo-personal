//! The named-pipe server `\\.\pipe\neo-agent`: DACL SYSTEM full and INTERACTIVE read/write,
//! remote clients refused, the first instance claimed exclusively so nothing can squat the name.

use std::fs::File;
use std::io;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::{ERROR_PIPE_CONNECTED, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::core::{PCWSTR, w};

use crate::agent::Agent;
use crate::config::PIPE_NAME;
use crate::ipc::{ConnectionGate, serve_connection};

/// SYSTEM: all access. INTERACTIVE (anyone signed in at the keyboard or over RDP): read/write.
/// No other ACE, so remote and service accounts are refused.
const PIPE_SDDL: PCWSTR = w!("D:(A;;GA;;;SY)(A;;GRGW;;;IU)");

const BUFFER: u32 = 64 * 1024;

fn create_instance(first: bool) -> io::Result<HANDLE> {
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: `sd` receives a LocalAlloc'd descriptor that is freed below; the SECURITY_ATTRIBUTES
    // only needs to live until CreateNamedPipeW returns (the system copies the descriptor).
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PIPE_SDDL, SDDL_REVISION_1, &mut sd, None)
            .map_err(|e| io::Error::other(e.to_string()))?;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: false.into(),
        };
        let mut open_mode = PIPE_ACCESS_DUPLEX;
        if first {
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }
        let handle = CreateNamedPipeW(
            PCWSTR(super::wide(PIPE_NAME).as_ptr()),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER,
            BUFFER,
            0,
            Some(&sa),
        );
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        if handle.is_invalid() {
            return Err(io::Error::last_os_error());
        }
        Ok(handle)
    }
}

/// Accepts connections until `stop` is set; each is served on its own thread. [`wake`] unblocks
/// the accept.
pub fn serve(agent: Arc<Agent>, stop: Arc<AtomicBool>) {
    let gate = Arc::new(ConnectionGate::default());
    let mut first = true;
    while !stop.load(Ordering::SeqCst) {
        let handle = match create_instance(first) {
            Ok(h) => h,
            Err(e) => {
                log::error!("could not create the pipe: {e}");
                std::thread::sleep(std::time::Duration::from_secs(5));
                continue;
            }
        };
        first = false;
        // SAFETY: `handle` is a valid pipe handle we own; ConnectNamedPipe blocks until a client
        // connects. ERROR_PIPE_CONNECTED means one connected between create and connect.
        let connected = unsafe {
            match ConnectNamedPipe(handle, None) {
                Ok(()) => true,
                Err(e) => e.code() == ERROR_PIPE_CONNECTED.to_hresult(),
            }
        };
        // SAFETY: from here the File owns the handle and closes it on drop.
        let file = unsafe { File::from_raw_handle(handle.0 as RawHandle) };
        if !connected || stop.load(Ordering::SeqCst) {
            continue;
        }
        let Some(permit) = gate.try_acquire() else { continue };
        let Ok(read) = file.try_clone() else { continue };
        let agent = agent.clone();
        std::thread::spawn(move || {
            let _permit = permit;
            serve_connection(&agent, read, file);
        });
    }
}

/// Connects once so a blocked `ConnectNamedPipe` returns and the loop sees `stop`.
pub fn wake() {
    let _ = std::fs::OpenOptions::new().read(true).write(true).open(PIPE_NAME);
}
