//! The whole agent against fakes: enrollment, baseline, detection, warnings, the queue, 401 and
//! unenroll. HTTP responses are the recorded fixtures from `agent-core`.

mod common;

use std::sync::atomic::Ordering;

use common::*;
use neo_agent::agent::Agent;
use neo_agent::persist::{META_FILE, Meta, QUEUE_FILE};
use neo_agent::protocol::Request;
use neo_agent::update::Available;
use neo_agent_core::snapshot::UninstallEntry;
use serde_json::json;

const SESSION_LOG: &str = r"C:\Users\Gran\AppData\Roaming\AnyDesk\connection_trace.txt";
const SESSION_LINE: &str = "Incoming 2026-10-01 10:00:00 Accepted 123456789\n";

fn teamviewer() -> UninstallEntry {
    UninstallEntry {
        display_name: "TeamViewer".into(),
        publisher: Some("TeamViewer Germany GmbH".into()),
        version: Some("15.0".into()),
        ..UninstallEntry::default()
    }
}

/// Enrolled and past the baseline scan, with TeamViewer already installed.
fn enrolled_after_baseline() -> Harness {
    let h = Harness::new();
    h.probe.set_uninstall(vec![teamviewer()]);
    h.probe.write_file(SESSION_LOG, "Incoming 2020-01-01 00:00:00 Accepted 111111111\n");
    assert_eq!(h.enroll()["ok"], true);
    h.agent.tick();
    h
}

#[test]
fn not_enrolled_does_nothing_but_answer_status() {
    let h = Harness::new();
    h.agent.tick();
    assert_eq!(h.server.requests.lock().unwrap().len(), 0);
    let s = h.agent.status();
    assert_eq!(s["ok"], true);
    assert_eq!(s["state"], "not_enrolled");
    assert_eq!(s["computerName"], "GRANDMA-PC");
}

#[test]
fn preview_then_enroll_stores_the_token_and_reports_status() {
    let h = Harness::new();
    let p = h.agent.handle(Request::EnrollPreview {
        code: "ABCD".into(),
        server_url: Some("http://127.0.0.1:3007".into()),
    });
    assert_eq!(p["householdName"], "The Keenans");
    assert_eq!(p["ownerName"], "Pat");
    let e = h.enroll();
    assert_eq!(e["state"], "enrolled");
    assert_eq!(e["memberName"], "Grandma");
    assert_eq!(e["ownerName"], "Pat");
    let creds = h.secrets.0.lock().unwrap().clone().unwrap();
    assert_eq!(creds.token, "neo_dt_fixturetoken");
    assert_eq!(creds.base_url, "http://127.0.0.1:3007");
    // The body of /enroll carries the agent's identity, as the contract asks.
    let req = h
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.url.ends_with("/api/devices/enroll"))
        .cloned()
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["kind"], "desktop_agent");
    assert_eq!(body["platform"], if cfg!(target_os = "macos") { "macos" } else { "windows" });
    assert_eq!(body["name"], "GRANDMA-PC");
    // Neither the status nor the state files contain the token.
    let meta = std::fs::read_to_string(h.dir.root().join(META_FILE)).unwrap();
    assert!(!meta.contains("neo_dt_"));
    assert!(!h.agent.status().to_string().contains("neo_dt_"));
    // A second enrollment is refused.
    assert_eq!(h.enroll()["code"], "already_enrolled");
}

#[test]
fn bad_code_and_unreachable_server_have_plain_errors() {
    let h = Harness::new();
    h.server.offline.store(true, Ordering::SeqCst);
    let r = h.enroll();
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "server_unreachable");
    let r = h.agent.handle(Request::EnrollPreview {
        code: "x".into(),
        server_url: Some("ftp://nope".into()),
    });
    assert_eq!(r["code"], "invalid_server_url");
}

#[test]
fn first_scan_is_a_baseline_and_does_not_warn() {
    let h = Harness::new();
    let rx = h.agent.hub().subscribe();
    h.probe.set_uninstall(vec![teamviewer()]);
    h.enroll();
    h.agent.tick();
    let events = h.server.posted_events();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["detector"], "remote_access_tool");
    assert_eq!(events[0]["toolId"], "teamviewer");
    assert_eq!(events[0]["discovery"], "baseline");
    assert!(drain(&rx).iter().all(|p| p["push"] != "warning"));
    assert!(h.notifier.0.lock().unwrap().is_empty());
    assert!(!h.dir.read_json::<Meta>(META_FILE).discovery_pending);
    // The heartbeat on start also fetched the lists.
    assert_eq!(h.server.count("POST /api/devices/heartbeat"), 1);
    assert_eq!(h.server.count("GET /api/signals/lists"), 1);
    // Seen state is local; nothing but the event was sent.
    let all = h.server.paths();
    assert!(all.iter().all(|p| !p.contains("inventory")));
}

#[test]
fn a_tool_appearing_later_is_new_warns_and_is_queued_then_sent() {
    let h = enrolled_after_baseline();
    let rx = h.agent.hub().subscribe();
    h.clock.advance(6);
    h.probe.set_processes(vec![process("AnyDesk.exe", Some("AnyDesk Software GmbH"))]);
    h.agent.tick();
    let pushes = drain(&rx);
    let warning = pushes.iter().find(|p| p["push"] == "warning").expect("a warning push");
    assert_eq!(warning["kind"], "tool");
    assert_eq!(warning["toolName"], "AnyDesk");
    assert_eq!(warning["ownerName"], "Pat");
    // The same tick posted it, and the result (high) tells the open window the owner was told.
    let events = h.server.posted_events();
    let any = events.iter().find(|e| e["toolId"] == "anydesk").unwrap();
    assert!(any.get("discovery").is_none(), "new is the default and is not sent");
    let told = pushes.iter().filter(|p| p["push"] == "warning" && p["ownerTold"] == true).count();
    assert_eq!(told, 1);
    assert_eq!(warning["eventId"], any["id"]);
    // No message box when a tray app is listening.
    assert!(h.notifier.0.lock().unwrap().is_empty());
}

#[test]
fn incoming_session_with_peer_shows_the_critical_window() {
    let h = enrolled_after_baseline();
    let rx = h.agent.hub().subscribe();
    h.clock.advance(6);
    h.probe.set_processes(vec![process("AnyDesk.exe", Some("AnyDesk Software GmbH"))]);
    h.agent.tick();
    drain(&rx);
    h.clock.advance(6);
    h.probe.append_file(SESSION_LOG, SESSION_LINE);
    h.agent.tick();
    let pushes = drain(&rx);
    let w = pushes
        .iter()
        .find(|p| p["push"] == "warning" && p["kind"] == "session")
        .expect("session warning");
    assert_eq!(w["peerId"], "123456789");
    assert_eq!(w["severity"], "critical");
    assert_eq!(w["toolName"], "AnyDesk");
    let events = h.server.posted_events();
    let s = events.iter().find(|e| e["detector"] == "remote_access_session").unwrap();
    assert_eq!(s["peerId"], "123456789");
    assert_eq!(s["direction"], "incoming");
    // The old line from before enrollment never became an event.
    assert_eq!(events.iter().filter(|e| e["detector"] == "remote_access_session").count(), 1);
}

#[test]
fn an_expected_tool_and_peer_gets_no_window_and_a_heartbeat_follows_a_low_result() {
    let server = Server::new();
    server.expected.store(true, Ordering::SeqCst);
    *server.severity.lock().unwrap() = "low".into();
    let h = Harness::in_dir(tempfile::tempdir().unwrap(), server);
    h.probe.write_file(SESSION_LOG, "");
    h.enroll();
    h.agent.tick();
    let rx = h.agent.hub().subscribe();
    h.clock.advance(6);
    h.probe.append_file(SESSION_LOG, SESSION_LINE);
    let hb_before = h.server.count("POST /api/devices/heartbeat");
    h.agent.tick();
    assert!(drain(&rx).iter().all(|p| p["push"] != "warning"));
    assert_eq!(
        h.server
            .posted_events()
            .iter()
            .filter(|e| e["detector"] == "remote_access_session")
            .count(),
        1
    );
    // `low` -> the expected tools are refreshed on the next tick.
    h.clock.advance(1);
    h.agent.tick();
    assert_eq!(h.server.count("POST /api/devices/heartbeat"), hb_before + 1);
}

#[test]
fn with_no_tray_a_session_falls_back_to_a_message_box() {
    let h = enrolled_after_baseline();
    h.clock.advance(6);
    h.probe.append_file(SESSION_LOG, SESSION_LINE);
    h.agent.tick();
    let shown = h.notifier.0.lock().unwrap().clone();
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert!(shown[0].1.starts_with("Someone is connected to this computer with AnyDesk."));
}

#[test]
fn offline_events_wait_in_the_queue_and_survive_a_restart() {
    let h = enrolled_after_baseline();
    h.server.offline.store(true, Ordering::SeqCst);
    h.clock.advance(6);
    h.probe.set_processes(vec![process("AnyDesk.exe", Some("AnyDesk Software GmbH"))]);
    h.agent.tick();
    let queued = std::fs::read_to_string(h.dir.root().join(QUEUE_FILE)).unwrap();
    assert!(queued.contains("anydesk"));
    // Still within the backoff: no new attempt.
    let attempts = h.server.requests.lock().unwrap().len();
    h.clock.advance(6);
    h.agent.tick();
    assert_eq!(h.server.requests.lock().unwrap().len(), attempts);
    // Back online after the backoff: a fresh Agent (a service restart) loads the queue and sends.
    h.server.offline.store(false, Ordering::SeqCst);
    h.clock.advance(120);
    let again = Agent::new(
        neo_agent::agent::Deps {
            probe: Box::new(h.probe.clone()),
            secrets: Box::new(h.secrets.clone()),
            notifier: Box::new(h.notifier.clone()),
            clock: Box::new(h.clock.clone()),
            transport: neo_agent::agent::DynTransport(h.server.clone()),
            updater: Box::new(h.updater.clone()),
        },
        h.dir.clone(),
    );
    again.tick();
    assert!(h.server.posted_events().iter().filter(|e| e["toolId"] == "anydesk").count() >= 1);
    let queued = std::fs::read_to_string(h.dir.root().join(QUEUE_FILE)).unwrap();
    assert!(!queued.contains("anydesk"));
}

#[test]
fn a_401_disconnects_clears_the_token_and_stops_detection() {
    let h = enrolled_after_baseline();
    let rx = h.agent.hub().subscribe();
    h.server.unauthorized.store(true, Ordering::SeqCst);
    h.clock.advance(6);
    h.probe.set_processes(vec![process("AnyDesk.exe", Some("AnyDesk Software GmbH"))]);
    h.agent.tick();
    assert!(h.secrets.0.lock().unwrap().is_none());
    assert_eq!(h.agent.status()["state"], "disconnected");
    assert!(drain(&rx).iter().any(|p| p["push"] == "status_changed"));
    // Nothing more is sent or detected.
    let n = h.server.requests.lock().unwrap().len();
    h.clock.advance(6);
    h.agent.tick();
    assert_eq!(h.server.requests.lock().unwrap().len(), n);
    // The member can enroll again.
    h.server.unauthorized.store(false, Ordering::SeqCst);
    assert_eq!(h.enroll()["state"], "enrolled");
}

#[test]
fn unenroll_tells_the_server_and_forgets_everything() {
    let h = enrolled_after_baseline();
    let r = h.agent.handle(Request::Unenroll);
    assert_eq!(r["ok"], true);
    assert_eq!(h.server.count("DELETE /api/devices/self"), 1);
    assert!(h.secrets.0.lock().unwrap().is_none());
    assert_eq!(h.agent.status()["state"], "not_enrolled");
    assert_eq!(h.agent.handle(Request::Unenroll)["code"], "not_enrolled");
}

#[test]
fn unenroll_keeps_the_enrollment_when_the_owner_cannot_be_told() {
    let h = enrolled_after_baseline();
    h.server.offline.store(true, Ordering::SeqCst);
    let r = h.agent.handle(Request::Unenroll);
    assert_eq!(r["code"], "server_unreachable");
    assert!(h.secrets.0.lock().unwrap().is_some());
    assert_eq!(h.agent.status()["state"], "enrolled");
}

#[test]
fn uninstall_unenroll_never_fails_and_clears() {
    let h = enrolled_after_baseline();
    h.server.offline.store(true, Ordering::SeqCst);
    h.agent.unenroll_for_uninstall();
    assert!(h.secrets.0.lock().unwrap().is_none());
}

#[test]
fn check_url_needs_enrollment_and_returns_the_rating() {
    let h = Harness::new();
    let r = h.agent.handle(Request::CheckUrl {
        url: "https://example.com".into(),
    });
    assert_eq!(r["code"], "not_enrolled");
    h.enroll();
    let r = h.agent.handle(Request::CheckUrl {
        url: "https://example.com".into(),
    });
    assert_eq!(r["ok"], true);
    assert!(r["rating"].is_string());
    assert!(r["reasons"].is_array());
}

#[test]
fn device_flow_sign_in_enrolls_through_the_service() {
    let h = Harness::new();
    let s = h.agent.handle(Request::SelfEnrollStart {
        name: Some("Grandma's PC".into()),
        server_url: Some("http://127.0.0.1:3007".into()),
    });
    assert_eq!(s["userCode"], "ABCD-EFGH");
    assert!(s.get("deviceCode").is_none(), "the device code stays in the service");
    let start = h
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.url.ends_with("/api/desktop/device"))
        .cloned()
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(start.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["device"]["kind"], "desktop_agent");
    assert_eq!(body["device"]["name"], "Grandma's PC");
    let p = h.agent.handle(Request::SelfEnrollPoll);
    assert_eq!(p["status"], "approved");
    assert_eq!(h.agent.status()["state"], "enrolled");
    assert_eq!(h.secrets.0.lock().unwrap().as_ref().unwrap().token, "neo_dt_fromflow");
    assert_eq!(h.agent.handle(Request::SelfEnrollPoll)["code"], "no_sign_in");
}

#[test]
fn update_check_runs_on_start_even_when_not_enrolled_and_applies_once() {
    let h = Harness::new();
    *h.updater.available.lock().unwrap() = Some(Available {
        version: "9.9.9".into(),
        url: "https://example.com/neo.msi".into(),
        signature: "x".into(),
    });
    h.agent.tick();
    assert_eq!(*h.updater.applied.lock().unwrap(), vec!["9.9.9".to_string()]);
    assert_eq!(h.agent.status()["updateAvailable"], json!("9.9.9"));
    h.clock.advance(60);
    h.agent.tick();
    assert_eq!(h.updater.applied.lock().unwrap().len(), 1, "daily, not every tick");
}
