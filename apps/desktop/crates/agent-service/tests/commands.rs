//! `end_session` commands in the whole service (`_specs/v2-m3-cutover.md` section 4), on Linux with
//! fakes: the command arrives in the signed bundle of an Elder (or any) device, the person confirms
//! in the tray, only the named tool's programs are closed, and the server is told what happened. The
//! pure rules (confirm, decline, timeout, expiry, duplicates, targets) are tested in
//! `neo-agent-core::commands`; these tests are about the wiring and the order of things.

mod common;

use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;

use common::*;
use neo_agent::protocol::Request;
use neo_agent_core::snapshot::ProcessInfo;
use serde_json::{Value, json};

const SESSION_LOG: &str = r"C:\Users\Gran\AppData\Roaming\AnyDesk\connection_trace.txt";

fn iso(unix: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(unix)
        .unwrap()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

fn command(id: &str, tool: &str, confirm: bool, expires_in: i64) -> Value {
    json!({
        "id": id, "kind": "end_session",
        "sessionRef": { "toolId": tool, "peerId": "123 456 789" },
        "requiresConfirmation": confirm,
        "expiresAt": iso(T0 + expires_in),
    })
}

/// An Elder device's bundle carrying `commands` (none: the key is absent, as the server does).
fn bundle_with(commands: &[Value]) -> Value {
    child_bundle(|b| {
        b["mode"] = json!("elder");
        if !commands.is_empty() {
            b["commands"] = json!(commands);
        }
    })
}

/// A program the person started: in their session, not a system account, not under Windows.
fn user_proc(pid: u32, image: &str) -> ProcessInfo {
    ProcessInfo {
        pid,
        image_name: image.into(),
        image_path: format!(r"C:\Users\Gran\AppData\Local\{image}"),
        session_id: Some(1),
        system_owned: Some(false),
        ..Default::default()
    }
}

/// A Windows service process of the tool: session 0, SYSTEM.
fn service_proc(pid: u32, image: &str) -> ProcessInfo {
    ProcessInfo {
        session_id: Some(0),
        system_owned: Some(true),
        image_path: format!(r"C:\Program Files\Tool\{image}"),
        ..user_proc(pid, image)
    }
}

fn terminated(h: &Harness) -> Vec<u32> {
    h.actuator.terminated.lock().unwrap().iter().map(|t| t.pid).collect()
}

fn results(h: &Harness) -> Vec<Value> {
    h.server
        .posted_events()
        .into_iter()
        .filter(|e| e["detector"] == "command_result")
        .collect()
}

fn pushes(rx: &Receiver<String>, kind: &str) -> Vec<Value> {
    drain(rx).into_iter().filter(|p| p["push"] == kind).collect()
}

fn answer(h: &Harness, id: &str, end: bool) -> Value {
    h.agent.handle(Request::CommandAnswer { id: id.into(), end })
}

/// An enrolled Elder device whose first bundle carries `commands`, with the tray listening.
fn device(commands: &[Value], procs: Vec<ProcessInfo>) -> (Harness, Receiver<String>) {
    let h = Harness::child(&bundle_with(commands));
    let rx = h.agent.hub().subscribe();
    h.probe.set_processes(procs);
    (h, rx)
}

#[test]
fn a_confirmed_command_asks_first_then_closes_only_that_tool_and_reports_done() {
    let (h, rx) = device(
        &[command("c1", "anydesk", true, 600)],
        vec![
            user_proc(10, "AnyDesk.exe"),
            user_proc(11, "notepad.exe"),
            user_proc(12, "TeamViewer.exe"),
            service_proc(13, "AnyDesk.exe"),
        ],
    );
    h.agent.tick();
    let asked = pushes(&rx, "confirm");
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["id"], "c1");
    assert_eq!(asked[0]["kind"], "end_session");
    assert!(asked[0]["title"].as_str().unwrap().contains("AnyDesk"), "{}", asked[0]);
    assert!(terminated(&h).is_empty(), "nothing is closed before the person answers");
    assert!(results(&h).is_empty());

    assert_eq!(answer(&h, "c1", true)["answered"], true);
    assert_eq!(
        terminated(&h),
        [10],
        "the person's AnyDesk only: not Notepad, not TeamViewer, not the SYSTEM service"
    );
    h.advance(1);
    h.agent.tick();
    let r = results(&h);
    assert_eq!(r.len(), 1);
    assert_eq!(
        (r[0]["commandId"].as_str(), r[0]["outcome"].as_str(), r[0]["detail"].as_str()),
        (Some("c1"), Some("done"), Some("closed"))
    );
    assert_eq!(r[0]["type"], "command");
    assert_eq!(pushes(&rx, "confirm_done").len(), 1, "the prompt is told it is over");
}

#[test]
fn keeping_the_session_closes_nothing_and_reports_declined() {
    let (h, rx) = device(&[command("c1", "anydesk", true, 600)], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    assert_eq!(pushes(&rx, "confirm").len(), 1);
    answer(&h, "c1", false);
    h.advance(1);
    h.agent.tick();
    assert!(terminated(&h).is_empty());
    let r = results(&h);
    assert_eq!(
        (r[0]["outcome"].as_str(), r[0]["detail"].as_str()),
        (Some("declined"), Some("kept"))
    );
}

#[test]
fn no_answer_in_two_minutes_is_declined_and_a_late_answer_does_nothing() {
    let (h, _rx) = device(&[command("c1", "anydesk", true, 600)], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    h.run(119);
    assert!(results(&h).is_empty(), "still waiting");
    h.run(2);
    let r = results(&h);
    assert_eq!(
        (r[0]["outcome"].as_str(), r[0]["detail"].as_str()),
        (Some("declined"), Some("no_answer"))
    );
    assert_eq!(answer(&h, "c1", true)["answered"], false);
    h.run(3);
    assert!(terminated(&h).is_empty());
    assert_eq!(results(&h).len(), 1);
}

#[test]
fn an_expired_command_is_reported_expired_and_never_acted_on() {
    // Already expired when the bundle arrives (a slow poll, or an old bundle).
    let (h, rx) = device(&[command("old", "anydesk", false, -5)], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    assert!(terminated(&h).is_empty());
    assert!(pushes(&rx, "confirm").is_empty());
    let r = results(&h);
    assert_eq!(
        (r[0]["commandId"].as_str(), r[0]["outcome"].as_str()),
        (Some("old"), Some("expired"))
    );
}

#[test]
fn a_command_without_confirmation_closes_at_once() {
    let (h, rx) = device(
        &[command("c1", "teamviewer", false, 600)],
        vec![user_proc(10, "AnyDesk.exe"), user_proc(12, "TeamViewer.exe")],
    );
    h.agent.tick();
    assert!(pushes(&rx, "confirm").is_empty(), "a child's computer: no prompt");
    assert_eq!(terminated(&h), [12]);
    let r = results(&h);
    assert_eq!((r[0]["outcome"].as_str(), r[0]["detail"].as_str()), (Some("done"), Some("closed")));
}

#[test]
fn with_no_tray_to_ask_the_command_fails_and_nothing_is_closed() {
    let h = Harness::child(&bundle_with(&[command("c1", "anydesk", true, 600)]));
    h.probe.set_processes(vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick(); // nobody subscribed
    assert!(terminated(&h).is_empty());
    let r = results(&h);
    assert_eq!(
        (r[0]["outcome"].as_str(), r[0]["detail"].as_str()),
        (Some("failed"), Some("tray_unavailable"))
    );
}

#[test]
fn a_command_is_acted_on_once_across_refetches_and_restarts() {
    let b = bundle_with(&[command("c1", "anydesk", false, 600)]);
    let (h, _rx) = device(&[command("c1", "anydesk", false, 600)], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    assert_eq!(terminated(&h), [10]);
    // The same bundle again, and the stored bundle after a restart: no second run, no second report.
    h.probe.set_processes(vec![user_proc(20, "AnyDesk.exe")]);
    h.serve_policy(&b);
    h.advance(3600);
    h.agent.tick();
    let again = h.restart();
    h.run_with(&again, 3);
    assert_eq!(terminated(&h), [10]);
    assert_eq!(results(&h).len(), 1);
}

#[test]
fn a_replayed_old_bundle_with_a_handled_command_does_nothing() {
    let (h, _rx) = device(&[command("c1", "anydesk", false, 600)], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    assert_eq!(terminated(&h), [10]);
    let restarted = h.restart();
    h.probe.set_processes(vec![user_proc(30, "AnyDesk.exe")]);
    h.run_with(&restarted, 5);
    assert_eq!(terminated(&h), [10]);
}

#[test]
fn only_protected_programs_are_never_closed_and_the_result_says_so() {
    let (h, _rx) = device(&[command("c1", "anydesk", false, 600)], vec![service_proc(13, "AnyDesk.exe")]);
    h.agent.tick();
    assert!(terminated(&h).is_empty());
    let r = results(&h);
    assert_eq!(
        (r[0]["outcome"].as_str(), r[0]["detail"].as_str()),
        (Some("failed"), Some("protected"))
    );
}

#[test]
fn a_program_that_will_not_close_is_a_failure_not_a_success() {
    let (h, _rx) = device(&[command("c1", "anydesk", false, 600)], vec![user_proc(10, "AnyDesk.exe")]);
    h.actuator.fail_terminate.store(true, Ordering::SeqCst);
    h.agent.tick();
    let r = results(&h);
    assert_eq!(
        (r[0]["outcome"].as_str(), r[0]["detail"].as_str()),
        (Some("failed"), Some("close_failed"))
    );
}

#[test]
fn nothing_running_is_done_with_not_running() {
    let (h, _rx) = device(&[command("c1", "anydesk", false, 600)], vec![user_proc(11, "notepad.exe")]);
    h.agent.tick();
    let r = results(&h);
    assert_eq!(
        (r[0]["outcome"].as_str(), r[0]["detail"].as_str()),
        (Some("done"), Some("not_running"))
    );
}

#[test]
fn a_tool_the_lists_do_not_know_fails_as_not_supported() {
    let (h, _rx) = device(&[command("c1", "mystery_tool", false, 600)], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    assert!(terminated(&h).is_empty());
    let r = results(&h);
    assert_eq!(
        (r[0]["outcome"].as_str(), r[0]["detail"].as_str()),
        (Some("failed"), Some("not_supported"))
    );
}

#[test]
fn unknown_kinds_are_ignored_and_a_bundle_without_commands_changes_nothing() {
    let mut other = command("c1", "anydesk", false, 600);
    other["kind"] = json!("lock_screen");
    let (h, rx) = device(&[other], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    assert!(terminated(&h).is_empty() && results(&h).is_empty());
    assert!(pushes(&rx, "confirm").is_empty());
    let (h, _rx) = device(&[], vec![user_proc(10, "AnyDesk.exe")]);
    h.run(5);
    assert!(terminated(&h).is_empty() && results(&h).is_empty());
}

#[test]
fn an_answer_for_an_unknown_id_does_nothing() {
    let (h, _rx) = device(&[], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    assert_eq!(answer(&h, "nope", true)["answered"], false);
    assert!(terminated(&h).is_empty());
}

#[test]
fn unenrolling_forgets_the_handled_commands() {
    let (h, _rx) = device(&[command("c1", "anydesk", false, 600)], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    assert!(h.dir.root().join("commands.json").exists());
    h.agent.handle(Request::Unenroll);
    assert!(!h.dir.root().join("commands.json").exists());
}

// ---- the fast poll ------------------------------------------------------------------------------

fn policy_gets(h: &Harness) -> usize {
    h.server.count("GET /api/devices/policy")
}

#[test]
fn the_policy_is_not_polled_every_minute_without_a_reason() {
    let (h, _rx) = device(&[], vec![]);
    h.agent.tick();
    let first = policy_gets(&h);
    h.run(300);
    assert_eq!(policy_gets(&h), first, "only the hourly heartbeat fetches it");
}

#[test]
fn a_seen_remote_session_arms_the_minute_poll_for_half_an_hour() {
    let (h, _rx) = device(&[], vec![]);
    h.probe.write_file(SESSION_LOG, "Incoming 2020-01-01 00:00:00 Accepted 111111111\n");
    h.agent.tick();
    h.run(40);
    let before = policy_gets(&h);
    h.probe
        .append_file(SESSION_LOG, "Incoming 2026-11-03 15:00:00 Accepted 123456789\n");
    h.run(10);
    assert!(h.sent().contains(&"remote_access_session".to_string()), "{:?}", h.sent());
    h.run(180);
    let during = policy_gets(&h);
    assert!(during >= before + 3, "polled about once a minute: {before} -> {during}");
    // 30 minutes on it stops.
    h.run(30 * 60);
    let after_window = policy_gets(&h);
    h.run(300);
    assert_eq!(policy_gets(&h), after_window);
}

#[test]
fn the_heartbeat_hint_arms_the_poll_and_a_command_found_by_it_is_acted_on() {
    let (h, rx) = device(&[], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    h.server.pending_command.store(true, Ordering::SeqCst);
    h.advance(3600);
    h.agent.tick(); // the hourly heartbeat carries the hint
    let armed_at = policy_gets(&h);
    // The server now has a command; its bundle (and version) is only seen by the minute poll, not the heartbeat.
    let b = bundle_with(&[command("c9", "anydesk", true, 3600 + 600)]);
    *h.server.policy.lock().unwrap() = Some(sign(&b));
    h.run(65);
    assert!(policy_gets(&h) > armed_at);
    assert_eq!(
        pushes(&rx, "confirm").len(),
        1,
        "found within a minute, without waiting for the next heartbeat"
    );
}

#[test]
fn an_open_confirmation_keeps_the_poll_on() {
    let (h, _rx) = device(&[command("c1", "anydesk", true, 600)], vec![user_proc(10, "AnyDesk.exe")]);
    h.agent.tick();
    let before = policy_gets(&h);
    h.run(61);
    assert!(policy_gets(&h) > before);
}
