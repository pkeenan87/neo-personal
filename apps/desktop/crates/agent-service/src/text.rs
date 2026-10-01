//! The words shown when the service has to speak without the tray app (the `WTSSendMessageW`
//! fallback). The tray app shows the same text; the copy is in `_specs/desktop-agent.md`.

use neo_agent_core::warn::WarningKind;

/// What an app can now do, by TCC service (`screen_recording`, `accessibility`, `full_disk_access`);
/// anything else (or none) is the general "see and control this Mac".
pub fn permission_phrase(service: Option<&str>) -> &'static str {
    match service {
        Some("screen_recording") => "see your screen",
        Some("accessibility") => "control this Mac",
        Some("full_disk_access") => "read all your files",
        _ => "see and control this Mac",
    }
}

/// (title, body) for a fallback message box. `service` is only used by `permission` warnings.
pub fn fallback_text(kind: WarningKind, tool_name: &str, service: Option<&str>) -> (String, String) {
    match kind {
        WarningKind::Permission => (
            "Neo: an app can now control this Mac".to_string(),
            format!(
                "{tool_name} can now {}. If someone on the phone asked you to allow this, it is a scam. \
                 Hang up, then open System Settings \u{2192} Privacy & Security and turn it off.",
                permission_phrase(service)
            ),
        ),
        WarningKind::Session => (
            "Neo: someone is connected to this computer".to_string(),
            format!(
                "Someone is connected to this computer with {tool_name}. If someone called you and asked for this, it is a scam. \
                 Hang up the phone and restart your computer. Do not log in to your bank."
            ),
        ),
        WarningKind::Tool => (
            "Neo: remote-access program found".to_string(),
            format!("{tool_name} is on this computer. If someone on the phone asked you to install it, it is a scam. Hang up."),
        ),
        WarningKind::Unwanted => (
            "Neo: unwanted software found".to_string(),
            format!("Neo found {tool_name}, which is known unwanted software."),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_copy_matches_the_spec() {
        let (_, body) = fallback_text(WarningKind::Session, "AnyDesk", None);
        assert!(body.starts_with("Someone is connected to this computer with AnyDesk."));
        assert!(body.contains("Hang up the phone and restart your computer. Do not log in to your bank."));
        let (_, tool) = fallback_text(WarningKind::Tool, "AnyDesk", None);
        assert_eq!(
            tool,
            "AnyDesk is on this computer. If someone on the phone asked you to install it, it is a scam. Hang up."
        );
    }

    #[test]
    fn permission_copy_matches_the_spec_and_adapts_to_the_service() {
        let tail = "If someone on the phone asked you to allow this, it is a scam. Hang up, then open System Settings \u{2192} Privacy & Security and turn it off.";
        for (svc, what) in [
            (None, "see and control this Mac"),
            (Some("screen_recording"), "see your screen"),
            (Some("accessibility"), "control this Mac"),
            (Some("full_disk_access"), "read all your files"),
        ] {
            let (_, body) = fallback_text(WarningKind::Permission, "AnyDesk", svc);
            assert_eq!(body, format!("AnyDesk can now {what}. {tail}"));
        }
    }
}
