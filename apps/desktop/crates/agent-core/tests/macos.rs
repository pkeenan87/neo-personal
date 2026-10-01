mod common;

use common::{lists, lists_macos, proc, snap, t0};
use neo_agent_core::detect::{bundle_exe_hints, detect};
use neo_agent_core::events::{Discovery, EventBody, SignalEvent, TccService, UnwantedReason};
use neo_agent_core::lists::{PathEnv, valid_log_predicate};
use neo_agent_core::snapshot::{AppBundle, ExeFacts, LogChunk, ProcessInfo, TccRow, UnifiedLogRecord};
use neo_agent_core::state::SeenState;
use neo_agent_core::warn::{ExpectedTool, WarningKind, decide, decide_with_lists};
use time::Duration;

const SHA: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

fn bundle(name: &str, id: Option<&str>, team: Option<&str>) -> AppBundle {
    AppBundle {
        path: format!("/Applications/{name}.app"),
        bundle_id: id.map(str::to_string),
        name: name.into(),
        team_id: team.map(str::to_string),
        ..Default::default()
    }
}

fn mac_proc(path: &str, bundle_id: Option<&str>, team: Option<&str>) -> ProcessInfo {
    ProcessInfo {
        pid: 9,
        image_name: path.rsplit('/').next().unwrap().into(),
        image_path: path.into(),
        bundle_id: bundle_id.map(str::to_string),
        team_id: team.map(str::to_string),
        ..Default::default()
    }
}

fn tools(evs: &[SignalEvent]) -> Vec<(String, Option<Discovery>)> {
    evs.iter()
        .filter_map(|e| match &e.body {
            EventBody::RemoteAccessTool { tool_id, discovery, .. } => Some((tool_id.clone(), *discovery)),
            _ => None,
        })
        .collect()
}

fn unwanted(evs: &[SignalEvent]) -> Vec<(String, UnwantedReason)> {
    evs.iter()
        .filter_map(|e| match &e.body {
            EventBody::UnwantedSoftware { name, reason, .. } => Some((name.clone(), *reason)),
            _ => None,
        })
        .collect()
}

#[test]
fn bundle_id_match_baseline_new_and_weekly_resend() {
    let l = lists_macos();
    let mut seen = SeenState::default();
    let mut s = snap();
    s.app_bundles = vec![bundle("AnyDesk", Some("com.philandro.anydesk"), None)];
    let evs = detect(&l, &mut seen, &s, t0(), true);
    assert_eq!(tools(&evs), [("anydesk".into(), Some(Discovery::Baseline))]);
    assert!(detect(&l, &mut seen, &s, t0() + Duration::days(1), false).is_empty());
    // Present continuously: nothing. Absent for 7 days, then back: reported again.
    let gone = snap();
    detect(&l, &mut seen, &gone, t0() + Duration::days(2), false);
    let back = detect(&l, &mut seen, &s, t0() + Duration::days(10), false);
    assert_eq!(tools(&back), [("anydesk".into(), Some(Discovery::New))]);
    // A new tool after the baseline is `new`.
    let mut s2 = s.clone();
    s2.app_bundles
        .push(bundle("TeamViewer", Some("com.teamviewer.TeamViewer"), Some("H7UGFBUGV6")));
    let evs = detect(&l, &mut seen, &s2, t0() + Duration::days(10), false);
    assert_eq!(tools(&evs), [("teamviewer".into(), Some(Discovery::New))]);
}

#[test]
fn running_process_matches_by_bundle_id_and_by_team_id_only() {
    let l = lists_macos();
    let mut s = snap();
    s.processes = vec![mac_proc(
        "/Volumes/AnyDesk/AnyDesk.app/Contents/MacOS/AnyDesk",
        Some("com.philandro.anydesk"),
        None,
    )];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert_eq!(tools(&evs), [("anydesk".into(), Some(Discovery::New))]);
    // A renamed copy with no known bundle id is caught by its Team ID.
    s.processes = vec![mac_proc("/Users/gran/Downloads/Helper", None, Some("H7UGFBUGV6"))];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert_eq!(tools(&evs), [("teamviewer".into(), Some(Discovery::New))]);
    // Unrelated Team ID or bundle id: nothing.
    s.processes = vec![mac_proc("/Applications/Zoom", Some("us.zoom.xos"), Some("BJ4HAAB9B3"))];
    assert!(detect(&l, &mut SeenState::default(), &s, t0(), false).is_empty());
}

#[test]
fn apple_screen_sharing_never_produces_a_tool_event() {
    let l = lists_macos();
    let t = l.tools.iter().find(|t| t.id == "apple_screen_sharing").unwrap();
    assert!(t.bundle_ids.is_empty() && t.team_ids.is_empty() && t.display_name_patterns.is_empty() && t.process_names.is_empty());
    let mut s = snap();
    s.processes = vec![
        mac_proc("/System/Library/CoreServices/screensharingd", Some("com.apple.screensharing"), None),
        proc("screensharingd", None),
    ];
    s.app_bundles = vec![bundle("Screen Sharing", Some("com.apple.ScreenSharing"), None)];
    s.unified_log_records = vec![UnifiedLogRecord {
        predicate: "process == \"screensharingd\"".into(),
        message: "Authentication: SUCCEEDED for user".into(),
        time: t0(),
    }];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert!(tools(&evs).is_empty());
    // Only the session fires.
    assert_eq!(evs.len(), 1);
    assert!(matches!(&evs[0].body, EventBody::RemoteAccessSession { tool_id, .. } if tool_id == "apple_screen_sharing"));
}

#[test]
fn unified_log_session_with_dedupe_and_peer() {
    let mut raw: neo_agent_core::lists::DetectionLists = serde_json::from_str(&common::fixture_text("lists-macos.json")).unwrap();
    // Give the evidence a peer group.
    let json = serde_json::to_string(&raw)
        .unwrap()
        .replace("Authentication: SUCCEEDED", "SUCCEEDED from (?<peer>[0-9.]+)");
    raw = serde_json::from_str(&json).unwrap();
    let l = neo_agent_core::lists::CompiledLists::compile(&raw);
    let rec = |msg: &str, pred: &str| UnifiedLogRecord {
        predicate: pred.into(),
        message: msg.into(),
        time: t0(),
    };
    let pred = "process == \"screensharingd\"";
    let mut seen = SeenState::default();
    let mut s = snap();
    s.unified_log_records = vec![
        rec("Authentication: SUCCEEDED from 10.0.0.7", pred),
        rec("SUCCEEDED from 10.0.0.7", "process == \"other\""),
    ];
    let evs = detect(&l, &mut seen, &s, t0(), false);
    assert_eq!(evs.len(), 1, "only the record for the listed predicate counts");
    assert!(matches!(&evs[0].body, EventBody::RemoteAccessSession { peer_id: Some(p), .. } if p == "10.0.0.7"));
    assert!(
        detect(&l, &mut seen, &s, t0() + Duration::minutes(5), false).is_empty(),
        "30 minute dedupe"
    );
    assert_eq!(detect(&l, &mut seen, &s, t0() + Duration::minutes(31), false).len(), 1);
    s.unified_log_records = vec![rec("no match here", pred)];
    assert!(detect(&l, &mut SeenState::default(), &s, t0(), false).is_empty());
}

#[test]
fn predicate_form_is_restricted_and_bad_entries_are_skipped() {
    for ok in ["process == \"screensharingd\"", "subsystem == \"com.apple.sharing-1_x\""] {
        assert!(valid_log_predicate(ok), "{ok}");
    }
    let long = format!("process == \"{}\"", "a".repeat(65));
    for bad in [
        "process == \"\"",
        "process == \"a b\"",
        "process == \"a\" OR 1 == 1",
        "process == \"a\"; x",
        "eventMessage == \"a\"",
        "process=='a'",
        "process == a",
        "process == \"a\\\"b\"",
        "PROCESS == \"a\"",
        " process == \"a\"",
        long.as_str(),
    ] {
        assert!(!valid_log_predicate(bad), "{bad}");
    }
    let l = lists_macos();
    let targets = l.unifiedlog_targets();
    assert_eq!(targets.len(), 1, "injection attempt and unverified entry are dropped");
    assert_eq!(targets[0].predicate, "process == \"screensharingd\"");
    assert!(l.warnings.iter().any(|w| w.contains("disallowed predicate")));
}

#[test]
fn home_token_expands_per_home_and_only_verified_logs_are_targets() {
    let l = lists_macos();
    let env = PathEnv {
        homes: vec!["/Users/gran".into(), "/Users/pat/".into()],
        ..Default::default()
    };
    let paths: Vec<_> = l.macos_log_targets(&env).into_iter().map(|t| t.path).collect();
    assert_eq!(
        paths,
        [
            "/Users/gran/.anydesk/connection_trace.txt",
            "/Users/pat/.anydesk/connection_trace.txt"
        ]
    );
    assert!(l.macos_log_targets(&PathEnv::default()).is_empty(), "no homes, no paths");
    // The Windows tokens are untouched.
    assert_eq!(PathEnv::default().expand("%Home%/x"), Vec::<String>::new());
    assert!(lists().log_targets(&common::env()).iter().all(|t| t.path.starts_with("C:\\")));
}

#[test]
fn macos_log_line_produces_a_session() {
    let l = lists_macos();
    let mut s = snap();
    s.env = PathEnv {
        homes: vec!["/Users/gran".into()],
        ..Default::default()
    };
    s.log_chunks = vec![LogChunk {
        path: "/Users/gran/.anydesk/connection_trace.txt".into(),
        lines: vec!["Incoming 2026-10-01, 10:03 User 123456789".into()],
    }];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert!(matches!(&evs[0].body, EventBody::RemoteAccessSession { peer_id: Some(p), .. } if p == "123456789"));
}

#[test]
fn unwanted_by_team_id_and_signer_name() {
    let l = lists_macos();
    let mut seen = SeenState::default();
    let mut s = snap();
    s.app_bundles = vec![
        bundle("Cleaner", Some("com.pup.cleaner"), Some("PUPTEAM001")),
        AppBundle {
            signer: Some("Shady Soft Ltd".into()),
            ..bundle("Booster", Some("com.shady.booster"), Some("OTHER00001"))
        },
        bundle("Fine", Some("com.fine.app"), Some("FINE000001")),
    ];
    let evs = detect(&l, &mut seen, &s, t0(), false);
    assert_eq!(
        unwanted(&evs),
        [
            ("Cleaner".into(), UnwantedReason::PublisherList),
            ("Booster".into(), UnwantedReason::PublisherList)
        ]
    );
    assert!(
        detect(&l, &mut seen, &s, t0() + Duration::minutes(1), false).is_empty(),
        "only once"
    );
    // Baseline PUP is still reported, as baseline.
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), true);
    assert_eq!(unwanted(&evs).len(), 2);
}

fn facts_for(path: &str, signed: bool) -> ExeFacts {
    ExeFacts {
        path: format!("{path}/Contents/MacOS/bin"),
        sha256: SHA.into(),
        signed_trusted: signed,
        signer: None,
    }
}

#[test]
fn unsigned_unknown_for_new_unsigned_bundles_only() {
    let l = lists_macos();
    let mut seen = SeenState::default();
    detect(&l, &mut seen, &snap(), t0(), true); // baseline scan, nothing installed
    let mut s = snap();
    let unsigned = bundle("Sketchy", Some("com.sketchy.app"), None);
    let adhoc_apple = AppBundle {
        signing_id: Some("com.apple.Safari".into()),
        ..bundle("Safari", Some("com.apple.Safari"), None)
    };
    let spoof = AppBundle {
        // com.apple.* signing id but with a Team ID: not Apple.
        signing_id: Some("com.apple.fake".into()),
        ..bundle("Spoof", Some("com.spoof.app"), Some("SPOOF00001"))
    };
    let signed = bundle("Signed", Some("com.signed.app"), Some("GOOD000001"));
    let tool = bundle("AnyDesk", Some("com.philandro.anydesk"), None);
    s.app_bundles = vec![unsigned.clone(), adhoc_apple.clone(), spoof.clone(), signed.clone(), tool.clone()];
    // First the service is asked what to examine.
    let hints = bundle_exe_hints(&seen, &s.app_bundles);
    assert_eq!(hints.len(), 5);
    let evs = detect(&l, &mut seen, &s, t0() + Duration::minutes(1), false);
    assert!(unwanted(&evs).is_empty(), "no exe facts yet");
    s.exe_facts = vec![
        facts_for(&unsigned.path, false),
        facts_for(&adhoc_apple.path, false),
        facts_for(&spoof.path, false),
        facts_for(&signed.path, true),
        facts_for(&tool.path, false),
    ];
    let evs = detect(&l, &mut seen, &s, t0() + Duration::minutes(2), false);
    assert_eq!(
        unwanted(&evs),
        [
            ("Sketchy".into(), UnwantedReason::UnsignedUnknown),
            ("Spoof".into(), UnwantedReason::UnsignedUnknown)
        ],
        "not for Apple, signed or listed tool bundles"
    );
    match &evs
        .iter()
        .find(|e| matches!(e.body, EventBody::UnwantedSoftware { .. }))
        .unwrap()
        .body
    {
        EventBody::UnwantedSoftware { sha256, .. } => assert_eq!(sha256.as_deref(), Some(SHA)),
        _ => unreachable!(),
    }
    assert!(bundle_exe_hints(&seen, &s.app_bundles).is_empty(), "all examined");
}

#[test]
fn unsigned_bundles_present_at_baseline_are_not_reported() {
    let l = lists_macos();
    let mut seen = SeenState::default();
    let mut s = snap();
    let b = bundle("Old", Some("com.old.app"), None);
    s.app_bundles = vec![b.clone()];
    s.exe_facts = vec![facts_for(&b.path, false)];
    assert!(unwanted(&detect(&l, &mut seen, &s, t0(), true)).is_empty());
}

#[test]
fn tcc_through_detect_uses_snapshot_and_none_is_inert() {
    let l = lists_macos();
    let mut seen = SeenState::default();
    let row = |c: &str, v: i64| TccRow {
        db: "system".into(),
        service: "kTCCServiceAccessibility".into(),
        client: c.into(),
        client_type: 0,
        auth_value: v,
    };
    let mut s = snap();
    s.tcc = Some(vec![row("com.a.b", 0)]);
    assert!(detect(&l, &mut seen, &s, t0(), true).is_empty());
    s.tcc = None;
    assert!(detect(&l, &mut seen, &s, t0() + Duration::minutes(1), false).is_empty());
    s.tcc = Some(vec![row("com.a.b", 2)]);
    let evs = detect(&l, &mut seen, &s, t0() + Duration::minutes(2), false);
    assert!(matches!(
        &evs[0].body,
        EventBody::TccGrant {
            service: TccService::Accessibility,
            ..
        }
    ));
}

#[test]
fn tcc_grant_warning_rules() {
    let l = lists_macos();
    let grant = |app: &str, id: Option<&str>| SignalEvent::tcc_grant(t0(), app, id, TccService::Accessibility);
    let any = grant("AnyDesk", Some("com.philandro.anydesk"));
    assert_eq!(decide_with_lists(&any, &[], &l), Some(WarningKind::Session));
    let case = grant("AnyDesk", Some("COM.Philandro.AnyDesk"));
    assert_eq!(decide_with_lists(&case, &[], &l), Some(WarningKind::Session));
    // Expected on this device: no window.
    let expected = vec![ExpectedTool {
        tool_id: "anydesk".into(),
        peer_ids: vec![],
    }];
    assert_eq!(decide_with_lists(&any, &expected, &l), None);
    let other = vec![ExpectedTool {
        tool_id: "teamviewer".into(),
        peer_ids: vec![],
    }];
    assert_eq!(decide_with_lists(&any, &other, &l), Some(WarningKind::Session));
    // Other apps and path clients: no local warning, even for Full Disk Access.
    assert_eq!(decide_with_lists(&grant("Zoom", Some("us.zoom.xos")), &[], &l), None);
    assert_eq!(decide_with_lists(&grant("helper", None), &[], &l), None);
    let fda = SignalEvent::tcc_grant(t0(), "X", Some("com.x.y"), TccService::FullDiskAccess);
    assert_eq!(decide_with_lists(&fda, &[], &l), None);
    // Without lists `decide` stays quiet for grants, and is unchanged for the rest.
    assert_eq!(decide(&any, &[]), None);
    let tool = SignalEvent::remote_access_tool(t0(), "anydesk", "AnyDesk", None, None, Discovery::New);
    assert_eq!(decide_with_lists(&tool, &[], &l), Some(WarningKind::Tool));
}

#[test]
fn windows_detection_is_unchanged_by_the_macos_fields() {
    // A Windows snapshot has none of the new inputs and the Windows lists have no macOS signals.
    let l = lists();
    let mut s = snap();
    s.processes = vec![proc("AnyDesk.exe", Some("AnyDesk Software GmbH"))];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert_eq!(tools(&evs), [("anydesk".into(), Some(Discovery::New))]);
    assert!(l.unifiedlog_targets().is_empty());
    // Old snapshot JSON (no macOS keys) still deserializes.
    let old: neo_agent_core::snapshot::Snapshot =
        serde_json::from_str(r#"{"processes":[{"pid":1,"image_name":"a.exe","image_path":"C:\\a.exe"}]}"#).unwrap();
    assert!(old.tcc.is_none() && old.app_bundles.is_empty() && old.processes[0].team_id.is_none());
}
