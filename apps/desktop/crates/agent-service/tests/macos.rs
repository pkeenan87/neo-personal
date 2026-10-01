//! The macOS flows through the whole agent on Linux: Full Disk Access states, TCC grants, the
//! `permission` warning, `probe_permissions` with its relaunch rule, and bundle detection. The
//! probe is the fake from `common`; the real macOS probe is only compiled on a Mac.

mod common;

use std::sync::atomic::Ordering;
use std::time::Duration;

use common::*;
use neo_agent::persist::{META_FILE, Meta};
use neo_agent::protocol::Request;
use neo_agent_core::snapshot::{AppBundle, TccRow, TccSnapshot};
use serde_json::Value;

fn row(client: &str, service: &str, auth_value: i64) -> TccRow {
    TccRow {
        db: "system".into(),
        service: service.into(),
        client: client.into(),
        client_type: 0,
        auth_value,
    }
}

fn snap(rows: Vec<TccRow>) -> Option<TccSnapshot> {
    Some(TccSnapshot {
        dbs_read: vec!["system".into()],
        rows,
    })
}

/// A Mac with Full Disk Access, enrolled and past the baseline scan (which saw Zoom's grant).
fn mac_after_baseline() -> Harness {
    let h = Harness::new();
    h.server.macos_lists.store(true, Ordering::SeqCst);
    h.probe.set_fda(Some(true));
    h.probe.set_tcc(snap(vec![row("us.zoom.xos", "kTCCServiceScreenCapture", 2)]));
    assert_eq!(h.enroll()["ok"], true);
    h.agent.tick();
    h
}

fn posted(h: &Harness) -> Vec<Value> {
    h.server.posted_events()
}

#[test]
fn status_reports_platform_and_full_disk_access() {
    let win = Harness::new();
    let s = win.agent.status();
    assert_eq!(s["platform"], "windows");
    assert_eq!(s["fullDiskAccess"], Value::Null, "not a Mac: null");

    let mac = Harness::new();
    mac.probe.set_fda(Some(false));
    assert_eq!(mac.agent.status()["platform"], "macos");
    assert_eq!(mac.agent.status()["fullDiskAccess"], false);
    mac.probe.set_fda(Some(true));
    // Cached until the next probe (the tray's Done button or the 5-minute re-probe).
    assert_eq!(mac.agent.status()["fullDiskAccess"], false);
    assert_eq!(mac.agent.handle(Request::ProbePermissions)["fullDiskAccess"], true);
    assert_eq!(mac.agent.status()["fullDiskAccess"], true);
}

#[test]
fn a_new_grant_after_enrollment_is_sent_and_warns_for_a_remote_access_tool() {
    let h = mac_after_baseline();
    assert!(
        posted(&h).iter().all(|e| e["detector"] != "tcc_grant"),
        "the baseline grant is never sent"
    );
    let rx = h.agent.hub().subscribe();

    h.probe.set_tcc(snap(vec![
        row("us.zoom.xos", "kTCCServiceScreenCapture", 2),
        row("com.anydesk.anydesk", "kTCCServiceAccessibility", 2),
    ]));
    h.clock.advance(31);
    h.agent.tick();

    let grants: Vec<Value> = posted(&h).into_iter().filter(|e| e["detector"] == "tcc_grant").collect();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0]["type"], "permission");
    assert_eq!(grants[0]["bundleId"], "com.anydesk.anydesk");
    assert_eq!(grants[0]["service"], "accessibility");

    let pushes = drain(&rx);
    let warning = pushes.iter().find(|p| p["push"] == "warning").expect("a warning was pushed");
    assert_eq!(warning["kind"], "permission");
    assert_eq!(warning["service"], "accessibility");
    assert_eq!(warning["severity"], "critical");
    assert!(warning["toolName"].as_str().unwrap().len() > 1);
}

#[test]
fn with_nobody_subscribed_the_console_fallback_carries_the_spec_copy() {
    let h = mac_after_baseline();
    h.probe.set_tcc(snap(vec![
        row("us.zoom.xos", "kTCCServiceScreenCapture", 2),
        row("com.anydesk.anydesk", "kTCCServiceScreenCapture", 2),
    ]));
    h.clock.advance(31);
    h.agent.tick();
    let shown = h.notifier.0.lock().unwrap().clone();
    assert_eq!(shown.len(), 1);
    assert!(
        shown[0]
            .1
            .contains("can now see your screen. If someone on the phone asked you to allow this, it is a scam.")
    );
    assert!(
        shown[0]
            .1
            .contains("open System Settings \u{2192} Privacy & Security and turn it off.")
    );
}

#[test]
fn a_grant_to_an_ordinary_app_is_sent_but_not_shown() {
    let h = mac_after_baseline();
    let rx = h.agent.hub().subscribe();
    h.probe
        .set_tcc(snap(vec![row("com.example.helper", "kTCCServiceScreenCapture", 2)]));
    h.clock.advance(31);
    h.agent.tick();
    assert_eq!(posted(&h).iter().filter(|e| e["detector"] == "tcc_grant").count(), 1);
    assert!(drain(&rx).iter().all(|p| p["push"] != "warning"));
    assert!(h.notifier.0.lock().unwrap().is_empty());
}

#[test]
fn without_full_disk_access_the_database_is_not_read_and_nothing_is_sent() {
    let h = Harness::new();
    h.probe.set_fda(Some(false));
    h.probe
        .set_tcc(snap(vec![row("com.anydesk.anydesk", "kTCCServiceAccessibility", 2)]));
    assert_eq!(h.enroll()["ok"], true);
    h.agent.tick();
    h.clock.advance(31);
    h.agent.tick();
    assert_eq!(h.probe.tcc_reads.load(Ordering::SeqCst), 0);
    assert!(posted(&h).iter().all(|e| e["detector"] != "tcc_grant"));
    // The other detectors still ran: the baseline scan finished.
    let meta: Meta = h.dir.read_json(META_FILE);
    assert!(!meta.discovery_pending);
}

#[test]
fn a_missing_grant_is_looked_for_again_every_five_minutes_and_a_grant_starts_detection() {
    let h = Harness::new();
    h.probe.set_fda(Some(false));
    assert_eq!(h.enroll()["ok"], true);
    h.agent.tick();
    let rx = h.agent.hub().subscribe();
    h.probe.set_fda(Some(true));
    h.probe.set_tcc(snap(vec![row("us.zoom.xos", "kTCCServiceScreenCapture", 2)]));
    h.clock.advance(31);
    h.agent.tick();
    assert_eq!(h.probe.tcc_reads.load(Ordering::SeqCst), 0, "not re-probed before five minutes");
    h.clock.advance(300);
    h.agent.tick();
    assert_eq!(h.probe.tcc_reads.load(Ordering::SeqCst), 1);
    assert!(
        drain(&rx).iter().any(|p| p["push"] == "status_changed"),
        "the tray hears that it changed"
    );
    // That first read is the silent baseline.
    assert!(posted(&h).iter().all(|e| e["detector"] != "tcc_grant"));
    assert_eq!(h.agent.status()["fullDiskAccess"], true);
}

#[test]
fn a_failed_probe_restarts_the_daemon_once_and_not_again_within_a_minute() {
    let h = Harness::new();
    h.probe.set_fda(Some(false));
    assert!(!h.agent.relaunch_due());
    let r = h.agent.handle(Request::ProbePermissions);
    assert_eq!(r["ok"], true);
    assert_eq!(r["fullDiskAccess"], false);
    assert_eq!(r["restarting"], true);
    assert!(!h.agent.relaunch_due(), "the reply is written first");
    std::thread::sleep(Duration::from_millis(1100));
    assert!(h.agent.relaunch_due());
    let meta: Meta = h.dir.read_json(META_FILE);
    assert!(meta.fda_relaunch_at.is_some(), "persisted, so a restart does not forget it");

    // Asking again straight away does not restart again.
    let again = h.agent.handle(Request::ProbePermissions);
    assert_eq!(again["restarting"], false);
    // After a minute it may.
    h.clock.advance(61);
    assert_eq!(h.agent.handle(Request::ProbePermissions)["restarting"], true);
}

#[test]
fn a_successful_probe_clears_the_relaunch_marker() {
    let h = Harness::new();
    h.probe.set_fda(Some(false));
    h.agent.handle(Request::ProbePermissions);
    h.probe.set_fda(Some(true));
    let r = h.agent.handle(Request::ProbePermissions);
    assert_eq!(r["fullDiskAccess"], true);
    assert_eq!(r["restarting"], false);
    let meta: Meta = h.dir.read_json(META_FILE);
    assert_eq!(meta.fda_relaunch_at, None);
}

#[test]
fn probe_permissions_off_a_mac_answers_null_and_never_restarts() {
    let h = Harness::new();
    let r = h.agent.handle(Request::ProbePermissions);
    assert_eq!(r["ok"], true);
    assert_eq!(r["fullDiskAccess"], Value::Null);
    assert!(!h.agent.relaunch_due());
}

#[test]
fn an_installed_remote_access_bundle_is_reported_like_a_program() {
    let h = Harness::new();
    h.server.macos_lists.store(true, Ordering::SeqCst);
    h.probe.set_fda(Some(true));
    h.probe.set_tcc(snap(vec![]));
    assert_eq!(h.enroll()["ok"], true);
    h.agent.tick(); // baseline: nothing installed
    h.probe.set_bundles(vec![AppBundle {
        path: "/Applications/AnyDesk.app".into(),
        bundle_id: Some("com.anydesk.anydesk".into()),
        name: "AnyDesk".into(),
        version: Some("8.0.0".into()),
        team_id: Some("ABCDE12345".into()),
        ..Default::default()
    }]);
    h.clock.advance(61);
    h.agent.tick();
    let tools: Vec<Value> = posted(&h).into_iter().filter(|e| e["detector"] == "remote_access_tool").collect();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["toolId"], "anydesk");
}

// ---- the socket's peer check and the relaunch exit ------------------------------------------

#[cfg(unix)]
mod socket {
    use super::*;
    use neo_agent::ipc::{PeerCheck, serve_unix_checked};
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    struct Fixed(bool);

    impl PeerCheck for Fixed {
        fn admit(&self, _s: &UnixStream) -> bool {
            self.0
        }
    }

    fn serve(h: &Harness, check: bool) -> (std::path::PathBuf, Arc<AtomicBool>, std::thread::JoinHandle<()>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("neo.sock");
        let stop = Arc::new(AtomicBool::new(false));
        let (agent, s2, p2) = (h.agent.clone(), stop.clone(), path.clone());
        let t = std::thread::spawn(move || {
            serve_unix_checked(agent, &p2, s2, Some(Arc::new(Fixed(check)))).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(Instant::now() < deadline, "socket never appeared");
            std::thread::sleep(Duration::from_millis(20));
        }
        (path, stop, t, dir)
    }

    fn ask(path: &std::path::Path) -> Option<Value> {
        let mut s = UnixStream::connect(path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(b"{\"op\":\"status\"}\n").unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).ok()?;
        serde_json::from_str(&line).ok()
    }

    #[test]
    fn an_admitted_peer_is_served_and_the_socket_is_world_connectable() {
        use std::os::unix::fs::PermissionsExt;
        let h = Harness::new();
        let (path, stop, t, _dir) = serve(&h, true);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o666);
        assert_eq!(ask(&path).unwrap()["ok"], true);
        stop.store(true, Ordering::SeqCst);
        t.join().unwrap();
    }

    #[test]
    fn a_peer_that_cannot_be_verified_is_dropped_without_an_answer() {
        let h = Harness::new();
        let (path, stop, t, _dir) = serve(&h, false);
        assert!(ask(&path).is_none(), "the connection is closed, not served");
        stop.store(true, Ordering::SeqCst);
        t.join().unwrap();
    }

    #[test]
    fn the_service_loop_ends_when_a_relaunch_is_due() {
        let h = Harness::new();
        h.probe.set_fda(Some(false));
        h.agent.handle(Request::ProbePermissions);
        let stop = Arc::new(AtomicBool::new(false));
        let start = Instant::now();
        neo_agent::runtime::run_loop(h.agent.clone(), stop.clone(), |_a, _s| {}, || {});
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(stop.load(Ordering::SeqCst), "it winds the server down itself and returns");
    }
}

// ---- the Trash rule's removal ------------------------------------------------------------------

#[cfg(unix)]
mod removal {
    use super::*;
    use neo_agent::macos::trash::{remove_self, spawn_uninstall_script};
    use std::cell::Cell;

    fn deletes(h: &Harness) -> usize {
        h.server.count("DELETE /api/devices/self")
    }

    #[test]
    fn the_owner_is_told_once_even_though_the_script_unenrolls_too() {
        let h = Harness::new();
        assert_eq!(h.enroll()["ok"], true);
        let ran = Cell::new(false);
        remove_self(&h.agent, || {
            ran.set(true);
            Ok(())
        })
        .unwrap();
        assert!(ran.get());
        assert_eq!(deletes(&h), 1);
        assert!(h.secrets.0.lock().unwrap().is_none(), "the token is gone before the script runs");
        // What `uninstall.sh` does next: `neo-agent --unenroll`. Nothing left to send.
        h.agent.unenroll_for_uninstall();
        assert_eq!(deletes(&h), 1);
    }

    #[test]
    fn removal_goes_ahead_when_the_server_is_unreachable_or_nothing_was_enrolled() {
        let h = Harness::new();
        assert_eq!(h.enroll()["ok"], true);
        h.server.offline.store(true, Ordering::SeqCst);
        let ran = Cell::new(0);
        remove_self(&h.agent, || {
            ran.set(ran.get() + 1);
            Ok(())
        })
        .unwrap();
        let never = Harness::new();
        remove_self(&never.agent, || {
            ran.set(ran.get() + 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(ran.get(), 2);
        assert_eq!(deletes(&never), 0, "nothing to tell the server about");
    }

    #[test]
    fn the_script_runs_detached_with_its_own_arguments() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("ran.txt");
        let script = tmp.path().join("uninstall.sh");
        std::fs::write(&script, format!("echo done > '{}'\n", out.display())).unwrap();
        spawn_uninstall_script(&script).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !out.exists() {
            assert!(std::time::Instant::now() < deadline, "the script did not run");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            spawn_uninstall_script(&tmp.path().join("missing.sh")).is_ok(),
            "sh itself starts; the failure is the script's"
        );
    }
}
