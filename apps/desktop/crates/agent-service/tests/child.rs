//! Child mode in the whole service (`_specs/v2-m2-child.md` section 7), on Linux with fakes: the
//! signed policy is fetched and verified, blocked apps are announced and then closed through the
//! `Actuator`, new apps wait for approval, screen time warns and locks, tamper is reported, and a
//! child can ask for more time. The pure rules are tested in `neo-agent-core`; these tests are about
//! the wiring and the order of things.

mod common;

use std::sync::atomic::Ordering;

use common::*;
use neo_agent::agent::Agent;
use neo_agent::protocol::Request;
use neo_agent_core::ledger::Console;
use neo_agent_core::snapshot::{ExeFacts, ProcessInfo, UninstallEntry};
use serde_json::{Value, json};

const TUE_2050_NY: i64 = 1_793_756_940; // 2026-11-04T01:49:00Z, 20:49 on Tuesday 3 November in New York

/// A program the child started: in the child's session, not a system account, not under Windows.
fn running(pid: u32, image: &str, signer: Option<&str>) -> ProcessInfo {
    ProcessInfo {
        pid,
        image_name: image.into(),
        image_path: format!(r"C:\Users\Kid\AppData\Local\{image}"),
        signer: signer.map(str::to_string),
        session_id: Some(1),
        system_owned: Some(false),
        ..Default::default()
    }
}

fn blocking(image: &str) -> Value {
    child_bundle(|b| b["apps"]["block"] = json!([{ "image": image }]))
}

fn terminated_pids(h: &Harness) -> Vec<u32> {
    h.actuator.terminated.lock().unwrap().iter().map(|t| t.pid).collect()
}

fn notices(h: &Harness) -> Vec<String> {
    h.actuator
        .log
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.starts_with("notice: "))
        .cloned()
        .collect()
}

fn heartbeat_bodies(h: &Harness) -> Vec<Value> {
    h.server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.url.ends_with("/api/devices/heartbeat"))
        .map(|r| serde_json::from_str(r.body.as_deref().unwrap()).unwrap())
        .collect()
}

// ---- the policy ---------------------------------------------------------------------------------

#[test]
fn the_policy_is_fetched_verified_stored_and_survives_a_restart() {
    let b = child_bundle(|_| {});
    let h = Harness::child(&b);
    assert_eq!(h.status()["hasPolicy"], false, "nothing is enforced before a bundle arrives");
    h.agent.tick();
    let st = h.status();
    assert_eq!(st["childMode"], true);
    assert_eq!(st["mode"], "child");
    assert_eq!(st["policyVersion"], b["policyVersion"]);
    assert_eq!(h.server.count("GET /api/devices/policy"), 1);
    assert!(h.dir.root().join("policy.json").exists());

    // The next heartbeat says which version is applied, and does not fetch again.
    h.advance(3600);
    h.agent.tick();
    assert_eq!(heartbeat_bodies(&h).last().unwrap()["policyVersion"], b["policyVersion"]);
    assert!(
        heartbeat_bodies(&h)[0].get("policyVersion").is_none(),
        "nothing applied yet at the first one"
    );
    assert_eq!(h.server.count("GET /api/devices/policy"), 1);

    // A restart (even offline) keeps enforcing: the stored bundle is verified again when read.
    h.server.offline.store(true, Ordering::SeqCst);
    let again = h.restart();
    assert_eq!(again.handle(Request::PolicyStatus)["childMode"], true);
}

#[test]
fn a_stored_bundle_that_no_longer_verifies_is_dropped_on_load() {
    let b = child_bundle(|_| {});
    let h = Harness::child(&b);
    h.agent.tick();
    let path = h.dir.root().join("policy.json");
    let text = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\"mode\":\"child\"", "\"mode\":\"standard\"");
    std::fs::write(&path, text).unwrap();
    assert_eq!(h.restart().handle(Request::PolicyStatus)["hasPolicy"], false);
}

#[test]
fn a_tampered_bundle_is_refused_the_last_one_stays_and_the_parent_is_told_once() {
    let h = Harness::child(&blocking("game.exe"));
    h.probe.set_processes(vec![running(7, "game.exe", None)]);
    h.agent.tick();
    let good = h.status()["policyVersion"].clone();
    assert_eq!(terminated_pids(&h), [7]);

    // A man in the middle turns the block list off but cannot sign it.
    let mut env = sign(&child_bundle(|b| b["apps"]["block"] = json!([{ "image": "other.exe" }])));
    env["bundle"]["apps"]["block"] = json!([]);
    *h.server.policy.lock().unwrap() = Some(env.clone());
    *h.server.policy_version.lock().unwrap() = env["bundle"]["policyVersion"].as_str().map(str::to_string);
    h.advance(3600);
    h.agent.tick();
    assert_eq!(h.status()["policyVersion"], good, "the last valid bundle is still in force");
    assert_eq!(terminated_pids(&h).len(), 2, "and still closes the app");
    assert_eq!(h.sent().iter().filter(|e| *e == "tamper_detected:bad_policy_signature").count(), 1);

    // The same bundle an hour later: still refused, not reported again.
    h.advance(3600);
    h.agent.tick();
    assert_eq!(h.sent().iter().filter(|e| *e == "tamper_detected:bad_policy_signature").count(), 1);
}

#[test]
fn a_bundle_signed_by_an_unknown_key_is_refused() {
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    let good = h.status()["policyVersion"].clone();
    let rotated = signing_key("a key this build does not know");
    let next = child_bundle(|b| b["mode"] = json!("standard"));
    *h.server.policy.lock().unwrap() = Some(sign_with(&rotated, "rotated-key", &next));
    *h.server.policy_version.lock().unwrap() = next["policyVersion"].as_str().map(str::to_string);
    h.advance(3600);
    h.agent.tick();
    assert_eq!(h.status()["policyVersion"], good);
    assert!(h.sent().contains(&"tamper_detected:bad_policy_signature".to_string()));
}

#[test]
fn a_validly_signed_bundle_for_another_device_is_refused() {
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    let good = h.status()["policyVersion"].clone();
    // Perhaps a sibling's, replayed: signed by the real key, but not this device's.
    let other = child_bundle(|b| {
        b["deviceId"] = json!("99999999-9999-4999-8999-999999999999");
        b["mode"] = json!("standard");
    });
    h.serve_policy(&other);
    h.advance(3600);
    h.agent.tick();
    assert_eq!(h.status()["policyVersion"], good);
    assert!(h.sent().contains(&"tamper_detected:bad_policy_signature".to_string()));
}

#[test]
fn an_older_bundle_does_not_replace_a_newer_one() {
    let h = Harness::child(&blocking("game.exe"));
    h.agent.tick();
    let current = h.status()["policyVersion"].clone();
    // A genuine, signed bundle from before the current one (a rollback to lift a block).
    let mut old = child_bundle(|b| b["mode"] = json!("standard"));
    old["issuedAt"] = json!("2026-11-02T00:00:00.000Z");
    *h.server.policy.lock().unwrap() = Some(sign(&old));
    *h.server.policy_version.lock().unwrap() = old["policyVersion"].as_str().map(str::to_string);
    h.advance(3600);
    h.agent.tick();
    assert_eq!(h.status()["policyVersion"], current);
    assert_eq!(h.status()["childMode"], true);
    assert!(
        !h.sent().iter().any(|e| e.starts_with("tamper_detected")),
        "not an attack on its own: it is just stale"
    );
}

#[test]
fn no_policy_signing_on_the_server_changes_nothing() {
    let h = Harness::child(&child_bundle(|_| {}));
    *h.server.policy.lock().unwrap() = None; // 503
    h.agent.tick();
    assert_eq!(h.status()["hasPolicy"], false);
    assert!(
        !h.sent().iter().any(|e| e.starts_with("tamper_detected")),
        "an unreachable policy is not tamper"
    );
}

#[test]
fn the_policy_is_polled_every_minute_while_a_request_is_open_and_conditionally_except_near_expiry() {
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    assert_eq!(h.server.count("GET /api/devices/policy"), 1);
    // Nothing open: no polling, however long it takes.
    h.run(120);
    assert_eq!(h.server.count("GET /api/devices/policy"), 1);

    *h.server.requests_list.lock().unwrap() = vec![json!({ "id": "req-1", "kind": "more_time", "status": "pending" })];
    let r = h.agent.handle(Request::RequestMoreTime { minutes: 30 });
    assert_eq!(r["ok"], true, "{r}");
    h.run(55);
    assert_eq!(h.server.count("GET /api/devices/policy"), 1, "not before a minute");
    h.run(10);
    assert_eq!(h.server.count("GET /api/devices/policy"), 2);
    let last_policy_get = |h: &Harness| {
        h.server
            .requests
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|r| r.url.ends_with("/api/devices/policy"))
            .cloned()
            .unwrap()
    };
    let version = h.status()["policyVersion"].as_str().unwrap().to_string();
    assert_eq!(last_policy_get(&h).header("if-none-match"), Some(format!("\"{version}\"").as_str()));
    h.run(60);
    assert_eq!(h.server.count("GET /api/devices/policy"), 3, "and again a minute later");

    // Within a day of expiry (2026-11-10T14:00Z) the ETag is not sent, to get a fresh signature.
    let near = 1_794_236_400; // 2026-11-09T15:00:00Z
    let now = h.clock.0.lock().unwrap().unix_timestamp();
    h.advance(near - now);
    h.run(61);
    assert!(last_policy_get(&h).header("if-none-match").is_none());
}

// ---- apps -----------------------------------------------------------------------------------------

#[test]
fn a_blocked_app_is_announced_then_closed_and_reported() {
    let h = Harness::child(&child_bundle(|b| {
        b["apps"]["block"] = json!([{ "signer": "Roblox Corporation", "image": "RobloxPlayerBeta.exe" }]);
    }));
    h.agent.tick();
    h.probe.set_processes(vec![
        running(7, "RobloxPlayerBeta.exe", Some("CN=Roblox Corporation, O=Roblox Corporation")),
        running(8, "notepad.exe", None),
    ]);
    h.run(5);
    assert_eq!(terminated_pids(&h), [7], "only the blocked app");
    let log = h.actuator.log.lock().unwrap().clone();
    let at = |needle: &str| {
        log.iter()
            .position(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("{needle} not in {log:?}"))
    };
    assert!(
        at("is blocked in Child mode") < at("terminate: 7"),
        "the message comes first: {log:?}"
    );
    assert!(
        log.iter()
            .any(|l| l == "notice: GRANDMA-PC: RobloxPlayerBeta is blocked in Child mode"),
        "{log:?}"
    );
    // The event carries names only.
    let ev: Vec<Value> = h
        .server
        .posted_events()
        .into_iter()
        .filter(|e| e["detector"] == "app_blocked")
        .collect();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["type"], "software");
    assert_eq!(ev[0]["image"], "RobloxPlayerBeta.exe");
    assert_eq!(ev[0]["signer"], "Roblox Corporation");
    assert!(!ev[0].to_string().contains("AppData"), "never a path");

    // The child starts it again at once and again later: closed each time, but one message a
    // minute and one report an hour.
    h.run(30);
    assert!(terminated_pids(&h).len() >= 5);
    assert_eq!(notices(&h).iter().filter(|n| n.contains("is blocked")).count(), 1);
    assert_eq!(h.sent().iter().filter(|e| *e == "app_blocked").count(), 1);
    h.run(60);
    assert_eq!(notices(&h).iter().filter(|n| n.contains("is blocked")).count(), 2);
}

#[test]
fn a_process_is_not_reported_when_the_close_failed() {
    let h = Harness::child(&blocking("game.exe"));
    h.agent.tick();
    h.actuator.fail_terminate.store(true, Ordering::SeqCst);
    h.probe.set_processes(vec![running(7, "game.exe", None)]);
    h.run(5);
    assert!(h.actuator.terminated.lock().unwrap().is_empty());
    assert!(!h.sent().contains(&"app_blocked".to_string()));
}

#[test]
fn system_neo_and_unknown_processes_are_never_closed_whatever_the_policy_says() {
    // Every one of these is named by the block list.
    let names = [
        "nofacts.exe",
        "svc.exe",
        "winfile.exe",
        "service.exe",
        "neo.exe",
        "agent.exe",
        "inneo.exe",
        "approved.exe",
        "game.exe",
    ];
    let h = Harness::child(&child_bundle(|b| {
        b["apps"]["block"] = json!(names.iter().map(|n| json!({ "image": n })).collect::<Vec<_>>());
        b["apps"]["approved"] = json!([{ "image": "approved.exe" }]);
    }));
    h.agent.tick();
    let base = |pid: u32, image: &str| running(pid, image, None);
    h.probe.set_processes(vec![
        ProcessInfo {
            session_id: None,
            system_owned: None,
            ..base(1, "nofacts.exe")
        },
        ProcessInfo {
            session_id: Some(0),
            ..base(2, "svc.exe")
        },
        ProcessInfo {
            image_path: r"C:\Windows\System32\winfile.exe".into(),
            ..base(3, "winfile.exe")
        },
        ProcessInfo {
            system_owned: Some(true),
            ..base(4, "service.exe")
        },
        base(5, "Neo.exe"),
        base(4242, "agent.exe"),
        ProcessInfo {
            image_path: r"C:\Program Files\Neo\inneo.exe".into(),
            ..base(6, "inneo.exe")
        },
        base(9, "approved.exe"),
        base(10, "game.exe"),
    ]);
    h.run(5);
    assert_eq!(terminated_pids(&h), [10], "only the ordinary program");
}

#[test]
fn nothing_is_closed_or_reported_outside_child_mode() {
    let h = Harness::child(&child_bundle(|b| {
        b["mode"] = json!("standard");
        b["apps"]["block"] = json!([{ "image": "game.exe" }]);
    }));
    h.agent.tick();
    h.probe
        .set_processes(vec![running(7, "game.exe", None), running(8, "nordvpn.exe", None)]);
    h.probe.set_uninstall(vec![UninstallEntry {
        display_name: "New thing".into(),
        install_location: Some(r"C:\n".into()),
        ..Default::default()
    }]);
    h.run(130);
    assert!(h.actuator.terminated.lock().unwrap().is_empty());
    assert_eq!(h.status()["childMode"], false);
    assert!(
        h.sent()
            .iter()
            .all(|e| e == "remote_access_tool" || e.starts_with("remote_") || e == "unwanted_software"),
        "{:?}",
        h.sent()
    );
    assert_eq!(h.actuator.locks.load(Ordering::SeqCst), 0);
}

fn epic() -> UninstallEntry {
    UninstallEntry {
        display_name: "Epic Games Launcher".into(),
        publisher: Some("Epic Games, Inc.".into()),
        display_icon: Some(r"C:\Program Files\Epic\Launcher\EpicGamesLauncher.exe,0".into()),
        install_location: Some(r"C:\Program Files\Epic".into()),
        ..Default::default()
    }
}

fn chrome() -> UninstallEntry {
    UninstallEntry {
        display_name: "Google Chrome".into(),
        publisher: Some("Google LLC".into()),
        install_location: Some(r"C:\Program Files\Google\Chrome".into()),
        ..Default::default()
    }
}

fn epic_facts() -> ExeFacts {
    ExeFacts {
        path: r"C:\Program Files\Epic\Launcher\EpicGamesLauncher.exe".into(),
        sha256: "a".repeat(64),
        signed_trusted: true,
        signer: Some("Epic Games, Inc.".into()),
    }
}

#[test]
fn a_new_app_is_reported_and_its_launches_are_closed_until_a_parent_approves_it() {
    let h = Harness::child(&child_bundle(|b| b["apps"]["requireApproval"] = json!(true)));
    h.probe.set_uninstall(vec![chrome()]);
    h.agent.tick(); // the first list is the baseline: nothing in it is new
    assert!(!h.sent().contains(&"app_installed".to_string()));

    h.probe.set_uninstall(vec![chrome(), epic()]);
    h.probe.snap.lock().unwrap().exe_facts = vec![epic_facts()];
    h.run(65);
    let installed: Vec<Value> = h
        .server
        .posted_events()
        .into_iter()
        .filter(|e| e["detector"] == "app_installed")
        .collect();
    assert_eq!(installed.len(), 1, "{:?}", h.sent());
    assert_eq!(installed[0]["name"], "Epic Games Launcher");
    assert_eq!(installed[0]["signer"], "Epic Games, Inc.");
    assert_eq!(installed[0]["image"], "EpicGamesLauncher.exe");
    assert_eq!(h.agent.child_pending_apps().len(), 1);

    // Launching it: told, then closed.
    h.probe
        .set_processes(vec![running(30, "EpicGamesLauncher.exe", Some("CN=Epic Games, Inc."))]);
    h.run(5);
    assert_eq!(terminated_pids(&h), [30]);
    let log = h.actuator.log.lock().unwrap().clone();
    let notice = log
        .iter()
        .position(|l| l == "notice: Waiting for a parent to approve")
        .expect("the notice");
    assert!(notice < log.iter().position(|l| l == "terminate: 30").unwrap());

    // A parent approves it: the next bundle lists it, and the launch is left alone from then on.
    let approved = child_bundle(|b| {
        b["apps"]["requireApproval"] = json!(true);
        b["apps"]["approved"] = json!([{ "signer": "Epic Games, Inc.", "image": "EpicGamesLauncher.exe" }]);
    });
    h.serve_policy(&approved);
    h.advance(3600);
    h.agent.tick();
    let closed = terminated_pids(&h).len();
    h.run(30);
    assert_eq!(terminated_pids(&h).len(), closed, "no more closes once approved");
    assert!(h.agent.child_pending_apps().is_empty());
}

#[test]
fn without_required_approval_a_new_app_is_reported_but_never_held() {
    let h = Harness::child(&child_bundle(|b| b["apps"]["requireApproval"] = json!(false)));
    h.probe.set_uninstall(vec![chrome()]);
    h.agent.tick();
    h.probe.set_uninstall(vec![chrome(), epic()]);
    h.probe.snap.lock().unwrap().exe_facts = vec![epic_facts()];
    h.run(65);
    assert!(
        h.sent().contains(&"app_installed".to_string()),
        "the 14 to 17 band: the server records it"
    );
    assert!(h.agent.child_pending_apps().is_empty());
    h.probe
        .set_processes(vec![running(30, "EpicGamesLauncher.exe", Some("CN=Epic Games, Inc."))]);
    h.run(10);
    assert!(h.actuator.terminated.lock().unwrap().is_empty());
}

#[test]
fn apps_installed_before_the_first_bundle_are_baseline_not_new() {
    // No bundle can be fetched yet: the list is not recorded, so the first list after the first
    // bundle is the baseline, and an app installed in between is not mistaken for a new one.
    let h = Harness::child(&child_bundle(|b| b["apps"]["requireApproval"] = json!(true)));
    *h.server.policy.lock().unwrap() = None;
    h.probe.set_uninstall(vec![chrome(), epic()]);
    h.probe.snap.lock().unwrap().exe_facts = vec![epic_facts()];
    h.run(70);
    assert!(!h.sent().contains(&"app_installed".to_string()));
    assert!(h.agent.child_pending_apps().is_empty());
}

// ---- screen time ------------------------------------------------------------------------------------

#[test]
fn the_budget_warns_then_locks_and_a_grant_unlocks() {
    let h = Harness::child(&child_bundle(|b| {
        b["screenTime"]["dailyMinutes"]["tue"] = json!(2);
        b["screenTime"]["warnMinutes"] = json!(1);
    }));
    h.agent.tick();
    h.run(70);
    assert!(
        notices(&h).iter().any(|n| n == "notice: GRANDMA-PC: 1 minute of screen time left"),
        "{:?}",
        notices(&h)
    );
    assert_eq!(h.actuator.locks.load(Ordering::SeqCst), 0);
    h.run(60);
    assert!(h.actuator.locks.load(Ordering::SeqCst) >= 1, "locked at zero");
    let log = h.actuator.log.lock().unwrap().clone();
    let up = log
        .iter()
        .position(|l| l == "notice: GRANDMA-PC: screen time is up")
        .expect("a message");
    assert!(
        up < log.iter().position(|l| l == "lock").unwrap(),
        "the message comes before the lock"
    );
    assert_eq!(h.sent().iter().filter(|e| *e == "screen_time_exhausted").count(), 1);
    assert_eq!(h.status()["remainingMinutes"], 0);

    // The session is locked now. A parent grants half an hour; the new bundle arrives and the
    // person can use the computer again.
    h.probe.console.lock().unwrap().locked = true;
    let locks = h.actuator.locks.load(Ordering::SeqCst);
    let granted = child_bundle(|b| {
        b["screenTime"]["dailyMinutes"]["tue"] = json!(2);
        b["screenTime"]["warnMinutes"] = json!(1);
        b["screenTime"]["grants"] = json!([{ "minutes": 30, "until": "2026-11-04T05:00:00.000Z" }]);
    });
    h.serve_policy(&granted);
    h.advance(3600);
    h.agent.tick();
    h.probe.console.lock().unwrap().locked = false;
    h.run(60);
    assert_eq!(h.actuator.locks.load(Ordering::SeqCst), locks, "no lock while the grant runs");
    let left = h.status()["remainingMinutes"].as_u64().unwrap();
    assert!((28..=30).contains(&left), "{left}");
}

#[test]
fn locked_screens_and_a_signed_out_console_use_no_time() {
    let h = Harness::child(&child_bundle(|b| b["screenTime"]["dailyMinutes"]["tue"] = json!(60)));
    h.agent.tick();
    h.probe.console.lock().unwrap().locked = true;
    h.run(120);
    h.probe.console.lock().unwrap().locked = false;
    h.probe.console.lock().unwrap().present = false;
    h.run(120);
    *h.probe.console.lock().unwrap() = Console {
        present: true,
        locked: false,
        idle_secs: Some(600),
    };
    h.run(120);
    assert_eq!(h.status()["usedMinutes"], 0);
    *h.probe.console.lock().unwrap() = Console {
        present: true,
        locked: false,
        idle_secs: Some(1),
    };
    h.run(120);
    assert_eq!(h.status()["usedMinutes"], 2);
}

#[test]
fn downtime_warns_ten_minutes_ahead_locks_and_spares_the_apps_a_parent_allowed() {
    let h = Harness::child_at(
        &child_bundle(|b| {
            b["screenTime"]["downtime"] = json!([{ "start": "21:00", "end": "07:00" }]);
            b["screenTime"]["allowDuringDowntime"] = json!([{ "image": "call.exe" }]);
            b["apps"]["block"] = json!([{ "image": "call.exe" }, { "image": "game.exe" }]);
        }),
        TUE_2050_NY,
    );
    h.probe
        .set_processes(vec![running(7, "call.exe", None), running(8, "game.exe", None)]);
    h.agent.tick();
    assert_eq!(terminated_pids(&h), [7, 8], "before downtime both are blocked");
    assert_eq!(h.status()["inDowntime"], false);
    assert_eq!(h.status()["nextDowntimeAt"], "2026-11-04T02:00:00Z");

    h.run(12 * 60);
    assert!(
        notices(&h).iter().any(|n| n == "notice: GRANDMA-PC: downtime starts in 10 minutes"),
        "{:?}",
        notices(&h)
    );
    assert!(h.actuator.locks.load(Ordering::SeqCst) >= 1, "locked when downtime began");
    assert_eq!(h.status()["inDowntime"], true);
    assert_eq!(h.sent().iter().filter(|e| *e == "screen_time_exhausted").count(), 1);
    // During downtime the allowed app is no longer closed; the other still is.
    let closed_call = h.actuator.terminated.lock().unwrap().iter().filter(|t| t.pid == 7).count();
    let closed_game = h.actuator.terminated.lock().unwrap().iter().filter(|t| t.pid == 8).count();
    h.run(30);
    assert_eq!(
        h.actuator.terminated.lock().unwrap().iter().filter(|t| t.pid == 7).count(),
        closed_call
    );
    assert!(h.actuator.terminated.lock().unwrap().iter().filter(|t| t.pid == 8).count() > closed_game);
    assert_eq!(h.status()["downtimeEndsAt"], "2026-11-04T12:00:00Z");
}

#[test]
fn policy_status_reports_the_time_left_for_the_tray() {
    let h = Harness::child(&child_bundle(|b| {
        b["screenTime"]["dailyMinutes"]["tue"] = json!(120);
        b["screenTime"]["downtime"] = json!([{ "start": "21:00", "end": "07:00" }]);
    }));
    h.agent.tick();
    h.run(65);
    let st = h.status();
    assert_eq!(st["ok"], true);
    assert_eq!(st["childMode"], true);
    assert_eq!(st["limited"], true);
    assert_eq!(st["remainingMinutes"], 119);
    assert_eq!(st["usedMinutes"], 1);
    assert_eq!(st["inDowntime"], false);
    assert_eq!(st["nextDowntimeAt"], "2026-11-04T02:00:00Z");
    assert_eq!(st["expired"], false);
    // No limit: the tray shows no countdown.
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    h.run(10);
    assert_eq!(h.status()["limited"], false);
    assert!(h.status()["remainingMinutes"].is_null());
}

#[test]
fn an_expired_bundle_keeps_being_enforced() {
    let h = Harness::child(&blocking("game.exe"));
    h.agent.tick();
    // A week and a day later, offline: the bundle is stale, not void.
    h.server.offline.store(true, Ordering::SeqCst);
    h.advance(8 * 86_400);
    h.probe.set_processes(vec![running(7, "game.exe", None)]);
    h.agent.tick();
    h.run(5);
    assert!(terminated_pids(&h).iter().all(|p| *p == 7) && !terminated_pids(&h).is_empty());
    assert_eq!(h.status()["expired"], true);
    assert_eq!(h.status()["childMode"], true);
}

// ---- tamper -----------------------------------------------------------------------------------------

#[test]
fn a_vpn_app_is_reported_once_in_six_hours() {
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    h.probe.set_processes(vec![running(9, "NordVPN.exe", None)]);
    h.run(30);
    assert_eq!(h.sent().iter().filter(|e| *e == "tamper_detected:vpn_app").count(), 1);
    h.run(600);
    assert_eq!(h.sent().iter().filter(|e| *e == "tamper_detected:vpn_app").count(), 1);
    h.advance(6 * 3600);
    h.run(10);
    assert_eq!(h.sent().iter().filter(|e| *e == "tamper_detected:vpn_app").count(), 2);
}

#[test]
fn a_browser_without_the_extension_is_reported_only_when_the_server_says_the_extension_is_missing() {
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    h.probe.set_processes(vec![running(9, "chrome.exe", None)]);
    h.run(60);
    assert!(
        !h.sent().contains(&"tamper_detected:browser_without_extension".to_string()),
        "unknown: nothing is reported"
    );
    *h.server.extension_enrolled.lock().unwrap() = Some(true);
    h.advance(3600);
    h.run(10);
    assert!(!h.sent().contains(&"tamper_detected:browser_without_extension".to_string()));
    *h.server.extension_enrolled.lock().unwrap() = Some(false);
    h.advance(3600);
    h.run(10);
    assert!(h.sent().contains(&"tamper_detected:browser_without_extension".to_string()));
}

#[test]
fn moving_the_computers_clock_is_reported_and_does_not_move_the_day() {
    let h = Harness::child(&child_bundle(|b| b["screenTime"]["dailyMinutes"]["tue"] = json!(10)));
    h.agent.tick();
    h.run(300);
    let used = h.status()["usedMinutes"].clone();
    // The child sets the clock a day forward to get a fresh budget: the wall clock moves, the
    // monotonic clocks do not.
    h.clock.advance(86_400);
    h.run(30);
    assert_eq!(h.sent().iter().filter(|e| *e == "tamper_detected:clock_changed").count(), 1);
    assert!(h.status()["usedMinutes"].as_u64() >= used.as_u64(), "the budget was not reset");
    // Not reported again for the same change.
    h.run(60);
    assert_eq!(h.sent().iter().filter(|e| *e == "tamper_detected:clock_changed").count(), 1);
}

#[test]
fn the_servers_date_corrects_a_clock_that_was_wrong_from_the_start() {
    let h = Harness::child(&child_bundle(|_| {}));
    // The server says it is 4 November 00:48; this computer's clock says 3 November 15:00.
    *h.server.date.lock().unwrap() = Some("Wed, 04 Nov 2026 00:48:25 GMT".into());
    h.agent.tick();
    h.run(10);
    assert_eq!(h.sent().iter().filter(|e| *e == "tamper_detected:clock_changed").count(), 1);
}

#[test]
fn a_service_that_was_off_while_the_computer_was_on_is_reported_after_it_restarts() {
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    h.run(70);
    assert!(h.dir.root().join("alive.json").exists());
    // Twenty awake minutes with nobody running the service, then it starts again.
    h.advance(1200);
    let again = h.restart();
    again.tick();
    assert!(
        h.sent().contains(&"tamper_detected:agent_service_stopped".to_string()),
        "{:?}",
        h.sent()
    );
}

#[test]
fn a_reboot_a_short_restart_and_sleep_are_not_a_stopped_service() {
    // A quick restart.
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    h.run(70);
    h.advance(30);
    h.restart().tick();
    assert!(!h.sent().contains(&"tamper_detected:agent_service_stopped".to_string()));

    // A shutdown for the night: the clocks start again at boot.
    h.clock.advance(8 * 3600);
    *h.probe.clocks.lock().unwrap() = neo_agent::clocks::Clocks {
        boot_secs: 20,
        awake_secs: 20,
    };
    h.restart().tick();
    assert!(!h.sent().contains(&"tamper_detected:agent_service_stopped".to_string()));

    // The lid was closed for hours: the boot clock ran, the awake clock did not.
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    h.run(70);
    h.clock.advance(6 * 3600);
    h.probe.clocks.lock().unwrap().boot_secs += 6 * 3600;
    h.restart().tick();
    assert!(!h.sent().contains(&"tamper_detected:agent_service_stopped".to_string()));
}

// ---- asking for more time -----------------------------------------------------------------------------

#[test]
fn a_child_asks_for_more_time_and_hears_the_answer() {
    let h = Harness::child(&child_bundle(|b| b["screenTime"]["dailyMinutes"]["tue"] = json!(60)));
    h.agent.tick();
    let rx = h.agent.hub().subscribe();
    let r = h.agent.handle(Request::RequestMoreTime { minutes: 30 });
    assert_eq!(r["ok"], true);
    assert_eq!(r["id"], "req-1");
    assert_eq!(r["status"], "pending");
    let sent = h
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|r| r.url.ends_with("/api/devices/requests"))
        .cloned()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(sent.body.as_deref().unwrap()).unwrap(),
        json!({ "kind": "more_time", "detail": { "minutes": 30 } })
    );
    assert_eq!(h.status()["pendingRequests"], 1);

    // The parent says yes: the next poll (a minute later) fetches the new bundle and tells the child.
    *h.server.requests_list.lock().unwrap() =
        vec![json!({ "id": "req-1", "kind": "more_time", "status": "approved", "decidedAt": "2026-11-03T15:01:00.000Z" })];
    let granted = child_bundle(|b| {
        b["screenTime"]["dailyMinutes"]["tue"] = json!(60);
        b["screenTime"]["grants"] = json!([{ "minutes": 30, "until": "2026-11-04T05:00:00.000Z" }]);
    });
    h.serve_policy(&granted);
    h.run(65);
    let pushes = drain(&rx);
    assert!(
        pushes
            .iter()
            .any(|p| p["push"] == "notice" && p["title"] == "Your request was approved"),
        "{pushes:?}"
    );
    assert_eq!(h.status()["pendingRequests"], 0);
    assert!(
        h.status()["remainingMinutes"].as_u64().unwrap() > 85,
        "the grant is in: {}",
        h.status()
    );
    // Polling stops once nothing is open.
    let polls = h.server.count("GET /api/devices/policy");
    h.run(180);
    assert_eq!(h.server.count("GET /api/devices/policy"), polls);
}

#[test]
fn the_tray_hears_notices_and_a_message_box_covers_for_a_missing_tray() {
    let h = Harness::child(&blocking("game.exe"));
    h.agent.tick();
    let rx = h.agent.hub().subscribe();
    h.probe.set_processes(vec![running(7, "game.exe", None)]);
    h.run(5);
    let pushes = drain(&rx);
    let n = pushes.iter().find(|p| p["push"] == "notice").expect("a notice push");
    assert_eq!(n["kind"], "blocked");
    assert_eq!(n["title"], "GRANDMA-PC: game is blocked in Child mode");
    assert!(h.notifier.0.lock().unwrap().is_empty(), "the tray was listening: no message box");
    drop(rx);
    h.advance(120);
    h.run(5);
    assert!(!h.notifier.0.lock().unwrap().is_empty(), "no tray: the service speaks itself");
}

#[test]
fn requests_that_the_server_refuses_have_plain_errors() {
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    for (status, code, expect) in [
        (409, "not_child_mode", "not_child_mode"),
        (429, "too_many_pending", "too_many_pending"),
        (429, "daily_limit", "daily_limit"),
    ] {
        *h.server.request_reply.lock().unwrap() = Some((status, json!({ "error": "no", "code": code })));
        let r = h.agent.handle(Request::RequestMoreTime { minutes: 15 });
        assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!(expect)), "{code}");
    }
    *h.server.request_reply.lock().unwrap() = Some((500, json!({ "error": "boom", "code": "x" })));
    assert_eq!(h.agent.handle(Request::RequestMoreTime { minutes: 15 })["code"], "server_error");
}

#[test]
fn only_a_child_device_can_ask() {
    let h = Harness::child(&child_bundle(|b| b["mode"] = json!("standard")));
    h.agent.tick();
    let before = h.server.paths().len();
    let r = h.agent.handle(Request::RequestMoreTime { minutes: 15 });
    assert_eq!(r["code"], "not_child_mode");
    assert_eq!(h.server.paths().len(), before, "refused here, nothing sent");
    // And a computer that is not enrolled at all.
    let h = Harness::new();
    assert_eq!(h.agent.handle(Request::RequestMoreTime { minutes: 15 })["code"], "not_enrolled");
    assert_eq!(h.agent.handle(Request::PolicyStatus)["hasPolicy"], false);
}

// ---- changes of state ---------------------------------------------------------------------------------

#[test]
fn switching_the_child_to_standard_lifts_everything_on_the_next_bundle() {
    let h = Harness::child(&child_bundle(|b| {
        b["apps"]["block"] = json!([{ "image": "game.exe" }]);
        b["screenTime"]["dailyMinutes"]["tue"] = json!(0);
    }));
    h.probe.set_processes(vec![running(7, "game.exe", None)]);
    h.agent.tick();
    h.run(10);
    let closed = terminated_pids(&h).len();
    let locks = h.actuator.locks.load(Ordering::SeqCst);
    assert!(closed >= 1 && locks >= 1);

    h.serve_policy(&child_bundle(|b| b["mode"] = json!("standard")));
    h.advance(3600);
    h.run(30);
    assert_eq!(h.status()["childMode"], false);
    assert_eq!(terminated_pids(&h).len(), closed);
    assert_eq!(h.actuator.locks.load(Ordering::SeqCst), locks);
}

#[test]
fn a_401_forgets_the_policy_and_everything_learned_about_the_child() {
    let h = Harness::child(&child_bundle(|_| {}));
    h.agent.tick();
    h.run(70);
    assert!(h.dir.root().join("policy.json").exists());
    h.server.unauthorized.store(true, Ordering::SeqCst);
    h.advance(3600);
    h.agent.tick();
    assert_eq!(h.status()["hasPolicy"], false);
    for f in ["policy.json", "child.json", "alive.json"] {
        assert!(!h.dir.root().join(f).exists(), "{f}");
    }
}

#[test]
fn the_default_build_trusts_the_production_key() {
    let keys = neo_agent_core::policy::parse_trusted_keys(neo_agent::config::DEFAULT_POLICY_PUBKEYS);
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].kid, "3bfde89a-dfd5-41e2-875f-0c86ebe4c3ad");
    // Without a build-time override, the keys in force are the production ones.
    if option_env!("NEO_POLICY_PUBKEYS").is_none() {
        assert_eq!(neo_agent::config::POLICY_PUBKEYS, neo_agent::config::DEFAULT_POLICY_PUBKEYS);
    }
}

#[test]
fn the_agent_type_is_send_and_sync_for_the_pipe_threads() {
    fn assert_sync<T: Send + Sync>() {}
    assert_sync::<Agent>();
}
