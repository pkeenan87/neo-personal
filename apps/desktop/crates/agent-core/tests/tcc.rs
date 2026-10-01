mod common;

use common::t0;
use neo_agent_core::detect::detect_tcc;
use neo_agent_core::events::{EventBody, SignalEvent, TccService, valid_bundle_id};
use neo_agent_core::snapshot::{AppBundle, TccRow, TccSnapshot};
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

/// A snapshot that read the system database plus every user database that has rows.
fn snap(rows: &[TccRow]) -> TccSnapshot {
    let mut dbs_read = vec!["system".to_string()];
    for r in rows {
        if !dbs_read.contains(&r.db) {
            dbs_read.push(r.db.clone());
        }
    }
    TccSnapshot {
        dbs_read,
        rows: rows.to_vec(),
    }
}

fn run(seen: &mut SeenState, rows: Option<&[TccRow]>, step: i64) -> Vec<SignalEvent> {
    detect_tcc(seen, rows.map(snap).as_ref(), &[], t0() + Duration::seconds(step))
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
    let evs = detect_tcc(&mut seen, Some(&snap(&rows)), &bundles, t0());
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

fn user_row(uid: u32, client: &str, service: &str, auth_value: i64) -> TccRow {
    TccRow {
        db: format!("user:{uid}"),
        ..row(client, service, auth_value)
    }
}

fn snap_of(dbs: &[&str], rows: Vec<TccRow>) -> TccSnapshot {
    TccSnapshot {
        dbs_read: dbs.iter().map(|d| d.to_string()).collect(),
        rows,
    }
}

#[test]
fn database_not_read_this_pass_keeps_its_state() {
    let mut seen = SeenState::default();
    let now = t0();
    // Baseline: both databases, a user grant already present.
    let both = snap_of(&["system", "user:501"], vec![user_row(501, "com.a.b", SC, 2)]);
    assert!(detect_tcc(&mut seen, Some(&both), &[], now).is_empty());
    // The user database is unreadable for a pass: not in dbs_read, so no revoke is recorded...
    let sys_only = snap_of(&["system"], vec![]);
    assert!(detect_tcc(&mut seen, Some(&sys_only), &[], now).is_empty());
    // ...and when it returns with the same grant nothing is sent.
    assert!(detect_tcc(&mut seen, Some(&both), &[], now).is_empty());
    // Rows of a database that was not read are ignored, not baselined or sent.
    let stray = snap_of(&["system"], vec![user_row(501, "com.new.app", SC, 2)]);
    assert!(detect_tcc(&mut seen, Some(&stray), &[], now).is_empty());
    let evs = detect_tcc(
        &mut seen,
        Some(&snap_of(&["system", "user:501"], vec![user_row(501, "com.new.app", SC, 2)])),
        &[],
        now,
    );
    assert_eq!(
        grants(&evs).len(),
        1,
        "a grant that appeared while the db was unread is seen once it is read"
    );
}

#[test]
fn a_database_read_for_the_first_time_is_baselined_silently() {
    let mut seen = SeenState::default();
    let now = t0();
    assert!(detect_tcc(&mut seen, Some(&snap_of(&["system"], vec![])), &[], now).is_empty());
    // A second user's database appears after the global baseline: its existing grants are baseline.
    let second = snap_of(&["system", "user:502"], vec![user_row(502, "us.zoom.xos", SC, 2)]);
    assert!(detect_tcc(&mut seen, Some(&second), &[], now).is_empty());
    assert!(seen.tcc_db_baselined("user:502"));
    // From then on it is compared like any other.
    let more = snap_of(
        &["system", "user:502"],
        vec![user_row(502, "us.zoom.xos", SC, 2), user_row(502, "com.x.y", AX, 2)],
    );
    assert_eq!(grants(&detect_tcc(&mut seen, Some(&more), &[], now)).len(), 1);
}

#[test]
fn empty_dbs_read_changes_nothing() {
    let mut seen = SeenState::default();
    assert!(detect_tcc(&mut seen, Some(&snap_of(&[], vec![])), &[], t0()).is_empty());
    assert!(!seen.tcc_baselined());
}
