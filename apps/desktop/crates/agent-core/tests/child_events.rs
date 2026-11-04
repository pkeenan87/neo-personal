//! Child-mode events on the wire. The server schema is `.strict()`, so each key set is exact.

mod common;

use neo_agent_core::events::{SignalEvent, TamperReason};
use neo_agent_core::policy::AppRef;
use serde_json::Value;

fn keys(e: &SignalEvent) -> Vec<String> {
    let v = serde_json::to_value(e).unwrap();
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn app_events_carry_names_only() {
    let app = AppRef {
        signer: Some("Roblox Corporation".into()),
        image: Some(r"C:\Users\Kid\Roblox\RobloxPlayerBeta.exe".into()),
        ..Default::default()
    };
    let e = SignalEvent::app_blocked(common::t0(), "Roblox", &app);
    let v: Value = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "software");
    assert_eq!(v["detector"], "app_blocked");
    assert_eq!(v["name"], "Roblox");
    assert_eq!(v["signer"], "Roblox Corporation");
    assert_eq!(v["image"], "RobloxPlayerBeta.exe", "a path is cut down to the file name");
    assert_eq!(keys(&e), ["detector", "id", "image", "name", "observedAt", "signer", "type"]);

    let mac = AppRef {
        bundle_id: Some("com.roblox.RobloxPlayer".into()),
        ..Default::default()
    };
    let e = SignalEvent::app_installed(common::t0(), "Roblox", &mac);
    assert_eq!(keys(&e), ["bundleId", "detector", "id", "name", "observedAt", "type"]);
    assert_eq!(serde_json::to_value(&e).unwrap()["detector"], "app_installed");

    // A bundle id the server would refuse is dropped, and a blank name falls back to the image.
    let bad = AppRef {
        bundle_id: Some("not a bundle id".into()),
        image: Some("x.exe".into()),
        ..Default::default()
    };
    let e = SignalEvent::app_installed(common::t0(), "  ", &bad);
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["name"], "x.exe");
    assert!(v.get("bundleId").is_none());

    // Over-long text is cut to the server's 128 characters.
    let long = "n".repeat(300);
    let e = SignalEvent::app_installed(common::t0(), &long, &mac);
    assert_eq!(serde_json::to_value(&e).unwrap()["name"].as_str().unwrap().len(), 128);
}

#[test]
fn usage_and_tamper_events() {
    let e = SignalEvent::screen_time_exhausted(common::t0());
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "usage");
    assert_eq!(v["detector"], "screen_time_exhausted");
    assert_eq!(keys(&e), ["detector", "id", "observedAt", "type"]);

    let e = SignalEvent::tamper_detected(common::t0(), TamperReason::BadPolicySignature);
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "tamper");
    assert_eq!(v["detector"], "tamper_detected");
    assert_eq!(v["reason"], "bad_policy_signature");
    assert_eq!(keys(&e), ["detector", "id", "observedAt", "reason", "type"]);
    for (r, s) in [
        (TamperReason::BrowserWithoutExtension, "browser_without_extension"),
        (TamperReason::VpnApp, "vpn_app"),
        (TamperReason::ClockChanged, "clock_changed"),
        (TamperReason::AgentServiceStopped, "agent_service_stopped"),
        (TamperReason::BadPolicySignature, "bad_policy_signature"),
    ] {
        assert_eq!(r.as_str(), s);
        assert_eq!(serde_json::to_value(r).unwrap(), s);
    }
}

#[test]
fn queued_child_events_survive_a_restart() {
    for e in [
        SignalEvent::screen_time_exhausted(common::t0()),
        SignalEvent::tamper_detected(common::t0(), TamperReason::VpnApp),
        SignalEvent::app_blocked(
            common::t0(),
            "Game",
            &AppRef {
                image: Some("game.exe".into()),
                ..Default::default()
            },
        ),
    ] {
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(serde_json::from_str::<SignalEvent>(&json).unwrap(), e);
    }
    // The type must match the detector.
    let bad = r#"{"id":"a","type":"usage","detector":"tamper_detected","observedAt":"2026-01-01T00:00:00Z","reason":"vpn_app"}"#;
    assert!(serde_json::from_str::<SignalEvent>(bad).is_err());
}
