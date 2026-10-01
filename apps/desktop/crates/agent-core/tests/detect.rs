mod common;

use common::{lists, proc, snap, t0};
use neo_agent_core::detect::{ExeHint, detect, exe_hints};
use neo_agent_core::events::{Discovery, EventBody, UnwantedReason};
use neo_agent_core::snapshot::{EventLogRecord, ExeFacts, LogChunk, ServiceInfo, UninstallEntry};
use neo_agent_core::state::SeenState;
use time::Duration;

const ANY_LOG: &str = "C:\\Users\\Gran\\AppData\\Roaming\\AnyDesk\\connection_trace.txt";
const ANY_LINE: &str = "Incoming    2026-10-01, 10:03    User    123456789";

fn uninstall(name: &str, publisher: Option<&str>) -> UninstallEntry {
    UninstallEntry {
        display_name: name.into(),
        publisher: publisher.map(str::to_string),
        hive: "HKLM64".into(),
        ..Default::default()
    }
}

fn tool_events(evs: &[neo_agent_core::events::SignalEvent]) -> Vec<(&str, Option<Discovery>)> {
    evs.iter()
        .filter_map(|e| match &e.body {
            EventBody::RemoteAccessTool { tool_id, discovery, .. } => Some((tool_id.as_str(), *discovery)),
            _ => None,
        })
        .collect()
}

#[test]
fn uninstall_entry_needs_publisher_confirmation() {
    let l = lists();
    let mut s = snap();
    s.uninstall_entries = vec![uninstall("AnyDesk", Some("Evil Corp"))];
    assert!(detect(&l, &mut SeenState::default(), &s, t0(), false).is_empty());
    s.uninstall_entries = vec![uninstall("AnyDesk", Some("AnyDesk Software GmbH"))];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert_eq!(tool_events(&evs), [("anydesk", Some(Discovery::New))]);
    match &evs[0].body {
        EventBody::RemoteAccessTool { publisher, name, .. } => {
            assert_eq!(publisher.as_deref(), Some("AnyDesk Software GmbH"));
            assert_eq!(name, "AnyDesk");
        }
        _ => unreachable!(),
    }
}

#[test]
fn uninstall_without_list_publishers_matches_on_name() {
    let l = lists();
    let mut s = snap();
    s.uninstall_entries = vec![uninstall("rustdesk", None)];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert_eq!(tool_events(&evs).len(), 1);
}

#[test]
fn service_name_matches() {
    let mut s = snap();
    s.services = vec![ServiceInfo {
        name: "teamviewer".into(),
        display_name: "TeamViewer".into(),
        binary_path: "C:\\x.exe".into(),
    }];
    let evs = detect(&lists(), &mut SeenState::default(), &s, t0(), false);
    assert_eq!(tool_events(&evs), [("teamviewer", Some(Discovery::New))]);
}

#[test]
fn process_needs_signer_confirmation_when_list_has_publishers() {
    let l = lists();
    let mut s = snap();
    s.processes = vec![proc("AnyDesk.exe", None)];
    assert!(
        detect(&l, &mut SeenState::default(), &s, t0(), false).is_empty(),
        "unsigned fails open"
    );
    s.processes = vec![proc("AnyDesk.exe", Some("Somebody Else"))];
    assert!(detect(&l, &mut SeenState::default(), &s, t0(), false).is_empty());
    s.processes = vec![proc("AnyDesk.exe", Some("AnyDesk Software GmbH"))];
    assert_eq!(tool_events(&detect(&l, &mut SeenState::default(), &s, t0(), false)).len(), 1);
    // No publishers on the list: the name alone is enough.
    s.processes = vec![proc("RUSTDESK.EXE", None)];
    assert_eq!(
        tool_events(&detect(&l, &mut SeenState::default(), &s, t0(), false)),
        [("rustdesk", Some(Discovery::New))]
    );
}

#[test]
fn renamed_binary_is_caught_by_signer() {
    let mut s = snap();
    s.processes = vec![proc("support.exe", Some("CN=TeamViewer Germany GmbH, O=TeamViewer"))];
    let evs = detect(&lists(), &mut SeenState::default(), &s, t0(), false);
    assert_eq!(tool_events(&evs), [("teamviewer", Some(Discovery::New))]);
    s.processes = vec![proc("support.exe", Some("Microsoft Corporation"))];
    assert!(detect(&lists(), &mut SeenState::default(), &s, t0(), false).is_empty());
}

#[test]
fn one_event_per_tool_across_sources() {
    let mut s = snap();
    s.uninstall_entries = vec![uninstall("AnyDesk", Some("AnyDesk Software GmbH"))];
    s.services = vec![ServiceInfo {
        name: "AnyDesk".into(),
        ..Default::default()
    }];
    s.processes = vec![proc("AnyDesk.exe", Some("AnyDesk Software GmbH"))];
    assert_eq!(detect(&lists(), &mut SeenState::default(), &s, t0(), false).len(), 1);
}

#[test]
fn baseline_then_new_and_resend_after_seven_days() {
    let l = lists();
    let mut seen = SeenState::default();
    let mut s = snap();
    s.uninstall_entries = vec![uninstall("TeamViewer", Some("TeamViewer Germany GmbH"))];
    let first = detect(&l, &mut seen, &s, t0(), true);
    assert_eq!(tool_events(&first), [("teamviewer", Some(Discovery::Baseline))]);
    // Still present later: nothing.
    assert!(detect(&l, &mut seen, &s, t0() + Duration::hours(1), false).is_empty());
    // Gone for 8 days (no sightings), then back: reported again, as new.
    let back = detect(&l, &mut seen, &s, t0() + Duration::days(9), false);
    assert_eq!(tool_events(&back), [("teamviewer", Some(Discovery::New))]);
    // A different tool appearing after the baseline is new.
    s.services = vec![ServiceInfo {
        name: "AnyDesk".into(),
        ..Default::default()
    }];
    let more = detect(&l, &mut seen, &s, t0() + Duration::days(9) + Duration::seconds(5), false);
    assert_eq!(tool_events(&more), [("anydesk", Some(Discovery::New))]);
}

#[test]
fn present_continuously_is_never_resent() {
    let l = lists();
    let mut seen = SeenState::default();
    let mut s = snap();
    s.processes = vec![proc("AnyDesk.exe", Some("AnyDesk Software GmbH"))];
    assert_eq!(detect(&l, &mut seen, &s, t0(), false).len(), 1);
    for day in 1..20 {
        assert!(detect(&l, &mut seen, &s, t0() + Duration::days(day), false).is_empty());
    }
}

fn chunk(path: &str, lines: &[&str]) -> LogChunk {
    LogChunk {
        path: path.into(),
        lines: lines.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn session_from_verified_log_with_peer() {
    let mut s = snap();
    s.log_chunks = vec![chunk(ANY_LOG, &["noise", ANY_LINE])];
    let evs = detect(&lists(), &mut SeenState::default(), &s, t0(), false);
    assert_eq!(evs.len(), 1);
    match &evs[0].body {
        EventBody::RemoteAccessSession {
            tool_id,
            peer_id,
            direction,
        } => {
            assert_eq!(tool_id, "anydesk");
            assert_eq!(peer_id.as_deref(), Some("123456789"));
            assert_eq!(direction, "incoming");
        }
        _ => panic!("not a session"),
    }
}

#[test]
fn log_path_matches_case_insensitively_and_other_paths_are_ignored() {
    let mut s = snap();
    s.log_chunks = vec![chunk(&ANY_LOG.to_lowercase().replace('\\', "/"), &[ANY_LINE])];
    assert_eq!(detect(&lists(), &mut SeenState::default(), &s, t0(), false).len(), 1);
    s.log_chunks = vec![chunk("C:\\Users\\Gran\\Documents\\connection_trace.txt", &[ANY_LINE])];
    assert!(detect(&lists(), &mut SeenState::default(), &s, t0(), false).is_empty());
    // The unverified entry's path is not a target.
    s.log_chunks = vec![chunk("C:\\Users\\Gran\\AppData\\Roaming\\AnyDesk\\unverified.txt", &["Incoming"])];
    assert!(detect(&lists(), &mut SeenState::default(), &s, t0(), false).is_empty());
}

#[test]
fn session_dedupe_per_tool_and_peer_for_30_minutes() {
    let l = lists();
    let mut seen = SeenState::default();
    let mut s = snap();
    s.log_chunks = vec![chunk(ANY_LOG, &[ANY_LINE, ANY_LINE])];
    assert_eq!(detect(&l, &mut seen, &s, t0(), false).len(), 1, "same chunk, same peer");
    assert!(detect(&l, &mut seen, &s, t0() + Duration::minutes(29), false).is_empty());
    assert_eq!(detect(&l, &mut seen, &s, t0() + Duration::minutes(31), false).len(), 1);
    // A different peer is a different key.
    s.log_chunks = vec![chunk(ANY_LOG, &["Incoming    2026-10-01, 11:00    User    987654321"])];
    assert_eq!(detect(&l, &mut seen, &s, t0() + Duration::minutes(32), false).len(), 1);
}

#[test]
fn oversize_lines_are_not_matched() {
    let mut s = snap();
    let long = format!("{ANY_LINE}{}", " ".repeat(5000));
    s.log_chunks = vec![chunk(ANY_LOG, &[&long])];
    assert!(detect(&lists(), &mut SeenState::default(), &s, t0(), false).is_empty());
}

#[test]
fn process_evidence_is_a_session_but_normal_process_names_are_not() {
    let l = lists();
    let mut s = snap();
    // AnyDesk.exe running is a tool sighting, never a session.
    s.processes = vec![
        proc("AnyDesk.exe", Some("AnyDesk Software GmbH")),
        proc("TeamViewer.exe", Some("TeamViewer Germany GmbH")),
    ];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert!(evs.iter().all(|e| matches!(e.body, EventBody::RemoteAccessTool { .. })));
    // The session-only process is a session with no peer.
    s.processes = vec![proc("ScreenConnect.WindowsClient.exe", Some("ConnectWise, LLC"))];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    let sessions: Vec<_> = evs
        .iter()
        .filter(|e| matches!(&e.body, EventBody::RemoteAccessSession { peer_id: None, tool_id, .. } if tool_id == "screenconnect"))
        .collect();
    assert_eq!(sessions.len(), 1);
}

#[test]
fn eventlog_evidence_is_a_session() {
    let l = lists();
    let mut s = snap();
    let rec = |channel: &str, id: u32| EventLogRecord {
        channel: channel.into(),
        event_id: id,
        time: t0(),
    };
    s.event_records = vec![
        rec("Splashtop-Splashtop Streamer-Remote Session/Operational", 999),
        rec("Other", 1000),
    ];
    assert!(detect(&l, &mut SeenState::default(), &s, t0(), false).is_empty());
    s.event_records = vec![rec("splashtop-splashtop streamer-remote session/operational", 1000)];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert_eq!(evs.len(), 1);
    assert!(matches!(&evs[0].body, EventBody::RemoteAccessSession { tool_id, peer_id: None, .. } if tool_id == "splashtop"));
}

fn facts(path: &str, signed: bool) -> ExeFacts {
    ExeFacts {
        path: path.into(),
        sha256: "cd".repeat(32),
        signed_trusted: signed,
        signer: signed.then(|| "Some Vendor".to_string()),
    }
}

fn unwanted(evs: &[neo_agent_core::events::SignalEvent]) -> Vec<(UnwantedReason, Option<Discovery>)> {
    evs.iter()
        .filter_map(|e| match &e.body {
            EventBody::UnwantedSoftware { reason, discovery, .. } => Some((*reason, *discovery)),
            _ => None,
        })
        .collect()
}

#[test]
fn pup_publisher_new_and_baseline() {
    let l = lists();
    let mut seen = SeenState::default();
    let mut s = snap();
    s.uninstall_entries = vec![uninstall("Toolbar", Some("Mindspark Interactive Network"))];
    assert_eq!(
        unwanted(&detect(&l, &mut seen, &s, t0(), true)),
        [(UnwantedReason::PublisherList, Some(Discovery::Baseline))]
    );
    assert!(
        detect(&l, &mut seen, &s, t0() + Duration::minutes(1), false).is_empty(),
        "known now"
    );
    s.uninstall_entries
        .push(uninstall("Another Toolbar", Some("Mindspark Interactive Network")));
    assert_eq!(
        unwanted(&detect(&l, &mut seen, &s, t0() + Duration::minutes(2), false)),
        [(UnwantedReason::PublisherList, Some(Discovery::New))]
    );
}

#[test]
fn hash_list_match_uses_display_icon_and_carries_sha() {
    let l = lists();
    let mut s = snap();
    let mut e = uninstall("Mystery App", Some("Whoever"));
    e.display_icon = Some("\"C:\\Program Files\\Mystery\\m.exe\",0".into());
    s.uninstall_entries = vec![e];
    let mut f = facts("C:\\Program Files\\Mystery\\m.exe", true);
    f.sha256 = "a".repeat(64);
    s.exe_facts = vec![f];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert_eq!(unwanted(&evs), [(UnwantedReason::HashList, Some(Discovery::New))]);
    assert!(matches!(&evs[0].body, EventBody::UnwantedSoftware { sha256: Some(h), .. } if *h == "a".repeat(64)));
}

#[test]
fn hash_list_also_applies_at_baseline() {
    let mut s = snap();
    let mut e = uninstall("Mystery App", None);
    e.install_location = Some("C:\\Program Files\\Mystery".into());
    s.uninstall_entries = vec![e];
    let mut f = facts("C:\\Program Files\\Mystery\\bin\\m.exe", false);
    f.sha256 = "A".repeat(64);
    s.exe_facts = vec![f];
    let evs = detect(&lists(), &mut SeenState::default(), &s, t0(), true);
    assert_eq!(unwanted(&evs), [(UnwantedReason::HashList, Some(Discovery::Baseline))]);
}

#[test]
fn unsigned_unknown_only_for_non_baseline_programs() {
    let l = lists();
    let mut seen = SeenState::default();
    let mut s = snap();
    let mut old = uninstall("Old Tool", Some("Someone"));
    old.install_location = Some("C:\\Tools\\Old".into());
    s.uninstall_entries = vec![old.clone()];
    s.exe_facts = vec![facts("C:\\Tools\\Old\\old.exe", false)];
    assert!(detect(&l, &mut seen, &s, t0(), true).is_empty(), "baseline: no fingerprint");

    let mut new = uninstall("New Tool", Some("Someone"));
    new.display_icon = Some("C:\\Tools\\New\\new.exe".into());
    s.uninstall_entries = vec![old, new];
    s.exe_facts.push(facts("C:\\Tools\\New\\new.exe", false));
    let evs = detect(&l, &mut seen, &s, t0() + Duration::minutes(1), false);
    assert_eq!(unwanted(&evs), [(UnwantedReason::UnsignedUnknown, Some(Discovery::New))]);
    assert!(matches!(&evs[0].body, EventBody::UnwantedSoftware { sha256: Some(_), .. }));
    // Examined once.
    assert!(detect(&l, &mut seen, &s, t0() + Duration::minutes(2), false).is_empty());
}

#[test]
fn signed_program_is_not_unsigned_unknown() {
    let mut s = snap();
    let mut e = uninstall("Signed Tool", Some("Vendor"));
    e.display_icon = Some("C:\\V\\t.exe".into());
    s.uninstall_entries = vec![e];
    s.exe_facts = vec![facts("C:\\V\\t.exe", true)];
    assert!(detect(&lists(), &mut SeenState::default(), &s, t0(), false).is_empty());
}

#[test]
fn unsigned_unknown_waits_for_exe_facts_and_is_capped_at_20_per_day() {
    let l = lists();
    let mut seen = SeenState::default();
    let mut s = snap();
    let entries: Vec<_> = (0..25)
        .map(|i| {
            let mut e = uninstall(&format!("Prog {i}"), Some("P"));
            e.display_icon = Some(format!("C:\\P\\{i}.exe"));
            e
        })
        .collect();
    s.uninstall_entries = entries.clone();
    // No facts yet: nothing reported, entries still need hints.
    assert!(detect(&l, &mut seen, &s, t0(), false).is_empty());
    assert_eq!(exe_hints(&seen, &entries).len(), 25);
    s.exe_facts = (0..25).map(|i| facts(&format!("C:\\P\\{i}.exe"), false)).collect();
    let evs = detect(&l, &mut seen, &s, t0() + Duration::seconds(60), false);
    assert_eq!(unwanted(&evs).len(), 20);
    assert!(exe_hints(&seen, &entries).is_empty());
}

#[test]
fn cap_resets_next_day() {
    let l = lists();
    let mut seen = SeenState::default();
    let mut s = snap();
    for day in 0..2 {
        let entries: Vec<_> = (0..21)
            .map(|i| {
                let mut e = uninstall(&format!("D{day} Prog {i}"), Some("P"));
                e.display_icon = Some(format!("C:\\P\\{day}_{i}.exe"));
                e
            })
            .collect();
        s.uninstall_entries.extend(entries);
        s.exe_facts = s
            .uninstall_entries
            .iter()
            .map(|e| facts(e.display_icon.as_deref().unwrap(), false))
            .collect();
        let evs = detect(&l, &mut seen, &s, t0() + Duration::days(day) + Duration::hours(1), false);
        assert_eq!(unwanted(&evs).len(), 20, "day {day}");
    }
}

#[test]
fn exe_hints_prefer_display_icon_then_install_location() {
    let mut a = uninstall("A", None);
    a.display_icon = Some("\"C:\\A\\a.exe\",0".into());
    a.install_location = Some("C:\\A".into());
    let mut b = uninstall("B", None);
    b.display_icon = Some("C:\\B\\b.ico".into());
    b.install_location = Some("C:\\B\\".into());
    let c = uninstall("C", None);
    let hints = exe_hints(&SeenState::default(), &[a, b, c]);
    assert_eq!(hints, [ExeHint::File("C:\\A\\a.exe".into()), ExeHint::FirstExeIn("C:\\B\\".into())]);
}

#[test]
fn events_never_contain_paths() {
    let l = lists();
    let mut s = snap();
    s.processes = vec![proc("AnyDesk.exe", Some("AnyDesk Software GmbH"))];
    s.log_chunks = vec![chunk(ANY_LOG, &[ANY_LINE])];
    let mut e = uninstall("Mystery", Some("Mindspark Interactive Network"));
    e.install_location = Some("C:\\Users\\Gran\\Secret".into());
    s.uninstall_entries = vec![e];
    let evs = detect(&l, &mut SeenState::default(), &s, t0(), false);
    assert!(evs.len() >= 3);
    let json = serde_json::to_string(&evs).unwrap();
    assert!(
        !json.contains("Users") && !json.contains("C:\\\\") && !json.contains("Downloads"),
        "{json}"
    );
}
