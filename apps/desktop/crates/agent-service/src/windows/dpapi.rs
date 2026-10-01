//! DPAPI at machine scope for `device.bin`: any process on this machine running as SYSTEM or an
//! administrator can decrypt it, ordinary users cannot read the file at all (data directory ACL).

use std::io;

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};
use windows::core::w;

use crate::secrets::Protector;

pub struct DpapiProtector;

fn blob_of(data: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too large"))?,
        pbData: data.as_ptr() as *mut u8,
    })
}

/// Copies the output blob and frees the DPAPI allocation.
///
/// # Safety
/// `out` must have been filled by `CryptProtectData` / `CryptUnprotectData`.
unsafe fn take_blob(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    unsafe {
        let v = if out.pbData.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec()
        };
        if !out.pbData.is_null() {
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        }
        v
    }
}

fn other(e: windows::core::Error) -> io::Error {
    io::Error::other(e.to_string())
}

impl Protector for DpapiProtector {
    fn protect(&self, plain: &[u8]) -> io::Result<Vec<u8>> {
        let input = blob_of(plain)?;
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` points at `plain`, which outlives the call.
        unsafe {
            CryptProtectData(
                &input,
                w!("Neo device"),
                None,
                None,
                None,
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(other)?;
            Ok(take_blob(out))
        }
    }

    fn unprotect(&self, blob: &[u8]) -> io::Result<Vec<u8>> {
        let input = blob_of(blob)?;
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` points at `blob`, which outlives the call.
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).map_err(other)?;
            Ok(take_blob(out))
        }
    }
}
