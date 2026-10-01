//! `pkgutil --check-signature` output, for the update signer policy. The exact format was recorded
//! on a macos-15 runner (spec "Verified before implementation"):
//!
//! ```text
//! Package "x.pkg":
//!    Status: signed by a developer certificate issued by Apple for distribution
//!    Notarization: trusted by the Apple notary service
//!    Signed with a trusted timestamp on: 2026-10-01 10:00:00 +0000
//!    Certificate Chain:
//!     1. Developer ID Installer: Some Name (ABCDE12345)
//!        Expires: ...
//! ```
//!
//! An unsigned package prints `Status: no signature` and exits 1.

/// What the output says about a package.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PkgSignature {
    /// `Status:` says it is signed by a developer certificate.
    pub signed: bool,
    /// A `Notarization: trusted by the Apple notary service` line is present.
    pub notarized: bool,
    /// The Team ID in certificate 1, `Developer ID Installer: <Name> (<TEAMID>)`.
    pub team_id: Option<String>,
}

impl PkgSignature {
    /// The Team ID the update policy may use: only a signed, notarized package signed by a
    /// Developer ID Installer certificate has one.
    pub fn trusted_team_id(&self) -> Option<&str> {
        if self.signed && self.notarized {
            self.team_id.as_deref()
        } else {
            None
        }
    }
}

/// Parses `pkgutil --check-signature` output.
pub fn parse_check_signature(output: &str) -> PkgSignature {
    let mut sig = PkgSignature::default();
    for line in output.lines() {
        let t = line.trim();
        if let Some(status) = t.strip_prefix("Status:") {
            sig.signed = status.trim().starts_with("signed by a developer certificate");
        } else if let Some(n) = t.strip_prefix("Notarization:") {
            sig.notarized = n.trim().starts_with("trusted by the Apple notary service");
        } else if sig.team_id.is_none()
            && let Some(rest) = t.strip_prefix("1.")
        {
            sig.team_id = installer_team_id(rest.trim());
        }
    }
    sig
}

/// `Developer ID Installer: <Name> (<TEAMID>)` -> the Team ID (ten characters, upper-case letters
/// and digits).
fn installer_team_id(cert_line: &str) -> Option<String> {
    let rest = cert_line.strip_prefix("Developer ID Installer:")?.trim();
    let inner = rest.strip_suffix(')')?;
    let id = &inner[inner.rfind('(')? + 1..];
    (id.len() == 10 && id.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNED: &str = r#"Package "neo-0.2.0.pkg":
   Status: signed by a developer certificate issued by Apple for distribution
   Notarization: trusted by the Apple notary service
   Signed with a trusted timestamp on: 2026-10-01 10:00:00 +0000
   Certificate Chain:
    1. Developer ID Installer: Neo Contributors (AB12CD34EF)
       Expires: 2031-10-01 10:00:00 +0000
       SHA256 Fingerprint:
           00 11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00 11 22 33 44 55 66 77
           88 99 AA BB CC DD EE FF
       ------------------------------------------------------------------------
    2. Developer ID Certification Authority
       Expires: 2031-10-01 10:00:00 +0000
    3. Apple Root CA
"#;

    #[test]
    fn a_signed_notarized_package_yields_its_team_id() {
        let s = parse_check_signature(SIGNED);
        assert!(s.signed && s.notarized);
        assert_eq!(s.team_id.as_deref(), Some("AB12CD34EF"));
        assert_eq!(s.trusted_team_id(), Some("AB12CD34EF"));
    }

    #[test]
    fn signed_but_not_notarized_has_no_trusted_team_id() {
        let text = SIGNED.replace("   Notarization: trusted by the Apple notary service\n", "");
        let s = parse_check_signature(&text);
        assert!(s.signed && !s.notarized);
        assert_eq!(s.team_id.as_deref(), Some("AB12CD34EF"));
        assert_eq!(s.trusted_team_id(), None);
        let rejected = SIGNED.replace("trusted by the Apple notary service", "not notarized");
        assert_eq!(parse_check_signature(&rejected).trusted_team_id(), None);
    }

    #[test]
    fn an_unsigned_package_has_nothing() {
        let s = parse_check_signature("Package \"x.pkg\":\n   Status: no signature\n");
        assert_eq!(s, PkgSignature::default());
        assert_eq!(s.trusted_team_id(), None);
        assert_eq!(parse_check_signature(""), PkgSignature::default());
    }

    #[test]
    fn only_a_developer_id_installer_certificate_counts() {
        // A Developer ID Application certificate (or anything else) is not an installer signature.
        let app = SIGNED.replace("Developer ID Installer", "Developer ID Application");
        assert_eq!(parse_check_signature(&app).team_id, None);
        // A Team ID in a name that merely contains parentheses.
        let odd = SIGNED.replace("Neo Contributors (AB12CD34EF)", "Neo (Contributors) (AB12CD34EF)");
        assert_eq!(parse_check_signature(&odd).team_id.as_deref(), Some("AB12CD34EF"));
        // Not a Team ID shape.
        let bad = SIGNED.replace("AB12CD34EF", "ab12cd34ef");
        assert_eq!(parse_check_signature(&bad).team_id, None);
        let short = SIGNED.replace("AB12CD34EF", "AB12");
        assert_eq!(parse_check_signature(&short).team_id, None);
    }

    #[test]
    fn only_certificate_one_is_read() {
        let text = "   Status: signed by a developer certificate issued by Apple for distribution\n   Notarization: trusted by the Apple notary service\n    1. Developer ID Certification Authority\n    2. Developer ID Installer: Evil (ZZZZZZZZZZ)\n";
        assert_eq!(parse_check_signature(text).team_id, None);
    }
}
