//! The words shown when the service has to speak without the tray app (the `WTSSendMessageW`
//! fallback). The tray app shows the same text; the copy is in `_specs/desktop-agent.md`.

use neo_agent_core::warn::WarningKind;

/// (title, body) for a fallback message box.
pub fn fallback_text(kind: WarningKind, tool_name: &str) -> (String, String) {
    match kind {
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
        let (_, body) = fallback_text(WarningKind::Session, "AnyDesk");
        assert!(body.starts_with("Someone is connected to this computer with AnyDesk."));
        assert!(body.contains("Hang up the phone and restart your computer. Do not log in to your bank."));
        let (_, tool) = fallback_text(WarningKind::Tool, "AnyDesk");
        assert_eq!(
            tool,
            "AnyDesk is on this computer. If someone on the phone asked you to install it, it is a scam. Hang up."
        );
    }
}
