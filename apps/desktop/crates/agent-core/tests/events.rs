mod common;

use neo_agent_core::events::{Discovery, SignalEvent, UnwantedReason, clean_peer_id};
use serde_json::Value;

fn keys(e: &SignalEvent) -> Vec<String> {
    let v = serde_json::to_value(e).unwrap();
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn tool_event_wire_shape() {
    let e = SignalEvent::remote_access_tool(
        common::t0(),
        "anydesk",
        "AnyDesk",
        Some("AnyDesk Software GmbH"),
        Some("8.0"),
        Discovery::Baseline,
    );
    let v: Value = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "software");
    assert_eq!(v["detector"], "remote_access_tool");
    assert_eq!(v["toolId"], "anydesk");
    assert_eq!(v["discovery"], "baseline");
    assert!(v["observedAt"].as_str().unwrap().ends_with('Z'));
    assert!(uuid_ok(v["id"].as_str().unwrap()));
    assert_eq!(
        keys(&e),
        [
            "detector",
            "discovery",
            "id",
            "name",
            "observedAt",
            "publisher",
            "toolId",
            "type",
            "version"
        ]
    );
}

fn uuid_ok(s: &str) -> bool {
    s.len() == 36 && s.as_bytes()[14] == b'4'
}

#[test]
fn new_discovery_is_omitted_and_optionals_dropped() {
    let e = SignalEvent::remote_access_tool(common::t0(), "anydesk", "AnyDesk", None, Some("  "), Discovery::New);
    assert_eq!(keys(&e), ["detector", "id", "name", "observedAt", "toolId", "type"]);
}

#[test]
fn unwanted_event_wire_shape() {
    let e = SignalEvent::unwanted_software(
        common::t0(),
        "Toolbar",
        Some("Mindspark"),
        None,
        Some(&"AB".repeat(32)),
        UnwantedReason::UnsignedUnknown,
        Discovery::New,
    );
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "software");
    assert_eq!(v["reason"], "unsigned_unknown");
    assert_eq!(v["sha256"], "ab".repeat(32));
    assert_eq!(
        keys(&e),
        ["detector", "id", "name", "observedAt", "publisher", "reason", "sha256", "type"]
    );
    // A malformed hash is dropped, not sent.
    let e = SignalEvent::unwanted_software(common::t0(), "T", None, None, Some("xyz"), UnwantedReason::HashList, Discovery::New);
    assert!(serde_json::to_value(&e).unwrap().get("sha256").is_none());
}

#[test]
fn session_event_wire_shape_and_roundtrip() {
    let e = SignalEvent::remote_session(common::t0(), "anydesk", Some("123 456 789"));
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "remote_session");
    assert_eq!(v["detector"], "remote_access_session");
    assert_eq!(v["direction"], "incoming");
    assert_eq!(v["peerId"], "123 456 789");
    assert_eq!(keys(&e), ["detector", "direction", "id", "observedAt", "peerId", "toolId", "type"]);
    let back: SignalEvent = serde_json::from_value(v).unwrap();
    assert_eq!(back, e);
}

#[test]
fn mismatched_type_is_rejected_on_read() {
    let bad = r#"{"id":"x","type":"page","detector":"remote_access_session","observedAt":"2026-10-01T10:00:00Z","toolId":"a","direction":"incoming"}"#;
    assert!(serde_json::from_str::<SignalEvent>(bad).is_err());
}

#[test]
fn long_text_is_bounded() {
    let long = "x".repeat(300);
    let e = SignalEvent::remote_access_tool(common::t0(), "t", &long, None, None, Discovery::New);
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["name"].as_str().unwrap().len(), 128);
}

#[test]
fn peer_id_cleaning() {
    assert_eq!(clean_peer_id("  123 456 789 ").as_deref(), Some("123 456 789"));
    assert_eq!(clean_peer_id("a<b>c;d\"e").as_deref(), Some("abcde"));
    assert_eq!(clean_peer_id("user@host.example-1_x").as_deref(), Some("user@host.example-1_x"));
    assert_eq!(clean_peer_id("<<>>"), None);
    assert_eq!(clean_peer_id(&"9".repeat(100)).unwrap().len(), 64);
}
