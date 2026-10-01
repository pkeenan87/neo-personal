//! Code-signing facts through the Security framework (`SecStaticCodeCreateWithPath`,
//! `SecStaticCodeCheckValidity`, `SecCodeCopySigningInformation`). The only other crate involved
//! is `core-foundation` for the CFString/CFURL plumbing. `security-framework-sys` has no binding for
//! `SecCodeCopySigningInformation` or the `kSecCodeInfo*` keys, so those are declared here.
//!
//! Nothing here is trusted from the file's own claims: a Team ID is reported only when the
//! signature validates against the Developer ID requirement, and an Apple signing identifier only
//! when it validates against `anchor apple`. An ad-hoc or broken signature reports nothing.

use std::ffi::c_void;
use std::path::Path;
use std::ptr;

use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation::url::CFURL;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation_sys::base::{CFRelease, CFTypeRef, OSStatus};
use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
use core_foundation_sys::string::CFStringRef;
use security_framework_sys::base::SecCertificateRef;
use security_framework_sys::certificate::SecCertificateCopySubjectSummary;
use security_framework_sys::code_signing::{
    SecCSFlags, SecRequirementCreateWithString, SecRequirementRef, SecStaticCodeCheckValidity, SecStaticCodeCreateWithPath,
    SecStaticCodeRef, kSecCSDoNotValidateResources, kSecCSNoNetworkAccess,
};

/// `kSecCSSigningInformation` (`1 << 1` in SecCode.h).
const SIGNING_INFORMATION: SecCSFlags = 1 << 1;
/// Validate the executable, skip the (large) resource tree, never touch the network.
const CHECK_FLAGS: SecCSFlags = kSecCSDoNotValidateResources | kSecCSNoNetworkAccess;

/// Developer ID Application: Apple's generic anchor, the Developer ID intermediate and the
/// Developer ID Application leaf extension.
const DEVELOPER_ID: &str =
    "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]";
const APPLE: &str = "anchor apple";

#[link(name = "Security", kind = "framework")]
#[allow(non_upper_case_globals)]
unsafe extern "C" {
    static kSecCodeInfoIdentifier: CFStringRef;
    static kSecCodeInfoTeamIdentifier: CFStringRef;
    static kSecCodeInfoCertificates: CFStringRef;
    fn SecCodeCopySigningInformation(code: SecStaticCodeRef, flags: SecCSFlags, information: *mut CFDictionaryRef) -> OSStatus;
}

/// What the signature of one bundle or executable says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodeInfo {
    /// The signing identifier, only for validated Developer ID or Apple signatures.
    pub identifier: Option<String>,
    /// The Team ID, only when the signature validates as Developer ID.
    pub team_id: Option<String>,
    /// The signer's name from the leaf certificate (`Developer ID Application: <Name> (<TEAM>)`
    /// without the prefix and Team ID), only when it validates as Developer ID.
    pub signer: Option<String>,
    /// Valid against the Developer ID requirement.
    pub developer_id: bool,
    /// Valid against `anchor apple`.
    pub apple: bool,
}

/// # Safety
/// `value` must be a `CFStringRef` (or null) that outlives the call.
unsafe fn cf_string(value: *const c_void) -> Option<String> {
    if value.is_null() {
        return None;
    }
    // SAFETY: the caller guarantees a CFString; the get rule retains it for the wrapper's life.
    let s = unsafe { CFString::wrap_under_get_rule(value as CFStringRef) }.to_string();
    (!s.is_empty()).then_some(s)
}

fn valid_against(code: SecStaticCodeRef, requirement: &str) -> bool {
    let text = CFString::new(requirement);
    let mut req: SecRequirementRef = ptr::null_mut();
    // SAFETY: `text` is a live CFString; `req` receives a retained requirement that is released below.
    unsafe {
        if SecRequirementCreateWithString(text.as_concrete_TypeRef(), 0, &mut req) != 0 || req.is_null() {
            return false;
        }
        let status = SecStaticCodeCheckValidity(code, CHECK_FLAGS, req);
        CFRelease(req as CFTypeRef);
        status == 0
    }
}

/// `Developer ID Application: Some Name (ABCDE12345)` -> `Some Name`.
pub fn signer_name(subject_summary: &str, team_id: Option<&str>) -> String {
    let s = subject_summary
        .strip_prefix("Developer ID Application:")
        .unwrap_or(subject_summary)
        .trim();
    match team_id {
        Some(t) => s.strip_suffix(&format!("({t})")).unwrap_or(s).trim().to_string(),
        None => s.to_string(),
    }
}

/// The signature facts of the bundle or file at `path`.
pub fn inspect(path: &Path) -> CodeInfo {
    let Some(url) = CFURL::from_path(path, path.is_dir()) else {
        return CodeInfo::default();
    };
    let mut code: SecStaticCodeRef = ptr::null_mut();
    // SAFETY: `url` is live; `code` receives a retained static code that is released before returning.
    unsafe {
        if SecStaticCodeCreateWithPath(url.as_concrete_TypeRef(), 0, &mut code) != 0 || code.is_null() {
            return CodeInfo::default();
        }
    }
    let developer_id = valid_against(code, DEVELOPER_ID);
    let apple = !developer_id && valid_against(code, APPLE);
    let mut info = CodeInfo {
        developer_id,
        apple,
        ..CodeInfo::default()
    };
    if developer_id || apple {
        let mut dict: CFDictionaryRef = ptr::null();
        // SAFETY: `dict` receives a retained dictionary released below; the keys are framework constants;
        // every value read from it is used before the dictionary is released.
        unsafe {
            if SecCodeCopySigningInformation(code, SIGNING_INFORMATION, &mut dict) == 0 && !dict.is_null() {
                info.identifier = cf_string(CFDictionaryGetValue(dict, kSecCodeInfoIdentifier as *const c_void));
                if developer_id {
                    info.team_id = cf_string(CFDictionaryGetValue(dict, kSecCodeInfoTeamIdentifier as *const c_void));
                    let certs = CFDictionaryGetValue(dict, kSecCodeInfoCertificates as *const c_void) as CFArrayRef;
                    if !certs.is_null() && CFArrayGetCount(certs) > 0 {
                        let leaf = CFArrayGetValueAtIndex(certs, 0) as SecCertificateRef;
                        let summary = SecCertificateCopySubjectSummary(leaf);
                        if !summary.is_null() {
                            let text = CFString::wrap_under_create_rule(summary).to_string();
                            info.signer = Some(signer_name(&text, info.team_id.as_deref()));
                        }
                    }
                }
                CFRelease(dict as CFTypeRef);
            }
        }
    }
    // SAFETY: balances the create rule of SecStaticCodeCreateWithPath.
    unsafe { CFRelease(code as CFTypeRef) };
    if !developer_id {
        info.team_id = None;
        info.signer = None;
    }
    if !(developer_id || apple) {
        info.identifier = None;
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signer_names_lose_the_prefix_and_team_id() {
        assert_eq!(
            signer_name("Developer ID Application: AnyDesk Software GmbH (ABCDE12345)", Some("ABCDE12345")),
            "AnyDesk Software GmbH"
        );
        assert_eq!(signer_name("Developer ID Application: Name", None), "Name");
        assert_eq!(signer_name("Plain", Some("X")), "Plain");
    }

    #[test]
    fn apple_software_validates_against_the_apple_anchor() {
        // A platform binary signed by Apple: valid against `anchor apple`, no Team ID, a com.apple.* identifier.
        let info = inspect(Path::new("/bin/ls"));
        assert!(info.apple, "{info:?}");
        assert!(!info.developer_id);
        assert_eq!(info.team_id, None);
        assert!(info.identifier.as_deref().is_some_and(|i| i.starts_with("com.apple.")));
    }

    #[test]
    fn a_missing_or_unsigned_file_reports_nothing() {
        assert_eq!(inspect(Path::new("/nonexistent/thing.app")), CodeInfo::default());
        let tmp = std::env::temp_dir().join(format!("neo-unsigned-{}", std::process::id()));
        std::fs::write(&tmp, b"#!/bin/sh\n").unwrap();
        assert_eq!(inspect(&tmp), CodeInfo::default());
        let _ = std::fs::remove_file(&tmp);
    }
}
