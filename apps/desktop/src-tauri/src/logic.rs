//! The tray app's decisions, as pure functions: icon state, menu text, toast text, which requests
//! the web view may send. Everything here is tested without a window.

use serde_json::Value;
use time::OffsetDateTime;

/// A warning counts for the red-dot icon for this long.
pub const ALERT_WINDOW_SECS: i64 = 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconState {
    /// Shield: protecting.
    Shield,
    /// Grey: not enrolled, disconnected, or the service is not running.
    Grey,
    /// Red dot: a warning in the last hour.
    Alert,
}

pub fn icon_state(service_up: bool, state: Option<&str>, last_warning_unix: Option<i64>, now_unix: i64) -> IconState {
    if !service_up || state != Some("enrolled") {
        return IconState::Grey;
    }
    match last_warning_unix {
        Some(t) if now_unix - t < ALERT_WINDOW_SECS && now_unix >= t => IconState::Alert,
        _ => IconState::Shield,
    }
}

fn text<'a>(status: &'a Value, key: &str) -> Option<&'a str> {
    status.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The first, disabled menu line.
pub fn status_line(service_up: bool, status: Option<&Value>) -> String {
    if !service_up {
        return "Neo Protection isn't running".to_string();
    }
    let Some(s) = status else {
        return "Checking…".to_string();
    };
    match text(s, "state") {
        Some("enrolled") => {
            let whose = text(s, "memberName")
                .map(|m| format!("{m}'s computer"))
                .unwrap_or_else(|| "this computer".to_string());
            match text(s, "householdName") {
                Some(h) => format!("Protecting {whose} for {h}"),
                None => format!("Protecting {whose}"),
            }
        }
        Some("disconnected") => "This computer is no longer connected to a household".to_string(),
        _ => "Neo isn't set up on this computer".to_string(),
    }
}

/// "5 minutes ago".
pub fn ago(secs: i64) -> String {
    let secs = secs.max(0);
    match secs {
        0..=59 => "just now".to_string(),
        60..=3599 => {
            let m = secs / 60;
            format!("{m} minute{} ago", if m == 1 { "" } else { "s" })
        }
        3600..=86_399 => {
            let h = secs / 3600;
            format!("{h} hour{} ago", if h == 1 { "" } else { "s" })
        }
        _ => {
            let d = secs / 86_400;
            format!("{d} day{} ago", if d == 1 { "" } else { "s" })
        }
    }
}

pub fn parse_rfc3339_unix(s: &str) -> Option<i64> {
    OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|t| t.unix_timestamp())
}

/// The second, disabled menu line.
pub fn checkin_line(last_check_in: Option<&str>, now_unix: i64) -> String {
    match last_check_in.and_then(parse_rfc3339_unix) {
        Some(t) => format!("Last check-in: {}", ago(now_unix - t)),
        None => "Last check-in: never".to_string(),
    }
}

/// (title, body) of the toast for a tool or unwanted-software warning. `None` for a session or a
/// permission grant: those get the critical window.
pub fn toast_text(kind: &str, tool_name: &str) -> Option<(String, String)> {
    match kind {
        "tool" => Some((
            "Neo: remote-access program found".to_string(),
            format!("{tool_name} is on this computer. If someone on the phone asked you to install it, it is a scam. Hang up."),
        )),
        "unwanted" => Some((
            "Neo: unwanted software found".to_string(),
            format!("Neo found {tool_name}, which is known unwanted software."),
        )),
        // `session` and `permission` (macOS) get the critical window.
        _ => None,
    }
}

/// The ops the web view may send through `agent_request`. `subscribe` is the Rust side's own.
pub fn op_allowed(request: &Value) -> bool {
    matches!(
        request.get("op").and_then(Value::as_str),
        Some(
            "status"
                | "enroll_preview"
                | "enroll"
                | "self_enroll_start"
                | "self_enroll_poll"
                | "check_url"
                | "unenroll"
                | "probe_permissions"
        )
    )
}

/// The menu line that offers Full Disk Access (macOS), only while the daemon says it is missing.
/// `None` otherwise (Windows, unknown, or already granted): the item is then not in the menu. The
/// tray icon itself never changes for this, and nothing here ever notifies.
pub fn permissions_menu_text(status: Option<&Value>) -> Option<&'static str> {
    (status?.get("fullDiskAccess") == Some(&Value::Bool(false))).then_some("App permission checks are off: turn on\u{2026}")
}

/// Whether the status comes from a Mac (the Uninstall item is only there).
pub fn is_macos(status: Option<&Value>) -> bool {
    status.and_then(|s| s.get("platform")).and_then(Value::as_str) == Some("macos")
}

/// The System Settings panes that hold Full Disk Access, newest first. Hardcoded here: the web view
/// can only ask for "open Full Disk Access", never for an arbitrary address.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const FULL_DISK_ACCESS_LINKS: [&str; 2] = [
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
];

/// The daemon's bundle, revealed in Finder so it can be added with the + button.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const DAEMON_BUNDLE: &str = "/Library/Application Support/Neo/Neo Protection.app";
/// What "Uninstall Neo..." runs with administrator rights.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const UNINSTALL_SCRIPT: &str = "/Library/Application Support/Neo/Neo Protection.app/Contents/Resources/uninstall.sh";

/// The AppleScript that runs the uninstall script with the standard administrator password prompt.
/// The path is a fixed constant with no quote characters; nothing from the web view goes in.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn uninstall_applescript(script: &str) -> Option<String> {
    if script.contains(['"', '\'', '\\']) {
        return None;
    }
    Some(format!("do shell script \"/bin/sh '{script}'\" with administrator privileges"))
}

/// Only http(s) addresses are opened in the browser.
pub fn url_openable(url: &str) -> bool {
    let u = url.trim();
    (u.starts_with("https://") || u.starts_with("http://")) && !u.contains(char::is_whitespace) && u.len() <= 2048
}

/// A window label for a warning: event ids are uuids, but never trust the pipe.
pub fn warning_label(event_id: &str) -> String {
    let clean: String = event_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    format!("warning-{clean}")
}

/// The warning to show for a push, if it is well formed.
pub fn parse_warning(push: &Value) -> Option<Value> {
    if push.get("push").and_then(Value::as_str) != Some("warning") {
        return None;
    }
    let kind = push.get("kind").and_then(Value::as_str)?;
    if !matches!(kind, "tool" | "session" | "unwanted" | "permission")
        || text(push, "eventId").is_none()
        || text(push, "toolName").is_none()
    {
        return None;
    }
    let mut w = push.clone();
    w.as_object_mut()?.remove("push");
    Some(w)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn icon_states() {
        assert_eq!(icon_state(true, Some("enrolled"), None, 1000), IconState::Shield);
        assert_eq!(icon_state(true, Some("enrolled"), Some(1000 - 600), 1000), IconState::Alert);
        assert_eq!(icon_state(true, Some("enrolled"), Some(1000 - 7200), 1000), IconState::Shield);
        assert_eq!(icon_state(true, Some("not_enrolled"), None, 1000), IconState::Grey);
        assert_eq!(icon_state(true, Some("disconnected"), Some(999), 1000), IconState::Grey);
        assert_eq!(icon_state(false, Some("enrolled"), None, 1000), IconState::Grey);
        assert_eq!(icon_state(true, None, None, 1000), IconState::Grey);
    }

    #[test]
    fn status_lines() {
        let enrolled = json!({"state":"enrolled","memberName":"Grandma","householdName":"The Keenans"});
        assert_eq!(status_line(true, Some(&enrolled)), "Protecting Grandma's computer for The Keenans");
        assert_eq!(
            status_line(true, Some(&json!({"state":"enrolled","householdName":"H"}))),
            "Protecting this computer for H"
        );
        assert_eq!(
            status_line(true, Some(&json!({"state":"disconnected"}))),
            "This computer is no longer connected to a household"
        );
        assert_eq!(
            status_line(true, Some(&json!({"state":"not_enrolled"}))),
            "Neo isn't set up on this computer"
        );
        assert_eq!(status_line(false, Some(&enrolled)), "Neo Protection isn't running");
        assert_eq!(status_line(true, None), "Checking…");
    }

    #[test]
    fn check_in_text() {
        let now = parse_rfc3339_unix("2026-10-01T10:00:00Z").unwrap();
        assert_eq!(checkin_line(Some("2026-10-01T09:55:00Z"), now), "Last check-in: 5 minutes ago");
        assert_eq!(checkin_line(Some("2026-10-01T09:59:30Z"), now), "Last check-in: just now");
        assert_eq!(checkin_line(Some("2026-10-01T09:00:00Z"), now), "Last check-in: 1 hour ago");
        assert_eq!(checkin_line(Some("2026-09-28T10:00:00Z"), now), "Last check-in: 3 days ago");
        assert_eq!(checkin_line(None, now), "Last check-in: never");
        assert_eq!(checkin_line(Some("garbage"), now), "Last check-in: never");
    }

    #[test]
    fn toast_copy_matches_the_spec() {
        assert_eq!(
            toast_text("tool", "AnyDesk").unwrap().1,
            "AnyDesk is on this computer. If someone on the phone asked you to install it, it is a scam. Hang up."
        );
        assert_eq!(
            toast_text("unwanted", "Foo").unwrap().1,
            "Neo found Foo, which is known unwanted software."
        );
        assert!(toast_text("session", "AnyDesk").is_none());
        assert!(
            toast_text("permission", "AnyDesk").is_none(),
            "a permission grant is a window, not a toast"
        );
    }

    #[test]
    fn the_permissions_item_shows_only_while_full_disk_access_is_off() {
        assert_eq!(
            permissions_menu_text(Some(&json!({"fullDiskAccess": false}))),
            Some("App permission checks are off: turn on\u{2026}")
        );
        assert_eq!(permissions_menu_text(Some(&json!({"fullDiskAccess": true}))), None);
        assert_eq!(permissions_menu_text(Some(&json!({"fullDiskAccess": null}))), None, "Windows");
        assert_eq!(permissions_menu_text(Some(&json!({}))), None);
        assert_eq!(permissions_menu_text(None), None);
        assert!(is_macos(Some(&json!({"platform":"macos"}))));
        assert!(!is_macos(Some(&json!({"platform":"windows"}))));
        assert!(!is_macos(None));
    }

    #[test]
    fn the_settings_links_and_uninstall_command_are_fixed() {
        assert!(FULL_DISK_ACCESS_LINKS[0].ends_with("Privacy_AllFiles"));
        assert!(FULL_DISK_ACCESS_LINKS.iter().all(|l| l.starts_with("x-apple.systempreferences:")));
        assert_eq!(
            uninstall_applescript(UNINSTALL_SCRIPT).unwrap(),
            "do shell script \"/bin/sh '/Library/Application Support/Neo/Neo Protection.app/Contents/Resources/uninstall.sh'\" with administrator privileges"
        );
        assert!(UNINSTALL_SCRIPT.starts_with(DAEMON_BUNDLE));
        assert!(uninstall_applescript("/x/it's").is_none());
        assert!(uninstall_applescript("/x\"; do shell script \"evil").is_none());
    }

    #[test]
    fn the_web_view_cannot_subscribe_or_send_unknown_ops() {
        assert!(op_allowed(&json!({"op":"status"})));
        assert!(op_allowed(&json!({"op":"unenroll"})));
        assert!(op_allowed(&json!({"op":"probe_permissions"})));
        assert!(!op_allowed(&json!({"op":"subscribe"})));
        assert!(!op_allowed(&json!({"op":"rm"})));
        assert!(!op_allowed(&json!({})));
        assert!(!op_allowed(&json!({"op":5})));
    }

    #[test]
    fn only_web_addresses_open() {
        assert!(url_openable("https://neo.test/a?b=c"));
        assert!(url_openable("http://localhost:3000"));
        assert!(!url_openable("file:///C:/Windows/system32/calc.exe"));
        assert!(!url_openable("ms-settings:"));
        assert!(!url_openable("https://a b"));
    }

    #[test]
    fn labels_and_warning_parsing() {
        assert_eq!(warning_label("0f2e-AB/../x"), "warning-0f2e-ABx");
        let push = json!({"push":"warning","eventId":"e1","kind":"session","toolName":"AnyDesk","severity":"critical","ownerName":"Pat","ownerTold":false});
        let w = parse_warning(&push).unwrap();
        assert!(w.get("push").is_none());
        assert_eq!(w["kind"], "session");
        let perm = json!({"push":"warning","eventId":"e2","kind":"permission","toolName":"AnyDesk","service":"accessibility","severity":"critical","ownerName":"Pat","ownerTold":false});
        let w = parse_warning(&perm).unwrap();
        assert_eq!(w["kind"], "permission");
        assert_eq!(w["service"], "accessibility");
        assert!(parse_warning(&json!({"push":"status_changed"})).is_none());
        assert!(parse_warning(&json!({"push":"warning","kind":"nope","eventId":"e","toolName":"x"})).is_none());
        assert!(parse_warning(&json!({"push":"warning","kind":"tool","toolName":"x"})).is_none());
    }
}
