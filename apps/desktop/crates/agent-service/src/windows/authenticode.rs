//! Authenticode through `WinVerifyTrust`, with no online revocation check and cache-only URL
//! retrieval (it runs on every new process image, so it must not make a network call per
//! binary). The signer is the leaf certificate's simple display name.

use std::ffi::c_void;
use std::mem::size_of;
use std::path::Path;

use windows::Win32::Foundation::HWND;
use windows::Win32::Security::Cryptography::{CERT_NAME_SIMPLE_DISPLAY_TYPE, CertGetNameStringW};
use windows::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE,
    WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE, WTHelperGetProvCertFromChain,
    WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
};
use windows::core::PCWSTR;

/// Result of checking one file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Verification {
    /// The signature is present and trusted.
    pub trusted: bool,
    /// Signer subject; only set when `trusted`.
    pub signer: Option<String>,
}

/// Checks `path`. Any failure means "not trusted".
pub fn verify(path: &Path) -> Verification {
    let wpath = super::wide(path);
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wpath.as_ptr()),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    data.Anonymous.pFile = &mut file;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // INVALID_HANDLE_VALUE as the window handle: never show UI.
    let no_ui = HWND(usize::MAX as *mut c_void);

    // SAFETY: `data`, `file` and `wpath` outlive both calls; the state handle returned by the
    // VERIFY call is released by the CLOSE call below, whatever the outcome.
    unsafe {
        let status = WinVerifyTrust(no_ui, &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
        let mut out = Verification::default();
        if status == 0 {
            out.trusted = true;
            out.signer = signer_name(&data);
        }
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(no_ui, &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
        out
    }
}

/// The leaf signing certificate's name, from the provider data the VERIFY call left in
/// `data.hWVTStateData`.
///
/// # Safety
/// `data` must hold a live state handle from a successful `WTD_STATEACTION_VERIFY` call.
unsafe fn signer_name(data: &WINTRUST_DATA) -> Option<String> {
    unsafe {
        let prov = WTHelperProvDataFromStateData(data.hWVTStateData);
        if prov.is_null() {
            return None;
        }
        let signer = WTHelperGetProvSignerFromChain(prov, 0, false, 0);
        if signer.is_null() || (*signer).csCertChain == 0 {
            return None;
        }
        let cert = WTHelperGetProvCertFromChain(signer, 0);
        if cert.is_null() || (*cert).pCert.is_null() {
            return None;
        }
        let mut buf = [0u16; 512];
        let n = CertGetNameStringW((*cert).pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(&mut buf));
        // `n` counts the terminating NUL; 1 means an empty name.
        if n <= 1 {
            return None;
        }
        Some(super::from_wide(&buf))
    }
}

/// The signer subject when the file is signed and trusted.
pub fn signer(path: &Path) -> Option<String> {
    verify(path).signer
}
