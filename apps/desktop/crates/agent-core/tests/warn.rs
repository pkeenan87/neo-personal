mod common;

use common::t0;
use neo_agent_core::events::{Discovery, SignalEvent, UnwantedReason};
use neo_agent_core::warn::{ExpectedTool, WarningKind, decide, session_window, tool_toast};

fn expected() -> Vec<ExpectedTool> {
    vec![ExpectedTool {
        tool_id: "anydesk".into(),
        peer_ids: vec!["123456789".into()],
    }]
}

#[test]
fn tool_toast_rules() {
    assert!(tool_toast(Discovery::New, "anydesk", &[]));
    assert!(!tool_toast(Discovery::Baseline, "anydesk", &[]), "not for baseline");
    assert!(!tool_toast(Discovery::New, "anydesk", &expected()), "not for an expected tool");
    assert!(tool_toast(Discovery::New, "teamviewer", &expected()));
}

#[test]
fn session_window_rules() {
    let e = expected();
    assert!(!session_window("anydesk", Some("123456789"), &e), "expected tool and peer");
    assert!(session_window("anydesk", Some("999"), &e), "unknown peer");
    assert!(session_window("anydesk", None, &e), "no peer id always warns");
    assert!(
        session_window("teamviewer", Some("123456789"), &e),
        "peer of another tool does not count"
    );
    assert!(session_window("anydesk", Some("123456789"), &[]));
    // An expected tool with no known peers never silences a session.
    let none = vec![ExpectedTool {
        tool_id: "anydesk".into(),
        peer_ids: vec![],
    }];
    assert!(session_window("anydesk", Some("123456789"), &none));
}

#[test]
fn decide_maps_events_to_warnings() {
    let e = expected();
    let tool = |d| SignalEvent::remote_access_tool(t0(), "anydesk", "AnyDesk", None, None, d);
    assert_eq!(decide(&tool(Discovery::New), &[]), Some(WarningKind::Tool));
    assert_eq!(decide(&tool(Discovery::New), &e), None);
    assert_eq!(decide(&tool(Discovery::Baseline), &[]), None);
    assert_eq!(decide(&SignalEvent::remote_session(t0(), "anydesk", Some("123456789")), &e), None);
    assert_eq!(
        decide(&SignalEvent::remote_session(t0(), "anydesk", Some("5")), &e),
        Some(WarningKind::Session)
    );
    assert_eq!(
        decide(&SignalEvent::remote_session(t0(), "anydesk", None), &e),
        Some(WarningKind::Session)
    );
    let pup = SignalEvent::unwanted_software(t0(), "X", None, None, None, UnwantedReason::PublisherList, Discovery::New);
    assert_eq!(decide(&pup, &e), Some(WarningKind::Unwanted));
}
