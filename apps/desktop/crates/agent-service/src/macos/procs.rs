//! Process listing through libproc (`proc_listallpids`, `proc_pidpath`), via the `libc` crate.
//! Running as root, every process's path is visible.

use std::ffi::c_void;

/// `PROC_PIDPATHINFO_MAXSIZE` (4 * MAXPATHLEN).
const PATH_BUF: usize = 4096;
/// More processes than this are not listed.
const MAX_PIDS: usize = 16_384;

/// Every process id. The buffer is generous and zero-filled, and the count the call returns is
/// not trusted (libproc has returned both a count and a byte size over the years): entries that
/// are zero are dropped instead.
pub fn list_pids() -> Vec<i32> {
    // SAFETY: a NULL buffer with size 0 asks only for the size needed.
    let need = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if need <= 0 {
        return Vec::new();
    }
    let cap = ((need as usize) * 2 + 64).min(MAX_PIDS);
    let mut buf = vec![0i32; cap];
    // SAFETY: `buf` is valid for `cap * 4` bytes, which is what is passed.
    let got = unsafe { libc::proc_listallpids(buf.as_mut_ptr() as *mut c_void, (cap * std::mem::size_of::<i32>()) as libc::c_int) };
    if got <= 0 {
        return Vec::new();
    }
    buf.into_iter().filter(|p| *p > 0).collect()
}

/// The executable path of `pid`, `None` when it cannot be read (the process ended, or is protected).
pub fn pid_path(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; PATH_BUF];
    // SAFETY: `buf` is valid for PATH_BUF bytes.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, PATH_BUF as u32) };
    if n <= 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[..n as usize]).to_string())
}
