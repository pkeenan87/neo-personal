mod common;

use common::t0;
use neo_agent_core::detect::detect_tcc;
use neo_agent_core::events::{EventBody, SignalEvent, TccService, valid_bundle_id};
use neo_agent_core::snapshot::{AppBundle, TccRow};
use neo_agent_core::state::SeenState;
use time::Duration;

const SC: &str = "kTCCServiceScreenCapture";
const AX: &str = "kTCCServiceAccessibility";
const FDA: &str = "kTCCServiceSystemPolicyAllFiles";

fn row(client: &str, service: &str, auth_value: i64) -> TccRow {
    TccRow {
        db: "system".into(),
        service: service.into(),
        client: client.into(),
        client_type: 0,
        auth_value,
    }
}

fn run(seen: &mut SeenState, rows: Option<&[TccRow]>, step: i64) -> Vec<SignalEvent> {
    detect_tcc(seen, rows, &[], t0() + Duration::seconds(step))
}

fn grants(evs: &[SignalEvent]) -> Vec<(String, Option<String>, TccService)> {
    evs.iter()
        .map(|e| match &e.body {
            EventBody::TccGrant { app, bundle_id, service } => (app.clone(), bundle_id.clone(), *service),
            _ => panic!("not a tcc_grant"),
        })
        .collect()
}

#[test]
fn first_readable_snapshot_is_a_silent_baseline() {
    let mut seen = SeenState::default();
    let rows = [row("us.zoom.xos", SC, 2), row("com.a.b", AX, 2), row("com.c.d", FDA, 2)];
    assert!(run(&mut seen, Some(&rows), 0).is_empty());
    assert!(seen.tcc_baselined());
    assert!(run(&mut seen, Some(&rows), 30).is_empty(), "still nothing on the next pass");
}

#[test]
fn unreadable_snapshot_leaves_state_untouched() {
    let mut seen = SeenState::default();
    assert!(run(&mut seen, None, 0).is_empty());
    assert!(!seen.tcc_baselined(), "None is not a baseline");
    // The first readable snapshot after that is still the baseline, even if it is full of grants.
    assert!(run(&mut seen, Some(&[row("com.a.b", SC, 2)]), 30).is_empty());
    // A None in the middle does not erase what was recorded.
    assert!(run(&mut seen, None, 60).is_empty());
    assert!(run(&mut seen, Some(&[row("com.a.b", SC, 2)]), 90).is_empty());
}

#[test]
fn transition_to_allowed_is_sent_once() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[]), 0);
    let rows = [row("com.example.helper", SC, 2)];
    let evs = run(&mut seen, Some(&rows), 30);
    assert_eq!(
        grants(&evs),
        [(
            "com.example.helper".into(),
            Some("com.example.helper".into()),
            TccService::ScreenRecording
        )]
    );
    assert!(run(&mut seen, Some(&rows), 60).is_empty());
}

#[test]
fn not_allowed_to_allowed_is_a_transition() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[row("com.a.b", AX, 0)]), 0);
    let evs = run(&mut seen, Some(&[row("com.a.b", AX, 2)]), 30);
    assert_eq!(grants(&evs).len(), 1);
    // Values 1 (unknown) and 3 (limited) are not allowed.
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[]), 0);
    assert!(run(&mut seen, Some(&[row("com.a.b", AX, 1), row("com.c.d", SC, 3)]), 30).is_empty());
}

#[test]
fn reapproval_of_an_allowed_row_sends_nothing() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[row("us.zoom.xos", SC, 2)]), 0);
    // Sequoia touches `last_modified`; the row stays allowed (the column is not even read).
    for i in 1..4 {
        assert!(run(&mut seen, Some(&[row("us.zoom.xos", SC, 2)]), i * 30).is_empty());
    }
}

#[test]
fn revoke_then_regrant_sends_again() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[row("com.a.b", SC, 2)]), 0);
    assert!(run(&mut seen, Some(&[row("com.a.b", SC, 0)]), 30).is_empty(), "revoke");
    assert_eq!(grants(&run(&mut seen, Some(&[row("com.a.b", SC, 2)]), 60)).len(), 1);
    // The row disappearing counts as a revoke too.
    assert!(run(&mut seen, Some(&[]), 90).is_empty());
    assert_eq!(grants(&run(&mut seen, Some(&[row("com.a.b", SC, 2)]), 120)).len(), 1);
}

#[test]
fn services_are_mapped_and_others_ignored() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[]), 0);
    let rows = [
        row("com.a.b", SC, 2),
        row("com.a.b", AX, 2),
        row("com.a.b", FDA, 2),
        row("com.a.b", "kTCCServiceCamera", 2),
        row("com.a.b", "kTCCServiceMicrophone", 2),
        row("com.a.b", "kTCCServiceListenEvent", 2),
    ];
    let services: Vec<_> = grants(&run(&mut seen, Some(&rows), 30)).into_iter().map(|g| g.2).collect();
    assert_eq!(
        services,
        [TccService::ScreenRecording, TccService::Accessibility, TccService::FullDiskAccess]
    );
}

#[test]
fn neos_own_bundles_are_ignored() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[]), 0);
    let rows = [
        row("dev.neoshield.agent", FDA, 2),
        row("dev.neoshield.desktop", SC, 2),
        row("Dev.NeoShield.Agent", AX, 2),
    ];
    assert!(run(&mut seen, Some(&rows), 30).is_empty());
}

#[test]
fn bundle_and_path_clients() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[]), 0);
    let path_row = TccRow {
        client_type: 1,
        ..row("/Applications/Some Tool.app/Contents/MacOS/helper", SC, 2)
    };
    let bundles = [AppBundle {
        path: "/Applications/AnyDesk.app".into(),
        bundle_id: Some("com.philandro.anydesk".into()),
        name: "AnyDesk".into(),
        ..Default::default()
    }];
    let rows = [row("com.philandro.anydesk", AX, 2), path_row, row("com.unknown.app", FDA, 2)];
    let evs = detect_tcc(&mut seen, Some(&rows), &bundles, t0());
    assert_eq!(
        grants(&evs),
        [
            ("AnyDesk".into(), Some("com.philandro.anydesk".into()), TccService::Accessibility),
            ("helper".into(), None, TccService::ScreenRecording),
            ("com.unknown.app".into(), Some("com.unknown.app".into()), TccService::FullDiskAccess),
        ]
    );
}

#[test]
fn same_client_in_two_databases_is_one_event() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[]), 0);
    let mut user = row("com.a.b", SC, 2);
    user.db = "user:501".into();
    let evs = run(&mut seen, Some(&[row("com.a.b", SC, 2), user]), 30);
    assert_eq!(grants(&evs).len(), 1);
}

#[test]
fn event_shape_matches_the_wire_schema() {
    let e = SignalEvent::tcc_grant(t0(), "AnyDesk", Some("com.philandro.anydesk"), TccService::FullDiskAccess);
    let v = serde_json::to_value(&e).unwrap();
    let keys: std::collections::BTreeSet<_> = v.as_object().unwrap().keys().cloned().collect();
    let want: std::collections::BTreeSet<_> = ["id", "type", "detector", "observedAt", "app", "bundleId", "service"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(keys, want);
    assert_eq!(v["type"], "permission");
    assert_eq!(v["detector"], "tcc_grant");
    assert_eq!(v["service"], "full_disk_access");
    // Round trip, and an event without a bundle id omits the key.
    assert_eq!(serde_json::from_value::<SignalEvent>(v).unwrap(), e);
    let v = serde_json::to_value(SignalEvent::tcc_grant(t0(), "helper", None, TccService::Accessibility)).unwrap();
    assert!(v.get("bundleId").is_none());
}

#[test]
fn invalid_bundle_id_is_dropped_and_app_is_bounded() {
    for bad in ["", "nodots", "com..x", "com.a b", "com.a/b", ".com.a", "com.", "-a.b", "com.é"] {
        assert!(!valid_bundle_id(bad), "{bad:?}");
        let v = serde_json::to_value(SignalEvent::tcc_grant(t0(), "App", Some(bad), TccService::Accessibility)).unwrap();
        assert!(v.get("bundleId").is_none(), "{bad:?}");
    }
    for good in ["com.a", "a.b-c.D1", "dev.neoshield.agent"] {
        assert!(valid_bundle_id(good), "{good:?}");
    }
    assert!(!valid_bundle_id(&format!("com.{}", "a".repeat(252))), "over 255");
    let v = serde_json::to_value(SignalEvent::tcc_grant(t0(), &"x".repeat(300), None, TccService::Accessibility)).unwrap();
    assert_eq!(v["app"].as_str().unwrap().len(), 128);
    let v = serde_json::to_value(SignalEvent::tcc_grant(t0(), "  ", Some("com.a.b"), TccService::Accessibility)).unwrap();
    assert_eq!(v["app"], "com.a.b");
}

#[test]
fn tcc_state_survives_a_restart_and_old_files_load() {
    let mut seen = SeenState::default();
    run(&mut seen, Some(&[row("com.a.b", SC, 2)]), 0);
    let mut seen = SeenState::from_json(&seen.to_json());
    assert!(run(&mut seen, Some(&[row("com.a.b", SC, 2)]), 30).is_empty());
    assert_eq!(
        grants(&run(&mut seen, Some(&[row("com.a.b", SC, 2), row("com.c.d", AX, 2)]), 60)).len(),
        1
    );
    // A seen.json written before TCC existed starts un-baselined.
    let old = SeenState::from_json(r#"{"tools":{},"programs":{},"sessions":{},"unsigned_unknown":{"day":"","count":0}}"#);
    assert!(!old.tcc_baselined());
}
